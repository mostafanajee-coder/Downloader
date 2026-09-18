'use strict';

const { exec } = require('child_process');
const EventEmitter = require('events');

/**
 * Executes the scheduler's "when done" actions. Nothing here is ever called
 * without the scheduler's 30-second cancellable countdown in front of it.
 *
 * `exitApp` is injected by main.js because quitting an Electron app cleanly
 * needs `app.quit()` with the tray's isQuitting flag set — this module must
 * stay free of Electron so it can be unit-tested in plain Node.
 */
class PowerManager extends EventEmitter {
  constructor({ platform = process.platform, run = exec, exitApp = null } = {}) {
    super();
    this.platform = platform;
    this.run = run;
    this.exitApp = exitApp;
  }

  perform(action) {
    this.emit('performing', { action });
    switch (action) {
      case 'exit':
        if (this.exitApp) this.exitApp();
        return true;
      case 'shutdown':
        return this._os(
          'shutdown /s /f /t 30 /c "Downloader: all scheduled downloads finished. Shutting down in 30 seconds."',
          'shutdown -h +1'
        );
      case 'hibernate':
        return this._os('shutdown /h', 'systemctl hibernate');
      case 'sleep':
        return this._os('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', 'systemctl suspend');
      default:
        return false;
    }
  }

  /** Abort a Windows shutdown that was issued with a delay. */
  cancelShutdown() {
    if (this.platform === 'win32') this.run('shutdown /a', () => {});
  }

  _os(winCmd, unixCmd) {
    const cmd = this.platform === 'win32' ? winCmd : unixCmd;
    this.run(cmd, (err) => {
      if (err) this.emit('failed', { command: cmd, error: err.message });
    });
    return true;
  }
}

module.exports = { PowerManager };
