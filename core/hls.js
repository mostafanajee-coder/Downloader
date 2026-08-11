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
  parser.push(text);
  parser.end();

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

  return { segments, mapUri, encrypted: Boolean(segments.find((s) => s.key)) };
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
