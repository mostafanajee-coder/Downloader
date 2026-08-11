'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { request } = require('./httpUtils');
const { probe } = require('./probe');
const { planSegments } = require('./segments');
const { RateLimiter } = require('./rateLimiter');
const speedometer = require('speedometer');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFilename(suggested, probedFilename) {
  if (!suggested) return probedFilename || 'download.bin';
  const hasExt = Boolean(path.extname(suggested));
  if (hasExt) return suggested;
  const ext = path.extname(probedFilename || '');
  return ext ? `${suggested}${ext}` : suggested;
}

const MIN_SPLIT_SIZE = 1024 * 1024; // 1 MB minimum segment size to allow dynamic splitting

class DownloadTask extends EventEmitter {
  constructor({ url, destPath, destDir, connections = 8, headers = {}, retries = 5, suggestedFilename = null, speedLimit = 0, rateLimiter = null }) {
    super();
    if (!destPath && !destDir) {
      throw new Error('Either destPath or destDir must be provided');
    }
    this.url = url;
    this.destDir = destDir || null;
    this.destPath = destPath || null;
    this.connections = connections;
    this.headers = headers;
    this.retries = retries;
    this.suggestedFilename = suggestedFilename;
    this.speedLimit = speedLimit; // Bytes per second limit (0 = unlimited)
    // A shared RateLimiter (global cap) takes precedence; otherwise a numeric
    // speedLimit lazily builds a private limiter so this task is capped on its
    // own (used by the CLI). 0 / no limiter => unlimited.
    this.rateLimiter = rateLimiter || (speedLimit > 0 ? new RateLimiter(speedLimit) : null);
    this.metaPath = this.destPath ? `${this.destPath}.ddl.json` : null;

    this.paused = false;
    this.cancelled = false;
    this.finished = false;
    this.failed = false; // a segment exhausted its retries (distinct from a user cancel)
    this.error = null;

    this.segments = [];
    this.size = null;
    this.acceptRanges = false;
    this.finalUrl = url;
    this.filename = null;

    this.downloadedTotal = 0;
    this.startTime = null;
    this._progressTimer = null;
    this._activeWorkers = 0;
    this.speed = speedometer(3); // 3-second EWMA speed calculation
  }

  async start() {
    this.paused = false;
    this.cancelled = false;
    this.startTime = Date.now();

    let preProbedInfo = null;
    if (!this.destPath) {
      fs.mkdirSync(this.destDir, { recursive: true });
      preProbedInfo = await probe(this.url, this.headers);
      this.destPath = path.join(this.destDir, resolveFilename(this.suggestedFilename, preProbedInfo.filename));
      this.metaPath = `${this.destPath}.ddl.json`;
    }

    const dir = path.dirname(this.destPath);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.metaPath)) {
      this._loadMeta();
      this._reconcileWithDisk();
    } else {
      const info = preProbedInfo || (await probe(this.url, this.headers));
      this.size = info.size;
      this.finalUrl = info.finalUrl || this.url;
      this.acceptRanges = Boolean(info.acceptRanges && info.size != null);
      this.filename = resolveFilename(this.suggestedFilename, info.filename);

      if (this.acceptRanges) {
        this.segments = planSegments(this.size, this.connections);
      } else {
        this.segments = [{ index: 0, start: 0, end: this.size != null ? this.size - 1 : null, downloaded: 0 }];
      }
      this._saveMeta();
    }

    // Pre-allocate destination file if size is known and file doesn't exist or isn't pre-allocated yet
    this._preallocateFile();

    this.downloadedTotal = this.segments.reduce((sum, s) => sum + s.downloaded, 0);
    this.emit('start', {
      size: this.size,
      segments: this.segments.length,
      filename: this.filename,
      resumed: this.downloadedTotal > 0,
    });

    this._progressTimer = setInterval(() => {
      this._saveMeta();
      this.emit('progress', this.getProgress());
    }, 400);

    try {
      await this._runWorkers();
    } finally {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }

    if (this.failed) {
      // 'error' was already emitted by the failing segment. Keep the .ddl.json
      // meta (don't _cleanup) so the download can be resumed later, and stop
      // without emitting a spurious 'complete'/'cancelled'.
      this._saveMeta();
      return;
    }
    if (this.cancelled) {
      this.emit('cancelled');
      return;
    }
    if (this.paused) {
      this._saveMeta();
      this.emit('paused', this.getProgress());
      return;
    }

    this._cleanup();
    this.finished = true;
    this.emit('complete', { destPath: this.destPath, size: this.size });
  }

  pause() {
    this.paused = true;
  }

  cancel() {
    this.cancelled = true;
  }

  _preallocateFile() {
    try {
      const flags = fs.existsSync(this.destPath) ? 'r+' : 'w+';
      const fd = fs.openSync(this.destPath, flags);
      if (this.size != null) {
        fs.ftruncateSync(fd, this.size);
      }
      fs.closeSync(fd);
    } catch (err) {
      // Non-fatal, write streams will create or expand the file
    }
  }

  _loadMeta() {
    const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    this.url = meta.url;
    this.finalUrl = meta.finalUrl;
    this.size = meta.size;
    this.acceptRanges = meta.acceptRanges;
    this.filename = meta.filename;
    this.segments = meta.segments;
  }

  _reconcileWithDisk() {
    if (!fs.existsSync(this.destPath)) {
      for (const seg of this.segments) seg.downloaded = 0;
      return;
    }
    const fileSize = fs.statSync(this.destPath).size;
    for (const seg of this.segments) {
      if (!this.acceptRanges) {
        seg.downloaded = 0;
      } else {
        const segEnd = seg.end != null ? seg.end : fileSize;
        const availableInSeg = Math.max(0, Math.min(seg.downloaded, fileSize - seg.start));
        seg.downloaded = availableInSeg;
      }
    }
  }

  _saveMeta() {
    try {
      const meta = {
        url: this.url,
        finalUrl: this.finalUrl,
        size: this.size,
        acceptRanges: this.acceptRanges,
        filename: this.filename,
        segments: this.segments,
      };
      fs.writeFileSync(this.metaPath, JSON.stringify(meta));
    } catch {}
  }

  getProgress() {
    const speed = this.speed();
    const remaining = this.size != null ? this.size - this.downloadedTotal : null;
    const eta = remaining != null && speed > 0 ? remaining / speed : null;
    return {
      downloaded: this.downloadedTotal,
      size: this.size,
      percent: this.size ? (this.downloadedTotal / this.size) * 100 : null,
      speedBytesPerSec: speed,
      eta, // seconds remaining (null when unknown)
      connections: this.connections,
      segments: this.segments.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        downloaded: s.downloaded,
        total: s.end != null ? s.end - s.start + 1 : null,
        active: Boolean(s.active),
      })),
    };
  }

  /**
   * Worker pool loop supporting IDM-style Dynamic Segment Splitting
   */
  async _runWorkers() {
    const maxWorkers = this.acceptRanges ? this.connections : 1;
    const workerPromises = [];
    for (let i = 0; i < maxWorkers; i++) {
      workerPromises.push(this._workerLoop(i));
    }
    await Promise.all(workerPromises);
  }

  async _workerLoop(workerId) {
    while (!this.cancelled && !this.paused && !this.failed) {
      let targetSeg = this._getNextUnfinishedSegment();

      // Dynamic Chunking: If no unassigned segment, attempt to split the largest active segment
      if (!targetSeg && this.acceptRanges) {
        targetSeg = this._splitLargestActiveSegment();
      }

      if (!targetSeg) {
        // No work available
        break;
      }

      targetSeg.active = true;
      try {
        await this._downloadSegmentWithRetry(targetSeg);
      } finally {
        targetSeg.active = false;
      }
    }
  }

  _getNextUnfinishedSegment() {
    return this.segments.find((s) => !s.active && (s.end == null || s.downloaded < s.end - s.start + 1));
  }

  /**
   * Dynamic Chunking: Splits an active, slow or large running segment into two
   */
  _splitLargestActiveSegment() {
    let candidate = null;
    let maxRemaining = MIN_SPLIT_SIZE;

    for (const seg of this.segments) {
      if (seg.end == null) continue;
      const totalLen = seg.end - seg.start + 1;
      const remaining = totalLen - seg.downloaded;
      if (remaining > maxRemaining) {
        maxRemaining = remaining;
        candidate = seg;
      }
    }

    if (!candidate) return null;

    // Split remaining bytes into half
    const currentAbsolutePos = candidate.start + candidate.downloaded;
    const remainingBytes = candidate.end - currentAbsolutePos + 1;
    const half = Math.floor(remainingBytes / 2);

    if (half < MIN_SPLIT_SIZE / 2) return null;

    const oldEnd = candidate.end;
    const splitPoint = currentAbsolutePos + half;

    // Resize candidate's end point
    candidate.end = splitPoint - 1;

    // Create new segment for second half
    const newSeg = {
      index: this.segments.length,
      start: splitPoint,
      end: oldEnd,
      downloaded: 0,
      active: false,
    };

    this.segments.push(newSeg);
    this.emit('segment-split', { parentIndex: candidate.index, newIndex: newSeg.index, splitPoint });
    return newSeg;
  }

  async _downloadSegmentWithRetry(seg) {
    let attempt = 0;
    while (!this.cancelled && !this.paused && !this.failed) {
      try {
        await this._streamSegment(seg);
        return;
      } catch (err) {
        attempt++;
        this.emit('segment-error', { index: seg.index, attempt, error: err.message });
        if (attempt > this.retries) {
          // Mark the whole task as failed (NOT cancelled) so the other workers
          // wind down. Guard the emit so that if several segments give up at
          // once we still surface exactly one 'error' — a second emit with no
          // listener left would otherwise throw from the EventEmitter.
          if (!this.failed) {
            this.failed = true;
            this.error = new Error(`Segment ${seg.index} failed after ${attempt} attempts: ${err.message}`);
            this.emit('error', this.error);
          }
          return;
        }
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
  }

  _streamSegment(seg) {
    return new Promise((resolve, reject) => {
      const currentStart = seg.start + seg.downloaded;
      if (seg.end != null && currentStart > seg.end) {
        resolve();
        return;
      }

      const headers = { ...this.headers };
      if (this.acceptRanges) {
        const end = seg.end != null ? seg.end : '';
        headers.Range = `bytes=${currentStart}-${end}`;
      }

      request(this.finalUrl || this.url, { method: 'GET', headers })
        .then(({ res }) => {
          const expectedStatus = this.acceptRanges ? [200, 206] : [200];
          if (!expectedStatus.includes(res.statusCode)) {
            res.resume();
            reject(new Error(`Unexpected status ${res.statusCode}`));
            return;
          }

          // Write directly at the segment's absolute offset in the final file.
          // NOTE: writing is fully manual here (no res.pipe) so we have exact
          // control over which bytes land on disk. Mixing pipe() with a manual
          // ws.write() in the boundary case would write the same chunk twice.
          const ws = fs.createWriteStream(this.destPath, {
            flags: 'r+',
            start: currentStart,
          });

          // Bytes optimistically added to the live counters (seg.downloaded /
          // downloadedTotal) for responsive progress. On a hard failure we roll
          // back whatever the write stream never actually flushed, so a retry
          // resumes from the true on-disk offset instead of leaving a gap.
          const base = seg.downloaded;
          let settled = false;

          const rollbackUnflushed = () => {
            const applied = seg.downloaded - base;
            const unflushed = applied - ws.bytesWritten;
            if (unflushed > 0) {
              seg.downloaded -= unflushed;
              this.downloadedTotal -= unflushed;
            }
          };

          const fail = (err) => {
            if (settled) return;
            settled = true;
            res.destroy();
            rollbackUnflushed();
            ws.destroy();
            reject(err);
          };

          // Flush buffered writes, then resolve. ws.end() guarantees every
          // prior ws.write() has hit the fd before the callback fires.
          const succeed = () => {
            if (settled) return;
            settled = true;
            res.destroy();
            ws.end(() => resolve());
          };

          res.on('error', fail);
          ws.on('error', fail);

          // Handle one chunk at a time: park the socket, write it (respecting
          // both backpressure and the shared speed limit), then resume. Pausing
          // per chunk is what lets _throttle pace the aggregate download rate
          // without letting unbounded data buffer in memory meanwhile.
          res.on('data', (chunk) => {
            if (settled) return;
            res.pause();
            this._consumeChunk(chunk, seg, ws)
              .then((reachedEnd) => {
                if (settled) return;
                if (reachedEnd || this.paused || this.cancelled || this.failed) succeed();
                else res.resume();
              })
              .catch(fail);
          });

          // Server closed the response normally (all requested bytes received).
          res.on('end', succeed);
        })
        .catch(reject);
    });
  }

  /**
   * Write a single response chunk to the destination at the segment's current
   * offset, updating progress counters, honouring backpressure, and pacing to
   * the speed limit. Returns true when this chunk reaches the segment's end
   * (e.g. after a dynamic split pulled the boundary in).
   */
  async _consumeChunk(chunk, seg, ws) {
    let data = chunk;
    let reachedEnd = false;
    if (seg.end != null) {
      const remaining = seg.end + 1 - (seg.start + seg.downloaded);
      if (remaining <= 0) return true;
      if (chunk.length >= remaining) {
        data = chunk.slice(0, remaining);
        reachedEnd = true;
      }
    }

    if (data && data.length) {
      seg.downloaded += data.length;
      this.downloadedTotal += data.length;
      this.speed(data.length);
      if (ws.write(data) === false) {
        await new Promise((resolve) => ws.once('drain', resolve));
      }
      await this._throttle(data.length);
    }

    return reachedEnd;
  }

  /**
   * Pace this task to the configured speed limit. Delegates to the shared
   * RateLimiter, which enforces the cap as an AGGREGATE across every concurrent
   * segment worker of this task AND — when the limiter instance is shared by the
   * Manager — across every active download at once (the global Speed Limiter).
   */
  async _throttle(bytes) {
    if (this.rateLimiter) await this.rateLimiter.consume(bytes);
  }

  _cleanup() {
    try {
      if (fs.existsSync(this.metaPath)) {
        fs.unlinkSync(this.metaPath);
      }
    } catch {}
  }
}

module.exports = { DownloadTask };
