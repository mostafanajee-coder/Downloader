'use strict';

const path = require('path');
const { URL } = require('url');
const { request, responseEncoding } = require('./httpUtils');
const { HttpStatusError, NON_RETRYABLE_STATUS } = require('./httpErrors');

function extractFilename(contentDisposition, urlStr) {
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8'')?"?([^";\n]+)"?/i.exec(contentDisposition);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
  }
  try {
    const u = new URL(urlStr);
    const base = decodeURIComponent(path.basename(u.pathname));
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
  }

  if (!acceptRanges || size === null) {
    const { res: rangeRes, finalUrl: rangeFinalUrl } = await request(urlStr, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      raw: true,
    });
    rangeRes.resume();
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
        const m = /\/(\d+)$/.exec(cr);
        if (m) size = Number(m[1]);
      }
    } else if (rangeRes.statusCode === 200) {
      acceptRanges = false;
      size = rangeRes.headers['content-length'] ? Number(rangeRes.headers['content-length']) : size;
    }
    contentType = contentType || rangeRes.headers['content-type'] || null;
    contentDisposition = contentDisposition || rangeRes.headers['content-disposition'] || null;
    contentEncoding = contentEncoding || responseEncoding(rangeRes);
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

  const filename = extractFilename(contentDisposition, finalUrl);
  return { size, acceptRanges, filename, finalUrl, contentType, contentEncoding };
}

module.exports = { probe, extractFilename };
