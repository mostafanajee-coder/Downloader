'use strict';
// Integration test for the edited download engine. No electron required.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { DownloadTask } = require(path.join(ROOT, 'core', 'DownloadTask'));
const { RateLimiter } = require(path.join(ROOT, 'core', 'rateLimiter'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dltest-'));
const SIZE = 8 * 1024 * 1024; // 8 MB
const PAYLOAD = crypto.randomBytes(SIZE);
const PAYLOAD_MD5 = crypto.createHash('md5').update(PAYLOAD).digest('hex');

function startServer({ acceptRanges = true } = {}) {
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (acceptRanges && range) {
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
    const head = { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE };
    if (acceptRanges) head['Accept-Ranges'] = 'bytes';
    res.writeHead(200, head);
    if (req.method === 'HEAD') return res.end();
    res.end(PAYLOAD);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function md5File(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

async function testMultiSegment(server) {
  const port = server.address().port;
  const dest = path.join(TMP, 'multi.bin');
  const task = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 8 });
  let splits = 0;
  task.on('segment-split', () => splits++);
  await task.start();
  check('multi-segment integrity', md5File(dest) === PAYLOAD_MD5, `splits=${splits}`);
  check('meta cleaned up on complete', !fs.existsSync(dest + '.ddl.json'));
}

async function testGlobalLimiter(server) {
  const port = server.address().port;
  // Shared limiter = global cap of 2 MB/s across BOTH tasks.
  const limiter = new RateLimiter(2 * 1024 * 1024);
  const d1 = path.join(TMP, 'g1.bin');
  const d2 = path.join(TMP, 'g2.bin');
  const t1 = new DownloadTask({ url: `http://127.0.0.1:${port}/a`, destPath: d1, connections: 4, rateLimiter: limiter });
  const t2 = new DownloadTask({ url: `http://127.0.0.1:${port}/b`, destPath: d2, connections: 4, rateLimiter: limiter });
  const start = Date.now();
  await Promise.all([t1.start(), t2.start()]);
  const secs = (Date.now() - start) / 1000;
  const totalBytes = SIZE * 2; // 16 MB
  const effectiveRate = totalBytes / secs / (1024 * 1024); // MB/s aggregate
  check('global limiter integrity t1', md5File(d1) === PAYLOAD_MD5);
  check('global limiter integrity t2', md5File(d2) === PAYLOAD_MD5);
  // 16MB at a shared 2MB/s should take ~8s. Allow generous headroom but prove
  // the aggregate rate is actually capped (well under, say, 6 MB/s).
  check('global cap enforced (aggregate <= ~3 MB/s)', effectiveRate <= 3.2, `measured ${effectiveRate.toFixed(2)} MB/s over ${secs.toFixed(1)}s`);
}

async function testPauseResume(server) {
  const port = server.address().port;
  const dest = path.join(TMP, 'pr.bin');
  // Throttle so the 8MB transfer takes ~4s, giving a real window to pause.
  const task = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 4, speedLimit: 2 * 1024 * 1024 });
  let paused = 0;
  task.on('paused', () => paused++);
  // Pause partway through.
  setTimeout(() => task.pause(), 800);
  await task.start();
  const partial = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  check('paused event fired', paused === 1);
  check('meta retained after pause (resumable)', fs.existsSync(dest + '.ddl.json'));
  // Resume to completion.
  const task2 = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 4 });
  let resumed = false;
  task2.on('start', (info) => { resumed = info.resumed; });
  await task2.start();
  check('resume flagged as resumed', resumed === true, `partial preallocated=${partial}`);
  check('pause/resume final integrity', md5File(dest) === PAYLOAD_MD5);
}

async function testNoRanges(server) {
  const port = server.address().port;
  const dest = path.join(TMP, 'nr.bin');
  const task = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 8 });
  await task.start();
  check('single-stream (no ranges) integrity', md5File(dest) === PAYLOAD_MD5);
}

(async () => {
  const rangeServer = await startServer({ acceptRanges: true });
  const plainServer = await startServer({ acceptRanges: false });
  try {
    await testMultiSegment(rangeServer);
    await testPauseResume(rangeServer);
    await testGlobalLimiter(rangeServer);
    await testNoRanges(plainServer);
  } catch (e) {
    console.error('ERROR', e);
    failures++;
  } finally {
    rangeServer.close();
    plainServer.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
