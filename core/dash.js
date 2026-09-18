'use strict';

const { URL } = require('url');

/**
 * MPEG-DASH manifest (.mpd) parser & segment planner.
 *
 * Handles the shapes seen in real-world VOD manifests:
 *  - SegmentTemplate with $Number$ (duration-based) segment lists
 *  - SegmentTemplate with a <SegmentTimeline> (S @t/@d/@r) for variable timing
 *  - $Time$ / $Number$ / $RepresentationID$ / $Bandwidth$ placeholders, incl.
 *    printf padding like $Number%05d$
 *  - SegmentList (explicit <SegmentURL>)
 *  - SegmentBase / plain <BaseURL> single-file on-demand representations
 *  - Cumulative BaseURL resolution (MPD > Period > AdaptationSet > Representation)
 *
 * Output separates video and audio adaptation sets so the caller can pick one of
 * each and mux them together with ffmpeg.
 */

// --- tiny XML parser -> {name, attrs, children, text} ------------------------

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

// --- helpers -----------------------------------------------------------------

function parseDuration(s) {
  if (!s) return 0;
  const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/.exec(s);
  if (!m) return 0;
  return (
    Number(m[3] || 0) * 86400 +
    Number(m[4] || 0) * 3600 +
    Number(m[5] || 0) * 60 +
    Number(m[6] || 0)
  );
}

// Fold a chain of (possibly relative) BaseURL values onto the manifest URL.
function resolveBase(manifestUrl, bases) {
  let base = manifestUrl;
  for (const b of bases) {
    if (b) base = new URL(b, base).toString();
  }
  return base;
}

function fillTemplate(tpl, vars) {
  if (!tpl) return tpl;
  return tpl.replace(/\$(\$|RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (m, key, pad) => {
    if (key === '$') return '$';
    let v = vars[key];
    if (v == null) return m;
    v = String(v);
    if (pad) v = v.padStart(Number(pad), '0');
    return v;
  });
}

// First BaseURL text child, if any.
function baseUrlOf(node) {
  const b = find(node, 'BaseURL');
  return b && b.text ? b.text : null;
}

// --- segment planning per representation --------------------------------------

function buildFromTemplate(tpl, rep, baseUrl, durationSec) {
  const timescale = Number(tpl.attrs.timescale || 1);
  const startNumber = Number(tpl.attrs.startNumber || 1);
  const media = tpl.attrs.media;
  const initTpl = tpl.attrs.initialization;

  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const initUrl = initTpl ? new URL(fillTemplate(initTpl, vars), baseUrl).toString() : null;

  const segments = [];
  const timeline = find(tpl, 'SegmentTimeline');

  if (timeline) {
    let number = startNumber;
    let time = 0;
    let first = true;
    for (const s of findAll(timeline, 'S')) {
      const d = Number(s.attrs.d);
      if (s.attrs.t != null) time = Number(s.attrs.t);
      else if (first && s.attrs.t == null) time = 0;
      const repeat = Number(s.attrs.r || 0); // r = additional repeats
      for (let i = 0; i <= repeat; i++) {
        const url = new URL(fillTemplate(media, { ...vars, Number: number, Time: time }), baseUrl).toString();
        segments.push({ url });
        number++;
        time += d;
      }
      first = false;
    }
  } else if (tpl.attrs.duration) {
    const segDur = Number(tpl.attrs.duration) / timescale;
    const count = segDur > 0 && durationSec > 0 ? Math.ceil(durationSec / segDur) : 0;
    for (let i = 0; i < count; i++) {
      const number = startNumber + i;
      const time = i * Number(tpl.attrs.duration);
      const url = new URL(fillTemplate(media, { ...vars, Number: number, Time: time }), baseUrl).toString();
      segments.push({ url });
    }
  }

  return { initUrl, segments, isSingleFile: false };
}

function buildFromList(segList, rep, baseUrl) {
  let initUrl = null;
  const init = find(segList, 'Initialization');
  if (init && init.attrs.sourceURL) initUrl = new URL(init.attrs.sourceURL, baseUrl).toString();

  const segments = findAll(segList, 'SegmentURL')
    .map((s) => s.attrs.media)
    .filter(Boolean)
    .map((u) => ({ url: new URL(u, baseUrl).toString() }));

  return { initUrl, segments, isSingleFile: false };
}

function buildRepresentation(repNode, inherited, baseUrl, durationSec) {
  const rep = {
    id: repNode.attrs.id || '',
    bandwidth: Number(repNode.attrs.bandwidth || 0),
    width: repNode.attrs.width ? Number(repNode.attrs.width) : null,
    height: repNode.attrs.height ? Number(repNode.attrs.height) : null,
    codecs: repNode.attrs.codecs || inherited.codecs || null,
    mimeType: repNode.attrs.mimeType || inherited.mimeType || null,
    lang: inherited.lang || null,
  };

  // Representation-level BaseURL folds onto the inherited base.
  const repBase = baseUrlOf(repNode);
  const effBase = repBase ? new URL(repBase, baseUrl).toString() : baseUrl;

  // SegmentTemplate: representation-level overrides adaptation-level.
  const tpl = find(repNode, 'SegmentTemplate') || inherited.segmentTemplate;
  const segList = find(repNode, 'SegmentList') || inherited.segmentList;

  let plan;
  if (tpl) {
    plan = buildFromTemplate(tpl, rep, effBase, durationSec);
  } else if (segList) {
    plan = buildFromList(segList, rep, effBase);
  } else {
    // Single-file on-demand (SegmentBase or bare BaseURL): the representation IS
    // one complete file. Download it whole and let ffmpeg read it directly.
    plan = { initUrl: null, segments: [], isSingleFile: true, url: effBase };
  }

  return { ...rep, ...plan };
}

// --- public API --------------------------------------------------------------

function parseMpd(xml, manifestUrl) {
  const root = parseXml(xml);
  const mpd = find(root, 'MPD');
  if (!mpd) throw new Error('Not a valid MPD manifest');

  const durationSec = parseDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = resolveBase(manifestUrl, [baseUrlOf(mpd)]);

  // type="dynamic" is a live presentation: no fixed duration, a segment
  // timeline that keeps growing. The static download path would compute a
  // nonsense segment count from a missing/zero duration.
  const live = String(mpd.attrs.type || 'static').toLowerCase() === 'dynamic';

  // Any <ContentProtection> means the media is encrypted. The bare
  // mp4protection:2011 element just signals CENC; a system-specific one names
  // the DRM. Either way the fragments can't be muxed into a playable file.
  const drmSystems = collectDrm(mpd);
  const drm = drmSystems.length ? drmSystems.join(', ') : null;

  const period = find(mpd, 'Period');
  if (!period) throw new Error('MPD has no Period');
  const periodBase = resolveBase(mpdBase, [baseUrlOf(period)]);

  const video = [];
  const audio = [];

  for (const set of findAll(period, 'AdaptationSet')) {
    const setBase = resolveBase(periodBase, [baseUrlOf(set)]);
    const inherited = {
      segmentTemplate: find(set, 'SegmentTemplate') || null,
      segmentList: find(set, 'SegmentList') || null,
      mimeType: set.attrs.mimeType || null,
      codecs: set.attrs.codecs || null,
      lang: set.attrs.lang || null,
    };

    // Determine content type from the set, or infer from a child representation.
    let contentType = set.attrs.contentType || '';
    const setMime = set.attrs.mimeType || '';
    const reps = findAll(set, 'Representation');
    if (!contentType) {
      const mime = setMime || (reps[0] && reps[0].attrs.mimeType) || '';
      if (mime.startsWith('video/')) contentType = 'video';
      else if (mime.startsWith('audio/')) contentType = 'audio';
    }

    for (const repNode of reps) {
      const rep = buildRepresentation(repNode, inherited, setBase, durationSec);
      if (contentType === 'video') video.push(rep);
      else if (contentType === 'audio') audio.push(rep);
      else if (rep.height || (rep.mimeType || '').startsWith('video/')) video.push(rep);
      else audio.push(rep);
    }
  }

  video.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  audio.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

  return { durationSec, video, audio, live, drm, drmSystems };
}

const DRM_SCHEMES = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'ClearKey',
};

function collectDrm(node, out = []) {
  if (!node) return out;
  if (node.name === 'ContentProtection') {
    const scheme = String(node.attrs.schemeIdUri || '').toLowerCase();
    const uuid = scheme.replace(/^urn:uuid:/, '');
    const name = DRM_SCHEMES[uuid] || (scheme.includes('mp4protection') ? 'CENC' : scheme || 'unknown');
    if (!out.includes(name)) out.push(name);
  }
  for (const child of node.children || []) collectDrm(child, out);
  return out;
}

/** Pick one video representation (by index) and the best audio, if separate. */
function selectTracks(parsed, variantIndex = 0) {
  const video = parsed.video[variantIndex] || parsed.video[0] || null;
  const audio = parsed.audio[0] || null;
  return { video, audio };
}

module.exports = { parseMpd, selectTracks, parseXml, fillTemplate, parseDuration };
