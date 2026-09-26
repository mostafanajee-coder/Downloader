'use strict';
// Manager-level regressions: destination collisions, what survives a restart,
// Refresh Download Address with a temp folder, Redownload, removal cleanup,
// graceful shutdown and the Add-URL probe.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));
const { workspaceKey } = require(path.join(ROOT, 'core', 'workspace'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-hard-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 60 - t.length))}`);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function makeConfig(values) {
  return {
    values: { excludedSites: '', speedLimitKBps: 0, maxConcurrentDownloads: 4, duplicateAction: 'allow', ...values },
    get(k) { return this.values[k]; },
    getAll() { return this.values; },
  };
}

function newManager(name, cfgValues = {}) {
  const stateDir = path.join(TMP, name, 'state');
  const dl = path.join(TMP, name, 'dl');
  const manager = new Manager({ stateDir, config: makeConfig({ destDirs: { General: dl }, ...cfgValues }) });
  return { manager, stateDir, dl };
}

function waitFor(manager, id, statuses, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => {
      const item = manager.items.get(id);
      return item && statuses.includes(item.status) ? item : null;
    };
    const now = done();
    if (now) return resolve(now);
    const t = setTimeout(() => { manager.off('updated', on); resolve(manager.items.get(id) || null); }, timeoutMs);
    const on = () => {
      const item = done();
      if (item) { clearTimeout(t); manager.off('updated', on); resolve(item); }
    };
    manager.on('updated', on);
  });
}

function listen(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

/** Range server; `delayMs` trickles the body so a pause lands mid-transfer. */
function fileServer(files, { delayMs = 0 } = {}) {
  const log = [];
  return listen((req, res) => {
    const key = req.url.split('?')[0];
    log.push({ url: key, method: req.method, cookie: req.headers.cookie || null });
    const entry = files[key];
    if (typeof entry === 'function') return entry(req, res);
    if (!entry) { res.writeHead(404); return res.end(); }
    const body = entry;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(m ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
    });
    if (!delayMs) return res.end(body.subarray(start, end + 1));
    let off = start;
    const t = setInterval(() => {
      if (off > end) { clearInterval(t); return res.end(); }
      const n = Math.min(16 * 1024, end + 1 - off);
      res.write(body.subarray(off, off + n));
      off += n;
    }, delayMs);
    req.on('close', () => clearInterval(t));
  }).then((s) => ({ ...s, log }));
}

(async () => {
  // ---------------------------------------------------------------------------
  section('Two downloads with the same filename never share a file');
  {
    const a = crypto.randomBytes(300 * 1024);
    const b = crypto.randomBytes(310 * 1024);
    const srv = await fileServer({ '/one/video.mp4': a, '/two/video.mp4': b }, { delayMs: 5 });
    const { manager, dl } = newManager('collide');
    // A finished "video.mp4" is already in the folder from last week.
    fs.mkdirSync(dl, { recursive: true });
    fs.writeFileSync(path.join(dl, 'video.mp4'), 'precious old file');

    const idA = manager.add({ url: `http://127.0.0.1:${srv.port}/one/video.mp4` });
    const idB = manager.add({ url: `http://127.0.0.1:${srv.port}/two/video.mp4` });
    const [ia, ib] = await Promise.all([waitFor(manager, idA, ['completed', 'error']), waitFor(manager, idB, ['completed', 'error'])]);
    check('both completed', ia.status === 'completed' && ib.status === 'completed', [ia.status, ib.status, ia.error, ib.error]);
    const names = [path.basename(ia.destPath), path.basename(ib.destPath)].sort();
    check('they were given distinct names', names[0] !== names[1] && names.every((n) => n !== 'video.mp4'), names);
    check('each holds its own bytes', md5(fs.readFileSync(ia.destPath)) === md5(a) && md5(fs.readFileSync(ib.destPath)) === md5(b));
    check('the existing file was left alone', fs.readFileSync(path.join(dl, 'video.mp4'), 'utf8') === 'precious old file');
    manager.db.close();
    srv.server.close();
  }

  // ---------------------------------------------------------------------------
  section('A queued download keeps its name across a restart');
  {
    const { manager, stateDir } = newManager('persist');
    const id = manager.add({ url: 'https://example.test/stream/master.m3u8', kind: 'hls', suggestedFilename: 'My Show S01E02', startNow: false });
    const view = manager.list().find((x) => x.id === id);
    check('the list shows the suggested name before it starts', view.displayName === 'My Show S01E02', view.displayName);
    manager.db.close();

    const again = new Manager({ stateDir, config: makeConfig({}) });
    const item = again.items.get(id);
    check('suggestedFilename survived the restart', item && item.suggestedFilename === 'My Show S01E02', item && item.suggestedFilename);
    again.db.close();
  }

  // ---------------------------------------------------------------------------
  section('Refresh download address works with a temp folder');
  {
    const body = crypto.randomBytes(900 * 1024);
    let oldExpired = false;
    const srv = await fileServer(
      {
        '/old/file.bin': (req, res) => {
          if (oldExpired) { res.writeHead(403); return res.end(); }
          return srv.files['/f'](req, res);
        },
        '/new/file.bin': (req, res) => srv.files['/f'](req, res),
      },
      {}
    );
    // Reuse one trickling handler for both addresses.
    const inner = await fileServer({ '/f': body }, { delayMs: 15 });
    srv.files = {
      '/f': (req, res) => {
        const proxied = http.request({ host: '127.0.0.1', port: inner.port, path: '/f', method: req.method, headers: req.headers }, (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        });
        req.on('close', () => proxied.destroy());
        proxied.end();
      },
    };
    const tempDir = path.join(TMP, 'refresh', 'scratch');
    const { manager } = newManager('refresh', { tempDir });
    const id = manager.add({ url: `http://127.0.0.1:${srv.port}/old/file.bin`, connections: 1 });
    await sleep(700);
    manager.pause(id);
    const paused = await waitFor(manager, id, ['paused', 'completed', 'error']);
    check('paused mid-way', paused.status === 'paused', paused.status);

    oldExpired = true; // the original link dies
    const newUrlHitsBefore = srv.log.filter((l) => l.url === '/new/file.bin').length;
    manager.refreshUrl(id, `http://127.0.0.1:${srv.port}/new/file.bin`);
    const done = await waitFor(manager, id, ['completed', 'error'], 60000);
    check('the refreshed download completed', done.status === 'completed', { status: done.status, error: done.error });
    check('it used the NEW address', srv.log.filter((l) => l.url === '/new/file.bin').length > newUrlHitsBefore);
    check('and the file is byte-exact', done.destPath && md5(fs.readFileSync(done.destPath)) === md5(body));
    manager.db.close();
    srv.server.close();
    inner.server.close();
  }

  // ---------------------------------------------------------------------------
  section('Redownload keeps the captured headers');
  {
    const body = crypto.randomBytes(64 * 1024);
    const srv = await fileServer({
      '/private.zip': (req, res) => {
        if (req.headers.cookie !== 'auth=1') { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
    });
    const { manager } = newManager('redownload', { duplicateAction: 'ask' });
    let duplicatePrompts = 0;
    manager.on('duplicate-detected', () => duplicatePrompts++);
    const id = manager.add({ url: `http://127.0.0.1:${srv.port}/private.zip`, headers: { Cookie: 'auth=1' } });
    const first = await waitFor(manager, id, ['completed', 'error']);
    check('first download completed', first.status === 'completed', first.error);
    const getsBefore = srv.log.filter((l) => l.method === 'GET').length;
    manager.redownload(id);
    await sleep(50);
    const second = await waitFor(manager, id, ['completed', 'error']);
    check('redownload completed again (still authorised)', second.status === 'completed', second.error);
    check('it really fetched again', srv.log.filter((l) => l.method === 'GET').length > getsBefore);
    check('without prompting about a duplicate of itself', duplicatePrompts === 0);
    check('same entry, same file', manager.items.size === 1 && second.destPath === first.destPath);
    manager.db.close();
    srv.server.close();
  }

  // ---------------------------------------------------------------------------
  section('Removing a running download leaves nothing behind');
  {
    const body = crypto.randomBytes(2 * 1024 * 1024);
    const srv = await fileServer({ '/big.bin': body }, { delayMs: 20 });
    const tempDir = path.join(TMP, 'remove', 'scratch');
    const { manager } = newManager('remove', { tempDir });
    const id = manager.add({ url: `http://127.0.0.1:${srv.port}/big.bin` });
    await sleep(600);
    const destPath = manager.items.get(id).destPath;
    check('it was running with a destination', Boolean(destPath));
    manager.remove(id);
    await sleep(1500); // longer than the 400ms sidecar save interval
    const ws = path.join(tempDir, workspaceKey(destPath));
    check('the temp workspace is gone (not re-created by a late sidecar save)', !fs.existsSync(ws), ws);
    check('nothing was published to the destination', !fs.existsSync(destPath));
    manager.db.close();
    srv.server.close();
  }

  // ---------------------------------------------------------------------------
  section('Shutdown pauses transfers and closes the database');
  {
    const body = crypto.randomBytes(2 * 1024 * 1024);
    const srv = await fileServer({ '/slow.bin': body }, { delayMs: 20 });
    const { manager } = newManager('shutdown');
    const id = manager.add({ url: `http://127.0.0.1:${srv.port}/slow.bin` });
    await sleep(500);
    await manager.shutdown({ timeoutMs: 3000 });
    const item = manager.items.get(id);
    check('the running download ended paused (resumable)', item.status === 'paused', item.status);
    check('the database is closed', manager.db.open === false);
    check('nothing new starts after shutdown', (manager.add({ url: `http://127.0.0.1:${srv.port}/slow.bin?2` }), manager.runningCount === 0));
    srv.server.close();
  }

  // ---------------------------------------------------------------------------
  section('Odd exclusion entries cannot break add()');
  {
    const { manager } = newManager('exclusions', { excludedSites: 'c++.example (weird [entry *.blocked.test' });
    let threw = null;
    let ids;
    try {
      ids = manager.add({ url: 'https://ok.example/file.zip', startNow: false });
      manager.add({ url: 'https://cdn.blocked.test/file.zip', startNow: false });
    } catch (e) {
      threw = e;
    }
    check('no SyntaxError from regex metacharacters', !threw, threw && threw.message);
    check('a normal URL is still added', typeof ids === 'string');
    check('a glob entry still excludes', !manager.list().some((x) => x.url.includes('blocked.test')));
    manager.db.close();
  }

  // ---------------------------------------------------------------------------
  section('The Add-URL probe');
  {
    const srv = await fileServer({
      '/get': (req, res) => {
        res.writeHead(200, { 'Content-Length': 5, 'Content-Disposition': 'attachment; filename="Report 2026.pdf"', 'Accept-Ranges': 'bytes' });
        res.end(req.method === 'HEAD' ? undefined : 'abcde');
      },
    });
    const { manager } = newManager('probe', { destDirs: { General: '/dl/General', Documents: '/dl/Documents' } });
    const info = await manager.probeUrl(`http://127.0.0.1:${srv.port}/get`);
    check('names the file from Content-Disposition', info.ok && info.filename === 'Report 2026.pdf', info);
    check('reports the size and resumability', info.size === 5 && info.resumable === true, info);
    check('picks the category folder', info.category === 'Documents' && info.destDir === '/dl/Documents', info);
    const stream = await manager.probeUrl('https://cdn.test/show/master.m3u8?token=1');
    check('recognises a stream without fetching it', stream.ok && stream.kind === 'hls' && stream.filename === 'master.mp4', stream);
    const bad = await manager.probeUrl('javascript:alert(1)');
    check('rejects non-http URLs', bad.ok === false);
    manager.db.close();
    srv.server.close();
  }

  await sleep(100);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fails === 0 ? 'ALL MANAGER HARDENING TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
