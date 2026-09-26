'use strict';

const path = require('path');
const { URL } = require('url');
const { request, responseEncoding } = require('./httpUtils');
const { HttpStatusError, NON_RETRYABLE_STATUS } = require('./httpErrors');

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The filename a Content-Disposition header names, per RFC 6266: the
 * RFC 5987 `filename*=charset'lang'value` form wins over plain `filename=`
 * (that one is the ASCII fallback for old clients), and a quoted value may
 * contain `;` and escaped quotes. Returns null when the header names nothing.
 *
 * The result is NOT safe to use as a path yet — callers must sanitise it.
 */
function parseContentDisposition(header) {
  if (!header || typeof header !== 'string') return null;

  const ext = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (ext) {
    const charset = ext[1].trim().toLowerCase();
    const value = ext[2].trim().replace(/^"(.*)"$/, '$1');
    if (!charset || charset === 'utf-8' || charset === 'utf8') return safeDecode(value);
    // ISO-8859-1 percent-escapes are single bytes, not UTF-8 sequences.
    return value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');

  const bare = /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(header);
  if (bare) {
    const value = bare[1].trim();
    // Plenty of servers percent-encode a bare filename despite the RFC.
    return /%[0-9a-f]{2}/i.test(value) ? safeDecode(value) : value;
  }
  return null;
}

function extractFilename(contentDisposition, urlStr) {
  const fromHeader = parseContentDisposition(contentDisposition);
  if (fromHeader && fromHeader.trim()) return fromHeader.trim();
  try {
    const u = new URL(urlStr);
    const base = safeDecode(path.posix.basename(u.pathname));
    return base || 'download';
  } catch {
    return 'download';
  }
}

async function probe(urlStr, headers = {}) {
  let size = null;
  let acceptRanges = false;
  let finalUrl = urlStr;
  let contentType = null;
  let contentDisposition = null;
  let contentEncoding = null;
  let etag = null;
  let lastModified = null;

  const readValidators = (res) => {
    etag = etag || res.headers.etag || null;
    lastModified = lastModified || res.headers['last-modified'] || null;
  };

  // `raw` throughout: the numbers this function returns are used to lay out
  // byte ranges in the destination file, so they have to describe the bytes as
  // stored, not a transparently-decoded view of them.
  const { res: headRes, finalUrl: headFinalUrl } = await request(urlStr, { method: 'HEAD', headers, raw: true });
  headRes.resume();
  finalUrl = headFinalUrl;

  if (headRes.statusCode >= 200 && headRes.statusCode < 400) {
    acceptRanges = headRes.headers['accept-ranges'] === 'bytes';
    size = headRes.headers['content-length'] ? Number(headRes.headers['content-length']) : null;
    contentType = headRes.headers['content-type'] || null;
    contentDisposition = headRes.headers['content-disposition'] || null;
    contentEncoding = responseEncoding(headRes);
    readValidators(headRes);
  }

  if (!acceptRanges || size === null) {
    const { res: rangeRes, finalUrl: rangeFinalUrl } = await request(urlStr, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      raw: true,
    });
    // Only the headers matter here. A server that ignores Range answers with
    // the ENTIRE file, and resume() would quietly download all of it in the
    // background just to throw it away — abort the body instead.
    rangeRes.destroy();
    finalUrl = rangeFinalUrl;

    // A definitive refusal (401/403/404/410...) is not something more
    // requests will change. Stop here with a message that names the fix,
    // rather than laying out segments for a file we will never be sent.
    if (NON_RETRYABLE_STATUS.has(rangeRes.statusCode)) {
      throw new HttpStatusError(rangeRes.statusCode, rangeFinalUrl || urlStr);
    }

    if (rangeRes.statusCode === 206) {
      acceptRanges = true;
      const cr = rangeRes.headers['content-range'];
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) size = Number(m[1]);
      }
    } else if (rangeRes.statusCode === 200) {
      acceptRanges = false;
      size = rangeRes.headers['content-length'] ? Number(rangeRes.headers['content-length']) : size;
    }
    contentType = contentType || rangeRes.headers['content-type'] || null;
    contentDisposition = contentDisposition || rangeRes.headers['content-disposition'] || null;
    contentEncoding = contentEncoding || responseEncoding(rangeRes);
    readValidators(rangeRes);
  }

  // A server that compresses anyway (despite Accept-Encoding: identity)
  // invalidates both numbers above: Content-Length counts the COMPRESSED bytes,
  // not what will be written, and byte ranges address compressed offsets.
  // Reporting that length as the file size is what truncated a 512 KB gzipped
  // file to 544 bytes and then declared it complete. Fall back to an
  // unknown-length, non-resumable single stream — slower, but always correct.
  if (contentEncoding) {
    size = null;
    acceptRanges = false;
  }

  if (!Number.isFinite(size) || size < 0) size = null;

  const filename = extractFilename(contentDisposition, finalUrl);
  return { size, acceptRanges, filename, finalUrl, contentType, contentEncoding, etag, lastModified };
}

module.exports = { probe, extractFilename, parseContentDisposition };
