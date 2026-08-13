'use strict';
// Functional test for the true queue/hold model in core/Manager.js, against the
// real Manager + DownloadTask + a local HTTP server (no mocks). Transfers are
// throttled via the Manager's own speedLimitKBps config (shared RateLimiter) so
// there's a real window to observe mid-flight 'running'/'queued' state instead
// of everything completing before the next `await` runs.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZE = 256 * 1024; // 256KB per file — small, so full-completion waits stay fast
const PAYLOAD = crypto.randomBytes(SIZE);

function startServer() {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : SIZE - 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${SIZE}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      res.end(PAYLOAD.slice(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': SIZE,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(PAYLOAD);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function makeManager(tmp, overrides = {}) {
  const cfg = {
    values: {
      destDirs: { General: path.join(tmp, 'General') },
      excludedSites: '',
      speedLimitKBps: 0,
      maxConcurrentDownloads: 2,
      ...overrides,
    },
    get(k) { return this.values[k]; },
    getAll() { return this.values; },
  };
  return new Manager({ stateDir: tmp, config: cfg });
}

async function waitUntil(fn, timeoutMs, stepMs = 50) {
  let waited = 0;
  while (!fn() && waited < timeoutMs) {
    await sleep(stepMs);
    waited += stepMs;
  }
  return fn();
}

async function testAddHeld(server) {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q1-'));
  const m = makeManager(tmp);

  const id = m.add({ url: `http://127.0.0.1:${port}/f`, startNow: false });
  const item = m.list().find((x) => x.id === id);
  check('add(startNow:false) creates a held item', item && item.status === 'held', JSON.stringify(item && item.status));

  await sleep(300);
  const stillHeld = m.list().find((x) => x.id === id);
  check('held item never auto-starts', stillHeld.status === 'held', stillHeld.status);

  m.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testStartQueueRunsHeldRespectingCap(server) {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q2-'));
  // Aggregate 200KB/s across 4x256KB = ~5s total to drain; cap=2 concurrent.
  const m = makeManager(tmp, { maxConcurrentDownloads: 2, speedLimitKBps: 200 });

  const ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push(m.add({ url: `http://127.0.0.1:${port}/f${i}`, startNow: false }));
  }
  const beforeStart = m.list();
  check('all 4 added as held before Start Queue', beforeStart.every((x) => x.status === 'held'));
  check('isQueueRunning false before Start Queue', m.isQueueRunning() === false);

  m.startQueue();
  check('isQueueRunning true after Start Queue', m.isQueueRunning() === true);

  await sleep(250); // mid-flight: well before any 256KB item finishes at a shared 200KB/s
  const running = m.list().filter((x) => x.status === 'running');
  const waiting = m.list().filter((x) => x.status === 'queued' || x.status === 'held');
  check('exactly maxConcurrentDownloads (2) running at once', running.length === 2, `running=${running.length}`);
  check('the other 2 still waiting', waiting.length === 2, `waiting=${waiting.length}`);

  const done = await waitUntil(() => m.list().every((x) => x.status === 'completed'), 15000, 200);
  check('all 4 eventually complete', done, JSON.stringify(m.list().map((x) => x.status)));

  m.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testStopQueueParksWaitingAndPausesRunning(server) {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q3-'));
  // Single active stream throttled to 100KB/s -> a 256KB item takes ~2.5s, plenty
  // of window to inspect mid-flight state and issue Stop Queue.
  const m = makeManager(tmp, { maxConcurrentDownloads: 1, speedLimitKBps: 100 });

  const idA = m.add({ url: `http://127.0.0.1:${port}/a`, startNow: false });
  const idB = m.add({ url: `http://127.0.0.1:${port}/b`, startNow: false });

  m.startQueue();
  await sleep(300);
  const midRun = m.list();
  check('with cap=1, only 1 running after Start Queue', midRun.filter((x) => x.status === 'running').length === 1);
  check('the second sits queued (eligible, waiting for slot)', midRun.find((x) => x.id === idB).status === 'queued');
  check('first item not yet complete (still mid-flight)', midRun.find((x) => x.id === idA).status === 'running');

  m.stopQueue();
  check('isQueueRunning false after Stop Queue', m.isQueueRunning() === false);
  await sleep(50);
  const bItem = m.list().find((x) => x.id === idB);
  check('the waiting item drops back to held on Stop Queue', bItem.status === 'held', bItem.status);

  // The running one should pause (not be killed/completed) — wait for it to settle.
  const settled = await waitUntil(() => m.list().find((x) => x.id === idA).status !== 'running', 5000, 100);
  const aItem = m.list().find((x) => x.id === idA);
  check('the running item pauses (not completed) on Stop Queue', settled && aItem.status === 'paused', aItem.status);
  check('paused item retained partial progress', aItem.progress && aItem.progress.downloaded > 0 && aItem.progress.downloaded < SIZE, JSON.stringify(aItem.progress && aItem.progress.downloaded));

  m.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testPauseBeforeStartRevertsToHeld(server) {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q4-'));
  // cap=1, throttled: A occupies the only slot; B never even gets a task, so its
  // 'queued' state is independent of A's speed, but we throttle anyway so A is
  // still cleanly 'running' (not finished) when we act.
  const m = makeManager(tmp, { maxConcurrentDownloads: 1, speedLimitKBps: 100 });

  const idA = m.add({ url: `http://127.0.0.1:${port}/x` }); // startNow true -> queued -> running
  const idB = m.add({ url: `http://127.0.0.1:${port}/y` }); // blocked by cap=1, stays queued

  await sleep(100);
  const bBefore = m.list().find((x) => x.id === idB);
  const aBefore = m.list().find((x) => x.id === idA);
  check('first item running', aBefore.status === 'running', aBefore.status);
  check('second item queued (not started) while first runs', bBefore.status === 'queued', bBefore.status);

  m.pause(idB); // no task yet -> should park back to held, not crash
  const bAfter = m.list().find((x) => x.id === idB);
  check('pausing a not-yet-started queued item reverts it to held', bAfter.status === 'held', bAfter.status);

  m.cancel(idA);
  m.cancel(idB);
  await waitUntil(() => m.list().find((x) => x.id === idA).status !== 'running', 3000, 100);
  m.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

(async () => {
  const server = await startServer();
  try {
    await testAddHeld(server);
    await testStartQueueRunsHeldRespectingCap(server);
    await testStopQueueParksWaitingAndPausesRunning(server);
    await testPauseBeforeStartRevertsToHeld(server);
  } catch (e) {
    console.error('ERROR', e);
    fails++;
  } finally {
    server.close();
  }
  console.log(`\n${fails === 0 ? 'ALL QUEUE/HOLD TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
