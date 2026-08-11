'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { DownloadTask } = require('./DownloadTask');
const { HlsDownloadTask } = require('./hlsDownloadTask');
const { DashDownloadTask } = require('./dashDownloadTask');
const { expandBatchUrl } = require('./BatchDownloader');
const { sanitizeFilename } = require('./filename');
const { getCategoryForUrl } = require('./categories');
const { RateLimiter } = require('./rateLimiter');

const MAX_CONCURRENT_DOWNLOADS = 4;

/**
 * Orchestrates a queue of downloads (plain files, HLS streams, DASH streams),
 * retains persistent download history across app restarts, supports batch URL expansion,
 * and enforces a cap on how many downloads run at once.
 */
class Manager extends EventEmitter {
  constructor({ stateDir, config, maxConcurrentDownloads = MAX_CONCURRENT_DOWNLOADS }) {
    super();
    this.stateDir = stateDir;
    this.config = config;
    this.maxConcurrentDownloads = maxConcurrentDownloads;
    this.dbPath = path.join(stateDir, 'queue.db');
    
    // SQLite setup
    fs.mkdirSync(stateDir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        kind TEXT,
        url TEXT,
        destPath TEXT,
        destDir TEXT,
        headers TEXT,
        connections INTEGER,
        variantIndex INTEGER,
        status TEXT,
        filename TEXT,
        error TEXT,
        addedAt INTEGER,
        progress TEXT
      )
    `);

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO downloads (id, kind, url, destPath, destDir, headers, connections, variantIndex, status, filename, error, addedAt, progress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteStmt = this.db.prepare(`DELETE FROM downloads WHERE id = ?`);

    this.items = new Map(); // id -> { id, kind, url, destPath, status, task, error, addedAt, ... }
    this.runningCount = 0;

    // Single shared limiter = the GLOBAL speed cap across every active download.
    // Its rate tracks config.speedLimitKBps and is applied to every task.
    this.rateLimiter = new RateLimiter(this._speedLimitBytes());

    this._loadState();
  }

  // Push the current configured global speed limit into the shared limiter.
  // Call after the UI changes speedLimitKBps so running downloads adjust live.
  updateSpeedLimit() {
    this.rateLimiter.setRate(this._speedLimitBytes());
  }

  _isExcluded(urlStr) {
    if (!this.config) return false;
    const excludedStr = this.config.get('excludedSites') || '';
    if (!excludedStr.trim()) return false;
    
    let hostname;
    try { hostname = new URL(urlStr).hostname; } catch { return false; }
    
    const patterns = excludedStr.split(/\s+/).filter(Boolean);
    for (const pattern of patterns) {
      const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
      const regex = new RegExp(regexStr, 'i');
      if (regex.test(hostname)) return true;
    }
    return false;
  }

  // Per-download speed cap in bytes/sec, read live from config (0 = unlimited).
  // The UI stores it as KB/s under `speedLimitKBps`; each new download picks up
  // the current value at start time.
  _speedLimitBytes() {
    if (!this.config) return 0;
    const kbps = Number(this.config.get('speedLimitKBps')) || 0;
    return kbps > 0 ? kbps * 1024 : 0;
  }

  add({ url, kind = 'file', destPath, destDir, headers = {}, connections = 16, variantIndex = 0, suggestedFilename, startNow = true, padWidth }) {
    const urls = expandBatchUrl(url, { padWidth });
    const addedIds = [];

    for (const singleUrl of urls) {
      if (this._isExcluded(singleUrl)) continue;

      const id = crypto.randomUUID();
      const category = getCategoryForUrl(singleUrl, kind, suggestedFilename);
      const destDirs = this.config ? this.config.get('destDirs') : {};
      const finalDestDir = destDir || destDirs[category] || destDirs['General'] || process.cwd();
      if (!fs.existsSync(finalDestDir)) {
        fs.mkdirSync(finalDestDir, { recursive: true });
      }

      const item = {
        id,
        kind, // 'file' | 'hls' | 'dash'
        url: singleUrl,
        destPath: destPath || null,
        destDir: finalDestDir,
        headers,
        connections,
        variantIndex,
        suggestedFilename: sanitizeFilename(suggestedFilename, null),
        // held   = in the queue, will NOT start until the queue is started
        // queued = eligible now, waiting for a free concurrency slot
        status: startNow ? 'queued' : 'held',
        progress: null,
        filename: null,
        error: null,
        addedAt: Date.now(),
      };
      this.items.set(id, item);
      addedIds.push(id);
      this._persistItem(item);
      this.emit('added', this._publicView(item));
    }

    if (startNow) this._pump();
    return addedIds.length === 1 ? addedIds[0] : addedIds;
  }

  pause(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.task) {
      item.task.pause();
      return;
    }
    // Not started yet: stopping a waiting item just parks it back in the queue.
    if (item.status === 'queued') {
      item.status = 'held';
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    }
  }

  resume(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === 'paused' || item.status === 'error' || item.status === 'held') {
      item.status = 'queued';
      item.error = null;
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
      this._pump();
    }
  }

  /** Park a download in the queue without starting it (IDM "Download Later"). */
  hold(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === 'completed' || item.status === 'running') return;
    item.status = 'held';
    this._persistItem(item);
    this.emit('updated', this._publicView(item));
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.task) {
      item.task.cancel();
    } else {
      item.status = 'cancelled';
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    }
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.task) item.task.cancel();
    this.items.delete(id);
    this._deleteItem(id);
    this.emit('removed', { id });
  }

  list() {
    return Array.from(this.items.values()).map((item) => this._publicView(item));
  }

  _publicView(item) {
    return {
      id: item.id,
      kind: item.kind,
      url: item.url,
      destPath: item.destPath,
      filename: item.filename,
      status: item.status,
      size: item.size ?? (item.progress ? item.progress.size : null),
      progress: item.progress,
      error: item.error,
      addedAt: item.addedAt,
      startedAt: item.startedAt ?? null,
      completedAt: item.completedAt ?? null,
    };
  }

  /** Resume every paused/errored download at once (IDM "Resume all"). */
  resumeAll() {
    for (const item of this.items.values()) {
      if (item.status === 'paused' || item.status === 'error') this.resume(item.id);
    }
  }

  /** Pause every running download at once (IDM "Stop all"). */
  pauseAll() {
    for (const item of this.items.values()) {
      if (item.status === 'running' && item.task) item.task.pause();
    }
  }

  /**
   * IDM "Start Queue": begin processing the queue. Every held item becomes
   * eligible and the pump fills all free concurrency slots, in insertion order.
   */
  startQueue() {
    this.queueRunning = true;
    for (const item of this.items.values()) {
      if (item.status === 'held' || item.status === 'paused' || item.status === 'error') {
        item.status = 'queued';
        item.error = null;
        this._persistItem(item);
        this.emit('updated', this._publicView(item));
      }
    }
    this.emit('queue-state', { running: true });
    this._pump();
  }

  /**
   * IDM "Stop Queue": stop processing. Running downloads are paused (progress is
   * preserved) and anything still waiting drops back to held so the queue does
   * not creep forward.
   */
  stopQueue() {
    this.queueRunning = false;
    for (const item of this.items.values()) {
      if (item.status === 'running' && item.task) {
        item.task.pause();
      } else if (item.status === 'queued') {
        item.status = 'held';
        this._persistItem(item);
        this.emit('updated', this._publicView(item));
      }
    }
    this.emit('queue-state', { running: false });
  }

  /** Back-compat alias: previously "start everything". */
  startAll() {
    this.startQueue();
  }

  isQueueRunning() {
    return Boolean(this.queueRunning);
  }

  /**
   * IDM "Refresh download address": swap in a fresh URL (e.g. an expired CDN
   * link) while preserving byte progress, then resume from the same offset.
   * Patches the on-disk .ddl.json so the resumed task uses the new URL.
   */
  refreshUrl(id, newUrl) {
    const item = this.items.get(id);
    if (!item || !newUrl) return;
    item.url = newUrl;
    if (item.destPath) {
      const metaPath = `${item.destPath}.ddl.json`;
      try {
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          meta.url = newUrl;
          meta.finalUrl = newUrl;
          fs.writeFileSync(metaPath, JSON.stringify(meta));
        }
      } catch (err) {
        console.error('Failed to patch meta on refreshUrl:', err);
      }
    }
    this._persistItem(item);
    if (item.task) {
      // Mid-flight: pause now and resume once the task has fully settled to
      // 'paused' (see _runItem), so it restarts cleanly with the new URL.
      item._pendingResume = true;
      item.task.pause();
    } else {
      this.resume(id);
    }
  }

  // Effective concurrency cap (config may override the constructor default).
  _maxConcurrent() {
    const fromCfg = this.config ? Number(this.config.get('maxConcurrentDownloads')) : 0;
    return fromCfg > 0 ? fromCfg : this.maxConcurrentDownloads;
  }

  /**
   * Fill every free concurrency slot with waiting ('queued') items, in insertion
   * order. Loops rather than starting a single item, so adding N downloads at
   * once actually saturates the cap instead of trickling one at a time.
   */
  _pump() {
    const max = this._maxConcurrent();
    while (this.runningCount < max) {
      const next = Array.from(this.items.values()).find((it) => it.status === 'queued');
      if (!next) return;

      this.runningCount++;
      next.status = 'running';
      this._persistItem(next);
      this.emit('updated', this._publicView(next));
      this._runItem(next).finally(() => {
        this.runningCount--;
        this._pump();
      });
    }
  }

  async _runItem(item) {
    let TaskClass;
    if (item.kind === 'hls') TaskClass = HlsDownloadTask;
    else if (item.kind === 'dash') TaskClass = DashDownloadTask;
    else TaskClass = DownloadTask;

    const taskOpts =
      item.kind === 'hls'
        ? {
            playlistUrl: item.url,
            destPath: item.destPath || path.join(item.destDir, `${item.suggestedFilename || item.id}.mp4`),
            headers: item.headers,
            variantIndex: item.variantIndex,
            rateLimiter: this.rateLimiter,
          }
        : item.kind === 'dash'
        ? {
            mpdUrl: item.url,
            destPath: item.destPath || path.join(item.destDir, `${item.suggestedFilename || item.id}.mp4`),
            headers: item.headers,
            variantIndex: item.variantIndex,
            rateLimiter: this.rateLimiter,
          }
        : item.destPath
          ? { url: item.url, destPath: item.destPath, headers: item.headers, connections: item.connections, rateLimiter: this.rateLimiter }
          : {
              url: item.url,
              destDir: item.destDir,
              headers: item.headers,
              connections: item.connections,
              suggestedFilename: item.suggestedFilename,
              rateLimiter: this.rateLimiter,
            };

    const task = new TaskClass(taskOpts);
    item.task = task;

    task.on('start', (info) => {
      item.filename = info.filename || path.basename(task.destPath || '');
      item.destPath = task.destPath;
      if (info.size != null) item.size = info.size;
      // Tracks the start of THIS run (reset on every resume) so the completion
      // dialog's "average speed" reflects actual transfer time, not time spent
      // sitting paused between resumes.
      item.startedAt = Date.now();
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    });
    task.on('progress', (p) => {
      item.progress = p;
      if (p && p.size != null) item.size = p.size;
      this.emit('updated', this._publicView(item));
    });
    task.on('variant-selected', (v) => this.emit('variant-selected', { id: item.id, variant: v }));
    task.on('segment-error', (e) => this.emit('segment-error', { id: item.id, ...e }));

    try {
      await new Promise((resolve, reject) => {
        task.once('complete', resolve);
        task.once('cancelled', resolve);
        task.once('paused', resolve);
        task.once('error', reject);
        task.start().catch(reject);
      });

      if (task.cancelled) {
        item.status = 'cancelled';
      } else if (task.paused) {
        item.status = 'paused';
      } else {
        item.status = 'completed';
        item.completedAt = Date.now();
      }
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
    }

    item.task = null;
    this._persistItem(item);
    this.emit('updated', this._publicView(item));

    // A refreshUrl() that landed while this task was running deferred its resume
    // until the task settled — honour it now that status is final.
    if (item._pendingResume) {
      item._pendingResume = false;
      this.resume(item.id);
    }
  }

  _persistItem(item) {
    try {
      this.insertStmt.run(
        item.id,
        item.kind,
        item.url,
        item.destPath,
        item.destDir,
        JSON.stringify(item.headers || {}),
        item.connections,
        item.variantIndex,
        item.status === 'running' ? 'paused' : item.status,
        item.filename,
        item.error,
        item.addedAt,
        JSON.stringify(
          item.status === 'completed'
            ? { percent: 100, size: item.size ?? null }
            : item.progress || (item.size != null ? { size: item.size } : null)
        )
      );
    } catch (err) {
      console.error('Failed to persist item to db:', err);
    }
  }

  _deleteItem(id) {
    try {
      this.deleteStmt.run(id);
    } catch (err) {
      console.error('Failed to delete item from db:', err);
    }
  }

  _loadState() {
    try {
      const stmt = this.db.prepare('SELECT * FROM downloads ORDER BY addedAt ASC');
      const rows = stmt.all();
      for (const row of rows) {
        const item = {
          id: row.id,
          kind: row.kind,
          url: row.url,
          destPath: row.destPath,
          destDir: row.destDir,
          headers: JSON.parse(row.headers || '{}'),
          connections: row.connections,
          variantIndex: row.variantIndex,
          status: row.status === 'running' ? 'paused' : row.status,
          filename: row.filename,
          error: row.error,
          addedAt: row.addedAt,
          progress: JSON.parse(row.progress || 'null'),
          task: null,
        };
        item.size = item.progress && item.progress.size != null ? item.progress.size : null;
        this.items.set(item.id, item);
      }
    } catch (err) {
      console.error('Failed to load items from db:', err);
    }
  }
}

module.exports = { Manager };
