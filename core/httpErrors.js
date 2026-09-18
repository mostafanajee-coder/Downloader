'use strict';

// Shared by probe() and DownloadTask so a bad status gets the SAME actionable
// wording whichever of them sees it first. Lives in its own module because
// probe is required by DownloadTask — defining these there would be circular.

// Statuses that will not change no matter how many times we ask. Retrying
// them five times with exponential backoff (~45s) just delays telling the
// user something they can act on — the message names the fix instead.
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);

function describeStatus(status, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* leave blank */
  }
  switch (status) {
    case 401:
      return `The server requires a login (HTTP 401). Add a Site Login for ${host || 'this host'} in Options → Connection, then resume.`;
    case 403:
      return `Access denied (HTTP 403). The link may have expired or need a login — try "Refresh download address" or add a Site Login for ${host || 'this host'}.`;
    case 404:
      return 'The file was not found on the server (HTTP 404). The link may have expired — try "Refresh download address".';
    case 407:
      return 'The proxy requires authentication (HTTP 407). Check the proxy username and password in Options → Proxy.';
    case 410:
      return 'The file is no longer available on the server (HTTP 410).';
    case 429:
      return 'The server is rate-limiting requests (HTTP 429). Fewer connections or a speed limit may help.';
    case 451:
      return 'The server refuses to serve this file for legal reasons (HTTP 451).';
    default:
      return `Unexpected status ${status}`;
  }
}

class HttpStatusError extends Error {
  constructor(status, url) {
    super(describeStatus(status, url));
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryable = !NON_RETRYABLE_STATUS.has(status);
  }
}

module.exports = { HttpStatusError, describeStatus, NON_RETRYABLE_STATUS };
