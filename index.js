/* eslint-disable @typescript-eslint/no-require-imports, react-hooks/rules-of-hooks */
/**
 * WhatsApp API Server with baileys-antiban + MQTT
 * 
 * Langsung konek ke WhatsApp dan tampilkan QR Code
 * Endpoint: POST /api/private/send
 * MQTT: Publish/Subscribe ke broker
 * 
 * Run: node run.js
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const mqtt = require('mqtt');

// Baileys
const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} = require('baileys');

// Anti-ban
const { AntiBan, wrapSocket } = require('./libs/baileys-antiban');

// ============================================================================
// CONFIG
// ============================================================================

const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'sessions');

// MQTT Config
const BROKER = 'ismaillowkey.my.id';
const MQTT_URL = `mqtt://${BROKER}:1883`;
const TOPICRECEIVE = 'wa/private/receive';   // Topic untuk publish pesan masuk
const TOPICSEND = 'wa/private/send';          // Topic untuk subscribe (terima perintah kirim)

// Buat folder sessions jika tidak ada
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ============================================================================
// WHATSAPP CLIENT
// ============================================================================

let sock = null;
let safeSock = null;
let antiban = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;
let mqttClient = null;

// Logger (simple, no pino-pretty needed)
const logger = pino({
  level: 'silent' // Silent mode, kita pakai console.log saja
});

// ============================================================================
// MQTT CLIENT
// ============================================================================

/**
 * Connect ke MQTT Broker
 */
function connectMQTT() {
  console.log('\n🔌 Menghubungkan ke MQTT Broker:', BROKER);

  mqttClient = mqtt.connect(MQTT_URL, {
    clientId: `wa-api-${Date.now()}`,
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 5000
  });

  mqttClient.on('connect', () => {
    console.log('✅ MQTT Connected!');
    
    // Subscribe ke topic untuk menerima perintah kirim pesan
    mqttClient.subscribe(TOPICSEND, (err) => {
      if (err) {
        console.error('❌ Failed to subscribe:', err.message);
      } else {
        console.log('📡 Subscribed to topic:', TOPICSEND);
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    if (topic.toLowerCase() === TOPICSEND.toLowerCase()) {
      if (connectionStatus !== 'connected') {
        console.warn('⚠️ WhatsApp not connected. Message skipped.');
        return;
      }

      try {
        const payload = JSON.parse(message.toString());
        let numberStr = payload.number.toString();
        
        // Format nomor
        if (numberStr.startsWith('0')) {
          numberStr = '62' + numberStr.slice(1);
        } else if (numberStr.startsWith('+62')) {
          numberStr = numberStr.slice(1);
        } else if (numberStr.startsWith('62')) {
          // Sudah benar
        } else {
          numberStr = '62' + numberStr;
        }
        
        const jid = numberStr + '@s.whatsapp.net';
        const text = payload.message;
        
        console.log(`\n📩 MQTT -> WhatsApp`);
        console.log(`   To: ${numberStr}`);
        console.log(`   Message: ${text}`);

        // Check dengan anti-ban
        const decision = await antiban.beforeSend(jid, text);
        
        if (!decision.allowed) {
          console.error('❌ Blocked by anti-ban:', decision.reason);
          return;
        }

        // Delay
        if (decision.delayMs) {
          await new Promise(r => setTimeout(r, decision.delayMs));
        }

        // Send message
        await sock.sendMessage(jid, { text });
        console.log('✅ Message sent via MQTT');

        // Notify anti-ban
        antiban.afterSend(jid, text);
        
      } catch (err) {
        console.error('❌ Error sending message from MQTT:', err.message);
      }
    }
  });

  mqttClient.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
  });

  mqttClient.on('reconnect', () => {
    console.log('🔄 MQTT Reconnecting...');
  });

  mqttClient.on('close', () => {
    console.log('⚠️ MQTT Connection closed');
  });
}

/**
 * Publish pesan masuk ke MQTT
 */
function publishToMQTT(from, message) {
  if (!mqttClient || !mqttClient.connected) {
    console.warn('⚠️ MQTT not connected, skip publishing');
    return;
  }

  // Extract number from JID
  const number = from.split('@')[0];

  const payload = {
    number: number,
    message: message,
    timestamp: new Date().toISOString(),
    from: 'whatsapp'
  };

  mqttClient.publish(TOPICRECEIVE, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) {
      console.error('❌ Failed to publish to MQTT:', err.message);
    } else {
      console.log('📤 Published to MQTT topic:', TOPICRECEIVE);
    }
  });
}

// ============================================================================
// WHATSAPP CONNECTION
// ============================================================================

/**
 * Connect ke WhatsApp
 */
async function connectWhatsApp() {
  try {
    connectionStatus = 'connecting';
    console.log('\n🔄 Menghubungkan ke WhatsApp...\n');

    // Auth state
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // Get latest version
    const { version } = await fetchLatestBaileysVersion();

    // Create socket
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false, // Kita handle QR sendiri
      logger,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: true,
      browser: ['WhatsApp API', 'Chrome', '1.0.0']
    });

    // Init anti-ban
    antiban = new AntiBan({
      rateLimiter: {
        maxPerMinute: 8,
        maxPerHour: 200,
        maxPerDay: 1500,
        minDelayMs: 1500,
        maxDelayMs: 5000
      },
      warmUp: {
        warmUpDays: 7,
        day1Limit: 20
      },
      health: {
        autoPauseAt: 'high'
      },
      logging: true
    });

    // Wrap socket dengan anti-ban
    safeSock = wrapSocket(sock);

    // Event handlers
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code
      if (qr) {
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📱 SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP ANDA');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
        console.log('📋 Atau salin QR string ini ke WhatsApp Web:');
        console.log('───────────────────────────────────────────────────────────');
        console.log(qr);
        console.log('───────────────────────────────────────────────────────────');
        console.log('\n');
      }

      // Connection closed
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log('\n❌ Koneksi terputus:', lastDisconnect?.error?.message);
        
        if (shouldReconnect) {
          console.log('🔄 Reconnecting dalam 5 detik...');
          connectionStatus = 'disconnected';
          antiban?.onDisconnect(lastDisconnect?.error?.output?.statusCode);
          setTimeout(() => connectWhatsApp(), 5000);
        } else {
          console.log('🚫 Nomor di-ban. Hapus folder sessions dan coba lagi.');
          connectionStatus = 'banned';
        }
      }

      // Connected
      if (connection === 'open') {
        connectionStatus = 'connected';
        antiban?.onReconnect();
        
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ BERHASIL TERHUBUNG KE WHATSAPP!');
        console.log('═══════════════════════════════════════════════════════════');
        
        // Get phone number
        const user = sock.user;
        if (user?.id) {
          phoneNumber = user.id.split(':')[0].split('@')[0];
          console.log('📱 Nomor:', phoneNumber);
        }
        
        console.log('\n📡 API Endpoint:');
        console.log('   POST http://localhost:' + PORT + '/api/private/send');
        console.log('\n📡 MQTT Topics:');
        console.log('   Subscribe:', TOPICSEND);
        console.log('   Publish:', TOPICRECEIVE);
        console.log('═══════════════════════════════════════════════════════════\n');
      }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages - Auto reply + Publish to MQTT
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        // Hanya proses pesan masuk (bukan dari kita) dan type notify
        if (type === 'notify' && !msg.key.fromMe) {
          const from = msg.key.remoteJid;
          const msgText = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || '';
          
          // Skip jika tidak ada teks
          if (!msgText) continue;
          
          // Skip pesan dari grup (optional)
          if (from.endsWith('@g.us')) continue;

          console.log('\n📩 Pesan masuk dari:', from);
          console.log('   Isi:', msgText);

          // Publish ke MQTT
          publishToMQTT(from, msgText);

          // Format tanggal waktu
          const dateTime = new Date().toLocaleString('id-ID', {
            dateStyle: 'full',
            timeStyle: 'long'
          });

          // Balas dengan konfirmasi
          const replyMessage = 
            `[BOT] Pesan telah diterima dan dibaca pada ${dateTime}\n` +
            `📊 Data dikirim ke:\n` +
            `Broker: ${BROKER}\n` +
            `Topic: ${TOPICRECEIVE}`;

          try {
            // Delay sebentar sebelum balas
            await new Promise(r => setTimeout(r, 1000));
            
            await sock.sendMessage(from, { text: replyMessage });
            console.log('✅ Auto-reply terkirim ke:', from);
            
            // Notify anti-ban
            antiban.afterSend(from, replyMessage);
          } catch (err) {
            console.error('❌ Gagal mengirim auto-reply:', err.message);
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Error connecting:', error);
    connectionStatus = 'disconnected';
    setTimeout(() => connectWhatsApp(), 5000);
  }
}

/**
 * Format nomor telepon
 */
function formatNumber(number) {
  // Hapus karakter non-numerik
  let cleaned = number.replace(/[^0-9]/g, '');
  
  // Jika sudah ada @, return as is
  if (number.includes('@')) return number;
  
  // Jika group
  if (number.includes('-') || number.endsWith('.us')) {
    return `${cleaned}@g.us`;
  }
  
  // Individual number
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Kirim pesan
 */
async function sendMessage(number, message) {
  if (!safeSock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp tidak terhubung');
  }

  const jid = formatNumber(number);

  // Check dengan anti-ban
  const decision = await antiban.beforeSend(jid, message);
  
  if (!decision.allowed) {
    throw new Error(`Diblokir anti-ban: ${decision.reason}`);
  }

  // Delay
  if (decision.delayMs) {
    await new Promise(r => setTimeout(r, decision.delayMs));
  }

  // Send
  const sent = await safeSock.sendMessage(jid, { text: message });
  
  // Notify anti-ban
  antiban.afterSend(jid, message);

  return {
    success: true,
    messageId: sent?.key?.id,
    timestamp: new Date(sent?.messageTimestamp * 1000),
    to: number
  };
}

// ============================================================================
// EXPRESS API
// ============================================================================

const app = express();

app.use(cors());
app.use(express.json());

// API Endpoint: Send Message
app.post('/api/private/send', async (req, res) => {
  try {
    const { number, message } = req.body;

    // Validasi
    if (!number || !message) {
      return res.status(400).json({
        success: false,
        error: 'Parameter wajib: number, message'
      });
    }

    // Cek koneksi
    if (connectionStatus !== 'connected') {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp tidak terhubung. Status: ' + connectionStatus
      });
    }

    // Kirim pesan
    const result = await sendMessage(number, message);

    console.log(`✅ Pesan terkirim ke ${number}`);
    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    name: 'WhatsApp API + MQTT',
    status: connectionStatus,
    phoneNumber: phoneNumber,
    mqtt: mqttClient?.connected ? 'connected' : 'disconnected',
    broker: BROKER,
    topics: {
      subscribe: TOPICSEND,
      publish: TOPICRECEIVE
    },
    antiban: antiban?.getStats() || null
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 WhatsApp API Server Started');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📡 Port:', PORT);
  console.log('📚 Library: baileys + baileys-antiban + mqtt');
  console.log('═══════════════════════════════════════════════════════════');

  // Connect ke MQTT
  connectMQTT();

  // Langsung konek ke WhatsApp
  connectWhatsApp();
});

// Handle termination
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  
  // Close MQTT
  if (mqttClient) {
    mqttClient.end();
  }
  
  process.exit(0);
});
