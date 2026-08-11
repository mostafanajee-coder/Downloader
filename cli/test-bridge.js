'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { Manager } = require('../core/Manager');
const { createBridgeServer } = require('../bridge/server');

const TEST_URL = 'https://proof.ovh.net/files/10Mb.dat';
const PORT = 38099;
const TOKEN = 'test-token-123';

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-bridge-test-'));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-bridge-dest-'));

  const manager = new Manager({ stateDir, defaultDestDir: destDir });
  const bridge = await createBridgeServer({ manager, port: PORT, token: TOKEN });
  console.log('[bridge] listening on', PORT);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: 'wrong-token' }));
    });
    ws.on('close', (code) => {
      if (code === 4003) {
        console.log('[auth] correctly rejected wrong token');
        resolve();
      } else {
        reject(new Error(`unexpected close code ${code}`));
      }
    });
    ws.on('error', reject);
  });

  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let downloadId = null;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for completion')), 180000);

    ws2.on('open', () => {
      ws2.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    });

    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello-ack') {
        console.log('[auth] correct token accepted');
        ws2.send(JSON.stringify({ type: 'add-download', payload: { url: TEST_URL, kind: 'file' } }));
      } else if (msg.type === 'add-ack') {
        downloadId = msg.id;
        console.log('[add-ack] id =', downloadId);
      } else if (msg.type === 'item-updated' && msg.item.id === downloadId) {
        if (msg.item.status === 'running' && msg.item.progress) {
          process.stdout.write(`\r[item-updated] ${msg.item.progress.percent?.toFixed(1)}%   `);
        } else if (msg.item.status === 'completed') {
          clearTimeout(timeout);
          console.log('\n[item-updated] completed:', msg.item.filename);
          resolve();
        } else if (msg.item.status === 'error') {
          clearTimeout(timeout);
          reject(new Error(`download errored: ${msg.item.error}`));
        }
      }
    });

    ws2.on('error', reject);
  });

  const finalPath = path.join(destDir, fs.readdirSync(destDir)[0]);
  const size = fs.statSync(finalPath).size;
  console.log('[verify] final file size:', size);
  if (size !== 10485760) throw new Error(`expected 10485760 bytes, got ${size}`);

  ws2.close();
  await bridge.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });

  console.log('\n=== BRIDGE INTEGRATION TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
