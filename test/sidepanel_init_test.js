'use strict';
// Focused, deterministic test for extension/sidepanel.js's init() resilience:
// chrome.windows.getCurrent() failing must not abort the rest of
// initialization (port connect, tab tracking via the currentWindow fallback,
// mode toggle wiring). Loads the REAL file via vm with a minimal DOM mock,
// sidestepping the Browser tool's file:// caching ambiguity entirely.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'sidepanel.js'), 'utf8');
// sidepanel.html loads modeToggle.js before sidepanel.js (two <script> tags
// sharing one page context) — mirror that exact composition here, since
// sidepanel.js's init() calls ddlInitModeToggle() at the end.
const modeToggleSrc = fs.readFileSync(path.join(ROOT, 'extension', 'modeToggle.js'), 'utf8');

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEl() {
  return {
    _text: '', _html: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set src(v) { this._src = v; },
    get src() { return this._src; },
    addEventListener() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild() {},
  };
}

function runTest(chromeOverrides, label) {
  const elements = {
    'media-list': makeEl(),
    'subtitles-section': makeEl(),
    'subtitles-list': makeEl(),
    'tab-title': makeEl(),
    'tab-favicon': makeEl(),
    'bridge-status': makeEl(),
  };

  const fakePort = {
    sent: [],
    _msgHandlers: [],
    _discHandlers: [],
    onMessage: { addListener: (fn) => fakePort._msgHandlers.push(fn) },
    onDisconnect: { addListener: (fn) => fakePort._discHandlers.push(fn) },
    postMessage(msg) { fakePort.sent.push(msg); },
  };

  const queries = [];
  const baseChrome = {
    tabs: {
      query: (q) => {
        queries.push(q);
        return Promise.resolve([{ id: 99, title: 'Resolved Tab', url: 'https://x.test', favIconUrl: null }]);
      },
      get: (id) => Promise.resolve({ id, title: 'Resolved Tab', url: 'https://x.test', favIconUrl: null }),
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    runtime: {
      connect: () => fakePort,
      sendMessage: () => Promise.resolve({ sent: true }),
    },
    storage: {
      sync: { get: () => Promise.resolve({ uiMode: 'floating' }), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
  const mockChrome = { ...baseChrome, ...chromeOverrides };

  const documentMock = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const sandbox = {
    chrome: mockChrome,
    document: documentMock,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(modeToggleSrc, sandbox, { filename: 'modeToggle.js' });
  vm.runInContext(src, sandbox, { filename: 'sidepanel.js' });

  return { sandbox, elements, fakePort, queries };
}

(async () => {
  // --- Case A: chrome.windows works normally (baseline) -------------------
  {
    const { sandbox, fakePort, queries } = runTest({ windows: { getCurrent: () => Promise.resolve({ id: 555 }) } }, 'normal');
    let threw = false;
    try { await sandbox.init(); } catch (e) { threw = true; }
    await sleep(20);
    check('[normal] init() completes without throwing', !threw);
    check('[normal] tabs.query used the resolved windowId', queries[0]?.windowId === 555 && queries[0]?.currentWindow === undefined, JSON.stringify(queries[0]));
    check('[normal] subscribed to the resolved tab', fakePort.sent.some((m) => m.type === 'subscribe' && m.tabId === 99));
  }

  // --- Case B: chrome.windows is entirely undefined (the fixed failure path) ---
  {
    const { sandbox, fakePort, queries } = runTest({}, 'no-windows-api'); // no `windows` key at all
    let threw = false;
    let errMsg = null;
    try { await sandbox.init(); } catch (e) { threw = true; errMsg = e.message; }
    await sleep(20);
    check('[no windows API] init() does NOT throw (caught internally)', !threw, errMsg);
    check('[no windows API] falls back to a currentWindow:true query', queries[0]?.currentWindow === true && queries[0]?.windowId === undefined, JSON.stringify(queries[0]));
    check('[no windows API] still resolves and subscribes to the active tab', fakePort.sent.some((m) => m.type === 'subscribe' && m.tabId === 99));
  }

  // --- Case C: chrome.windows.getCurrent() itself rejects -----------------
  {
    const { sandbox, fakePort, queries } = runTest({ windows: { getCurrent: () => Promise.reject(new Error('boom')) } }, 'rejects');
    let threw = false;
    try { await sandbox.init(); } catch (e) { threw = true; }
    await sleep(20);
    check('[getCurrent rejects] init() does not propagate the rejection', !threw);
    check('[getCurrent rejects] still falls back and subscribes', fakePort.sent.some((m) => m.type === 'subscribe' && m.tabId === 99));
  }

  console.log(`\n${fails === 0 ? 'ALL SIDEPANEL INIT RESILIENCE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
