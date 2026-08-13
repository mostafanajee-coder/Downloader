'use strict';
// Drives the REAL extension/background.js with a mocked chrome.* surface to
// verify the three forensics-derived filters:
//   1. per-format minimum size (IDM's DwnlPanel\minsize)
//   2. SkipHtml
//   3. modifier COMBINATIONS via the capture hint
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const bgSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
const contentSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 56 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackground(syncValues = {}) {
  const log = { cancelled: [], browserDownloads: [], bridgeSends: [] };
  const listeners = { downloadCreated: [], message: [], beforeRequest: [], headersReceived: [], storageChanged: [] };
  const store = { ...syncValues };

  const mockChrome = {
    downloads: {
      onCreated: { addListener: (fn) => listeners.downloadCreated.push(fn) },
      cancel: (id, cb) => { log.cancelled.push(id); if (cb) cb(); },
      erase: () => {},
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
      onBeforeRequest: { addListener: (fn) => listeners.beforeRequest.push(fn) },
      onHeadersReceived: { addListener: (fn) => listeners.headersReceived.push(fn) },
      onBeforeSendHeaders: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      get: () => Promise.resolve({ title: 'Test Page', url: 'https://x.test' }),
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(),
    },
    cookies: { getAll: () => Promise.resolve([]) },
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      sync: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in store) out[k] = store[k];
          if (typeof cb === 'function') { cb(out); return; }
          return Promise.resolve(out);
        },
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
      },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} }, removeAll: (cb) => cb && cb() },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
  };

  const sandbox = {
    chrome: mockChrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    fetch: () => Promise.reject(new Error('no network in test')),
    URL, TextDecoder, DOMParser: undefined,
    navigator: { userAgent: 'TestAgent' },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.WebSocket = function () {
    this.readyState = 1;
    this.send = (d) => log.bridgeSends.push(JSON.parse(d));
    setTimeout(() => {
      if (this.onopen) this.onopen();
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'hello-ack', config: {} }) });
    }, 0);
  };
  sandbox.WebSocket.OPEN = 1;

  vm.createContext(sandbox);
  vm.runInContext(bgSrc, sandbox, { filename: 'background.js' });
  return { sandbox, log, listeners, store };
}

const fireBefore = (L, d) => L.beforeRequest.forEach((fn) => fn({ tabId: 1, type: 'xmlhttprequest', ...d }));
const fireHeaders = (L, d) => L.headersReceived.forEach((fn) => fn({ tabId: 1, type: 'xmlhttprequest', statusCode: 200, responseHeaders: [], ...d }));
const hdr = (o) => Object.entries(o).map(([name, value]) => ({ name, value: String(value) }));
async function snapshot(sandbox) { return sandbox.buildMediaSnapshot(1); }

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  section('1. Per-format minimum size');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // A 2 KB notification sound and a real 5 MB song.
    fireBefore(listeners, { url: 'https://s.test/ping.mp3' });
    fireHeaders(listeners, { url: 'https://s.test/ping.mp3', responseHeaders: hdr({ 'content-type': 'audio/mpeg', 'content-length': 2048 }) });
    fireBefore(listeners, { url: 'https://s.test/song.mp3' });
    fireHeaders(listeners, { url: 'https://s.test/song.mp3', responseHeaders: hdr({ 'content-type': 'audio/mpeg', 'content-length': 5 * 1024 * 1024 }) });

    const snap = await snapshot(sandbox);
    const urls = snap.items.map((i) => i.url);
    check('a 2 KB notification sound is filtered out', !urls.some((u) => u.includes('ping.mp3')), urls);
    check('a real 5 MB song is kept', urls.some((u) => u.includes('song.mp3')), urls);
  }
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // IDM's exact documented floors: MP3 50 KB, OGG 100 KB.
    fireBefore(listeners, { url: 'https://s.test/a.ogg' });
    fireHeaders(listeners, { url: 'https://s.test/a.ogg', responseHeaders: hdr({ 'content-type': 'audio/ogg', 'content-length': 60 * 1024 }) });
    fireBefore(listeners, { url: 'https://s.test/b.mp3' });
    fireHeaders(listeners, { url: 'https://s.test/b.mp3', responseHeaders: hdr({ 'content-type': 'audio/mpeg', 'content-length': 60 * 1024 }) });
    const urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('60 KB OGG is filtered (its floor is 100 KB)', !urls.some((u) => u.includes('a.ogg')), urls);
    check('60 KB MP3 is kept (its floor is 50 KB)', urls.some((u) => u.includes('b.mp3')), urls);
  }
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // Streams must NEVER be size-filtered: a manifest is tiny by nature.
    fireBefore(listeners, { url: 'https://s.test/master.m3u8' });
    fireHeaders(listeners, { url: 'https://s.test/master.m3u8', responseHeaders: hdr({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': 380 }) });
    const urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('a 380-byte HLS manifest is NOT filtered', urls.some((u) => u.includes('master.m3u8')), urls);
  }
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // Unknown size must not be treated as "small".
    fireBefore(listeners, { url: 'https://s.test/unknown.mp4' });
    fireHeaders(listeners, { url: 'https://s.test/unknown.mp4', responseHeaders: hdr({ 'content-type': 'video/mp4' }) });
    const urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('media with no Content-Length is kept', urls.some((u) => u.includes('unknown.mp4')), urls);
  }
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // A 206 range response describes the CHUNK, not the file — the total from
    // Content-Range must win, or a chunked 4 GB movie looks like 64 KB.
    fireBefore(listeners, { url: 'https://s.test/movie.mp4' });
    fireHeaders(listeners, {
      url: 'https://s.test/movie.mp4', statusCode: 206,
      responseHeaders: hdr({ 'content-type': 'video/mp4', 'content-length': 65536, 'content-range': 'bytes 0-65535/4294967296' }),
    });
    const snap = await snapshot(sandbox);
    const urls = snap.items.map((i) => i.url);
    check('a range-fetched large video survives the size filter', urls.some((u) => u.includes('movie.mp4')), urls);
    check('and its label shows the FULL size, not the chunk',
      snap.items.some((i) => /4096\.00 MB/.test(i.label)), snap.items.map((i) => i.label));
  }
  {
    const { sandbox, listeners, store } = loadBackground({ panelMinSizeKB: 500 });
    await sleep(20);
    fireBefore(listeners, { url: 'https://s.test/mid.mp4' });
    fireHeaders(listeners, { url: 'https://s.test/mid.mp4', responseHeaders: hdr({ 'content-type': 'video/mp4', 'content-length': 300 * 1024 }) });
    const urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('a user floor of 500 KB overrides the 100 KB default', !urls.some((u) => u.includes('mid.mp4')), urls);
    check('the setting was read from storage', store.panelMinSizeKB === 500);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. SkipHtml');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    // A URL that matches MEDIA_PATTERN but serves a web page.
    fireBefore(listeners, { url: 'https://s.test/manifest/watch' });
    let urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('URL-only match is provisionally recorded', urls.some((u) => u.includes('/manifest/watch')), urls);

    fireHeaders(listeners, { url: 'https://s.test/manifest/watch', responseHeaders: hdr({ 'content-type': 'text/html; charset=utf-8' }) });
    urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('once it answers as HTML it is pruned', !urls.some((u) => u.includes('/manifest/watch')), urls);
  }
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    fireBefore(listeners, { url: 'https://s.test/page/manifest/x', type: 'main_frame' });
    const urls = (await snapshot(sandbox)).items.map((i) => i.url);
    check('a main_frame navigation is never treated as media', urls.length === 0, urls);
  }
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    for (const fn of listeners.downloadCreated) await fn({ id: 7, url: 'https://s.test/page', mime: 'text/html', filename: 'page.html', referrer: '' });
    check('saving a web page is left to the browser', log.cancelled.length === 0, log.cancelled);
  }
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    for (const fn of listeners.downloadCreated) await fn({ id: 8, url: 'https://s.test/file.zip', mime: 'application/zip', filename: 'file.zip', referrer: '' });
    check('a real file download is still captured', log.cancelled.length === 1, log.cancelled);
  }
  {
    const { log, listeners } = loadBackground();
    await sleep(20);
    // Force must still win over SkipHtml, for deliberately grabbing markup.
    for (const fn of listeners.message) fn({ type: 'capture-hint', force: true, bypass: false }, { tab: { id: 1 } }, () => {});
    for (const fn of listeners.downloadCreated) await fn({ id: 9, url: 'https://s.test/page', mime: 'text/html', filename: 'page.html', referrer: '' });
    check('the force key overrides SkipHtml', log.cancelled.length === 1, log.cancelled);
  }
  {
    const { log, listeners } = loadBackground({ skipHtml: false });
    await sleep(20);
    for (const fn of listeners.downloadCreated) await fn({ id: 10, url: 'https://s.test/page', mime: 'text/html', filename: 'page.html', referrer: '' });
    check('turning SkipHtml off restores HTML capture', log.cancelled.length === 1, log.cancelled);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. Modifier combinations (content.js)');
  {
    // Load content.js's combo logic in isolation and exercise comboActive.
    const sandbox = {
      chrome: {
        storage: { sync: { get: (k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
        runtime: { sendMessage: () => {}, lastError: null },
      },
      document: { addEventListener: () => {}, documentElement: {}, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }) },
      window: { addEventListener: () => {} },
      console,
      setTimeout, clearTimeout,
      MutationObserver: function () { this.observe = () => {}; },
      navigator: { userAgent: 'test' },
      location: { href: 'https://x.test' },
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try { vm.runInContext(contentSrc, sandbox, { filename: 'content.js' }); } catch (e) { /* DOM bits may bail; the fns we need are defined */ }

    const comboActive = sandbox.comboActive;
    check('comboActive is available', typeof comboActive === 'function');

    if (typeof comboActive === 'function') {
      const ctrlShift = { enabled: true, alt: false, ctrl: true, shift: true, ins: false };
      check('Ctrl+Shift requires BOTH', comboActive(ctrlShift, { ctrlKey: true, shiftKey: true }) === true);
      check('Ctrl alone does not fire a Ctrl+Shift combo', comboActive(ctrlShift, { ctrlKey: true, shiftKey: false }) === false);
      check('Shift alone does not fire it either', comboActive(ctrlShift, { ctrlKey: false, shiftKey: true }) === false);

      const altOnly = { enabled: true, alt: true, ctrl: false, shift: false, del: false };
      check('a single-key combo still works', comboActive(altOnly, { altKey: true }) === true);
      check('extra unticked modifiers are tolerated', comboActive(altOnly, { altKey: true, shiftKey: true }) === true);

      check('a disabled combo never fires', comboActive({ ...ctrlShift, enabled: false }, { ctrlKey: true, shiftKey: true }) === false);
      check('an enabled combo with NO keys ticked stays inactive',
        comboActive({ enabled: true, alt: false, ctrl: false, shift: false, ins: false }, { ctrlKey: true }) === false);
      check('a null spec is handled', comboActive(null, {}) === false);
    }

    check('legacy single-key settings are migrated', typeof sandbox.migrateLegacyKeys === 'function');
    if (typeof sandbox.migrateLegacyKeys === 'function') {
      const m = sandbox.migrateLegacyKeys({ captureForceKey: 'Insert', captureBypassKey: 'Alt' });
      check('legacy Insert -> force.ins', m && m.force.ins === true && m.force.enabled === true, m && m.force);
      check('legacy Alt -> bypass.alt', m && m.bypass.alt === true && m.bypass.enabled === true, m && m.bypass);
      const off = sandbox.migrateLegacyKeys({ captureForceKey: 'None', captureBypassKey: 'Alt' });
      check("legacy 'None' migrates to disabled", off && off.force.enabled === false, off && off.force);
    }

    // DEFAULT_CAPTURE_KEYS is a top-level `const`, which (unlike a function
    // declaration) never becomes a property of the vm sandbox — so read the
    // declaration out of the source and evaluate it directly.
    const popupSrc = fs.readFileSync(path.join(ROOT, 'extension', 'popup.js'), 'utf8');
    const extractDefaults = (src) => {
      const m = /const DEFAULT_CAPTURE_KEYS = (\{[\s\S]*?\n\};)/.exec(src);
      return m ? eval('(' + m[1].replace(/;$/, '') + ')') : null;
    };
    const contentDefaults = extractDefaults(contentSrc);
    const popupDefaults = extractDefaults(popupSrc);

    check('content.js defaults match a real IDM install (force off, Alt bypass on)',
      contentDefaults &&
      contentDefaults.force.enabled === false && contentDefaults.force.ins === true &&
      contentDefaults.bypass.enabled === true && contentDefaults.bypass.alt === true,
      contentDefaults);
    // The popup writes what content.js reads; drift between the two copies
    // would silently show the user settings the page isn't actually using.
    check('popup.js declares the same defaults as content.js',
      JSON.stringify(contentDefaults) === JSON.stringify(popupDefaults),
      { content: contentDefaults, popup: popupDefaults });
    check('Delete is tracked for the bypass set', /deleteHeld/.test(contentSrc));
  }

  console.log(`\n${fails === 0 ? 'ALL PANEL FILTER TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
