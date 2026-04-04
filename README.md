# Example Whatsapp API multi device(new) and mqtt

This repository is example from whatsapp-api from [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)
This example get chat from whatsapp and publish to mqtt and then you can publish message to spesific number whatsapp from mqtt (eg. send message whatsapp from arduino/ESP/PLC,SCADA)

## Requirement
Nodejs v20

## Installation
Install dependency first
```bash
npm install
```

Run app
```bash
npm start
```

## Usage
Qrcode will display in terminal after "npm start", in your whatsapp app on android/ios will set to sender.

## Send to number whatsapp to and the publish to mqtt 
Send message to your number whatsapp (whatsapp as sender and scan qrcode from terminal), topic will publish to broker ismaillowkey.my.id with topic **wa/receive**

## Send message from mqtt to spesific number whatsapp using rest API
Post to http://your-ip:4000/api/wa/private/send (number must with country code like 62 or indonesia)

body json
```
{
   "number": "62xxxxx",
   "message": "your-message"
}
```

## Send message from mqtt to spesific number whatsapp
Connect to broker ismaillowkey.my.id and publish with topic **wa/private/send** and with body (number must with country code like 62 or indonesia)
```
{
 "number" : "62xxxx",
 "message" :  "your message"
}
```

## Send image from mqtt to spesific number whatsapp
Connect to broker ismaillowkey.my.id and publish with topic **wa/private/send/picture** and with body (number must with country code like 62 or indonesia)
```
{
 "number" : "62xxxx",
 "message" :  "base64 image"
}
```

## Send custome template to spesific number whatsapp
Connect to broker ismaillowkey.my.id and publish with topic **wa/private/send/custome** and with body (number must with country code like 62 or indonesia)
```
{
 "number" : "62xxxx",
 "message" :  jsonCustomeTemplae
}
```

## Send message from mqtt to group whatsapp
Connect to broker ismaillowkey.my.id and publish with topic **wa/group/send** and with body (wa sender must join group)
```
{
 "name" : "your group name",
 "message" :  "your message"
}
```


## With pm2
automatic restart app every 1 hour
```
pm2 start index.js --name "wa-api-mqtt-v7antiban" --cron "0 * * * *"
```
