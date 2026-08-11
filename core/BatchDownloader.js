'use strict';

/**
 * Expands batch pattern URLs like:
 * - https://example.com/files/video_[1-20].mp4
 * - https://example.com/docs/chapter_[a-z].pdf
 */
function expandBatchUrl(patternUrl) {
  const urls = [];

  // Match numerical patterns like [1-50] or [01-50]
  const numMatch = /\[(\d+)-(\d+)\]/.exec(patternUrl);
  if (numMatch) {
    const startNum = parseInt(numMatch[1], 10);
    const endNum = parseInt(numMatch[2], 10);
    const padLen = numMatch[1].length;

    const step = startNum <= endNum ? 1 : -1;
    for (let i = startNum; step > 0 ? i <= endNum : i >= endNum; i += step) {
      const numStr = String(i).padStart(padLen, '0');
      urls.push(patternUrl.replace(numMatch[0], numStr));
    }
    return urls;
  }

  // Match alphabetical patterns like [a-z]
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

module.exports = { expandBatchUrl };
