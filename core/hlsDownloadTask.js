'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolvePlaylist, segmentIv } = require('./hls');
const { streamToFile } = require('./streamFile');
const { resolveWorkspace, finalizeWorkspace } = require('./workspace');
const { scopeHeaders } = require('./headerScope');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listVariants(playlistUrl, headers = {}) {
  const result = await resolvePlaylist(playlistUrl, headers);
  if (result.type === 'master') return result.variants;
  return [{ bandwidth: null, resolution: null, url: playlistUrl }];
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
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
    tempDir = null,
  }) {
    super();
    this.playlistUrl = playlistUrl;
    this.destPath = destPath;
    this.tempDir = tempDir || null;
    this.workPath = null;
    this.workDir = null;
    this.usingTemp = false;
    this.headers = headers;
    this.concurrency = concurrency;
    this.variantIndex = variantIndex;
    this.ffmpegPath = ffmpegPath;
    this.retries = retries;
    this.keepSegments = keepSegments;
    this.rateLimiter = rateLimiter;

    this.paused = false;
    this.cancelled = false;
    this.failed = false;
    this.segDir = null;
    this.segments = [];
    this.mapUri = null;
    this.maps = new Map(); // "uri|start-end" -> local file name
    this.keysMap = new Map(); // remoteUri -> localFileName
    this.completed = 0;
    this.downloadedBytes = 0; // bytes transferred in this run (drives the speed readout)
    this.bytesCompleted = 0; // bytes of every finished segment, including ones kept from an earlier run
    this.speed = speedometer(3);
    this.startTime = null;
  }

  /** Headers for a request to `url`: credentials stay with the playlist's own site. */
  _headersFor(url) {
    return scopeHeaders(this.playlistUrl, url, this.headers);
  }

  async start() {
    this.startTime = Date.now();
    fs.mkdirSync(path.dirname(this.destPath), { recursive: true });

    let playlist = await resolvePlaylist(this.playlistUrl, this.headers);
    if (playlist.type === 'master') {
      const variant = playlist.variants[this.variantIndex] || playlist.variants[0];
      if (!variant) throw new Error('No variants found in master playlist');
      this.emit('variant-selected', variant);
      playlist = await resolvePlaylist(variant.url, this._headersFor(variant.url));
    }

    if (!playlist.segments || !playlist.segments.length) {
      throw new Error('No segments found in HLS playlist');
    }

    // Refuse up front rather than producing a file that looks finished and
    // won't play. IDM shows exactly these two refusals.
    if (playlist.drm) {
      throw new Error(`This stream is DRM-protected (${playlist.drm}) and cannot be downloaded.`);
    }
    if (playlist.live) {
      throw new Error(
        'This is a live stream with no end marker. Downloading it would capture only the current window; live recording is not supported.'
      );
    }

    this.segments = playlist.segments;
    this.mapUri = playlist.mapUri;

    // Segments, keys, the rewritten local playlist and ffmpeg's output all live
    // inside the workspace. Previously the scratch folder sat right beside the
    // finished video as "<name>.hls_parts", so a cancelled stream download left
    // hundreds of .ts files in the user's Video folder.
    const workspace = resolveWorkspace({ destPath: this.destPath, tempDir: this.tempDir });
    this.workPath = workspace.workPath;
    this.workDir = workspace.workDir;
    this.usingTemp = workspace.usingTemp;
    this.segDir = this.usingTemp ? path.join(this.workDir, 'hls_parts') : `${this.destPath}.hls_parts`;
    fs.mkdirSync(this.segDir, { recursive: true });

    this.emit('start', { segments: this.segments.length, encrypted: playlist.encrypted });

    await this._downloadMaps();
    if (this.failed) return;

    // Download any AES-128 encryption keys locally using request headers
    await this._downloadKeys();

    await this._downloadSegments();

    // 'error' has already been emitted by whichever segment gave up.
    if (this.failed) return;
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
    // ffmpeg wrote to the workspace; publish only now that it exited cleanly,
    // so a failed remux can never leave a broken .mp4 at the destination.
    finalizeWorkspace({
      workPath: this.workPath,
      destPath: this.destPath,
      workDir: this.workDir,
      usingTemp: this.usingTemp,
    });
    this.emit('complete', { destPath: this.destPath, size: fileSize(this.destPath) || null });
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
    // A playlist doesn't say how big the stream is; extrapolate from the
    // segments finished so far so the Size column shows something useful.
    const size = this.completed > 0 && total > 0 ? Math.round((this.bytesCompleted / this.completed) * total) : null;
    return {
      completed: this.completed,
      total,
      percent: total ? (this.completed / total) * 100 : 0,
      segmentsPerSec,
      downloaded: this.bytesCompleted,
      size,
      sizeEstimated: size != null,
      speedBytesPerSec: this.speed(),
      eta,
    };
  }

  segPath(seg) {
    const ext = this.mapUri ? 'm4s' : 'ts';
    return path.join(this.segDir, `seg_${String(seg.index).padStart(6, '0')}.${ext}`);
  }

  _mapKey(map) {
    return `${map.uri}|${map.range ? `${map.range.start}-${map.range.end}` : ''}`;
  }

  /** Every distinct #EXT-X-MAP init segment, downloaded once each. */
  async _downloadMaps() {
    for (const seg of this.segments) {
      if (!seg.map) continue;
      const key = this._mapKey(seg.map);
      if (this.maps.has(key)) continue;
      const name = `init_${this.maps.size}.mp4`;
      this.maps.set(key, name);
      const dest = path.join(this.segDir, name);
      if (fs.existsSync(dest)) continue;
      await this._fetchWithRetry(seg.map.uri, dest, { range: seg.map.range, label: 'init segment' });
      if (this.failed || this.cancelled || this.paused) return;
    }
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
      while (nextIndex < total && !this.cancelled && !this.paused && !this.failed) {
        const seg = this.segments[nextIndex++];
        const finalPath = this.segPath(seg);
        if (fs.existsSync(finalPath)) {
          this.completed++;
          this.bytesCompleted += fileSize(finalPath);
          continue;
        }
        const ok = await this._fetchWithRetry(seg.url, finalPath, { range: seg.range, count: true, index: seg.index });
        if (ok) {
          this.completed++;
          this.bytesCompleted += fileSize(finalPath);
          this.emit('progress', this.getProgress());
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  /** Resolves true once the file is on disk, false if stopped or failed. */
  async _fetchWithRetry(url, finalPath, { range = null, count = false, index = null, label = 'segment' } = {}) {
    let attempt = 0;
    while (!this.cancelled && !this.paused && !this.failed) {
      try {
        await this._downloadToFile(url, finalPath, { count, range });
        return true;
      } catch (err) {
        attempt++;
        this.emit('segment-error', { index, attempt, error: err.message });
        if (err.retryable === false || attempt > this.retries) {
          if (!this.failed) {
            this.failed = true;
            const which = index != null ? `Segment ${index}` : `The ${label}`;
            this.emit('error', new Error(`${which} failed after ${attempt} attempt(s): ${err.message}`));
          }
          return false;
        }
        await sleep(Math.min(500 * 2 ** attempt, 10000));
      }
    }
    return false;
  }

  _downloadToFile(url, finalPath, { count = false, range = null } = {}) {
    return streamToFile(url, finalPath, {
      headers: this._headersFor(url),
      rateLimiter: this.rateLimiter,
      range,
      onBytes: count
        ? (len) => {
            this.downloadedBytes += len;
            this.speed(len);
          }
        : null,
    });
  }

  /**
   * The playlist ffmpeg actually reads: every URI points at a local file, each
   * byte-range slice is its own file, keys are local, and every encrypted
   * segment carries an explicit IV — the local playlist renumbers from zero, so
   * an IV left implicit would be derived from the wrong sequence number.
   */
  _writeLocalPlaylist() {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-MEDIA-SEQUENCE:0'];

    let lastKeySignature;
    let lastMap = null;
    for (const seg of this.segments) {
      if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');

      if (seg.map) {
        const local = this.maps.get(this._mapKey(seg.map));
        if (local && local !== lastMap) {
          lines.push(`#EXT-X-MAP:URI="${local}"`);
          lastMap = local;
        }
      }

      const iv = seg.key ? segmentIv(seg) : null;
      const sig = seg.key ? `${seg.key.method}|${seg.key.uri}|${iv}` : null;
      if (sig !== lastKeySignature) {
        if (seg.key) {
          const localKey = this.keysMap.get(seg.key.uri) || seg.key.uri;
          lines.push(`#EXT-X-KEY:METHOD=${seg.key.method},URI="${localKey}",IV=${iv}`);
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
      const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'hls',
        '-allowed_extensions', 'ALL',
        '-i', localPlaylistPath,
        '-c', 'copy',
        this.workPath,
      ];
      const proc = spawn(this.ffmpegPath, args, { cwd: this.segDir, windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
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
