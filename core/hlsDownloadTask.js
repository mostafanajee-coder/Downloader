'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolvePlaylist } = require('./hls');
const { streamToFile } = require('./streamFile');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listVariants(playlistUrl, headers = {}) {
  const result = await resolvePlaylist(playlistUrl, headers);
  if (result.type === 'master') return result.variants;
  return [{ bandwidth: null, resolution: null, url: playlistUrl }];
}

/**
 * Downloads an HLS (m3u8) stream: fetches all .ts/.m4s segments in parallel,
 * downloads AES-128 keys locally with proper headers, then hands off to ffmpeg
 * (-c copy, no re-encode) to remux into a single file.
 */
class HlsDownloadTask extends EventEmitter {
  constructor({
    playlistUrl,
    destPath,
    headers = {},
    concurrency = 12,
    variantIndex = 0,
    ffmpegPath = 'ffmpeg',
    retries = 5,
    keepSegments = false,
    rateLimiter = null,
  }) {
    super();
    this.playlistUrl = playlistUrl;
    this.destPath = destPath;
    this.headers = headers;
    this.concurrency = concurrency;
    this.variantIndex = variantIndex;
    this.ffmpegPath = ffmpegPath;
    this.retries = retries;
    this.keepSegments = keepSegments;
    this.rateLimiter = rateLimiter;

    this.paused = false;
    this.cancelled = false;
    this.segDir = null;
    this.segments = [];
    this.mapUri = null;
    this.keysMap = new Map(); // remoteUri -> localFileName
    this.completed = 0;
    this.downloadedBytes = 0;
    this.speed = speedometer(3);
    this.startTime = null;
  }

  async start() {
    this.startTime = Date.now();
    fs.mkdirSync(path.dirname(this.destPath), { recursive: true });

    let playlist = await resolvePlaylist(this.playlistUrl, this.headers);
    if (playlist.type === 'master') {
      const variant = playlist.variants[this.variantIndex] || playlist.variants[0];
      if (!variant) throw new Error('No variants found in master playlist');
      this.emit('variant-selected', variant);
      playlist = await resolvePlaylist(variant.url, this.headers);
    }

    if (!playlist.segments || !playlist.segments.length) {
      throw new Error('No segments found in HLS playlist');
    }

    this.segments = playlist.segments;
    this.mapUri = playlist.mapUri;

    this.segDir = `${this.destPath}.hls_parts`;
    fs.mkdirSync(this.segDir, { recursive: true });

    this.emit('start', { segments: this.segments.length, encrypted: playlist.encrypted });

    if (this.mapUri) {
      await this._downloadToFile(this.mapUri, path.join(this.segDir, 'init.mp4'));
    }

    // Download any AES-128 encryption keys locally using request headers
    await this._downloadKeys();

    await this._downloadSegments();

    if (this.cancelled) {
      this.emit('cancelled');
      return;
    }
    if (this.paused) {
      this.emit('paused', this.getProgress());
      return;
    }

    const localPlaylistPath = this._writeLocalPlaylist();
    this.emit('remuxing');
    await this._remux(localPlaylistPath);

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

  segPath(seg) {
    const ext = this.mapUri ? 'm4s' : 'ts';
    return path.join(this.segDir, `seg_${String(seg.index).padStart(6, '0')}.${ext}`);
  }

  async _downloadKeys() {
    let keyIdx = 0;
    for (const seg of this.segments) {
      if (seg.key && seg.key.uri && !this.keysMap.has(seg.key.uri)) {
        const keyFileName = `key_${keyIdx++}.key`;
        const keyLocalPath = path.join(this.segDir, keyFileName);
        try {
          await this._downloadToFile(seg.key.uri, keyLocalPath);
          this.keysMap.set(seg.key.uri, keyFileName);
        } catch (err) {
          // If key download fails, fall back to remote URL
        }
      }
    }
  }

  async _downloadSegments() {
    let nextIndex = 0;
    const total = this.segments.length;

    const worker = async () => {
      while (nextIndex < total && !this.cancelled && !this.paused) {
        const seg = this.segments[nextIndex++];
        const finalPath = this.segPath(seg);
        if (fs.existsSync(finalPath)) {
          this.completed++;
          continue;
        }
        await this._downloadSegmentWithRetry(seg, finalPath);
        if (!this.cancelled) {
          this.completed++;
          this.emit('progress', this.getProgress());
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  async _downloadSegmentWithRetry(seg, finalPath) {
    let attempt = 0;
    while (!this.cancelled && !this.paused) {
      try {
        await this._downloadToFile(seg.url, finalPath, { count: true });
        return;
      } catch (err) {
        attempt++;
        this.emit('segment-error', { index: seg.index, attempt, error: err.message });
        if (attempt > this.retries) {
          this.cancelled = true;
          this.emit('error', new Error(`Segment ${seg.index} failed after ${attempt} attempts: ${err.message}`));
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

  _writeLocalPlaylist() {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    if (this.mapUri) {
      lines.push('#EXT-X-MAP:URI="init.mp4"');
    }

    let lastKeySignature;
    for (const seg of this.segments) {
      const sig = seg.key ? `${seg.key.method}|${seg.key.uri}|${seg.key.iv || ''}` : null;
      if (sig !== lastKeySignature) {
        if (seg.key) {
          const ivPart = seg.key.iv ? `,IV=${seg.key.iv}` : '';
          const localKey = this.keysMap.get(seg.key.uri) || seg.key.uri;
          lines.push(`#EXT-X-KEY:METHOD=${seg.key.method},URI="${localKey}"${ivPart}`);
        } else {
          lines.push('#EXT-X-KEY:METHOD=NONE');
        }
        lastKeySignature = sig;
      }
      lines.push(`#EXTINF:${seg.duration != null ? seg.duration : 0},`);
      lines.push(path.basename(this.segPath(seg)));
    }
    lines.push('#EXT-X-ENDLIST');

    const localPlaylistPath = path.join(this.segDir, 'local.m3u8');
    fs.writeFileSync(localPlaylistPath, lines.join('\n'));
    return localPlaylistPath;
  }

  _remux(localPlaylistPath) {
    return new Promise((resolve, reject) => {
      const args = ['-y', '-f', 'hls', '-allowed_extensions', 'ALL', '-i', localPlaylistPath, '-c', 'copy', this.destPath];
      const proc = spawn(this.ffmpegPath, args, { cwd: this.segDir });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          reject(new Error('FFmpeg was not found. Install FFmpeg and make sure it is available in your system PATH — it is required to remux HLS downloads.'));
        } else {
          reject(err);
        }
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }

  _cleanup() {
    // A failed temp-dir removal (locked file, permissions) shouldn't turn an
    // otherwise-successful download into a reported error — best-effort only.
    try {
      fs.rmSync(this.segDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[HlsDownloadTask] Failed to clean up temp segments at ${this.segDir}:`, err.message);
    }
  }
}

module.exports = { HlsDownloadTask, listVariants };
