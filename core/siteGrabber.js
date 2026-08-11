'use strict';

const { URL } = require('url');
const { request } = require('./httpUtils');
const { getCategoryForUrl } = require('./categories');

/**
 * Site Grabber & Web Crawler Engine matching IDM Site Grabber
 */
class SiteGrabber {
  constructor(options = {}) {
    this.targetUrl = options.targetUrl;
    this.maxDepth = options.maxDepth || 1; // 1 = single page, 2 = 1 level deep
    this.filterCategory = options.filterCategory || 'All'; // 'Video', 'Images', 'Audio', 'Documents', 'All'
    this.headers = options.headers || {};
    this.visitedUrls = new Set();
    this.foundAssets = new Map(); // url -> { url, filename, category, size }
  }

  async crawl() {
    console.log(`[SiteGrabber] Starting web spider on ${this.targetUrl} (max depth: ${this.maxDepth})`);
    await this.crawlUrl(this.targetUrl, 0);
    return Array.from(this.foundAssets.values());
  }

  async crawlUrl(urlStr, currentDepth) {
    if (currentDepth > this.maxDepth || this.visitedUrls.has(urlStr)) return;
    this.visitedUrls.add(urlStr);

    try {
      const { res, finalUrl } = await request(urlStr, { method: 'GET', headers: this.headers });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return;
      }

      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      const html = Buffer.concat(chunks).toString('utf8');
      const baseUrl = finalUrl || urlStr;

      // Extract all media assets and links
      this.extractAssetsFromHtml(html, baseUrl);

      // If depth > currentDepth, extract child pages
      if (currentDepth < this.maxDepth) {
        const pageLinks = this.extractChildPageLinks(html, baseUrl);
        for (const link of pageLinks) {
          await this.crawlUrl(link, currentDepth + 1);
        }
      }
    } catch (e) {
      console.warn(`[SiteGrabber] Error crawling ${urlStr}:`, e.message);
    }
  }

  extractAssetsFromHtml(html, baseUrl) {
    // Regex for href and src attributes
    const linkRegex = /(?:href|src|data-src)=["']([^"']+)["']/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const relativeUri = match[1];
      if (!relativeUri || relativeUri.startsWith('javascript:') || relativeUri.startsWith('#')) continue;

      try {
        const absoluteUrl = new URL(relativeUri, baseUrl).toString();
        const category = getCategoryForUrl(absoluteUrl);

        if (this.filterCategory !== 'All' && category !== this.filterCategory) {
          continue;
        }

        const filename = absoluteUrl.split('/').pop().split('?')[0] || 'asset.bin';
        const ext = filename.split('.').pop().toLowerCase();

        // Only include media/asset extensions or categorized files
        if (['mp4', 'm3u8', 'webm', 'mp3', 'png', 'jpg', 'jpeg', 'gif', 'pdf', 'zip', 'rar', 'exe', 'iso', '7z'].includes(ext) || category !== 'General') {
          if (!this.foundAssets.has(absoluteUrl)) {
            this.foundAssets.set(absoluteUrl, {
              url: absoluteUrl,
              filename,
              category,
              foundOn: baseUrl
            });
          }
        }
      } catch (e) {}
    }
  }

  extractChildPageLinks(html, baseUrl) {
    const links = [];
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;
    const baseHost = new URL(baseUrl).hostname;

    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const absoluteUrl = new URL(match[1], baseUrl).toString();
        // Stay on same domain for deep crawling
        if (new URL(absoluteUrl).hostname === baseHost && !absoluteUrl.includes('#')) {
          links.push(absoluteUrl);
        }
      } catch (e) {}
    }
    return links.slice(0, 20); // Limit to top 20 links per page
  }
}

module.exports = { SiteGrabber };
