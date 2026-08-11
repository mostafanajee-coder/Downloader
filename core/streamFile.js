'use strict';

const fs = require('fs');
const { request } = require('./httpUtils');

/**
 * Download a single URL to `finalPath` (via a .tmp then atomic rename).
 *
 * Used by the HLS and DASH engines for each media segment. Supports:
 *  - `rateLimiter`: a shared RateLimiter so segment downloads honour the global
 *    / per-file speed cap (previously HLS/DASH had no throttling at all).
 *  - `onBytes(len)`: called for every received chunk so the caller can track
 *    byte-accurate progress and transfer rate.
 *
 * When no throttling is required and no byte callback is given, it uses the fast
 * pipe() path. Otherwise it pumps chunks manually (pause/resume) so it can pace
 * to the limit without buffering the whole response in memory.
 */
function streamToFile(url, finalPath, { headers = {}, rateLimiter = null, onBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${finalPath}.tmp`;
    request(url, { method: 'GET', headers })
      .then(({ res }) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const ws = fs.createWriteStream(tmpPath);
        let settled = false;

        const fail = (err) => {
          if (settled) return;
          settled = true;
          res.destroy();
          ws.destroy();
          reject(err);
        };

        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            fs.renameSync(tmpPath, finalPath);
          } catch (e) {
            reject(e);
            return;
          }
          resolve();
        };

        res.on('error', fail);
        ws.on('error', fail);

        const throttled = rateLimiter && !rateLimiter.unlimited;

        if (!throttled && !onBytes) {
          // Fast path: let the pipe manage backpressure.
          res.pipe(ws);
          ws.on('finish', finish);
          return;
        }

        res.on('data', (chunk) => {
          if (settled) return;
          res.pause();
          (async () => {
            if (onBytes) onBytes(chunk.length);
            if (ws.write(chunk) === false) {
              await new Promise((r) => ws.once('drain', r));
            }
            if (throttled) await rateLimiter.consume(chunk.length);
            if (!settled) res.resume();
          })().catch(fail);
        });

        res.on('end', () => {
          if (settled) return;
          ws.end(finish);
        });
      })
      .catch(reject);
  });
}

module.exports = { streamToFile };
