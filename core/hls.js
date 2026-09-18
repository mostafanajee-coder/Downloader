'use strict';

const { URL } = require('url');
const { request } = require('./httpUtils');
const m3u8Parser = require('m3u8-parser');

async function fetchText(urlStr, headers = {}) {
  const { res, finalUrl } = await request(urlStr, { method: 'GET', headers });
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

  let mapUri = null;
  if (manifest.segments && manifest.segments.length > 0) {
    for (let i = 0; i < manifest.segments.length; i++) {
      const seg = manifest.segments[i];
      if (seg.map && seg.map.uri) mapUri = new URL(seg.map.uri, baseUrl).toString();

      let key = null;
      if (seg.key && seg.key.method && seg.key.method !== 'NONE') {
        key = {
          method: seg.key.method,
          uri: seg.key.uri ? new URL(seg.key.uri, baseUrl).toString() : null,
          iv: seg.key.iv || null,
        };
      }

      segments.push({
        index: i,
        url: new URL(seg.uri, baseUrl).toString(),
        duration: seg.duration,
        key,
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

  return { segments, mapUri, encrypted: Boolean(segments.find((s) => s.key)), live, drm };
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

module.exports = { resolvePlaylist, parseMasterPlaylist, parseMediaPlaylist, fetchText };
