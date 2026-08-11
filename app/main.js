'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const notifier = require('node-notifier');

const { Manager } = require('../core/Manager');
const { createBridgeServer } = require('../bridge/server');
const { ConfigManager } = require('../core/config');
const { GrabberHost } = require('../core/grabberHost');

const userDataDir = app.getPath('userData');
const stateDir = path.join(userDataDir, 'downloader-state');
const downloadsDir = app.getPath('downloads');

let manager;
let bridge;
let mainWindow;
let tray;
let config;
let grabber; // the in-flight SiteGrabber crawl, if any (one at a time)

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 820,
    minHeight: 480,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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

  const notifiedSet = new Set();
  manager.on('updated', (item) => {
    if (item.status === 'completed' && !notifiedSet.has(item.id)) {
      notifiedSet.add(item.id);
      notifyUser('Download Complete', `${item.filename || 'A file'} has finished downloading.`);
    }
  });
}

// Best-effort system notification. Wrapped so a broken notifier backend
// (missing notify-send on some Linux setups, etc.) can never itself take down
// the process — a failed notification should be a no-op, not a crash.
function notifyUser(title, message) {
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
      label: 'Exit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Internet Download Manager');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', showMainWindow);
}

function handleCommandLine(argv) {
  if (!manager || !argv) return;
  const dlIndex = argv.indexOf('--download');
  if (dlIndex !== -1 && argv.length > dlIndex + 1) {
    const url = argv[dlIndex + 1];
    try {
      manager.add({ url });
    } catch (err) {
      console.warn('[handleCommandLine] Failed to add URL from command line:', err.message);
    }
  }
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

  try {
    bridge = await createBridgeServer({ manager, port: 9333 });
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
      'Port 9333 is in use by another program, so the browser extension cannot connect. Downloads added from the app itself still work.'
    );
  }

  createWindow();
  createTray();
  handleCommandLine(process.argv);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  // With a tray present the app intentionally keeps running after the window is
  // closed; only quit here when there's no tray to fall back to.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('will-quit', async () => {
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
ipcMain.handle('queue:startQueue', () => manager.startQueue());
ipcMain.handle('queue:stopQueue', () => manager.stopQueue());
ipcMain.handle('queue:isQueueRunning', () => manager.isQueueRunning());

ipcMain.handle('config:get', () => config.getAll());
ipcMain.handle('config:set', (_event, newConfig) => {
  config.setAll(newConfig);
  // Apply the (possibly changed) global speed limit to running downloads live.
  manager.updateSpeedLimit();
  manager.updateHttpSettings();
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


