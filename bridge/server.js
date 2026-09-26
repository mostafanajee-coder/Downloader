'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { sanitizeRequestHeaders } = require('../core/headerScope');

// Origins a browser extension connects from. Chrome, Edge, Brave, Vivaldi and
// Opera all use chrome-extension://; Firefox moz-extension://; Safari
// safari-web-extension://.
const EXTENSION_ORIGIN = /^(chrome|moz|ms-browser|safari-web)-extension:\/\/[A-Za-z0-9._@-]+\/?$/;

/**
 * Who may talk to the bridge.
 *
 * A browser always sends an Origin header on a WebSocket handshake, and a web
 * page cannot forge or omit it. So:
 *   - no Origin at all      -> a local program (the native-messaging host, the
 *                              CLI tools), which already runs as the user;
 *   - an extension origin   -> the browser extension;
 *   - ANYTHING else refused -> including "null". The previous check only
 *     refused http(s) origins, and "null" is exactly what a sandboxed iframe or
 *     a data: page sends — any website could embed one, connect, queue
 *     downloads to an arbitrary path, and read back the saved site-login and
 *     proxy passwords from the greeting.
 */
function isTrustedOrigin(origin) {
  if (origin === undefined || origin === '') return true;
  return EXTENSION_ORIGIN.test(String(origin));
}

/**
 * The only configuration a bridge client ever needs (the extension uses the
 * exclusion list and file types). Credentials — Site Logins, proxy passwords —
 * never leave the app.
 */
function publicConfig(manager) {
  const cfg = manager.config && typeof manager.config.getAll === 'function' ? manager.config.getAll() || {} : {};
  return {
    excludedSites: typeof cfg.excludedSites === 'string' ? cfg.excludedSites : '',
    fileTypes: typeof cfg.fileTypes === 'string' ? cfg.fileTypes : '',
  };
}

/**
 * Rebuild a download request from the fields a capture is allowed to set.
 * Where the file goes (destPath/destDir), which queue, whether to skip the
 * duplicate check — those are the user's decisions in the app, never a
 * client's; accepting destPath here let any client write a file anywhere the
 * user can, the Startup folder included.
 */
function sanitizeDownloadPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const url = typeof p.url === 'string' ? p.url.trim() : '';
  if (!/^(https?|ftp):\/\//i.test(url) || url.length > 8192) return null;
  const kind = p.kind === 'hls' || p.kind === 'dash' ? p.kind : 'file';
  const vi = Number(p.variantIndex);
  const payload = {
    url,
    kind,
    headers: sanitizeRequestHeaders(p.headers),
    variantIndex: Number.isInteger(vi) && vi >= 0 && vi < 1000 ? vi : 0,
    // A captured URL is one download. Without this, a URL that happens to
    // contain "[1-1000]" would be expanded into a thousand of them.
    noBatch: true,
  };
  if (typeof p.suggestedFilename === 'string' && p.suggestedFilename.trim()) {
    payload.suggestedFilename = p.suggestedFilename.slice(0, 400);
  }
  return payload;
}

/**
 * Local-only bridge between the Chrome extension and the download Manager.
 * Binds to 127.0.0.1 only. Handles EADDRINUSE gracefully if another process occupies the port.
 */
function createBridgeServer({ manager, port, allowedOrigins = [] }) {
  const httpServer = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    // Messages are small JSON commands; the library default is 100 MB.
    maxPayload: 1024 * 1024,
    verifyClient: (info, cb) => {
      const origin = info.req.headers.origin;

      // Explicit allowlist wins when configured.
      if (allowedOrigins.length > 0) {
        if (!allowedOrigins.includes(origin || '')) {
          cb(false, 403, 'Forbidden origin');
          return;
        }
        cb(true);
        return;
      }

      if (!isTrustedOrigin(origin)) {
        cb(false, 403, 'Forbidden origin');
        return;
      }
      cb(true);
    },
  });

  const clients = new Set();

  // Progress fires ~2.5 times a second per running download. Only clients
  // that ask for it get it: the extension doesn't use it, and pushing every
  // tick into its service worker just to be discarded is pure overhead.
  // Origin-less tools (the CLI) are subscribed by default, as before.
  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.subscribed && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // Settings the extension acts on (File Types, exclusions) are pushed to every
  // client as soon as they change — subscription or not — so an edit in
  // Options applies to the very next browser download.
  function pushConfig() {
    const data = JSON.stringify({ type: 'config', config: publicConfig(manager) });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  const onAdded = (item) => broadcast({ type: 'item-added', item });
  const onUpdated = (item) => broadcast({ type: 'item-updated', item });
  const onRemoved = (info) => broadcast({ type: 'item-removed', id: info.id });
  manager.on('added', onAdded);
  manager.on('updated', onUpdated);
  manager.on('removed', onRemoved);

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    ws.subscribed = !req.headers.origin;

    const reply = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    // Send immediate sync
    reply({ type: 'hello-ack', config: publicConfig(manager) });
    reply({ type: 'queue', items: manager.list() });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      try {
        switch (msg.type) {
          case 'hello':
            break;
          case 'ping':
            // Keeps an MV3 service worker (and so this socket) alive.
            reply({ type: 'pong' });
            break;
          case 'subscribe':
            ws.subscribed = true;
            break;
          case 'unsubscribe':
            ws.subscribed = false;
            break;
          case 'add-download': {
            const payload = sanitizeDownloadPayload(msg.payload);
            if (!payload) {
              reply({ type: 'error', tempId: msg.tempId, message: 'Rejected: not a valid http(s)/ftp download' });
              break;
            }
            const id = manager.add(payload);
            reply({ type: 'add-ack', tempId: msg.tempId, id });
            break;
          }
          case 'native-idm-capture': {
            const p = msg.payload || {};
            const payload = sanitizeDownloadPayload({
              url: p.url || p.downloadUrl || p.fileUrl,
              suggestedFilename: p.suggestedFilename || p.filename || 'Captured_Media',
              headers: p.headers,
            });
            if (payload) reply({ type: 'add-ack', id: manager.add(payload) });
            break;
          }
          case 'list':
            reply({ type: 'queue', items: manager.list() });
            break;
          case 'pause':
            manager.pause(msg.id);
            break;
          case 'resume':
            manager.resume(msg.id);
            break;
          case 'cancel':
            manager.cancel(msg.id);
            break;
          case 'remove':
            manager.remove(msg.id);
            break;
        }
      } catch (err) {
        reply({ type: 'error', message: err.message });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    // Node's `ws` connections are EventEmitters — an 'error' event with no
    // listener throws and can take down the whole Electron main process.
    // Abrupt disconnects (extension reload, browser crash, ECONNRESET) land
    // here rather than 'close', so this must be handled defensively even
    // though 'close' usually fires too (cleanup below is idempotent).
    ws.on('error', (err) => {
      console.warn('[BridgeServer] Connection error:', err.message);
      clients.delete(ws);
    });
  });

  // Same reasoning for the server-level socket — a listen-time bind failure
  // is already handled below, but this covers any later runtime error on the
  // WebSocketServer itself.
  wss.on('error', (err) => {
    console.warn('[BridgeServer] WebSocketServer error:', err.message);
  });

  return new Promise((resolve) => {
    httpServer.on('error', (err) => {
      console.warn(`[BridgeServer] Port ${port} notice: ${err.message}. Continuing in UI mode.`);
      // The manager listeners were attached up-front, before we knew whether
      // the bind would succeed. Nothing will ever read their broadcasts now,
      // so detach them rather than leaving this dead server subscribed to
      // every progress tick for the lifetime of the app.
      manager.off('added', onAdded);
      manager.off('updated', onUpdated);
      manager.off('removed', onRemoved);
      resolve({
        httpServer: null,
        wss: null,
        pushConfig: () => {},
        stop: () => Promise.resolve(),
      });
    });

    httpServer.listen(port, '127.0.0.1', () => {
      resolve({
        httpServer,
        wss,
        pushConfig,
        stop: () =>
          new Promise((r) => {
            manager.off('added', onAdded);
            manager.off('updated', onUpdated);
            manager.off('removed', onRemoved);
            for (const ws of clients) {
              try {
                ws.terminate();
              } catch (e) {
                /* already gone */
              }
            }
            wss.close();
            httpServer.close(() => r());
          }),
      });
    });
  });
}

module.exports = { createBridgeServer, isTrustedOrigin, sanitizeDownloadPayload, publicConfig };
