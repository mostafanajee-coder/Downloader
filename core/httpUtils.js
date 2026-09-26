'use strict';

const zlib = require('zlib');
const got = require('got');

const { sharedResolver } = require('./proxy');

// TLS certificate verification is ON. It used to be hardcoded OFF for every
// request in the app, which silently accepted ANY certificate — including on
// the requests that replay session cookies forwarded by the browser extension,
// making a download trivially interceptable on a hostile network.
//
// It can still be relaxed, but only by an explicit opt-in from config, for the
// legitimate cases (a self-signed NAS, a corporate MITM proxy).
let allowInsecureTLS = false;

// Per-PHASE timeouts, never a cap on the whole request. This used to be
// `timeout: { request: 30000 }`, which got enforces from the first byte sent
// to the LAST byte received — so every connection was killed 30 seconds into
// its body. A multi-connection download only survived because each retry
// resumed where the last one stopped (and the retry budget eventually ran out
// on big files anyway); a server without range support restarted from zero
// every time and could never deliver a file that takes longer than 30s.
//
// A stalled body is caught by a separate idle watchdog instead (see
// stallTimeoutMs / createStallGuard), which only counts time spent WAITING on
// the network, not time the engine itself paused the socket to honour the
// speed limiter.
const DEFAULT_TIMEOUTS = {
  lookup: 20000,
  connect: 20000,
  secureConnect: 20000,
  send: 30000,
  response: 30000, // request fully sent -> response headers received
};
const DEFAULT_STALL_TIMEOUT_MS = 60000;

let phaseTimeouts = { ...DEFAULT_TIMEOUTS };
let stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS;

function configureHttp({ allowInsecureTLS: insecure, timeouts, stallTimeoutMs: stall } = {}) {
  allowInsecureTLS = Boolean(insecure);
  if (timeouts && typeof timeouts === 'object') phaseTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  if (Number.isFinite(stall) && stall > 0) stallTimeoutMs = stall;
}

/** How long a response body may go without delivering a byte before it counts as stalled. */
function getStallTimeoutMs() {
  return stallTimeoutMs;
}

/**
 * Idle watchdog for a streaming response body. `arm()` starts (or restarts)
 * the countdown and is called whenever the engine is waiting on the network;
 * `disarm()` stops it while the engine itself is holding the stream paused
 * (writing to disk, sleeping off the speed limit). `clear()` is final.
 */
function createStallGuard(onStall, ms = stallTimeoutMs) {
  let timer = null;
  let done = false;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    arm() {
      if (done) return;
      disarm();
      timer = setTimeout(() => {
        timer = null;
        if (done) return;
        const err = new Error(`Connection stalled: no data received for ${Math.round(ms / 1000)}s.`);
        err.code = 'ESTALLED';
        onStall(err);
      }, ms);
    },
    disarm,
    clear() {
      done = true;
      disarm();
    },
  };
}

const client = got.extend({
  retry: { limit: 0 }, // We handle retries manually in DownloadTask
  // A download engine inspects status codes itself (206 vs 200, 401 -> "add a
  // Site Login"). With the default, got rejected 4xx/5xx with its own generic
  // HTTPError before any of that logic ran.
  throwHttpErrors: false,
});

// Strips any caller-supplied Accept-Encoding (whatever its casing) and demands
// an unencoded body.
function withIdentityEncoding(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() !== 'accept-encoding') out[k] = v;
  }
  out['Accept-Encoding'] = 'identity';
  return out;
}

/**
 * `raw: true` asks for the bytes exactly as they sit on the origin server: no
 * transparent gunzip, and `Accept-Encoding: identity` so a well-behaved server
 * does not compress in the first place.
 *
 * Byte-exact transfer is what makes `Content-Length` describe the file that
 * lands on disk and `Range` offsets address real file positions — the resumable
 * download engine depends on both. When those assumptions broke, a gzipped
 * 512 KB file was written as a 544-byte file and reported as complete.
 *
 * Text fetches (HLS playlists, DASH manifests, crawled HTML) deliberately stay
 * on the default decoding path: they want the decoded string, and they do no
 * byte arithmetic.
 */
function request(urlStr, { method = 'GET', headers = {}, raw = false, totalTimeoutMs = 0 } = {}) {
  // A whole-request cap is only appropriate for small text fetches (playlists,
  // manifests, crawled pages), where "still going after a minute" means stuck.
  // Media transfers pass nothing and rely on the stall watchdog instead.
  const timeout = totalTimeoutMs > 0 ? { ...phaseTimeouts, request: totalTimeoutMs } : { ...phaseTimeouts };

  // Proxy resolution is async (PAC evaluation may need a DNS lookup), but it
  // costs nothing when no proxy is configured — `enabled` is false and this
  // short-circuits before touching the resolver.
  const agentPromise = sharedResolver.enabled
    ? sharedResolver.resolve(urlStr).then((descriptor) => {
        const secure = /^https:/i.test(urlStr);
        const agent = sharedResolver.agentFor(descriptor, secure);
        if (!agent) return undefined;
        return secure ? { https: agent } : { http: agent };
      })
    : Promise.resolve(undefined);

  return agentPromise.then(
    (agent) =>
      new Promise((resolve, reject) => {
        try {
          const stream = client.stream(urlStr, {
            method,
            headers: raw ? withIdentityEncoding(headers) : headers,
            decompress: !raw,
            timeout,
            https: { rejectUnauthorized: !allowInsecureTLS },
            ...(agent ? { agent } : {}),
          });

          stream.on('response', (response) => {
            // Expose statusCode and headers on the stream object directly to simulate standard 'res'
            stream.statusCode = response.statusCode;
            stream.headers = response.headers;
            // `url` is where the redirects ended; `requestUrl` is where they
            // started. This used to report requestUrl, so a file behind a
            // redirect was named after the redirector ("download.php"), and
            // an HLS/DASH manifest that redirected to a CDN resolved its
            // relative segment URLs against the wrong host and path.
            resolve({ res: stream, finalUrl: response.url || response.requestUrl || urlStr });
          });

          stream.on('error', (err) => {
            reject(err);
          });
        } catch (e) {
          reject(e);
        }
      })
  );
}

/** Push proxy settings into the shared resolver used by every request. */
function configureProxy(settings) {
  sharedResolver.configure(settings || { mode: 'direct' });
}

function describeProxy() {
  return sharedResolver.describe();
}

/**
 * The response's Content-Encoding, or null when the body is already unencoded.
 * Callers that do byte arithmetic must check this: a server is free to ignore
 * `Accept-Encoding: identity`, and a compressed body means neither the
 * advertised length nor any byte offset refers to the bytes we will write.
 */
function responseEncoding(res) {
  const enc = String((res.headers && res.headers['content-encoding']) || '')
    .trim()
    .toLowerCase();
  if (!enc || enc === 'identity') return null;
  return enc;
}

/** Inflater for a Content-Encoding, or null if we can't handle that encoding. */
function createDecoder(encoding) {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

module.exports = {
  request,
  client,
  configureHttp,
  configureProxy,
  describeProxy,
  responseEncoding,
  createDecoder,
  createStallGuard,
  getStallTimeoutMs,
};
