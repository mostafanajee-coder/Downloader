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

// 1. Recursive Shadow DOM & DOM Video Scanner
function findVideosRecursive(root = document) {
  let results = [];
  try {
    const videos = Array.from(root.querySelectorAll('video, audio'));
    results.push(...videos);

    // Deep Shadow DOM traversal
    const allNodes = Array.from(root.querySelectorAll('*'));
    for (const node of allNodes) {
      if (node.shadowRoot) {
        results.push(...findVideosRecursive(node.shadowRoot));
      }
    }
  } catch (e) {}
  return results;
}

function positionOverlay(overlay, video) {
  const rect = video.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 15) {
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

async function buildMenuItems(video) {
  const items = [];
  let bgItems = [];
  let subtitles = [];

  try {
    const sendMessagePromise = chrome.runtime.sendMessage({ type: 'get-media-for-tab' });
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
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

  // Fallback: Guarantee no empty list
  if (!items.length) {
    const fallbackUrl = (directSrc && !directSrc.startsWith('blob:')) ? directSrc : window.location.href;
    items.push({
      label: `${titleClean || 'Video'} - Download Page Video Stream`,
      kind: fallbackUrl.includes('.m3u8') ? 'hls' : 'file',
      url: fallbackUrl,
    });
  }

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
      const res = await chrome.runtime.sendMessage({
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
        const res = await chrome.runtime.sendMessage({ type: 'download-media', url: item.url, kind: 'file', title: `${pageTitleClean}_sub` });
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

function attachOverlay(video) {
  if (sidePanelModeActive) return;
  if (video.dataset.ddlAttached || video.dataset.ddlDismissed) return;
  video.dataset.ddlAttached = '1';

  const allVideos = findVideosRecursive();
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

  const reposition = () => {
    if (video.dataset.ddlDismissed) {
      btn.remove();
      return;
    }
    positionOverlay(btn, video);
  };
  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  new ResizeObserver(reposition).observe(video);

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
  });
}

function scan() {
  findVideosRecursive().forEach(attachOverlay);
}

// Tears down every currently-attached floating button and clears the
// per-video dataset flags that would otherwise make attachOverlay() skip
// those videos when the user switches back to Floating Button mode later.
function removeAllFloatingButtons() {
  closeMenus();
  document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => btn.remove());
  findVideosRecursive().forEach((video) => {
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
  else scan();
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
      // The MutationObserver below won't refire for videos already sitting
      // in the DOM unchanged, so switching back needs an explicit re-scan to
      // reattach buttons to whatever's already on the page.
      scan();
    }
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest(`.${MENU_CLASS}`) && !e.target.closest(`.${BTN_CLASS}`)) closeMenus();
});

// --- Capture modifier keys (IDM's Options → General → Keys) ------------------
// Hold the "force" combination while clicking a link and the app takes the
// download even if it wouldn't normally be captured; hold the "bypass"
// combination and the browser keeps it.
//
// IDM models each of these as a set of independent checkboxes plus a master
// enable (its SpecialKeys registry values are UseKeyToForce/UseKeyToPrevent
// with AltF/CtrlF/ShiftF/InsF and AltP/CtrlP/ShiftP/DelP), so ALL the ticked
// keys must be held together — Ctrl+Shift is expressible. A real install ships
// with force off and Alt-to-bypass on, and those are the defaults here.
//
// Alt/Ctrl/Shift come free on the click event. Insert and Delete don't — they
// aren't modifiers — so their held state is tracked separately.
const DEFAULT_CAPTURE_KEYS = {
  force: { enabled: false, alt: false, ctrl: false, shift: false, ins: true },
  bypass: { enabled: true, alt: true, ctrl: false, shift: false, del: false },
};

let captureKeys = DEFAULT_CAPTURE_KEYS;
let insertHeld = false;
let deleteHeld = false;

// Accepts the older single-key setting so an existing install keeps working
// after an update instead of silently reverting to defaults.
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

/**
 * Every ticked key must be held at once. An enabled combination with nothing
 * ticked stays inactive on purpose — otherwise it would fire on every plain
 * click and silently override capture for the whole browsing session.
 */
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
// A lost keyup (tab switch, alt-tab) would otherwise leave a key stuck on.
window.addEventListener('blur', () => {
  insertHeld = false;
  deleteHeld = false;
});

// Reported on every mousedown, not just modified ones: the flag has to be
// *cleared* by an ordinary click too, or a plain download moments after a
// modified one would inherit the previous decision.
document.addEventListener('mousedown', (e) => {
  const force = comboActive(captureKeys.force, e);
  const bypass = comboActive(captureKeys.bypass, e);
  try {
    chrome.runtime.sendMessage({ type: 'capture-hint', force, bypass });
  } catch (err) {
    // Extension context invalidated (reload/update) — nothing to do.
  }
}, true);

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.captureKeys && changes.captureKeys.newValue) captureKeys = changes.captureKeys.newValue;
  });
}

loadCaptureKeys();
initUiMode();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
