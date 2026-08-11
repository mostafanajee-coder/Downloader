'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { request } = require('./httpUtils');
const { streamToFile } = require('./streamFile');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Downloads an MPEG-DASH (.mpd) stream by parsing segment URLs and remuxing via ffmpeg.
 */
class DashDownloadTask extends EventEmitter {
  constructor({
    mpdUrl,
    destPath,
    headers = {},
    concurrency = 10,
    ffmpegPath = 'ffmpeg',
    retries = 5,
    keepSegments = false,
    rateLimiter = null,
  }) {
    super();
    this.mpdUrl = mpdUrl;
    this.destPath = destPath;
    this.headers = headers;
    this.concurrency = concurrency;
    this.ffmpegPath = ffmpegPath;
    this.retries = retries;
    this.keepSegments = keepSegments;
    this.rateLimiter = rateLimiter;

    this.paused = false;
    this.cancelled = false;
    this.segDir = null;
    this.segments = [];
    this.completed = 0;
    this.downloadedBytes = 0;
    this.speed = speedometer(3);
    this.startTime = null;
  }

  async start() {
    this.startTime = Date.now();
    fs.mkdirSync(path.dirname(this.destPath), { recursive: true });

    this.segDir = `${this.destPath}.dash_parts`;
    fs.mkdirSync(this.segDir, { recursive: true });

    // Fetch and parse MPD manifest
    const manifestText = await this._fetchText(this.mpdUrl);
    this.segments = this._parseMpdSegments(manifestText, this.mpdUrl);

    if (!this.segments.length) {
      throw new Error('No downloadable segments found in MPEG-DASH manifest');
    }

    this.emit('start', { segments: this.segments.length });

    await this._downloadSegments();

    if (this.cancelled) {
      this.emit('cancelled');
      return;
    }
    if (this.paused) {
      this.emit('paused', this.getProgress());
      return;
    }

    this.emit('remuxing');
    await this._remux();

    if (!this.keepSegments) this._cleanup();
    this.emit('complete', { destPath: this.destPath });
  }

  pause() {
    this.paused = true;
  }

  cancel() {
    this.cancelled = true;
  }

  getProgress() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const total = this.segments.length;
    const segmentsPerSec = elapsed > 0 ? this.completed / elapsed : 0;
    const eta = segmentsPerSec > 0 && total > 0 ? (total - this.completed) / segmentsPerSec : null;
    return {
      completed: this.completed,
      total,
      percent: total ? (this.completed / total) * 100 : 0,
      segmentsPerSec,
      downloaded: this.downloadedBytes,
      speedBytesPerSec: this.speed(),
      eta,
    };
  }

  _fetchText(url) {
    return new Promise((resolve, reject) => {
      request(url, { method: 'GET', headers: this.headers })
        .then(({ res }) => {
          let body = '';
          res.on('data', (d) => (body += d.toString()));
          res.on('end', () => resolve(body));
          res.on('error', reject);
        })
        .catch(reject);
    });
  }

  _parseMpdSegments(xml, baseUrl) {
    const segments = [];
    const base = new URL(baseUrl);
    const mediaRegex = /<BaseURL>([^<]+)<\/BaseURL>|<SegmentURL media="([^"]+)"/g;
    let match;
    let idx = 0;

    while ((match = mediaRegex.exec(xml)) !== null) {
      const segRel = match[1] || match[2];
      if (segRel) {
        try {
          const segUrl = new URL(segRel, base).toString();
          segments.push({ index: idx++, url: segUrl });
        } catch {}
      }
    }
    return segments;
  }

  async _downloadSegments() {
    let nextIndex = 0;
    const total = this.segments.length;

    const worker = async () => {
      while (nextIndex < total && !this.cancelled && !this.paused) {
        const seg = this.segments[nextIndex++];
        const finalPath = path.join(this.segDir, `seg_${String(seg.index).padStart(6, '0')}.m4s`);
        if (fs.existsSync(finalPath)) {
          this.completed++;
          continue;
        }
        await this._downloadSegmentWithRetry(seg.url, finalPath);
        if (!this.cancelled) {
          this.completed++;
          this.emit('progress', this.getProgress());
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  async _downloadSegmentWithRetry(url, finalPath) {
    let attempt = 0;
    while (!this.cancelled && !this.paused) {
      try {
        await this._downloadToFile(url, finalPath, { count: true });
        return;
      } catch (err) {
        attempt++;
        if (attempt > this.retries) {
          this.cancelled = true;
          this.emit('error', err);
          return;
        }
        await sleep(Math.min(500 * 2 ** attempt, 10000));
      }
    }
  }

  _downloadToFile(url, finalPath, { count = false } = {}) {
    return streamToFile(url, finalPath, {
      headers: this.headers,
      rateLimiter: this.rateLimiter,
      onBytes: count
        ? (len) => {
            this.downloadedBytes += len;
            this.speed(len);
          }
        : null,
    });
  }

  _remux() {
    return new Promise((resolve, reject) => {
      const args = ['-y', '-i', this.mpdUrl, '-c', 'copy', this.destPath];
      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
      });
    });
  }

  _cleanup() {
    fs.rmSync(this.segDir, { recursive: true, force: true });
  }
}

module.exports = { DashDownloadTask };
