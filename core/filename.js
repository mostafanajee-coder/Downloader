'use strict';

const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const MAX_LENGTH = 150;

// Device names Windows reserves in every directory, with or without an
// extension: "CON.txt" can't be created at all, and "NUL.mp4" silently goes
// nowhere. They get an underscore rather than being rejected outright.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * A single path COMPONENT that is safe to create on Windows (and everywhere
 * else): no separators, no characters the filesystem rejects, no trailing
 * dots/spaces (which Windows strips, so the name on disk would silently differ
 * from the one we tracked), no reserved device names, and a bounded length
 * that keeps the extension intact.
 *
 * Every name that reaches the disk goes through here — including the ones a
 * server supplies via Content-Disposition or the URL path. Those are hostile
 * input: "..\\..\\Startup\\x.bat" or "a%2F..%2F..%2Fx.bat" used to be joined
 * straight onto the download folder.
 */
function sanitizeFilename(name, fallback) {
  if (!name || typeof name !== 'string') return fallback;

  let cleaned = name
    .normalize('NFC')
    .replace(INVALID_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');

  if (cleaned.length > MAX_LENGTH) cleaned = truncateKeepingExtension(cleaned, MAX_LENGTH);
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback;

  const dot = cleaned.indexOf('.');
  const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
  if (RESERVED_NAMES.test(stem.trim())) cleaned = `_${cleaned}`;

  return cleaned;
}

function truncateKeepingExtension(name, max) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stem = name.slice(0, name.length - ext.length);
  return `${stem.slice(0, Math.max(1, max - ext.length)).replace(/[.\s]+$/, '')}${ext}`;
}

/**
 * `name (2).ext`, `name (3).ext`, ... for the Nth candidate. The same scheme
 * Windows Explorer and every browser use, so a renamed duplicate is recognisable.
 */
function numberedVariant(name, n) {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 16;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  return `${stem} (${n})${ext}`;
}

module.exports = { sanitizeFilename, numberedVariant, MAX_LENGTH };
