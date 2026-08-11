'use strict';

/**
 * Smart Exclusions Filter
 * A twin feature to IDM's defexclist.txt
 * Ignores dummy requests, tracking pixels, ads, and tiny audio files.
 */

const EXCLUDED_DOMAINS = [
  'yieldmanager.com',
  'doubleclick.net',
  'google-analytics.com',
  'facebook.com/tr', // Facebook pixel
  'akamaihd.net',
  'gstatic.com',
];

const EXCLUDED_EXTENSIONS = [
  'gif', 'jpg', 'jpeg', 'png', 'svg', 'webp', 'ico', 'js', 'css', 'woff', 'woff2', 'ttf', 'eot', 'json', 'xml'
];

/**
 * Determines if a URL should be ignored completely.
 * @param {string} url - The URL to check
 * @param {string} type - The resource type (e.g. 'media', 'xmlhttprequest')
 * @param {string} initiator - The tab's domain or initiator origin
 */
function shouldExclude(url, type, initiator) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const path = urlObj.pathname.toLowerCase();

    // 1. Check blacklisted domains
    for (const d of EXCLUDED_DOMAINS) {
      if (domain.includes(d)) return true;
    }

    // 2. Ignore non-media resource types if they don't look like streams
    if (type !== 'media' && type !== 'xmlhttprequest' && type !== 'main_frame' && type !== 'sub_frame') {
      return true;
    }

    // 3. Check for explicitly excluded extensions (like images pretending to be media)
    const ext = path.split('.').pop();
    if (EXCLUDED_EXTENSIONS.includes(ext)) {
      return true;
    }

    return false;
  } catch (e) {
    return false; // If we can't parse it, don't exclude it just in case
  }
}

// In a browser extension environment, module.exports won't work unless using a bundler or ES modules.
// We'll attach it to the global window/self object so background.js can use it.
if (typeof self !== 'undefined') {
  self.shouldExclude = shouldExclude;
}
