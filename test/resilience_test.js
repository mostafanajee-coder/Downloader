'use strict';
// Targeted resilience tests for the final polish audit:
//  1. bridge/server.js survives malformed messages and an abrupt socket error
//     without crashing the process (the ws.on('error') fix).
//  2. Manager.add() skips a single bad destination in a batch instead of
//     aborting the whole batch (the per-URL try/catch fix).
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));
const { createBridgeServer } = require(path.join(ROOT, 'bridge', 'server'));

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If bridge/server.js's new ws.on('error') handler weren't there, an abrupt
// socket error would throw an uncaught exception INSIDE this same process
// (Node's EventEmitter 'error' semantics) — so simply reaching the end of
// this script without the process dying is itself the proof.
let crashed = false;
process.on('uncaughtException', (err) => {
  crashed = true;
  console.log('FAIL  process survived (uncaughtException leaked to top level) —', err.message);
});

function makeManager(tmp) {
  const cfg = {
    values: { destDirs: { General: path.join(tmp, 'General') }, excludedSites: '', speedLimitKBps: 0, maxConcurrentDownloads: 2 },
    get(k) { return this.values[k]; },
    getAll() { return this.values; },
  };
  return new Manager({ stateDir: tmp, config: cfg });
}

async function testBridgeSurvivesMalformedAndSocketError() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-res-'));
  const manager = makeManager(tmp);
  const port = 38077;
  const bridge = await createBridgeServer({ manager, port });
  check('bridge started', Boolean(bridge.wss));

  // 1. Malformed JSON — must not crash, no response expected.
  const client1 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => client1.on('open', resolve));
  client1.send('{not valid json!!!');
  await sleep(100);
  check('malformed JSON did not crash the server', client1.readyState === WebSocket.OPEN);

  // 2. Well-formed but nonsense message type — must not crash.
  client1.send(JSON.stringify({ type: 'totally-unknown-message-type', payload: { a: 1 } }));
  await sleep(100);
  check('unknown message type did not crash the server', client1.readyState === WebSocket.OPEN);

  // 3. Abrupt socket destruction (simulates ECONNRESET / browser crash) —
  // this is exactly the scenario ws.on('error') protects against.
  client1._socket.destroy(new Error('simulated abrupt disconnect'));
  await sleep(150);

  // The server must still be alive and accept a brand-new connection.
  const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
  const opened = await new Promise((resolve) => {
    client2.on('open', () => resolve(true));
    client2.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 2000);
  });
  check('server still accepts new connections after a peer socket error', opened);

  client2.close();
  await sleep(50);
  await bridge.stop();
  manager.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testManagerAddSkipsBadDestDirButKeepsGoing() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-res-'));
  const manager = makeManager(tmp);

  // Create a FILE (not a directory) at the path we'll try to use as a
  // destination directory — fs.mkdirSync on top of an existing file throws
  // EEXIST/ENOTDIR, simulating a real "can't create destination" failure.
  const blockedPath = path.join(tmp, 'blocked-not-a-dir');
  fs.writeFileSync(blockedPath, 'this is a file, not a directory');

  const idBad = manager.add({ url: 'http://x/bad.zip', destDir: blockedPath, startNow: false });
  const idGood = manager.add({ url: 'http://x/good.zip', startNow: false });

  const list = manager.list();
  check('the bad-destDir URL produced no queued item', !list.some((x) => x.url === 'http://x/bad.zip'));
  check('the good URL was still added despite the earlier failure', list.some((x) => x.url === 'http://x/good.zip'));
  check('add() returned an empty result for the fully-skipped bad call', Array.isArray(idBad) && idBad.length === 0);

  manager.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  try {
    await testBridgeSurvivesMalformedAndSocketError();
    await testManagerAddSkipsBadDestDirButKeepsGoing();
  } catch (e) {
    console.error('ERROR', e);
    fails++;
  }
  await sleep(100);
  check('no uncaught exception escaped to the process top level', !crashed);
  console.log(`\n${fails === 0 ? 'ALL RESILIENCE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
