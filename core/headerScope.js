'use strict';

const net = require('net');

/**
 * Keeps credentials attached to the host they were issued for.
 *
 * A download's headers are captured once, for ONE url: the browser extension
 * copies the cookies it would have sent there, and a Site Login becomes an
 * Authorization header for that host. The engine then talks to other hosts
 * with the same header set — the CDN a download redirected to, the edge that
 * serves an HLS playlist's segments, a key server. got strips Cookie and
 * Authorization when IT follows a cross-host redirect, but the engine then
 * requests the post-redirect URL directly for every segment, which re-sent the
 * original site's session cookie and Basic credentials to the third party on
 * every single request.
 *
 * Rules, matching what a browser (and curl) would send:
 *   - Authorization only goes to the exact origin host and port it was meant for.
 *   - Cookie goes anywhere on the same site (www.example.com -> media.example.com
 *     is normal for signed-cookie CDNs), never to an unrelated site.
 *   - Neither ever downgrades from https to plain http.
 */

// Second-level labels that are registries rather than sites under a two-letter
// country code (example.co.uk, example.com.au). A heuristic, not the Public
// Suffix List — it errs towards treating hosts as DIFFERENT sites, which only
// ever costs a cookie, never leaks one.
const REGISTRY_SLD = /^(co|com|net|org|gov|edu|ac|or|ne|go|mil|nic|gen|biz|info|ltd|plc|sch|nom|web)$/;

function siteOf(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || net.isIP(h) || h.startsWith('[') || !h.includes('.')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && REGISTRY_SLD.test(sld)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ftp:': '21' };

function originKey(u) {
  return `${u.hostname.toLowerCase()}:${u.port || DEFAULT_PORTS[u.protocol] || ''}`;
}

function parse(urlStr) {
  try {
    return new URL(urlStr);
  } catch (e) {
    return null;
  }
}

/**
 * The headers to send to `targetUrl`, given that `headers` were captured for
 * `originUrl`. Returns the same object when nothing needs removing.
 */
function scopeHeaders(originUrl, targetUrl, headers) {
  if (!headers || !originUrl || !targetUrl || originUrl === targetUrl) return headers;
  const from = parse(originUrl);
  const to = parse(targetUrl);
  if (!from || !to) return headers;

  const downgrade = from.protocol === 'https:' && to.protocol !== 'https:';
  const dropAuth = downgrade || originKey(from) !== originKey(to);
  const dropCookie = downgrade || siteOf(from.hostname) !== siteOf(to.hostname);
  if (!dropAuth && !dropCookie) return headers;

  const out = {};
  let changed = false;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if ((dropAuth && lower === 'authorization') || (dropCookie && lower === 'cookie')) {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? out : headers;
}

// Headers the ENGINE owns. A captured header set containing any of these
// would fight the transfer logic: a stray Range corrupts every segment's
// offset, a stale If-Range forces restarts, a Host/Content-Length/
// Transfer-Encoding breaks the request outright.
const ENGINE_OWNED = new Set([
  'host',
  'range',
  'if-range',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'accept-encoding',
  'proxy-authorization',
  'proxy-connection',
]);

const MAX_HEADERS = 64;
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * A request-header object that is safe to hand to the engine: string values
 * only, no CR/LF (header injection), nothing the engine manages itself, and a
 * bounded size. Anything unexpected is dropped rather than rejected, because
 * these arrive from browser captures that are messy but legitimate.
 */
function sanitizeRequestHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  let count = 0;
  let bytes = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (count >= MAX_HEADERS) break;
    if (typeof k !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) continue;
    if (ENGINE_OWNED.has(k.toLowerCase())) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const value = String(v);
    if (/[\r\n\0]/.test(value)) continue;
    bytes += k.length + value.length;
    if (bytes > MAX_HEADER_BYTES) break;
    out[k] = value;
    count++;
  }
  return out;
}

module.exports = { scopeHeaders, siteOf, sanitizeRequestHeaders };
