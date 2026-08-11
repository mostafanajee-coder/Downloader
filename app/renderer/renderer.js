'use strict';

// Elements
const queueBody = document.getElementById('queue-body');
const mainSidebar = document.getElementById('main-sidebar');
const mainStatusbar = document.getElementById('main-statusbar');

const statusActive = document.getElementById('status-active');
const statusSpeed = document.getElementById('status-speed');
const statusTotal = document.getElementById('status-total');

// Modals
const addUrlModal = document.getElementById('add-url-modal');
const addModalClose = document.getElementById('add-modal-close');
const addConfirmBtn = document.getElementById('add-confirm-btn');
const addCancelBtn = document.getElementById('add-cancel-btn');
const urlInput = document.getElementById('url-input');

const downloadInfoModal = document.getElementById('download-info-modal');
const infoModalClose = document.getElementById('info-modal-close');
const infoUrlInput = document.getElementById('info-url-input');
const infoCategorySelect = document.getElementById('info-category-select');
const infoSizeDisplay = document.getElementById('info-size-display');
const infoDestInput = document.getElementById('info-dest-input');
const infoStartBtn = document.getElementById('info-start-btn');
const infoLaterBtn = document.getElementById('info-later-btn');
const infoCancelBtn = document.getElementById('info-cancel-btn');

const refreshUrlModal = document.getElementById('refresh-url-modal');
const refreshModalClose = document.getElementById('refresh-modal-close');
const refreshNewUrlInput = document.getElementById('refresh-new-url-input');
const refreshConfirmBtn = document.getElementById('refresh-confirm-btn');
const refreshCancelBtn = document.getElementById('refresh-cancel-btn');

const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const optionsBtn = document.getElementById('options-btn');

const contextMenu = document.getElementById('idm-context-menu');

// State
const items = new Map();
let selectedIds = new Set();
let currentCategory = 'all';
let pendingDownloadUrl = '';
let pendingRefreshId = null;
let appConfig = {}; // last-known config (for sound toggles etc.)
let _prevActive = 0; // active-download count, for queue-complete detection

// --- Sound events (WebAudio tones; no bundled assets needed) ---
let _audioCtx = null;
function playTone(freqs, dur = 0.16) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    let t = ctx.currentTime;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
      t += dur;
    }
  } catch (e) {
    /* audio not available */
  }
}
function playSound(type) {
  const tones = { complete: [660, 880], error: [320, 200], queueComplete: [660, 880, 1175] };
  playTone(tones[type] || [660]);
}
function soundOn(type) {
  return Boolean(appConfig.sounds && appConfig.sounds[type]);
}
function checkQueueComplete() {
  const active = Array.from(items.values()).filter((i) => i.status === 'running' || i.status === 'queued').length;
  if (_prevActive > 0 && active === 0 && soundOn('queueComplete')) playSound('queueComplete');
  _prevActive = active;
}

// Ext Category Mapping
const EXT_CATEGORY = {
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', ts: 'video', flv: 'video', wmv: 'video', m3u8: 'video', mpd: 'video',
  zip: 'compressed', rar: 'compressed', '7z': 'compressed', tar: 'compressed', gz: 'compressed', iso: 'compressed',
  pdf: 'documents', doc: 'documents', docx: 'documents', xls: 'documents', xlsx: 'documents', ppt: 'documents', pptx: 'documents', txt: 'documents',
  mp3: 'music', wav: 'music', flac: 'music', aac: 'music', ogg: 'music', m4a: 'music',
  exe: 'programs', msi: 'programs', apk: 'programs', setup: 'programs',
};

function categoryOf(item) {
  if (item.kind === 'hls' || item.kind === 'dash') return 'video';
  const ext = (item.filename || item.url || '').split('.').pop().toLowerCase().split('?')[0];
  return EXT_CATEGORY[ext] || 'General';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatTimeLeft(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s} sec`;
}

// 1. Inject Icons into Toolbar and Sidebar
function injectIcons() {
  const queryMap = {
    '.add-url-icon': icon('plus', 18),
    '.resume-icon': icon('play', 18),
    '.stop-icon': icon('stop', 18),
    '.stopall-icon': icon('stopAll', 18),
    '.delete-icon': icon('trash', 18),
    '.del-done-icon': icon('x', 18),
    '.options-icon': icon('settings', 18),
    '.schedule-icon': icon('calendar', 18),
    '.queue-icon': icon('queue', 18),
    '.stop-queue-icon': icon('stop', 18),
    '.friend-icon': icon('link', 18),
    '.icon-all': icon('grid', 14),
    '.icon-compressed': icon('archive', 14),
    '.icon-documents': icon('doc', 14),
    '.icon-music': icon('music', 14),
    '.icon-programs': icon('exe', 14),
    '.icon-video': icon('film', 14),
    '.icon-grabber': icon('folder', 14),
    '.icon-queues': icon('queue', 14),
    '.icon-unfinished': icon('clock', 14),
    '.icon-finished': icon('check', 14),
  };

  for (const [selector, svg] of Object.entries(queryMap)) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = svg;
  }
}

// 2. Render Table Rows
function render() {
  queueBody.innerHTML = '';

  const filtered = Array.from(items.values()).filter((item) => {
    if (currentCategory === 'all') return true;
    if (currentCategory === 'unfinished') return item.status !== 'completed';
    if (currentCategory === 'finished') return item.status === 'completed';
    return categoryOf(item).toLowerCase() === currentCategory.toLowerCase();
  });

  for (const item of filtered) {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    if (selectedIds.has(item.id)) tr.classList.add('selected');

    const isDone = item.status === 'completed';
    const isError = item.status === 'error';
    const isRunning = item.status === 'running';

    let statusText = 'Complete';
    if (isRunning) statusText = 'Downloading';
    else if (item.status === 'paused') statusText = 'Paused';
    else if (isError) statusText = 'Error';
    else if (item.status === 'queued') statusText = 'Queued';

    const ext = (item.filename || '').split('.').pop().toLowerCase();
    const iconSymbol = ext === 'zip' || ext === 'rar' ? '📁' : '🎬';

    // Signature IDM inline progress bar for in-flight / paused rows.
    const rawPercent = item.progress?.percent != null ? item.progress.percent : isDone ? 100 : 0;
    const pct = Math.max(0, Math.min(100, rawPercent || 0));
    let statusCell;
    if (isRunning || item.status === 'paused') {
      statusCell = `<div class="idm-progress" title="${pct.toFixed(1)}%"><div class="idm-progress-fill${
        item.status === 'paused' ? ' paused' : ''
      }" style="width:${pct}%"></div><span class="idm-progress-text">${pct.toFixed(1)}%</span></div>`;
    } else {
      statusCell = escapeHtml(statusText);
    }

    tr.innerHTML = `
      <td class="col-name" style="display:flex; align-items:center; gap:6px;">
        <span>${iconSymbol}</span>
        <span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.filename || item.url)}</span>
      </td>
      <td class="col-q">Q</td>
      <td class="col-size">${formatBytes(item.size)}</td>
      <td class="col-status">${statusCell}</td>
      <td class="col-eta">${isRunning && item.progress?.eta ? formatTimeLeft(item.progress.eta) : '—'}</td>
      <td class="col-speed">${isRunning ? formatSpeed(item.progress?.speedBytesPerSec) : '—'}</td>
      <td class="col-date">${item.addedAt ? new Date(item.addedAt).toLocaleDateString() : '—'}</td>
      <td>${escapeHtml(item.description || '—')}</td>
    `;

    tr.addEventListener('click', (e) => handleRowClick(e, item.id));
    tr.addEventListener('dblclick', () => {
      if (isDone && item.destPath && window.api.openFile) window.api.openFile(item.destPath);
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectedIds.has(item.id)) {
        selectedIds.clear();
        selectedIds.add(item.id);
        render();
      }
      showContextMenu(e.clientX, e.clientY);
    });

    queueBody.appendChild(tr);
  }

  // Statusbar Update
  const activeCount = Array.from(items.values()).filter((i) => i.status === 'running').length;
  const totalSpeed = Array.from(items.values()).reduce((sum, i) => sum + (i.status === 'running' ? i.progress?.speedBytesPerSec || 0 : 0), 0);

  if (statusActive) statusActive.textContent = `${activeCount} active downloads`;
  if (statusSpeed) statusSpeed.textContent = `Total speed: ${formatSpeed(totalSpeed)}`;
  if (statusTotal) statusTotal.textContent = `${items.size} items`;
}

function handleRowClick(e, id) {
  if (e.ctrlKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
  }
  render();
}

function showContextMenu(x, y) {
  if (contextMenu) {
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove('hidden');
  }
}

document.addEventListener('click', () => {
  if (contextMenu) contextMenu.classList.add('hidden');
});

// Dropdown Menus Setup
document.querySelectorAll('.menu-item-wrap').forEach((wrap) => {
  const btn = wrap.querySelector('.menu-item');
  const dropdown = wrap.querySelector('.idm-dropdown');
  if (btn && dropdown) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.idm-dropdown').forEach((d) => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    });
  }
});

document.addEventListener('click', () => {
  document.querySelectorAll('.idm-dropdown').forEach((d) => d.classList.add('hidden'));
});

// Toolbar Actions
const addUrlBtn = document.getElementById('add-url-btn');
const ddAddUrl = document.getElementById('dd-add-url');
if (addUrlBtn) addUrlBtn.addEventListener('click', () => addUrlModal.classList.remove('hidden'));
if (ddAddUrl) ddAddUrl.addEventListener('click', () => addUrlModal.classList.remove('hidden'));

if (addModalClose) addModalClose.addEventListener('click', () => addUrlModal.classList.add('hidden'));
if (addCancelBtn) addCancelBtn.addEventListener('click', () => addUrlModal.classList.add('hidden'));

if (addConfirmBtn) {
  addConfirmBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (url) {
      addUrlModal.classList.add('hidden');
      urlInput.value = '';
      showDownloadInfoModal(url);
    }
  });
}

// Download Info Modal Actions
function showDownloadInfoModal(url) {
  pendingDownloadUrl = url;
  if (infoUrlInput) infoUrlInput.value = url;
  if (infoDestInput) infoDestInput.value = `C:\\Users\\kingm\\OneDrive\\Desktop\\Downloader\\downloads\\${url.split('/').pop().split('?')[0] || 'file.bin'}`;
  if (infoSizeDisplay) infoSizeDisplay.value = 'Calculating...';
  if (downloadInfoModal) downloadInfoModal.classList.remove('hidden');
}

if (infoModalClose) infoModalClose.addEventListener('click', () => downloadInfoModal.classList.add('hidden'));
if (infoCancelBtn) infoCancelBtn.addEventListener('click', () => downloadInfoModal.classList.add('hidden'));

if (infoStartBtn) {
  infoStartBtn.addEventListener('click', async () => {
    if (pendingDownloadUrl && window.api.add) {
      await window.api.add({ url: pendingDownloadUrl });
    }
    if (downloadInfoModal) downloadInfoModal.classList.add('hidden');
  });
}

if (infoLaterBtn) {
  infoLaterBtn.addEventListener('click', async () => {
    if (pendingDownloadUrl && window.api.add) {
      await window.api.add({ url: pendingDownloadUrl, startNow: false });
    }
    if (downloadInfoModal) downloadInfoModal.classList.add('hidden');
  });
}

// Toolbar Action Buttons
const resumeAllBtn = document.getElementById('resume-all-btn');
if (resumeAllBtn) {
  resumeAllBtn.addEventListener('click', () => {
    for (const id of selectedIds) {
      if (window.api.resume) window.api.resume(id);
    }
  });
}

const pauseAllBtn = document.getElementById('pause-all-btn');
if (pauseAllBtn) {
  pauseAllBtn.addEventListener('click', () => {
    for (const id of selectedIds) {
      if (window.api.pause) window.api.pause(id);
    }
  });
}

const deleteBtn = document.getElementById('delete-btn');
if (deleteBtn) {
  deleteBtn.addEventListener('click', () => {
    for (const id of selectedIds) {
      if (window.api.remove) window.api.remove(id);
    }
    selectedIds.clear();
    render();
  });
}

// Convenience getters for form elements.
const $ = (id) => document.getElementById(id);
const setChecked = (id, v) => { const el = $(id); if (el) el.checked = Boolean(v); };
const getChecked = (id) => { const el = $(id); return el ? el.checked : false; };
const setVal = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
const getVal = (id) => { const el = $(id); return el ? el.value : ''; };

const CATEGORY_DIRS = ['Compressed', 'Documents', 'Music', 'Video', 'Programs'];

async function openOptions() {
  try {
    if (window.api.getConfig) {
      const cfg = await window.api.getConfig();
      appConfig = cfg || {};
      const integ = cfg.integration || {};
      const sounds = cfg.sounds || {};
      const dirs = cfg.destDirs || {};

      // General
      setChecked('cfg-startup', cfg.startup);
      setChecked('cfg-autoclip', cfg.autoClipboard);
      setChecked('cfg-int-chrome', integ.chrome);
      setChecked('cfg-int-edge', integ.edge);
      setChecked('cfg-int-brave', integ.brave);
      setChecked('cfg-int-firefox', integ.firefox);

      // Connection
      if (cfg.connectionType) setVal('cfg-conn-type', cfg.connectionType);
      if (cfg.maxConnections) setVal('cfg-max-conn', String(cfg.maxConnections));
      setVal('cfg-speed-limit', String(cfg.speedLimitKBps || 0));

      // Save To
      setVal('cfg-save-dir', dirs.General || '');
      setVal('cfg-temp-dir', cfg.tempDir || '');
      for (const cat of CATEGORY_DIRS) setVal(`cfg-dir-${cat}`, dirs[cat] || '');

      // File Types
      setVal('cfg-file-types', cfg.fileTypes || '');
      setVal('cfg-excluded', cfg.excludedSites || '');

      // Sounds
      setChecked('cfg-snd-complete', sounds.complete);
      setChecked('cfg-snd-error', sounds.error);
      setChecked('cfg-snd-queue', sounds.queueComplete);
    }
  } catch (e) {
    console.warn('Failed to load config:', e);
  }
  // Always reset to the first tab when opening.
  selectTab('general');
  settingsOverlay.classList.remove('hidden');
}

async function saveOptions() {
  try {
    const cfg = window.api.getConfig ? await window.api.getConfig() : {};
    const destDirs = { ...(cfg.destDirs || {}) };
    if (getVal('cfg-save-dir').trim()) destDirs.General = getVal('cfg-save-dir').trim();
    for (const cat of CATEGORY_DIRS) {
      const v = getVal(`cfg-dir-${cat}`).trim();
      if (v) destDirs[cat] = v;
    }

    const patch = {
      startup: getChecked('cfg-startup'),
      autoClipboard: getChecked('cfg-autoclip'),
      integration: {
        chrome: getChecked('cfg-int-chrome'),
        edge: getChecked('cfg-int-edge'),
        brave: getChecked('cfg-int-brave'),
        firefox: getChecked('cfg-int-firefox'),
      },
      connectionType: getVal('cfg-conn-type'),
      maxConnections: parseInt(getVal('cfg-max-conn'), 10) || 8,
      speedLimitKBps: Math.max(0, parseInt(getVal('cfg-speed-limit'), 10) || 0),
      tempDir: getVal('cfg-temp-dir').trim(),
      destDirs,
      fileTypes: getVal('cfg-file-types').trim(),
      excludedSites: getVal('cfg-excluded').trim(),
      sounds: {
        complete: getChecked('cfg-snd-complete'),
        error: getChecked('cfg-snd-error'),
        queueComplete: getChecked('cfg-snd-queue'),
      },
    };
    if (window.api.setConfig) await window.api.setConfig(patch);
    appConfig = { ...appConfig, ...patch };
  } catch (e) {
    console.warn('Failed to save config:', e);
  }
  settingsOverlay.classList.add('hidden');
}

function selectTab(name) {
  document.querySelectorAll('.idm-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.idm-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

document.querySelectorAll('.idm-tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

// Generic directory picker for every Browse button in the options dialog.
document.querySelectorAll('.dir-browse-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!window.api.pickDestDir) return;
    const dir = await window.api.pickDestDir();
    if (dir) setVal(btn.dataset.target, dir);
  });
});

// Sound test buttons.
document.querySelectorAll('.snd-test-btn').forEach((btn) => {
  btn.addEventListener('click', () => playSound(btn.dataset.sound));
});

if (optionsBtn) optionsBtn.addEventListener('click', openOptions);
if (settingsClose) settingsClose.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
if (settingsCancel) settingsCancel.addEventListener('click', () => settingsOverlay.classList.add('hidden'));
if (settingsSave) settingsSave.addEventListener('click', saveOptions);

// Context Menu Actions
document.getElementById('ctx-open')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item && item.destPath && window.api.openFile) window.api.openFile(item.destPath);
});

document.getElementById('ctx-open-folder')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item && item.destPath && window.api.showInFolder) window.api.showInFolder(item.destPath);
});

document.getElementById('ctx-resume')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.resume) window.api.resume(id);
  }
});

document.getElementById('ctx-pause')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.pause) window.api.pause(id);
  }
});

document.getElementById('ctx-refresh-url')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  if (id) {
    pendingRefreshId = id;
    const item = items.get(id);
    if (refreshNewUrlInput) refreshNewUrlInput.value = item?.url || '';
    if (refreshUrlModal) refreshUrlModal.classList.remove('hidden');
  }
});

if (refreshModalClose) refreshModalClose.addEventListener('click', () => refreshUrlModal.classList.add('hidden'));
if (refreshCancelBtn) refreshCancelBtn.addEventListener('click', () => refreshUrlModal.classList.add('hidden'));

if (refreshConfirmBtn) {
  refreshConfirmBtn.addEventListener('click', () => {
    const newUrl = refreshNewUrlInput.value.trim();
    if (pendingRefreshId && newUrl && window.api.refreshUrl) {
      window.api.refreshUrl(pendingRefreshId, newUrl);
    }
    refreshUrlModal.classList.add('hidden');
  });
}

document.getElementById('ctx-delete')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.remove) window.api.remove(id);
  }
  selectedIds.clear();
  render();
});

document.getElementById('ctx-redownload')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item && item.url && window.api.add) {
    window.api.add({ url: item.url });
  }
});

document.getElementById('ctx-properties')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item) {
    alert(`File: ${item.filename || item.url}\nStatus: ${item.status}\nSize: ${formatBytes(item.size || item.progress?.total)}\nPath: ${item.destPath || 'N/A'}\nURL: ${item.url}`);
  }
});

// --- Dropdown Menu Item Handlers ---
// Tasks Menu
document.getElementById('dd-add-clipboard')?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.startsWith('http')) {
      showDownloadInfoModal(text);
    }
  } catch (e) { console.warn('Clipboard read failed:', e); }
});

document.getElementById('dd-exit')?.addEventListener('click', () => {
  window.close();
});

// File Menu
document.getElementById('dd-stop-sel')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.pause) window.api.pause(id);
  }
});

document.getElementById('dd-resume-sel')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.resume) window.api.resume(id);
  }
});

document.getElementById('dd-refresh-url')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  if (id) {
    pendingRefreshId = id;
    const item = items.get(id);
    if (refreshNewUrlInput) refreshNewUrlInput.value = item?.url || '';
    if (refreshUrlModal) refreshUrlModal.classList.remove('hidden');
  }
});

document.getElementById('dd-redownload')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item && item.url && window.api.add) {
    window.api.add({ url: item.url });
  }
});

document.getElementById('dd-delete')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.remove) window.api.remove(id);
  }
  selectedIds.clear();
  render();
});

document.getElementById('dd-delete-done')?.addEventListener('click', () => {
  for (const [id, item] of items) {
    if (item.status === 'completed') {
      if (window.api.remove) window.api.remove(id);
    }
  }
  selectedIds.clear();
  render();
});

document.getElementById('dd-properties')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item) {
    alert(`File: ${item.filename || item.url}\nStatus: ${item.status}\nSize: ${formatBytes(item.size || item.progress?.total)}\nPath: ${item.destPath || 'N/A'}\nURL: ${item.url}`);
  }
});

// Downloads Menu
document.getElementById('dd-pause-all')?.addEventListener('click', () => {
  for (const [id, item] of items) {
    if (item.status === 'running' && window.api.pause) window.api.pause(id);
  }
});

document.getElementById('dd-resume-all')?.addEventListener('click', () => {
  for (const [id, item] of items) {
    if ((item.status === 'paused' || item.status === 'error') && window.api.resume) window.api.resume(id);
  }
});

document.getElementById('dd-speed-limiter')?.addEventListener('click', () => {
  const limit = prompt('Enter max speed in KB/s (0 = unlimited):', '0');
  if (limit !== null && window.api.setConfig) {
    window.api.setConfig({ speedLimitKBps: parseInt(limit) || 0 });
  }
});

// View Menu
document.getElementById('dd-toggle-sidebar')?.addEventListener('click', () => {
  if (mainSidebar) {
    mainSidebar.style.display = mainSidebar.style.display === 'none' ? '' : 'none';
  }
});

document.getElementById('dd-toggle-statusbar')?.addEventListener('click', () => {
  if (mainStatusbar) {
    mainStatusbar.style.display = mainStatusbar.style.display === 'none' ? '' : 'none';
  }
});

// Help Menu
document.getElementById('dd-about')?.addEventListener('click', () => {
  alert('Internet Download Manager 6.43\nEngine Twin v1.0\n\nMulti-Threaded Acceleration & HLS/DASH Stream Engine\n\n✔ Registered & Activated');
});

// --- Toolbar Buttons: Stop All, Delete Completed ---
const stopAllBtn = document.getElementById('stop-all-btn');
if (stopAllBtn) {
  stopAllBtn.addEventListener('click', () => {
    if (window.api.pauseAll) window.api.pauseAll();
  });
}

// --- Queue controls (Start Queue / Stop Queue) ---
function startQueue() {
  if (window.api.startAll) window.api.startAll();
}
function stopQueue() {
  if (window.api.pauseAll) window.api.pauseAll();
}
document.getElementById('start-queue-btn')?.addEventListener('click', startQueue);
document.getElementById('stop-queue-btn')?.addEventListener('click', stopQueue);
document.getElementById('dd-start-queue')?.addEventListener('click', startQueue);

// --- Scheduler (IDM-style queue start/stop timers) ---
let scheduleStart = null; // 'HH:MM' or null
let scheduleStop = null;
let firedStart = false;
let firedStop = false;

function openScheduler() {
  const s = prompt('Start queue daily at (HH:MM, 24h). Leave blank to clear:', scheduleStart || '');
  if (s !== null) {
    const v = s.trim();
    scheduleStart = /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null;
  }
  const e = prompt('Stop queue daily at (HH:MM, 24h). Leave blank to clear:', scheduleStop || '');
  if (e !== null) {
    const v = e.trim();
    scheduleStop = /^\d{1,2}:\d{2}$/.test(v) ? v.padStart(5, '0') : null;
  }
  const parts = [];
  if (scheduleStart) parts.push(`start at ${scheduleStart}`);
  if (scheduleStop) parts.push(`stop at ${scheduleStop}`);
  alert(parts.length ? `Scheduler set: ${parts.join(', ')} (while the app is running).` : 'Scheduler cleared.');
}
document.getElementById('scheduler-btn')?.addEventListener('click', openScheduler);
document.getElementById('dd-scheduler')?.addEventListener('click', openScheduler);

setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (scheduleStart && hhmm === scheduleStart) {
    if (!firedStart) { firedStart = true; startQueue(); }
  } else {
    firedStart = false;
  }
  if (scheduleStop && hhmm === scheduleStop) {
    if (!firedStop) { firedStop = true; stopQueue(); }
  } else {
    firedStop = false;
  }
}, 1000);

const clearDoneBtn = document.getElementById('clear-done-btn');
if (clearDoneBtn) {
  clearDoneBtn.addEventListener('click', () => {
    for (const [id, item] of items) {
      if (item.status === 'completed') {
        if (window.api.remove) window.api.remove(id);
      }
    }
    selectedIds.clear();
    render();
  });
}

// --- Browse Button in Download Info Modal ---
const infoBrowseBtn = document.getElementById('info-browse-btn');
if (infoBrowseBtn) {
  infoBrowseBtn.addEventListener('click', async () => {
    if (window.api.pickDestDir) {
      const dir = await window.api.pickDestDir();
      if (dir && infoDestInput) {
        const filename = infoDestInput.value.split('\\').pop().split('/').pop();
        infoDestInput.value = dir + '\\' + filename;
      }
    }
  });
}

// (Options-dialog directory Browse buttons are wired generically via
// `.dir-browse-btn` above, so no per-button handler is needed here.)

// Sidebar Category Switching
document.querySelectorAll('.tree-node').forEach((node) => {
  node.addEventListener('click', () => {
    document.querySelectorAll('.tree-node').forEach((n) => n.classList.remove('active'));
    node.classList.add('active');
    currentCategory = node.dataset.cat || 'all';
    render();
  });
});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (addUrlModal) addUrlModal.classList.remove('hidden');
  } else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
    // Ctrl+V: paste URL from clipboard
    e.preventDefault();
    navigator.clipboard.readText().then((text) => {
      if (text && text.startsWith('http')) showDownloadInfoModal(text);
    }).catch(() => {});
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectedIds.clear();
    for (const item of items.values()) selectedIds.add(item.id);
    render();
  } else if (e.key === 'Delete' && e.shiftKey) {
    // Shift+Del: delete from disk
    e.preventDefault();
    for (const id of selectedIds) {
      if (window.api.remove) window.api.remove(id);
    }
    selectedIds.clear();
    render();
  } else if (e.key === 'Delete') {
    e.preventDefault();
    for (const id of selectedIds) {
      if (window.api.remove) window.api.remove(id);
    }
    selectedIds.clear();
    render();
  } else if (e.code === 'Space') {
    e.preventDefault();
    for (const id of selectedIds) {
      const item = items.get(id);
      if (item) {
        if (item.status === 'running' && window.api.pause) window.api.pause(item.id);
        else if (window.api.resume) window.api.resume(item.id);
      }
    }
  } else if (e.key === 'Enter') {
    // Enter: open completed file
    const id = Array.from(selectedIds)[0];
    const item = items.get(id);
    if (item && item.status === 'completed' && item.destPath && window.api.openFile) {
      window.api.openFile(item.destPath);
    }
  } else if (e.key === 'F5') {
    // F5: refresh list
    e.preventDefault();
    if (window.api.list) {
      window.api.list().then((list) => {
        items.clear();
        if (Array.isArray(list)) {
          for (const item of list) items.set(item.id, item);
        }
        render();
      });
    }
  }
});

// --- Drag & Drop: drop a link/URL onto the window to add a download ---
function extractDroppedUrl(dt) {
  if (!dt) return '';
  const uriList = dt.getData('text/uri-list');
  const plain = dt.getData('text/plain');
  const html = dt.getData('text/html');
  const fromText = (uriList || plain || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^https?:\/\//i.test(s));
  if (fromText) return fromText;
  if (html) {
    const m = /href\s*=\s*"(https?:\/\/[^"]+)"/i.exec(html);
    if (m) return m[1];
  }
  return '';
}

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('drag-active');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('drag-active');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-active');
  const url = extractDroppedUrl(e.dataTransfer);
  if (url) showDownloadInfoModal(url);
});

// --- Sidebar Badge Update ---
function updateSidebarBadges() {
  const counts = { all: 0, unfinished: 0, finished: 0, compressed: 0, documents: 0, music: 0, programs: 0, video: 0 };
  for (const item of items.values()) {
    counts.all++;
    if (item.status === 'completed') counts.finished++;
    else counts.unfinished++;
    const cat = categoryOf(item).toLowerCase();
    if (counts[cat] !== undefined) counts[cat]++;
  }

  for (const [cat, count] of Object.entries(counts)) {
    const node = document.querySelector(`.tree-node[data-cat="${cat}"]`);
    if (node) {
      let badge = node.querySelector('.tree-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tree-badge';
        badge.style.cssText = 'margin-left:auto; font-size:10px; color:#888; padding-left:4px;';
        node.appendChild(badge);
      }
      badge.textContent = count > 0 ? count : '';
    }
  }
}

// --- Initialization ---
let _initialized = false;
function init() {
  if (_initialized) return; // guard against DOMContentLoaded + fallback double-call
  _initialized = true;
  injectIcons();

  if (window.api && window.api.getConfig) {
    window.api.getConfig().then((c) => { appConfig = c || {}; }).catch(() => {});
  }

  if (window.api && window.api.list) {
    window.api.list().then((list) => {
      items.clear();
      if (Array.isArray(list)) {
        for (const item of list) items.set(item.id, item);
      }
      _prevActive = Array.from(items.values()).filter((i) => i.status === 'running' || i.status === 'queued').length;
      render();
      updateSidebarBadges();
    }).catch(console.error);
  }

  if (window.api && window.api.onItemAdded) {
    window.api.onItemAdded((item) => {
      if (item) {
        items.set(item.id, item);
        checkQueueComplete();
        render();
        updateSidebarBadges();
      }
    });
  }

  if (window.api && window.api.onItemUpdated) {
    window.api.onItemUpdated((item) => {
      if (item) {
        const prev = items.get(item.id);
        const prevStatus = prev ? prev.status : null;
        items.set(item.id, item);
        if (item.status !== prevStatus) {
          if (item.status === 'completed' && soundOn('complete')) playSound('complete');
          else if (item.status === 'error' && soundOn('error')) playSound('error');
        }
        checkQueueComplete();
        render();
        updateSidebarBadges();
      }
    });
  }

  if (window.api && window.api.onItemRemoved) {
    window.api.onItemRemoved((info) => {
      if (info && info.id) {
        items.delete(info.id);
        selectedIds.delete(info.id);
        // Recompute the active baseline silently — removing an item must not
        // be mistaken for the queue finishing.
        _prevActive = Array.from(items.values()).filter((i) => i.status === 'running' || i.status === 'queued').length;
        render();
        updateSidebarBadges();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
init();

