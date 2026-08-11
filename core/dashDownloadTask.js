'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { request } = require('./httpUtils');
const { streamToFile } = require('./streamFile');
const { resolveWorkspace, finalizeWorkspace } = require('./workspace');
const { parseMpd, selectTracks } = require('./dash');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Downloads an MPEG-DASH (.mpd) stream. Parses the manifest via core/dash.js
 * (SegmentTemplate / SegmentTimeline / SegmentList / single-file), downloads the
 * chosen video representation and best audio representation as separate tracks,
 * concatenates each track's init + media fragments, then muxes them into one
 * file with ffmpeg (-c copy, no re-encode).
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
    variantIndex = 0,
    rateLimiter = null,
    tempDir = null,
  }) {
    super();
    this.mpdUrl = mpdUrl;
    this.destPath = destPath;
    this.tempDir = tempDir || null;
    this.workPath = null;
    this.workDir = null;
    this.usingTemp = false;
    this.headers = headers;
    this.concurrency = concurrency;
    this.ffmpegPath = ffmpegPath;
    this.retries = retries;
    this.keepSegments = keepSegments;
    this.variantIndex = variantIndex;
    this.rateLimiter = rateLimiter;

    this.paused = false;
    this.cancelled = false;
    this.segDir = null;
    this.jobs = []; // flat list of { url, dest }
    this.completed = 0;
    this.downloadedBytes = 0;
    this.speed = speedometer(3);
    this.startTime = null;
  }

  async start() {
    this.startTime = Date.now();
    fs.mkdirSync(path.dirname(this.destPath), { recursive: true });

    // Fragments and ffmpeg's output stay inside the workspace; the destination
    // only ever receives the finished, muxed file.
    const workspace = resolveWorkspace({ destPath: this.destPath, tempDir: this.tempDir });
    this.workPath = workspace.workPath;
    this.workDir = workspace.workDir;
    this.usingTemp = workspace.usingTemp;
    this.segDir = this.usingTemp ? path.join(this.workDir, 'dash_parts') : `${this.destPath}.dash_parts`;
    fs.mkdirSync(this.segDir, { recursive: true });

    const manifestText = await this._fetchText(this.mpdUrl);
    const parsed = parseMpd(manifestText, this.mpdUrl);
    const { video, audio } = selectTracks(parsed, this.variantIndex);

    if (!video) throw new Error('No video representation found in MPEG-DASH manifest');
    this.emit('variant-selected', {
      resolution: video.width && video.height ? `${video.width}x${video.height}` : null,
      bandwidth: video.bandwidth || null,
      hasAudio: Boolean(audio),
    });

    // Build the concrete track files + the flat download job list.
    this.videoTrackFile = null;
    this.audioTrackFile = null;
    this.jobs = [];

    this._planTrack(video, 'v');
    if (audio) this._planTrack(audio, 'a');

    if (!this.jobs.length) {
      throw new Error('No downloadable segments found in MPEG-DASH manifest');
    }

    this.emit('start', { segments: this.jobs.length });

    await this._downloadJobs();

    if (this.cancelled) {
      this.emit('cancelled');
      return;
    }
    if (this.paused) {
      this.emit('paused', this.getProgress());
      return;
    }

    // Concatenate each track's fragments into a single elementary file.
    this.emit('remuxing');
    const videoTrack = await this._assembleTrack('v');
    const audioTrack = audio ? await this._assembleTrack('a') : null;

    await this._remux(videoTrack, audioTrack);

    if (!this.keepSegments) this._cleanup();
    finalizeWorkspace({
      workPath: this.workPath,
      destPath: this.destPath,
      workDir: this.workDir,
      usingTemp: this.usingTemp,
    });
    this.emit('complete', { destPath: this.destPath });
  }

  pause() {
    this.paused = true;
  }

  cancel() {
    this.cancelled = true;
  }

  getProgress() {
    const total = this.jobs.length;
    const elapsed = (Date.now() - this.startTime) / 1000;
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

  // Register the init + media segments (or a single file) for one track as jobs,
  // and record the ordered part paths used later for concatenation.
  _planTrack(rep, prefix) {
    const parts = [];
    if (rep.isSingleFile) {
      const dest = path.join(this.segDir, `${prefix}_full.mp4`);
      this.jobs.push({ url: rep.url, dest });
      parts.push(dest);
    } else {
      if (rep.initUrl) {
        const dest = path.join(this.segDir, `${prefix}_init.m4s`);
        this.jobs.push({ url: rep.initUrl, dest });
        parts.push(dest);
      }
      rep.segments.forEach((seg, i) => {
        const dest = path.join(this.segDir, `${prefix}_${String(i).padStart(6, '0')}.m4s`);
        this.jobs.push({ url: seg.url, dest });
        parts.push(dest);
      });
    }
    if (prefix === 'v') this._videoParts = parts;
    else this._audioParts = parts;
  }

  async _downloadJobs() {
    let next = 0;
    const total = this.jobs.length;

    const worker = async () => {
      while (next < total && !this.cancelled && !this.paused) {
        const job = this.jobs[next++];
        if (fs.existsSync(job.dest)) {
          this.completed++;
          continue;
        }
        await this._downloadWithRetry(job);
        if (!this.cancelled && !this.paused) {
          this.completed++;
          this.emit('progress', this.getProgress());
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  async _downloadWithRetry(job) {
    let attempt = 0;
    while (!this.cancelled && !this.paused) {
      try {
        await streamToFile(job.url, job.dest, {
          headers: this.headers,
          rateLimiter: this.rateLimiter,
          onBytes: (len) => {
            this.downloadedBytes += len;
            this.speed(len);
          },
        });
        return;
      } catch (err) {
        attempt++;
        this.emit('segment-error', { url: job.url, attempt, error: err.message });
        if (attempt > this.retries) {
          this.cancelled = true;
          this.emit('error', new Error(`DASH segment failed after ${attempt} attempts: ${err.message}`));
          return;
        }
        await sleep(Math.min(500 * 2 ** attempt, 10000));
      }
    }
  }

  async _assembleTrack(prefix) {
    const parts = prefix === 'v' ? this._videoParts : this._audioParts;
    if (parts.length === 1 && parts[0].endsWith('_full.mp4')) {
      return parts[0]; // single-file track: already a complete file
    }
    const outPath = path.join(this.segDir, `${prefix}_track.mp4`);
    await concatFiles(parts, outPath);
    return outPath;
  }

  _fetchText(url) {
    return new Promise((resolve, reject) => {
      request(url, { method: 'GET', headers: this.headers })
        .then(({ res }) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`Failed to fetch MPD: HTTP ${res.statusCode}`));
            return;
          }
          let body = '';
          res.on('data', (d) => (body += d.toString()));
          res.on('end', () => resolve(body));
          res.on('error', reject);
        })
        .catch(reject);
    });
  }

  _remux(videoTrack, audioTrack) {
    return new Promise((resolve, reject) => {
      let args;
      if (audioTrack) {
        args = [
          '-y',
          '-i', videoTrack,
          '-i', audioTrack,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c', 'copy',
          this.workPath,
        ];
      } else {
        // Single track may itself carry both streams (single-file on-demand).
        args = ['-y', '-i', videoTrack, '-c', 'copy', this.workPath];
      }
      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          reject(new Error('FFmpeg was not found. Install FFmpeg and make sure it is available in your system PATH — it is required to mux DASH downloads.'));
        } else {
          reject(err);
        }
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1500)}`));
      });
    });
  }

  _cleanup() {
    // A failed temp-dir removal (locked file, permissions) shouldn't turn an
    // otherwise-successful download into a reported error — best-effort only.
    try {
      fs.rmSync(this.segDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[DashDownloadTask] Failed to clean up temp segments at ${this.segDir}:`, err.message);
    }
  }
}

// Stream-concatenate a list of files into one output (init + fragments).
function concatFiles(parts, outPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    out.on('error', reject);
    let i = 0;
    const next = () => {
      if (i >= parts.length) {
        out.end(resolve);
        return;
      }
      const rs = fs.createReadStream(parts[i++]);
      rs.on('error', reject);
      rs.on('end', next);
      rs.pipe(out, { end: false });
    };
    next();
  });
}

module.exports = { DashDownloadTask };
