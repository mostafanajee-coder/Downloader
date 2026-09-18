'use strict';

const EventEmitter = require('events');

// Runs in the MAIN process on purpose. The previous scheduler lived in the
// renderer as a 1-second setInterval: Chromium throttles hidden-window timers
// to roughly once a minute, and the check demanded an exact HH:MM match — so an
// app minimised to the tray (its normal state) could skip the target minute and
// never fire. Node timers in the main process are never throttled.

const TICK_MS = 15 * 1000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DEFAULT_SCHEDULE = {
  enabled: false,
  queueId: 'main',
  startTime: null, // 'HH:MM' 24h, or null
  stopTime: null,
  days: [0, 1, 2, 3, 4, 5, 6], // JS getDay(): 0 = Sunday
  // What to do once the scheduled queue has drained: IDM's "Exit IDM /
  // Turn off computer / Hibernate / Stand by when done".
  onComplete: 'none', // 'none' | 'exit' | 'shutdown' | 'hibernate' | 'sleep'
  // IDM's traffic quota: "stop after N MB within M hours".
  quota: { enabled: false, mb: 200, hours: 5 },
};

function hhmmOf(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function normalizeTime(value) {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Queue scheduler + completion actions + traffic quota.
 *
 * `now` is injectable so the whole thing is testable without waiting for the
 * clock; production passes nothing and gets Date.now.
 */
class ScheduleManager extends EventEmitter {
  constructor({ manager, config, power = null, now = () => Date.now() } = {}) {
    super();
    this.manager = manager;
    this.config = config;
    this.power = power;
    this.now = now;
    this.schedule = { ...DEFAULT_SCHEDULE };
    this.timer = null;
    // "Fired today" bookkeeping, so a minute-long window can't fire twice.
    this._firedStartOn = null;
    this._firedStopOn = null;
    // Completion action state: only arm after the scheduled queue has run.
    this._armedForCompletion = false;
    this._completionTimer = null;
    // Traffic quota: rolling log of (timestamp, bytes) samples.
    this._trafficLog = [];
    this._lastProgressBytes = new Map(); // itemId -> last downloaded count
    this._quotaTripped = false;

    if (this.manager) {
      this.manager.on('updated', (item) => this._onItemUpdated(item));
      this.manager.on('queue-state', (state) => this._onQueueState(state));
    }
    this.update();
  }

  /** Re-read the schedule from config. Call whenever config changes. */
  update() {
    // Tolerate a minimal config object (tests, embedders) that only offers
    // getAll(); the real ConfigManager has both.
    const cfg = this.config;
    const raw =
      (cfg && typeof cfg.get === 'function' && cfg.get('schedule')) ||
      (cfg && typeof cfg.getAll === 'function' && (cfg.getAll() || {}).schedule) ||
      {};
    this.schedule = {
      ...DEFAULT_SCHEDULE,
      ...raw,
      startTime: normalizeTime(raw.startTime),
      stopTime: normalizeTime(raw.stopTime),
      days:
        Array.isArray(raw.days) && raw.days.length
          ? raw.days.map(Number).filter((d) => d >= 0 && d <= 6)
          : DEFAULT_SCHEDULE.days,
      quota: { ...DEFAULT_SCHEDULE.quota, ...(raw.quota || {}) },
    };
    // A changed quota starts a fresh window rather than tripping on old traffic.
    this._quotaTripped = false;
    this.emit('schedule-changed', this.describe());
    if (this.schedule.enabled && !this.timer) this.start();
    if (!this.schedule.enabled && this.timer) this.stop();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  destroy() {
    this.stop();
    this.cancelPendingAction();
  }

  describe() {
    const s = this.schedule;
    return {
      ...s,
      days: s.days.slice(),
      daysLabel: s.days.length === 7 ? 'every day' : s.days.map((d) => DAY_NAMES[d]).join(', '),
      timerRunning: Boolean(this.timer),
      pendingAction: this._completionTimer ? s.onComplete : null,
    };
  }

  /** One scheduler pass. Public so tests can drive it deterministically. */
  tick() {
    if (!this.schedule.enabled || !this.manager) return;
    const date = new Date(this.now());
    if (!this.schedule.days.includes(date.getDay())) return;

    const hhmm = hhmmOf(date);
    const today = dayKey(date);

    if (this.schedule.startTime && hhmm === this.schedule.startTime && this._firedStartOn !== today) {
      this._firedStartOn = today;
      this._armedForCompletion = this.schedule.onComplete !== 'none';
      this._quotaTripped = false;
      this.manager.startQueue(this.schedule.queueId);
      this.emit('fired', { action: 'start', queueId: this.schedule.queueId, at: hhmm });
    }

    if (this.schedule.stopTime && hhmm === this.schedule.stopTime && this._firedStopOn !== today) {
      this._firedStopOn = today;
      this._armedForCompletion = false;
      this.manager.stopQueue(this.schedule.queueId);
      this.emit('fired', { action: 'stop', queueId: this.schedule.queueId, at: hhmm });
    }

    this._checkQuota();
  }

  // --- Traffic quota ---------------------------------------------------------

  _onItemUpdated(item) {
    if (!item) return;
    if (item.progress) {
      const downloaded = Number(item.progress.downloaded) || 0;
      const prev = this._lastProgressBytes.get(item.id) || 0;
      if (downloaded > prev) this._trafficLog.push({ at: this.now(), bytes: downloaded - prev });
      if (item.status === 'completed' || item.status === 'error' || item.status === 'cancelled') {
        this._lastProgressBytes.delete(item.id);
      } else {
        this._lastProgressBytes.set(item.id, downloaded);
      }
      this._checkQuota();
    }
    this._checkCompletion();
  }

  bytesInWindow() {
    const hours = Number(this.schedule.quota.hours) || 0;
    const cutoff = this.now() - hours * 3600 * 1000;
    this._trafficLog = this._trafficLog.filter((e) => e.at >= cutoff);
    return this._trafficLog.reduce((a, e) => a + e.bytes, 0);
  }

  _checkQuota() {
    const q = this.schedule.quota;
    if (!q.enabled || this._quotaTripped || !this.manager) return;
    const limit = (Number(q.mb) || 0) * 1024 * 1024;
    if (limit <= 0) return;
    const used = this.bytesInWindow();
    if (used >= limit) {
      this._quotaTripped = true;
      this.manager.stopQueue(); // every queue: the quota is a global cap
      this.emit('quota-exceeded', { usedBytes: used, limitBytes: limit, hours: q.hours });
    }
  }

  // --- Completion action -----------------------------------------------------

  _onQueueState(state) {
    // If the user manually stops the queue, don't power the machine off on
    // them when the last download happens to finish.
    if (state && state.queueId === this.schedule.queueId && state.queueRunning === false) {
      this._armedForCompletion = false;
    }
  }

  _queueDrained() {
    const wanted = this.schedule.queueId;
    for (const item of this.manager.items.values()) {
      if ((item.queueId || 'main') !== wanted) continue;
      if (item.status === 'running' || item.status === 'queued') return false;
    }
    return true;
  }

  _checkCompletion() {
    if (!this._armedForCompletion || this._completionTimer || this.schedule.onComplete === 'none') return;
    if (!this._queueDrained()) return;
    this._armedForCompletion = false;

    const action = this.schedule.onComplete;
    const graceMs = 30 * 1000;
    // Never immediate: the user gets a window to cancel a shutdown they forgot
    // they scheduled, which is also how IDM's own countdown dialog behaves.
    this.emit('completion-action', { action, inMs: graceMs });
    this._completionTimer = setTimeout(() => {
      this._completionTimer = null;
      this.emit('completion-action-fired', { action });
      if (this.power && typeof this.power.perform === 'function') this.power.perform(action);
    }, graceMs);
    if (typeof this._completionTimer.unref === 'function') this._completionTimer.unref();
  }

  cancelPendingAction() {
    if (!this._completionTimer) return false;
    clearTimeout(this._completionTimer);
    this._completionTimer = null;
    this.emit('completion-action-cancelled');
    return true;
  }
}

module.exports = { ScheduleManager, DEFAULT_SCHEDULE, normalizeTime };
