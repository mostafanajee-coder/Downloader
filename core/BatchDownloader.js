'use strict';

// Safety cap on how many URLs a single pattern can expand to. Manager.add()
// runs every URL through this — without a cap, a pattern like
// "http://x/[1-999999].mp4" typed into the plain Add-URL box (no preview,
// no confirmation) would try to enqueue ~1M downloads and could hang or
// crash the app.
const MAX_EXPANSION = 1000;

/**
 * Expands batch pattern URLs like:
 * - https://example.com/files/video_[1-20].mp4
 * - https://example.com/files/video_[01-20].mp4       (2-digit padding, inferred from "01")
 * - https://example.com/files/video_[1-20]%03d.mp4     (explicit 3-digit padding, overrides inference)
 * - https://example.com/docs/chapter_[a-z].pdf
 *
 * `padWidth`, if given, overrides both the bracket's own inferred padding and
 * any inline %0Nd token — this is what the Batch Download modal's "Leading
 * zero digits" field uses, so users never have to hand-write printf syntax.
 */
function expandBatchUrl(patternUrl, { padWidth } = {}) {
  const urls = [];

  // Match numerical patterns like [1-50] or [01-50], with an optional
  // immediately-following printf-style width override: [1-500]%03d
  const numMatch = /\[(\d+)-(\d+)\](?:%0(\d+)d)?/.exec(patternUrl);
  if (numMatch) {
    const startNum = parseInt(numMatch[1], 10);
    const endNum = parseInt(numMatch[2], 10);
    const inlinePad = numMatch[3] != null ? Number(numMatch[3]) : null;
    const padLen = padWidth != null ? padWidth : inlinePad != null ? inlinePad : numMatch[1].length;

    const step = startNum <= endNum ? 1 : -1;
    let n = 0;
    for (let i = startNum; (step > 0 ? i <= endNum : i >= endNum) && n < MAX_EXPANSION; i += step, n++) {
      const numStr = String(i).padStart(padLen, '0');
      urls.push(patternUrl.replace(numMatch[0], numStr));
    }
    return urls;
  }

  // Match alphabetical patterns like [a-z] — inherently bounded to 26, no cap needed.
  const alphaMatch = /\[([a-zA-Z])-([a-zA-Z])\]/.exec(patternUrl);
  if (alphaMatch) {
    const startChar = alphaMatch[1].charCodeAt(0);
    const endChar = alphaMatch[2].charCodeAt(0);
    const step = startChar <= endChar ? 1 : -1;

    for (let i = startChar; step > 0 ? i <= endChar : i >= endChar; i += step) {
      const charStr = String.fromCharCode(i);
      urls.push(patternUrl.replace(alphaMatch[0], charStr));
    }
    return urls;
  }

  return [patternUrl];
}

module.exports = { expandBatchUrl, MAX_EXPANSION };
