'use strict';
// Verification suite for the Tier 0 engine hardening. Every test drives the
// REAL core/DownloadTask against a local server reproducing a specific
// real-world server behaviour, and checks the resulting file byte for byte —
// because every bug fixed here originally presented as a successful download.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { DownloadTask } = require(path.join(ROOT, 'core', 'DownloadTask'));
const { probe } = require(path.join(ROOT, 'core', 'probe'));
const { configureHttp } = require(path.join(ROOT, 'core', 'httpUtils'));
const { selfSignedCert } = require('./helpers/selfSignedCert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tier0-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 60 - t.length))}`);

function listen(handler, tls) {
  return new Promise((res) => {
    const s = tls ? https.createServer(tls, handler) : http.createServer(handler);
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

/**
 * Range-capable static server. `delayMs` streams the body in `chunkBytes`
 * pieces with a pause between them, which is what makes pause/kill land in the
 * MIDDLE of a transfer — over plain localhost a few MB completes faster than
 * the first progress tick, so the interesting states are never reached.
 */
function rangeServer(body, { delayMs = 0, chunkBytes = 16 * 1024 } = {}) {
  let requests = 0;
  return listen(async (req, res) => {
    requests++;
    const total = body.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    let start = 0;
    let end = total - 1;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
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
    if (!delayMs) {
      res.end(body.slice(start, end + 1));
      return;
    }
    for (let p = start; p <= end; p += chunkBytes) {
      if (res.destroyed || res.writableEnded) return; // client went away
      res.write(body.slice(p, Math.min(p + chunkBytes, end + 1)));
      await sleep(delayMs);
    }
    if (!res.destroyed) res.end();
  }).then((h) => ({ ...h, requests: () => requests }));
}

function runTask(opts) {
  const task = new DownloadTask(opts);
  let settle;
  const outcome = new Promise((resolve) => { settle = resolve; });
  task.on('complete', () => settle('complete'));
  task.on('error', (e) => settle('error:' + e.message));
  task.on('cancelled', () => settle('cancelled'));
  task.on('paused', () => settle('paused'));
  // A failure inside start() itself (a rejected probe: bad certificate, DNS,
  // connection refused) rejects without ever emitting 'error' —
  // Manager._runItem catches that separately, so the harness must too.
  task.start().catch((e) => settle('error:' + e.message));
  return { task, outcome };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const raced = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 1 - missing Content-Length no longer loops forever');
  {
    let requests = 0;
    const BODY = crypto.randomBytes(64 * 1024);
    const { server, port } = await listen((req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); // chunked, no length
      res.end(BODY);
    });
    const dest = path.join(TMP, 'nolen.bin');
    const { task, outcome } = runTask({ url: `http://127.0.0.1:${port}/f.bin`, destPath: dest, connections: 4 });
    const result = await raced(outcome, 10000);
    task.cancel();
    await sleep(150);
    server.close();

    check('terminates instead of looping', result === 'complete', { result, requests });
    check('makes a bounded number of requests', requests <= 5, { requests });
    check('file is byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));
    check('sidecar cleaned up on success', !fs.existsSync(`${dest}.ddl.json`));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 2 - compressed responses are no longer truncated');
  for (const [label, encode, encoding] of [
    ['gzip', zlib.gzipSync, 'gzip'],
    ['brotli', zlib.brotliCompressSync, 'br'],
    ['deflate', zlib.deflateSync, 'deflate'],
  ]) {
    const RAW = Buffer.concat([crypto.randomBytes(256 * 1024), Buffer.alloc(256 * 1024, 0x42)]);
    const ENC = encode(RAW);
    let sawIdentity = false;
    const { server, port } = await listen((req, res) => {
      if ((req.headers['accept-encoding'] || '').includes('identity')) sawIdentity = true;
      // A server that compresses regardless of Accept-Encoding: identity.
      res.writeHead(200, {
        'Content-Encoding': encoding,
        'Content-Length': String(ENC.length),
        'Accept-Ranges': 'bytes',
      });
      res.end(ENC);
    });
    const dest = path.join(TMP, `enc-${label}.bin`);
    const { task, outcome } = runTask({ url: `http://127.0.0.1:${port}/c.bin`, destPath: dest, connections: 4 });
    const result = await raced(outcome, 15000);
    task.cancel();
    await sleep(150);
    server.close();

    check(`[${label}] we ask for identity encoding`, sawIdentity);
    check(`[${label}] completes`, result === 'complete', { result });
    check(
      `[${label}] full ${RAW.length}B written, not the ${ENC.length}B compressed length`,
      fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(RAW),
      { onDisk: fs.existsSync(dest) ? fs.statSync(dest).size : 0, raw: RAW.length }
    );
  }
  {
    const RAW = Buffer.alloc(400 * 1024, 0x43);
    const GZ = zlib.gzipSync(RAW);
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(GZ.length), 'Accept-Ranges': 'bytes' });
      res.end(GZ);
    });
    const info = await probe(`http://127.0.0.1:${port}/p.bin`);
    server.close();
    check('probe reports the encoding', info.contentEncoding === 'gzip', info.contentEncoding);
    check('probe refuses to report a compressed size', info.size === null, { size: info.size });
    check('probe disables ranges for a compressed body', info.acceptRanges === false);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 3a - pause / resume mid-transfer is byte-exact');
  {
    const BODY = crypto.randomBytes(2 * 1024 * 1024);
    const { server, port } = await rangeServer(BODY, { delayMs: 40 });
    const dest = path.join(TMP, 'pause.bin');
    const meta = `${dest}.ddl.json`;
    const url = `http://127.0.0.1:${port}/r.bin`;

    const first = runTask({ url, destPath: dest, connections: 4 });
    await sleep(700); // long enough for real bytes to land, short enough to be partial
    first.task.pause();
    const paused = await raced(first.outcome, 15000);
    check('settles as paused mid-transfer', paused === 'paused', paused);

    const saved = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const claimed = saved.segments.reduce((a, s) => a + s.downloaded, 0);
    check('paused before the file was finished', claimed > 0 && claimed < BODY.length, { claimed, total: BODY.length });
    check('sidecar never persists the transient `active` flag',
      saved.segments.every((s) => !('active' in s)), saved.segments[0]);
    check('sidecar never claims more than a segment can hold',
      saved.segments.every((s) => s.downloaded <= s.end - s.start + 1));

    const second = runTask({ url, destPath: dest, connections: 4 });
    const r2 = await raced(second.outcome, 30000);
    server.close();
    check('resumed run completes', r2 === 'complete', r2);
    check('RESUMED FILE IS BYTE-EXACT', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY),
      { onDisk: fs.existsSync(dest) ? fs.statSync(dest).size : 0, want: BODY.length });
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 3b - SIGKILL mid-transfer, then resume, is byte-exact');
  {
    const BODY = crypto.randomBytes(2 * 1024 * 1024);
    const { server, port } = await rangeServer(BODY, { delayMs: 40 });
    const dest = path.join(TMP, 'killed.bin');
    const meta = `${dest}.ddl.json`;
    const url = `http://127.0.0.1:${port}/k.bin`;

    const child = spawn(process.execPath, [path.join(__dirname, 'killer_child.js'), url, dest, '4']);
    let ready = false;
    let exited = false;
    child.stdout.on('data', (d) => { if (String(d).includes('READY')) ready = true; });
    child.on('exit', () => { exited = true; });

    const deadline = Date.now() + 10000;
    while (!ready && !exited && Date.now() < deadline) await sleep(25);
    check('child got bytes flowing before we killed it', ready && !exited, { ready, exited });

    child.kill('SIGKILL');
    // Guarded: if the child already died, 'exit' has fired and will not fire
    // again, so waiting on it unconditionally would hang forever.
    const killDeadline = Date.now() + 5000;
    while (!exited && Date.now() < killDeadline) await sleep(25);

    let metaValid = false;
    let claimed = null;
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      metaValid = Array.isArray(m.segments);
      claimed = m.segments.reduce((a, s) => a + s.downloaded, 0);
    } catch {}
    check('sidecar survived the kill as valid JSON', metaValid);
    check('sidecar records partial progress', claimed > 0 && claimed < BODY.length, { claimed, total: BODY.length });

    const { outcome } = runTask({ url, destPath: dest, connections: 4 });
    const r = await raced(outcome, 40000);
    server.close();
    check('resumed run completes', r === 'complete', r);
    check('RESUMED FILE IS BYTE-EXACT AFTER A HARD KILL', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY),
      { onDisk: fs.existsSync(dest) ? fs.statSync(dest).size : 0, want: BODY.length });
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 3c - a corrupt sidecar degrades gracefully');
  {
    const BODY = crypto.randomBytes(512 * 1024);
    const { server, port } = await rangeServer(BODY);
    const dest = path.join(TMP, 'corrupt.bin');
    fs.writeFileSync(dest, Buffer.alloc(10));
    fs.writeFileSync(`${dest}.ddl.json`, '{"url":"http://x","segments":[{"index":0,'); // truncated JSON
    const { outcome } = runTask({ url: `http://127.0.0.1:${port}/c2.bin`, destPath: dest, connections: 4 });
    const r = await raced(outcome, 20000);
    server.close();
    check('recovers with a clean download instead of failing', r === 'complete', r);
    check('file is byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 4 - a short transfer can no longer report success');
  {
    const TOTAL = 400 * 1024;
    const BODY = crypto.randomBytes(TOTAL);
    const { server, port } = await listen((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(TOTAL) }); // no Accept-Ranges
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(TOTAL) });
      res.end(BODY.slice(0, TOTAL / 2)); // declares one length, delivers half
    });
    const dest = path.join(TMP, 'short.bin');
    // retries: 1 keeps the exponential backoff short; the behaviour under test
    // is what happens between attempts, not how many there are.
    const { task, outcome } = runTask({ url: `http://127.0.0.1:${port}/s.bin`, destPath: dest, connections: 4, retries: 1 });
    const r = await raced(outcome, 40000);
    task.cancel();
    await sleep(150);
    server.close();
    check('a truncated transfer errors instead of completing', String(r).startsWith('error:'), r);
    check('the sidecar is kept so the user can retry', fs.existsSync(`${dest}.ddl.json`));
    check('the half-file was NOT padded to full length by replaying the body',
      !fs.existsSync(dest) || fs.readFileSync(dest).slice(0, TOTAL / 2).equals(BODY.slice(0, TOTAL / 2)),
      { onDisk: fs.existsSync(dest) ? fs.statSync(dest).size : 0 });
  }
  {
    const BODY = crypto.randomBytes(2 * 1024 * 1024);
    const { server, port } = await rangeServer(BODY);
    const dest = path.join(TMP, 'healthy.bin');
    const { outcome } = runTask({ url: `http://127.0.0.1:${port}/h.bin`, destPath: dest, connections: 8 });
    const r = await raced(outcome, 30000);
    server.close();
    check('a healthy multi-connection download still completes', r === 'complete', r);
    check('and is byte-exact', fs.existsSync(dest) && sha(fs.readFileSync(dest)) === sha(BODY));
    check('no stray .tmp sidecar left behind', !fs.existsSync(`${dest}.ddl.json.tmp`));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('FIX 5 - TLS certificates are verified by default');
  {
    const BODY = crypto.randomBytes(128 * 1024);
    // Generated on demand rather than committed — see helpers/selfSignedCert.js.
    const tls = selfSignedCert();
    if (!tls) {
      console.log('SKIP  TLS handshake checks — OpenSSL not available to generate a test certificate');
      console.log(`\n${fails === 0 ? 'ALL TIER 0 VERIFICATION TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
      process.exit(fails === 0 ? 0 : 1);
    }
    const { server, port } = await listen((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(BODY.length), 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(BODY.length), 'Accept-Ranges': 'bytes' });
      res.end(BODY);
    }, tls);
    const url = `https://127.0.0.1:${port}/tls.bin`;

    const r1 = await raced(runTask({ url, destPath: path.join(TMP, 'tls1.bin'), connections: 2 }).outcome, 15000);
    check('a self-signed certificate is REJECTED by default', String(r1).startsWith('error:'), r1);
    check('the failure names a certificate problem',
      /self[- ]signed|certificate|DEPTH_ZERO|unable to verify/i.test(String(r1)), r1);

    configureHttp({ allowInsecureTLS: true });
    const dest2 = path.join(TMP, 'tls2.bin');
    const r2 = await raced(runTask({ url, destPath: dest2, connections: 2 }).outcome, 20000);
    check('the explicit allowInsecureTLS opt-in still works', r2 === 'complete', r2);
    check('and delivers a byte-exact file', fs.existsSync(dest2) && sha(fs.readFileSync(dest2)) === sha(BODY));

    configureHttp({ allowInsecureTLS: false });
    const r3 = await raced(runTask({ url, destPath: path.join(TMP, 'tls3.bin'), connections: 2 }).outcome, 15000);
    check('turning the opt-in back off restores rejection', String(r3).startsWith('error:'), r3);

    server.close();
  }

  console.log(`\n${fails === 0 ? 'ALL TIER 0 VERIFICATION TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
