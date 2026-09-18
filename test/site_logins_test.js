'use strict';
// Site Logins + fail-fast HTTP status handling.
//  - applySiteLogin attaches Basic auth for matching hosts only, never
//    overriding an explicit Authorization header.
//  - Manager.add() injects it into the stored item headers.
//  - A 401 without credentials fails IMMEDIATELY with a message that names the
//    host to add, instead of five retries with exponential backoff.
//  - With the login configured, the same server serves the file.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { applySiteLogin, findLogin, hostMatches } = require(path.join(ROOT, 'core', 'siteLogins'));
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));
const { DownloadTask } = require(path.join(ROOT, 'core', 'DownloadTask'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logins-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);

function fakeConfig(v = {}) {
  const store = { destDirs: { General: path.join(TMP, 'dl') }, duplicateAction: 'allow', ...v };
  return { get: (k) => store[k], set: (k, x) => { store[k] = x; }, getAll: () => store };
}

// A server that demands Basic auth for everything.
function authServer(body, user, pass) {
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let hits = 0;
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      hits++;
      if (req.headers.authorization !== expected) {
        r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="nas"', 'Content-Length': '0' });
        r.end();
        return;
      }
      if (req.method === 'HEAD') {
        r.writeHead(200, { 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
        r.end();
        return;
      }
      const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : body.length - 1;
        r.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) });
        r.end(body.subarray(start, end + 1));
        return;
      }
      r.writeHead(200, { 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
      r.end(body);
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port, hits: () => hits }));
  });
}

async function run(task) {
  const started = Date.now();
  let result;
  try {
    await new Promise((resolve, reject) => {
      task.on('complete', resolve);
      task.on('error', reject);
      task.start().catch(reject);
    });
    result = 'complete';
  } catch (e) {
    result = 'error:' + e.message;
  }
  return { result, ms: Date.now() - started };
}

(async () => {
  section('matching');
  check('exact host matches', hostMatches('nas.local', 'nas.local'));
  check('wildcard matches subdomains and the bare domain', hostMatches('*.example.com', 'cdn.example.com') && hostMatches('*.example.com', 'example.com'));
  check('wildcard does not match a lookalike', !hostMatches('*.example.com', 'notexample.com'));
  const logins = [{ host: '*.example.com', username: 'wild', password: 'w' }, { host: 'cdn.example.com', username: 'exact', password: 'e' }];
  check('exact host wins over a wildcard', findLogin(logins, 'https://cdn.example.com/f').username === 'exact');
  check('wildcard still covers other subdomains', findLogin(logins, 'https://img.example.com/f').username === 'wild');
  check('no login for an unrelated host', findLogin(logins, 'https://other.test/f') === null);

  section('header application');
  const h = applySiteLogin(logins, 'https://cdn.example.com/f', { Referer: 'x' });
  check('adds a Basic Authorization header', h.Authorization === 'Basic ' + Buffer.from('exact:e').toString('base64'), h);
  check('keeps existing headers', h.Referer === 'x');
  const kept = applySiteLogin(logins, 'https://cdn.example.com/f', { authorization: 'Bearer tok' });
  check('never overrides an explicit Authorization (any casing)', kept.authorization === 'Bearer tok' && !kept.Authorization);
  check('no logins -> headers untouched', applySiteLogin([], 'https://a/', { A: 1 }).A === 1);

  section('Manager injects the login at add() time');
  {
    const stateDir = path.join(TMP, 'st');
    fs.mkdirSync(stateDir, { recursive: true });
    const m = new Manager({ stateDir, config: fakeConfig({ siteLogins: [{ host: 'nas.local', username: 'bob', password: 'pw' }] }) });
    const id = m.add({ url: 'http://nas.local/file.bin', startNow: false });
    const item = m.items.get(id);
    check('stored item carries the Authorization header', item.headers.Authorization === 'Basic ' + Buffer.from('bob:pw').toString('base64'), item.headers);
    const id2 = m.add({ url: 'http://other.test/file.bin', startNow: false });
    check('a non-matching host gets no header', !m.items.get(id2).headers.Authorization);
    m.db.close();
  }

  section('401 fails fast with an actionable message');
  {
    const BODY = crypto.randomBytes(200 * 1024);
    const { server, port, hits } = await authServer(BODY, 'bob', 'pw');
    const url = `http://127.0.0.1:${port}/secret.bin`;

    const { result, ms } = await run(new DownloadTask({ url, destPath: path.join(TMP, 'noauth.bin'), connections: 2 }));
    check('an unauthenticated download errors', result.startsWith('error:'), result);
    check('the message names HTTP 401 and points to Site Logins', /401/.test(result) && /Site Login/i.test(result) && /127\.0\.0\.1/.test(result), result);
    check('it gives up quickly instead of backing off for ~45s', ms < 5000, { ms });
    check('and does not hammer the server with retries', hits() <= 6, { hits: hits() });

    // Same server, with the login supplied the way Manager would.
    const headers = applySiteLogin([{ host: '127.0.0.1', username: 'bob', password: 'pw' }], url, {});
    const dest = path.join(TMP, 'auth.bin');
    const ok = await run(new DownloadTask({ url, destPath: dest, connections: 2, headers }));
    check('with the login the download completes', ok.result === 'complete', ok.result);
    check('and the file is byte-exact', fs.existsSync(dest) && fs.readFileSync(dest).equals(BODY));
    server.close();
  }

  console.log(`\n${fails === 0 ? 'ALL SITE LOGIN TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
