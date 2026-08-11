'use strict';

const EventEmitter = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class NativeEngineTask extends EventEmitter {
  constructor({ url, destPath, connections = 8 }) {
    super();
    this.url = url;
    this.destPath = destPath;
    this.connections = connections;
    this.binaryPath = path.join(__dirname, '..', 'bin', 'downloader-native.exe');
    this.process = null;
    this.paused = false;
    this.cancelled = false;
    this.finished = false;
    this.progress = { downloaded: 0, total: 0, speed: 0, percent: 0 };
  }

  async start() {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Native binary not found at ${this.binaryPath}. Please run build script.`);
    }

    const args = [this.url, this.destPath, String(this.connections)];
    this.process = spawn(this.binaryPath, args, { windowsHide: true });

    this.process.stdout.on('data', (data) => {
      const output = data.toString();
      // Match progress output: [Downloading] 50.0% | 5.0 MB / 10.0 MB | 2.50 MB/s
      const match = output.match(/(\d+\.\d+)%\s+\|\s+(\d+\.\d+)\s+MB\s+\/\s+(\d+\.\d+)\s+MB\s+\|\s+(\d+\.\d+)\s+MB\/s/);
      if (match) {
        const percent = parseFloat(match[1]);
        const downloadedMB = parseFloat(match[2]);
        const totalMB = parseFloat(match[3]);
        const speedMB = parseFloat(match[4]);

        this.progress = {
          percent,
          downloaded: Math.round(downloadedMB * 1024 * 1024),
          total: Math.round(totalMB * 1024 * 1024),
          speed: Math.round(speedMB * 1024 * 1024)
        };

        this.emit('progress', this.progress);
      }
    });

    this.process.on('close', (code) => {
      if (code === 0) {
        this.finished = true;
        this.emit('finished', { destPath: this.destPath });
      } else if (!this.cancelled) {
        this.emit('error', new Error(`Native C++ Engine exited with code ${code}`));
      }
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });
  }

  pause() {
    if (this.process) {
      this.paused = true;
      this.process.kill('SIGSTOP');
      this.emit('paused');
    }
  }

  resume() {
    if (this.process) {
      this.paused = false;
      this.process.kill('SIGCONT');
      this.emit('resumed');
    }
  }

  cancel() {
    if (this.process) {
      this.cancelled = true;
      this.process.kill('SIGKILL');
      this.emit('cancelled');
    }
  }
}

module.exports = { NativeEngineTask };
