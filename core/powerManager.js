'use strict';

const { exec } = require('child_process');
const EventEmitter = require('events');

/**
 * Power Manager for Windows Auto-Shutdown / Hibernate when downloads complete
 */
class PowerManager extends EventEmitter {
  constructor() {
    super();
    this.autoShutdownEnabled = false;
    this.action = 'shutdown'; // 'shutdown', 'hibernate', 'sleep'
  }

  enableAutoShutdown(action = 'shutdown') {
    this.autoShutdownEnabled = true;
    this.action = action;
    this.emit('status-changed', { enabled: true, action });
  }

  disableAutoShutdown() {
    this.autoShutdownEnabled = false;
    this.cancelPendingShutdown();
    this.emit('status-changed', { enabled: false });
  }

  triggerPowerAction() {
    if (!this.autoShutdownEnabled) return;

    this.emit('power-action-triggered', { action: this.action });

    if (process.platform === 'win32') {
      if (this.action === 'shutdown') {
        exec('shutdown /s /f /t 30 /c "Downloader: All queue downloads completed. System shutting down in 30 seconds."');
      } else if (this.action === 'hibernate') {
        exec('shutdown /h');
      } else if (this.action === 'sleep') {
        exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
      }
    }
  }

  cancelPendingShutdown() {
    if (process.platform === 'win32') {
      exec('shutdown /a', () => {});
    }
  }
}

module.exports = new PowerManager();
