'use strict';

const BTN_CLASS = 'ddl-float-btn';
const MENU_CLASS = 'ddl-float-menu';

// When true, the floating overlay is suppressed in favor of the Side Panel
// (media discovery itself is unaffected — background.js keeps tracking media
// for every tab regardless of display mode; this only gates whether THIS
// content script renders its own floating UI on top of the page).
let sidePanelModeActive = false;

function getPageTitle() {
  let title = '';
  try { title = window.top.document.title; } catch(e) {}
  if (!title) {
    try { title = document.title; } catch(e) {}
  }
  if (!title) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) title = ogTitle.getAttribute('content');
  }
  if (!title) {
    const h1 = document.querySelector('h1');
    if (h1) title = h1.textContent;
  }
  return title;
}

function cleanTitle(title) {
  if (!title) return '';
  title = title.replace(/^\(\d+\)\s*/, '').replace(/[ \t\r\n\u25B6]+/g, ' ').trim();
  return title
    .replace(/[-|_]?(مشاهدة|تحميل|اون لاين|فاصل اعلاني|FaselHD|Fasel|شاهد|انمي|مترجم).*/ig, '')
    .replace(/[\/\\?%*:|"<>]/g, '')
    .trim() || '';
}

// 1. Ultra-fast targeted Video Scanner without heavy full-DOM iterations
function findVideos(root = document) {
  const results = [];
  try {
    const direct = root.querySelectorAll('video, audio');
    for (let i = 0; i < direct.length; i++) {
      results.push(direct[i]);
    }

    // Look for shadow roots inside known player containers and web components
    const shadowHosts = root.querySelectorAll('[id*="player"], [class*="player"], media-player, shaka-player, amp-video');
    for (let i = 0; i < shadowHosts.length; i++) {
      const sr = shadowHosts[i].shadowRoot;
      if (sr) {
        const nested = sr.querySelectorAll('video, audio');
        for (let j = 0; j < nested.length; j++) {
          results.push(nested[j]);
        }
      }
    }
  } catch (e) {}
  return results;
}

function positionOverlay(overlay, video) {
  if (!video || !overlay) return;
  const rect = video.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 30 || (video.offsetWidth === 0 && video.offsetHeight === 0)) {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';
  overlay.style.top = `${window.scrollY + rect.top + 8}px`;
  overlay.style.left = `${window.scrollX + rect.right - 185}px`;
  overlay.style.zIndex = '2147483647';
}

function closeMenus() {
  document.querySelectorAll(`.${MENU_CLASS}`).forEach((m) => m.remove());
}

// runtime.sendMessage rejects while the service worker is (re)starting and
// throws once the extension has been reloaded under a live page. Either way the
// page must not collect uncaught errors, and the caller gets `null`.
async function sendToExtension(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return null;
  }
}

async function buildMenuItems(video) {
  const items = [];
  let bgItems = [];
  let subtitles = [];

  try {
    const sendMessagePromise = sendToExtension({ type: 'get-media-for-tab' });
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
    const res = await Promise.race([sendMessagePromise, timeoutPromise]);
    if (res) {
      bgItems = res.items || [];
      subtitles = res.subtitles || [];
    }
  } catch (e) {}

  if (bgItems.length) {
    items.push(...bgItems);
  }

  // Inspect direct video source
  const directSrc = video.currentSrc || video.src || video.querySelector('source')?.src;
  const titleClean = cleanTitle(getPageTitle());

  if (directSrc && !directSrc.startsWith('blob:') && !items.some((i) => i.url === directSrc)) {
    let fn = null;
    try {
      const last = new URL(directSrc).pathname.split('/').pop();
      if (last && /\.(mp4|webm)$/i.test(last)) fn = decodeURIComponent(last);
    } catch(e) {}
    items.push({ label: `${fn || titleClean || 'Video'} - Direct MP4 Video`, kind: 'file', url: directSrc });
  }

  // Inspect page performance resources for media streams
  try {
    const resources = performance.getEntriesByType('resource');
    for (const res of resources) {
      const u = res.name;
      if (u && (u.includes('.mp4') || u.includes('.m3u8') || u.includes('.webm') || u.includes('videoplayback') || u.includes('mime=video')) && !u.startsWith('blob:')) {
        const cleanU = u.replace(/&range=\d+-\d+/i, '').replace(/&bytestart=\d+/i, '');
        if (!items.some((i) => i.url === cleanU)) {
          const isHls = cleanU.includes('.m3u8');
          items.push({
            label: `${titleClean || 'Video'} - Captured ${isHls ? 'HLS Stream' : 'Video Stream'}`,
            kind: isHls ? 'hls' : 'file',
            url: cleanU,
          });
        }
      }
    }
  } catch (e) {}

  // No fallback to the page's own URL: that "video" was the HTML document,
  // and the app dutifully saved a web page under a video's name. An empty list
  // shows "No video link captured yet" instead, which is the truth.

  const subItems = [];
  video.querySelectorAll('track').forEach((track) => {
    if (track.src) {
      subItems.push({ label: `Subtitle: ${track.label || track.srclang || 'unknown'}`, kind: 'file', url: track.src });
    }
  });
  for (const sub of subtitles) {
    if (!subItems.some((s) => s.url === sub.url)) {
      subItems.push({ label: `Subtitle: ${sub.url.split('/').pop()}`, kind: 'file', url: sub.url });
    }
  }

  return { items, subItems };
}

async function onButtonClick(video, btn) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = MENU_CLASS;
  menu.style.zIndex = '2147483647';
  menu.textContent = 'Scanning available video qualities...';
  document.body.appendChild(menu);
  positionMenu(menu, btn);

  menu.addEventListener('mouseleave', (e) => {
    if (!e.relatedTarget || !e.relatedTarget.closest(`.${BTN_CLASS}`)) {
      setTimeout(closeMenus, 300);
    }
  });

  const { items, subItems } = await buildMenuItems(video);
  menu.innerHTML = '';

  if (!items.length) {
    menu.innerHTML = '<div class="ddl-menu-empty">No video link captured yet</div>';
  }

  const pageTitleClean = cleanTitle(getPageTitle());

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ddl-menu-item';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';

    const kindBadge = (item.kind || 'FILE').toUpperCase();
    
    const labelSpan = document.createElement('span');
    labelSpan.textContent = item.label;
    labelSpan.style.flex = '1';

    const actionsContainer = document.createElement('div');
    actionsContainer.style.display = 'flex';
    actionsContainer.style.gap = '6px';
    actionsContainer.style.alignItems = 'center';

    // Copy Link Action Button
    const copyBtn = document.createElement('button');
    copyBtn.innerHTML = '📋';
    copyBtn.title = 'Copy Media URL';
    copyBtn.style.background = 'none';
    copyBtn.style.border = 'none';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.fontSize = '12px';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(item.url);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
    });

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'ddl-menu-badge';
    badgeSpan.textContent = kindBadge;

    actionsContainer.appendChild(copyBtn);
    actionsContainer.appendChild(badgeSpan);

    row.appendChild(labelSpan);
    row.appendChild(actionsContainer);

    row.addEventListener('click', async () => {
      labelSpan.textContent = `${item.label} — sending...`;
      const res = await sendToExtension({
        type: 'download-media',
        url: item.url,
        kind: item.kind,
        variantIndex: item.variantIndex,
        title: pageTitleClean,
      });
      labelSpan.textContent = res?.sent ? `${item.label} ✓ Sent to IDM` : `${item.label} — IDM not connected`;
      setTimeout(closeMenus, 1200);
    });
    menu.appendChild(row);
  }

  if (subItems.length) {
    const sep = document.createElement('div');
    sep.className = 'ddl-menu-sep';
    sep.textContent = 'Subtitles';
    menu.appendChild(sep);
    for (const item of subItems) {
      const row = document.createElement('div');
      row.className = 'ddl-menu-item';
      row.textContent = item.label;
      row.addEventListener('click', async () => {
        row.textContent = `${item.label} — sending...`;
        const res = await sendToExtension({ type: 'download-media', url: item.url, kind: 'file', title: `${pageTitleClean}_sub` });
        row.textContent = res?.sent ? `${item.label} ✓ Sent to IDM` : `${item.label} — IDM not connected`;
        setTimeout(closeMenus, 1200);
      });
      menu.appendChild(row);
    }
  }
}

function positionMenu(menu, btn) {
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${window.scrollY + rect.bottom + 4}px`;
  menu.style.left = `${window.scrollX + rect.left}px`;
}

// Global active overlays map for centralized throttled repositioning
const activeOverlays = new Map(); // video -> { btn }
let repositionScheduled = false;

function repositionAllOverlays() {
  repositionScheduled = false;
  for (const [video, data] of activeOverlays.entries()) {
    if (!document.body.contains(video) || video.dataset.ddlDismissed) {
      data.btn.remove();
      activeOverlays.delete(video);
      continue;
    }
    positionOverlay(data.btn, video);
  }
}

function requestReposition() {
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(repositionAllOverlays);
}

// Single, passive listeners for scrolling and viewport changes
window.addEventListener('scroll', requestReposition, { passive: true });
window.addEventListener('resize', requestReposition, { passive: true });

function attachOverlay(video) {
  if (sidePanelModeActive) return;
  if (video.dataset.ddlAttached || video.dataset.ddlDismissed) return;
  
  // Guard against tiny audio/tracking elements
  const rect = video.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0 && (rect.width < 50 || rect.height < 30)) {
    return;
  }

  video.dataset.ddlAttached = '1';

  const allVideos = findVideos();
  const countTag = allVideos.length > 1 ? ` (${allVideos.length})` : '';

  const btn = document.createElement('div');
  btn.className = BTN_CLASS;
  btn.innerHTML = `
    <span class="ddl-btn-main">
      <svg class="idm-icon" viewBox="0 0 24 24"><path d="M7 5.5v13l11-6.5-11-6.5Z"/></svg>
      Download this video${countTag}
    </span>
    <span class="ddl-btn-help" title="IDM Panel Help">?</span>
    <span class="ddl-btn-close" title="Hide panel">×</span>
  `;
  btn.title = 'Internet Download Manager Panel';
  document.body.appendChild(btn);

  activeOverlays.set(video, { btn });
  positionOverlay(btn, video);

  const mainBtn = btn.querySelector('.ddl-btn-main');
  const closeBtn = btn.querySelector('.ddl-btn-close');

  let hoverTimer = null;

  btn.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      onButtonClick(video, btn);
    }, 100);
  });

  btn.addEventListener('mouseleave', (e) => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!e.relatedTarget || !e.relatedTarget.closest(`.${MENU_CLASS}`)) {
        closeMenus();
      }
    }, 400);
  });

  mainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onButtonClick(video, btn);
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenus();
    video.dataset.ddlDismissed = '1';
    btn.remove();
    activeOverlays.delete(video);
  });
}

function scan() {
  if (sidePanelModeActive) return;
  findVideos().forEach(attachOverlay);
}

let scanDebounceTimer = null;
function scheduleScan() {
  if (sidePanelModeActive) return;
  if (scanDebounceTimer) return;
  scanDebounceTimer = setTimeout(() => {
    scanDebounceTimer = null;
    scan();
  }, 250);
}

// Tears down every currently-attached floating button and clears the
// per-video dataset flags that would otherwise make attachOverlay() skip
// those videos when the user switches back to Floating Button mode later.
function removeAllFloatingButtons() {
  closeMenus();
  document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => btn.remove());
  activeOverlays.clear();
  findVideos().forEach((video) => {
    delete video.dataset.ddlAttached;
    delete video.dataset.ddlDismissed;
  });
}

async function initUiMode() {
  try {
    const { uiMode } = await chrome.storage.sync.get('uiMode');
    sidePanelModeActive = uiMode === 'sidepanel';
  } catch (e) {
    sidePanelModeActive = false;
  }
  if (sidePanelModeActive) removeAllFloatingButtons();
  else scheduleScan();
}

// Respects the popup/panel's mode toggle instantly, with no page reload:
// chrome.storage.onChanged fires in every frame with a listener registered
// (matters here since manifest.json runs this content script in all_frames).
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.uiMode) return;
    sidePanelModeActive = changes.uiMode.newValue === 'sidepanel';
    if (sidePanelModeActive) {
      removeAllFloatingButtons();
    } else {
      scheduleScan();
    }
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest(`.${MENU_CLASS}`) && !e.target.closest(`.${BTN_CLASS}`)) closeMenus();
});

// --- Capture modifier keys (IDM's Options → General → Keys) ------------------
const DEFAULT_CAPTURE_KEYS = {
  force: { enabled: false, alt: false, ctrl: false, shift: false, ins: true },
  bypass: { enabled: true, alt: true, ctrl: false, shift: false, del: false },
};

let captureKeys = DEFAULT_CAPTURE_KEYS;
let insertHeld = false;
let deleteHeld = false;

function migrateLegacyKeys(cfg) {
  if (!cfg || (cfg.captureForceKey === undefined && cfg.captureBypassKey === undefined)) return null;
  const asSpec = (name, isForce) => ({
    enabled: Boolean(name) && name !== 'None',
    alt: name === 'Alt',
    ctrl: name === 'Ctrl',
    shift: name === 'Shift',
    [isForce ? 'ins' : 'del']: name === 'Insert' || name === 'Delete',
  });
  return {
    force: asSpec(cfg.captureForceKey, true),
    bypass: asSpec(cfg.captureBypassKey, false),
  };
}

function loadCaptureKeys() {
  try {
    chrome.storage.sync.get(['captureKeys', 'captureForceKey', 'captureBypassKey'], (cfg) => {
      if (chrome.runtime.lastError || !cfg) return;
      if (cfg.captureKeys && cfg.captureKeys.force && cfg.captureKeys.bypass) {
        captureKeys = cfg.captureKeys;
        return;
      }
      const migrated = migrateLegacyKeys(cfg);
      if (migrated) captureKeys = migrated;
    });
  } catch (e) {
    /* keep the defaults */
  }
}

function comboActive(spec, e) {
  if (!spec || !spec.enabled) return false;
  const required = [];
  if (spec.alt) required.push(Boolean(e && e.altKey));
  if (spec.ctrl) required.push(Boolean(e && e.ctrlKey));
  if (spec.shift) required.push(Boolean(e && e.shiftKey));
  if (spec.ins) required.push(insertHeld);
  if (spec.del) required.push(deleteHeld);
  if (!required.length) return false;
  return required.every(Boolean);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Insert') insertHeld = true;
  else if (e.key === 'Delete') deleteHeld = true;
}, true);
window.addEventListener('keyup', (e) => {
  if (e.key === 'Insert') insertHeld = false;
  else if (e.key === 'Delete') deleteHeld = false;
}, true);
window.addEventListener('blur', () => {
  insertHeld = false;
  deleteHeld = false;
});

document.addEventListener('mousedown', (e) => {
  const force = comboActive(captureKeys.force, e);
  const bypass = comboActive(captureKeys.bypass, e);
  sendToExtension({ type: 'capture-hint', force, bypass });
}, true);

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.captureKeys && changes.captureKeys.newValue) captureKeys = changes.captureKeys.newValue;
  });
}

loadCaptureKeys();
initUiMode();

// Safe, debounced MutationObserver with self-mutation filtering
const observer = new MutationObserver((mutations) => {
  if (sidePanelModeActive) return;
  let hasRelevantChange = false;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.target && m.target.classList && (m.target.classList.contains(BTN_CLASS) || m.target.classList.contains(MENU_CLASS))) {
      continue;
    }
    const added = m.addedNodes;
    for (let j = 0; j < added.length; j++) {
      const node = added[j];
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.classList && (node.classList.contains(BTN_CLASS) || node.classList.contains(MENU_CLASS))) continue;
      if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || (node.querySelector && node.querySelector('video, audio'))) {
        hasRelevantChange = true;
        break;
      }
    }
    if (hasRelevantChange) break;
  }
  if (hasRelevantChange) {
    scheduleScan();
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
