'use strict';

try {
  importScripts('exclusions.js');
} catch (e) {
  console.error('Failed to import exclusions.js', e);
}

try {
  importScripts('dashParser.js');
} catch (e) {
  console.error('Failed to import dashParser.js', e);
}

// --- WebSocket Bridge -----------------------------------------------------

let ws = null;
let nativeReady = false;
let reconnectDelay = 1000;

function connectBridge() {
  if (ws) {
    try { ws.close(); } catch (e) {}
  }

  ws = new WebSocket('ws://127.0.0.1:9333');

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: 'hello' }));
    } catch (e) {}
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'hello-ack' || msg.status === 'success' || msg.type === 'queue') {
      const wasReady = nativeReady;
      nativeReady = true;
      reconnectDelay = 1000;
      chrome.action.setBadgeText({ text: '' });
      if (msg.config) {
        self.serverConfig = msg.config;
      }
      if (!wasReady) broadcastBridgeStatusToPorts();
    }
  };

  ws.onclose = () => {
    const wasReady = nativeReady;
    nativeReady = false;
    ws = null;
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
    if (wasReady) broadcastBridgeStatusToPorts();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // Error will trigger close event
  };
}

function scheduleReconnect() {
  setTimeout(connectBridge, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
}

connectBridge();

function sendToBridge(payload) {
  if (ws && nativeReady && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      console.error('Failed to send:', e);
    }
  }
  return false;
}

chrome.runtime.onInstalled.addListener(connectBridge);

// No pairing functions needed. The native host reads pairing.json directly!

self.shouldExclude = function(urlStr) {
  if (!self.serverConfig || !self.serverConfig.excludedSites) return false;
  const excludedStr = self.serverConfig.excludedSites || '';
  if (!excludedStr.trim()) return false;
  let hostname;
  try { hostname = new URL(urlStr).hostname; } catch { return false; }
  const patterns = excludedStr.split(/\s+/).filter(Boolean);
  for (const pattern of patterns) {
    const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
    const regex = new RegExp(regexStr, 'i');
    if (regex.test(hostname)) return true;
  }
  return false;
};

// --- Cookie/header & Title helpers -------------------------------------------

async function buildHeaders(pageUrl, referer) {
  const headers = {};
  try {
    const cookies = await chrome.cookies.getAll({ url: pageUrl });
    if (cookies.length) {
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
  } catch {}
  if (referer) headers.Referer = referer;
  headers['User-Agent'] = navigator.userAgent;
  return headers;
}

function cleanMediaTitle(msgTitle, tabTitle, mediaUrl, isHls) {
  let title = tabTitle || msgTitle || '';

  if (mediaUrl && !isHls) {
    try {
      const u = new URL(mediaUrl);
      const last = u.pathname.split('/').pop();
      if (last && /\.(mp4|mkv|webm|avi|flv|wmv|mp3|m4a|zip|rar|7z|exe|pdf)$/i.test(last)) {
        return decodeURIComponent(last);
      }
    } catch (e) {}
  }

  const genericRegex = /(player|embed|iframe|faselhd player|video_player|stream)/i;
  if (tabTitle && (genericRegex.test(msgTitle) || !msgTitle || msgTitle === 'video')) {
    title = tabTitle;
  } else if (msgTitle) {
    title = msgTitle;
  }

  title = title.replace(/^\(\d+\)\s*/, '');
  title = title.replace(/[ \t\r\n▶]+/g, ' ').trim();

  return title
    .replace(/[-|_]?(مشاهدة|تحميل|اون لاين|فاصل اعلاني|FaselHD|Fasel|شاهد|انمي|مترجم).*/ig, '')
    .replace(/[\/\\?%*:|"<>]/g, '')
    .trim() || 'video';
}

function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[m[1]] = val;
  }
  return attrs;
}

function parseMasterVariants(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      const uriLine = lines[i + 1] ? lines[i + 1].trim() : null;
      if (uriLine && !uriLine.startsWith('#')) {
        let resLabel = attrs.RESOLUTION ? (attrs.RESOLUTION.split('x')[1] ? `${attrs.RESOLUTION.split('x')[1]}p` : attrs.RESOLUTION) : null;
        let bwLabel = attrs.BANDWIDTH ? `${Math.round(Number(attrs.BANDWIDTH) / 1000)} kbps` : null;
        variants.push({
          quality: resLabel || bwLabel || 'HD Quality',
          bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
          resolution: attrs.RESOLUTION || null,
          url: new URL(uriLine, baseUrl).toString(),
        });
        i++;
      }
    }
  }
  return variants;
}

// DRM on HLS shows up as SAMPLE-AES (FairPlay) or a vendor KEYFORMAT; a
// playlist without #EXT-X-ENDLIST is live. Both are flagged so the panel can
// tell the user instead of the app failing after they click Download.
function classifyHlsText(text) {
  const drm =
    /METHOD=SAMPLE-AES/i.test(text) ||
    /KEYFORMAT="?[^",]*(streamingkeydelivery|widevine|playready)/i.test(text) ||
    /urn:uuid:edef8ba9/i.test(text);
  const isMedia = /#EXTINF/i.test(text);
  const live = isMedia && !/#EXT-X-ENDLIST/i.test(text);
  return { drm, live };
}

async function inspectManifestBackground(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    const flags = classifyHlsText(text);
    if (text.includes('#EXT-X-STREAM-INF')) {
      return { type: 'master', variants: parseMasterVariants(text, res.url), ...flags };
    }
    return { type: 'media', url, ...flags };
  } catch {
    return { type: 'media', url };
  }
}

// Fetch + parse an MPEG-DASH manifest into its video Representations (see
// dashParser.js). Race against a timeout so a slow/hanging manifest never
// blocks the quality menu from opening; the caller falls back to a single
// generic "MPEG-DASH Stream" entry when this returns no variants.
async function inspectMpdVariants(url) {
  try {
    const fetchPromise = (async () => {
      const res = await fetch(url);
      const text = await res.text();
      const flags = {
        drm: /<ContentProtection\b/i.test(text),
        live: /<MPD\b[^>]*\btype\s*=\s*"dynamic"/i.test(text),
      };
      if (typeof self.parseMpdVariants !== 'function') return { video: [], ...flags };
      return { ...self.parseMpdVariants(text), ...flags };
    })();
    const timeoutPromise = new Promise((r) => setTimeout(() => r({ video: [] }), 1500));
    const parsed = await Promise.race([fetchPromise, timeoutPromise]);
    const list = parsed.video || [];
    list.drm = Boolean(parsed.drm);
    list.live = Boolean(parsed.live);
    return list;
  } catch (e) {
    return [];
  }
}

// --- Track HLS/DASH/subtitle URLs seen per tab ------------------------------

const MEDIA_PATTERN = /(\.(m3u8|mpd|mp4|mkv|webm|avi|mov|flv|wmv|m4v|ogv|3gp|ts|m2ts|mts|vob|divx|f4v|mp3|m4a|aac|flac|wav|ogg|opus|wma|pdf|zip|rar|7z|tar|gz|iso|exe|msi|apk|dmg)(\?|$))|(mime=video)|(mime=audio)|(bytestart=)|(videoplayback)|(video_stream)|(\/hls\/)|(\/dash\/)|(\/manifest\/)|(\/playlist\.|\/master\.)/i;
const SUB_PATTERN = /\.(vtt|srt|ass|ssa|ttml)(\?|$)/i;
const MEDIA_CONTENT_TYPES = [
  'video/',
  'audio/',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'application/dash+xml',
  'application/pdf',
  'application/zip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/octet-stream',
];

// --- Stream identity & segment rejection ------------------------------------
// A DASH/HLS player doesn't fetch "a video" — it fetches hundreds of small
// chunks of one. Treating each chunk request as its own downloadable file is
// what filled the panel with dozens of identical "Captured Video Stream" rows.
// IDM lists the STREAM (one row per resolution); so must we.
//
// Two mechanisms do that: reject anything that is recognisably one piece of a
// stream, and collapse whatever survives onto a canonical per-stream key.

// Query parameters that change between chunks of the SAME stream. Stripping
// them is what makes two chunk URLs collapse onto one identity.
const VOLATILE_QUERY_PARAMS = new Set([
  // Byte-range / sequence cursors — the chunk pointer itself.
  'range', 'rn', 'rbuf', 'sq', 'bytestart', 'byteend', 'offset', 'start', 'begin', 'end',
  // Per-request session, routing and expiry noise (mostly YouTube/googlevideo).
  'cpn', 'ei', 'met', 'mt', 'mn', 'ms', 'mv', 'mvi', 'pl', 'initcwndbps', 'ump', 'srfvp',
  'expire', 'ip', 'ipbits', 'sparams', 'sig', 'lsparams', 'lsig', 'pot', 'alr', 'keepalive',
  'redirect_counter', 'rm', 'fallback_count', 'shardid', 'cmbypass', 'txp', 'xpc', 'beids',
  '_nc_rid', 'oh', 'oe', 'ccb', 'bytestart_', 'tt', 'token', 'hdnts', 'hdnea',
  // Unambiguous cache-busters. Deliberately NOT 't' or 'v' — those are just as
  // often a real version or variant selector, and wrongly folding two distinct
  // files into one row is a worse failure than showing an extra row.
  '_', 'cb', 'nocache', 'rand', 'random', 'timestamp', 'cachebuster',
]);

// A request that is one PIECE of a stream rather than a complete file.
const STREAM_SEGMENT_PATTERN = new RegExp(
  [
    '\\.m4s(\\?|$)',            // DASH media segment
    '[?&]sq=\\d',               // YouTube DASH sequence number
    '[?&]range=\\d+-\\d*',      // explicit byte-range fetch
    '[?&]bytestart=\\d',        // Facebook/others
    '[_-]seg(ment)?[_-]?\\d+',  // media_seg-00012.ts
    '[_-]chunk[_-]?\\d+',
    '[_-]frag(ment)?[_-]?\\d+',
    '/seg-\\d+',
    '/init\\.(mp4|m4s)(\\?|$)', // initialization segment
    '\\binit-[a-z0-9]+\\.(mp4|m4s)(\\?|$)',
    '\\d{4,}\\.ts(\\?|$)',      // numbered HLS segment: media_0001234.ts
  ].join('|'),
  'i'
);

// CDN shards spread one stream across many hostnames (rr3---sn-abc.googlevideo
// .com, rr7---sn-xyz.googlevideo.com …). Fold them together or the same video
// reappears once per edge node the player happened to touch.
function canonicalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  const shard = /^(?:rr\d+---)?sn-[a-z0-9-]+\.(googlevideo\.com)$/.exec(h);
  if (shard) return shard[1];
  return h.replace(/^(?:v|video|media|cdn|edge|stream)[-.]?\d+[.-]/, '');
}

/**
 * A stable identity for the STREAM a URL belongs to. Two chunk URLs of the same
 * rendition produce the same key; two different renditions (different `itag`,
 * different path) do not — `itag`/`quality` are deliberately preserved because
 * they are exactly what distinguishes 1080p from 720p.
 */
function streamKeyFor(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return String(rawUrl).split('?')[0];
  }
  const params = [];
  for (const [k, v] of u.searchParams) {
    if (VOLATILE_QUERY_PARAMS.has(k.toLowerCase())) continue;
    params.push(`${k}=${v}`);
  }
  params.sort();
  // Trailing chunk numbers in the PATH collapse too (…/video_0001.ts).
  const cleanPath = u.pathname.replace(/\d{3,}(?=\.[a-z0-9]{2,5}$)/i, 'N');
  return `${canonicalHost(u.hostname)}${cleanPath}?${params.join('&')}`;
}

// A hostile or merely busy page must not be able to grow this without bound.
const MAX_TRACKED_MEDIA_PER_TAB = 60;

const tabMedia = new Map(); // tabId -> { manifests: Map<streamKey,url>, subtitles: Map<url,{lang,label}>, sizes: Map<url, number> }
const ytFormats = new Map(); // tabId -> Map<label, item>
const fbFormats = new Map(); // tabId -> Map<url, item>

function getTabState(tabId) {
  if (!tabMedia.has(tabId)) {
    tabMedia.set(tabId, { manifests: new Map(), subtitles: new Map(), sizes: new Map() });
  }
  return tabMedia.get(tabId);
}

/** True for a manifest/playlist — the thing we WANT, as opposed to its chunks. */
function isManifestUrl(url) {
  return /\.(m3u8|mpd)(\?|$)/i.test(String(url || ''));
}

/**
 * Record a media URL for a tab, collapsing it onto its stream identity.
 * Returns true if this actually added something new (i.e. the caller should
 * mark the tab dirty). Chunk requests are rejected outright.
 */
function recordMedia(state, url) {
  // A manifest is always worth keeping, even if its filename looks segment-ish.
  if (!isManifestUrl(url) && STREAM_SEGMENT_PATTERN.test(url)) return false;

  const key = streamKeyFor(url);
  if (state.manifests.has(key)) return false;
  if (state.manifests.size >= MAX_TRACKED_MEDIA_PER_TAB) return false;
  state.manifests.set(key, url);
  return true;
}

// --- Panel filters -----------------------------------------------------------
// Per-format size floors, below which a media file isn't worth offering. IDM
// keeps these under DwnlPanel\minsize; the two values a real install ships
// explicitly (MP3 = 50 KB, OGG = 100 KB) are reproduced exactly and the rest
// follow the same shape. Without this a 2 KB UI notification sound shows up in
// the panel as a downloadable "audio file".
const KB = 1024;
const DEFAULT_MIN_SIZES = {
  mp3: 50 * KB,
  ogg: 100 * KB,
  m4a: 50 * KB,
  aac: 50 * KB,
  opus: 50 * KB,
  wav: 50 * KB,
  wma: 50 * KB,
  flac: 50 * KB,
  mp4: 100 * KB,
  m4v: 100 * KB,
  webm: 100 * KB,
  mov: 100 * KB,
  flv: 100 * KB,
  f4v: 100 * KB,
  avi: 100 * KB,
  mkv: 100 * KB,
  ogv: 100 * KB,
  '3gp': 100 * KB,
};

// User-set floor applied on top of the per-format defaults (0 = defaults only),
// and IDM's SkipHtml, which keeps plain web pages out of the download path.
let panelMinSizeFloorBytes = 0;
let skipHtml = true;

function loadPanelSettings() {
  try {
    chrome.storage.sync.get(['panelMinSizeKB', 'skipHtml'], (cfg) => {
      if (chrome.runtime.lastError || !cfg) return;
      const kb = Number(cfg.panelMinSizeKB);
      panelMinSizeFloorBytes = Number.isFinite(kb) && kb > 0 ? kb * KB : 0;
      if (cfg.skipHtml !== undefined) skipHtml = Boolean(cfg.skipHtml);
    });
  } catch (e) {
    /* keep the defaults */
  }
}
loadPanelSettings();

// Settings changed in the popup take effect immediately — the service worker
// may live for hours, so re-reading only at startup would leave it stale.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.panelMinSizeKB) {
      const kb = Number(changes.panelMinSizeKB.newValue);
      panelMinSizeFloorBytes = Number.isFinite(kb) && kb > 0 ? kb * KB : 0;
      // Snapshots are cached by version, so raising the floor has to invalidate
      // them or already-listed small files would linger until the next event.
      tabSnapshotCache.clear();
      for (const tabId of tabMedia.keys()) markTabDirty(tabId);
    }
    if (changes.skipHtml) skipHtml = Boolean(changes.skipHtml.newValue);
  });
}

function fileExtensionOf(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * True when a discovered item is too small to be worth showing.
 *
 * Deliberately never applies to HLS/DASH: a manifest is a few hundred bytes by
 * nature while representing an entire movie, so a size floor there would hide
 * every stream on the page.
 */
function isBelowPanelMinSize(url, kind, size) {
  if (kind === 'hls' || kind === 'dash') return false;
  if (!Number.isFinite(size) || size <= 0) return false; // unknown size — keep it
  const perFormat = DEFAULT_MIN_SIZES[fileExtensionOf(url)] || 0;
  const threshold = Math.max(perFormat, panelMinSizeFloorBytes);
  return threshold > 0 && size < threshold;
}

/** A web page rather than a file. IDM calls this SkipHtml, and defaults it on. */
function isHtmlLike(mimeOrContentType, url) {
  const m = String(mimeOrContentType || '').toLowerCase().split(';')[0].trim();
  if (m === 'text/html' || m === 'application/xhtml+xml' || m === 'application/xml+xhtml') return true;
  // Only fall back to the extension when the server told us nothing at all —
  // a .html URL that actually serves a file should still be capturable.
  if (!m) {
    const ext = fileExtensionOf(url);
    return ext === 'html' || ext === 'htm' || ext === 'xhtml';
  }
  return false;
}

/** Page navigations are never media, whatever their URL happens to look like. */
function isNavigationRequest(type) {
  return type === 'main_frame' || type === 'sub_frame';
}

// --- Side Panel support: change tracking, session persistence, live push ---
//
// The side panel is a long-lived page that can stay open across many tab
// switches and idle minutes, unlike the popup (opened briefly, on demand).
// Two problems that don't matter for the popup become real for the panel:
//
//  1. MV3 service workers are ephemeral — Chrome can terminate this worker
//     after ~30s of no qualifying activity and restart it fresh on the next
//     event. The in-memory `tabMedia` Map would silently lose everything
//     discovered so far. `chrome.storage.session` is the purpose-built fix:
//     memory-backed (cleared on browser close, unlike `local`) but survives
//     a service-worker restart (unlike a plain module-level Map).
//  2. A snapshot of a tab's media is potentially expensive to (re)compute
//     (it fetches and parses every discovered .m3u8/.mpd). The version-based
//     cache below avoids redoing that work when nothing has actually changed
//     since the last computation.

const SESSION_KEY_PREFIX = 'tabMedia:';
const tabVersions = new Map(); // tabId -> version counter, bumped on any relevant change
const tabSnapshotCache = new Map(); // tabId -> { version, snapshot: {items, subtitles} }

function persistTabState(tabId, state) {
  try {
    chrome.storage.session
      .set({
        [SESSION_KEY_PREFIX + tabId]: {
          manifests: Array.from(state.manifests.values()),
          subtitles: Array.from(state.subtitles.entries()),
        },
      })
      .catch(() => {});
  } catch (e) {
    // storage.session unavailable — live in-memory tracking still works,
    // it just won't survive a mid-session service-worker restart.
  }
}

async function rehydrateFromSession() {
  try {
    const all = await chrome.storage.session.get(null);
    const openTabs = await chrome.tabs.query({});
    const openTabIds = new Set(openTabs.map((t) => t.id));
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(SESSION_KEY_PREFIX)) continue;
      const tabId = Number(key.slice(SESSION_KEY_PREFIX.length));
      if (!openTabIds.has(tabId)) {
        chrome.storage.session.remove(key).catch(() => {});
        continue;
      }
      if (tabMedia.has(tabId)) continue; // fresher in-memory state already exists
      tabMedia.set(tabId, {
        // Rebuilt through the same keying path so a session restored from an
        // older build (which stored raw chunk URLs) is deduplicated on load.
        manifests: (() => {
          const m = new Map();
          for (const u of value.manifests || []) {
            if (!isManifestUrl(u) && STREAM_SEGMENT_PATTERN.test(u)) continue;
            const k = streamKeyFor(u);
            if (!m.has(k) && m.size < MAX_TRACKED_MEDIA_PER_TAB) m.set(k, u);
          }
          return m;
        })(),
        subtitles: new Map(value.subtitles || []),
        sizes: new Map(),
      });
      tabVersions.set(tabId, 1);
    }
  } catch (e) {
    // Nothing to rehydrate, or storage.session isn't available — fine, the
    // extension continues to work from a clean slate.
  }
}
rehydrateFromSession();

// Single trigger for "something about this tab's media changed": bumps the
// version (invalidating the snapshot cache), best-effort persists the raw
// discovered URLs, and schedules a debounced push to any connected panel.
function markTabDirty(tabId) {
  tabVersions.set(tabId, (tabVersions.get(tabId) || 0) + 1);
  const state = tabMedia.get(tabId);
  if (state) persistTabState(tabId, state);
  scheduleSnapshotPush(tabId);
}

// Clear tab captured URLs only on main-frame URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabMedia.delete(tabId);
    tabVersions.delete(tabId);
    tabSnapshotCache.delete(tabId);
    ytFormats.delete(tabId);
    fbFormats.delete(tabId);
    chrome.storage.session.remove(SESSION_KEY_PREFIX + tabId).catch(() => {});
    pushResetToPorts(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  tabVersions.delete(tabId);
  tabSnapshotCache.delete(tabId);
  ytFormats.delete(tabId);
  fbFormats.delete(tabId);
  chrome.storage.session.remove(SESSION_KEY_PREFIX + tabId).catch(() => {});
  pushResetToPorts(tabId);
  portsByTab.delete(tabId); // tab is gone for good; no further updates will ever apply
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (self.shouldExclude && self.shouldExclude(details.url, details.type, details.initiator)) return;
    // A page navigation is a page, not a download candidate — some sites route
    // documents through paths like /manifest/ that MEDIA_PATTERN would match.
    if (skipHtml && isNavigationRequest(details.type)) return;

    const state = getTabState(details.tabId);
    if (MEDIA_PATTERN.test(details.url)) {
      if (recordMedia(state, details.url)) markTabDirty(details.tabId);
    } else if (SUB_PATTERN.test(details.url) || details.url.includes('/api/timedtext')) {
      if (!state.subtitles.has(details.url)) {
        let label = details.url.split('/').pop().split('?')[0];
        if (details.url.includes('timedtext')) {
           const u = new URL(details.url);
           const lang = u.searchParams.get('lang') || 'en';
           const name = u.searchParams.get('name') || '';
           label = `YouTube Subtitle (${lang}${name ? ' - ' + name : ''})`;
        }
        state.subtitles.set(details.url, { url: details.url, label });
        markTabDirty(details.tabId);
      }
    }
  },
  { urls: ['<all_urls>'] }
);

// Sniff Content-Type response headers for media streams
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (self.shouldExclude && self.shouldExclude(details.url, details.type, details.initiator)) return;
    if (skipHtml && isNavigationRequest(details.type)) return;

    const state = getTabState(details.tabId);
    const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
    const contentType = header('content-type');
    let isMedia = false;

    // A response that turns out to be a web page is never media, even if the
    // URL matched. Prune it too — onBeforeRequest may already have recorded it
    // on the strength of the URL alone.
    if (skipHtml && isHtmlLike(contentType, details.url)) {
      if (state.manifests.delete(streamKeyFor(details.url))) markTabDirty(details.tabId);
      return;
    }

    if (contentType) {
      const val = contentType.toLowerCase();
      if (val.startsWith('video/') || val.startsWith('audio/') || MEDIA_CONTENT_TYPES.some((ct) => val.includes(ct))) {
        if (recordMedia(state, details.url)) markTabDirty(details.tabId);
        isMedia = true;
      }
    }

    if (isMedia || MEDIA_PATTERN.test(details.url)) {
      // Content-Length on a 206 describes the RANGE, not the file — players
      // fetch video in small chunks, so trusting it would report a 4 GB movie
      // as 64 KB and then let the size filter throw it away. The total after
      // the slash in Content-Range is the real figure.
      let total = null;
      const contentRange = header('content-range');
      const rangeTotal = contentRange && /\/(\d+)\s*$/.exec(contentRange);
      if (rangeTotal) {
        total = parseInt(rangeTotal[1], 10);
      } else if (details.statusCode !== 206) {
        const len = header('content-length');
        if (len) total = parseInt(len, 10);
      }

      if (Number.isFinite(total) && total > 0) {
        state.sizes.set(details.url, total);
        // Now that the real size is known, a file below the floor can be
        // dropped at the source rather than filtered on every snapshot.
        if (isBelowPanelMinSize(details.url, 'file', total) && state.manifests.delete(streamKeyFor(details.url))) {
          markTabDirty(details.tabId);
        }
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// --- Downloads interception --------------------------------------------------

const recentlyForwarded = new Set();

// The most recent click's modifier state, reported by content.js. A
// DownloadItem carries no tabId, so this can't be scoped per-tab — it's a
// short-lived global hint instead, valid only for downloads that follow the
// click closely enough to plausibly be that click's.
const CAPTURE_HINT_TTL_MS = 4000;
let captureHint = { force: false, bypass: false, ts: 0 };

function currentCaptureHint() {
  if (Date.now() - captureHint.ts > CAPTURE_HINT_TTL_MS) return { force: false, bypass: false };
  return captureHint;
}

chrome.downloads.onCreated.addListener(async (item) => {
  if (recentlyForwarded.has(item.url)) {
    recentlyForwarded.delete(item.url);
    return;
  }
  if (!nativeReady) return;

  const hint = currentCaptureHint();
  // Bypass wins over force: it's the "just let the browser do it" escape hatch,
  // and it must work even on a URL we would normally take.
  if (hint.bypass) return;
  // Saving a web page (Ctrl+S, or a link the server answers with a document)
  // should stay with the browser — hijacking it hands the user a raw .html
  // file in their downloads folder instead of a saved page. Force still wins,
  // for the rare case of deliberately grabbing the markup.
  if (skipHtml && !hint.force && isHtmlLike(item.mime, item.url)) return;
  // Force overrides the exclusion list — that's the whole point of holding the
  // key on a site the user has otherwise told us to leave alone.
  if (!hint.force && self.shouldExclude && self.shouldExclude(item.url)) return;

  chrome.downloads.cancel(item.id, () => {
    chrome.downloads.erase({ id: item.id });
  });

  const headers = await buildHeaders(item.url, item.referrer || '');
  const sent = sendToBridge({
    type: 'add-download',
    payload: { url: item.url, kind: 'file', headers },
  });

  if (!sent) {
    recentlyForwarded.add(item.url);
    chrome.downloads.download({ url: item.url, filename: item.filename });
  }
});

// --- Build the display-ready media list for a tab ---------------------------
// Shared by the on-demand `get-media-for-tab` message (used by the floating
// button, which already has a `sender.tab`) and the Side Panel's push path
// (which doesn't — it resolves the title itself via chrome.tabs.get). Backed
// by a version-based cache so repeated calls for an unchanged tab (e.g. the
// panel re-subscribing after a tab switch back) skip the fetch/parse work.
async function buildMediaSnapshot(tabId) {
  const state = tabId != null ? tabMedia.get(tabId) : null;
  const currentVersion = tabVersions.get(tabId) || 0;
  const cached = tabSnapshotCache.get(tabId);
  if (cached && cached.version === currentVersion) {
    return cached.snapshot;
  }

  let tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitle = tab?.title || '';
  } catch (e) {
    // Tab may have closed between the triggering event and this call —
    // proceed with an empty title rather than failing the whole snapshot.
  }

  let rawManifests = state ? Array.from(state.manifests.values()) : [];

  // When a parsed source already describes the video properly, the raw
  // progressive URLs the player happened to hit are noise, not extra options.
  // IDM shows six clean resolutions for a YouTube video precisely because it
  // reads the player config instead of listing what the network sniffer saw.
  const hasParsedFormats =
    (tabId != null && ytFormats.has(tabId) && ytFormats.get(tabId).size > 0) ||
    (tabId != null && fbFormats.has(tabId) && fbFormats.get(tabId).size > 0);
  if (hasParsedFormats) {
    rawManifests = rawManifests.filter(
      (u) => isManifestUrl(u) || !/googlevideo\.com|\/videoplayback|fbcdn\.net|video_stream/i.test(u)
    );
  }

  // A master manifest supersedes the individual renditions fetched from it:
  // once we can parse the master, listing its children duplicates every
  // quality a second time.
  //
  // Scoped deliberately tightly. Only true segment container types are
  // suppressed (never .mp4 — a progressive download can legitimately sit on the
  // same page as a stream), and only for URLs from the same origin as a master,
  // so an unrelated stream elsewhere on the page survives.
  const masterOrigins = new Set();
  for (const u of rawManifests) {
    if (!/\/master[.-]|master\.m3u8|\.mpd(\?|$)/i.test(u)) continue;
    try {
      masterOrigins.add(new URL(u).origin);
    } catch (e) {
      /* unparseable — can't scope it, so it suppresses nothing */
    }
  }
  if (masterOrigins.size) {
    rawManifests = rawManifests.filter((u) => {
      if (isManifestUrl(u)) return true;
      if (!/\.(ts|m4s|aac)(\?|$)/i.test(u)) return true;
      try {
        return !masterOrigins.has(new URL(u).origin);
      } catch (e) {
        return true;
      }
    });
  }

  const parsedItems = [];
  const seenUrls = new Set();
  const seenLabels = new Set();
  // Collapses two renditions that describe the same quality (e.g. an mp4 and a
  // webm 1080p) down to one row, which is what makes the list read like IDM's.
  const seenQualities = new Set();

  for (const mediaUrl of rawManifests) {
    const titleClean = cleanMediaTitle('', tabTitle, mediaUrl, mediaUrl.includes('.m3u8'));
    // Deduplicate Instagram/CDN URLs by base path & resolution parameters
    const cleanKey = mediaUrl.split('?')[0] + (mediaUrl.match(/_(\d+p)_/)?.[1] || '');
    if (seenUrls.has(cleanKey)) continue;
    seenUrls.add(cleanKey);

    if (mediaUrl.includes('.mpd')) {
      // Parse real Representations (resolution + bitrate) instead of just
      // guessing the max height, and expose one entry per quality — same
      // logic as the HLS branch below. variantIndex is the position in the
      // height-sorted list, matching exactly what core/dash.js's
      // selectTracks(variantIndex) will pick on the app side.
      const variants = await inspectMpdVariants(mediaUrl);
      const dashBlocked = variants.drm ? 'DRM-protected' : variants.live ? 'live stream' : null;
      if (variants.length) {
        variants.forEach((v, idx) => {
          const quality = v.height ? `${v.height}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'Auto';
          const detail = v.width && v.height ? `${v.width}x${v.height}` : 'DASH';
          const label = `${titleClean} - ${quality} (${detail})${dashBlocked ? ` [${dashBlocked}]` : ''}`;
          if (!seenLabels.has(label)) {
            seenLabels.add(label);
            parsedItems.push({ label, kind: 'dash', url: mediaUrl, variantIndex: idx, blocked: dashBlocked });
          }
        });
      } else {
        // Manifest fetch/parse failed or timed out, or it has no video
        // Representations (e.g. audio-only) — still offer a generic entry
        // so the download isn't silently dropped from the list.
        const label = `${titleClean} - MPEG-DASH Stream (.mpd)`;
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          parsedItems.push({ label, kind: 'dash', url: mediaUrl, variantIndex: 0 });
        }
      }
      continue;
    }

    let info = { type: 'media', variants: [] };
    try {
      const timeoutPromise = new Promise((r) => setTimeout(() => r({ type: 'media', url: mediaUrl }), 1500));
      info = await Promise.race([inspectManifestBackground(mediaUrl), timeoutPromise]);
    } catch (e) {
      console.error('inspectManifestBackground failed for', mediaUrl, e);
    }

    const hlsBlocked = info.drm ? 'DRM-protected' : info.live ? 'live stream' : null;
    if (info.type === 'master' && info.variants.length) {
      info.variants.forEach((v, idx) => {
        const label = `${titleClean} - ${v.quality} (${v.resolution || 'HLS'})${hlsBlocked ? ` [${hlsBlocked}]` : ''}`;
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          parsedItems.push({ label, kind: 'hls', url: mediaUrl, variantIndex: idx, blocked: hlsBlocked });
        }
      });
    } else {
      let kind = 'file';
      let ext = '.mp4';
      if (mediaUrl.includes('.m3u8')) {
        kind = 'hls';
        ext = '.m3u8';
      } else if (mediaUrl.includes('.webm')) {
        ext = '.webm';
      }

      let qualityLabel = 'Video File';
      const pMatch = mediaUrl.match(/(\d{3,4}p)/i) || mediaUrl.match(/tag=dash_(\d+p)/i) || mediaUrl.match(/quality_(\d+p)/i);
      const hdSdMatch = mediaUrl.match(/quality[=_](hd|sd)/i) || mediaUrl.match(/tag=dash_(hd|sd)/i) || mediaUrl.match(/_(hd|sd)\.mp4/i);
      const resDimensionsMatch = mediaUrl.match(/(\d{3,4})x(\d{3,4})/i);

      if (pMatch) {
        qualityLabel = `Quality ${pMatch[1].toLowerCase()}${pMatch[1].includes('720') || pMatch[1].includes('1080') ? ' HD' : ''}`;
      } else if (resDimensionsMatch) {
        qualityLabel = `Quality ${resDimensionsMatch[2]}p`;
      } else if (hdSdMatch) {
        qualityLabel = `Quality ${hdSdMatch[1].toUpperCase()}`;
      }

      const size = state && state.sizes.has(mediaUrl) ? state.sizes.get(mediaUrl) : 0;
      // Second line of defence: a size can arrive after discovery, and the
      // user can raise the floor at any time, so the snapshot re-checks.
      if (isBelowPanelMinSize(mediaUrl, kind, size)) continue;
      let sizeStr = '';
      if (size > 1024 * 1024) sizeStr = ` ${(size / 1024 / 1024).toFixed(2)} MB`;
      else if (size > 1024) sizeStr = ` ${Math.round(size / 1024)} KB`;

      // Two chunk URLs that survived keying but describe the same rendition
      // (same host + same quality) must not both be offered.
      let qualityKey = null;
      try {
        qualityKey = `${canonicalHost(new URL(mediaUrl).hostname)}|${qualityLabel}|${kind}`;
      } catch (e) {
        qualityKey = `${qualityLabel}|${kind}`;
      }
      if (seenQualities.has(qualityKey)) continue;
      seenQualities.add(qualityKey);

      const label = `${titleClean} - MP4 File (${qualityLabel})${sizeStr}`;
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        parsedItems.push({ label, kind, url: mediaUrl, variantIndex: 0 });
      }
    }
  }

  // Append YT formats if any
  if (tabId != null && ytFormats.has(tabId)) {
    for (const ytItem of ytFormats.get(tabId).values()) {
      if (!seenLabels.has(ytItem.label)) {
        seenLabels.add(ytItem.label);
        parsedItems.push(ytItem);
      }
    }
  }

  // Append Facebook formats if any
  if (tabId != null && fbFormats.has(tabId)) {
    for (const fbItem of fbFormats.get(tabId).values()) {
      if (!seenLabels.has(fbItem.label)) {
        seenLabels.add(fbItem.label);
        parsedItems.push(fbItem);
      }
    }
  }

  const snapshot = {
    items: parsedItems,
    subtitles: state ? Array.from(state.subtitles.values()) : [],
  };
  tabSnapshotCache.set(tabId, { version: currentVersion, snapshot });
  return snapshot;
}

// --- Side Panel: live push over a persistent Port ---------------------------
// One global panel page (not per-tab chrome.sidePanel.setOptions) tracks
// whichever tab is active in its own window and subscribes here by tabId.
const portsByTab = new Map(); // tabId -> Set<Port>
const pushTimers = new Map(); // tabId -> timeoutId

function removePortFromTab(port, tabId) {
  if (tabId == null) return;
  const set = portsByTab.get(tabId);
  if (!set) return;
  set.delete(port);
  if (set.size === 0) portsByTab.delete(tabId);
}

// Debounces bursts of discovery events (a busy page can fire many webRequest
// matches within milliseconds) into a single snapshot push. Skips the
// (potentially expensive) rebuild entirely when no panel is subscribed to
// this tab, so an unopened panel costs nothing.
function scheduleSnapshotPush(tabId) {
  const ports = portsByTab.get(tabId);
  if (!ports || ports.size === 0) return;
  if (pushTimers.has(tabId)) return;
  const timer = setTimeout(async () => {
    pushTimers.delete(tabId);
    const currentPorts = portsByTab.get(tabId);
    if (!currentPorts || currentPorts.size === 0) return;
    const snapshot = await buildMediaSnapshot(tabId);
    const payload = { type: 'snapshot', tabId, items: snapshot.items, subtitles: snapshot.subtitles, bridgeConnected: nativeReady };
    for (const port of currentPorts) {
      try { port.postMessage(payload); } catch (e) { /* stale port; onDisconnect will clean it up */ }
    }
  }, 250);
  pushTimers.set(tabId, timer);
}

function pushResetToPorts(tabId) {
  const ports = portsByTab.get(tabId);
  if (!ports || ports.size === 0) return;
  for (const port of ports) {
    try { port.postMessage({ type: 'reset', tabId }); } catch (e) {}
  }
}

function broadcastBridgeStatusToPorts() {
  for (const ports of portsByTab.values()) {
    for (const port of ports) {
      try { port.postMessage({ type: 'bridge-status', bridgeConnected: nativeReady }); } catch (e) {}
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  let subscribedTabId = null;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'subscribe') return;
    removePortFromTab(port, subscribedTabId);
    subscribedTabId = typeof msg.tabId === 'number' ? msg.tabId : null;
    if (subscribedTabId == null) return;

    if (!portsByTab.has(subscribedTabId)) portsByTab.set(subscribedTabId, new Set());
    portsByTab.get(subscribedTabId).add(port);

    // Join-in-progress: push the current snapshot immediately instead of
    // waiting for the next change.
    buildMediaSnapshot(subscribedTabId).then((snapshot) => {
      try {
        port.postMessage({
          type: 'snapshot',
          tabId: subscribedTabId,
          items: snapshot.items,
          subtitles: snapshot.subtitles,
          bridgeConnected: nativeReady,
        });
      } catch (e) {}
    });
  });

  // A `ws`-style EventEmitter isn't in play here (ports don't throw on an
  // unhandled disconnect), but cleanup is still required to avoid leaking a
  // dead port's Set entry — same discipline as bridge/server.js's
  // `ws.on('close', () => clients.delete(ws))` on the desktop app side.
  port.onDisconnect.addListener(() => {
    removePortFromTab(port, subscribedTabId);
  });
});

// --- Messages from content script & popup ------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'capture-hint') {
    // Every mousedown reports its modifier state, so this both sets and clears
    // the override. Stamped with a time so a stale hint can't leak into an
    // unrelated download later.
    captureHint = { force: Boolean(msg.force), bypass: Boolean(msg.bypass), ts: Date.now() };
    return;
  }

  if (msg.type === 'universal-media-found') {
    if (tabId != null) {
      const state = getTabState(tabId);
      // Remove range parameters to prevent duplicates for the same file
      const cleanUrl = msg.url.replace(/&range=\d+-\d+/i, '').replace(/&bytestart=\d+/i, '');
      if (recordMedia(state, cleanUrl)) {
        markTabDirty(tabId);
      }
    }
    return;
  }

  if (msg.type === 'fb-media-found') {
    if (tabId != null && msg.url) {
      if (!fbFormats.has(tabId)) fbFormats.set(tabId, new Map());
      const tabFb = fbFormats.get(tabId);
      const titleClean = cleanMediaTitle('', sender.tab?.title, msg.url, false);
      const label = `${titleClean} - Facebook Video (${msg.quality || 'MP4'})`;
      tabFb.set(msg.url, { label, kind: 'file', url: msg.url, variantIndex: 0 });
      markTabDirty(tabId);
    }
    return;
  }

  if (msg.type === 'get-media-for-tab') {
    (async () => {
      const snapshot = tabId != null ? await buildMediaSnapshot(tabId) : { items: [], subtitles: [] };
      sendResponse({
        items: snapshot.items,
        subtitles: snapshot.subtitles,
        bridgeConnected: nativeReady,
      });
    })();
    return true;
  }

  if (msg.type === 'yt-player-response') {
     const streamingData = msg.data?.streamingData || {};
     const formats = (streamingData.adaptiveFormats || []).concat(streamingData.formats || []);
     const captions = msg.data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
     const tabId = sender.tab?.id;
     if (tabId == null) return;

     if (!ytFormats.has(tabId)) ytFormats.set(tabId, new Map());
     const tabMap = ytFormats.get(tabId);
     const sizeBefore = tabMap.size;

     formats.forEach(f => {
       if (f.mimeType && f.mimeType.includes('video/')) {
          const quality = f.qualityLabel || (f.height ? f.height + 'p' : 'HD');
          const ext = f.mimeType.includes('mp4') ? 'MP4' : 'WebM';
          let downloadUrl = f.url;
          if (!downloadUrl && (f.signatureCipher || f.cipher)) {
            try {
              const params = new URLSearchParams(f.signatureCipher || f.cipher);
              downloadUrl = params.get('url');
            } catch(e) {}
          }
          if (downloadUrl) {
            const videoTitle = cleanMediaTitle('', sender.tab?.title, downloadUrl, false);
            const isHd = quality.includes('720') || quality.includes('1080') || quality.includes('1440') || quality.includes('2160');
            const label = `${videoTitle} - ${ext} file, quality ${quality}${isHd ? ' HD' : ''}`;
            tabMap.set(label, { label, kind: 'file', url: downloadUrl });
          }
       }
     });

     // Extract Subtitles / Captions
     captions.forEach(c => {
       if (c.baseUrl) {
         const videoTitle = cleanMediaTitle('', sender.tab?.title, c.baseUrl, false);
         const langName = c.name?.simpleText || c.languageCode || 'EN';
         const label = `${videoTitle} - TTML file, ${langName} subtitles (ASR)`;
         tabMap.set(label, { label, kind: 'file', url: c.baseUrl });
       }
     });

     if (tabMap.size !== sizeBefore) markTabDirty(tabId);
     return;
  }

  if (msg.type === 'download-media') {
    (async () => {
      const headers = await buildHeaders(sender.tab?.url || msg.url, sender.tab?.url || '');
      const suggestedFilename = cleanMediaTitle(msg.title, sender.tab?.title, msg.url, msg.kind === 'hls');
      const sent = sendToBridge({
        type: 'add-download',
        payload: {
          url: msg.url,
          kind: msg.kind || 'file',
          headers,
          variantIndex: msg.variantIndex ?? 0,
          suggestedFilename,
        },
      });
      sendResponse({ sent });
    })();
    return true;
  }
});

// --- Context Menu Integration (Download with Downloader) ------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ddl-download-context',
    title: 'Download with Downloader',
    contexts: ['video', 'audio', 'link', 'selection', 'image', 'page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const mediaUrl = info.srcUrl || info.linkUrl || info.selectionText || info.pageUrl;
  if (!mediaUrl || !mediaUrl.startsWith('http')) return;

  const headers = await buildHeaders(tab?.url || mediaUrl, tab?.url || '');
  const isHls = mediaUrl.includes('.m3u8');
  const suggestedFilename = cleanMediaTitle('', tab?.title, mediaUrl, isHls);

  sendToBridge({
    type: 'add-download',
    payload: {
      url: mediaUrl,
      kind: isHls ? 'hls' : 'file',
      headers,
      suggestedFilename,
    },
  });
});
