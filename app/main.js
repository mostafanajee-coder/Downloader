'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell, powerSaveBlocker, clipboard } = require('electron');
const notifier = require('node-notifier');

const { Manager } = require('../core/Manager');
const { createBridgeServer } = require('../bridge/server');
const { ConfigManager } = require('../core/config');
const { GrabberHost } = require('../core/grabberHost');
const { ScheduleManager } = require('../core/scheduler');
const { PowerManager } = require('../core/powerManager');

const userDataDir = app.getPath('userData');
const stateDir = path.join(userDataDir, 'downloader-state');
const downloadsDir = app.getPath('downloads');

// The extension always talks to 9333. The override exists so a development or
// test instance can run beside the real one without catching its downloads.
const BRIDGE_PORT = (() => {
  const n = Number(process.env.DOWNLOADER_BRIDGE_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9333;
})();

let manager;
let bridge;
let mainWindow;
let tray;
let config;
let grabber; // the in-flight SiteGrabber crawl, if any (one at a time)
let scheduler;
let power;
let powerBlockerId = null; // powerSaveBlocker handle while downloads are active
let clipboardTimer = null;
let lastClipboardText = null;
let shutdownStarted = false;

// Launched by "Start with Windows": come up in the tray, not in the user's face.
const startHidden = process.argv.includes('--hidden');

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    // Wide enough for the default column widths (~990px) beside the category
    // tree; at 1120 the Description column started off-screen behind a
    // horizontal scrollbar.
    width: 1240,
    height: 720,
    minWidth: 820,
    minHeight: 480,
    backgroundColor: '#1c1f26',
    show,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The preload exposes powerful IPC (open a file, delete a file, change
  // settings). The window must only ever show our own page: a dropped link or
  // a stray <a href> navigating it would hand that API to a remote site.
  const appPage = mainWindow.webContents;
  appPage.on('will-navigate', (e) => e.preventDefault());
  appPage.on('will-redirect', (e) => e.preventDefault());
  appPage.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize / close to the system tray instead of quitting (classic IDM
  // behavior — the app keeps running in the tray to catch browser downloads).
  mainWindow.on('minimize', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

// Wires Manager events to the renderer/tray exactly once, for the app's whole
// lifetime — NOT from inside createWindow(). createWindow() can legitimately
// run more than once (e.g. macOS `activate` recreating a destroyed window),
// and registering these listeners there would duplicate them on every
// recreation: duplicate IPC forwards, duplicate "Download Complete" toasts,
// worse with every cycle. sendToWindow() already safely no-ops when there's
// no live window, so this wiring is independent of window lifecycle.
function wireManagerEvents() {
  manager.on('added', (item) => sendToWindow('queue:item-added', item));
  manager.on('updated', (item) => sendToWindow('queue:item-updated', item));
  manager.on('removed', (info) => sendToWindow('queue:item-removed', info));
  manager.on('queue-state', (state) => sendToWindow('queue:state-changed', state));
  // The Manager can't put a dialog on screen, and duplicate URLs arrive from
  // the browser extension as well as the UI, so it defers the decision to
  // whoever is listening. The renderer prompts and re-adds with allowDuplicate.
  manager.on('duplicate-detected', (info) => sendToWindow('queue:duplicate', info));
  manager.on('queues-changed', (queues) => sendToWindow('queues:changed', queues));

  // Keep the machine awake while anything is transferring, and mirror overall
  // progress onto the taskbar button. Both are things IDM does and both are
  // invisible until they're missing (a laptop that sleeps at 80%).
  manager.on('updated', () => syncActivityState());
  manager.on('removed', () => syncActivityState());

  const notifiedSet = new Set();
  manager.on('updated', (item) => {
    if (item.status === 'completed' && !notifiedSet.has(item.id)) {
      notifiedSet.add(item.id);
      notifyUser('Download Complete', `${item.filename || 'A file'} has finished downloading.`);
    }
  });
}

// Aggregate running-download state -> powerSaveBlocker + taskbar progress.
function syncActivityState() {
  if (!manager) return;
  const items = manager.list();
  const running = items.filter((i) => i.status === 'running');

  // powerSaveBlocker: hold it only while something is actually moving.
  if (running.length && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!running.length && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }

  // Taskbar progress: weighted by bytes when sizes are known, else by percent.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!running.length) {
      mainWindow.setProgressBar(-1);
      return;
    }
    let done = 0;
    let total = 0;
    for (const i of running) {
      const p = i.progress || {};
      if (i.size && p.downloaded != null) {
        done += p.downloaded;
        total += i.size;
      } else if (p.percent != null) {
        done += p.percent;
        total += 100;
      }
    }
    if (total > 0) mainWindow.setProgressBar(Math.max(0, Math.min(1, done / total)));
    else mainWindow.setProgressBar(2, { mode: 'indeterminate' });
  }
}

// IDM's "Monitor the clipboard for downloadable URLs": when a URL that looks
// like a file is copied, offer it in the Add URL dialog. The renderer decides
// what to do with it; here we only detect and de-duplicate.
const CLIPBOARD_URL = /^(https?|ftp):\/\/\S+$/i;
function clipboardLooksDownloadable(text) {
  if (!text || text.length > 2048) return false;
  const t = text.trim();
  if (!CLIPBOARD_URL.test(t)) return false;
  if (/\.(m3u8|mpd)(\?|$)/i.test(t)) return true;
  const types = String(config ? config.get('fileTypes') || '' : '')
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
  let ext = '';
  try {
    const pathname = new URL(t).pathname;
    const last = pathname.split('/').pop() || '';
    ext = last.includes('.') ? last.split('.').pop().toLowerCase() : '';
  } catch (e) {
    return false;
  }
  return Boolean(ext) && types.some((pat) => new RegExp('^' + pat + '$').test(ext));
}

function syncClipboardMonitor() {
  const wanted = Boolean(config && config.get('autoClipboard'));
  if (wanted && !clipboardTimer) {
    try {
      lastClipboardText = clipboard.readText();
    } catch (e) {
      lastClipboardText = null;
    }
    clipboardTimer = setInterval(() => {
      let text;
      try {
        text = clipboard.readText();
      } catch (e) {
        return;
      }
      if (text === lastClipboardText) return;
      lastClipboardText = text;
      if (clipboardLooksDownloadable(text)) {
        sendToWindow('clipboard:url', text.trim());
        showMainWindow();
      }
    }, 1000);
  } else if (!wanted && clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
}

// Best-effort system notification. Wrapped so a broken notifier backend
// (missing notify-send on some Linux setups, etc.) can never itself take down
// the process — a failed notification should be a no-op, not a crash.
//
// Rate-limited, and that limit is load-bearing rather than cosmetic. On Windows
// node-notifier shows each toast by spawning a helper executable, so an error
// that repeats — a progress tick that throws, a rejection on every retry —
// turns into a process-spawn storm that will bring the whole machine to its
// knees and make the app look frozen. The failure being reported is then far
// less damaging than the reporting of it.
const NOTIFY_MIN_INTERVAL_MS = 10000;
const _notifyHistory = new Map(); // message -> last shown at
let _notifyLastAny = 0;

function notifyUser(title, message) {
  const now = Date.now();
  const key = `${title}|${message}`;
  // Identical messages are throttled hard; anything at all is throttled to one
  // per second, so a burst of *different* errors still can't spawn a storm.
  if (now - (_notifyHistory.get(key) || 0) < NOTIFY_MIN_INTERVAL_MS) return;
  if (now - _notifyLastAny < 1000) return;
  _notifyHistory.set(key, now);
  _notifyLastAny = now;

  // Keep the dedupe map from growing without bound over a long session.
  if (_notifyHistory.size > 50) {
    for (const [k, at] of _notifyHistory) {
      if (now - at > NOTIFY_MIN_INTERVAL_MS) _notifyHistory.delete(k);
    }
  }

  try {
    notifier.notify({ title, message, wait: false });
  } catch (e) {
    console.warn('[Notifier] Failed to show notification:', e.message);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  // The window may be minimized, hidden in the tray, or simply behind another
  // app — un-do all three, in that order, so this reliably surfaces it no
  // matter which state the user left it in.
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'extension', 'icon16.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(__dirname, '..', 'extension', 'icon48.png'));
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  } catch (e) {
    console.warn('Tray unavailable:', e.message);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Internet Download Manager', click: showMainWindow },
    { type: 'separator' },
    { label: 'Start Queue', click: () => manager && manager.startQueue() },
    { label: 'Stop Queue', click: () => manager && manager.stopQueue() },
    { type: 'separator' },
    { label: 'Resume all downloads', click: () => manager && manager.resumeAll() },
    { label: 'Pause all downloads', click: () => manager && manager.pauseAll() },
    { type: 'separator' },
    {
      label: 'Speed Limiter',
      type: 'checkbox',
      checked: Boolean(config && config.get('speedLimiterEnabled')),
      click: (item) => {
        if (!config || !manager) return;
        config.set('speedLimiterEnabled', item.checked);
        manager.updateSpeedLimit();
        sendToWindow('limiter:changed', { enabled: item.checked, kbps: Number(config.get('speedLimitKBps')) || 0 });
      },
    },
    {
      label: 'Options...',
      click: () => {
        showMainWindow();
        sendToWindow('ui:open-options');
      },
    },
    { type: 'separator' },
    { label: 'Exit', click: quitApp },
  ]);

  tray.setToolTip('Internet Download Manager');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', showMainWindow);
}

function handleCommandLine(argv) {
  if (!manager || !argv) return;
  const dlIndex = argv.indexOf('--download');
  if (dlIndex !== -1 && argv.length > dlIndex + 1) {
    const url = String(argv[dlIndex + 1] || '').trim();
    if (!/^(https?|ftp):\/\//i.test(url)) {
      console.warn('[handleCommandLine] Ignoring --download with a non-http(s)/ftp URL');
      return;
    }
    try {
      manager.add({ url, noBatch: true });
    } catch (err) {
      console.warn('[handleCommandLine] Failed to add URL from command line:', err.message);
    }
  }
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

// Last-resort safety nets. A packaged .exe has no visible console, so a bare
// console.warn here is effectively invisible to the user — best-effort
// surface it as a system notification too, so a real problem is at least
// discoverable instead of the app silently misbehaving. These must never
// throw themselves (that would recurse into the same handler), so every
// side effect here is individually try/caught.
process.on('uncaughtException', (err) => {
  console.warn('[Main Process Exception]', err && err.stack ? err.stack : err);
  notifyUser('Downloader — unexpected error', (err && err.message) || 'An unexpected error occurred.');
});

process.on('unhandledRejection', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.warn('[Main Process Rejection]', err);
  notifyUser('Downloader — unexpected error', message || 'An unexpected error occurred.');
});

// --- Single instance ---------------------------------------------------------
// Exactly one process may own the bridge port (127.0.0.1:9333) and the state
// database. A second launch used to race the primary for both, which surfaced
// as `listen EADDRINUSE 127.0.0.1:9333` and left the ghost instance running in
// UI-only mode — the browser extension would then silently stop working
// because it was talking to a bridge owned by the *other* process.
//
// The lock must be taken before anything with a side effect: if we don't own
// it, this process registers no `whenReady` handler at all, so it never opens
// the DB, never binds the port and never creates a tray icon — it just hands
// its argv to the primary and exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Electron grants this process foreground rights for the duration of the
  // event, so focus() here actually raises the window on Windows rather than
  // just flashing the taskbar button.
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    // A second launch is also how `downloader.exe --download <url>` reaches an
    // already-running instance, so its command line still has to be honoured.
    handleCommandLine(argv);
  });

  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  Menu.setApplicationMenu(null);

  try {
    config = new ConfigManager(stateDir);
    manager = new Manager({ stateDir, config });
  } catch (err) {
    // Can't recover from a broken state directory / corrupt DB — tell the
    // user plainly (a native dialog works even though no window/renderer
    // exists yet) and exit cleanly rather than continuing with `manager`
    // undefined, which would make every IPC handler below throw forever.
    dialog.showErrorBox(
      'Internet Download Manager — Startup Failed',
      `The app could not initialize its download state:\n\n${err.message}\n\nCheck that ${stateDir} is writable, then restart the app.`
    );
    app.exit(1);
    return;
  }

  wireManagerEvents();

  power = new PowerManager({ exitApp: quitApp });
  scheduler = new ScheduleManager({ manager, config, power });
  scheduler.on('fired', (e) => sendToWindow('schedule:event', { type: 'fired', ...e }));
  scheduler.on('quota-exceeded', (e) => {
    sendToWindow('schedule:event', { type: 'quota-exceeded', ...e });
    notifyUser('Download quota reached', `${(e.usedBytes / 1048576).toFixed(0)} MB in ${e.hours}h - queues stopped.`);
  });
  scheduler.on('completion-action', (e) => {
    sendToWindow('schedule:event', { type: 'completion-action', ...e });
    showMainWindow();
    notifyUser('Downloads finished', `The computer will ${e.action} in 30 seconds. Open the app to cancel.`);
  });
  scheduler.on('completion-action-cancelled', () => sendToWindow('schedule:event', { type: 'completion-action-cancelled' }));
  syncClipboardMonitor();

  try {
    bridge = await createBridgeServer({ manager, port: BRIDGE_PORT });
  } catch (e) {
    console.warn('Bridge failed to start, continuing in UI-only mode:', e.message);
  }

  // createBridgeServer resolves with a null server rather than rejecting when
  // the port can't be bound, so a failure is only visible here. With the
  // single-instance lock in place this can no longer be our own ghost process
  // — it means a genuinely unrelated program holds 9333 — and the consequence
  // (the browser extension can't reach the app at all) is too big to leave in
  // a console the user will never open.
  if (!bridge || !bridge.httpServer) {
    notifyUser(
      'Downloader — browser integration unavailable',
      `Port ${BRIDGE_PORT} is in use by another program, so the browser extension cannot connect. Downloads added from the app itself still work.`
    );
  }

  createWindow({ show: !startHidden });
  createTray();
  // Without a tray there would be no way to reach a hidden window.
  if (startHidden && !tray) showMainWindow();
  handleCommandLine(process.argv);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
}

app.on('before-quit', (e) => {
  app.isQuitting = true;
  // Give running transfers a moment to flush their bytes and sidecars rather
  // than being killed mid-write, then quit for real. Bounded, so a wedged
  // download can never keep the app from closing.
  if (!shutdownStarted && manager && typeof manager.shutdown === 'function') {
    shutdownStarted = true;
    e.preventDefault();
    Promise.resolve()
      .then(() => manager.shutdown({ timeoutMs: 4000 }))
      .catch((err) => console.warn('[Shutdown]', err && err.message))
      .finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  // With a tray present the app intentionally keeps running after the window is
  // closed; only quit here when there's no tray to fall back to.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('will-quit', async () => {
  if (scheduler) scheduler.destroy();
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
  if (bridge) await bridge.stop();
});

ipcMain.handle('queue:list', () => manager.list());

ipcMain.handle('queue:add', (_event, payload) => manager.add(payload));

ipcMain.handle('queue:pause', (_event, id) => manager.pause(id));
ipcMain.handle('queue:resume', (_event, id) => manager.resume(id));
ipcMain.handle('queue:cancel', (_event, id) => manager.cancel(id));
ipcMain.handle('queue:remove', (_event, id) => manager.remove(id));
ipcMain.handle('queue:pauseAll', () => manager.pauseAll());
ipcMain.handle('queue:resumeAll', () => manager.resumeAll());
ipcMain.handle('queue:startAll', () => manager.startAll());
ipcMain.handle('queue:refreshUrl', (_event, { id, url }) => manager.refreshUrl(id, url));
ipcMain.handle('queue:hold', (_event, id) => manager.hold(id));
ipcMain.handle('queue:startQueue', (_event, queueId) => manager.startQueue(queueId));
ipcMain.handle('queue:stopQueue', (_event, queueId) => manager.stopQueue(queueId));
ipcMain.handle('queue:isQueueRunning', () => manager.isQueueRunning());
ipcMain.handle('queue:reorder', (_event, { id, delta }) => manager.reorder(id, delta));
ipcMain.handle('queue:redownload', (_event, id) => manager.redownload(id));
ipcMain.handle('queue:probe', (_event, url) => manager.probeUrl(url));
ipcMain.handle('app:quit', () => quitApp());

// --- Named queues -----------------------------------------------------------
ipcMain.handle('queues:list', () => manager.listQueues());
ipcMain.handle('queues:create', (_event, { name, maxConcurrent }) => manager.createQueue(name, maxConcurrent));
ipcMain.handle('queues:rename', (_event, { queueId, name }) => manager.renameQueue(queueId, name));
ipcMain.handle('queues:setConcurrency', (_event, { queueId, maxConcurrent }) =>
  manager.setQueueConcurrency(queueId, maxConcurrent)
);
ipcMain.handle('queues:delete', (_event, queueId) => manager.deleteQueue(queueId));
ipcMain.handle('queues:move', (_event, { ids, queueId }) => manager.moveToQueue(ids, queueId));

ipcMain.handle('config:get', () => config.getAll());
ipcMain.handle('config:set', (_event, newConfig) => {
  if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) return;
  config.setAll(newConfig);
  // Apply the (possibly changed) global speed limit to running downloads live.
  manager.updateSpeedLimit();
  manager.updateHttpSettings();
  if (scheduler) scheduler.update();
  syncClipboardMonitor();
  // File Types / exclusions changed? The extension learns immediately.
  if (bridge && typeof bridge.pushConfig === 'function') bridge.pushConfig();
});

// --- Scheduler / power ------------------------------------------------------
ipcMain.handle('schedule:get', () => (scheduler ? scheduler.describe() : null));
ipcMain.handle('schedule:set', (_event, schedule) => {
  config.set('schedule', { ...(config.get('schedule') || {}), ...(schedule || {}) });
  if (scheduler) scheduler.update();
  return scheduler ? scheduler.describe() : null;
});
ipcMain.handle('schedule:cancelAction', () => {
  if (power) power.cancelShutdown();
  return scheduler ? scheduler.cancelPendingAction() : false;
});

// --- Speed limiter toggle (IDM: on/off with a remembered value) --------------
ipcMain.handle('limiter:set', (_event, { enabled, kbps } = {}) => {
  const patch = {};
  if (typeof enabled === 'boolean') patch.speedLimiterEnabled = enabled;
  if (kbps !== undefined && Number.isFinite(Number(kbps))) patch.speedLimitKBps = Math.max(0, Math.floor(Number(kbps)));
  config.setAll(patch);
  manager.updateSpeedLimit();
  const state = { enabled: Boolean(config.get('speedLimiterEnabled')), kbps: Number(config.get('speedLimitKBps')) || 0 };
  sendToWindow('limiter:changed', state);
  return state;
});

// --- Export / import download list ------------------------------------------
ipcMain.handle('list:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export download list',
    defaultPath: `downloads-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Download list', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const data = manager.exportList();
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { saved: true, path: result.filePath, count: data.items.length };
});

ipcMain.handle('list:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import download list',
    properties: ['openFile'],
    filters: [
      { name: 'Download list', extensions: ['json'] },
      { name: 'Plain URL list', extensions: ['txt'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { imported: false };
  const file = result.filePaths[0];
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  if (/\.txt$/i.test(file)) {
    // One URL per line, the format IDM's own import accepts.
    data = { items: raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((url) => ({ url })) };
  } else {
    data = JSON.parse(raw);
  }
  const summary = manager.importList(data);
  return { imported: true, path: file, ...summary };
});

ipcMain.handle('shell:openFile', (_event, filePath) => {
  if (filePath) shell.openPath(filePath);
});

ipcMain.handle('shell:showInFolder', (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// "Delete file from disk" — moves to the Recycle Bin (shell.trashItem) rather
// than a permanent unlink, so a Shift+Delete mistake is still recoverable.
ipcMain.handle('shell:deleteFile', async (_event, filePath) => {
  if (!filePath) return { ok: false, error: 'No file path' };
  try {
    await shell.trashItem(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bridge:clientCount', () => {
  return bridge && bridge.wss ? bridge.wss.clients.size : 0;
});

ipcMain.handle('dialog:pickDestDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// --- Site Grabber -----------------------------------------------------------
// Fire-and-forget: the crawl can take several seconds, so the handler starts
// it and returns immediately; progress streams to the renderer via events
// instead of blocking the IPC round trip on the whole crawl.
ipcMain.handle('grabber:start', (_event, opts) => {
  if (!opts || !/^https?:\/\//i.test(opts.targetUrl || '')) {
    return { started: false, error: 'Enter a valid http:// or https:// URL' };
  }
  if (grabber) grabber.cancel(); // only one crawl at a time

  // The crawl itself runs in a separate process (see core/grabberHost.js), so a
  // hostile or pathological page can't stall or crash the app — the host turns
  // any of that into a normal 'done' with an error string.
  const g = new GrabberHost();
  grabber = g;
  g.on('page-start', (p) => sendToWindow('grabber:page-start', p));
  g.on('asset-found', (a) => sendToWindow('grabber:asset-found', a));
  g.on('page-error', (e) => sendToWindow('grabber:page-error', e));
  g.on('done', (result) => {
    // Only report completion if no newer crawl has superseded this one — a
    // cancelled crawl still settles, and without this check its late arrival
    // could send a stray "done" for a crawl the user already replaced.
    if (grabber === g) sendToWindow('grabber:done', result);
  });
  g.start(opts);

  return { started: true };
});

ipcMain.handle('grabber:cancel', () => {
  if (grabber) grabber.cancel();
});


