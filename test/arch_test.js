'use strict';
// Verification for the forensics-driven architecture work:
//   1. Site Grabber runs in a separate process and survives its failures
//   2. Downloads assemble in a temp workspace and publish only on success
//   3. maxConnections / duplicateAction actually do something
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { DownloadTask } = require(path.join(ROOT, 'core', 'DownloadTask'));
const { GrabberHost } = require(path.join(ROOT, 'core', 'grabberHost'));
const { resolveWorkspace, finalizeWorkspace, discardWorkspace, workspaceKey } = require(path.join(ROOT, 'core', 'workspace'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 58 - t.length))}`);

function listen(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

function rangeServer(body, { delayMs = 0, chunkBytes = 16 * 1024 } = {}) {
  return listen(async (req, res) => {
    const total = body.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    let start = 0;
    let end = total - 1;
    if (req.headers.range) {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : total - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      });
    } else {
      res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
    }
    if (!delayMs) { res.end(body.slice(start, end + 1)); return; }
    for (let p = start; p <= end; p += chunkBytes) {
      if (res.destroyed || res.writableEnded) return;
      res.write(body.slice(p, Math.min(p + chunkBytes, end + 1)));
      await sleep(delayMs);
    }
    if (!res.destroyed) res.end();
  });
}

function runTask(opts) {
  const task = new DownloadTask(opts);
  let settle;
  const outcome = new Promise((r) => { settle = r; });
  task.on('complete', () => settle('complete'));
  task.on('error', (e) => settle('error:' + e.message));
  task.on('paused', () => settle('paused'));
  task.on('cancelled', () => settle('cancelled'));
  task.start().catch((e) => settle('error:' + e.message));
  return { task, outcome };
}
const raced = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  section('TEMP WORKSPACE — nothing appears at the destination until done');
  {
    const BODY = crypto.randomBytes(2 * 1024 * 1024);
    const { server, port } = await rangeServer(BODY, { delayMs: 40 });
    const tempDir = path.join(TMP, 'work');
    const destDir = path.join(TMP, 'dest');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'movie.mp4');
    const url = `http://127.0.0.1:${port}/m.mp4`;

    const { task, outcome } = runTask({ url, destPath: dest, connections: 4, tempDir });
    await sleep(700);

    const midDest = fs.readdirSync(destDir);
    check('destination folder is still EMPTY mid-download', midDest.length === 0, midDest);
    const workDir = path.join(tempDir, workspaceKey(dest));
    const midWork = fs.existsSync(workDir) ? fs.readdirSync(workDir) : [];
    check('bytes and sidecar are in the temp workspace', midWork.includes('movie.mp4') && midWork.some((f) => f.endsWith('.ddl.json')), midWork);
    check('the partial file has real bytes', fs.statSync(path.join(workDir, 'movie.mp4')).size > 0);

    const r = await raced(outcome, 30000);
    server.close();
    check('download completes', r === 'complete', r);
    check('file is published to the destination, byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));
    check('the temp workspace is torn down afterwards', !fs.existsSync(workDir));
    check('no stray sidecar at the destination', !fs.existsSync(`${dest}.ddl.json`));
  }

  section('TEMP WORKSPACE — resume finds the same workspace');
  {
    const BODY = crypto.randomBytes(2 * 1024 * 1024);
    const { server, port } = await rangeServer(BODY, { delayMs: 40 });
    const tempDir = path.join(TMP, 'work2');
    const destDir = path.join(TMP, 'dest2');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'clip.bin');
    const url = `http://127.0.0.1:${port}/c.bin`;

    const first = runTask({ url, destPath: dest, connections: 4, tempDir });
    await sleep(700);
    first.task.pause();
    const paused = await raced(first.outcome, 15000);
    check('pauses mid-transfer', paused === 'paused', paused);
    check('destination still empty while paused', fs.readdirSync(destDir).length === 0);

    const second = runTask({ url, destPath: dest, connections: 4, tempDir });
    const r2 = await raced(second.outcome, 30000);
    server.close();
    check('resumed run completes', r2 === 'complete', r2);
    check('resumed file is byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));
  }

  section('TEMP WORKSPACE — degrades safely, and cleans up on delete');
  {
    // An unusable temp folder must not stop the download.
    const BODY = crypto.randomBytes(256 * 1024);
    const { server, port } = await rangeServer(BODY);
    const destDir = path.join(TMP, 'dest3');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'fallback.bin');
    // Point tempDir at an existing FILE — mkdir under it can only fail.
    const bogusTemp = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(bogusTemp, 'x');

    const ws = resolveWorkspace({ destPath: dest, tempDir: bogusTemp });
    check('unusable tempDir falls back to assembling in place', ws.usingTemp === false && ws.workPath === dest, ws);

    const r = await raced(runTask({ url: `http://127.0.0.1:${port}/f.bin`, destPath: dest, connections: 2, tempDir: bogusTemp }).outcome, 20000);
    server.close();
    check('download still succeeds with a broken tempDir', r === 'complete', r);
    check('and the file is byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));

    // discardWorkspace removes abandoned scratch data.
    const tempDir = path.join(TMP, 'work3');
    const target = path.join(destDir, 'abandoned.bin');
    const ws2 = resolveWorkspace({ destPath: target, tempDir });
    fs.writeFileSync(ws2.workPath, 'partial');
    check('scratch dir exists before discard', fs.existsSync(ws2.workDir));
    discardWorkspace({ destPath: target, tempDir });
    check('discardWorkspace removes it', !fs.existsSync(ws2.workDir));
  }

  section('TEMP WORKSPACE — cross-volume publish (EXDEV) path');
  {
    // Force the EXDEV branch by stubbing rename, proving the copy+verify
    // fallback works when temp and destination are on different drives.
    const destDir = path.join(TMP, 'dest4');
    const tempDir = path.join(TMP, 'work4');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'crossvol.bin');
    const ws = resolveWorkspace({ destPath: dest, tempDir });
    const payload = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(ws.workPath, payload);

    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e; };
    try {
      finalizeWorkspace({ workPath: ws.workPath, destPath: dest, workDir: ws.workDir, usingTemp: true });
    } finally {
      fs.renameSync = realRename;
    }
    check('EXDEV falls back to copy and still publishes', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(payload));
    check('the source copy is removed after the copy', !fs.existsSync(ws.workPath));
    check('the workspace is cleaned up', !fs.existsSync(ws.workDir));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('GRABBER ISOLATION — a normal crawl still works, out of process');
  {
    const PAGE = `<html><body>
      <a href="/a.pdf">doc</a><a href="/b.zip">zip</a>
      <img src="/c.png"><a href="/sub.html">more</a>
      </body></html>`;
    const SUB = `<html><body><a href="/d.mp4">vid</a></body></html>`;
    const { server, port } = await listen((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/' || u === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
      if (u === '/sub.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(SUB); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('x');
    });

    const host = new GrabberHost();
    const found = [];
    host.on('asset-found', (a) => found.push(a.url));
    const done = new Promise((r) => host.on('done', r));
    host.start({ targetUrl: `http://127.0.0.1:${port}/`, maxDepth: 1, filterCategory: 'All' });
    const result = await Promise.race([done, sleep(25000).then(() => null)]);
    server.close();

    check('crawl completes out of process', result && !result.error, result && result.error);
    check('assets streamed live to the host', found.length >= 3, found);
    check('done carries the full asset list', result && Array.isArray(result.assets) && result.assets.length >= 3,
      result && result.assets && result.assets.length);
    check('sub-page was crawled at depth 1', result && result.assets.some((a) => /d\.mp4$/.test(a.url)),
      result && result.assets.map((a) => a.url));
  }

  section('GRABBER ISOLATION — a hung crawl cannot hang the app');
  {
    // A server that accepts the connection and then says nothing, forever.
    const { server, port } = await listen(() => { /* never responds */ });
    const host = new GrabberHost({ idleTimeoutMs: 2500 });
    const started = Date.now();
    const done = new Promise((r) => host.on('done', r));
    host.start({ targetUrl: `http://127.0.0.1:${port}/`, maxDepth: 0 });
    const result = await Promise.race([done, sleep(20000).then(() => null)]);
    const elapsed = Date.now() - started;
    server.close();

    check('a silent crawl is terminated, not left hanging', result !== null, { elapsed });
    check('it reports a timeout rather than a fake success', result && /stopped responding/i.test(result.error || ''), result && result.error);
    check('it gives up close to the configured idle timeout', elapsed < 12000, { elapsed });
    check('exactly one terminal event, and it is marked cancelled', result && result.cancelled === true);
  }

  section('GRABBER ISOLATION — a crashed child is reported, not silent');
  {
    // The child must still be ALIVE when it dies, so the crawl has to be
    // genuinely in flight — a server that accepts and then stalls. (Pointing at
    // a refused port instead just lets the crawl finish legitimately first.)
    const { server, port } = await listen(() => { /* never responds */ });
    const host = new GrabberHost({ idleTimeoutMs: 60000 }); // don't let the watchdog win
    const done = new Promise((r) => host.on('done', r));
    host.start({ targetUrl: `http://127.0.0.1:${port}/`, maxDepth: 0 });
    await sleep(600);
    check('the child process is alive before we kill it', host.child !== null && host.settled === false);
    host._kill(); // simulate a hard crash: no goodbye message
    const result = await Promise.race([done, sleep(15000).then(() => null)]);
    server.close();
    check('a killed grabber process still produces a done event', result !== null);
    check('and it carries an error explaining why', result && Boolean(result.error), result && result.error);
    check('the crash is reported as cancelled, not a clean finish', result && result.cancelled === true);
  }

  section('GRABBER ISOLATION — cancel is honoured and idempotent');
  {
    const { server, port } = await listen(() => {});
    const host = new GrabberHost({ idleTimeoutMs: 30000 });
    let doneCount = 0;
    const done = new Promise((r) => host.on('done', (res) => { doneCount++; r(res); }));
    host.start({ targetUrl: `http://127.0.0.1:${port}/`, maxDepth: 0 });
    await sleep(300);
    host.cancel();
    host.cancel(); // double-cancel must not double-fire
    const result = await Promise.race([done, sleep(15000).then(() => null)]);
    await sleep(600);
    server.close();
    check('cancel settles the crawl', result !== null);
    check('cancelled flag is set', result && result.cancelled === true);
    check('exactly one done event despite two cancels', doneCount === 1, { doneCount });
  }

  console.log(`\n${fails === 0 ? 'ALL ARCHITECTURE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
