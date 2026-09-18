'use strict';

/**
 * IDM's "Site Logins" (Options → Logins): a per-host username/password that is
 * attached automatically to every download from that host. Stored in config as
 * `siteLogins: [{ host, username, password }]`.
 *
 * Matching is by hostname, with `*.example.com`-style globs accepted so one
 * entry covers a CDN and its subdomains. Only HTTP Basic is emitted here —
 * that is what the overwhelming majority of password-protected direct
 * downloads (NAS boxes, private mirrors, Nextcloud shares) actually use.
 */
function hostMatches(pattern, hostname) {
  const p = String(pattern || '').trim().toLowerCase();
  const h = String(hostname || '').toLowerCase();
  if (!p || !h) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }
  return false;
}

function findLogin(logins, urlStr) {
  if (!Array.isArray(logins) || !logins.length) return null;
  let host;
  try {
    host = new URL(urlStr).hostname;
  } catch (e) {
    return null;
  }
  // Prefer an exact host over a wildcard so a specific override wins.
  const exact = logins.find((l) => l && l.username && String(l.host || '').toLowerCase() === host.toLowerCase());
  if (exact) return exact;
  return logins.find((l) => l && l.username && hostMatches(l.host, host)) || null;
}

function basicAuthHeader(login) {
  const token = Buffer.from(`${login.username}:${login.password || ''}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

/**
 * Returns `headers` with an Authorization header added when a login matches
 * and the caller hasn't already supplied one. Never overwrites an explicit
 * header — a browser-captured Bearer token must not be clobbered.
 */
function applySiteLogin(logins, urlStr, headers = {}) {
  const hasAuth = Object.keys(headers || {}).some((k) => k.toLowerCase() === 'authorization');
  if (hasAuth) return headers;
  const login = findLogin(logins, urlStr);
  if (!login) return headers;
  return { ...headers, Authorization: basicAuthHeader(login) };
}

module.exports = { findLogin, applySiteLogin, hostMatches, basicAuthHeader };
