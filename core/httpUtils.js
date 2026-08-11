'use strict';

const zlib = require('zlib');
const got = require('got');

// TLS certificate verification is ON. It used to be hardcoded OFF for every
// request in the app, which silently accepted ANY certificate — including on
// the requests that replay session cookies forwarded by the browser extension,
// making a download trivially interceptable on a hostile network.
//
// It can still be relaxed, but only by an explicit opt-in from config, for the
// legitimate cases (a self-signed NAS, a corporate MITM proxy).
let allowInsecureTLS = false;

function configureHttp({ allowInsecureTLS: insecure } = {}) {
  allowInsecureTLS = Boolean(insecure);
}

const client = got.extend({
  retry: { limit: 0 }, // We handle retries manually in DownloadTask
  timeout: { request: 30000 },
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
function request(urlStr, { method = 'GET', headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const stream = client.stream(urlStr, {
        method,
        headers: raw ? withIdentityEncoding(headers) : headers,
        decompress: !raw,
        https: { rejectUnauthorized: !allowInsecureTLS },
      });

      stream.on('response', (response) => {
        // Expose statusCode and headers on the stream object directly to simulate standard 'res'
        stream.statusCode = response.statusCode;
        stream.headers = response.headers;
        resolve({ res: stream, finalUrl: response.requestUrl || urlStr });
      });

      stream.on('error', (err) => {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
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

module.exports = { request, client, configureHttp, responseEncoding, createDecoder };
