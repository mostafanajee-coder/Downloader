'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// We can use the 'ws' package to connect to the local Electron app's WebSocket server
const WebSocket = require('ws');

// Locate pairing.json to find the local port
const userDataDir = path.join(process.env.APPDATA, 'downloader', 'downloader-state');
// Electron uses app.getPath('userData'), which defaults to %APPDATA%\downloader
const pairingPath = path.join(process.env.APPDATA, 'downloader', 'downloader-state', 'pairing.json');

let ws = null;
let msgQueue = [];

function getPairing() {
  try {
    const data = fs.readFileSync(pairingPath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function connectToApp() {
  const pairing = getPairing();
  if (!pairing) {
    sendMessage({ status: 'error', message: 'Downloader Desktop App is not running.' });
    return;
  }

  ws = new WebSocket(`ws://127.0.0.1:${pairing.port}`);
  
  ws.on('open', () => {
    // Authenticate
    ws.send(JSON.stringify({ type: 'auth', token: pairing.token }));
    
    // Flush queued messages
    while (msgQueue.length > 0) {
      ws.send(JSON.stringify(msgQueue.shift()));
    }
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data);
      sendMessage(parsed);
    } catch (e) {}
  });

  ws.on('error', (e) => {
    sendMessage({ status: 'error', message: 'Downloader is not running or disconnected.' });
  });

  ws.on('close', () => {
    process.exit(0);
  });
}

// Read from Chrome Native Messaging (stdin)
process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    if (chunk.length < 4) continue;
    const msgLen = chunk.readUInt32LE(0);
    const msgData = chunk.slice(4, 4 + msgLen).toString('utf8');
    
    if (msgData) {
      try {
        const payload = JSON.parse(msgData);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        } else {
          msgQueue.push(payload);
          if (!ws) connectToApp();
        }
      } catch (err) {
        sendMessage({ status: 'error', message: 'Failed to parse JSON' });
      }
    }
  }
});

// Write to Chrome Native Messaging (stdout)
function sendMessage(msgObj) {
  const msgStr = JSON.stringify(msgObj);
  const msgBuf = Buffer.from(msgStr, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(msgBuf.length, 0);
  
  process.stdout.write(lenBuf);
  process.stdout.write(msgBuf);
}
