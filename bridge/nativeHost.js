'use strict';

const WebSocket = require('ws');

// Last-resort safety net for this standalone, Chrome-spawned helper process.
// If anything here crashes, Chrome reports "native host has exited
// unexpectedly" and the extension's native-messaging channel breaks until the
// browser is restarted — so nothing in this short-lived process should ever
// be allowed to bring it down uncaught.
process.on('uncaughtException', (err) => {
  console.error('[NativeHost] Uncaught exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[NativeHost] Unhandled rejection:', err);
});

// Connect to our main app WebSocket bridge
const ws = new WebSocket('ws://127.0.0.1:9333');

ws.on('open', () => {
  try {
    ws.send(JSON.stringify({ type: 'hello', source: 'native-host-bridge' }));
  } catch (e) {
    // Send failures are surfaced via the socket's own 'error' event below.
  }
});

// A `ws` connection is an EventEmitter — an unhandled 'error' event throws
// and crashes the process outright. This is the single most likely failure
// mode here: the desktop app simply isn't running when Chrome launches this
// host, so the connection is refused immediately.
ws.on('error', (err) => {
  console.warn('[NativeHost] Bridge connection error:', err.message);
});

// The bridge went away (app closed) or never connected — nothing more this
// process can usefully do. Exit cleanly; Chrome spawns a fresh instance the
// next time native messaging is invoked, so there's no reconnect loop to run
// inside this short-lived helper.
ws.on('close', () => {
  process.exit(0);
});

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    // Guard against a corrupt/malicious length prefix claiming an
    // unreasonably large payload — without this, a bad length would just
    // make the loop wait forever for bytes that will never arrive, silently
    // wedging the host (and the extension's UI waiting on it).
    if (msgLen > 64 * 1024 * 1024) {
      console.warn('[NativeHost] Rejecting oversized message, resetting buffer');
      inputBuffer = Buffer.alloc(0);
      break;
    }
    if (inputBuffer.length < 4 + msgLen) break;

    const msgBytes = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    let msg;
    try {
      msg = JSON.parse(msgBytes.toString('utf8'));
    } catch (e) {
      console.warn('[NativeHost] Dropping malformed message from extension:', e.message);
      continue;
    }

    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'native-idm-capture', payload: msg }));
      }
      // If the socket isn't open, the message is simply dropped — this
      // legacy native-messaging path has no queue/replay of its own (the
      // live extension integration uses the direct WebSocket bridge, not
      // native messaging), so silently dropping is the correct, non-crashing
      // behavior rather than buffering indefinitely.
    } catch (e) {
      console.warn('[NativeHost] Failed to forward message to bridge:', e.message);
    }
  }
});

process.stdin.on('error', (err) => {
  console.warn('[NativeHost] stdin error:', err.message);
});

// Chrome closed the native-messaging pipe (extension disabled/removed, or the
// browser is shutting down) — nothing left to do but exit cleanly.
process.stdin.on('end', () => {
  try {
    ws.close();
  } catch (e) {
    // already closed / never opened — fine either way.
  }
  process.exit(0);
});
