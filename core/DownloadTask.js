'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { request, responseEncoding, createDecoder } = require('./httpUtils');
const { probe } = require('./probe');
const { planSegments } = require('./segments');
const { RateLimiter } = require('./rateLimiter');
const { resolveWorkspace, finalizeWorkspace } = require('./workspace');
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
  constructor({ url, destPath, destDir, connections = 8, headers = {}, retries = 5, suggestedFilename = null, speedLimit = 0, rateLimiter = null, tempDir = null }) {
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

    // Where the bytes actually land while the download runs. Resolved in
    // start(), once destPath is known — everything on disk (segments,
    // preallocation, the .ddl.json sidecar) lives at workPath, and destPath
    // only receives a file once the download is verified complete.
    this.tempDir = tempDir || null;
    this.workPath = null;
    this.workDir = null;
    this.usingTemp = false;
    this.metaPath = null;

    this.paused = false;
    this.cancelled = false;
    this.finished = false;
    this.failed = false; // a segment exhausted its retries (distinct from a user cancel)
    this.error = null;

    this.segments = [];
    this.size = null;
    this.acceptRanges = false;
    this.contentEncoding = null; // non-null only if the origin compressed anyway
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
    }

    // The destination folder is created up front even though nothing is written
    // there until the very end: failing now, with an obvious error, beats
    // downloading a 4 GB file and only then discovering the target is gone.
    fs.mkdirSync(path.dirname(this.destPath), { recursive: true });

    const workspace = resolveWorkspace({ destPath: this.destPath, tempDir: this.tempDir });
    this.workPath = workspace.workPath;
    this.workDir = workspace.workDir;
    this.usingTemp = workspace.usingTemp;
    this.metaPath = `${this.workPath}.ddl.json`;

    // A sidecar that can't be read is treated as absent rather than fatal — a
    // half-written .ddl.json used to throw straight out of start() and wedge an
    // otherwise perfectly resumable download for good.
    const resumed = fs.existsSync(this.metaPath) && this._loadMeta();
    if (resumed) {
      this._reconcileWithDisk();
    } else {
      const info = preProbedInfo || (await probe(this.url, this.headers));
      this.size = info.size;
      this.finalUrl = info.finalUrl || this.url;
      this.acceptRanges = Boolean(info.acceptRanges && info.size != null);
      this.contentEncoding = info.contentEncoding || null;
      this.filename = resolveFilename(this.suggestedFilename, info.filename);

      if (this.acceptRanges) {
        this.segments = planSegments(this.size, this.connections);
      } else {
        this.segments = [
          { index: 0, start: 0, end: this.size != null ? this.size - 1 : null, downloaded: 0, done: false },
        ];
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
      this._flushToDisk();
      this._saveMeta();
      return;
    }
    if (this.cancelled) {
      this.emit('cancelled');
      return;
    }
    if (this.paused) {
      this._flushToDisk();
      this._saveMeta();
      this.emit('paused', this.getProgress());
      return;
    }

    // A stream with no advertised length only reveals its size by ending.
    if (this.size == null) this.size = this.downloadedTotal;

    const problem = this._verifyCompletion();
    if (problem) {
      // Note this deliberately does NOT _cleanup(): keeping the sidecar is what
      // leaves the download resumable instead of stranding the user with a file
      // the app swore was finished.
      this.failed = true;
      this.error = new Error(problem);
      this._flushToDisk();
      this._saveMeta();
      this.emit('error', this.error);
      return;
    }

    // Verified complete — only now does anything appear at the destination.
    // Publishing before this point is what put half-written files in the user's
    // Video folder for Windows Search and Plex to pick up.
    try {
      finalizeWorkspace({
        workPath: this.workPath,
        destPath: this.destPath,
        workDir: this.workDir,
        usingTemp: this.usingTemp,
      });
    } catch (err) {
      // The bytes are all present and correct, they just couldn't be moved
      // (destination full, permissions, a lock). Keep the assembled file and
      // its sidecar so a retry publishes rather than re-downloads.
      this.failed = true;
      this.error = new Error(`Download finished but could not be moved to ${this.destPath}: ${err.message}`);
      this._saveMeta();
      this.emit('error', this.error);
      return;
    }

    this._cleanup();
    this.finished = true;
    this.emit('complete', { destPath: this.destPath, size: this.size });
  }

  /**
   * The last line of defence before a download is declared finished.
   *
   * Every silent corruption this engine produced looked like a success at
   * exactly this point, so nothing here is taken on trust: the individual
   * segments, the running byte counter, and the actual file on disk all have to
   * agree before 'complete' is emitted. Returns a human-readable reason, or
   * null when the file genuinely checks out.
   */
  _verifyCompletion() {
    for (const seg of this.segments) {
      if (!this._isSegmentComplete(seg)) {
        const expected = seg.end != null ? seg.end - seg.start + 1 : 'an unknown number of';
        return `Incomplete transfer: segment ${seg.index} stopped at ${seg.downloaded} of ${expected} bytes.`;
      }
    }

    if (this.size != null && this.downloadedTotal !== this.size) {
      return `Size mismatch: received ${this.downloadedTotal} bytes but the server declared ${this.size}.`;
    }

    if (this.size != null) {
      let onDisk;
      try {
        onDisk = fs.statSync(this.workPath).size;
      } catch {
        return 'The destination file disappeared before the download finished.';
      }
      if (onDisk !== this.size) {
        return `File on disk is ${onDisk} bytes but the download expected ${this.size}.`;
      }
    }

    return null;
  }

  /**
   * fsync the destination so the bytes the metadata is about to claim are
   * really on the platter rather than sitting in the OS page cache. Called only
   * when settling (pause, failure, or a failed completion check), so it costs
   * one sync per stop instead of one per chunk.
   */
  _flushToDisk() {
    try {
      const fd = fs.openSync(this.workPath, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Nothing actionable. The metadata is conservative either way, so a
      // resume simply re-fetches anything that never made it out.
    }
  }

  pause() {
    this.paused = true;
  }

  cancel() {
    this.cancelled = true;
  }

  _preallocateFile() {
    try {
      const flags = fs.existsSync(this.workPath) ? 'r+' : 'w+';
      const fd = fs.openSync(this.workPath, flags);
      try {
        if (this.size != null) {
          fs.ftruncateSync(fd, this.size);
        } else {
          // Unknown length means this run restarts from byte zero (see
          // _reconcileWithDisk), so discard whatever a previous attempt left
          // behind. Without this, a second attempt that returns fewer bytes
          // than the first would leave the old tail in place and quietly
          // produce a corrupt file.
          fs.ftruncateSync(fd, 0);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      // Non-fatal, write streams will create or expand the file
    }
  }

  /**
   * Load the .ddl.json sidecar. Returns false when it is missing, unparseable,
   * or structurally wrong, so start() can fall back to a clean probe instead of
   * the whole download dying on a JSON syntax error.
   */
  _loadMeta() {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch {
      return false;
    }
    if (!meta || !Array.isArray(meta.segments) || meta.segments.length === 0) return false;

    this.url = meta.url || this.url;
    this.finalUrl = meta.finalUrl || this.url;
    this.size = meta.size == null ? null : meta.size;
    this.acceptRanges = Boolean(meta.acceptRanges);
    this.contentEncoding = meta.contentEncoding || null;
    this.filename = meta.filename || this.filename;
    this.segments = meta.segments.map((s) => ({
      index: s.index,
      start: s.start,
      end: s.end == null ? null : s.end,
      downloaded: Number(s.downloaded) || 0,
      done: Boolean(s.done),
      // `active` is rebuilt as false, never restored. It describes a worker
      // that stopped existing when the previous run ended — persisting it made
      // every segment look claimed on resume, so the worker pool found no work
      // at all and a partial file sailed straight through to 'complete'.
      active: false,
    }));
    return true;
  }

  _reconcileWithDisk() {
    if (!fs.existsSync(this.workPath)) {
      for (const seg of this.segments) {
        seg.downloaded = 0;
        seg.done = false;
      }
      return;
    }
    const fileSize = fs.statSync(this.workPath).size;
    for (const seg of this.segments) {
      if (!this.acceptRanges) {
        // Without range support there is nothing to resume from — the transfer
        // has to restart at byte zero, so any recorded progress is void.
        seg.downloaded = 0;
        seg.done = false;
        continue;
      }
      // The file is preallocated to its full length, so its size cannot prove
      // WHICH ranges hold real data; the sidecar is the authority there, and
      // _saveMeta only ever records bytes the OS has accepted. What the file
      // size can still prove is a shortfall: if the file was truncated,
      // replaced, or never fully preallocated, anything past its end is gone.
      const available = Math.max(0, fileSize - seg.start);
      if (seg.downloaded > available) {
        seg.downloaded = available;
        seg.done = false;
      }
    }
  }

  /**
   * Bytes this segment is known to have handed to the file descriptor.
   *
   * While a write stream is live, seg.downloaded runs ahead of the disk — it is
   * bumped the moment a chunk arrives, so progress stays responsive. Persisting
   * that optimistic figure is precisely how a crash left metadata claiming
   * bytes that were never written, which a later resume then skipped over,
   * producing a zero-filled hole in a file reported as complete.
   */
  _flushedBytes(seg) {
    if (!seg._writer) return seg.downloaded;
    return Math.min(seg.downloaded, seg._writer.base + seg._writer.ws.bytesWritten);
  }

  _saveMeta() {
    try {
      const meta = {
        url: this.url,
        finalUrl: this.finalUrl,
        size: this.size,
        acceptRanges: this.acceptRanges,
        contentEncoding: this.contentEncoding || null,
        filename: this.filename,
        // Rebuilt field by field rather than serialising this.segments wholesale:
        // those carry a live `_writer` (a stream, unserialisable) and the
        // transient `active` flag that must never be persisted.
        segments: this.segments.map((s) => ({
          index: s.index,
          start: s.start,
          end: s.end,
          downloaded: this._flushedBytes(s),
          done: Boolean(s.done),
        })),
      };
      // Write-then-rename. A crash midway through a direct write would leave
      // truncated JSON that no future run could parse, permanently wedging a
      // download that was otherwise fine.
      const tmpPath = `${this.metaPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(meta));
      fs.renameSync(tmpPath, this.metaPath);
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

      const downloadedBefore = targetSeg.downloaded;
      targetSeg.active = true;
      try {
        await this._downloadSegmentWithRetry(targetSeg);
      } finally {
        targetSeg.active = false;
      }

      // Belt and braces against the runaway-loop class of bug: if a segment
      // returns reporting success, has not advanced a single byte, and still
      // is not complete, handing it back to the pool can only repeat that
      // forever. Stop and surface it rather than hammering the server.
      if (
        !this.cancelled &&
        !this.paused &&
        !this.failed &&
        targetSeg.downloaded === downloadedBefore &&
        !this._isSegmentComplete(targetSeg)
      ) {
        this.failed = true;
        this.error = new Error(
          `Segment ${targetSeg.index} made no progress and never signalled completion — aborting to avoid an endless retry loop.`
        );
        this.emit('error', this.error);
        return;
      }
    }
  }

  /**
   * A segment with a known end is complete once its byte count reaches that
   * end. An open-ended one — the server sent no Content-Length — has no byte
   * target at all, so its ONLY completion signal is the response ending, which
   * _streamSegment records as `done`.
   *
   * Treating "no end" as "not yet finished" is what made unknown-length
   * downloads re-fetch the same body forever: a 64 KB response turned into
   * 2,209 requests and a 144 MB file in two and a half seconds.
   */
  _isSegmentComplete(seg) {
    if (seg.done) return true;
    if (seg.end == null) return false;
    return seg.downloaded >= seg.end - seg.start + 1;
  }

  _getNextUnfinishedSegment() {
    return this.segments.find((s) => !s.active && !this._isSegmentComplete(s));
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

        // Without range support a partial attempt cannot be continued: the
        // retry replays the body from byte zero, so keeping the old offset
        // splices the START of a fresh response onto the MIDDLE of the file.
        // That produced a file of exactly the right length, made of the first
        // half twice — byte counts all agreed, so no completion check could
        // ever have caught it. Start the segment over instead.
        if (!this.acceptRanges && seg.downloaded > 0) {
          this.downloadedTotal -= seg.downloaded;
          seg.downloaded = 0;
          seg.done = false;
        }

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

      request(this.finalUrl || this.url, { method: 'GET', headers, raw: true })
        .then(({ res }) => {
          const expectedStatus = this.acceptRanges ? [200, 206] : [200];
          if (!expectedStatus.includes(res.statusCode)) {
            res.resume();
            reject(new Error(`Unexpected status ${res.statusCode}`));
            return;
          }

          // We asked for `identity`, but a server is free to ignore that.
          // Compressed bytes must be inflated before they reach the disk or the
          // file is simply the wrong file. On a ranged request there is no way
          // to reconcile it at all — the offsets we computed address compressed
          // positions — so that combination is refused outright rather than
          // written out as plausible-looking garbage.
          const encoding = responseEncoding(res);
          let src = res;
          let decoder = null;
          if (encoding) {
            if (this.acceptRanges) {
              res.resume();
              reject(
                new Error(
                  `Server returned a ${encoding}-compressed body for a range request, which cannot be written byte-exactly.`
                )
              );
              return;
            }
            decoder = createDecoder(encoding);
            if (!decoder) {
              res.resume();
              reject(new Error(`Unsupported Content-Encoding "${encoding}".`));
              return;
            }
            src = res.pipe(decoder);
          }

          // Write directly at the segment's absolute offset in the final file.
          // NOTE: writing is fully manual here (no res.pipe) so we have exact
          // control over which bytes land on disk. Mixing pipe() with a manual
          // ws.write() in the boundary case would write the same chunk twice.
          const ws = fs.createWriteStream(this.workPath, {
            flags: 'r+',
            start: currentStart,
          });

          // Bytes optimistically added to the live counters (seg.downloaded /
          // downloadedTotal) for responsive progress. On a hard failure we roll
          // back whatever the write stream never actually flushed, so a retry
          // resumes from the true on-disk offset instead of leaving a gap.
          const base = seg.downloaded;
          let settled = false;

          // Lets _saveMeta persist only the bytes the OS has actually accepted
          // for this segment, rather than the optimistic in-memory counter.
          seg._writer = { base, ws };

          const rollbackUnflushed = () => {
            const applied = seg.downloaded - base;
            const unflushed = applied - ws.bytesWritten;
            if (unflushed > 0) {
              seg.downloaded -= unflushed;
              this.downloadedTotal -= unflushed;
            }
          };

          const closeSource = () => {
            if (decoder) decoder.destroy();
            res.destroy();
          };

          const fail = (err) => {
            if (settled) return;
            settled = true;
            closeSource();
            rollbackUnflushed();
            seg._writer = null;
            ws.destroy();
            reject(err);
          };

          // Flush buffered writes, then resolve. ws.end() guarantees every
          // prior ws.write() has hit the fd before the callback fires — which
          // is also the point at which _flushedBytes can stop consulting the
          // stream, so the writer handle is only cleared in there.
          const succeed = () => {
            if (settled) return;
            settled = true;
            closeSource();
            ws.end(() => {
              seg._writer = null;
              resolve();
            });
          };

          res.on('error', fail);
          if (decoder) decoder.on('error', fail);
          ws.on('error', fail);

          // Handle one chunk at a time: park the socket, write it (respecting
          // both backpressure and the shared speed limit), then resume. Pausing
          // per chunk is what lets _throttle pace the aggregate download rate
          // without letting unbounded data buffer in memory meanwhile.
          src.on('data', (chunk) => {
            if (settled) return;
            src.pause();
            this._consumeChunk(chunk, seg, ws)
              .then((reachedEnd) => {
                if (settled) return;
                if (reachedEnd || this.paused || this.cancelled || this.failed) succeed();
                else src.resume();
              })
              .catch(fail);
          });

          // Server closed the response normally (all requested bytes received).
          src.on('end', () => {
            const stillRunning = !this.paused && !this.cancelled && !this.failed;
            if (seg.end == null) {
              // An open-ended segment has no byte target, so the body ending IS
              // its completion signal. Recording it is what stops the worker
              // pool handing the same segment straight back and downloading the
              // whole body again, forever.
              if (stillRunning) seg.done = true;
            } else if (!this.acceptRanges && stillRunning && seg.downloaded < seg.end - seg.start + 1) {
              // The body ended short of its declared length and there is no
              // range support to resume from. Continuing at the current offset
              // would splice the START of a fresh response onto the MIDDLE of
              // the file, so the only correct recovery is to begin again.
              this.downloadedTotal -= seg.downloaded;
              seg.downloaded = 0;
            }
            succeed();
          });
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
    for (const p of [this.metaPath, `${this.metaPath}.tmp`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
  }
}

module.exports = { DownloadTask };
