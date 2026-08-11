'use strict';

const path = require('path');
const { URL } = require('url');
const { request } = require('./httpUtils');

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

  const { res: headRes, finalUrl: headFinalUrl } = await request(urlStr, { method: 'HEAD', headers });
  headRes.resume();
  finalUrl = headFinalUrl;

  if (headRes.statusCode >= 200 && headRes.statusCode < 400) {
    acceptRanges = headRes.headers['accept-ranges'] === 'bytes';
    size = headRes.headers['content-length'] ? Number(headRes.headers['content-length']) : null;
    contentType = headRes.headers['content-type'] || null;
    contentDisposition = headRes.headers['content-disposition'] || null;
  }

  if (!acceptRanges || size === null) {
    const { res: rangeRes, finalUrl: rangeFinalUrl } = await request(urlStr, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
    });
    rangeRes.resume();
    finalUrl = rangeFinalUrl;

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
  }

  const filename = extractFilename(contentDisposition, finalUrl);
  return { size, acceptRanges, filename, finalUrl, contentType };
}

module.exports = { probe, extractFilename };
