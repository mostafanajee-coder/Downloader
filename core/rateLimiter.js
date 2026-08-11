'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared token-bucket rate limiter.
 *
 * A single instance can be consumed concurrently by many segment workers and by
 * many DownloadTasks at once — calls are serialized through an internal promise
 * chain so the budget timeline is shared. This is what lets one limiter act as a
 * GLOBAL cap across every active download (IDM's "Speed Limiter"), while a
 * dedicated instance per task acts as a strict per-file cap.
 *
 * Rate is in bytes/sec; 0 (or negative) means unlimited and adds zero overhead.
 */
class RateLimiter {
  constructor(bytesPerSec = 0) {
    this.rate = bytesPerSec > 0 ? bytesPerSec : 0;
    this._tokens = 0;
    this._last = null;
    this._chain = Promise.resolve();
  }

  setRate(bytesPerSec) {
    this.rate = bytesPerSec > 0 ? bytesPerSec : 0;
  }

  get unlimited() {
    return !this.rate;
  }

  /**
   * Account for `bytes` about to be (or just) written. When the bucket runs a
   * deficit the caller sleeps off the difference while still holding the chain,
   * so every other consumer queues behind it and the aggregate rate converges
   * on `this.rate`.
   */
  async consume(bytes) {
    // Re-check inside as well: rate may flip to unlimited between calls.
    if (!this.rate) return;

    const prev = this._chain;
    let release;
    this._chain = new Promise((r) => {
      release = r;
    });
    await prev;

    try {
      if (!this.rate) return; // became unlimited while we waited our turn
      const now = Date.now();
      // Cap accumulated credit at ~0.25s worth (but never below one typical
      // chunk) so the measured rate hugs the limit instead of overshooting on a
      // large initial burst.
      const burst = Math.max(this.rate * 0.25, 64 * 1024);
      if (this._last == null) {
        this._last = now;
        this._tokens = 0;
      }
      this._tokens = Math.min(burst, this._tokens + ((now - this._last) / 1000) * this.rate);
      this._last = now;
      this._tokens -= bytes;
      if (this._tokens < 0) {
        await sleep((-this._tokens / this.rate) * 1000);
      }
    } finally {
      release();
    }
  }
}

module.exports = { RateLimiter };
