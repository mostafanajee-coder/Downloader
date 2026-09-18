'use strict';
// Black-box test of app/main.js's single-instance behaviour. Loads the REAL
// file with `electron` and every heavy dependency swapped out at the module
// loader, so we can assert exactly what a losing second instance does and does
// NOT do — the whole point of the lock is that it binds nothing.
const Module = require('module');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'app', 'main.js');

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadMain({ hasLock, bridgeBinds = true }) {
  const log = { quit: 0, exit: 0, appEvents: {}, whenReadyRegistered: 0, windowsCreated: 0, traysCreated: 0,
                bridgeCalls: 0, managersCreated: 0, notifications: [], shown: 0, focused: 0, restored: 0, added: [] };

  const fakeWindow = {
    _destroyed: false, _minimized: true, _visible: false,
    webContents: { send() {} },
    isDestroyed: () => fakeWindow._destroyed,
    isMinimized: () => fakeWindow._minimized,
    isVisible: () => fakeWindow._visible,
    restore() { log.restored++; fakeWindow._minimized = false; },
    show() { log.shown++; fakeWindow._visible = true; },
    focus() { log.focused++; },
    loadFile() {},
    on() {},
  };

  const app = {
    isQuitting: false,
    getPath: (k) => (k === 'userData' ? 'C:\\tmp\\ud' : 'C:\\tmp\\dl'),
    requestSingleInstanceLock: () => hasLock,
    quit() { log.quit++; },
    exit(code) { log.exit = code; },
    on(evt, fn) { (log.appEvents[evt] = log.appEvents[evt] || []).push(fn); },
    whenReady() { log.whenReadyRegistered++; return Promise.resolve(); },
  };

  const electron = {
    app,
    BrowserWindow: Object.assign(
      function BrowserWindow() { log.windowsCreated++; return fakeWindow; },
      { getAllWindows: () => [fakeWindow] }
    ),
    ipcMain: { handle() {} },
    dialog: { showErrorBox() {}, showOpenDialog: () => Promise.resolve({ canceled: true }) },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    Tray: function Tray() { log.traysCreated++; return { setToolTip() {}, setContextMenu() {}, on() {} }; },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    shell: { openPath() {}, showItemInFolder() {}, trashItem: () => Promise.resolve() },
  };

  const stubs = {
    electron,
    'node-notifier': { notify: (o) => log.notifications.push(o) },
    [path.join(ROOT, 'core', 'Manager.js')]: {
      Manager: function Manager() {
        log.managersCreated++;
        return { on() {}, off() {}, list: () => [], add: (p) => log.added.push(p), updateSpeedLimit() {} };
      },
    },
    [path.join(ROOT, 'bridge', 'server.js')]: {
      createBridgeServer: () => {
        log.bridgeCalls++;
        return Promise.resolve(bridgeBinds ? { httpServer: {}, wss: { clients: new Set() }, stop: () => Promise.resolve() }
                                           : { httpServer: null, wss: null, stop: () => Promise.resolve() });
      },
    },
    [path.join(ROOT, 'core', 'config.js')]: { ConfigManager: function ConfigManager() { return { get: () => undefined, set() {}, getAll: () => ({}), setAll() {} }; } },
    [path.join(ROOT, 'core', 'siteGrabber.js')]: { SiteGrabber: function SiteGrabber() { return { on() {}, crawl: () => Promise.resolve([]), cancel() {} }; } },
  };

  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request];
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return null; } })();
    if (resolved && stubs[resolved]) return stubs[resolved];
    return realLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(MAIN)];
    require(MAIN);
  } finally {
    Module._load = realLoad;
  }
  return { log, app, fakeWindow };
}

(async () => {
  // --- The losing second instance -----------------------------------------
  {
    const { log } = loadMain({ hasLock: false });
    await sleep(20);
    check('[2nd instance] quits immediately', log.quit === 1, { quit: log.quit });
    check('[2nd instance] never registers a whenReady handler', log.whenReadyRegistered === 0);
    check('[2nd instance] never binds the bridge port (no EADDRINUSE)', log.bridgeCalls === 0);
    check('[2nd instance] never opens the state database', log.managersCreated === 0);
    check('[2nd instance] never creates a window or tray', log.windowsCreated === 0 && log.traysCreated === 0);
    check('[2nd instance] does not listen for second-instance itself', !log.appEvents['second-instance']);
  }

  // --- The primary instance ------------------------------------------------
  {
    const { log, fakeWindow } = loadMain({ hasLock: true });
    await sleep(20);
    check('[primary] does not quit', log.quit === 0);
    check('[primary] registers a second-instance handler', Boolean(log.appEvents['second-instance']));
    check('[primary] boots: binds the bridge, opens the DB, creates window + tray',
      log.bridgeCalls === 1 && log.managersCreated === 1 && log.windowsCreated === 1 && log.traysCreated === 1,
      { bridge: log.bridgeCalls, mgr: log.managersCreated, win: log.windowsCreated, tray: log.traysCreated });
    check('[primary] a successfully bound bridge raises no warning notification',
      !log.notifications.some((n) => /9333|browser integration/i.test(n.title + n.message)), log.notifications);

    // Simulate the ghost launch the user hit: window minimized AND hidden to tray.
    fakeWindow._minimized = true;
    fakeWindow._visible = false;
    const shownBefore = log.shown, focusedBefore = log.focused, restoredBefore = log.restored;
    log.appEvents['second-instance'][0]({}, ['downloader.exe', '--download', 'https://ex.test/f.zip']);
    check('[primary] a second launch restores the minimized window', log.restored === restoredBefore + 1);
    check('[primary] a second launch un-hides it from the tray', log.shown === shownBefore + 1);
    check('[primary] a second launch focuses it', log.focused === focusedBefore + 1);
    check('[primary] a second launch still honours --download from its argv',
      log.added.length === 1 && log.added[0].url === 'https://ex.test/f.zip', log.added);

    // An already-visible window must not be re-shown/re-restored needlessly.
    const s2 = log.shown, r2 = log.restored;
    fakeWindow._minimized = false;
    fakeWindow._visible = true;
    log.appEvents['second-instance'][0]({}, ['downloader.exe']);
    check('[primary] an already-visible window is only focused, not re-shown',
      log.shown === s2 && log.restored === r2 && log.focused > focusedBefore + 1);
  }

  // --- Port genuinely held by an unrelated program -------------------------
  {
    const { log } = loadMain({ hasLock: true, bridgeBinds: false });
    await sleep(20);
    check('[port taken] the app still starts in UI-only mode',
      log.windowsCreated === 1 && log.quit === 0);
    check('[port taken] the user is actually told the extension cannot connect',
      log.notifications.some((n) => /9333/.test(n.message)),
      log.notifications.map((n) => n.title));
  }

  console.log(`\n${fails === 0 ? 'ALL SINGLE-INSTANCE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
