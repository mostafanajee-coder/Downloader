'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } = require('electron');
const notifier = require('node-notifier');

const { Manager } = require('../core/Manager');
const { createBridgeServer } = require('../bridge/server');
const { ConfigManager } = require('../core/config');
const { SiteGrabber } = require('../core/siteGrabber');

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

  const forward = (channel) => (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };
  manager.on('added', forward('queue:item-added'));
  manager.on('updated', (payload) => {
    forward('queue:item-updated')(payload);
  });
  manager.on('removed', forward('queue:item-removed'));
  manager.on('queue-state', forward('queue:state-changed'));

  const notifiedSet = new Set();
  manager.on('updated', (item) => {
    if (item.status === 'completed' && !notifiedSet.has(item.id)) {
      notifiedSet.add(item.id);
      notifier.notify({
        title: 'Download Complete',
        message: `${item.filename || 'A file'} has finished downloading.`,
        wait: false,
      });
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
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
    manager.add({ url });
  }
}

process.on('uncaughtException', (err) => {
  console.warn('[Main Process Warning]', err.message);
});

process.on('unhandledRejection', (err) => {
  console.warn('[Main Process Rejection]', err);
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  config = new ConfigManager(stateDir);
  manager = new Manager({ stateDir, config });

  try {
    bridge = await createBridgeServer({ manager, port: 9333 });
    console.log(`Bridge listening on ws://127.0.0.1:9333`);
  } catch (e) {
    console.warn(`Bridge port busy, starting UI mode:`, e.message);
  }

  createWindow();
  createTray();
  handleCommandLine(process.argv);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

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

  const g = new SiteGrabber(opts);
  grabber = g;
  g.on('page-start', (p) => sendToWindow('grabber:page-start', p));
  g.on('asset-found', (a) => sendToWindow('grabber:asset-found', a));
  g.on('page-error', (e) => sendToWindow('grabber:page-error', e));
  g.crawl().then((assets) => {
    // Only report completion if no newer crawl has superseded this one — a
    // cancelled crawl still resolves its promise, and without this check its
    // late arrival could send a stray "done" for a crawl the user already
    // replaced, and/or report the WRONG instance's cancelled flag.
    if (grabber === g) sendToWindow('grabber:done', { assets, cancelled: g.cancelled });
  });

  return { started: true };
});

ipcMain.handle('grabber:cancel', () => {
  if (grabber) grabber.cancel();
});


