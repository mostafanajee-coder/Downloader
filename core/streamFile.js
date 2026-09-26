'use strict';

const fs = require('fs');
const { request, responseEncoding, createStallGuard } = require('./httpUtils');

/**
 * Download a single URL to `finalPath` (via a .tmp then atomic rename).
 *
 * Used by the HLS and DASH engines for each media segment. Supports:
 *  - `rateLimiter`: a shared RateLimiter so segment downloads honour the global
 *    / per-file speed cap (previously HLS/DASH had no throttling at all).
 *  - `onBytes(len)`: called for every received chunk so the caller can track
 *    byte-accurate progress and transfer rate.
 *  - `range: { start, end }`: fetch only those bytes (inclusive), e.g. an HLS
 *    #EXT-X-BYTERANGE sub-range. The server MUST answer 206 with exactly that
 *    range — a 200 would be the whole resource, and writing that as one segment
 *    is how a byte-range playlist turned into N copies of the same file.
 *
 * Every body is watched by an idle guard (see httpUtils.createStallGuard): a
 * connection that stops delivering without closing used to hang the segment,
 * and with it the whole stream download, forever.
 */
function streamToFile(url, finalPath, { headers = {}, rateLimiter = null, onBytes = null, range = null } = {}) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${finalPath}.tmp`;
    const reqHeaders = { ...headers };
    const wantRange = range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start;
    if (wantRange) reqHeaders.Range = `bytes=${range.start}-${range.end}`;

    request(url, { method: 'GET', headers: reqHeaders })
      .then(({ res }) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        if (wantRange && res.statusCode !== 206) {
          res.destroy();
          const err = new Error('The server ignored a byte-range request that this stream depends on.');
          err.retryable = false;
          reject(err);
          return;
        }

        // Only an unencoded body can be checked against Content-Length (got
        // inflates gzip on this path, and the header counts compressed bytes).
        const declared =
          !responseEncoding(res) && res.headers['content-length'] != null ? Number(res.headers['content-length']) : null;
        let received = 0;

        const ws = fs.createWriteStream(tmpPath);
        let settled = false;

        const fail = (err) => {
          if (settled) return;
          settled = true;
          stall.clear();
          res.destroy();
          ws.destroy();
          reject(err);
        };

        const stall = createStallGuard(fail);

        const finish = () => {
          if (settled) return;
          settled = true;
          stall.clear();
          if (declared != null && Number.isFinite(declared) && received !== declared) {
            reject(new Error(`Truncated response: received ${received} of ${declared} bytes.`));
            return;
          }
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
          // Fast path: let the pipe manage backpressure; any data at all counts
          // as a sign of life.
          res.on('data', (chunk) => {
            received += chunk.length;
            stall.arm();
          });
          res.pipe(ws);
          ws.on('finish', finish);
          stall.arm();
          return;
        }

        res.on('data', (chunk) => {
          if (settled) return;
          res.pause();
          stall.disarm();
          received += chunk.length;
          (async () => {
            if (onBytes) onBytes(chunk.length);
            if (ws.write(chunk) === false) {
              await new Promise((r) => ws.once('drain', r));
            }
            if (throttled) await rateLimiter.consume(chunk.length);
            if (!settled) {
              stall.arm();
              res.resume();
            }
          })().catch(fail);
        });

        res.on('end', () => {
          if (settled) return;
          stall.disarm();
          ws.end(finish);
        });

        stall.arm();
      })
      .catch(reject);
  });
}

module.exports = { streamToFile };
