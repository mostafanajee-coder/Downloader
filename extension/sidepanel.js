'use strict';

// Global single side panel page: not registered per-tab via
// chrome.sidePanel.setOptions — this same page instance stays loaded across
// tab switches within its window, so it tracks "which tab is active" itself
// and re-subscribes to background.js's Port protocol whenever that changes.

let myWindowId = null;
let currentTabId = null;
let port = null;
let reconnectDelay = 500;

const mediaListEl = document.getElementById('media-list');
const subtitlesSectionEl = document.getElementById('subtitles-section');
const subtitlesListEl = document.getElementById('subtitles-list');
const tabTitleEl = document.getElementById('tab-title');
const tabFaviconEl = document.getElementById('tab-favicon');
const bridgeStatusEl = document.getElementById('bridge-status');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function renderEmpty() {
  mediaListEl.innerHTML = '<div class="empty-state">No media detected yet on this page.</div>';
  subtitlesSectionEl.classList.add('hidden');
  subtitlesListEl.innerHTML = '';
}

function renderItems(items, subtitles) {
  if (!items || !items.length) {
    mediaListEl.innerHTML = '<div class="empty-state">No media detected yet on this page.</div>';
  } else {
    mediaListEl.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'media-item';
      row.innerHTML = `
        <div class="media-item-main">
          <span class="media-item-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
          <span class="media-item-badge">${escapeHtml((item.kind || 'file').toUpperCase())}</span>
        </div>
        <div class="media-item-actions">
          <button class="media-download-btn">Download</button>
          <button class="media-copy-btn" title="Copy link">Copy</button>
        </div>
      `;
      row.querySelector('.media-download-btn').addEventListener('click', () => downloadItem(item));
      row.querySelector('.media-copy-btn').addEventListener('click', (e) => copyItemUrl(item, e.currentTarget));
      mediaListEl.appendChild(row);
    }
  }

  if (subtitles && subtitles.length) {
    subtitlesSectionEl.classList.remove('hidden');
    subtitlesListEl.innerHTML = '';
    for (const sub of subtitles) {
      const row = document.createElement('div');
      row.className = 'media-item';
      row.innerHTML = `
        <div class="media-item-main">
          <span class="media-item-label" title="${escapeHtml(sub.url)}">${escapeHtml(sub.label || sub.url)}</span>
        </div>
        <div class="media-item-actions">
          <button class="media-download-btn">Download</button>
        </div>
      `;
      row.querySelector('.media-download-btn').addEventListener('click', () =>
        downloadItem({ url: sub.url, kind: 'file', label: sub.label })
      );
      subtitlesListEl.appendChild(row);
    }
  } else {
    subtitlesSectionEl.classList.add('hidden');
  }
}

async function downloadItem(item) {
  try {
    await chrome.runtime.sendMessage({
      type: 'download-media',
      url: item.url,
      kind: item.kind,
      variantIndex: item.variantIndex,
      title: tabTitleEl.textContent,
    });
  } catch (e) {
    console.warn('[SidePanel] Failed to send download request:', e);
  }
}

function copyItemUrl(item, btn) {
  navigator.clipboard
    .writeText(item.url)
    .then(() => {
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    })
    .catch(() => {});
}

function updateBridgeStatus(connected) {
  bridgeStatusEl.textContent = connected ? 'Connected to app' : 'App not running';
  bridgeStatusEl.classList.toggle('ok', connected);
  bridgeStatusEl.classList.toggle('bad', !connected);
}

async function refreshTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitleEl.textContent = tab.title || tab.url || 'Untitled tab';
    if (tab.favIconUrl) {
      tabFaviconEl.src = tab.favIconUrl;
      tabFaviconEl.style.visibility = 'visible';
    } else {
      tabFaviconEl.style.visibility = 'hidden';
    }
  } catch (e) {
    tabTitleEl.textContent = 'No active tab';
    tabFaviconEl.style.visibility = 'hidden';
  }
}

function subscribeToCurrentTab() {
  if (port && currentTabId != null) {
    try {
      port.postMessage({ type: 'subscribe', tabId: currentTabId });
    } catch (e) {
      // Port died between the check and the send — onDisconnect will fire
      // and trigger a reconnect; nothing more to do here.
    }
  }
}

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'sidepanel' });
  } catch (e) {
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'bridge-status') {
      updateBridgeStatus(Boolean(msg.bridgeConnected));
      return;
    }
    if (msg.tabId !== currentTabId) return; // stale push for a tab we've since switched away from
    if (msg.type === 'snapshot') {
      reconnectDelay = 500; // a live message proves the connection is healthy
      renderItems(msg.items, msg.subtitles);
      updateBridgeStatus(Boolean(msg.bridgeConnected));
    } else if (msg.type === 'reset') {
      renderEmpty();
    }
  });

  // MV3 service workers are ephemeral — Chrome can terminate background.js
  // after a period of inactivity, which disconnects any open ports. Without
  // reconnecting, the panel would silently go stale for the rest of the
  // browsing session. Backoff mirrors extension/background.js's own
  // WebSocket reconnect pattern for the desktop bridge.
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect();
  });

  // Re-announce whichever tab we were already tracking — matters on
  // reconnect (service worker restarted mid-session), not just first
  // connect, where currentTabId is still null and this is a harmless no-op.
  subscribeToCurrentTab();
}

function scheduleReconnect() {
  setTimeout(connectPort, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

async function trackActiveTab() {
  try {
    // Prefer the explicitly-resolved window id; fall back to Chrome's own
    // "current window" resolution if init() couldn't determine it (e.g. a
    // transient failure of chrome.windows.getCurrent()) — this still finds
    // the right tab rather than tracking nothing for the rest of the session.
    const query = myWindowId != null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true };
    const [tab] = await chrome.tabs.query(query);
    if (!tab) return;
    if (tab.id === currentTabId) {
      // Same tab — still refresh title/favicon in case they changed without
      // a full navigation (e.g. an SPA updating document.title).
      refreshTabInfo(tab.id);
      return;
    }
    currentTabId = tab.id;
    renderEmpty();
    refreshTabInfo(tab.id);
    subscribeToCurrentTab();
  } catch (e) {
    // Window/tab may have closed mid-query — nothing actionable here.
  }
}

async function init() {
  try {
    const win = await chrome.windows.getCurrent();
    myWindowId = win.id;
  } catch (e) {
    // Extremely unlikely in a real extension context (this API is always
    // available to an extension page), but if it ever fails, degrade to
    // "track whatever tab is active in whichever window this panel is in"
    // via chrome.tabs.query's own currentWindow resolution rather than
    // aborting the rest of initialization (port connect, mode toggle, etc.).
    console.warn('[SidePanel] Failed to resolve the current window:', e);
  }

  // Multi-window correctness: this panel instance belongs to exactly one
  // browser window, so every tab-activation event must be filtered to that
  // window — otherwise switching tabs in a DIFFERENT window would incorrectly
  // re-render this panel. When myWindowId couldn't be resolved, fall back to
  // reacting to every activation (trackActiveTab's own currentWindow-based
  // query still scopes correctly per-call).
  chrome.tabs.onActivated.addListener((info) => {
    if (myWindowId == null || info.windowId === myWindowId) trackActiveTab();
  });

  // A same-tab navigation doesn't fire onActivated; background.js already
  // pushes 'reset' + a fresh 'snapshot' down the port for the subscribed
  // tabId when that happens, so no separate listener is needed for the media
  // list itself. We do still want the title/favicon to refresh promptly.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTabId && (changeInfo.title || changeInfo.favIconUrl || changeInfo.url)) {
      refreshTabInfo(tabId);
    }
  });

  connectPort();
  await trackActiveTab();

  ddlInitModeToggle({
    floatingBtnId: 'mode-floating-btn',
    sidepanelBtnId: 'mode-sidepanel-btn',
    sectionId: null, // this section always stays visible inside the panel itself
  });
}

init();
