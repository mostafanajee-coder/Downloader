'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { request } = require('./httpUtils');
const { streamToFile } = require('./streamFile');
const { resolveWorkspace, finalizeWorkspace } = require('./workspace');
const { parseMpd, selectTracksPerPeriod } = require('./dash');
const { scopeHeaders } = require('./headerScope');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

function runFfmpeg(ffmpegPath, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { cwd, windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
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

/**
 * Downloads an MPEG-DASH (.mpd) stream. Parses the manifest via core/dash.js
 * (SegmentTemplate / SegmentTimeline / SegmentList / single-file), downloads the
 * chosen video representation and best audio representation as separate tracks,
 * concatenates each track's init + media fragments, then muxes them into one
 * file with ffmpeg (-c copy, no re-encode).
 *
 * A multi-period presentation is handled period by period — each has its own
 * init segments, so its fragments can only be joined to its own — and the
 * muxed periods are then concatenated in order.
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
    this.failed = false;
    this.segDir = null;
    this.jobs = []; // flat list of { url, dest }
    this.tracks = []; // [{ period, videoParts, audioParts }]
    this.completed = 0;
    this.downloadedBytes = 0;
    this.bytesCompleted = 0;
    this.speed = speedometer(3);
    this.startTime = null;
  }

  _headersFor(url) {
    return scopeHeaders(this.mpdUrl, url, this.headers);
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

    const manifest = await this._fetchText(this.mpdUrl);
    // Relative BaseURLs/templates resolve against where the manifest actually
    // came from — after redirects — not the address we first asked for.
    const parsed = parseMpd(manifest.text, manifest.finalUrl || this.mpdUrl);
    if (parsed.drm) {
      throw new Error(`This stream is DRM-protected (${parsed.drm}) and cannot be downloaded.`);
    }
    if (parsed.live) {
      throw new Error('This is a live MPEG-DASH presentation (type="dynamic"); live recording is not supported.');
    }

    const selections = selectTracksPerPeriod(parsed, this.variantIndex).filter((s) => s.video);
    const first = selections[0];
    if (!first) throw new Error('No video representation found in MPEG-DASH manifest');
    this.emit('variant-selected', {
      resolution: first.video.width && first.video.height ? `${first.video.width}x${first.video.height}` : null,
      bandwidth: first.video.bandwidth || null,
      hasAudio: Boolean(first.audio),
      periods: selections.length,
    });

    // Build the concrete track files + the flat download job list. Period 0
    // keeps the historical v_/a_ names so an in-progress download from an
    // older build resumes instead of starting over.
    this.jobs = [];
    this.tracks = selections.map((sel, i) => {
      const tag = i === 0 ? '' : `p${i}`;
      return {
        period: i,
        videoParts: this._planTrack(sel.video, `${tag}v`),
        audioParts: sel.audio ? this._planTrack(sel.audio, `${tag}a`) : null,
      };
    });
    // Back-compat for callers that read these directly.
    this._videoParts = this.tracks[0].videoParts;
    this._audioParts = this.tracks[0].audioParts || [];

    if (!this.jobs.length) {
      throw new Error('No downloadable segments found in MPEG-DASH manifest');
    }

    this.emit('start', { segments: this.jobs.length });

    await this._downloadJobs();

    // 'error' has already been emitted by whichever job gave up.
    if (this.failed) return;
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
    if (this.tracks.length === 1) {
      const videoTrack = await this._assembleTrack(this.tracks[0].videoParts, 'v');
      const audioTrack = this.tracks[0].audioParts ? await this._assembleTrack(this.tracks[0].audioParts, 'a') : null;
      await this._remux(videoTrack, audioTrack, this.workPath);
    } else {
      const outputs = [];
      for (const t of this.tracks) {
        const tag = t.period === 0 ? '' : `p${t.period}`;
        const videoTrack = await this._assembleTrack(t.videoParts, `${tag}v`);
        const audioTrack = t.audioParts ? await this._assembleTrack(t.audioParts, `${tag}a`) : null;
        const out = path.join(this.segDir, `period_${String(t.period).padStart(3, '0')}.mp4`);
        await this._remux(videoTrack, audioTrack, out);
        outputs.push(out);
      }
      await this._concatPeriods(outputs, this.workPath);
    }

    if (!this.keepSegments) this._cleanup();
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
    const total = this.jobs.length;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const segmentsPerSec = elapsed > 0 ? this.completed / elapsed : 0;
    const eta = segmentsPerSec > 0 && total > 0 ? (total - this.completed) / segmentsPerSec : null;
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

  // Register the init + media segments (or a single file) for one track as
  // jobs, returning the ordered part paths used later for concatenation.
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
    return parts;
  }

  async _downloadJobs() {
    let next = 0;
    const total = this.jobs.length;

    const worker = async () => {
      while (next < total && !this.cancelled && !this.paused && !this.failed) {
        const job = this.jobs[next++];
        if (fs.existsSync(job.dest)) {
          this.completed++;
          this.bytesCompleted += fileSize(job.dest);
          continue;
        }
        const ok = await this._downloadWithRetry(job);
        if (ok) {
          this.completed++;
          this.bytesCompleted += fileSize(job.dest);
          this.emit('progress', this.getProgress());
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  async _downloadWithRetry(job) {
    let attempt = 0;
    while (!this.cancelled && !this.paused && !this.failed) {
      try {
        await streamToFile(job.url, job.dest, {
          headers: this._headersFor(job.url),
          rateLimiter: this.rateLimiter,
          onBytes: (len) => {
            this.downloadedBytes += len;
            this.speed(len);
          },
        });
        return true;
      } catch (err) {
        attempt++;
        this.emit('segment-error', { url: job.url, attempt, error: err.message });
        if (err.retryable === false || attempt > this.retries) {
          if (!this.failed) {
            this.failed = true;
            this.emit('error', new Error(`DASH segment failed after ${attempt} attempt(s): ${err.message}`));
          }
          return false;
        }
        await sleep(Math.min(500 * 2 ** attempt, 10000));
      }
    }
    return false;
  }

  async _assembleTrack(parts, prefix) {
    if (parts.length === 1 && parts[0].endsWith('_full.mp4')) {
      return parts[0]; // single-file track: already a complete file
    }
    const outPath = path.join(this.segDir, `${prefix}_track.mp4`);
    await concatFiles(parts, outPath);
    return outPath;
  }

  _fetchText(url) {
    return new Promise((resolve, reject) => {
      request(url, { method: 'GET', headers: this.headers, totalTimeoutMs: 60000 })
        .then(({ res, finalUrl }) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new Error(`Failed to fetch MPD: HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          // Decode once at the end: appending per chunk split multi-byte
          // UTF-8 characters that straddled a chunk boundary.
          res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), finalUrl }));
          res.on('error', reject);
        })
        .catch(reject);
    });
  }

  _remux(videoTrack, audioTrack, outPath = this.workPath) {
    let args;
    if (audioTrack) {
      args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', videoTrack,
        '-i', audioTrack,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        outPath,
      ];
    } else {
      // Single track may itself carry both streams (single-file on-demand).
      args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoTrack, '-c', 'copy', outPath];
    }
    return runFfmpeg(this.ffmpegPath, args);
  }

  /** Join the per-period files end to end with ffmpeg's concat demuxer (no re-encode). */
  _concatPeriods(files, outPath) {
    const listPath = path.join(this.segDir, 'periods.txt');
    // The concat list's own quoting: single quotes, with ' escaped as '\''.
    const body = files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, `${body}\n`);
    return runFfmpeg(this.ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outPath,
    ]);
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
