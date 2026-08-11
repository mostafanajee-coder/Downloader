'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Connect to our main app WebSocket bridge
const ws = new WebSocket('ws://127.0.0.1:9333');

ws.on('open', () => {
  try {
    ws.send(JSON.stringify({ type: 'hello', source: 'native-host-bridge' }));
  } catch (e) {}
});

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) break;

    const msgBytes = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    try {
      const msg = JSON.parse(msgBytes.toString('utf8'));
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'native-idm-capture',
          payload: msg,
        }));
      }
    } catch (e) {}
  }
});
