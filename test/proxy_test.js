'use strict';
// Proxy + PAC subsystem, driven end to end: a real HTTP proxy and a real
// SOCKS5 server are stood up locally and the engine's own request() is pointed
// at them, so a "pass" means bytes genuinely travelled through the proxy.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { ProxyResolver } = require(path.join(ROOT, 'core', 'proxy'));
const { PacEngine, parsePacResult, shExpToRegExp } = require(path.join(ROOT, 'core', 'pac'));
const { request, configureProxy } = require(path.join(ROOT, 'core', 'httpUtils'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 56 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// --- An origin server -------------------------------------------------------
async function startOrigin(body) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) });
    res.end(body);
  });
  return { server, port: await listen(server) };
}

// --- A forwarding HTTP proxy ------------------------------------------------
async function startHttpProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    // A real proxy receives the ABSOLUTE URI — that's how we know the request
    // actually went through here rather than straight to the origin.
    seen.push(req.url);
    let target;
    try {
      target = new URL(req.url);
    } catch (e) {
      res.writeHead(400);
      res.end('not a proxy request');
      return;
    }
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    req.pipe(upstream);
  });
  return { server, port: await listen(server), seen };
}

// --- A minimal SOCKS5 server ------------------------------------------------
async function startSocks5({ requireAuth = false } = {}) {
  const seen = [];
  const server = net.createServer((socket) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = Array.from(buf.subarray(2, 2 + n));
          buf = buf.subarray(2 + n);
          if (requireAuth) {
            if (!methods.includes(0x02)) { socket.end(Buffer.from([0x05, 0xff])); return; }
            socket.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 'request';
          }
          continue;
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          seen.push({ auth: { user, pass } });
          socket.write(Buffer.from([0x01, user === 'bob' && pass === 'secret' ? 0x00 : 0x01]));
          stage = 'request';
          continue;
        }
        if (stage === 'request') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host;
          let offset;
          if (atyp === 0x01) { if (buf.length < 10) return; host = Array.from(buf.subarray(4, 8)).join('.'); offset = 8; }
          else if (atyp === 0x03) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.subarray(5, 5 + l).toString(); offset = 5 + l; }
          else { socket.end(); return; }
          const port = buf.readUInt16BE(offset);
          buf = buf.subarray(offset + 2);
          seen.push({ atyp, host, port });

          const upstream = net.connect({ host: atyp === 0x03 ? '127.0.0.1' : host, port }, () => {
            // Success reply, then splice the two sockets together.
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (buf.length) upstream.write(buf);
            buf = Buffer.alloc(0);
            stage = 'tunnel';
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          upstream.on('error', () => { try { socket.end(); } catch (e) {} });
          return;
        }
        return;
      }
    });
  });
  return { server, port: await listen(server), seen };
}

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  section('Exception list matching');
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'manual', http: { host: 'p', port: 1 }, exceptions: '<local> localhost 192.168.* *.internal example.com' });
    check('exact hostname matches', r.isException('localhost'));
    check('<local> matches a dotless name', r.isException('buildserver'));
    check('<local> does not match a dotted name', !r.isException('build.example.org'));
    check('a wildcard prefix matches', r.isException('10.0.0.1') === false && r.isException('192.168.1.50'));
    check('*.internal matches a subdomain', r.isException('api.internal'));
    check('*.internal also covers the bare domain', r.isException('internal'));
    check('an unrelated host is not excepted', !r.isException('example.org'));
    check('a listed domain matches exactly', r.isException('example.com'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Manual mode resolution');
  {
    const r = new ProxyResolver();
    r.configure({
      mode: 'manual',
      http: { host: 'hp', port: 8080 },
      https: { host: 'sp', port: 8443 },
      ftp: { host: 'fp', port: 2121 },
      exceptions: 'skip.test',
    });
    check('http uses the http proxy', (await r.resolve('http://a.test/x')).host === 'hp');
    check('https uses the https proxy', (await r.resolve('https://a.test/x')).host === 'sp');
    check('ftp uses the ftp proxy', (await r.resolve('ftp://a.test/x')).host === 'fp');
    check('an excepted host goes direct', (await r.resolve('http://skip.test/x')).type === 'direct');
  }
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'manual', http: { host: 'hp', port: 8080 } });
    check('https falls back to the http proxy when unset', (await r.resolve('https://a.test/x')).host === 'hp');
  }
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'manual', http: { host: 'hp', port: 8080 }, socks: { host: 'sk', port: 1080 }, useSocksForAll: true });
    const d = await r.resolve('https://a.test/x');
    check('useSocksForAll overrides the per-protocol servers', d.type === 'socks5' && d.host === 'sk', d);
  }
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'direct', http: { host: 'hp', port: 8080 } });
    check('direct mode ignores configured servers', (await r.resolve('http://a.test/x')).type === 'direct');
    check('and reports itself as disabled', r.enabled === false);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('PAC evaluation');
  {
    check('parses a PROXY directive', parsePacResult('PROXY p:8080')[0].type === 'http');
    check('parses SOCKS5', parsePacResult('SOCKS5 s:1080')[0].type === 'socks5');
    check('parses DIRECT', parsePacResult('DIRECT')[0].type === 'direct');
    const chain = parsePacResult('PROXY a:1; SOCKS5 b:2; DIRECT');
    check('parses a fallback chain in order', chain.length === 3 && chain[2].type === 'direct', chain.map((c) => c.type));
    check('garbage degrades to DIRECT', parsePacResult('nonsense')[0].type === 'direct');
    check('an empty result degrades to DIRECT', parsePacResult('')[0].type === 'direct');
    check('shExpMatch globbing works', shExpToRegExp('*.example.com').test('a.example.com') && !shExpToRegExp('*.example.com').test('example.org'));
  }
  {
    const pac = new PacEngine(`
      function FindProxyForURL(url, host) {
        if (isPlainHostName(host)) return "DIRECT";
        if (shExpMatch(host, "*.corp.test")) return "PROXY corp:3128";
        if (dnsDomainIs(host, ".cdn.test")) return "SOCKS5 socks:1080";
        return "PROXY default:8080";
      }
    `);
    check('isPlainHostName -> DIRECT', (await pac.resolve('http://intranet/', 'intranet'))[0].type === 'direct');
    check('shExpMatch -> named proxy', (await pac.resolve('http://a.corp.test/', 'a.corp.test'))[0].host === 'corp');
    check('dnsDomainIs -> SOCKS5', (await pac.resolve('http://x.cdn.test/', 'x.cdn.test'))[0].type === 'socks5');
    check('fallthrough -> default proxy', (await pac.resolve('http://other.test/', 'other.test'))[0].host === 'default');
  }
  {
    // A runaway PAC must not wedge the engine.
    const pac = new PacEngine('function FindProxyForURL(u,h){ while(true){} }');
    const started = Date.now();
    let threw = false;
    try { await pac.resolve('http://a.test/', 'a.test'); } catch (e) { threw = true; }
    const elapsed = Date.now() - started;
    check('an infinite-loop PAC is aborted', threw, { elapsed });
    check('and it is aborted quickly', elapsed < 6000, { elapsed });
  }
  {
    const pacPath = path.join(TMP, 'test.pac');
    fs.writeFileSync(pacPath, 'function FindProxyForURL(url, host) { return "PROXY filepac:9999"; }');
    const r = new ProxyResolver();
    r.configure({ mode: 'pac', pacUrl: pacPath });
    const d = await r.resolve('http://anything.test/');
    check('a PAC file is loaded from a local path', d.host === 'filepac' && d.port === 9999, d);
  }
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'pac', pacUrl: path.join(TMP, 'does-not-exist.pac') });
    const d = await r.resolve('http://anything.test/');
    check('an unreachable PAC falls back to DIRECT rather than failing', d.type === 'direct', d);
    check('and the failure is reported in describe()', /failed/i.test(r.describe().detail), r.describe());
  }
  {
    const r = new ProxyResolver();
    const pacPath = path.join(TMP, 'exc.pac');
    fs.writeFileSync(pacPath, 'function FindProxyForURL(url, host) { return "PROXY p:1"; }');
    r.configure({ mode: 'pac', pacUrl: pacPath, exceptions: 'direct.test' });
    check('exceptions apply in PAC mode too', (await r.resolve('http://direct.test/')).type === 'direct');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('End to end through a real HTTP proxy');
  {
    const BODY = 'hello-through-the-proxy-' + crypto.randomBytes(4).toString('hex');
    const origin = await startOrigin(BODY);
    const proxy = await startHttpProxy();

    configureProxy({ mode: 'manual', http: { host: '127.0.0.1', port: proxy.port }, exceptions: '' });
    const { res } = await request(`http://127.0.0.1:${origin.port}/file.txt`, { method: 'GET' });
    const text = await readBody(res);

    check('the body arrives intact through the proxy', text === BODY, { got: text.slice(0, 40) });
    check('the proxy actually saw an absolute-URI request',
      proxy.seen.some((u) => u === `http://127.0.0.1:${origin.port}/file.txt`), proxy.seen);

    // Now except that host and confirm it bypasses.
    const before = proxy.seen.length;
    configureProxy({ mode: 'manual', http: { host: '127.0.0.1', port: proxy.port }, exceptions: '127.0.0.1' });
    const direct = await request(`http://127.0.0.1:${origin.port}/file.txt`, { method: 'GET' });
    check('an excepted host reaches the origin directly', (await readBody(direct.res)) === BODY);
    check('and the proxy saw nothing more', proxy.seen.length === before, { before, after: proxy.seen.length });

    configureProxy({ mode: 'direct' });
    origin.server.close();
    proxy.server.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('End to end through a real SOCKS5 proxy');
  {
    const BODY = 'socks-payload-' + crypto.randomBytes(4).toString('hex');
    const origin = await startOrigin(BODY);
    const socks = await startSocks5();

    configureProxy({
      mode: 'manual',
      socks: { host: '127.0.0.1', port: socks.port, remoteDns: true },
      useSocksForAll: true,
      exceptions: '',
    });
    const { res } = await request(`http://127.0.0.1:${origin.port}/s.txt`, { method: 'GET' });
    const text = await readBody(res);

    check('the body arrives intact through SOCKS5', text === BODY, { got: text.slice(0, 40) });
    check('the SOCKS5 server handled a CONNECT to the origin port',
      socks.seen.some((s) => s.port === origin.port), socks.seen);

    configureProxy({ mode: 'direct' });
    origin.server.close();
    socks.server.close();
    await sleep(50);
  }
  {
    // remoteDns must send the NAME (ATYP 0x03), not a locally-resolved address.
    const BODY = 'remote-dns-body';
    const origin = await startOrigin(BODY);
    const socks = await startSocks5();
    configureProxy({
      mode: 'manual',
      socks: { host: '127.0.0.1', port: socks.port, remoteDns: true },
      useSocksForAll: true,
      exceptions: '',
    });
    const { res } = await request(`http://localhost:${origin.port}/r.txt`, { method: 'GET' });
    await readBody(res);
    const connect = socks.seen.find((s) => s.port === origin.port);
    check('remoteDns sends the hostname for the proxy to resolve (ATYP 0x03)',
      connect && connect.atyp === 0x03 && connect.host === 'localhost', connect);

    configureProxy({ mode: 'direct' });
    origin.server.close();
    socks.server.close();
    await sleep(50);
  }
  {
    // Username/password sub-negotiation (RFC 1929).
    const BODY = 'authed-body';
    const origin = await startOrigin(BODY);
    const socks = await startSocks5({ requireAuth: true });
    configureProxy({
      mode: 'manual',
      socks: { host: '127.0.0.1', port: socks.port, username: 'bob', password: 'secret', remoteDns: true },
      useSocksForAll: true,
      exceptions: '',
    });
    const { res } = await request(`http://127.0.0.1:${origin.port}/a.txt`, { method: 'GET' });
    check('an authenticated SOCKS5 connection works', (await readBody(res)) === BODY);
    check('the credentials reached the proxy',
      socks.seen.some((s) => s.auth && s.auth.user === 'bob' && s.auth.pass === 'secret'),
      socks.seen.filter((s) => s.auth));

    configureProxy({ mode: 'direct' });
    origin.server.close();
    socks.server.close();
    await sleep(50);
  }
  {
    // An unreachable proxy must produce a clear error, not a hang.
    configureProxy({ mode: 'manual', socks: { host: '127.0.0.1', port: 1 }, useSocksForAll: true, exceptions: '' });
    let message = null;
    try {
      await request('http://127.0.0.1:9/never.txt', { method: 'GET' });
    } catch (err) {
      message = err.message;
    }
    check('an unreachable SOCKS proxy fails with a clear message', message && /SOCKS5 proxy/i.test(message), message);
    configureProxy({ mode: 'direct' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Agent caching and reconfiguration');
  {
    const r = new ProxyResolver();
    r.configure({ mode: 'manual', http: { host: 'a', port: 1 } });
    const a1 = r.agentFor({ type: 'http', host: 'a', port: 1 }, false);
    const a2 = r.agentFor({ type: 'http', host: 'a', port: 1 }, false);
    check('agents are reused for identical descriptors', a1 === a2);
    check('direct needs no agent', r.agentFor({ type: 'direct' }, false) === null);
    r.configure({ mode: 'manual', http: { host: 'b', port: 2 } });
    const a3 = r.agentFor({ type: 'http', host: 'a', port: 1 }, false);
    check('reconfiguring clears the agent cache', a3 !== a1);
  }

  console.log(`\n${fails === 0 ? 'ALL PROXY TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
