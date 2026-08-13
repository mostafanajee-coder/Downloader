'use strict';
// Drives the REAL extension/background.js download-interception path with a
// mocked chrome.* surface, proving the capture modifier override (IDM's
// Options -> General -> Keys) actually changes what gets captured.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackground() {
  const log = { cancelled: [], erased: [], browserDownloads: [], bridgeSends: [] };
  const listeners = { downloadCreated: [], message: [] };
  // background.js's state lives in top-level `let` bindings, which are NOT
  // reachable as sandbox properties. Time is therefore steered through an
  // injected clock rather than by poking at captureHint directly.
  const clock = { offset: 0 };

  const mockChrome = {
    downloads: {
      onCreated: { addListener: (fn) => listeners.downloadCreated.push(fn) },
      cancel: (id, cb) => { log.cancelled.push(id); if (cb) cb(); },
      erase: (q) => log.erased.push(q),
      download: (o) => log.browserDownloads.push(o),
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
      id: 'test',
    },
    webRequest: {
      onBeforeRequest: { addListener: () => {} },
      onHeadersReceived: { addListener: () => {} },
      onBeforeSendHeaders: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      get: () => Promise.resolve({ title: 't', url: 'https://x.test' }),
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
    },
    cookies: { getAll: () => Promise.resolve([]) },
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} }, removeAll: (cb) => cb && cb() },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
  };

  const sandbox = {
    chrome: mockChrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    fetch: () => Promise.reject(new Error('no network in test')),
    URL,
    TextDecoder,
    DOMParser: undefined,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent' },
    Date: new Proxy(Date, {
      get(target, prop) {
        if (prop === 'now') return () => Date.now() + clock.offset;
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  // WebSocket stub. nativeReady only flips on a 'hello-ack' from the app, so
  // the stub has to complete that handshake or nothing is ever intercepted.
  sandbox.WebSocket = function WebSocketStub() {
    this.readyState = 1;
    this.send = (data) => log.bridgeSends.push(JSON.parse(data));
    setTimeout(() => {
      if (typeof this.onopen === 'function') this.onopen();
      if (typeof this.onmessage === 'function') {
        this.onmessage({ data: JSON.stringify({ type: 'hello-ack', config: {} }) });
      }
    }, 0);
  };
  sandbox.WebSocket.OPEN = 1;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  return { sandbox, log, listeners, clock };
}

async function fireDownload(listeners, url) {
  for (const fn of listeners.downloadCreated) await fn({ id: 1, url, filename: 'f.bin', referrer: '' });
}
function sendHint(listeners, hint) {
  for (const fn of listeners.message) fn({ type: 'capture-hint', ...hint }, { tab: { id: 1 } }, () => {});
}

(async () => {
  section('baseline: normal downloads are captured');
  {
    const { log, listeners } = loadBackground();
    await sleep(30);
    check('the bridge handshake completed', log.bridgeSends.some((m) => m.type === 'hello'));
    await fireDownload(listeners, 'https://ex.test/file.bin');
    check('an ordinary download is intercepted', log.cancelled.length === 1, log.cancelled);
    check('and forwarded to the app', log.bridgeSends.some((m) => m.type === 'add-download'), log.bridgeSends.map((m) => m.type));
  }

  section('bypass key: let the browser have it');
  {
    const { log, listeners } = loadBackground();
    await sleep(30);
    sendHint(listeners, { force: false, bypass: true });
    await fireDownload(listeners, 'https://ex.test/file.bin');
    check('bypass leaves the download to the browser', log.cancelled.length === 0, log.cancelled);
    check('nothing is sent to the app', !log.bridgeSends.some((m) => m.type === 'add-download'));
  }

  section('force key: capture even an excluded site');
  {
    const { log, listeners, sandbox } = loadBackground();
    await sleep(30);
    // Exclude the host, then prove force overrides that.
    sandbox.shouldExclude = (u) => u.includes('excluded.test');

    await fireDownload(listeners, 'https://excluded.test/file.bin');
    check('an excluded site is normally skipped', log.cancelled.length === 0, log.cancelled);

    sendHint(listeners, { force: true, bypass: false });
    await fireDownload(listeners, 'https://excluded.test/file.bin');
    check('force captures it anyway', log.cancelled.length === 1, log.cancelled);
  }

  section('bypass wins when both keys are held');
  {
    const { log, listeners } = loadBackground();
    await sleep(30);
    sendHint(listeners, { force: true, bypass: true });
    await fireDownload(listeners, 'https://ex.test/file.bin');
    check('bypass takes precedence over force', log.cancelled.length === 0, log.cancelled);
  }

  section('the hint is short-lived and self-clearing');
  {
    const { log, listeners } = loadBackground();
    await sleep(30);
    sendHint(listeners, { force: false, bypass: true });
    // A subsequent PLAIN click must clear it — this is why content.js reports
    // every mousedown, not only modified ones.
    sendHint(listeners, { force: false, bypass: false });
    await fireDownload(listeners, 'https://ex.test/file.bin');
    check('a plain click afterwards clears the bypass', log.cancelled.length === 1, log.cancelled);
  }
  {
    const { log, listeners, clock } = loadBackground();
    await sleep(30);
    sendHint(listeners, { force: false, bypass: true });
    clock.offset = 10000; // jump the extension's clock past the 4s TTL
    await fireDownload(listeners, 'https://ex.test/file.bin');
    check('a stale hint is ignored (TTL enforced)', log.cancelled.length === 1, log.cancelled);
  }

  // content.js now uses IDM's checkbox/combination model; the combination
  // semantics themselves are owned by panel_filters_test.js. What matters here
  // is only that content.js still feeds this hint protocol correctly.
  section('content.js -> hint protocol wiring');
  {
    const content = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');
    check('Insert and Delete are tracked via keydown/keyup, not the click event',
      /keydown[\s\S]{0,200}Insert[\s\S]{0,80}Delete/.test(content) && /keyup[\s\S]{0,200}Insert[\s\S]{0,80}Delete/.test(content));
    check('a lost keyup cannot leave a key stuck on',
      /blur[\s\S]{0,120}insertHeld = false[\s\S]{0,60}deleteHeld = false/.test(content));
    check('every mousedown reports state so plain clicks clear it', /mousedown[\s\S]{0,400}capture-hint/.test(content));
    check('the hint carries both force and bypass, derived from combinations',
      /comboActive\(captureKeys\.force/.test(content) && /comboActive\(captureKeys\.bypass/.test(content));
  }

  console.log(`\n${fails === 0 ? 'ALL CAPTURE KEY TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
