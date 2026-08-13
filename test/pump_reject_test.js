'use strict';
// Does a REJECTING _runItem leave the queue in a sane state?
// The pump does `this._runItem(next).finally(...)` with no .catch(), and
// _runItem constructs the task OUTSIDE its own try/catch.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpsafe-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e && e.message));

function fakeConfig(v = {}) {
  const store = { destDirs: { General: path.join(TMP, 'dl') }, duplicateAction: 'allow', ...v };
  return { get: (k) => store[k], set: (k, x) => { store[k] = x; }, getAll: () => store };
}

(async () => {
  const stateDir = path.join(TMP, 'st');
  fs.mkdirSync(stateDir, { recursive: true });
  const m = new Manager({ stateDir, config: fakeConfig() });

  // Force _runItem to reject the way a throwing task constructor would.
  const realRun = m._runItem.bind(m);
  m._runItem = async (item) => {
    if (item.url.includes('boom')) throw new Error('task construction blew up');
    return realRun(item);
  };

  const id = m.add({ url: 'https://ex.test/boom.bin' });
  await sleep(300);

  const item = m.items.get(id);
  console.log(`\n  status after rejection: ${item.status}`);
  console.log(`  runningByQueue: ${JSON.stringify([...m.runningByQueue])}  runningCount: ${m.runningCount}`);
  console.log(`  unhandled rejections: ${JSON.stringify(unhandled)}`);

  check('the slot is released', (m.runningByQueue.get('main') || 0) === 0, m.runningByQueue.get('main'));
  check('the item does NOT stay stuck as running', item.status !== 'running', item.status);
  check('the rejection is handled, not left unhandled', unhandled.length === 0, unhandled);

  // A second download must still be able to start afterwards.
  const id2 = m.add({ url: 'https://ex.test/ok.bin' });
  await sleep(200);
  check('the queue still accepts and starts new work', m.items.get(id2).status !== 'queued', m.items.get(id2).status);

  m.db.close();
  console.log(`\n${fails === 0 ? 'PUMP REJECTION HANDLING OK' : fails + ' PROBLEM(S) FOUND'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
