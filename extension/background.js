'use strict';

try {
  importScripts('exclusions.js');
} catch (e) {
  console.error('Failed to import exclusions.js', e);
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
      nativeReady = true;
      reconnectDelay = 1000;
      chrome.action.setBadgeText({ text: '' });
      if (msg.config) {
        self.serverConfig = msg.config;
      }
    }
  };

  ws.onclose = () => {
    nativeReady = false;
    ws = null;
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
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
  title = title.replace(/[ \t\r\n\u25B6]+/g, ' ').trim();

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

async function inspectManifestBackground(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    if (text.includes('#EXT-X-STREAM-INF')) {
      return { type: 'master', variants: parseMasterVariants(text, res.url) };
    }
    return { type: 'media', url };
  } catch {
    return { type: 'media', url };
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

const tabMedia = new Map(); // tabId -> { manifests: Set<url>, subtitles: Map<url,{lang,label}>, sizes: Map<url, number> }
const ytFormats = new Map(); // tabId -> Map<label, item>
const fbFormats = new Map(); // tabId -> Map<url, item>

function getTabState(tabId) {
  if (!tabMedia.has(tabId)) {
    tabMedia.set(tabId, { manifests: new Set(), subtitles: new Map(), sizes: new Map() });
  }
  return tabMedia.get(tabId);
}

// Clear tab captured URLs only on main-frame URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabMedia.delete(tabId);
    ytFormats.delete(tabId);
    fbFormats.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
  ytFormats.delete(tabId);
  fbFormats.delete(tabId);
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (self.shouldExclude && self.shouldExclude(details.url, details.type, details.initiator)) return;

    const state = getTabState(details.tabId);
    if (MEDIA_PATTERN.test(details.url)) {
      state.manifests.add(details.url);
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

    const state = getTabState(details.tabId);
    let isMedia = false;

    const contentTypeHeader = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type');
    if (contentTypeHeader && contentTypeHeader.value) {
      const val = contentTypeHeader.value.toLowerCase();
      if (val.startsWith('video/') || val.startsWith('audio/') || MEDIA_CONTENT_TYPES.some((ct) => val.includes(ct))) {
        state.manifests.add(details.url);
        isMedia = true;
      }
    }

    if (isMedia || MEDIA_PATTERN.test(details.url)) {
      const lengthHeader = details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-length');
      if (lengthHeader && lengthHeader.value) {
        state.sizes.set(details.url, parseInt(lengthHeader.value, 10));
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// --- Downloads interception --------------------------------------------------

const recentlyForwarded = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  if (recentlyForwarded.has(item.url)) {
    recentlyForwarded.delete(item.url);
    return;
  }
  if (!nativeReady) return;
  if (self.shouldExclude && self.shouldExclude(item.url)) return;

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

// --- Messages from content script & popup ------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'universal-media-found') {
    if (tabId != null) {
      const state = getTabState(tabId);
      // Remove range parameters to prevent duplicates for the same file
      const cleanUrl = msg.url.replace(/&range=\d+-\d+/i, '').replace(/&bytestart=\d+/i, '');
      state.manifests.add(cleanUrl);
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
    }
    return;
  }

  if (msg.type === 'get-media-for-tab') {
    (async () => {
      const state = tabId != null ? tabMedia.get(tabId) : null;
      const rawManifests = state ? Array.from(state.manifests) : [];
      const parsedItems = [];
      const seenUrls = new Set();
      const seenLabels = new Set();

      for (const mediaUrl of rawManifests) {
        const titleClean = cleanMediaTitle('', sender.tab?.title, mediaUrl, mediaUrl.includes('.m3u8'));
        // Deduplicate Instagram/CDN URLs by base path & resolution parameters
        const cleanKey = mediaUrl.split('?')[0] + (mediaUrl.match(/_(\d+p)_/)?.[1] || '');
        if (seenUrls.has(cleanKey)) continue;
        seenUrls.add(cleanKey);

        if (mediaUrl.includes('.mpd')) {
          let qualityLabel = 'MPEG-DASH Stream (.mpd)';
          try {
            const res = await fetch(mediaUrl);
            const text = await res.text();
            const re = /height="(\d+)"/g;
            let maxH = 0;
            let m;
            while ((m = re.exec(text))) {
               const h = parseInt(m[1], 10);
               if (h > maxH) maxH = h;
            }
            if (maxH > 0) qualityLabel = `${maxH}p (DASH)`;
          } catch(e) {}

          const label = `${titleClean} - ${qualityLabel}`;
          if (!seenLabels.has(label)) {
            seenLabels.add(label);
            parsedItems.push({ label, kind: 'dash', url: mediaUrl });
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

        if (info.type === 'master' && info.variants.length) {
          info.variants.forEach((v, idx) => {
            const label = `${titleClean} - ${v.quality} (${v.resolution || 'HLS'})`;
            if (!seenLabels.has(label)) {
              seenLabels.add(label);
              parsedItems.push({ label, kind: 'hls', url: mediaUrl, variantIndex: idx });
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
          let sizeStr = '';
          if (size > 1024 * 1024) sizeStr = ` ${(size / 1024 / 1024).toFixed(2)} MB`;
          else if (size > 1024) sizeStr = ` ${Math.round(size / 1024)} KB`;

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

      sendResponse({
        items: parsedItems,
        subtitles: state ? Array.from(state.subtitles.values()) : [],
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

