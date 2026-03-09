/**
 * WhatsApp API Server - Standalone Version
 * 
 * A complete WhatsApp API server with baileys-antiban protection
 * Run with: bun run whatsapp-api-server.ts
 * 
 * @author Generated with baileys-antiban
 * @see https://github.com/kobie3717/baileys-antiban
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState as initAuthState,
  type WASocket,
  type WAMessage,
  type WAMessageContent,
  type ConnectionState,
  type Contact,
  type BaileysEventMap
} from 'baileys';
import { AntiBan, wrapSocket, MessageQueue, ContentVariator, type AntiBanConfig } from 'baileys-antiban';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

// ============================================================================
// TYPES
// ============================================================================

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'banned';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface AntiBanStats {
  rateLimiter: {
    messagesPerMinute: number;
    messagesPerHour: number;
    messagesPerDay: number;
    totalSent: number;
  };
  warmUp: {
    isActive: boolean;
    currentDay: number;
    dailyLimit: number;
    usedToday: number;
    daysRemaining: number;
  };
  health: {
    risk: RiskLevel;
    score: number;
    recommendation: string;
    disconnects: number;
    failedMessages: number;
    lastUpdate: Date;
  };
  isPaused: boolean;
}

interface SessionInfo {
  id: string;
  status: ConnectionStatus;
  phoneNumber?: string;
  name?: string;
  connectedAt?: Date;
  qrCode?: string;
}

interface SendMessageRequest {
  to: string;
  message: string;
  options?: {
    delay?: number;
    priority?: 'low' | 'normal' | 'high';
    varyContent?: boolean;
  };
}

interface SendMediaRequest {
  to: string;
  mediaType: 'image' | 'video' | 'audio' | 'document';
  mediaUrl?: string;
  mediaBase64?: string;
  caption?: string;
  filename?: string;
}

interface SendBulkRequest {
  recipients: string[];
  message: string;
  delayBetweenMessages?: number;
  varyContent?: boolean;
}

interface MessageResponse {
  success: boolean;
  messageId?: string;
  timestamp?: Date;
  error?: string;
  to: string;
}

interface BulkMessageResponse {
  success: boolean;
  totalSent: number;
  totalFailed: number;
  results: MessageResponse[];
}

interface WhatsAppConfig {
  sessionName?: string;
  printQRInTerminal?: boolean;
  port?: number;
  antiban?: AntiBanConfig;
}

interface WhatsAppContact {
  id: string;
  name?: string;
  number: string;
  isGroup: boolean;
  pushName?: string;
}

interface MessageInfo {
  id: string;
  from: string;
  to: string;
  text?: string;
  timestamp: Date;
  fromMe: boolean;
  status?: string;
  type: string;
}

// ============================================================================
// WHATSAPP CLIENT CLASS
// ============================================================================

class WhatsAppClient {
  private static instance: WhatsAppClient | null = null;
  private socket: WASocket | null = null;
  private safeSocket: ReturnType<typeof wrapSocket> | null = null;
  private antiban: AntiBan | null = null;
  private messageQueue: MessageQueue | null = null;
  private contentVariator: ContentVariator | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private qrCode: string | null = null;
  private sessionName: string;
  private config: WhatsAppConfig;
  private logger: pino.Logger;
  private contacts: Map<string, Contact> = new Map();
  private messages: WAMessage[] = [];
  private eventHandlers: Map<string, Set<(data?: unknown) => void>> = new Map();
  private phoneNumber: string | null = null;
  private pushName: string | null = null;

  private constructor(config: WhatsAppConfig = {}) {
    this.sessionName = config.sessionName || 'default';
    this.config = config;
    this.logger = pino({
      level: config.antiban?.logging !== false ? 'info' : 'silent',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true }
      }
    });
    
    this.contentVariator = new ContentVariator({
      zeroWidthChars: true,
      punctuationVariation: true,
      synonyms: true
    });
  }

  public static getInstance(config?: WhatsAppConfig): WhatsAppClient {
    if (!WhatsAppClient.instance) {
      WhatsAppClient.instance = new WhatsAppClient(config);
    }
    return WhatsAppClient.instance;
  }

  public async connect(): Promise<void> {
    try {
      this.connectionStatus = 'connecting';
      this.emit('connection.update', { status: 'connecting' });

      const sessionsDir = path.join(process.cwd(), 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }

      const sessionPath = path.join(sessionsDir, this.sessionName);
      
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await initAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        printQRInTerminal: this.config.printQRInTerminal ?? true,
        logger: this.logger,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        shouldIgnoreJid: (jid) => {
          const isGroup = jid.endsWith('@g.us');
          const isBroadcast = jid.endsWith('@broadcast');
          return isBroadcast && !isGroup;
        }
      });

      await this.initializeAntiBan();
      this.setupEventHandlers(saveCreds);

    } catch (error) {
      this.logger.error('Failed to connect:', error);
      this.connectionStatus = 'disconnected';
      this.emit('connection.update', { status: 'disconnected', error });
      throw error;
    }
  }

  private async initializeAntiBan(): Promise<void> {
    if (!this.socket) return;

    const antibanConfig: AntiBanConfig = {
      rateLimiter: {
        maxPerMinute: this.config.antiban?.rateLimiter?.maxPerMinute ?? 8,
        maxPerHour: this.config.antiban?.rateLimiter?.maxPerHour ?? 200,
        maxPerDay: this.config.antiban?.rateLimiter?.maxPerDay ?? 1500,
        minDelayMs: this.config.antiban?.rateLimiter?.minDelayMs ?? 1500,
        maxDelayMs: this.config.antiban?.rateLimiter?.maxDelayMs ?? 5000,
        newChatDelayMs: this.config.antiban?.rateLimiter?.newChatDelayMs ?? 3000,
        maxIdenticalMessages: this.config.antiban?.rateLimiter?.maxIdenticalMessages ?? 3,
        burstAllowance: this.config.antiban?.rateLimiter?.burstAllowance ?? 3
      },
      warmUp: {
        warmUpDays: this.config.antiban?.warmUp?.warmUpDays ?? 7,
        day1Limit: this.config.antiban?.warmUp?.day1Limit ?? 20,
        growthFactor: this.config.antiban?.warmUp?.growthFactor ?? 1.8,
        inactivityThresholdHours: this.config.antiban?.warmUp?.inactivityThresholdHours ?? 72
      },
      health: {
        disconnectWarningThreshold: this.config.antiban?.health?.disconnectWarningThreshold ?? 3,
        disconnectCriticalThreshold: this.config.antiban?.health?.disconnectCriticalThreshold ?? 5,
        failedMessageThreshold: this.config.antiban?.health?.failedMessageThreshold ?? 5,
        autoPauseAt: this.config.antiban?.health?.autoPauseAt ?? 'high',
        onRiskChange: (status) => {
          this.logger.info(`Health status changed: ${status.risk} (${status.score})`);
          this.emit('health.update', status);
        }
      },
      logging: this.config.antiban?.logging ?? true
    };

    this.antiban = new AntiBan(antibanConfig);
    this.safeSocket = wrapSocket(this.socket);

    this.messageQueue = new MessageQueue({ maxAttempts: 3 });
    this.messageQueue.setSendFunction(async (jid: string, content: WAMessageContent) => {
      if (!this.safeSocket) throw new Error('Not connected');
      await this.safeSocket.sendMessage(jid, content);
    });

    this.messageQueue.on('sent', (msg: unknown) => {
      this.emit('message.sent', msg);
    });

    this.messageQueue.on('failed', (msg: unknown, error: Error) => {
      this.emit('message.failed', { message: msg, error });
    });
  }

  private setupEventHandlers(saveCreds: () => Promise<void>): void {
    if (!this.socket) return;

    this.socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.logger.info('QR Code received, scan to connect');
        
        if (this.config.printQRInTerminal !== false) {
          qrcode.generate(qr, { small: true });
        }
        
        this.emit('qr', qr);
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        this.connectionStatus = shouldReconnect ? 'disconnected' : 'banned';
        this.logger.info(`Connection closed. Reason: ${lastDisconnect?.error?.message}`);
        
        this.antiban?.onDisconnect((lastDisconnect?.error as Boom)?.output?.statusCode);
        this.emit('connection.update', { 
          status: this.connectionStatus, 
          reason: lastDisconnect?.error?.message 
        });

        if (shouldReconnect) {
          this.logger.info('Reconnecting...');
          setTimeout(() => this.connect(), 5000);
        }
      } else if (connection === 'open') {
        this.connectionStatus = 'connected';
        this.qrCode = null;
        this.antiban?.onReconnect();
        this.logger.info('Connected to WhatsApp!');
        this.emit('connection.update', { status: 'connected' });

        const user = this.socket?.user;
        if (user) {
          this.phoneNumber = user.id?.split(':')[0]?.split('@')[0] || null;
          this.pushName = user.name || null;
        }
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('messages.upsert', ({ messages, type }: BaileysEventMap['messages.upsert']) => {
      for (const message of messages) {
        if (type === 'notify' && !message.key.fromMe) {
          this.messages.push(message);
          this.emit('message.received', this.formatMessage(message));
        }
      }
    });

    this.socket.ev.on('contacts.upsert', (contacts: Contact[]) => {
      for (const contact of contacts) {
        this.contacts.set(contact.id, contact);
      }
      this.emit('contacts.update', contacts);
    });
  }

  public async sendMessage(request: SendMessageRequest): Promise<MessageResponse> {
    try {
      if (!this.safeSocket) {
        return { success: false, to: request.to, error: 'Not connected to WhatsApp' };
      }

      let content = request.message;
      
      if (request.options?.varyContent && this.contentVariator) {
        content = this.contentVariator.vary(request.message);
      }

      const decision = await this.antiban?.beforeSend(request.to, content);
      
      if (decision && !decision.allowed) {
        return { 
          success: false, 
          to: request.to, 
          error: `Blocked by anti-ban: ${decision.reason}` 
        };
      }

      if (decision?.delayMs) {
        await this.delay(decision.delayMs);
      }

      const sent = await this.safeSocket.sendMessage(request.to, { text: content });
      
      this.antiban?.afterSend(request.to, content);

      return {
        success: true,
        messageId: sent?.key.id || undefined,
        timestamp: new Date(sent?.messageTimestamp as number * 1000),
        to: request.to
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.antiban?.afterSendFailed(errorMessage);
      
      return {
        success: false,
        to: request.to,
        error: errorMessage
      };
    }
  }

  public async sendMedia(request: SendMediaRequest): Promise<MessageResponse> {
    try {
      if (!this.safeSocket) {
        return { success: false, to: request.to, error: 'Not connected to WhatsApp' };
      }

      let content: WAMessageContent;

      switch (request.mediaType) {
        case 'image':
          content = {
            image: request.mediaUrl ? { url: request.mediaUrl } : { url: '' },
            caption: request.caption
          };
          break;
        case 'video':
          content = {
            video: request.mediaUrl ? { url: request.mediaUrl } : { url: '' },
            caption: request.caption
          };
          break;
        case 'audio':
          content = {
            audio: request.mediaUrl ? { url: request.mediaUrl } : { url: '' },
            mimetype: 'audio/mp4'
          };
          break;
        case 'document':
          content = {
            document: request.mediaUrl ? { url: request.mediaUrl } : { url: '' },
            mimetype: 'application/pdf',
            fileName: request.filename
          };
          break;
        default:
          return { success: false, to: request.to, error: 'Invalid media type' };
      }

      const decision = await this.antiban?.beforeSend(request.to, JSON.stringify(content));
      
      if (decision && !decision.allowed) {
        return { 
          success: false, 
          to: request.to, 
          error: `Blocked by anti-ban: ${decision.reason}` 
        };
      }

      if (decision?.delayMs) {
        await this.delay(decision.delayMs);
      }

      const sent = await this.safeSocket.sendMessage(request.to, content);
      
      this.antiban?.afterSend(request.to, JSON.stringify(content));

      return {
        success: true,
        messageId: sent?.key.id || undefined,
        timestamp: new Date(sent?.messageTimestamp as number * 1000),
        to: request.to
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.antiban?.afterSendFailed(errorMessage);
      
      return {
        success: false,
        to: request.to,
        error: errorMessage
      };
    }
  }

  public async sendBulk(request: SendBulkRequest): Promise<BulkMessageResponse> {
    const results: MessageResponse[] = [];
    let totalSent = 0;
    let totalFailed = 0;

    const delay = request.delayBetweenMessages ?? 3000;

    for (const recipient of request.recipients) {
      let message = request.message;
      
      if (request.varyContent && this.contentVariator) {
        message = this.contentVariator.vary(request.message);
      }

      const result = await this.sendMessage({
        to: recipient,
        message,
        options: { delay }
      });

      results.push(result);
      
      if (result.success) {
        totalSent++;
      } else {
        totalFailed++;
      }

      await this.delay(delay);
    }

    return {
      success: totalFailed === 0,
      totalSent,
      totalFailed,
      results
    };
  }

  public getAntiBanStats(): AntiBanStats | null {
    if (!this.antiban) return null;
    return this.antiban.getStats();
  }

  public getSessionInfo(): SessionInfo {
    return {
      id: this.sessionName,
      status: this.connectionStatus,
      phoneNumber: this.phoneNumber || undefined,
      name: this.pushName || undefined,
      connectedAt: this.connectionStatus === 'connected' ? new Date() : undefined,
      qrCode: this.qrCode || undefined
    };
  }

  public getContacts(): WhatsAppContact[] {
    return Array.from(this.contacts.values()).map(contact => ({
      id: contact.id,
      name: contact.name || contact.notify,
      number: contact.id.split('@')[0],
      isGroup: contact.id.endsWith('@g.us'),
      pushName: contact.notify
    }));
  }

  public getMessages(limit: number = 50): MessageInfo[] {
    return this.messages
      .slice(-limit)
      .map(msg => this.formatMessage(msg));
  }

  public isConnected(): boolean {
    return this.connectionStatus === 'connected' && this.socket !== null;
  }

  public async disconnect(): Promise<void> {
    if (this.socket) {
      await this.socket.end();
      this.socket = null;
      this.safeSocket = null;
      this.connectionStatus = 'disconnected';
      this.emit('connection.update', { status: 'disconnected' });
    }
  }

  public async logout(): Promise<void> {
    await this.disconnect();
    
    const sessionsDir = path.join(process.cwd(), 'sessions');
    const sessionPath = path.join(sessionsDir, this.sessionName);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    this.contacts.clear();
    this.messages = [];
    this.phoneNumber = null;
    this.pushName = null;
  }

  public pause(): void {
    this.antiban?.pause();
  }

  public resume(): void {
    this.antiban?.resume();
  }

  public reset(): void {
    this.antiban?.reset();
  }

  public on(event: string, handler: (data?: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)?.add(handler);
  }

  public off(event: string, handler: (data?: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: string, data?: unknown): void {
    this.eventHandlers.get(event)?.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        this.logger.error(`Error in event handler for ${event}:`, error);
      }
    });
  }

  private formatMessage(msg: WAMessage): MessageInfo {
    return {
      id: msg.key.id || '',
      from: msg.key.remoteJid || '',
      to: msg.key.fromMe ? msg.key.remoteJid || '' : (msg.key.fromMe ? '' : this.phoneNumber || ''),
      text: msg.message?.conversation || 
            msg.message?.extendedTextMessage?.text || 
            '',
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      fromMe: msg.key.fromMe || false,
      status: msg.status,
      type: Object.keys(msg.message || {})[0] || 'unknown'
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// EXPRESS API SERVER
// ============================================================================

function formatPhoneNumber(phone: string): string {
  let cleaned = phone.replace(/[^0-9@.]/g, '');
  if (cleaned.includes('@')) return cleaned;
  if (cleaned.endsWith('.us') || phone.includes('-')) {
    return `${cleaned}@g.us`;
  }
  return `${cleaned}@s.whatsapp.net`;
}

function createServer(config: WhatsAppConfig = {}) {
  const app = express();
  const client = WhatsAppClient.getInstance(config);

  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'WhatsApp API Server',
      version: '1.0.0',
      library: 'baileys-antiban',
      status: 'running'
    });
  });

  // Connect to WhatsApp
  app.post('/connect', async (_req: Request, res: Response) => {
    try {
      if (client.isConnected()) {
        return res.json({
          success: true,
          data: client.getSessionInfo(),
          message: 'Already connected to WhatsApp'
        });
      }

      await client.connect();

      res.json({
        success: true,
        data: client.getSessionInfo(),
        message: 'Connecting to WhatsApp. Scan QR code if needed.'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to connect'
      });
    }
  });

  // Disconnect
  app.post('/disconnect', async (req: Request, res: Response) => {
    try {
      const { logout } = req.body;

      if (logout) {
        await client.logout();
        return res.json({ success: true, message: 'Logged out and session cleared' });
      }

      await client.disconnect();
      res.json({ success: true, message: 'Disconnected from WhatsApp' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to disconnect'
      });
    }
  });

  // Get status
  app.get('/status', (_req: Request, res: Response) => {
    const sessionInfo = client.getSessionInfo();
    const antibanStats = client.getAntiBanStats();

    res.json({
      success: true,
      data: {
        session: sessionInfo,
        antiban: antibanStats,
        isHealthy: antibanStats ? antibanStats.health.risk !== 'critical' : true
      }
    });
  });

  // Send text message
  app.post('/send', async (req: Request, res: Response) => {
    try {
      if (!client.isConnected()) {
        return res.status(400).json({
          success: false,
          error: 'Not connected to WhatsApp. Connect first.'
        });
      }

      const { to, message, options, recipients, mediaType, mediaUrl, caption, varyContent, delayBetweenMessages } = req.body;

      // Bulk messages
      if (recipients && Array.isArray(recipients)) {
        const result = await client.sendBulk({
          recipients: recipients.map(r => formatPhoneNumber(r)),
          message,
          delayBetweenMessages,
          varyContent
        });
        return res.json({ success: result.success, data: result });
      }

      // Media message
      if (mediaType) {
        const result = await client.sendMedia({
          to: formatPhoneNumber(to),
          mediaType,
          mediaUrl,
          caption
        });
        return res.json({ success: result.success, data: result, error: result.error });
      }

      // Text message
      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, message'
        });
      }

      const result = await client.sendMessage({
        to: formatPhoneNumber(to),
        message,
        options
      });

      res.json({ success: result.success, data: result, error: result.error });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send message'
      });
    }
  });

  // Get messages
  app.get('/messages', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const type = req.query.type as string || 'all';

    const response: { messages: MessageInfo[]; contacts: WhatsAppContact[] } = {
      messages: [],
      contacts: []
    };

    if (type === 'all' || type === 'messages') {
      response.messages = client.getMessages(limit);
    }

    if (type === 'all' || type === 'contacts') {
      response.contacts = client.getContacts();
    }

    res.json({ success: true, data: response });
  });

  // Control actions
  app.put('/control', (req: Request, res: Response) => {
    const { action } = req.body;

    switch (action) {
      case 'pause':
        client.pause();
        return res.json({ success: true, message: 'Anti-ban paused' });
      case 'resume':
        client.resume();
        return res.json({ success: true, message: 'Anti-ban resumed' });
      case 'reset':
        client.reset();
        return res.json({ success: true, message: 'Anti-ban state reset' });
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid action. Use: pause, resume, or reset'
        });
    }
  });

  // Event webhook simulation
  app.get('/events', (_req: Request, res: Response) => {
    res.json({
      success: true,
      message: 'WebSocket events available. Connect to receive real-time updates.',
      events: [
        'connection.update',
        'message.received',
        'message.sent',
        'message.failed',
        'health.update',
        'qr'
      ]
    });
  });

  return { app, client };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

const config: WhatsAppConfig = {
  sessionName: process.env.WHATSAPP_SESSION || 'default',
  printQRInTerminal: true,
  port: parseInt(process.env.PORT || '3001', 10),
  antiban: {
    rateLimiter: {
      maxPerMinute: 8,
      maxPerHour: 200,
      maxPerDay: 1500,
      minDelayMs: 1500,
      maxDelayMs: 5000
    },
    warmUp: {
      warmUpDays: 7,
      day1Limit: 20,
      growthFactor: 1.8
    },
    health: {
      autoPauseAt: 'high'
    },
    logging: true
  }
};

const { app } = createServer(config);
const port = config.port || 3001;

app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🟢 WhatsApp API Server Started!                          ║
║                                                            ║
║   📡 Server: http://localhost:${port}                         ║
║   📚 Library: baileys-antiban                              ║
║                                                            ║
║   Endpoints:                                               ║
║   • POST /connect    - Connect to WhatsApp                 ║
║   • POST /disconnect - Disconnect from WhatsApp            ║
║   • GET  /status     - Get connection status               ║
║   • POST /send       - Send message                        ║
║   • GET  /messages   - Get messages & contacts             ║
║   • PUT  /control    - Control actions (pause/resume)      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export { WhatsAppClient, createServer };
