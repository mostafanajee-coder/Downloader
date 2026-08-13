'use strict';
// Multi-queue subsystem, driven against the real Manager + a real SQLite store.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(path.join(path.join(__dirname, '..'), 'node_modules', 'better-sqlite3'));

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queues-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 56 - t.length))}`);

function fakeConfig(v = {}) {
  const store = { destDirs: { General: path.join(TMP, 'dl') }, duplicateAction: 'allow', ...v };
  return { get: (k) => store[k], set: (k, x) => { store[k] = x; }, getAll: () => store };
}
let seq = 0;
function makeManager(cfg, dirName) {
  const stateDir = path.join(TMP, dirName || `state${seq++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return new Manager({ stateDir, config: fakeConfig(cfg) });
}

(() => {
  // ══════════════════════════════════════════════════════════════════════════
  section('Default queues');
  {
    const m = makeManager();
    const qs = m.listQueues();
    check('two default queues exist', qs.length === 2, qs.map((q) => q.name));
    check('Main download queue is first', qs[0].id === 'main' && qs[0].name === 'Main download queue', qs[0]);
    check('Synchronization queue exists', qs[1].id === 'sync' && qs[1].name === 'Synchronization queue', qs[1]);
    check('both are marked as built-in', qs.every((q) => q.isDefault === true));
    check('the sync queue defaults to one at a time', qs[1].maxConcurrent === 1, qs[1].maxConcurrent);
    check('no queue is running at startup', qs.every((q) => q.running === false));
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Per-queue concurrency');
  {
    // Global cap 4, but this queue is limited to 2 — only 2 may run.
    const m = makeManager({ maxConcurrentDownloads: 4 });
    const qid = m.createQueue('Slow lane', 2);
    for (let i = 0; i < 5; i++) m.add({ url: `https://ex.test/f${i}.bin`, queueId: qid });
    const running = Array.from(m.items.values()).filter((i) => i.status === 'running');
    check("a queue's own limit caps its running count", running.length === 2, { running: running.length });
    check('the rest wait as queued', Array.from(m.items.values()).filter((i) => i.status === 'queued').length === 3);
    check('the per-queue running counter matches', m.runningByQueue.get(qid) === 2, m.runningByQueue.get(qid));
    m.db.close();
  }
  {
    // Two queues run concurrently — one busy queue must not starve another.
    const m = makeManager({ maxConcurrentDownloads: 10 });
    const a = m.createQueue('A', 2);
    const b = m.createQueue('B', 3);
    for (let i = 0; i < 5; i++) m.add({ url: `https://ex.test/a${i}.bin`, queueId: a });
    for (let i = 0; i < 5; i++) m.add({ url: `https://ex.test/b${i}.bin`, queueId: b });
    check('queue A runs its own 2', m.runningByQueue.get(a) === 2, m.runningByQueue.get(a));
    check('queue B runs its own 3 in parallel', m.runningByQueue.get(b) === 3, m.runningByQueue.get(b));
    check('total running is the sum, not a shared cap', m.runningCount === 5, m.runningCount);
    m.db.close();
  }
  {
    const m = makeManager({ maxConcurrentDownloads: 4 });
    const qid = m.createQueue('Growing', 1);
    for (let i = 0; i < 4; i++) m.add({ url: `https://ex.test/g${i}.bin`, queueId: qid });
    check('starts with 1 running', m.runningByQueue.get(qid) === 1);
    m.setQueueConcurrency(qid, 3);
    check('raising the limit immediately starts more', m.runningByQueue.get(qid) === 3, m.runningByQueue.get(qid));
    m.db.close();
  }
  {
    const m = makeManager({ maxConcurrentDownloads: 3 });
    const qid = m.createQueue('Follows global', 0);
    for (let i = 0; i < 5; i++) m.add({ url: `https://ex.test/h${i}.bin`, queueId: qid });
    check('maxConcurrent 0 follows the global setting', m.runningByQueue.get(qid) === 3, m.runningByQueue.get(qid));
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Independent start / stop');
  {
    const m = makeManager({ maxConcurrentDownloads: 4 });
    const a = m.createQueue('A', 1);
    const b = m.createQueue('B', 1);
    m.add({ url: 'https://ex.test/a.bin', queueId: a, startNow: false });
    m.add({ url: 'https://ex.test/b.bin', queueId: b, startNow: false });
    check('held items do not start on their own',
      Array.from(m.items.values()).every((i) => i.status === 'held'));

    m.startQueue(a);
    const inA = Array.from(m.items.values()).filter((i) => (i.queueId || 'main') === a);
    const inB = Array.from(m.items.values()).filter((i) => (i.queueId || 'main') === b);
    check('starting queue A runs only A', inA[0].status === 'running' && inB[0].status === 'held',
      { a: inA[0].status, b: inB[0].status });
    check('isQueueRunning() is true when any queue runs', m.isQueueRunning() === true);
    check('only queue A is flagged running', m.listQueues().find((q) => q.id === a).running === true &&
      m.listQueues().find((q) => q.id === b).running === false);

    m.stopQueue(a);
    check('stopping A clears the global running flag', m.isQueueRunning() === false);
    m.db.close();
  }
  {
    const m = makeManager({ maxConcurrentDownloads: 4 });
    m.add({ url: 'https://ex.test/x.bin', startNow: false });
    m.add({ url: 'https://ex.test/y.bin', queueId: 'sync', startNow: false });
    m.startQueue(); // no argument = every queue, the legacy toolbar behaviour
    check('argument-less startQueue starts them all',
      m.listQueues().every((q) => q.running === true), m.listQueues().map((q) => q.running));
    m.stopQueue();
    check('argument-less stopQueue stops them all',
      m.listQueues().every((q) => q.running === false));
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Ordering and reordering');
  {
    const m = makeManager({ maxConcurrentDownloads: 1 });
    const qid = m.createQueue('Ordered', 1);
    const ids = [];
    for (const n of ['first', 'second', 'third', 'fourth']) {
      ids.push(m.add({ url: `https://ex.test/${n}.bin`, queueId: qid, startNow: false }));
    }
    const order = () => m._itemsInQueue(qid).map((i) => i.url.match(/\/(\w+)\.bin/)[1]);
    check('items keep insertion order', order().join(',') === 'first,second,third,fourth', order());

    m.reorder(ids[3], -1);
    check('move up swaps with the previous item', order().join(',') === 'first,second,fourth,third', order());
    m.reorder(ids[3], -1);
    m.reorder(ids[3], -1);
    check('repeated moves walk it to the top', order().join(',') === 'fourth,first,second,third', order());
    m.reorder(ids[3], -1);
    check('moving past the top is a no-op', order().join(',') === 'fourth,first,second,third', order());

    m.reorder(ids[0], 1);
    check('move down works too', order().join(',') === 'fourth,second,first,third', order());
    m.db.close();
  }
  {
    // Order is what the pump consumes, not merely a display sort.
    const m = makeManager({ maxConcurrentDownloads: 1 });
    const qid = m.createQueue('Priority', 1);
    m.add({ url: 'https://ex.test/one.bin', queueId: qid, startNow: false });
    const lastId = m.add({ url: 'https://ex.test/two.bin', queueId: qid, startNow: false });
    m.reorder(lastId, -1); // promote the second one to the front
    m.startQueue(qid);
    const running = Array.from(m.items.values()).find((i) => i.status === 'running');
    check('the promoted download is the one that starts', running && running.id === lastId,
      running && running.url);
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Moving between queues');
  {
    const m = makeManager({ maxConcurrentDownloads: 4 });
    const qid = m.createQueue('Target', 2);
    const id = m.add({ url: 'https://ex.test/m.bin', startNow: false });
    check('a new download lands in the main queue', m.items.get(id).queueId === 'main');
    m.moveToQueue([id], qid);
    check('moveToQueue reassigns it', m.items.get(id).queueId === qid);
    check('the counts follow it',
      m.listQueues().find((q) => q.id === qid).count === 1 &&
      m.listQueues().find((q) => q.id === 'main').count === 0);
    m.db.close();
  }
  {
    const m = makeManager({ maxConcurrentDownloads: 4 });
    const qid = m.createQueue('Doomed', 1);
    const id = m.add({ url: 'https://ex.test/d.bin', queueId: qid, startNow: false });
    m.deleteQueue(qid);
    check('deleting a queue does NOT delete its downloads', m.items.has(id));
    check('they fall back to the main queue', m.items.get(id).queueId === 'main');
    check('the queue is gone', !m.listQueues().some((q) => q.id === qid));
    m.db.close();
  }
  {
    const m = makeManager();
    m.deleteQueue('main');
    m.deleteQueue('sync');
    check('the two built-in queues cannot be deleted', m.listQueues().length === 2);
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Persistence and migration');
  {
    const dir = 'persist-state';
    const m1 = makeManager({}, dir);
    const qid = m1.createQueue('Survivor', 5);
    const id = m1.add({ url: 'https://ex.test/p.bin', queueId: qid, startNow: false });
    m1.reorder(id, -1);
    m1.db.close();

    const m2 = makeManager({}, dir);
    const found = m2.listQueues().find((q) => q.name === 'Survivor');
    check('a custom queue survives a restart', Boolean(found), m2.listQueues().map((q) => q.name));
    check('its concurrency survives too', found && found.maxConcurrent === 5, found && found.maxConcurrent);
    check('its download is still assigned to it', m2.items.get(id) && m2.items.get(id).queueId === qid);
    check('queues do not auto-resume after a restart', m2.listQueues().every((q) => !q.running));
    m2.db.close();
  }
  {
    // A pre-queues database: downloads table without queueId/position.
    const stateDir = path.join(TMP, 'legacy-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const db = new Database(path.join(stateDir, 'queue.db'));
    db.exec(`CREATE TABLE downloads (id TEXT PRIMARY KEY, kind TEXT, url TEXT, destPath TEXT, destDir TEXT,
      headers TEXT, connections INTEGER, variantIndex INTEGER, status TEXT, filename TEXT, error TEXT,
      addedAt INTEGER, progress TEXT)`);
    db.prepare(`INSERT INTO downloads (id,kind,url,status,addedAt,headers,connections,variantIndex,progress)
      VALUES ('old1','file','https://ex.test/legacy.bin','paused',1000,'{}',8,0,'null')`).run();
    db.close();

    const m = new Manager({ stateDir, config: fakeConfig() });
    check('an existing pre-queues download survives the migration', m.items.has('old1'));
    check('and is adopted into the main queue', m.items.get('old1').queueId === 'main', m.items.get('old1').queueId);
    const cols = m.db.prepare('PRAGMA table_info(downloads)').all().map((c) => c.name);
    check('the new columns were added, not recreated', cols.includes('queueId') && cols.includes('position'), cols);
    // Re-opening must not double-add the columns.
    m.db.close();
    const m2 = new Manager({ stateDir, config: fakeConfig() });
    check('re-opening an already-migrated database is safe', m2.items.has('old1'));
    m2.db.close();
  }

  console.log(`\n${fails === 0 ? 'ALL QUEUE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})();
