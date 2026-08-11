'use strict';

const MIN_SEGMENT_SIZE = 5 * 1024 * 1024; // 5MB per segment minimum

function planSegments(size, maxConnections) {
  let n = Math.min(maxConnections, Math.max(1, Math.floor(size / MIN_SEGMENT_SIZE)));
  if (n < 1) n = 1;

  const segSize = Math.ceil(size / n);
  const segments = [];
  for (let i = 0; i < n; i++) {
    const start = i * segSize;
    const end = Math.min(start + segSize - 1, size - 1);
    if (start > end) break;
    segments.push({ index: i, start, end, downloaded: 0 });
  }
  return segments;
}

module.exports = { planSegments, MIN_SEGMENT_SIZE };
