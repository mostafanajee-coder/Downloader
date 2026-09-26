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
const { sanitizeFilename, numberedVariant } = require('./filename');
const { getCategoryForUrl } = require('./categories');
const { RateLimiter } = require('./rateLimiter');
const { configureHttp, configureProxy } = require('./httpUtils');
const { discardWorkspace } = require('./workspace');
const { applySiteLogin } = require('./siteLogins');
const { probe } = require('./probe');
const { sanitizeRequestHeaders } = require('./headerScope');

const MAX_CONCURRENT_DOWNLOADS = 4;
const KINDS = new Set(['file', 'hls', 'dash']);

// Paths compare case-insensitively on Windows: "Video.mp4" and "video.mp4"
// are the same file there.
function samePathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** What a download is called before its server has named it. */
function nameFromUrl(urlStr) {
  try {
    const base = path.posix.basename(new URL(urlStr).pathname);
    if (!base) return null;
    try {
      return decodeURIComponent(base);
    } catch (e) {
      return base;
    }
  } catch (e) {
    return null;
  }
}

/** HLS/DASH are remuxed into MP4 whatever the playlist was called. */
function streamOutputName(name) {
  const base = String(name || '').replace(/\.(m3u8|m3u|mpd|ts|m4s|mp4|m4v)$/i, '');
  return `${base || 'video'}.mp4`;
}

// Only ever raced against real work as an upper bound, so it must not keep the
// process alive on its own.
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

/** An IDM-style exclusion pattern ("*.example.com") as an anchored regex. */
function hostPatternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

// Stable ids for the two queues IDM always has. Fixed rather than generated so
// they survive restarts and can be referenced directly by the UI.
const MAIN_QUEUE_ID = 'main';
const SYNC_QUEUE_ID = 'sync';

/**
 * Orchestrates a queue of downloads (plain files, HLS streams, DASH streams),
 * retains persistent download history across app restarts, supports batch URL expansion,
 * and enforces a cap on how many downloads run at once.
 */
class Manager extends EventEmitter {
  constructor({ stateDir, config, maxConcurrentDownloads = MAX_CONCURRENT_DOWNLOADS, defaultDestDir = null }) {
    super();
    this.stateDir = stateDir;
    this.config = config;
    this.maxConcurrentDownloads = maxConcurrentDownloads;
    // Where downloads land when no ConfigManager is supplying category folders.
    // Without this the last resort was process.cwd(), which for a packaged app
    // is wherever Windows happened to launch it from — Program Files, or
    // System32 for a shell-invoked instance. An explicit parameter also makes
    // an embedded or test Manager hermetic instead of writing into the repo.
    this.defaultDestDir = defaultDestDir || null;
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queues (
        id TEXT PRIMARY KEY,
        name TEXT,
        maxConcurrent INTEGER,
        position INTEGER,
        isDefault INTEGER
      )
    `);

    // Downloads predate queues, so an existing database has no queueId or
    // position column. Adding them conditionally keeps every previously
    // recorded download intact instead of forcing a schema reset.
    this._ensureColumn('downloads', 'queueId', 'TEXT');
    this._ensureColumn('downloads', 'position', 'INTEGER');
    // Not persisted originally, so a download that hadn't started yet came
    // back after a restart without its name (an HLS stream was saved as
    // "<uuid>.mp4") and every finished one lost its completion time.
    this._ensureColumn('downloads', 'suggestedFilename', 'TEXT');
    this._ensureColumn('downloads', 'startedAt', 'INTEGER');
    this._ensureColumn('downloads', 'completedAt', 'INTEGER');

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO downloads (id, kind, url, destPath, destDir, headers, connections, variantIndex, status, filename, error, addedAt, progress, queueId, position, suggestedFilename, startedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteStmt = this.db.prepare(`DELETE FROM downloads WHERE id = ?`);
    this.insertQueueStmt = this.db.prepare(`
      INSERT OR REPLACE INTO queues (id, name, maxConcurrent, position, isDefault) VALUES (?, ?, ?, ?, ?)
    `);
    this.deleteQueueStmt = this.db.prepare(`DELETE FROM queues WHERE id = ?`);

    this.items = new Map(); // id -> { id, kind, url, destPath, status, task, error, addedAt, ... }
    this.queues = new Map(); // queueId -> { id, name, maxConcurrent, position, isDefault, running }
    // Running counts are tracked per queue: each queue enforces its own
    // concurrency limit, so one busy queue can't starve another.
    this.runningByQueue = new Map();
    this.runningCount = 0;

    // Single shared limiter = the GLOBAL speed cap across every active download.
    // Its rate tracks config.speedLimitKBps and is applied to every task.
    this.rateLimiter = new RateLimiter(this._speedLimitBytes());

    this.updateHttpSettings();
    this._loadQueues();
    this._loadState();
  }

  /** Add a column only if it isn't already there (SQLite has no IF NOT EXISTS). */
  _ensureColumn(table, column, type) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // Push the current configured global speed limit into the shared limiter.
  // Call after the UI changes speedLimitKBps so running downloads adjust live.
  updateSpeedLimit() {
    this.rateLimiter.setRate(this._speedLimitBytes());
  }

  // Push TLS strictness into the shared HTTP client. Verification stays on
  // unless the user has explicitly opted out in config.
  updateHttpSettings() {
    configureHttp({
      allowInsecureTLS: this.config ? Boolean(this.config.get('allowInsecureTLS')) : false,
    });
    configureProxy(this.config ? this.config.get('proxy') : null);
  }

  // --- Queues ----------------------------------------------------------------
  // IDM ships a Main download queue and a Synchronization queue and lets you
  // create more, each with its own file list, running state and concurrency
  // limit. `running` is deliberately NOT persisted: a queue that was mid-run
  // when the app closed should not silently resume on next launch.

  _loadQueues() {
    let rows = [];
    try {
      rows = this.db.prepare('SELECT * FROM queues ORDER BY position ASC').all();
    } catch (err) {
      console.error('Failed to load queues:', err);
    }

    for (const row of rows) {
      this.queues.set(row.id, {
        id: row.id,
        name: row.name,
        maxConcurrent: row.maxConcurrent || 0, // 0 = follow the global setting
        position: row.position,
        isDefault: Boolean(row.isDefault),
        running: false,
      });
    }

    if (!this.queues.has(MAIN_QUEUE_ID)) {
      this._putQueue({ id: MAIN_QUEUE_ID, name: 'Main download queue', maxConcurrent: 0, position: 0, isDefault: true });
    }
    if (!this.queues.has(SYNC_QUEUE_ID)) {
      this._putQueue({ id: SYNC_QUEUE_ID, name: 'Synchronization queue', maxConcurrent: 1, position: 1, isDefault: true });
    }
  }

  _putQueue(queue) {
    this.queues.set(queue.id, { running: false, ...queue });
    try {
      this.insertQueueStmt.run(
        queue.id,
        queue.name,
        queue.maxConcurrent || 0,
        queue.position || 0,
        queue.isDefault ? 1 : 0
      );
    } catch (err) {
      console.error('Failed to persist queue:', err);
    }
    return this.queues.get(queue.id);
  }

  listQueues() {
    return Array.from(this.queues.values())
      .sort((a, b) => a.position - b.position)
      .map((q) => ({
        id: q.id,
        name: q.name,
        maxConcurrent: q.maxConcurrent,
        isDefault: q.isDefault,
        running: Boolean(q.running),
        count: this._itemsInQueue(q.id).length,
      }));
  }

  createQueue(name, maxConcurrent = 0) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('A queue needs a name');
    const position = Math.max(-1, ...Array.from(this.queues.values()).map((q) => q.position)) + 1;
    const queue = this._putQueue({ id: crypto.randomUUID(), name: clean, maxConcurrent, position, isDefault: false });
    this.emit('queues-changed', this.listQueues());
    return queue.id;
  }

  renameQueue(queueId, name) {
    const q = this.queues.get(queueId);
    const clean = String(name || '').trim();
    if (!q || !clean) return;
    q.name = clean;
    this._putQueue(q);
    this.emit('queues-changed', this.listQueues());
  }

  setQueueConcurrency(queueId, maxConcurrent) {
    const q = this.queues.get(queueId);
    if (!q) return;
    const n = Number(maxConcurrent);
    q.maxConcurrent = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 32) : 0;
    this._putQueue(q);
    this.emit('queues-changed', this.listQueues());
    this._pump(queueId); // a raised limit should take effect immediately
  }

  /**
   * Remove a queue. Its downloads move to the main queue rather than being
   * destroyed — deleting a container should never silently delete its contents.
   */
  deleteQueue(queueId) {
    const q = this.queues.get(queueId);
    if (!q || q.isDefault) return; // the built-in two can't be removed
    for (const item of this._itemsInQueue(queueId)) {
      item.queueId = MAIN_QUEUE_ID;
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    }
    this.queues.delete(queueId);
    this.runningByQueue.delete(queueId);
    try {
      this.deleteQueueStmt.run(queueId);
    } catch (err) {
      console.error('Failed to delete queue:', err);
    }
    this.emit('queues-changed', this.listQueues());
    this._pump(MAIN_QUEUE_ID);
  }

  moveToQueue(ids, queueId) {
    if (!this.queues.has(queueId)) return;
    const list = Array.isArray(ids) ? ids : [ids];
    let nextPos = this._nextPosition(queueId);
    for (const id of list) {
      const item = this.items.get(id);
      if (!item || item.queueId === queueId) continue;
      const from = item.queueId;
      item.queueId = queueId;
      item.position = nextPos++;
      // A download already in flight keeps running; it just belongs to a
      // different queue now, and its slot is accounted for there on completion.
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
      if (from) this._pump(from);
    }
    this.emit('queues-changed', this.listQueues());
    this._pump(queueId);
  }

  _itemsInQueue(queueId) {
    return Array.from(this.items.values())
      .filter((i) => (i.queueId || MAIN_QUEUE_ID) === queueId)
      .sort((a, b) => (a.position || 0) - (b.position || 0) || a.addedAt - b.addedAt);
  }

  _nextPosition(queueId) {
    const inQueue = this._itemsInQueue(queueId);
    return inQueue.length ? Math.max(...inQueue.map((i) => i.position || 0)) + 1 : 0;
  }

  /**
   * Move a download up or down within its queue. Order is what the pump
   * consumes, so this is genuinely "download this one sooner", not just a
   * cosmetic list sort.
   */
  reorder(id, delta) {
    const item = this.items.get(id);
    if (!item) return;
    const queueId = item.queueId || MAIN_QUEUE_ID;
    const ordered = this._itemsInQueue(queueId);
    const index = ordered.findIndex((i) => i.id === id);
    const target = index + (delta < 0 ? -1 : 1);
    if (index === -1 || target < 0 || target >= ordered.length) return;

    // Renumber the whole queue from scratch: positions can be sparse or
    // duplicated after imports and migrations, and swapping two values only
    // works if they're already sane.
    const swapped = ordered.slice();
    [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
    swapped.forEach((it, i) => {
      it.position = i;
      this._persistItem(it);
      this.emit('updated', this._publicView(it));
    });
  }

  startQueueById(queueId) {
    const q = this.queues.get(queueId);
    if (!q) return;
    q.running = true;
    for (const item of this._itemsInQueue(queueId)) {
      if (item.status === 'held' || item.status === 'paused' || item.status === 'error') {
        item.status = 'queued';
        item.error = null;
        this._persistItem(item);
        this.emit('updated', this._publicView(item));
      }
    }
    this.emit('queue-state', { running: this.isQueueRunning(), queueId, queueRunning: true });
    this.emit('queues-changed', this.listQueues());
    this._pump(queueId);
  }

  stopQueueById(queueId) {
    const q = this.queues.get(queueId);
    if (!q) return;
    q.running = false;
    for (const item of this._itemsInQueue(queueId)) {
      if (item.status === 'running' && item.task) {
        item.task.pause();
      } else if (item.status === 'queued') {
        item.status = 'held';
        this._persistItem(item);
        this.emit('updated', this._publicView(item));
      }
    }
    this.emit('queue-state', { running: this.isQueueRunning(), queueId, queueRunning: false });
    this.emit('queues-changed', this.listQueues());
  }

  _isExcluded(urlStr) {
    if (!this.config) return false;
    const excludedStr = this.config.get('excludedSites') || '';
    if (!excludedStr.trim()) return false;
    
    let hostname;
    try { hostname = new URL(urlStr).hostname; } catch { return false; }
    
    // Every regex metacharacter is escaped, not just dots: an entry like
    // "c++.example" used to throw a SyntaxError out of add() and take the
    // whole batch down with it.
    const patterns = excludedStr.split(/\s+/).filter(Boolean);
    return patterns.some((pattern) => hostPatternToRegExp(pattern).test(hostname));
  }

  /**
   * Default connections per download, from Options → Connection.
   *
   * This used to be a hardcoded 16 in add()'s signature that no caller ever
   * overrode, which made the "Default max. connections per download" dropdown
   * pure decoration. Capped at 32 to match the dropdown's own maximum.
   */
  _defaultConnections() {
    const n = this.config ? Number(this.config.get('maxConnections')) : 0;
    if (!Number.isFinite(n) || n <= 0) return 8;
    return Math.min(Math.max(1, Math.floor(n)), 32);
  }

  /** Configured scratch folder for in-progress downloads (Options → Save To). */
  _tempDir() {
    const dir = this.config ? this.config.get('tempDir') : null;
    return dir && String(dir).trim() ? String(dir).trim() : null;
  }

  /**
   * An existing entry for the same URL that still "occupies" that download —
   * anything not cancelled. A completed item counts: re-adding a file you
   * already have is exactly the case IDM's duplicate prompt exists for.
   */
  _findDuplicate(url) {
    for (const item of this.items.values()) {
      if (item.url === url && item.status !== 'cancelled') return item;
    }
    return null;
  }

  // Per-download speed cap in bytes/sec, read live from config (0 = unlimited).
  // The UI stores it as KB/s under `speedLimitKBps`; each new download picks up
  // the current value at start time.
  _speedLimitBytes() {
    if (!this.config) return 0;
    // The limiter is a switch with a remembered value (IDM's sls_maxSpeed +
    // on/off): a stored KB/s figure only applies while the switch is on. An
    // older config without the flag but with a non-zero value keeps working.
    const enabled = this.config.get('speedLimiterEnabled');
    if (enabled === false) return 0;
    const kbps = Number(this.config.get('speedLimitKBps')) || 0;
    return kbps > 0 ? kbps * 1024 : 0;
  }

  add(payload = {}) {
    const {
      url,
      kind: requestedKind = 'file',
      destPath,
      destDir,
      headers: requestedHeaders = {},
      connections,
      variantIndex: requestedVariant = 0,
      suggestedFilename,
      startNow = true,
      padWidth,
      allowDuplicate = false,
      queueId,
      noBatch = false,
    } = payload;

    if (typeof url !== 'string' || !url.trim()) return [];
    const kind = KINDS.has(requestedKind) ? requestedKind : 'file';
    const headers = sanitizeRequestHeaders(requestedHeaders);
    const variantIndex = Number.isInteger(Number(requestedVariant)) && Number(requestedVariant) >= 0 ? Number(requestedVariant) : 0;

    const targetQueue = this.queues.has(queueId) ? queueId : MAIN_QUEUE_ID;
    let nextPosition = this._nextPosition(targetQueue);

    const urls = noBatch ? [url.trim()] : expandBatchUrl(url.trim(), { padWidth });
    const addedIds = [];
    // 'ask' | 'skip' | 'allow' — what to do when the same URL is already here.
    const duplicatePolicy = this.config ? this.config.get('duplicateAction') || 'ask' : 'allow';
    const effectiveConnections = connections || this._defaultConnections();

    for (const singleUrl of urls) {
      if (this._isExcluded(singleUrl)) continue;

      if (!allowDuplicate && duplicatePolicy !== 'allow') {
        const existing = this._findDuplicate(singleUrl);
        if (existing) {
          if (duplicatePolicy === 'skip') {
            this.emit('duplicate-skipped', { url: singleUrl, existingId: existing.id });
          } else {
            // 'ask': the Manager can't put a dialog on screen, and it is reached
            // from the bridge as well as the UI, so it defers the decision —
            // whoever is listening prompts and re-adds with allowDuplicate.
            this.emit('duplicate-detected', {
              url: singleUrl,
              existingId: existing.id,
              existingFilename: existing.filename || null,
              existingStatus: existing.status,
              payload: { ...payload, url: singleUrl, allowDuplicate: true },
            });
          }
          continue;
        }
      }

      const id = crypto.randomUUID();
      const category = getCategoryForUrl(singleUrl, kind, suggestedFilename);
      const destDirs = this.config ? this.config.get('destDirs') : {};
      const finalDestDir =
        destDir || destDirs[category] || destDirs['General'] || this.defaultDestDir || process.cwd();
      try {
        const existingStat = fs.existsSync(finalDestDir) ? fs.statSync(finalDestDir) : null;
        if (!existingStat) {
          fs.mkdirSync(finalDestDir, { recursive: true });
        } else if (!existingStat.isDirectory()) {
          // Something exists at this path but it's a file, not a directory —
          // existsSync() alone can't tell them apart, and silently proceeding
          // would only surface a much more cryptic failure later, deep inside
          // the download task's own file writes.
          throw new Error(`Destination path exists but is not a directory: ${finalDestDir}`);
        }
      } catch (err) {
        // A disk-full/permission/not-a-directory failure for ONE destination
        // shouldn't abort the rest of a batch add (e.g. 50 URLs from the
        // Batch Download modal) — skip just this URL and keep going.
        console.error(`Failed to prepare destination directory "${finalDestDir}" for ${singleUrl}:`, err.message);
        continue;
      }

      // IDM's Site Logins: a stored username/password for this host becomes a
      // Basic Authorization header on every request for the download. Never
      // overrides a header the caller already set (a captured Bearer token).
      const siteLogins = this.config ? this.config.get('siteLogins') : null;
      const effectiveHeaders = applySiteLogin(siteLogins, singleUrl, headers);

      const item = {
        id,
        kind, // 'file' | 'hls' | 'dash'
        url: singleUrl,
        destPath: destPath || null,
        destDir: finalDestDir,
        headers: effectiveHeaders,
        connections: effectiveConnections,
        variantIndex,
        suggestedFilename: sanitizeFilename(suggestedFilename, null),
        // held   = in the queue, will NOT start until the queue is started
        // queued = eligible now, waiting for a free concurrency slot
        status: startNow ? 'queued' : 'held',
        queueId: targetQueue,
        position: nextPosition++,
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

    if (addedIds.length) this.emit('queues-changed', this.listQueues());
    if (startNow) this._pump(targetQueue);
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
      this._pump(item.queueId || MAIN_QUEUE_ID);
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
    // Deleting a half-finished download must also drop its scratch data,
    // otherwise abandoned partials accumulate forever with nothing left in the
    // queue pointing at them. A running task is still writing (and re-saving
    // its sidecar every 400ms), so its cleanup waits until it has stopped.
    if (item.task) {
      item._discardOnSettle = item.status !== 'completed';
      item.task.cancel();
    } else if (item.status !== 'completed') {
      this._discardPartial(item);
    }
    const queueId = item.queueId || MAIN_QUEUE_ID;
    this.items.delete(id);
    this._deleteItem(id);
    this.emit('removed', { id });
    this.emit('queues-changed', this.listQueues());
    this._pump(queueId);
  }

  /**
   * Throw away everything an unfinished download left behind: its temp-folder
   * workspace, and — when it was assembled in place — the sidecar, the stream
   * parts folder, and the partial file itself. The partial file is only
   * removed when its sidecar proves it IS one of our partials, never a file
   * the user already had.
   */
  _discardPartial(item) {
    if (!item || !item.destPath) return;
    discardWorkspace({ destPath: item.destPath, tempDir: this._tempDir() });
    const sidecar = `${item.destPath}.ddl.json`;
    try {
      if (fs.existsSync(sidecar)) {
        if (item.status !== 'completed' && fs.existsSync(item.destPath)) fs.unlinkSync(item.destPath);
        fs.unlinkSync(sidecar);
      }
      if (fs.existsSync(`${sidecar}.tmp`)) fs.unlinkSync(`${sidecar}.tmp`);
    } catch (err) {
      console.warn(`[Manager] Could not remove partial download ${item.destPath}:`, err.message);
    }
    for (const dir of [`${item.destPath}.hls_parts`, `${item.destPath}.dash_parts`]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        /* best effort */
      }
    }
  }

  /**
   * IDM "Redownload": start this entry over from zero with its original
   * headers, kind, quality and destination. Re-adding the bare URL (what the
   * menu used to do) lost the captured cookies, so a browser-captured download
   * came back 403, and tripped the duplicate prompt against itself.
   */
  redownload(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.task) {
      item._pendingRedownload = true;
      item.task.cancel();
      return;
    }
    // The previous copy stays where it is until the new one is verified; the
    // publish step then replaces it, exactly like a first download would.
    const keep = item.status === 'completed';
    if (!keep) this._discardPartial(item);
    else {
      discardWorkspace({ destPath: item.destPath, tempDir: this._tempDir() });
      try {
        if (item.destPath && fs.existsSync(`${item.destPath}.ddl.json`)) fs.unlinkSync(`${item.destPath}.ddl.json`);
      } catch (err) {
        /* best effort */
      }
    }
    item.status = 'queued';
    item.error = null;
    item.progress = null;
    item.startedAt = null;
    item.completedAt = null;
    this._persistItem(item);
    this.emit('updated', this._publicView(item));
    this._pump(item.queueId || MAIN_QUEUE_ID);
  }

  list() {
    return Array.from(this.items.values()).map((item) => this._publicView(item));
  }

  /**
   * IDM "Export download list": everything needed to re-create the queue
   * elsewhere. Headers are included because a captured download is often
   * useless without its cookies/referer; the caller decides where the file
   * goes and should treat it as sensitive for that reason.
   */
  exportList() {
    return {
      format: 'downloader-list',
      version: 1,
      exportedAt: new Date().toISOString(),
      queues: this.listQueues().map((q) => ({ id: q.id, name: q.name, maxConcurrent: q.maxConcurrent })),
      items: Array.from(this.items.values()).map((item) => ({
        url: item.url,
        kind: item.kind,
        filename: item.filename || null,
        suggestedFilename: item.suggestedFilename || null,
        destDir: item.destDir || null,
        headers: item.headers || {},
        connections: item.connections,
        variantIndex: item.variantIndex || 0,
        queueId: item.queueId || MAIN_QUEUE_ID,
        status: item.status,
      })),
    };
  }

  /**
   * IDM "Import download list". Items are added ON HOLD so a large import
   * doesn't start dozens of downloads the moment the file is opened; the user
   * starts the queue when ready. Unknown queues are created by name.
   * Returns { added, skipped }.
   */
  importList(data) {
    if (!data || !Array.isArray(data.items)) throw new Error('Not a download list file');

    // Map exported queue ids to local ones, creating missing custom queues.
    const queueMap = new Map([[MAIN_QUEUE_ID, MAIN_QUEUE_ID], [SYNC_QUEUE_ID, SYNC_QUEUE_ID]]);
    for (const q of data.queues || []) {
      if (!q || !q.id || queueMap.has(q.id)) continue;
      const existing = Array.from(this.queues.values()).find((x) => x.name === q.name);
      queueMap.set(q.id, existing ? existing.id : this.createQueue(q.name || 'Imported', q.maxConcurrent || 0));
    }

    let added = 0;
    let skipped = 0;
    for (const entry of data.items) {
      if (!entry || typeof entry.url !== 'string' || !/^(https?|ftp):\/\//i.test(entry.url)) {
        skipped++;
        continue;
      }
      const ids = this.add({
        url: entry.url,
        kind: entry.kind || 'file',
        suggestedFilename: entry.suggestedFilename || entry.filename || undefined,
        destDir: entry.destDir || undefined,
        headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
        connections: entry.connections || undefined,
        variantIndex: entry.variantIndex || 0,
        queueId: queueMap.get(entry.queueId) || MAIN_QUEUE_ID,
        startNow: false,
        allowDuplicate: false,
      });
      const count = Array.isArray(ids) ? ids.length : ids ? 1 : 0;
      if (count) added += count;
      else skipped++;
    }
    return { added, skipped };
  }

  _publicView(item) {
    return {
      id: item.id,
      kind: item.kind,
      url: item.url,
      destPath: item.destPath,
      filename: item.filename,
      // What the list shows before the server has named the file: the name
      // the user/extension asked for, else the URL's last path segment.
      displayName: item.filename || item.suggestedFilename || nameFromUrl(item.url) || item.url,
      status: item.status,
      size: item.size ?? (item.progress ? item.progress.size : null),
      progress: item.progress,
      error: item.error,
      addedAt: item.addedAt,
      queueId: item.queueId || MAIN_QUEUE_ID,
      position: item.position || 0,
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
  startQueue(queueId) {
    if (queueId) return this.startQueueById(queueId);
    for (const id of this.queues.keys()) this.startQueueById(id);
  }

  /**
   * IDM "Stop Queue": stop processing. Running downloads are paused (progress is
   * preserved) and anything still waiting drops back to held so the queue does
   * not creep forward.
   */
  stopQueue(queueId) {
    if (queueId) return this.stopQueueById(queueId);
    for (const id of this.queues.keys()) this.stopQueueById(id);
  }

  /** Back-compat alias: previously "start everything". */
  startAll() {
    this.startQueue();
  }

  /** True when ANY queue is processing — what the toolbar indicator reflects. */
  isQueueRunning() {
    for (const q of this.queues.values()) if (q.running) return true;
    return false;
  }

  /**
   * IDM "Refresh download address": swap in a fresh URL (e.g. an expired CDN
   * link) while preserving byte progress, then resume from the same offset.
   *
   * The resumed task treats the URL it is given as authoritative over the one
   * recorded in its .ddl.json sidecar (see DownloadTask._loadMeta), so nothing
   * on disk needs patching — which matters, because with a temp folder the
   * sidecar isn't next to destPath at all, and the old patch-in-place silently
   * missed it and kept resuming from the expired link.
   */
  refreshUrl(id, newUrl) {
    const item = this.items.get(id);
    const url = typeof newUrl === 'string' ? newUrl.trim() : '';
    if (!item || !/^(https?|ftp):\/\//i.test(url)) return;
    item.url = url;
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
  _pump(queueId) {
    if (queueId === undefined) {
      for (const id of this.queues.keys()) this._pump(id);
      return;
    }

    const queue = this.queues.get(queueId);
    if (!queue || this._shuttingDown) return;
    // A queue-specific limit wins; 0 means "follow the global setting".
    const max = queue.maxConcurrent > 0 ? queue.maxConcurrent : this._maxConcurrent();
    const ordered = this._itemsInQueue(queueId);

    while ((this.runningByQueue.get(queueId) || 0) < max) {
      const next = ordered.find((it) => it.status === 'queued');
      if (!next) return;

      this.runningByQueue.set(queueId, (this.runningByQueue.get(queueId) || 0) + 1);
      this.runningCount++;
      next.status = 'running';
      this._persistItem(next);
      this.emit('updated', this._publicView(next));
      this._runItem(next)
        // Last-resort net. _runItem guards itself, but `.finally()` re-throws
        // whatever it received, and nothing was awaiting this promise — so any
        // escape became an unhandledRejection at the process level rather than
        // a failed download. Catch first, so the slot accounting below always
        // runs against a settled, non-throwing promise.
        .catch((err) => {
          console.error(`[Manager] Download ${next.id} failed outside its own error handling:`, err);
          if (next.status === 'running') {
            next.status = 'error';
            next.error = err && err.message ? err.message : String(err);
            next.task = null;
            this._persistItem(next);
            this.emit('updated', this._publicView(next));
          }
        })
        .finally(() => {
          // Charge the slot back to the queue the item STARTED in: moveToQueue
          // can reassign it mid-flight, and decrementing the new queue would
          // corrupt both counters.
          const startedIn = next._runningQueueId || queueId;
          this.runningByQueue.set(startedIn, Math.max(0, (this.runningByQueue.get(startedIn) || 1) - 1));
          this.runningCount = Math.max(0, this.runningCount - 1);
          next._runningQueueId = null;
          this._pump(startedIn);
          if (startedIn !== queueId) this._pump(queueId);
        });
      next._runningQueueId = queueId;
    }
  }

  async _runItem(item) {
    // Everything from here to the end is inside one guard on purpose.
    //
    // Previously only the *awaited download* was wrapped: constructing the
    // task, building its options and attaching listeners all sat outside the
    // try, so a throw there rejected _runItem without ever setting a status.
    // The pump then released the slot but left the row saying "running" with
    // whatever progress it last displayed — a zombie download frozen at, say,
    // 49.9% with a live-looking transfer rate that will never change again.
    try {
      await this._startTask(item);
    } catch (err) {
      item.status = 'error';
      item.error = err && err.message ? err.message : String(err);
      item.task = null;
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    }
  }

  /**
   * Turn a candidate destination into one nothing else is using, and claim it
   * for `item` immediately.
   *
   * Two downloads that both resolve to "video.mp4" in the same folder used to
   * share one temp workspace and one sidecar while running — each clobbering
   * the other's bytes and progress — and whichever finished second deleted the
   * first one's finished file to publish its own. Now the second becomes
   * "video (2).mp4", the way a browser names a repeated download. A file that
   * already exists on disk is never overwritten by a NEW download either.
   *
   * Only called for a download's first run; resumes keep the path they had.
   */
  _reserveDestPath(item, candidate) {
    const taken = new Set();
    for (const other of this.items.values()) {
      if (other !== item && other.destPath) taken.add(samePathKey(other.destPath));
    }
    const dir = path.dirname(candidate);
    const base = path.basename(candidate);
    for (let n = 1; n < 10000; n++) {
      const p = path.join(dir, numberedVariant(base, n));
      if (taken.has(samePathKey(p))) continue;
      if (fs.existsSync(p) || fs.existsSync(`${p}.ddl.json`)) continue;
      item.destPath = p;
      this._persistItem(item);
      return p;
    }
    item.destPath = candidate;
    return candidate;
  }

  async _startTask(item) {
    // A previous run that failed may still be unwinding (see `running` below).
    // Starting over on top of it would put two tasks on one file and one
    // sidecar. The wait is bounded by the HTTP response timeout.
    if (item._taskRun) {
      await Promise.race([item._taskRun, sleep(35000)]);
      item._taskRun = null;
    }

    let TaskClass;
    if (item.kind === 'hls') TaskClass = HlsDownloadTask;
    else if (item.kind === 'dash') TaskClass = DashDownloadTask;
    else TaskClass = DownloadTask;

    const streamDest = () =>
      item.destPath ||
      this._reserveDestPath(
        item,
        path.join(item.destDir, sanitizeFilename(streamOutputName(item.suggestedFilename || item.id), 'video.mp4'))
      );

    const taskOpts =
      item.kind === 'hls'
        ? {
            playlistUrl: item.url,
            destPath: streamDest(),
            headers: item.headers,
            variantIndex: item.variantIndex,
            rateLimiter: this.rateLimiter,
            tempDir: this._tempDir(),
          }
        : item.kind === 'dash'
        ? {
            mpdUrl: item.url,
            destPath: streamDest(),
            headers: item.headers,
            variantIndex: item.variantIndex,
            rateLimiter: this.rateLimiter,
            tempDir: this._tempDir(),
          }
        : item.destPath
          ? {
              url: item.url,
              destPath: item.destPath,
              headers: item.headers,
              connections: item.connections,
              rateLimiter: this.rateLimiter,
              tempDir: this._tempDir(),
            }
          : {
              url: item.url,
              destDir: item.destDir,
              headers: item.headers,
              connections: item.connections,
              suggestedFilename: item.suggestedFilename,
              rateLimiter: this.rateLimiter,
              tempDir: this._tempDir(),
              reserveDestPath: (candidate) => this._reserveDestPath(item, candidate),
            };

    const task = new TaskClass(taskOpts);
    item.task = task;
    let settle;
    item._settled = new Promise((r) => (settle = r));

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

    // Resolving on the first terminal event is not the same as the task having
    // stopped: when a segment gives up, 'error' fires while the other
    // connections are still finishing their current chunk and start() has yet
    // to write its final sidecar. `running` is start() itself, kept so that
    // anything touching this download's files next waits for it to finish.
    let running = null;
    try {
      await new Promise((resolve, reject) => {
        task.once('complete', (info) => {
          if (info && Number.isFinite(info.size) && info.size > 0) item.size = info.size;
          resolve();
        });
        task.once('cancelled', resolve);
        task.once('paused', resolve);
        task.once('error', reject);
        running = task.start();
        running.catch(reject);
      });

      if (task.cancelled) {
        item.status = 'cancelled';
      } else if (task.paused) {
        item.status = 'paused';
      } else {
        item.status = 'completed';
        item.completedAt = Date.now();
        // An HLS/DASH row showed an extrapolated size while it ran; the
        // real one is known now.
        if (item.progress) item.progress = { ...item.progress, percent: 100, size: item.size ?? item.progress.size };
      }
    } catch (err) {
      item.status = 'error';
      item.error = err && err.message ? err.message : String(err);
    }

    item.task = null;
    item._taskRun = running ? running.catch(() => {}) : null;

    if (item._discardOnSettle) {
      item._discardOnSettle = false;
      await Promise.race([item._taskRun, sleep(5000)]);
      this._discardPartial(item);
    }

    // A removed item is gone from the list; don't resurrect its row.
    if (this.items.get(item.id) === item) {
      this._persistItem(item);
      this.emit('updated', this._publicView(item));
    }
    settle();

    // A refreshUrl() that landed while this task was running deferred its resume
    // until the task settled — honour it now that status is final.
    if (item._pendingResume) {
      item._pendingResume = false;
      this.resume(item.id);
    }
    if (item._pendingRedownload) {
      item._pendingRedownload = false;
      this.redownload(item.id);
    }
  }

  /**
   * Stop cleanly before the app exits: pause every transfer so each one
   * flushes its bytes and writes a final sidecar, wait (bounded) for them to
   * settle, then close the database. Killing the process mid-write instead
   * left the last ~400ms of every download to be fetched again, and on a
   * crash-prone disk, sidecars pointing past what was really written.
   */
  async shutdown({ timeoutMs = 4000 } = {}) {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    const active = Array.from(this.items.values()).filter((i) => i.task);
    for (const item of active) {
      try {
        item.task.pause();
      } catch (e) {
        /* already stopping */
      }
    }
    const settled = active.map((i) => i._settled || Promise.resolve());
    await Promise.race([Promise.all(settled), sleep(timeoutMs)]);
    try {
      this.db.close();
    } catch (e) {
      /* already closed */
    }
  }

  /**
   * What the Add URL dialog needs before the user commits: the file's name,
   * size, type, where it would be saved, and whether it can be resumed. Never
   * throws for an ordinary network problem — the dialog shows the reason and
   * still lets the user add the URL.
   */
  async probeUrl(url, headers = {}) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!/^(https?|ftp):\/\//i.test(target)) return { ok: false, error: 'Not an http(s) or ftp URL' };
    const kindFromUrl = /\.m3u8?(\?|#|$)/i.test(target) ? 'hls' : /\.mpd(\?|#|$)/i.test(target) ? 'dash' : 'file';
    const destDirs = this.config ? this.config.get('destDirs') || {} : {};
    const describe = (kind, filename, extra) => {
      const category = getCategoryForUrl(target, kind, filename);
      return {
        ok: true,
        kind,
        filename,
        category,
        destDir: destDirs[category] || destDirs.General || this.defaultDestDir || null,
        ...extra,
      };
    };
    if (kindFromUrl !== 'file') {
      return describe(kindFromUrl, sanitizeFilename(streamOutputName(nameFromUrl(target) || 'video'), 'video.mp4'), {
        size: null,
        resumable: true,
      });
    }
    try {
      const siteLogins = this.config ? this.config.get('siteLogins') : null;
      const info = await probe(target, applySiteLogin(siteLogins, target, headers || {}));
      const ct = String(info.contentType || '').toLowerCase();
      const kind = /mpegurl/.test(ct) ? 'hls' : /dash\+xml/.test(ct) ? 'dash' : 'file';
      const name = kind === 'file' ? info.filename : streamOutputName(info.filename);
      return describe(kind, sanitizeFilename(name, 'download.bin'), {
        size: info.size,
        resumable: Boolean(info.acceptRanges),
        contentType: info.contentType || null,
        finalUrl: info.finalUrl,
      });
    } catch (err) {
      return { ...describe('file', sanitizeFilename(nameFromUrl(target), 'download.bin'), { size: null }), ok: false, error: err.message };
    }
  }

  _persistItem(item) {
    if (this._shuttingDown && !this.db.open) return;
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
        ),
        item.queueId || MAIN_QUEUE_ID,
        item.position || 0,
        item.suggestedFilename || null,
        item.startedAt ?? null,
        item.completedAt ?? null
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
          // Downloads recorded before queues existed have no queueId — they
          // belong to the main queue, which is where IDM would have put them.
          queueId: row.queueId || MAIN_QUEUE_ID,
          position: row.position || 0,
          progress: JSON.parse(row.progress || 'null'),
          suggestedFilename: row.suggestedFilename || null,
          startedAt: row.startedAt ?? null,
          completedAt: row.completedAt ?? null,
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
