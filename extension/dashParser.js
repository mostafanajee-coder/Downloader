'use strict';

/**
 * Lightweight MPEG-DASH manifest (.mpd) variant lister for the extension's
 * service worker context.
 *
 * This is a deliberate, trimmed browser-side port of the video/audio
 * Representation extraction in core/dash.js: same tiny XML parser, same
 * AdaptationSet/Representation walk, and — critically — the SAME sort order
 * (height desc, then bandwidth desc) so that the Nth entry here is the exact
 * representation core/dashDownloadTask.js will pick when the app receives
 * `variantIndex: N`. It intentionally skips SegmentTemplate/SegmentTimeline
 * expansion (core/dash.js's buildFromTemplate/buildFromList) since listing
 * qualities in a popup only needs Representation metadata, not the full
 * segment list — expanding thousands of segment URLs on every hover would be
 * wasted work in a browser context with a tight response-time budget.
 *
 * Runs as a classic (non-module) service-worker script via importScripts(),
 * so it can't use Node's `require('url')` — it relies on the global `URL`
 * constructor, which is available in both browsers and service workers.
 */

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) attrs[m[1]] = m[2];
    else attrs[m[3]] = m[4];
  }
  return attrs;
}

function parseXml(xml) {
  xml = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tagRe =
    /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*"|\s+[\w:.-]+\s*=\s*'[^']*')*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    if (m[5] !== undefined) {
      const t = m[5].trim();
      if (t) stack[stack.length - 1].text += t;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2];
    const selfClose = m[4] === '/';
    if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const node = { name, attrs: parseAttrs(m[3] || ''), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  return root;
}

const local = (name) => name.split(':').pop();
const find = (node, tag) => node.children.find((c) => local(c.name) === tag);
const findAll = (node, tag) => node.children.filter((c) => local(c.name) === tag);

/**
 * Parse an MPD's video/audio Representations (no segment expansion).
 * Returns { video: [{width,height,bandwidth,codecs,mimeType}], audio: [...] }
 * sorted identically to core/dash.js's parseMpd().
 */
function parseMpdVariants(xml) {
  const root = parseXml(xml);
  const mpd = find(root, 'MPD');
  if (!mpd) throw new Error('Not a valid MPD manifest');

  const period = find(mpd, 'Period');
  if (!period) throw new Error('MPD has no Period');

  const video = [];
  const audio = [];

  for (const set of findAll(period, 'AdaptationSet')) {
    let contentType = set.attrs.contentType || '';
    const setMime = set.attrs.mimeType || '';
    const reps = findAll(set, 'Representation');
    if (!contentType) {
      const mime = setMime || (reps[0] && reps[0].attrs.mimeType) || '';
      if (mime.startsWith('video/')) contentType = 'video';
      else if (mime.startsWith('audio/')) contentType = 'audio';
    }

    for (const repNode of reps) {
      const rep = {
        id: repNode.attrs.id || '',
        bandwidth: Number(repNode.attrs.bandwidth || 0),
        width: repNode.attrs.width ? Number(repNode.attrs.width) : null,
        height: repNode.attrs.height ? Number(repNode.attrs.height) : null,
        codecs: repNode.attrs.codecs || set.attrs.codecs || null,
        mimeType: repNode.attrs.mimeType || setMime || null,
      };
      if (contentType === 'video') video.push(rep);
      else if (contentType === 'audio') audio.push(rep);
      else if (rep.height || (rep.mimeType || '').startsWith('video/')) video.push(rep);
      else audio.push(rep);
    }
  }

  video.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  audio.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  return { video, audio };
}

if (typeof self !== 'undefined') {
  self.parseMpdVariants = parseMpdVariants;
}
