'use strict';

// End-to-end integration check for the local bridge: a client connects, queues
// a download, and watches it through to completion over the WebSocket.
//
// NOTE: this hits the real network on purpose. It is manual/integration
// tooling, not part of `npm test` — run it with `npm run test:integration`.
//
// The bridge no longer uses a shared token. Authentication is by ORIGIN: any
// connection presenting a normal web-page origin is refused, because otherwise
// any site the user visited could open ws://127.0.0.1:9333 and queue arbitrary
// downloads. The extension's service worker connects with a chrome-extension://
// origin, and native/CLI clients send no Origin header at all.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { Manager } = require('../core/Manager');
const { createBridgeServer } = require('../bridge/server');

const TEST_URL = 'https://proof.ovh.net/files/10Mb.dat';
const EXPECTED_BYTES = 10485760;
const PORT = 38099;

function connect(origin) {
  return origin ? new WebSocket(`ws://127.0.0.1:${PORT}`, { origin }) : new WebSocket(`ws://127.0.0.1:${PORT}`);
}

async function expectRejected(origin) {
  const ws = connect(origin);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`origin ${origin} was not rejected within 10s`)), 10000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error(`origin ${origin} was ACCEPTED — a web page could queue downloads`));
    });
    // A refused upgrade surfaces as an error carrying the HTTP status.
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      if (res.statusCode === 403) resolve();
      else reject(new Error(`expected HTTP 403 for ${origin}, got ${res.statusCode}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (/403/.test(err.message)) resolve();
      else reject(err);
    });
  });
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-bridge-test-'));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-bridge-dest-'));

  // defaultDestDir keeps the download inside the temp dir instead of falling
  // back to process.cwd() and littering the repo.
  const manager = new Manager({ stateDir, defaultDestDir: destDir });
  const bridge = await createBridgeServer({ manager, port: PORT });
  if (!bridge.httpServer) throw new Error(`could not bind port ${PORT} — is something already using it?`);
  console.log('[bridge] listening on', PORT);

  // --- Origin policy --------------------------------------------------------
  await expectRejected('https://evil.example.com');
  console.log('[auth] a web-page origin is correctly refused with 403');
  await expectRejected('http://localhost:3000');
  console.log('[auth] even a localhost web origin is refused');

  // --- A legitimate client (no Origin header, like the native host) ---------
  const ws = connect(null);
  let downloadId = null;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for completion')), 180000);
    const fail = (err) => {
      clearTimeout(timeout);
      reject(err);
    };

    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello' })));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (msg.type === 'hello-ack') {
        console.log('[auth] a client with no web origin is accepted');
        ws.send(JSON.stringify({ type: 'add-download', payload: { url: TEST_URL, kind: 'file' } }));
      } else if (msg.type === 'add-ack') {
        downloadId = msg.id;
        console.log('[add-ack] id =', downloadId);
      } else if (msg.type === 'item-updated' && msg.item.id === downloadId) {
        if (msg.item.status === 'running' && msg.item.progress) {
          process.stdout.write(`\r[item-updated] ${(msg.item.progress.percent || 0).toFixed(1)}%   `);
        } else if (msg.item.status === 'completed') {
          clearTimeout(timeout);
          console.log('\n[item-updated] completed:', msg.item.filename);
          resolve();
        } else if (msg.item.status === 'error') {
          fail(new Error(`download errored: ${msg.item.error}`));
        }
      }
    });

    ws.on('error', fail);
  });

  // --- Verify the published file -------------------------------------------
  const produced = fs.readdirSync(destDir);
  if (produced.length !== 1) {
    throw new Error(`expected exactly one file in the destination, got ${JSON.stringify(produced)}`);
  }
  const finalPath = path.join(destDir, produced[0]);
  const size = fs.statSync(finalPath).size;
  console.log('[verify] final file size:', size);
  if (size !== EXPECTED_BYTES) throw new Error(`expected ${EXPECTED_BYTES} bytes, got ${size}`);

  // The sidecar must be gone: it is removed only once the download verifies.
  if (fs.existsSync(`${finalPath}.ddl.json`)) throw new Error('a .ddl.json sidecar was left behind');

  ws.close();
  await bridge.stop();
  manager.db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });

  console.log('\n=== BRIDGE INTEGRATION TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
