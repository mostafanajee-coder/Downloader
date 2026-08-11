'use strict';

const EventEmitter = require('events');
const path = require('path');
const { fork } = require('child_process');

const CHILD_SCRIPT = path.join(__dirname, 'grabberChild.js');

// How long the crawl may go without saying anything at all before we assume it
// has wedged. Reset on every message, so a slow-but-alive crawl is never cut
// off — only a genuinely silent one.
const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000;
// After asking politely to stop, how long before we stop asking.
const CANCEL_GRACE_MS = 3000;

/**
 * Runs a Site Grabber crawl in a separate process and re-emits its events, so
 * the caller's interface is unchanged from talking to a SiteGrabber directly:
 * 'page-start', 'asset-found', 'page-error', then exactly one 'done'.
 *
 * Exactly one 'done' is the contract that matters. Whatever happens — clean
 * finish, crash, hang, cancel, refusal to die — the UI gets one terminal event
 * carrying whatever assets were found before things went wrong, so a crawl can
 * never leave the wizard spinning forever.
 */
class GrabberHost extends EventEmitter {
  constructor({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, utilityProcess = detectUtilityProcess() } = {}) {
    super();
    this.idleTimeoutMs = idleTimeoutMs;
    this._utilityProcess = utilityProcess;
    this.child = null;
    this.cancelled = false;
    this.settled = false;
    this._assets = [];
    this._idleTimer = null;
    this._cancelTimer = null;
  }

  start(options) {
    if (this.child) this.cancel();
    this.cancelled = false;
    this.settled = false;
    this._assets = [];

    try {
      this.child = this._spawn();
    } catch (err) {
      this._finish({ cancelled: true, error: `Could not start the grabber process: ${err.message}` });
      return;
    }

    this._send({ type: 'start', options });
    this._armIdleTimer();
  }

  cancel() {
    if (this.settled || !this.child) return;
    this.cancelled = true;
    this._send({ type: 'cancel' });

    // SiteGrabber.cancel() only takes effect between requests. If the child is
    // stuck inside one that never returns, it would ignore us indefinitely.
    clearTimeout(this._cancelTimer);
    this._cancelTimer = setTimeout(() => {
      if (!this.settled) {
        this._kill();
        this._finish({ cancelled: true });
      }
    }, CANCEL_GRACE_MS);
  }

  _spawn() {
    if (this._utilityProcess) {
      const child = this._utilityProcess.fork(CHILD_SCRIPT, [], {
        stdio: 'ignore',
        serviceName: 'downloader-site-grabber',
      });
      child.on('message', (msg) => this._onMessage(msg));
      child.on('exit', (code) => this._onExit(code));
      return { kind: 'utility', handle: child };
    }

    // ELECTRON_RUN_AS_NODE matters when this path is taken inside a packaged
    // app: process.execPath is the Electron binary, which would otherwise boot
    // a second copy of the whole application instead of running the script.
    const child = fork(CHILD_SCRIPT, [], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('message', (msg) => this._onMessage(msg));
    child.on('exit', (code) => this._onExit(code));
    child.on('error', (err) => this._finish({ cancelled: true, error: err.message }));
    return { kind: 'fork', handle: child };
  }

  _send(msg) {
    if (!this.child) return;
    try {
      if (this.child.kind === 'utility') this.child.handle.postMessage(msg);
      else this.child.handle.send(msg);
    } catch (err) {
      // The child died between our check and this send; _onExit will settle it.
    }
  }

  _onMessage(msg) {
    if (!msg || this.settled) return;
    this._armIdleTimer(); // any sign of life counts

    switch (msg.type) {
      case 'ready':
        break;
      case 'page-start':
        this.emit('page-start', msg.payload);
        break;
      case 'asset-found':
        this._assets.push(msg.payload);
        this.emit('asset-found', msg.payload);
        break;
      case 'page-error':
        this.emit('page-error', msg.payload);
        break;
      case 'done':
        this._finish({
          assets: msg.payload && msg.payload.assets,
          cancelled: Boolean(msg.payload && msg.payload.cancelled),
        });
        break;
      case 'failed':
        this._finish({ cancelled: true, error: (msg.payload && msg.payload.message) || 'Grabber failed' });
        break;
    }
  }

  _onExit(code) {
    if (this.settled) return;
    // The child vanished without sending 'done' — a crash, an OOM kill, or the
    // OS reaping it. Hand back whatever was streamed before it went.
    this._finish({
      cancelled: true,
      error: `The grabber process stopped unexpectedly (exit code ${code}).`,
    });
  }

  _armIdleTimer() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.settled) return;
      this._kill();
      this._finish({
        cancelled: true,
        error: `The grabber stopped responding after ${Math.round(this.idleTimeoutMs / 1000)}s and was stopped.`,
      });
    }, this.idleTimeoutMs);
  }

  _kill() {
    if (!this.child) return;
    try {
      if (this.child.kind === 'utility') this.child.handle.kill();
      else this.child.handle.kill('SIGKILL');
    } catch (err) {
      // Already gone.
    }
  }

  _finish({ assets, cancelled = false, error = null }) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this._idleTimer);
    clearTimeout(this._cancelTimer);
    this._idleTimer = null;
    this._cancelTimer = null;

    // Prefer the child's authoritative list; fall back to what we streamed, so
    // a crash still surfaces the assets the user already watched appear.
    const finalAssets = Array.isArray(assets) ? assets : this._assets;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        if (child.kind === 'utility') child.handle.kill();
        else if (child.handle.exitCode === null && !child.handle.killed) child.handle.kill();
      } catch (err) {
        // Already gone.
      }
    }

    this.emit('done', { assets: finalAssets, cancelled: cancelled || this.cancelled, error });
  }
}

/**
 * Electron's utilityProcess when we're running inside Electron, otherwise null
 * so we fall back to child_process.fork. In plain Node, `require('electron')`
 * resolves to the package's path string, which has no .utilityProcess.
 */
function detectUtilityProcess() {
  try {
    const electron = require('electron');
    return electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function'
      ? electron.utilityProcess
      : null;
  } catch (err) {
    return null;
  }
}

module.exports = { GrabberHost };
