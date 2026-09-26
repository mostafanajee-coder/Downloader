'use strict';
// Regression suite for the second engine hardening pass. Like tier0, every
// case drives the REAL DownloadTask against a local server that reproduces one
// specific real-world behaviour, and checks the result byte for byte.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { DownloadTask, resolveFilename, parseContentRange } = require(path.join(ROOT, 'core', 'DownloadTask'));
const { configureHttp, request } = require(path.join(ROOT, 'core', 'httpUtils'));
const { sanitizeFilename, numberedVariant } = require(path.join(ROOT, 'core', 'filename'));
const { parseContentDisposition, extractFilename } = require(path.join(ROOT, 'core', 'probe'));
const { scopeHeaders, siteOf } = require(path.join(ROOT, 'core', 'headerScope'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 60 - t.length))}`);
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function listen(handler, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, host, () => res({ server: s, port: s.address().port }));
  });
}

function runTask(task, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ result: 'timeout' }), timeoutMs);
    task.on('complete', () => { clearTimeout(t); resolve({ result: 'complete' }); });
    task.on('error', (e) => { clearTimeout(t); resolve({ result: 'error', error: e.message }); });
    task.on('paused', () => { clearTimeout(t); resolve({ result: 'paused' }); });
    task.start().catch((e) => { clearTimeout(t); resolve({ result: 'error', error: e.message }); });
  });
}

function parseRange(header, total) {
  const m = /bytes=(\d+)-(\d*)/.exec(header || '');
  if (!m) return null;
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : total - 1 };
}

(async () => {
  // Small, fast timeouts so the stall/response paths run in seconds.
  configureHttp({ timeouts: { response: 3000 }, stallTimeoutMs: 800 });

  // ---------------------------------------------------------------------------
  section('A transfer may outlast every phase timeout while it keeps moving');
  {
    const body = crypto.randomBytes(48 * 1024);
    // No range support: this is the case that could never finish under the old
    // 30s whole-request cap, because every retry restarted from zero.
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
      if (req.method === 'HEAD') return res.end();
      let off = 0;
      const t = setInterval(() => {
        const n = Math.min(2048, body.length - off);
        res.write(body.subarray(off, off + n));
        off += n;
        if (off >= body.length) { clearInterval(t); res.end(); }
      }, 90); // ~2.1s total: longer than the 800ms stall window, never idle that long
      req.on('close', () => clearInterval(t));
    });
    const dest = path.join(TMP, 'trickle.bin');
    const started = Date.now();
    const r = await runTask(new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, retries: 0 }));
    check('a steady trickle longer than the stall window completes', r.result === 'complete', r);
    check('took longer than the stall timeout (so no whole-request cap applied)', Date.now() - started > 1500);
    check('and is byte-exact', fs.existsSync(dest) && md5(fs.readFileSync(dest)) === md5(body));
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('A stalled connection is abandoned and resumed from its offset');
  {
    const body = crypto.randomBytes(512 * 1024);
    const ranges = [];
    let stalled = false;
    const { server, port } = await listen((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      const r = parseRange(req.headers.range, body.length) || { start: 0, end: body.length - 1 };
      ranges.push(r.start);
      res.writeHead(206, {
        'Content-Length': r.end - r.start + 1,
        'Content-Range': `bytes ${r.start}-${r.end}/${body.length}`,
        'Accept-Ranges': 'bytes',
      });
      if (!stalled) {
        // Half the body, then silence with the socket held open.
        stalled = true;
        res.write(body.subarray(r.start, r.start + 200 * 1024));
        return;
      }
      res.end(body.subarray(r.start, r.end + 1));
    });
    const dest = path.join(TMP, 'stall.bin');
    const task = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 1, retries: 2 });
    const errors = [];
    task.on('segment-error', (e) => errors.push(e.error));
    const r = await runTask(task, 30000);
    check('the stall was detected as such', errors.some((e) => /stalled/i.test(e)), errors);
    check('the download still completed', r.result === 'complete', r);
    check('the retry resumed from the stalled offset instead of byte 0', ranges.length >= 2 && ranges[1] >= 200 * 1024, ranges);
    check('and the file is byte-exact', fs.existsSync(dest) && md5(fs.readFileSync(dest)) === md5(body));
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('Retries that make progress do not use up the retry budget');
  {
    const body = crypto.randomBytes(384 * 1024);
    let requests = 0;
    const { server, port } = await listen((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
        return res.end();
      }
      requests++;
      const r = parseRange(req.headers.range, body.length) || { start: 0, end: body.length - 1 };
      res.writeHead(206, {
        'Content-Length': r.end - r.start + 1,
        'Content-Range': `bytes ${r.start}-${r.end}/${body.length}`,
      });
      // Drop the connection after every 100 KB — forward progress every time.
      const slice = body.subarray(r.start, Math.min(r.end + 1, r.start + 100 * 1024));
      res.write(slice, () => {
        if (r.start + slice.length <= r.end) setTimeout(() => res.destroy(), 20);
        else res.end();
      });
    });
    const dest = path.join(TMP, 'flaky.bin');
    // retries: 1 — the old engine gave up on the second drop.
    const r = await runTask(new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 1, retries: 1 }), 60000);
    check('a connection dropping 4 times with a retry budget of 1 still completes', r.result === 'complete', r);
    check('it really did reconnect several times', requests >= 4, { requests });
    check('and the file is byte-exact', fs.existsSync(dest) && md5(fs.readFileSync(dest)) === md5(body));
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('A server that ignores Range on GET is downloaded as one stream');
  {
    const body = crypto.randomBytes(11 * 1024 * 1024); // big enough for 2+ planned segments
    let ranged200 = 0;
    const { server, port } = await listen((req, res) => {
      // Advertises ranges on HEAD, then answers every GET with the whole file.
      res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      if (req.headers.range && !/^bytes=0-/.test(req.headers.range)) ranged200++;
      res.end(body);
    });
    const dest = path.join(TMP, 'ignores-range.bin');
    const task = new DownloadTask({ url: `http://127.0.0.1:${port}/f`, destPath: dest, connections: 4 });
    let restarted = null;
    task.on('restarted', (e) => (restarted = e));
    const r = await runTask(task);
    check('the engine noticed the ignored range', ranged200 >= 1, { ranged200 });
    check('it restarted as a single stream', restarted && restarted.reason === 'single-stream', restarted);
    check('the download completed', r.result === 'complete', r);
    check('the file is byte-exact (not the first bytes spliced into the middle)', fs.existsSync(dest) && md5(fs.readFileSync(dest)) === md5(body));
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('Resuming a file that changed on the server restarts it cleanly');
  {
    let version = 1;
    const v1 = crypto.randomBytes(640 * 1024);
    const v2 = crypto.randomBytes(700 * 1024);
    const cur = () => (version === 1 ? v1 : v2);
    const etag = () => `"v${version}"`;
    let slow = true;
    const { server, port } = await listen((req, res) => {
      const b = cur();
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': b.length, 'Accept-Ranges': 'bytes', ETag: etag() });
        return res.end();
      }
      const ifRange = req.headers['if-range'];
      const r = parseRange(req.headers.range, b.length);
      if (!r || (ifRange && ifRange !== etag())) {
        res.writeHead(200, { 'Content-Length': b.length, ETag: etag(), 'Accept-Ranges': 'bytes' });
        return res.end(b);
      }
      res.writeHead(206, {
        'Content-Length': r.end - r.start + 1,
        'Content-Range': `bytes ${r.start}-${r.end}/${b.length}`,
        ETag: etag(),
      });
      if (!slow) return res.end(b.subarray(r.start, r.end + 1));
      let off = r.start;
      const t = setInterval(() => {
        if (off > r.end) { clearInterval(t); return res.end(); }
        const n = Math.min(16 * 1024, r.end + 1 - off);
        res.write(b.subarray(off, off + n));
        off += n;
      }, 25);
      req.on('close', () => clearInterval(t));
    });
    const dest = path.join(TMP, 'changed.bin');
    const url = `http://127.0.0.1:${port}/f`;
    const first = new DownloadTask({ url, destPath: dest, connections: 1 });
    setTimeout(() => first.pause(), 300);
    const r1 = await runTask(first);
    check('first run paused part-way', r1.result === 'paused' && first.downloadedTotal > 0 && first.downloadedTotal < v1.length, { r1, got: first.downloadedTotal });

    version = 2; // the file is replaced while the download sits paused
    slow = false;
    const second = new DownloadTask({ url, destPath: dest, connections: 1 });
    let restarted = null;
    second.on('restarted', (e) => (restarted = e));
    const r2 = await runTask(second);
    check('the resume detected the change and restarted', restarted && restarted.reason === 'changed', restarted);
    check('the resumed download completed', r2.result === 'complete', r2);
    check('the result is entirely the NEW file, not a splice of both', fs.existsSync(dest) && md5(fs.readFileSync(dest)) === md5(v2));
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('A resume through a mirror redirector is not mistaken for a change');
  {
    const body = crypto.randomBytes(640 * 1024);
    const mirror = (tag) =>
      listen((req, res) => {
        const r = parseRange(req.headers.range, body.length);
        const etag = `"${tag}"`; // same bytes, a different tag on each mirror
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes', ETag: etag });
          return res.end();
        }
        if (!r || (req.headers['if-range'] && req.headers['if-range'] !== etag)) {
          res.writeHead(200, { 'Content-Length': body.length, ETag: etag });
          return res.end(body);
        }
        res.writeHead(206, { 'Content-Length': r.end - r.start + 1, 'Content-Range': `bytes ${r.start}-${r.end}/${body.length}`, ETag: etag });
        let off = r.start;
        const t = setInterval(() => {
          if (off > r.end) { clearInterval(t); return res.end(); }
          const n = Math.min(16 * 1024, r.end + 1 - off);
          res.write(body.subarray(off, off + n));
          off += n;
        }, 20);
        req.on('close', () => clearInterval(t));
      });
    const m1 = await mirror('mirror-one');
    const m2 = await mirror('mirror-two');
    let flip = 0;
    const redirector = await listen((req, res) => {
      const target = flip++ % 2 === 0 ? m1.port : m2.port;
      res.writeHead(302, { Location: `http://127.0.0.1:${target}/file.iso` });
      res.end();
    });
    const dest = path.join(TMP, 'mirrored.iso');
    const url = `http://127.0.0.1:${redirector.port}/get/file.iso`;
    const first = new DownloadTask({ url, destPath: dest, connections: 1 });
    setTimeout(() => first.pause(), 300);
    const r1 = await runTask(first);
    check('paused part-way', r1.result === 'paused' && first.downloadedTotal > 0, r1);
    const second = new DownloadTask({ url, destPath: dest, connections: 1 });
    let restarted = null;
    second.on('restarted', (e) => (restarted = e));
    const r2 = await runTask(second);
    check('the resume did NOT restart from zero', restarted === null, restarted);
    check('and completed byte-exact', r2.result === 'complete' && md5(fs.readFileSync(dest)) === md5(body), r2);
    [m1, m2, redirector].forEach((s) => s.server.close());
  }

  // ---------------------------------------------------------------------------
  section('Server-supplied filenames cannot escape the download folder');
  {
    const body = Buffer.from('payload');
    const { server, port } = await listen((req, res) => {
      const headers = { 'Content-Length': body.length };
      if (req.url.startsWith('/cd')) headers['Content-Disposition'] = 'attachment; filename="..\\..\\escape-cd.txt"';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    });
    const destDir = path.join(TMP, 'jail', 'inner');
    for (const [label, url] of [
      ['Content-Disposition with ..\\..\\', `http://127.0.0.1:${port}/cd`],
      ['URL path with %2F..%2F', `http://127.0.0.1:${port}/a%2F..%2F..%2Fescape-url.txt`],
      ['URL path with %5C..%5C', `http://127.0.0.1:${port}/a%5C..%5C..%5Cescape-bs.txt`],
    ]) {
      const task = new DownloadTask({ url, destDir });
      const r = await runTask(task);
      const inside = path.dirname(path.resolve(task.destPath)) === path.resolve(destDir);
      check(`${label}: saved inside the download folder`, r.result === 'complete' && inside, { dest: task.destPath, r });
    }
    const escaped = ['escape-cd.txt', 'escape-url.txt', 'escape-bs.txt'].filter(
      (f) => fs.existsSync(path.join(TMP, f)) || fs.existsSync(path.join(TMP, 'jail', f))
    );
    check('nothing was written outside it', escaped.length === 0, escaped);
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('Credentials are not replayed to a different host after a redirect');
  {
    const body = crypto.randomBytes(64 * 1024);
    const seenByCdn = [];
    const cdn = await listen((req, res) => {
      seenByCdn.push({ cookie: req.headers.cookie || null, auth: req.headers.authorization || null, referer: req.headers.referer || null });
      res.writeHead(200, { 'Content-Length': body.length });
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    }, 'localhost');
    const origin = await listen((req, res) => {
      res.writeHead(302, { Location: `http://localhost:${cdn.port}/file.bin` });
      res.end();
    });
    const dest = path.join(TMP, 'redirected.bin');
    const task = new DownloadTask({
      url: `http://127.0.0.1:${origin.port}/download`,
      destPath: dest,
      headers: { Cookie: 'session=secret', Authorization: 'Basic c2VjcmV0', Referer: 'http://127.0.0.1/page' },
    });
    const r = await runTask(task);
    check('the redirected download completed', r.result === 'complete', r);
    check('the CDN never received the origin\'s Cookie', seenByCdn.length > 0 && seenByCdn.every((h) => !h.cookie), seenByCdn);
    check('the CDN never received the origin\'s Authorization', seenByCdn.every((h) => !h.auth), seenByCdn);
    check('non-credential headers (Referer) still went through', seenByCdn.some((h) => h.referer), seenByCdn);
    cdn.server.close();
    origin.server.close();
  }

  // ---------------------------------------------------------------------------
  section('A file behind a redirect is named after where it landed');
  {
    const body = Buffer.from('zip-bytes');
    let originHits = 0;
    const { server, port } = await listen((req, res) => {
      if (req.url.startsWith('/download.php')) {
        originHits++;
        res.writeHead(302, { Location: '/files/Real%20Name.zip' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Length': body.length });
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    });
    const destDir = path.join(TMP, 'redirect-name');
    const task = new DownloadTask({ url: `http://127.0.0.1:${port}/download.php?id=7`, destDir });
    const r = await runTask(task);
    check('named "Real Name.zip", not "download.php"', r.result === 'complete' && path.basename(task.destPath) === 'Real Name.zip', task.destPath);
    check('the transfer itself still went through the original link', originHits >= 2, { originHits });
    server.close();
  }

  // ---------------------------------------------------------------------------
  section('Header scoping rules');
  {
    const h = { Cookie: 'a=1', authorization: 'Basic x', 'User-Agent': 'ua' };
    const same = scopeHeaders('https://example.com/a', 'https://example.com/b', h);
    check('same origin keeps everything', same === h);
    const sub = scopeHeaders('https://www.example.com/a', 'https://media.example.com/b', h);
    check('same site, other host: keeps Cookie, drops Authorization', sub.Cookie === 'a=1' && !sub.authorization && sub['User-Agent'] === 'ua', sub);
    const other = scopeHeaders('https://example.com/a', 'https://cdn.other.net/b', h);
    check('other site: drops both', !other.Cookie && !other.authorization && other['User-Agent'] === 'ua', other);
    const down = scopeHeaders('https://example.com/a', 'http://example.com/b', h);
    check('https -> http downgrade: drops both', !down.Cookie && !down.authorization, down);
    check('siteOf handles two-part registries', siteOf('video.bbc.co.uk') === 'bbc.co.uk' && siteOf('a.b.example.com') === 'example.com');
  }

  // ---------------------------------------------------------------------------
  section('Filename rules');
  {
    check('Windows device names are defused', sanitizeFilename('CON.txt', 'x') === '_CON.txt' && sanitizeFilename('nul', 'x') === '_nul');
    check('trailing dots AND spaces are stripped', sanitizeFilename('movie. . ', 'x') === 'movie');
    check('a bare ".." falls back', sanitizeFilename('..', 'fallback') === 'fallback');
    check('separators never survive', !/[\\/]/.test(sanitizeFilename('a/../../b\\c.txt', 'x')));
    const long = sanitizeFilename(`${'n'.repeat(300)}.mp4`, 'x');
    check('an over-long name keeps its extension', long.endsWith('.mp4') && long.length <= 150, long.length);
    check('numbered variants', numberedVariant('a.zip', 2) === 'a (2).zip' && numberedVariant('noext', 3) === 'noext (3)');
    check('a title with a dotted number still gets the real extension', resolveFilename('Episode 2.0', 'x.mp4') === 'Episode 2.0.mp4');
    check('a real suggested extension wins', resolveFilename('report.pdf', 'download.php') === 'report.pdf');
    check('Content-Range parsing', JSON.stringify(parseContentRange('bytes 5-9/100')) === JSON.stringify({ start: 5, end: 9, total: 100 }));
  }

  section('Content-Disposition parsing (RFC 6266)');
  {
    check("filename* wins over the ASCII fallback",
      parseContentDisposition(`attachment; filename="EURO rates.txt"; filename*=UTF-8''%e2%82%ac%20rates.txt`) === '€ rates.txt');
    check('a language tag is tolerated', parseContentDisposition(`attachment; filename*=utf-8'en'na%C3%AFve.txt`) === 'naïve.txt');
    check('quoted names may contain ; and escaped quotes', parseContentDisposition('attachment; filename="a;b \\"c\\".txt"') === 'a;b "c".txt');
    check('ISO-8859-1 escapes are single bytes', parseContentDisposition("attachment; filename*=iso-8859-1''caf%E9.txt") === 'café.txt');
    check('no filename -> URL basename', extractFilename('inline', 'https://x.test/dir/file%20name.zip?x=1') === 'file name.zip');
    check('a malformed escape does not throw', extractFilename(null, 'https://x.test/bad%E0%A4%A.bin') === 'bad%E0%A4%A.bin');
  }

  // ---------------------------------------------------------------------------
  section('Text fetches keep a whole-request cap');
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial'); // then never ends
    });
    const started = Date.now();
    let error = null;
    try {
      const { res } = await request(`http://127.0.0.1:${port}/playlist.m3u8`, { totalTimeoutMs: 700 });
      for await (const _ of res) { /* drain */ }
    } catch (e) {
      error = e;
    }
    check('a never-ending playlist fetch is cut off', error && Date.now() - started < 5000, error && error.message);
    server.close();
  }

  await sleep(50);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fails === 0 ? 'ALL ENGINE HARDENING TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
