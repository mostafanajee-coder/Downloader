'use strict';

const { URL } = require('url');
const { request } = require('./httpUtils');
const m3u8Parser = require('m3u8-parser');

async function fetchText(urlStr, headers = {}) {
  // Playlists are small: a whole-request cap is right here (a stuck fetch
  // would otherwise hold the download at "starting" forever).
  const { res, finalUrl } = await request(urlStr, { method: 'GET', headers, totalTimeoutMs: 60000 });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`Failed to fetch playlist: HTTP ${res.statusCode} for ${urlStr}`);
  }
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { text: Buffer.concat(chunks).toString('utf8'), finalUrl };
}

function parseMasterPlaylist(text, baseUrl) {
  const parser = new m3u8Parser.Parser();
  parser.push(text);
  parser.end();

  const manifest = parser.manifest;
  const variants = [];

  if (manifest.playlists && manifest.playlists.length > 0) {
    for (const p of manifest.playlists) {
      variants.push({
        bandwidth: p.attributes.BANDWIDTH || null,
        resolution: p.attributes.RESOLUTION ? `${p.attributes.RESOLUTION.width}x${p.attributes.RESOLUTION.height}` : null,
        codecs: p.attributes.CODECS || null,
        url: new URL(p.uri, baseUrl).toString(),
      });
    }
  }
  return variants;
}

function parseMediaPlaylist(text, baseUrl) {
  const parser = new m3u8Parser.Parser();
  try {
    parser.push(text);
    parser.end();
  } catch (err) {
    throw new Error(`Invalid HLS playlist: ${err.message}`);
  }

  const manifest = parser.manifest;
  const segments = [];
  const mediaSequence = Number.isFinite(manifest.mediaSequence) ? manifest.mediaSequence : 0;

  let mapUri = null;
  let mapRange = null;
  if (manifest.segments && manifest.segments.length > 0) {
    for (let i = 0; i < manifest.segments.length; i++) {
      const seg = manifest.segments[i];
      // m3u8-parser carries the current #EXT-X-MAP onto every segment after
      // it. A playlist may switch init segments (typically at a
      // discontinuity), so each segment keeps its own.
      let map = null;
      if (seg.map && seg.map.uri) {
        map = { uri: new URL(seg.map.uri, baseUrl).toString(), range: toRange(seg.map.byterange) };
        if (!mapUri) {
          mapUri = map.uri;
          mapRange = map.range;
        }
      }

      let key = null;
      if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
        key = {
          method: seg.key.method,
          uri: seg.key.uri ? new URL(seg.key.uri, baseUrl).toString() : null,
          iv: ivToHex(seg.key.iv),
        };
      }

      segments.push({
        index: i,
        // The number the spec derives an implicit AES-128 IV from.
        sequence: mediaSequence + i,
        url: new URL(seg.uri, baseUrl).toString(),
        duration: seg.duration,
        key,
        // #EXT-X-BYTERANGE: this segment is a slice of a larger resource.
        range: toRange(seg.byterange),
        discontinuity: Boolean(seg.discontinuity),
        map,
      });
    }
  }

  // A playlist with no #EXT-X-ENDLIST is still being written to: a live
  // stream (or an event stream that hasn't ended). Downloading it would grab
  // whatever segments sit in the sliding window and stop, silently truncated.
  const live = !manifest.endList;

  // SAMPLE-AES / SAMPLE-AES-CTR is FairPlay-style DRM: the key is never
  // fetchable, so the .ts files would remux into unplayable garbage. Plain
  // AES-128 with a URI is fine — we download the key and ffmpeg decrypts.
  const drm = detectHlsDrm(text, segments);

  return { segments, mapUri, mapRange, mediaSequence, encrypted: Boolean(segments.find((s) => s.key)), live, drm };
}

/** m3u8-parser's { length, offset } -> inclusive { start, end }, or null. */
function toRange(byterange) {
  if (!byterange || !Number.isFinite(byterange.length) || byterange.length <= 0) return null;
  const start = Number.isFinite(byterange.offset) ? byterange.offset : 0;
  return { start, end: start + byterange.length - 1 };
}

/**
 * m3u8-parser hands IVs back as a Uint32Array. Interpolated straight into the
 * local playlist that became "IV=19088743,2309737967,..." — which ffmpeg does
 * not recognise as an IV at all, silently falling back to the sequence number
 * and decrypting every segment into noise. Normalise to the 0x-hex form the
 * playlist syntax requires.
 */
function ivToHex(iv) {
  if (iv == null) return null;
  if (typeof iv === 'string') {
    const hex = iv.replace(/^0x/i, '');
    return /^[0-9a-f]{1,32}$/i.test(hex) ? `0x${hex.padStart(32, '0').toLowerCase()}` : null;
  }
  if (ArrayBuffer.isView(iv) || Array.isArray(iv)) {
    const words = Array.from(iv);
    if (words.length !== 4) return null;
    return `0x${words.map((w) => (Number(w) >>> 0).toString(16).padStart(8, '0')).join('')}`;
  }
  return null;
}

/**
 * The IV a segment is decrypted with: its explicit IV, or — per RFC 8216
 * §5.2 — its media sequence number as a 128-bit big-endian integer. Written
 * out explicitly because the local playlist renumbers segments from zero.
 */
function segmentIv(seg) {
  if (seg.key && seg.key.iv) return seg.key.iv;
  const seq = BigInt(Math.max(0, Math.floor(Number(seg.sequence) || 0)));
  return `0x${seq.toString(16).padStart(32, '0')}`;
}

// Friendly names for the DRM systems that show up in HLS playlists. Newer
// m3u8-parser versions file non-identity KEYFORMATs under the manifest's
// contentProtection rather than each segment's `key`, so the playlist TEXT is
// the reliable place to look.
const HLS_DRM_SYSTEMS = [
  [/com\.apple\.streamingkeydelivery/i, 'FairPlay'],
  [/urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|com\.widevine/i, 'Widevine'],
  [/com\.microsoft\.playready|urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95/i, 'PlayReady'],
];

function detectHlsDrm(text, segments) {
  const found = [];
  for (const [re, name] of HLS_DRM_SYSTEMS) {
    if (re.test(text)) found.push(name);
  }
  // SAMPLE-AES without a recognised system is still DRM: the key is delivered
  // out of band and the segments cannot be decrypted by ffmpeg.
  const sampleAes =
    /METHOD=SAMPLE-AES/i.test(text) || segments.some((s) => s.key && /^SAMPLE-AES/i.test(s.key.method || ''));
  if (sampleAes && !found.length) found.push('SAMPLE-AES');
  return found.length ? found.join(', ') : null;
}

async function resolvePlaylist(urlStr, headers = {}) {
  const { text, finalUrl } = await fetchText(urlStr, headers);
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMasterPlaylist(text, finalUrl).sort(
      (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)
    );
    return { type: 'master', variants, finalUrl };
  }
  const media = parseMediaPlaylist(text, finalUrl);
  return { type: 'media', ...media, finalUrl };
}

module.exports = { resolvePlaylist, parseMasterPlaylist, parseMediaPlaylist, fetchText, ivToHex, segmentIv };
