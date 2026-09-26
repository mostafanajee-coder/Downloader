'use strict';
// Drives the REAL extension/background.js with a mocked chrome.* surface:
// what gets taken from the browser, which cookies go with it, the HLS quality
// order the app will honour, and the service-worker keepalive.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
const { parseMasterPlaylist } = require(path.join(ROOT, 'core', 'hls'));

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `helloConfig` is what the app sends on connect; `namedAs` maps a download id
// to the filename the browser will eventually settle on (via onChanged).
function loadBackground({ helloConfig = {}, namedAs = {} } = {}) {
  const log = { cancelled: [], bridgeSends: [], cookieQueries: [], menusCreated: 0, menusCleared: 0, longTimers: [], sockets: [], browserDownloads: [] };
  const listeners = { downloadCreated: [], message: [], beforeRequest: [], menuClicked: [], installed: [], changed: new Set() };

  const mockChrome = {
    downloads: {
      onCreated: { addListener: (fn) => listeners.downloadCreated.push(fn) },
      onChanged: {
        addListener: (fn) => {
          listeners.changed.add(fn);
          // The browser names the file a moment after the download starts.
          for (const [id, name] of Object.entries(namedAs)) {
            setTimeout(() => fn({ id: Number(id), filename: { previous: '', current: name } }), 50);
          }
        },
        removeListener: (fn) => listeners.changed.delete(fn),
      },
      search: (q, cb) => { if (cb) cb([{ id: q.id, filename: '' }]); },
      cancel: (id, cb) => { log.cancelled.push(id); if (cb) cb(); },
      erase: () => {},
      download: (o) => log.browserDownloads.push(o),
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: () => {} },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      lastError: null,
    },
    webRequest: {
      onBeforeRequest: { addListener: (fn) => listeners.beforeRequest.push(fn) },
      onHeadersReceived: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      get: () => Promise.resolve({ title: 't', url: 'https://page.test/watch' }),
      query: () => Promise.resolve([]),
    },
    cookies: {
      getAll: (q) => {
        log.cookieQueries.push(q.url);
        const host = new URL(q.url).hostname;
        return Promise.resolve([{ name: 'site', value: host }]);
      },
    },
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      sync: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    contextMenus: {
      create: () => { log.menusCreated++; },
      removeAll: (cb) => { log.menusCleared++; if (cb) cb(); },
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };

  // The keepalive runs on a 20s timer; capture those instead of waiting.
  const fakeSetTimeout = (fn, ms, ...args) => {
    if (ms >= 15000) {
      log.longTimers.push(fn);
      return 0;
    }
    return setTimeout(fn, ms, ...args);
  };

  const sandbox = {
    chrome: mockChrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: fakeSetTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in test')),
    URL,
    URLSearchParams,
    navigator: { userAgent: 'TestAgent' },
    importScripts: () => {},
  };
  sandbox.self = sandbox;
  sandbox.WebSocket = function WebSocketStub() {
    this.readyState = 1;
    this.send = (data) => log.bridgeSends.push(JSON.parse(data));
    this.close = () => {};
    log.sockets.push(this);
    setTimeout(() => {
      if (typeof this.onopen === 'function') this.onopen();
      if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify({ type: 'hello-ack', config: helloConfig }) });
    }, 0);
  };
  sandbox.WebSocket.OPEN = 1;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });
  return { sandbox, log, listeners };
}

async function fireDownload(listeners, item) {
  for (const fn of listeners.downloadCreated) await fn({ id: 1, filename: '', referrer: '', ...item });
}

function sendMessage(listeners, msg, sender) {
  return new Promise((resolve) => {
    for (const fn of listeners.message) {
      const keepOpen = fn(msg, sender, resolve);
      if (keepOpen !== true) resolve(undefined);
    }
  });
}

(async () => {
  section('What is left to the browser');
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    await fireDownload(listeners, { url: 'blob:https://app.test/7b6f-1c2d' });
    await fireDownload(listeners, { url: 'data:text/csv;base64,YSxiCg==' });
    check('blob: and data: downloads are not taken from the browser', log.cancelled.length === 0, log.cancelled);

    for (const fn of listeners.beforeRequest) fn({ url: 'https://shop.test/invoice/export', method: 'POST', type: 'main_frame', tabId: 3 });
    await fireDownload(listeners, { url: 'https://shop.test/invoice/export' });
    check('a download produced by a POST form stays with the browser', log.cancelled.length === 0, log.cancelled);

    await fireDownload(listeners, { url: 'https://files.test/setup.zip' });
    check('an ordinary GET download is still captured', log.cancelled.length === 1);
  }

  section('Cookies belong to the file, not the page');
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    const res = await sendMessage(
      listeners,
      { type: 'download-media', url: 'https://cdn.video.test/v/720.mp4', kind: 'file', title: 'x' },
      { tab: { id: 5, url: 'https://social.test/watch?v=1', title: 'A video' } }
    );
    check('the request reached the app', res && res.sent === true);
    check('cookies were looked up for the media URL', log.cookieQueries.includes('https://cdn.video.test/v/720.mp4'), log.cookieQueries);
    check('the page\'s own cookies were NOT collected', !log.cookieQueries.includes('https://social.test/watch?v=1'), log.cookieQueries);
    const add = log.bridgeSends.find((m) => m.type === 'add-download');
    check('the page is still sent as the Referer', add && add.payload.headers.Referer === 'https://social.test/watch?v=1', add && add.payload.headers);
    check('the Cookie sent is the CDN\'s', add && add.payload.headers.Cookie === 'site=cdn.video.test', add && add.payload.headers.Cookie);
  }

  section('HLS quality index matches what the app downloads');
  {
    const { sandbox } = loadBackground();
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360',
      '360.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080',
      '1080.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720',
      '720.m3u8',
    ].join('\n');
    const base = 'https://cdn.test/show/master.m3u8';
    const panel = sandbox.parseMasterVariants(master, base).map((v) => v.url);
    const app = parseMasterPlaylist(master, base).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)).map((v) => v.url);
    check('variantIndex N means the same rendition on both sides', JSON.stringify(panel) === JSON.stringify(app), { panel, app });
    check('highest quality first', panel[0].endsWith('1080.m3u8'), panel);
  }

  section('Context menu');
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    listeners.installed.forEach((fn) => fn({ reason: 'update' }));
    check('re-registering after an update clears the old item first', log.menusCleared === 1 && log.menusCreated === 1);
    for (const fn of listeners.menuClicked) await fn({ linkUrl: 'https://cdn.test/show/manifest.mpd' }, { url: 'https://page.test/', title: 'Show' });
    const add = log.bridgeSends.find((m) => m.type === 'add-download');
    check('an .mpd link is sent as DASH', add && add.payload.kind === 'dash', add && add.payload);
    for (const fn of listeners.menuClicked) await fn({ selectionText: 'javascript:alert(1)' }, { url: 'https://page.test/' });
    check('a non-http selection is ignored', log.bridgeSends.filter((m) => m.type === 'add-download').length === 1);
  }

  section('Service-worker keepalive');
  {
    const { log } = loadBackground();
    await sleep(20);
    check('a keepalive is scheduled once connected', log.longTimers.length === 1, log.longTimers.length);
    log.longTimers.shift()();
    check('it pings the app', log.bridgeSends.some((m) => m.type === 'ping'));
    check('and re-arms itself', log.longTimers.length === 1);
  }

  // --- File Types list -----------------------------------------------------------
  const LIST = { fileTypes: 'ZIP MP4 R0* *.pdf .exe', excludedSites: '' };
  const addsOf = (log) => log.bridgeSends.filter((m) => m.type === 'add-download');

  section('Only the app\'s File Types are taken automatically');
  {
    const { log, listeners } = loadBackground({ helloConfig: LIST });
    await sleep(20);
    await fireDownload(listeners, { id: 1, url: 'https://x.test/files/setup.zip' });
    check('a listed type (ZIP) is captured', log.cancelled.includes(1));
    await fireDownload(listeners, { id: 2, url: 'https://x.test/files/notes.docx' });
    check('an unlisted type (DOCX) stays with the browser', !log.cancelled.includes(2));
    await fireDownload(listeners, { id: 3, url: 'https://x.test/files/archive.part.r01' });
    check('wildcards work (R0* matches .r01)', log.cancelled.includes(3));
    await fireDownload(listeners, { id: 4, url: 'https://x.test/files/REPORT.PDF' });
    check('matching ignores case, and "*.pdf" / ".exe" forms are understood', log.cancelled.includes(4));
    await fireDownload(listeners, { id: 5, url: 'https://x.test/dl?id=9', finalUrl: 'https://cdn.test/v/clip.mp4' });
    check('the redirect target\'s extension counts', log.cancelled.includes(5));
    await fireDownload(listeners, { id: 6, url: 'https://x.test/download.php?id=7', mime: 'application/zip' });
    check('"download.php" is judged by its Content-Type (application/zip), not ".php"', log.cancelled.includes(6));
  }

  section('When only the browser knows the name, wait for it');
  {
    const { log, listeners } = loadBackground({
      helloConfig: LIST,
      namedAs: { 10: 'C:\\Users\\me\\Downloads\\Setup Tool.exe', 11: 'C:\\Users\\me\\Downloads\\letter.docx' },
    });
    await sleep(20);
    await fireDownload(listeners, { id: 10, url: 'https://x.test/get?file=10', mime: 'application/octet-stream' });
    check('a Content-Disposition name on the list is captured', log.cancelled.includes(10));
    const add = addsOf(log).pop();
    check('and the app is given that exact name', add && add.payload.suggestedFilename === 'Setup Tool.exe', add && add.payload);
    await fireDownload(listeners, { id: 11, url: 'https://x.test/get?file=11', mime: 'application/octet-stream' });
    check('a Content-Disposition name NOT on the list stays with the browser', !log.cancelled.includes(11));
    check('no stray onChanged listeners are left behind', listeners.changed.size === 0, listeners.changed.size);
  }

  section('A download that is never named is left alone');
  {
    const { log, listeners } = loadBackground({ helloConfig: LIST });
    await sleep(20);
    const started = Date.now();
    await fireDownload(listeners, { id: 20, url: 'https://x.test/get?file=20', mime: 'application/octet-stream' });
    check('given up on after the short wait, not captured', !log.cancelled.includes(20) && Date.now() - started < 6000);
  }

  section('Force, live updates, an empty list, an older app');
  {
    const { log, listeners, sandbox } = loadBackground({ helloConfig: LIST });
    await sleep(20);
    for (const fn of listeners.message) fn({ type: 'capture-hint', force: true, bypass: false }, { tab: { id: 1 } }, () => {});
    await fireDownload(listeners, { id: 30, url: 'https://x.test/files/any.docx' });
    check('the Force key takes an unlisted type anyway', log.cancelled.includes(30));
    for (const fn of listeners.message) fn({ type: 'capture-hint', force: false, bypass: false }, { tab: { id: 1 } }, () => {});

    log.sockets[0].onmessage({ data: JSON.stringify({ type: 'config', config: { fileTypes: 'DOCX', excludedSites: '' } }) });
    await fireDownload(listeners, { id: 31, url: 'https://x.test/files/next.docx' });
    await fireDownload(listeners, { id: 32, url: 'https://x.test/files/next.zip' });
    check('an edited list applies to the very next download', log.cancelled.includes(31) && !log.cancelled.includes(32));

    log.sockets[0].onmessage({ data: JSON.stringify({ type: 'config', config: { fileTypes: '', excludedSites: '' } }) });
    await fireDownload(listeners, { id: 33, url: 'https://x.test/files/next2.zip' });
    check('an empty list turns automatic capture off', !log.cancelled.includes(33));
    check('the popup summary says so', /off/i.test(sandbox.fileTypeSummary()), sandbox.fileTypeSummary());

    const older = loadBackground({ helloConfig: {} });
    await sleep(20);
    await fireDownload(older.listeners, { id: 34, url: 'https://x.test/files/anything.docx' });
    check('an older app that sends no list keeps the capture-everything behaviour', older.log.cancelled.includes(34));
  }

  section('Popup summary and stream kinds');
  {
    const { log, listeners } = loadBackground({ helloConfig: { fileTypes: 'ZIP M3U8', excludedSites: '' } });
    await sleep(20);
    const res = await sendMessage(listeners, { type: 'get-media-for-tab' }, { tab: { id: 7, url: 'https://x.test/' } });
    check('the popup is told how many types are captured', res && /Capturing 2 file types/.test(res.captureSummary), res && res.captureSummary);
    await fireDownload(listeners, { id: 40, url: 'https://x.test/live/master.m3u8' });
    const add = addsOf(log).pop();
    check('a captured playlist is sent as HLS, not as a plain file', add && add.payload.kind === 'hls', add && add.payload);
  }

  console.log(`\n${fails === 0 ? 'ALL EXTENSION CAPTURE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
