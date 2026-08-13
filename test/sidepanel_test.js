'use strict';
// Black-box simulation test for extension/background.js's new Side Panel
// support (Port protocol, version-based snapshot cache, chrome.storage.session
// persistence, tab-lifecycle cleanup). Loads the REAL file via Node's vm
// module with a mocked chrome.* surface, then drives it exactly the way
// Chrome would: capture the addListener callbacks, invoke them with synthetic
// events, and observe the resulting postMessage/storage calls.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Mock chrome.* surface --------------------------------------------------
const captured = {
  tabsOnUpdated: [], tabsOnRemoved: [], tabsOnActivated: [],
  runtimeOnMessage: [], runtimeOnConnect: [], runtimeOnInstalled: [],
  webRequestOnBeforeRequest: [], webRequestOnHeadersReceived: [],
  storageOnChanged: [],
};

const mockTabs = new Map();
mockTabs.set(1, { id: 1, title: 'Test Page', url: 'https://example.com/watch', favIconUrl: null });

const sessionStore = {};
let fetchCallCount = 0;
const createdSockets = [];

const mockChrome = {
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  tabs: {
    onUpdated: { addListener: (fn) => captured.tabsOnUpdated.push(fn) },
    onRemoved: { addListener: (fn) => captured.tabsOnRemoved.push(fn) },
    onActivated: { addListener: (fn) => captured.tabsOnActivated.push(fn) },
    get: (tabId) => {
      const tab = mockTabs.get(tabId);
      return tab ? Promise.resolve(tab) : Promise.reject(new Error('No tab: ' + tabId));
    },
    query: () => Promise.resolve(Array.from(mockTabs.values())),
  },
  runtime: {
    onInstalled: { addListener: (fn) => captured.runtimeOnInstalled.push(fn) },
    onMessage: { addListener: (fn) => captured.runtimeOnMessage.push(fn) },
    onConnect: { addListener: (fn) => captured.runtimeOnConnect.push(fn) },
  },
  webRequest: {
    onBeforeRequest: { addListener: (fn) => captured.webRequestOnBeforeRequest.push(fn) },
    onHeadersReceived: { addListener: (fn) => captured.webRequestOnHeadersReceived.push(fn) },
  },
  storage: {
    session: {
      set: (obj) => { Object.assign(sessionStore, obj); return Promise.resolve(); },
      get: (keys) => {
        if (keys === null || keys === undefined) return Promise.resolve({ ...sessionStore });
        if (typeof keys === 'string') return Promise.resolve(keys in sessionStore ? { [keys]: sessionStore[keys] } : {});
        return Promise.resolve({});
      },
      remove: (key) => { delete sessionStore[key]; return Promise.resolve(); },
    },
    onChanged: { addListener: (fn) => captured.storageOnChanged.push(fn) },
  },
  cookies: { getAll: () => Promise.resolve([]) },
  downloads: { onCreated: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

class MockWebSocket {
  constructor() { createdSockets.push(this); }
  send() {}
  close() {}
}
MockWebSocket.OPEN = 1;

const sandbox = {
  chrome: mockChrome,
  WebSocket: MockWebSocket,
  fetch: (url) => {
    fetchCallCount++;
    return Promise.resolve({ ok: true, url, text: () => Promise.resolve('') }); // empty body -> generic HLS fallback path
  },
  console,
  setTimeout, clearTimeout,
  URL, URLSearchParams,
  navigator: { userAgent: 'test-agent' },
  importScripts: () => { throw new Error('no importScripts in test sandbox'); }, // background.js already try/catches this
};
sandbox.self = sandbox; // a service worker's `self` IS its global object
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'background.js' });

function makePort() {
  const sent = [];
  const port = {
    name: 'sidepanel',
    _onMessage: [],
    _onDisconnect: [],
    onMessage: { addListener: (fn) => port._onMessage.push(fn) },
    onDisconnect: { addListener: (fn) => port._onDisconnect.push(fn) },
    postMessage: (msg) => sent.push(msg),
    _sent: sent,
    _receive: (msg) => port._onMessage.forEach((fn) => fn(msg)),
    _disconnect: () => port._onDisconnect.forEach((fn) => fn()),
  };
  return port;
}

function fireWebRequest(tabId, url) {
  captured.webRequestOnBeforeRequest.forEach((fn) => fn({ tabId, url, type: 'xmlhttprequest', initiator: 'https://example.com' }));
}

function callRuntimeMessage(msg, sender) {
  return new Promise((resolve) => {
    let handled = false;
    for (const fn of captured.runtimeOnMessage) {
      const willRespond = fn(msg, sender, (resp) => { handled = true; resolve(resp); });
      if (!willRespond && !handled) {
        // synchronous handler (e.g. universal-media-found) — nothing to await
      }
    }
    if (!captured.runtimeOnMessage.length) resolve(undefined);
  });
}

(async () => {
  check('background.js loaded without throwing', true);
  check('registered a webRequest.onBeforeRequest listener', captured.webRequestOnBeforeRequest.length > 0);
  check('registered a runtime.onConnect listener', captured.runtimeOnConnect.length === 1);
  check('registered a tabs.onUpdated listener', captured.tabsOnUpdated.length === 1);
  check('registered a tabs.onRemoved listener', captured.tabsOnRemoved.length === 1);

  // --- 1. Discover media, verify it shows up via get-media-for-tab -------
  fireWebRequest(1, 'https://cdn.example.com/stream/master.m3u8');
  const fetchesAfterFirst = fetchCallCount;
  let resp = await callRuntimeMessage({ type: 'get-media-for-tab' }, { tab: { id: 1, title: 'Test Page' } });
  check('newly discovered .m3u8 appears in the snapshot', resp.items.some((i) => i.url.includes('master.m3u8')), JSON.stringify(resp.items));
  check('fetch() was called once to inspect the new manifest', fetchCallCount === fetchesAfterFirst + 1, `fetchCallCount=${fetchCallCount}`);

  // --- 2. Cache hit: re-querying an UNCHANGED tab must not re-fetch ------
  resp = await callRuntimeMessage({ type: 'get-media-for-tab' }, { tab: { id: 1, title: 'Test Page' } });
  check('re-querying an unchanged tab does not re-fetch (version-based cache hit)', fetchCallCount === fetchesAfterFirst + 1, `fetchCallCount=${fetchCallCount}`);

  // --- 3. Duplicate webRequest events for the SAME url must not re-trigger work
  fireWebRequest(1, 'https://cdn.example.com/stream/master.m3u8'); // exact duplicate
  await sleep(50);
  resp = await callRuntimeMessage({ type: 'get-media-for-tab' }, { tab: { id: 1, title: 'Test Page' } });
  check('duplicate URL detection did not trigger a redundant re-fetch', fetchCallCount === fetchesAfterFirst + 1, `fetchCallCount=${fetchCallCount}`);

  // --- 4. Port subscribe -> immediate snapshot push (join-in-progress) ----
  check('a port with name other than "sidepanel" is ignored', (() => {
    const before = captured.runtimeOnConnect.length;
    const otherPort = makePort();
    otherPort.name = 'something-else';
    captured.runtimeOnConnect.forEach((fn) => fn(otherPort));
    otherPort._receive({ type: 'subscribe', tabId: 1 });
    return otherPort._sent.length === 0; // never wired up since name didn't match
  })());

  const port = makePort();
  captured.runtimeOnConnect.forEach((fn) => fn(port));
  port._receive({ type: 'subscribe', tabId: 1 });
  await sleep(50);
  check('subscribing pushes an immediate snapshot', port._sent.length === 1 && port._sent[0].type === 'snapshot', JSON.stringify(port._sent));
  check('the pushed snapshot has the correct tabId', port._sent[0]?.tabId === 1);
  check('the pushed snapshot includes the discovered media', port._sent[0]?.items?.some((i) => i.url.includes('master.m3u8')));

  // --- 5. New discovery while subscribed -> debounced live push ----------
  port._sent.length = 0;
  fireWebRequest(1, 'https://cdn.example.com/video/second.mp4');
  check('push is debounced, not immediate', port._sent.length === 0);
  await sleep(350); // > the 250ms debounce window
  check('a live snapshot push arrives after the debounce window', port._sent.some((m) => m.type === 'snapshot' && m.items.some((i) => i.url.includes('second.mp4'))), JSON.stringify(port._sent));

  // --- 6. Session persistence ---------------------------------------------
  check('discovered manifests are mirrored to chrome.storage.session', Array.isArray(sessionStore['tabMedia:1']?.manifests) && sessionStore['tabMedia:1'].manifests.includes('https://cdn.example.com/video/second.mp4'), JSON.stringify(sessionStore['tabMedia:1']));

  // --- 7. Navigation reset ------------------------------------------------
  port._sent.length = 0;
  captured.tabsOnUpdated.forEach((fn) => fn(1, { url: 'https://example.com/new-page' }));
  check('navigating the subscribed tab pushes a reset', port._sent.some((m) => m.type === 'reset' && m.tabId === 1), JSON.stringify(port._sent));
  check('session storage entry is cleared on navigation', !('tabMedia:1' in sessionStore));

  // Re-discover after the reset so the next checks have fresh state.
  fireWebRequest(1, 'https://cdn.example.com/stream/after-nav.m3u8');
  await sleep(350);

  // --- 8. Port disconnect cleanup: no leak, no further pushes ------------
  const sentCountBeforeDisconnect = port._sent.length;
  port._disconnect();
  fireWebRequest(1, 'https://cdn.example.com/stream/after-disconnect.mp4');
  await sleep(350);
  check('a disconnected port receives no further pushes (cleaned up, not leaked)', port._sent.length === sentCountBeforeDisconnect, `before=${sentCountBeforeDisconnect} after=${port._sent.length}`);

  // --- 9. Tab removal cleans up session storage + ports -------------------
  const port2 = makePort();
  captured.runtimeOnConnect.forEach((fn) => fn(port2));
  port2._receive({ type: 'subscribe', tabId: 1 });
  await sleep(50);
  // Subscribing always triggers an immediate join-in-progress snapshot push
  // (by design) — that's message #1, independent of what happens next.
  check('subscribe triggers the expected join-in-progress snapshot', port2._sent.length === 1 && port2._sent[0].type === 'snapshot', JSON.stringify(port2._sent));

  captured.tabsOnRemoved.forEach((fn) => fn(1));
  check('closing the tab pushes a final reset', port2._sent.length === 2 && port2._sent[1].type === 'reset', JSON.stringify(port2._sent));

  const countAfterRemoval = port2._sent.length;
  fireWebRequest(1, 'https://cdn.example.com/should-not-push.mp4');
  await sleep(350);
  check('no further pushes after the tab is removed (portsByTab cleaned up)', port2._sent.length === countAfterRemoval, `before=${countAfterRemoval} after=${port2._sent.length}`);

  // --- 10. Bridge status broadcast to subscribed ports --------------------
  mockTabs.set(2, { id: 2, title: 'Another Tab', url: 'https://x.test', favIconUrl: null });
  fireWebRequest(2, 'https://cdn.example.com/tab2.mp4');
  const port3 = makePort();
  captured.runtimeOnConnect.forEach((fn) => fn(port3));
  port3._receive({ type: 'subscribe', tabId: 2 });
  await sleep(50);
  port3._sent.length = 0;
  const socket = createdSockets[createdSockets.length - 1];
  socket.onmessage({ data: JSON.stringify({ type: 'hello-ack', config: {} }) }); // simulate successful bridge connect
  check('a successful bridge connection broadcasts bridge-status to subscribed ports', port3._sent.some((m) => m.type === 'bridge-status' && m.bridgeConnected === true), JSON.stringify(port3._sent));

  console.log(`\n${fails === 0 ? 'ALL SIDE PANEL SIMULATION TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
