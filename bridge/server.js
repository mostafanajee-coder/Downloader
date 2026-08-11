'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

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
    verifyClient: (info, cb) => {
      const origin = info.origin || info.req.headers.origin || '';

      // Explicit allowlist wins when configured.
      if (allowedOrigins.length > 0) {
        if (!allowedOrigins.includes(origin)) {
          cb(false, 403, 'Forbidden origin');
          return;
        }
        cb(true);
        return;
      }

      // Otherwise reject connections that carry a normal web-page origin.
      // Any site the user visits could otherwise open ws://127.0.0.1:9333 and
      // queue arbitrary downloads. The extension's service worker connects with
      // a chrome-extension:// origin; native/CLI clients send no Origin header.
      if (/^https?:\/\//i.test(origin)) {
        cb(false, 403, 'Forbidden origin');
        return;
      }

      cb(true);
    },
  });

  const clients = new Set();

  function broadcast(msg) {
    const data = JSON.stringify(msg);
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

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send immediate sync
    ws.send(JSON.stringify({ type: 'hello-ack', config: manager.config ? manager.config.getAll() : {} }));
    ws.send(JSON.stringify({ type: 'queue', items: manager.list() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        switch (msg.type) {
          case 'add-download': {
            const id = manager.add(msg.payload || {});
            ws.send(JSON.stringify({ type: 'add-ack', tempId: msg.tempId, id }));
            break;
          }
          case 'native-idm-capture': {
            const p = msg.payload || {};
            const url = p.url || p.downloadUrl || p.fileUrl;
            if (url) {
              const id = manager.add({
                url,
                suggestedFilename: p.suggestedFilename || p.filename || 'Captured_Media',
                headers: p.headers || {},
              });
              ws.send(JSON.stringify({ type: 'add-ack', id }));
            }
            break;
          }
          case 'list':
            ws.send(JSON.stringify({ type: 'queue', items: manager.list() }));
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
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
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
      resolve({
        httpServer: null,
        wss: null,
        stop: () => Promise.resolve(),
      });
    });

    httpServer.listen(port, '127.0.0.1', () => {
      resolve({
        httpServer,
        wss,
        stop: () =>
          new Promise((r) => {
            manager.off('added', onAdded);
            manager.off('updated', onUpdated);
            manager.off('removed', onRemoved);
            wss.close();
            httpServer.close(r);
          }),
      });
    });
  });
}

module.exports = { createBridgeServer };
