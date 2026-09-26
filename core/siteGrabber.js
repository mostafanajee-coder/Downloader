'use strict';

const EventEmitter = require('events');
const { URL } = require('url');
const { request } = require('./httpUtils');

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif']);
const VIDEO_AUDIO_EXTS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'flv', 'wmv', 'm4v', 'ogv', '3gp', 'm3u8', 'mpd',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus',
]);
const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf']);
const OTHER_DOWNLOADABLE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'exe', 'msi', 'apk', 'dmg']);

// Classification used ONLY by the Site Grabber's own file-type filter step
// (Images / Video-Audio / Documents / All). Deliberately separate from
// core/categories.js's getCategoryForUrl(), which drives destination-FOLDER
// selection for the main download list and uses a different bucket set
// (Video/Compressed/Documents/Music/Programs/General) that has no "Images" or
// combined "Video/Audio" bucket — reusing it here would silently make the
// Images and Video/Audio filters match nothing.
function classifyAsset(ext) {
  if (IMAGE_EXTS.has(ext)) return 'Images';
  if (VIDEO_AUDIO_EXTS.has(ext)) return 'Video/Audio';
  if (DOCUMENT_EXTS.has(ext)) return 'Documents';
  if (OTHER_DOWNLOADABLE_EXTS.has(ext)) return 'Other';
  return null; // not a downloadable asset type we care about
}

// One link with a broken %-escape ("bad%E0%A4%A.pdf") used to throw out of
// the extraction loop and end the whole crawl with nothing found.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function kindForUrl(urlStr) {
  const path = urlStr.split('?')[0].split('#')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'file';
}

/**
 * Site Grabber & Web Crawler Engine matching IDM's Site Grabber.
 *
 * Crawls a start page (and optionally one level of same-site sub-pages),
 * discovers downloadable assets (images / video+audio / documents / archives),
 * and streams results as it finds them via 'asset-found' so a UI can render
 * progressively instead of blocking on the whole crawl.
 */
class SiteGrabber extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targetUrl = options.targetUrl;
    // 0 = current page only, 1 = current page + one level of sub-pages.
    this.maxDepth = options.maxDepth === 1 ? 1 : 0;
    // 'Images' | 'Video/Audio' | 'Documents' | 'All'
    this.filterCategory = options.filterCategory || 'All';
    this.sameOriginOnly = options.sameOriginOnly !== false;
    this.headers = options.headers || {};
    this.maxAssets = options.maxAssets || 500;
    this.maxPagesPerLevel = options.maxPagesPerLevel || 20;

    this.visitedUrls = new Set();
    this.foundAssets = new Map(); // url -> { url, filename, category, kind, foundOn }
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async crawl() {
    this.emit('start', { targetUrl: this.targetUrl, maxDepth: this.maxDepth });
    try {
      await this.crawlUrl(this.targetUrl, 0);
    } catch (e) {
      // crawlUrl already catches per-page errors; this guards unexpected throws
      // (e.g. a malformed targetUrl) from leaving the wizard hanging forever.
      this.emit('page-error', { url: this.targetUrl, error: e.message });
    }
    const results = Array.from(this.foundAssets.values());
    this.emit('done', { assets: results, cancelled: this.cancelled });
    return results;
  }

  async crawlUrl(urlStr, currentDepth) {
    if (this.cancelled) return;
    if (currentDepth > this.maxDepth || this.visitedUrls.has(urlStr)) return;
    if (this.foundAssets.size >= this.maxAssets) return;
    this.visitedUrls.add(urlStr);

    this.emit('page-start', { url: urlStr, depth: currentDepth });

    let html, baseUrl;
    try {
      const { res, finalUrl } = await request(urlStr, { method: 'GET', headers: this.headers });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        this.emit('page-error', { url: urlStr, error: `HTTP ${res.statusCode}` });
        return;
      }
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      html = Buffer.concat(chunks).toString('utf8');
      baseUrl = finalUrl || urlStr;
    } catch (e) {
      this.emit('page-error', { url: urlStr, error: e.message });
      return;
    }

    if (this.cancelled) return;
    this.extractAssetsFromHtml(html, baseUrl);

    if (currentDepth < this.maxDepth && !this.cancelled) {
      const pageLinks = this.extractChildPageLinks(html, baseUrl);
      for (const link of pageLinks) {
        if (this.cancelled || this.foundAssets.size >= this.maxAssets) break;
        await this.crawlUrl(link, currentDepth + 1);
      }
    }
  }

  extractAssetsFromHtml(html, baseUrl) {
    const linkRegex = /(?:href|src|data-src)=["']([^"']+)["']/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      if (this.foundAssets.size >= this.maxAssets) return;
      const relativeUri = match[1];
      if (!relativeUri || relativeUri.startsWith('javascript:') || relativeUri.startsWith('#') || relativeUri.startsWith('data:')) continue;

      let absoluteUrl;
      try {
        absoluteUrl = new URL(relativeUri, baseUrl).toString();
      } catch (e) {
        continue;
      }
      if (this.foundAssets.has(absoluteUrl)) continue;

      const filename = safeDecode(absoluteUrl.split('/').pop().split('?')[0].split('#')[0]) || 'asset.bin';
      const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
      const category = classifyAsset(ext);
      if (!category) continue; // not a recognized downloadable type at all

      // 'Other' (archives/programs) only surfaces under the "All Files" filter;
      // it isn't a filter option of its own.
      if (this.filterCategory !== 'All' && category !== this.filterCategory) continue;

      const asset = {
        url: absoluteUrl,
        filename,
        category,
        kind: kindForUrl(absoluteUrl),
        foundOn: baseUrl,
      };
      this.foundAssets.set(absoluteUrl, asset);
      this.emit('asset-found', asset);
    }
  }

  extractChildPageLinks(html, baseUrl) {
    const links = [];
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;
    let baseHost;
    try {
      baseHost = new URL(baseUrl).hostname;
    } catch (e) {
      return links;
    }

    while ((match = hrefRegex.exec(html)) !== null) {
      if (links.length >= this.maxPagesPerLevel) break;
      try {
        const absoluteUrl = new URL(match[1], baseUrl).toString();
        if (absoluteUrl.includes('#')) continue;
        if (this.sameOriginOnly && new URL(absoluteUrl).hostname !== baseHost) continue;

        // Skip links that are themselves downloadable assets (already captured
        // by extractAssetsFromHtml) rather than navigable pages — otherwise the
        // crawler would issue a full GET on every discovered file (potentially
        // multi-MB) just to scan its bytes for more href/src attributes.
        const filename = absoluteUrl.split('/').pop().split('?')[0];
        const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        if (classifyAsset(ext)) continue;

        if (!links.includes(absoluteUrl)) links.push(absoluteUrl);
      } catch (e) {}
    }
    return links;
  }
}

module.exports = { SiteGrabber, classifyAsset, kindForUrl };
