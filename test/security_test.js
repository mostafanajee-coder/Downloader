'use strict';
// Security regressions: who may use the local bridge, what it will reveal and
// accept, header hygiene, and the PAC sandbox.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));
const { createBridgeServer, isTrustedOrigin } = require(path.join(ROOT, 'bridge', 'server'));
const { sanitizeRequestHeaders } = require(path.join(ROOT, 'core', 'headerScope'));
const { PacEngine } = require(path.join(ROOT, 'core', 'pac'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'security-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 60 - t.length))}`);

const PORT = 38123;

function connect(origin) {
  return new Promise((resolve) => {
    const ws = origin === undefined ? new WebSocket(`ws://127.0.0.1:${PORT}`) : new WebSocket(`ws://127.0.0.1:${PORT}`, { origin });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox, status: 101 }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws: null, inbox, status: res.statusCode }));
    ws.on('error', () => resolve({ ws: null, inbox, status: 'error' }));
  });
}

(async () => {
  const General = path.join(TMP, 'General');
  const cfg = {
    values: {
      destDirs: { General },
      excludedSites: 'blocked.test',
      fileTypes: 'ZIP MP4',
      duplicateAction: 'allow',
      siteLogins: [{ host: 'nas.local', username: 'admin', password: 'hunter2' }],
      proxy: { mode: 'direct', http: { host: 'p', port: 1, username: 'u', password: 'proxy-pass' } },
    },
    get(k) { return this.values[k]; },
    getAll() { return this.values; },
  };
  const manager = new Manager({ stateDir: path.join(TMP, 'state'), config: cfg });
  const bridge = await createBridgeServer({ manager, port: PORT });

  section('Who may connect');
  {
    for (const [origin, label] of [
      ['null', 'Origin: null (sandboxed iframe / data: page)'],
      ['https://evil.example', 'an https web page'],
      ['http://localhost:3000', 'a local web page'],
      ['file://', 'a file:// page'],
    ]) {
      const c = await connect(origin);
      check(`refused: ${label}`, c.status === 403, c.status);
    }
    const ext = await connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    check('accepted: a Chrome extension', ext.status === 101);
    const ff = await connect('moz-extension://2b1e7c3a-1111-4222-8333-444455556666');
    check('accepted: a Firefox extension', ff.status === 101);
    const cli = await connect(undefined);
    check('accepted: a local program (no Origin header)', cli.status === 101);
    check('isTrustedOrigin rejects look-alikes', !isTrustedOrigin('chrome-extension://x/../evil') && !isTrustedOrigin('https://chrome-extension.evil'));
    [ext, ff, cli].forEach((c) => c.ws && c.ws.close());
  }

  section('What the greeting reveals');
  {
    const c = await connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    await sleep(100);
    const hello = c.inbox.find((m) => m.type === 'hello-ack');
    const text = JSON.stringify(hello);
    check('the extension still gets the exclusion list and file types', hello && hello.config.excludedSites === 'blocked.test' && hello.config.fileTypes === 'ZIP MP4');
    check('no site-login password', !/hunter2/.test(text) && !('siteLogins' in hello.config));
    check('no proxy credentials', !/proxy-pass/.test(text) && !('proxy' in hello.config));
    c.ws.close();
  }

  section('What an add request may decide');
  {
    const c = await connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    await sleep(50);
    const send = (msg) => c.ws.send(JSON.stringify(msg));
    const nextAck = () => new Promise((resolve) => {
      const start = c.inbox.length;
      const t = setInterval(() => {
        const m = c.inbox.slice(start).find((x) => x.type === 'add-ack' || x.type === 'error');
        if (m) { clearInterval(t); resolve(m); }
      }, 10);
    });

    send({ type: 'add-download', payload: {
      url: 'http://127.0.0.1:9/file.zip',
      destPath: 'C:\\Users\\Public\\Start Menu\\Programs\\Startup\\evil.exe',
      destDir: 'C:\\Windows\\System32',
      allowDuplicate: true,
      headers: { Cookie: 'a=1', Range: 'bytes=0-10', 'X-Bad': 'v\r\nInjected: yes' },
    } });
    const ack = await nextAck();
    const item = manager.items.get(ack.id);
    check('the download was queued', Boolean(item), ack);
    check('destPath from the client was ignored', item && item.destPath !== 'C:\\Users\\Public\\Start Menu\\Programs\\Startup\\evil.exe' && !/Startup/.test(String(item.destPath)), item && item.destPath);
    check('destDir from the client was ignored (configured folder used)', item && item.destDir === General, item && item.destDir);
    check('a captured Cookie survives', item && item.headers.Cookie === 'a=1');
    check('an engine-owned Range header is dropped', item && !Object.keys(item.headers).some((k) => k.toLowerCase() === 'range'));
    check('a CR/LF header-injection value is dropped', item && !('X-Bad' in item.headers));

    const before = manager.items.size;
    send({ type: 'add-download', payload: { url: 'http://127.0.0.1:9/part[1-500].zip' } });
    await nextAck();
    check('a URL that looks like a batch pattern is ONE download, not 500', manager.items.size === before + 1, manager.items.size - before);

    send({ type: 'add-download', tempId: 't1', payload: { url: 'javascript:alert(1)' } });
    const rejected = await nextAck();
    check('non-http URLs are refused', rejected.type === 'error', rejected);

    send({ type: 'ping' });
    await sleep(80);
    check('ping gets a pong (service-worker keepalive)', c.inbox.some((m) => m.type === 'pong'));
    c.ws.close();
  }

  section('Progress is only pushed to clients that ask for it');
  {
    const ext = await connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    const cli = await connect(undefined);
    await sleep(50);
    const id = manager.add({ url: 'http://127.0.0.1:9/probe-updates.zip', startNow: false });
    manager.hold(id);
    await sleep(100);
    check('an extension client is not flooded with updates by default', !ext.inbox.some((m) => m.type === 'item-updated'));
    check('a local tool still receives them (unchanged behaviour)', cli.inbox.some((m) => m.type === 'item-updated'));
    ext.ws.send(JSON.stringify({ type: 'subscribe' }));
    await sleep(50);
    manager.hold(id);
    await sleep(100);
    check('after subscribing, the extension receives them', ext.inbox.some((m) => m.type === 'item-updated'));
    ext.ws.close();
    cli.ws.close();
  }

  section('Settings changes reach the extension at once — and nothing else does');
  {
    const ext = await connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    await sleep(50);
    cfg.values.fileTypes = 'ZIP DOCX';
    bridge.pushConfig();
    await sleep(80);
    const pushed = ext.inbox.filter((m) => m.type === 'config').pop();
    check('an unsubscribed extension still receives the new File Types', pushed && pushed.config.fileTypes === 'ZIP DOCX', pushed);
    check('the push carries no credentials', pushed && !/hunter2|proxy-pass/.test(JSON.stringify(pushed)) && !('siteLogins' in pushed.config));
    ext.ws.close();
  }

  section('Header sanitising');
  {
    const out = sanitizeRequestHeaders({
      Cookie: 'x=1',
      'User-Agent': 'UA',
      host: 'evil',
      'If-Range': '"e"',
      'Transfer-Encoding': 'chunked',
      'Bad Name': 'v',
      Obj: { a: 1 },
      Num: 5,
    });
    check('keeps ordinary headers', out.Cookie === 'x=1' && out['User-Agent'] === 'UA' && out.Num === '5', out);
    check('drops engine-owned, malformed and non-string ones', !out.host && !out['If-Range'] && !out['Transfer-Encoding'] && !out['Bad Name'] && !out.Obj, out);
    check('arrays and junk become {}', JSON.stringify(sanitizeRequestHeaders(['a'])) === '{}' && JSON.stringify(sanitizeRequestHeaders(null)) === '{}');
  }

  section('PAC scripts stay inside their sandbox');
  {
    const attempts = [
      'return "PROXY " + dnsResolve.constructor("return typeof process")() + ":1";',
      'return "PROXY " + this.constructor.constructor("return typeof process")() + ":1";',
      'return "PROXY " + eval("typeof require") + ":1";',
      'return "PROXY " + typeof process + ":1";',
    ];
    for (const body of attempts) {
      const pac = new PacEngine(`function FindProxyForURL(u, h) { try { ${body} } catch (e) { return "DIRECT"; } }`);
      const [first] = await pac.resolve('http://example.com/', 'example.com');
      const leaked = first.type !== 'direct' && first.host !== 'undefined';
      check(`no escape via: ${body.slice(0, 50)}…`, !leaked, first);
    }
    const hostile = new PacEngine('function FindProxyForURL(){ return { toString: function(){ while(true){} } }; }');
    let threw = false;
    const started = Date.now();
    try { await hostile.resolve('http://a.test/', 'a.test'); } catch (e) { threw = true; }
    check('a hostile return value is handled under the timeout', threw && Date.now() - started < 6000);
  }

  await bridge.stop();
  manager.db.close();
  await sleep(50);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fails === 0 ? 'ALL SECURITY TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
