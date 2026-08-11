'use strict';

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const MAX_LENGTH = 150;

function sanitizeFilename(name, fallback) {
  if (!name || typeof name !== 'string') return fallback;

  let cleaned = name
    .replace(INVALID_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');

  if (cleaned.length > MAX_LENGTH) cleaned = cleaned.slice(0, MAX_LENGTH).trim();

  return cleaned || fallback;
}

module.exports = { sanitizeFilename };
