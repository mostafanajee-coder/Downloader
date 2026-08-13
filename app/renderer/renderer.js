'use strict';

// Elements
const queueBody = document.getElementById('queue-body');
const queueTable = document.getElementById('queue-table');
const queueColgroup = document.getElementById('queue-colgroup');
const tableWrap = document.getElementById('table-wrap');
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
// Anchor row for Shift+click / Shift+Arrow range selection, mirroring how a
// Win32 list view works: the anchor stays put while the range grows and
// shrinks around it, and only a plain or Ctrl click moves it.
let selectionAnchorId = null;
// The row the keyboard is "on" — where the next Arrow press steps from. Kept
// separate from the anchor, which stays pinned while a Shift range grows.
let _lastFocusedId = null;
let currentCategory = 'all';
let pendingDownloadUrl = '';
let pendingRefreshId = null;
let appConfig = {}; // last-known config (for sound toggles etc.)
let _prevActive = 0; // active-download count, for queue-complete detection
let queueRunning = false; // whether Start Queue has been invoked (vs Stop Queue)
let completeDialogItem = null; // item currently shown in the Download Complete dialog

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

// Surfaces an otherwise-invisible error (unhandled promise rejection, uncaught
// exception) as a brief, non-blocking toast instead of letting it silently
// vanish into the DevTools console where a normal user will never see it.
let _errorToastTimer = null;
function showTransientError(message) {
  const el = document.getElementById('error-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(_errorToastTimer);
  _errorToastTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('[Unhandled rejection]', reason);
  showTransientError(`Unexpected error: ${message}`);
});

window.addEventListener('error', (e) => {
  console.error('[Uncaught error]', e.error || e.message);
  showTransientError(`Unexpected error: ${e.message || 'something went wrong'}`);
});

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

// The rows the user can actually see right now, in display order. Selection
// operates strictly on this list rather than on the whole `items` map — a
// Ctrl+A while the sidebar is filtered to "Finished" must not silently arm
// the hidden Unfinished rows for the next Delete.
function visibleItems() {
  const list = Array.from(items.values()).filter((item) => {
    if (currentCategory === 'all') return true;
    if (currentCategory === 'unfinished') return item.status !== 'completed';
    if (currentCategory === 'finished') return item.status === 'completed';
    if (currentCategory === 'queue') return (item.queueId || 'main') === currentQueueId;
    return categoryOf(item).toLowerCase() === currentCategory.toLowerCase();
  });

  // Inside a queue, show the queue's actual running order — that ordering is
  // what the pump consumes, so it has to be what the user sees and reorders.
  if (currentCategory === 'queue') {
    list.sort((a, b) => (a.position || 0) - (b.position || 0) || a.addedAt - b.addedAt);
  }
  return list;
}

// 2. Render Table Rows
function render() {
  queueBody.innerHTML = '';

  pruneSelection();
  const filtered = visibleItems();

  for (const item of filtered) {
    const tr = document.createElement('tr');
    tr.dataset.id = item.id;
    if (selectedIds.has(item.id)) tr.classList.add('selected');

    const isDone = item.status === 'completed';
    const isError = item.status === 'error';
    const isRunning = item.status === 'running';

    const isHeld = item.status === 'held';
    let statusText = 'Complete';
    if (isRunning) statusText = 'Downloading';
    else if (item.status === 'paused') statusText = 'Paused';
    else if (isError) statusText = 'Error';
    else if (item.status === 'queued') statusText = 'Queued';
    else if (isHeld) statusText = 'On Hold';

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
    } else if (isHeld) {
      statusCell = `<span class="status-held">${escapeHtml(statusText)}</span>`;
    } else {
      statusCell = escapeHtml(statusText);
    }

    // Q column: mark items that belong to the queue (waiting to start / on hold).
    const qCell = isHeld || item.status === 'queued' ? '<span class="q-mark" title="In queue"></span>' : '';

    tr.innerHTML = `
      <td class="col-name">
        <div class="cell-name">
          <span>${iconSymbol}</span>
          <span class="cell-name-text">${escapeHtml(item.filename || item.url)}</span>
        </div>
      </td>
      <td class="col-q">${qCell}</td>
      <td class="col-size">${formatBytes(item.size)}</td>
      <td class="col-status">${statusCell}</td>
      <td class="col-eta">${isRunning && item.progress?.eta ? formatTimeLeft(item.progress.eta) : '—'}</td>
      <td class="col-speed">${isRunning ? formatSpeed(item.progress?.speedBytesPerSec) : '—'}</td>
      <td class="col-date">${item.addedAt ? new Date(item.addedAt).toLocaleDateString() : '—'}</td>
      <td>${escapeHtml(item.description || '—')}</td>
    `;

    tr.addEventListener('click', (e) => handleRowClick(e, item.id));
    tr.addEventListener('dblclick', () => {
      // Finished: open the file, as before. Still going: show the live
      // per-connection view, which is what double-click does in IDM.
      if (isDone) {
        if (item.destPath && window.api.openFile) window.api.openFile(item.destPath);
      } else {
        showProgressModal(items.get(item.id) || item);
      }
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Right-clicking inside an existing multi-selection keeps it (so the
      // menu acts on all of them); right-clicking outside it selects just
      // that row first, exactly like Explorer.
      if (!selectedIds.has(item.id)) selectOnly(item.id);
      showContextMenu(e.clientX, e.clientY);
    });

    queueBody.appendChild(tr);
  }

  // Statusbar Update
  const activeCount = Array.from(items.values()).filter((i) => i.status === 'running').length;
  const totalSpeed = Array.from(items.values()).reduce((sum, i) => sum + (i.status === 'running' ? i.progress?.speedBytesPerSec || 0 : 0), 0);

  if (statusActive) statusActive.textContent = `${activeCount} active downloads`;
  if (statusSpeed) statusSpeed.textContent = `Total speed: ${formatSpeed(totalSpeed)}`;
  updateSelectionCount();
}

// --- Multi-row selection ----------------------------------------------------
// Selection is deliberately decoupled from render(): changing it only toggles
// the `selected` class on the rows already in the DOM. Re-running the whole
// render() for a click meant tearing down and rebuilding every <tr> (and every
// listener on them) just to repaint a highlight, which flickered and lost the
// row under the cursor mid-drag.

// Repaints the highlight from `selectedIds` without touching row structure.
function applySelectionClasses() {
  for (const tr of queueBody.children) {
    tr.classList.toggle('selected', selectedIds.has(tr.dataset.id));
  }
  updateSelectionCount();
}

// Drops ids that are no longer selectable — either removed from the queue
// entirely, or filtered out of the current category view. Without this the set
// silently accumulates ghosts, and a later Delete would act on rows the user
// can't see.
function pruneSelection() {
  const visible = new Set(visibleItems().map((i) => i.id));
  for (const id of Array.from(selectedIds)) {
    if (!visible.has(id)) selectedIds.delete(id);
  }
  if (selectionAnchorId != null && !visible.has(selectionAnchorId)) selectionAnchorId = null;
}

function selectOnly(id) {
  selectedIds.clear();
  if (id != null) selectedIds.add(id);
  selectionAnchorId = id;
  applySelectionClasses();
}

function toggleSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  // Ctrl+click moves the anchor even when it deselects, matching Explorer:
  // a following Shift+click ranges from the row you last touched.
  selectionAnchorId = id;
  applySelectionClasses();
}

// Selects the contiguous run between the anchor and `id`. `additive` keeps the
// existing selection (Ctrl+Shift+click) instead of replacing it.
function selectRangeTo(id, additive) {
  const order = visibleItems().map((i) => i.id);
  const to = order.indexOf(id);
  if (to === -1) return;
  let from = selectionAnchorId != null ? order.indexOf(selectionAnchorId) : -1;
  if (from === -1) from = to; // no usable anchor yet — degrade to a single row
  if (!additive) selectedIds.clear();
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) selectedIds.add(order[i]);
  applySelectionClasses();
}

function selectAllVisible() {
  selectedIds.clear();
  const order = visibleItems().map((i) => i.id);
  for (const id of order) selectedIds.add(id);
  if (order.length) selectionAnchorId = order[0];
  applySelectionClasses();
}

function clearSelection() {
  selectedIds.clear();
  selectionAnchorId = null;
  applySelectionClasses();
}

// Keyboard navigation. `delta` of -1/+1 steps a row; `extend` grows the range
// from the anchor rather than replacing the selection.
function moveSelection(delta, extend) {
  const order = visibleItems().map((i) => i.id);
  if (!order.length) return;

  // Step from the row the user last acted on, falling back to the edge of the
  // list so a first Arrow press with nothing selected still does something.
  const currentId = _lastFocusedId != null && order.includes(_lastFocusedId)
    ? _lastFocusedId
    : Array.from(selectedIds).filter((id) => order.includes(id)).pop();
  let next;
  if (currentId == null) {
    next = delta > 0 ? order[0] : order[order.length - 1];
  } else {
    const idx = order.indexOf(currentId);
    next = order[Math.max(0, Math.min(order.length - 1, idx + delta))];
  }

  _lastFocusedId = next;
  if (extend) selectRangeTo(next, false);
  else selectOnly(next);
  scrollRowIntoView(next);
}

function scrollRowIntoView(id) {
  const tr = queueBody.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`);
  if (tr) tr.scrollIntoView({ block: 'nearest' });
}

function updateSelectionCount() {
  if (!statusTotal) return;
  const suffix = selectedIds.size > 1 ? ` (${selectedIds.size} selected)` : '';
  statusTotal.textContent = `${items.size} items${suffix}`;
}

function handleRowClick(e, id) {
  _lastFocusedId = id;
  if (e.shiftKey) selectRangeTo(id, e.ctrlKey);
  else if (e.ctrlKey) toggleSelection(id);
  else selectOnly(id);
}

// Clicking the empty space under the last row clears the selection, the way a
// native list view does. Bound on the scroll container so it also catches
// clicks below a short list.
if (tableWrap) {
  tableWrap.addEventListener('mousedown', (e) => {
    // A header click lands on the thead <tr>, so this also correctly leaves
    // the selection alone when the user grabs a column divider.
    if (!e.target.closest('tr')) clearSelection();
  });
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
      routeUrlToAddFlow(url);
    }
  });
}

// Insert / Ctrl+V / "Add download from clipboard": pre-fill the Add URL modal
// with clipboard text and show it, giving a review/edit step before the URL
// is routed onward (plain download vs. batch wildcard preview).
function pasteUrlIntoAddModal() {
  navigator.clipboard
    .readText()
    .then((text) => {
      const trimmed = (text || '').trim();
      if (trimmed && /^https?:\/\//i.test(trimmed)) {
        if (urlInput) urlInput.value = trimmed;
        if (addUrlModal) addUrlModal.classList.remove('hidden');
      }
    })
    .catch((e) => console.warn('Clipboard read failed:', e));
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

// --- Download Complete Dialog (IDM's signature completion popup) -----------
function fileIconKeyFor(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return 'archive';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'].includes(ext)) return 'doc';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'music';
  if (['exe', 'msi', 'apk'].includes(ext)) return 'exe';
  return 'film';
}

function showDownloadCompleteDialog(item) {
  if (!item) return;
  const modal = document.getElementById('download-complete-modal');
  if (!modal) return;

  completeDialogItem = item;

  const iconEl = document.getElementById('complete-file-icon');
  if (iconEl) iconEl.innerHTML = icon(fileIconKeyFor(item.filename), 24);

  const nameEl = document.getElementById('complete-filename');
  if (nameEl) nameEl.textContent = item.filename || item.url;

  const sizeEl = document.getElementById('complete-size');
  if (sizeEl) sizeEl.textContent = formatBytes(item.size);

  const speedEl = document.getElementById('complete-speed');
  if (speedEl) {
    const elapsedSec = item.startedAt && item.completedAt ? (item.completedAt - item.startedAt) / 1000 : 0;
    speedEl.textContent = elapsedSec > 0 && item.size ? formatSpeed(item.size / elapsedSec) : '—';
  }

  const pathEl = document.getElementById('complete-path');
  if (pathEl) pathEl.textContent = item.destPath || '—';

  const dontShowCb = document.getElementById('complete-dont-show');
  if (dontShowCb) dontShowCb.checked = false;

  modal.classList.remove('hidden');
}

function hideDownloadCompleteDialog() {
  document.getElementById('download-complete-modal')?.classList.add('hidden');
}

document.getElementById('complete-modal-close')?.addEventListener('click', hideDownloadCompleteDialog);
document.getElementById('complete-close-btn')?.addEventListener('click', hideDownloadCompleteDialog);

document.getElementById('complete-open-file-btn')?.addEventListener('click', () => {
  if (completeDialogItem && completeDialogItem.destPath && window.api.openFile) {
    window.api.openFile(completeDialogItem.destPath);
  }
});

document.getElementById('complete-open-folder-btn')?.addEventListener('click', () => {
  if (completeDialogItem && completeDialogItem.destPath && window.api.showInFolder) {
    window.api.showInFolder(completeDialogItem.destPath);
  }
});

document.getElementById('complete-dont-show')?.addEventListener('change', (e) => {
  appConfig.showCompleteDialog = !e.target.checked;
  if (window.api.setConfig) window.api.setConfig({ showCompleteDialog: !e.target.checked });
});

// --- Download Properties Modal ----------------------------------------------
function showPropertiesModal(item) {
  if (!item) return;
  const modal = document.getElementById('properties-modal');
  if (!modal) return;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const downloaded =
    item.status === 'completed'
      ? formatBytes(item.size)
      : item.progress && item.progress.downloaded != null
        ? formatBytes(item.progress.downloaded)
        : '—';

  set('prop-filename', item.filename || item.url);
  set('prop-status', item.status);
  set('prop-size', formatBytes(item.size));
  set('prop-downloaded', downloaded);
  set('prop-category', categoryOf(item));
  set('prop-added', item.addedAt ? new Date(item.addedAt).toLocaleString() : '—');
  set('prop-path', item.destPath || '—');
  set('prop-url', item.url || '—');

  modal.classList.remove('hidden');
}

function hidePropertiesModal() {
  document.getElementById('properties-modal')?.classList.add('hidden');
}

document.getElementById('properties-close')?.addEventListener('click', hidePropertiesModal);
document.getElementById('properties-close-btn')?.addEventListener('click', hidePropertiesModal);

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

// --- Delete Confirmation Modal ---------------------------------------------
let pendingDeleteIds = [];
let pendingDeleteFromDisk = false;

function confirmDelete(ids, fromDisk) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) return;
  pendingDeleteIds = list;
  pendingDeleteFromDisk = fromDisk;
  const text = document.getElementById('delete-confirm-text');
  if (text) {
    text.textContent = fromDisk
      ? `Permanently delete ${list.length} file(s) from disk (moved to the Recycle Bin) and remove ${list.length === 1 ? 'it' : 'them'} from the list?`
      : `Remove ${list.length} item(s) from the list? This will NOT delete the downloaded file(s) from disk.`;
  }
  document.getElementById('delete-confirm-modal')?.classList.remove('hidden');
}

function closeDeleteConfirm() {
  pendingDeleteIds = [];
  document.getElementById('delete-confirm-modal')?.classList.add('hidden');
}

document.getElementById('delete-confirm-close')?.addEventListener('click', closeDeleteConfirm);
document.getElementById('delete-confirm-cancel-btn')?.addEventListener('click', closeDeleteConfirm);
document.getElementById('delete-confirm-ok-btn')?.addEventListener('click', async () => {
  for (const id of pendingDeleteIds) {
    const item = items.get(id);
    if (pendingDeleteFromDisk && item && item.destPath && window.api.deleteFile) {
      await window.api.deleteFile(item.destPath);
    }
    if (window.api.remove) window.api.remove(id);
  }
  clearSelection();
  closeDeleteConfirm();
  render();
});

const deleteBtn = document.getElementById('delete-btn');
if (deleteBtn) {
  deleteBtn.addEventListener('click', () => {
    confirmDelete(Array.from(selectedIds), false);
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
      setChecked('cfg-show-complete', cfg.showCompleteDialog !== false);
      setVal('cfg-duplicate-action', cfg.duplicateAction || 'ask');

      // Connection
      if (cfg.connectionType) setVal('cfg-conn-type', cfg.connectionType);
      if (cfg.maxConnections) setVal('cfg-max-conn', String(cfg.maxConnections));
      setVal('cfg-speed-limit', String(cfg.speedLimitKBps || 0));
      if (cfg.maxConcurrentDownloads) setVal('cfg-max-simultaneous', String(cfg.maxConcurrentDownloads));

      // Proxy
      const proxy = cfg.proxy || {};
      const mode = proxy.mode || 'direct';
      setChecked('cfg-proxy-direct', mode === 'direct');
      setChecked('cfg-proxy-manual', mode === 'manual');
      setChecked('cfg-proxy-pac', mode === 'pac');
      for (const scheme of ['http', 'https', 'ftp', 'socks']) {
        setVal(`cfg-proxy-${scheme}-host`, (proxy[scheme] && proxy[scheme].host) || '');
        setVal(`cfg-proxy-${scheme}-port`, String((proxy[scheme] && proxy[scheme].port) || ''));
      }
      setChecked('cfg-proxy-socks-all', proxy.useSocksForAll);
      setChecked('cfg-proxy-socks-dns', proxy.socks ? proxy.socks.remoteDns !== false : true);
      setVal('cfg-proxy-pac-url', proxy.pacUrl || '');
      setVal('cfg-proxy-exceptions', proxy.exceptions || '');
      updateProxyMode();

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

// Greys out whichever proxy section the selected mode doesn't use, so it's
// obvious which fields are actually in play.
function updateProxyMode() {
  const manual = document.getElementById('cfg-proxy-manual')?.checked;
  const pac = document.getElementById('cfg-proxy-pac')?.checked;
  const manualGroup = document.getElementById('proxy-manual-group');
  const pacGroup = document.getElementById('proxy-pac-group');
  if (manualGroup) manualGroup.style.opacity = manual ? '1' : '0.45';
  if (pacGroup) pacGroup.style.opacity = pac ? '1' : '0.45';
}
document.querySelectorAll('input[name="proxy-mode"]').forEach((r) => r.addEventListener('change', updateProxyMode));

function readProxyForm(previous) {
  const server = (scheme) => ({
    // Credentials aren't exposed in this dialog, so carry forward whatever was
    // already stored rather than blanking it on every save.
    ...(previous[scheme] || {}),
    host: getVal(`cfg-proxy-${scheme}-host`).trim(),
    port: parseInt(getVal(`cfg-proxy-${scheme}-port`), 10) || 0,
  });
  const mode = document.getElementById('cfg-proxy-pac')?.checked
    ? 'pac'
    : document.getElementById('cfg-proxy-manual')?.checked
    ? 'manual'
    : 'direct';
  return {
    ...previous,
    mode,
    http: server('http'),
    https: server('https'),
    ftp: server('ftp'),
    socks: { ...server('socks'), remoteDns: getChecked('cfg-proxy-socks-dns') },
    useSocksForAll: getChecked('cfg-proxy-socks-all'),
    pacUrl: getVal('cfg-proxy-pac-url').trim(),
    exceptions: getVal('cfg-proxy-exceptions').trim(),
  };
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
      showCompleteDialog: getChecked('cfg-show-complete'),
      duplicateAction: getVal('cfg-duplicate-action') || 'ask',
      connectionType: getVal('cfg-conn-type'),
      maxConnections: parseInt(getVal('cfg-max-conn'), 10) || 8,
      maxConcurrentDownloads: parseInt(getVal('cfg-max-simultaneous'), 10) || 4,
      speedLimitKBps: Math.max(0, parseInt(getVal('cfg-speed-limit'), 10) || 0),
      proxy: readProxyForm(cfg.proxy || {}),
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

document.getElementById('ctx-hold')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.hold) window.api.hold(id);
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
  confirmDelete(Array.from(selectedIds), false);
});

document.getElementById('ctx-delete-disk')?.addEventListener('click', () => {
  confirmDelete(Array.from(selectedIds), true);
});

document.getElementById('ctx-redownload')?.addEventListener('click', () => {
  const id = Array.from(selectedIds)[0];
  const item = items.get(id);
  if (item && item.url && window.api.add) {
    window.api.add({ url: item.url });
  }
});

document.getElementById('ctx-properties')?.addEventListener('click', () => {
  showPropertiesModal(items.get(Array.from(selectedIds)[0]));
});

// --- Dropdown Menu Item Handlers ---
// Tasks Menu
document.getElementById('dd-add-clipboard')?.addEventListener('click', pasteUrlIntoAddModal);

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

document.getElementById('dd-hold-sel')?.addEventListener('click', () => {
  for (const id of selectedIds) {
    if (window.api.hold) window.api.hold(id);
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
  confirmDelete(Array.from(selectedIds), false);
});

document.getElementById('dd-delete-disk')?.addEventListener('click', () => {
  confirmDelete(Array.from(selectedIds), true);
});

document.getElementById('dd-delete-done')?.addEventListener('click', () => {
  for (const [id, item] of items) {
    if (item.status === 'completed') {
      if (window.api.remove) window.api.remove(id);
    }
  }
  clearSelection();
  render();
});

document.getElementById('dd-properties')?.addEventListener('click', () => {
  showPropertiesModal(items.get(Array.from(selectedIds)[0]));
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
// True queue model: "Start Queue" promotes every held/paused/error item to
// running (up to the concurrency cap) and keeps pulling from the queue as
// slots free up; "Stop Queue" pauses active transfers and parks anything
// still waiting back on hold so the queue doesn't keep creeping forward.
function startQueue() {
  if (window.api.startQueue) window.api.startQueue();
}
function stopQueue() {
  if (window.api.stopQueue) window.api.stopQueue();
}
document.getElementById('start-queue-btn')?.addEventListener('click', startQueue);
document.getElementById('stop-queue-btn')?.addEventListener('click', stopQueue);
document.getElementById('dd-start-queue')?.addEventListener('click', startQueue);
document.getElementById('dd-stop-queue')?.addEventListener('click', stopQueue);

function updateQueueUI(running) {
  queueRunning = Boolean(running);
  const startBtn = document.getElementById('start-queue-btn');
  const stopBtn = document.getElementById('stop-queue-btn');
  if (startBtn) startBtn.classList.toggle('active', queueRunning);
  if (stopBtn) stopBtn.classList.toggle('active', !queueRunning);
  const statusQueue = document.getElementById('status-queue');
  if (statusQueue) {
    statusQueue.textContent = `Queue: ${queueRunning ? 'Running' : 'Stopped'}`;
    statusQueue.classList.toggle('queue-running', queueRunning);
    statusQueue.classList.toggle('queue-stopped', !queueRunning);
  }
}

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

// --- Site Grabber Wizard ----------------------------------------------------
const grabberModal = document.getElementById('grabber-modal');
const grabAssets = new Map(); // url -> asset (as streamed from the crawl)
const grabSelected = new Set(); // urls currently checked for download
let grabStep = 1;
let _grabRenderScheduled = false;

function goToGrabStep(n) {
  grabStep = n;
  document.querySelectorAll('.wizard-step').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === n));
  document.querySelectorAll('.wizard-panel').forEach((el) => el.classList.toggle('active', Number(el.dataset.wpanel) === n));

  const backBtn = document.getElementById('grab-back-btn');
  const nextBtn = document.getElementById('grab-next-btn');
  const downloadBtn = document.getElementById('grab-download-btn');
  const selectAllWrap = document.getElementById('grab-select-all-wrap');
  if (backBtn) backBtn.disabled = n === 1;

  if (n === 3) {
    if (nextBtn) { nextBtn.textContent = 'Start Crawling'; nextBtn.style.display = ''; }
    if (downloadBtn) downloadBtn.style.display = 'none';
    if (selectAllWrap) selectAllWrap.style.display = 'none';
  } else if (n === 4) {
    if (nextBtn) nextBtn.style.display = 'none';
    if (downloadBtn) downloadBtn.style.display = '';
    if (selectAllWrap) selectAllWrap.style.display = grabAssets.size ? '' : 'none';
  } else {
    if (nextBtn) { nextBtn.textContent = 'Next'; nextBtn.style.display = ''; }
    if (downloadBtn) downloadBtn.style.display = 'none';
    if (selectAllWrap) selectAllWrap.style.display = 'none';
  }
}

function openGrabberWizard() {
  grabAssets.clear();
  grabSelected.clear();
  const projectName = document.getElementById('grab-project-name');
  const startUrl = document.getElementById('grab-start-url');
  const saveDir = document.getElementById('grab-save-dir');
  const sameOrigin = document.getElementById('grab-same-origin');
  const depth0 = document.querySelector('input[name="grab-depth"][value="0"]');
  const filterAll = document.querySelector('input[name="grab-filter"][value="All"]');
  if (projectName) projectName.value = '';
  if (startUrl) startUrl.value = '';
  if (saveDir) saveDir.value = '';
  if (sameOrigin) sameOrigin.checked = true;
  if (depth0) depth0.checked = true;
  if (filterAll) filterAll.checked = true;
  const tree = document.getElementById('grab-tree');
  if (tree) tree.innerHTML = '';
  const statusText = document.getElementById('grab-status-text');
  if (statusText) statusText.textContent = 'Ready to start crawling…';
  const countText = document.getElementById('grab-count-text');
  if (countText) countText.textContent = '';
  goToGrabStep(1);
  if (grabberModal) grabberModal.classList.remove('hidden');
}

function closeGrabberWizard() {
  if (window.api.cancelGrabber) window.api.cancelGrabber();
  if (grabberModal) grabberModal.classList.add('hidden');
}

async function startGrabberCrawl() {
  grabAssets.clear();
  grabSelected.clear();
  const tree = document.getElementById('grab-tree');
  if (tree) tree.innerHTML = '';
  const statusText = document.getElementById('grab-status-text');
  if (statusText) statusText.textContent = 'Crawling…';
  const countText = document.getElementById('grab-count-text');
  if (countText) countText.textContent = '';
  const selectAllWrap = document.getElementById('grab-select-all-wrap');
  if (selectAllWrap) selectAllWrap.style.display = 'none';

  const depthEl = document.querySelector('input[name="grab-depth"]:checked');
  const filterEl = document.querySelector('input[name="grab-filter"]:checked');
  const opts = {
    targetUrl: (document.getElementById('grab-start-url')?.value || '').trim(),
    maxDepth: depthEl ? Number(depthEl.value) : 0,
    filterCategory: filterEl ? filterEl.value : 'All',
    sameOriginOnly: document.getElementById('grab-same-origin')?.checked !== false,
  };

  if (window.api.startGrabber) {
    const res = await window.api.startGrabber(opts);
    if (!res || !res.started) {
      if (statusText) statusText.textContent = (res && res.error) || 'Failed to start crawl.';
    }
  }
}

function renderGrabTree() {
  const tree = document.getElementById('grab-tree');
  if (!tree) return;

  const groups = { Images: [], 'Video/Audio': [], Documents: [], Other: [] };
  for (const asset of grabAssets.values()) {
    (groups[asset.category] || (groups[asset.category] = [])).push(asset);
  }

  tree.innerHTML = '';
  let anyGroup = false;
  for (const [cat, list] of Object.entries(groups)) {
    if (!list.length) continue;
    anyGroup = true;

    const groupEl = document.createElement('div');
    groupEl.className = 'grab-group';

    const selectedInGroup = list.filter((a) => grabSelected.has(a.url)).length;
    const header = document.createElement('div');
    header.className = 'grab-group-header';
    header.innerHTML = `
      <input type="checkbox" class="grab-group-check" ${selectedInGroup === list.length ? 'checked' : ''} />
      <span class="grab-group-title">${escapeHtml(cat)}</span>
      <span class="grab-group-count">${list.length}</span>
    `;
    const groupCheck = header.querySelector('.grab-group-check');
    groupCheck.addEventListener('change', () => {
      for (const a of list) {
        if (groupCheck.checked) grabSelected.add(a.url);
        else grabSelected.delete(a.url);
      }
      renderGrabTree();
    });
    groupEl.appendChild(header);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'grab-group-items';
    for (const asset of list) {
      const row = document.createElement('label');
      row.className = 'grab-item';
      const checked = grabSelected.has(asset.url);
      row.innerHTML = `
        <input type="checkbox" class="grab-item-check" ${checked ? 'checked' : ''} />
        <span class="grab-item-name" title="${escapeHtml(asset.url)}">${escapeHtml(asset.filename)}</span>
        <span class="grab-item-badge">${escapeHtml((asset.kind || 'file').toUpperCase())}</span>
      `;
      const cb = row.querySelector('.grab-item-check');
      cb.addEventListener('change', () => {
        if (cb.checked) grabSelected.add(asset.url);
        else grabSelected.delete(asset.url);
        renderGrabTree();
      });
      itemsWrap.appendChild(row);
    }
    groupEl.appendChild(itemsWrap);
    tree.appendChild(groupEl);
  }

  if (!anyGroup) {
    tree.innerHTML = '<div class="grab-empty">No files discovered yet…</div>';
  }

  const countText = document.getElementById('grab-count-text');
  if (countText) countText.textContent = `${grabSelected.size} of ${grabAssets.size} selected`;

  const selectAllWrap = document.getElementById('grab-select-all-wrap');
  const selectAllCb = document.getElementById('grab-select-all');
  if (selectAllWrap) selectAllWrap.style.display = grabAssets.size ? '' : 'none';
  if (selectAllCb) selectAllCb.checked = grabAssets.size > 0 && grabSelected.size === grabAssets.size;
}

// Coalesce bursts of asset-found events (a busy page can fire dozens within
// milliseconds) into a single re-render instead of thrashing the DOM per event.
function scheduleGrabRender() {
  if (_grabRenderScheduled) return;
  _grabRenderScheduled = true;
  setTimeout(() => {
    _grabRenderScheduled = false;
    renderGrabTree();
  }, 80);
}

document.getElementById('dd-run-grabber')?.addEventListener('click', openGrabberWizard);
document.getElementById('grabber-close')?.addEventListener('click', closeGrabberWizard);
document.getElementById('grab-cancel-btn')?.addEventListener('click', closeGrabberWizard);

document.getElementById('grab-next-btn')?.addEventListener('click', () => {
  if (grabStep === 1) {
    const url = (document.getElementById('grab-start-url')?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      alert('Enter a valid http:// or https:// start page URL.');
      return;
    }
    goToGrabStep(2);
  } else if (grabStep === 2) {
    goToGrabStep(3);
  } else if (grabStep === 3) {
    goToGrabStep(4);
    startGrabberCrawl();
  }
});

document.getElementById('grab-back-btn')?.addEventListener('click', () => {
  if (grabStep === 4 && window.api.cancelGrabber) window.api.cancelGrabber();
  if (grabStep > 1) goToGrabStep(grabStep - 1);
});

document.getElementById('grab-browse-btn')?.addEventListener('click', async () => {
  if (!window.api.pickDestDir) return;
  const dir = await window.api.pickDestDir();
  if (dir) {
    const el = document.getElementById('grab-save-dir');
    if (el) el.value = dir;
  }
});

document.getElementById('grab-select-all')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    for (const url of grabAssets.keys()) grabSelected.add(url);
  } else {
    grabSelected.clear();
  }
  renderGrabTree();
});

document.getElementById('grab-download-btn')?.addEventListener('click', () => {
  const destDir = (document.getElementById('grab-save-dir')?.value || '').trim() || undefined;
  let count = 0;
  for (const url of grabSelected) {
    const asset = grabAssets.get(url);
    if (!asset || !window.api.add) continue;
    window.api.add({ url: asset.url, kind: asset.kind, suggestedFilename: asset.filename, destDir });
    count++;
  }
  closeGrabberWizard();
  if (count > 0) alert(`${count} file(s) added to the download queue.`);
});

if (window.api && window.api.onGrabberAssetFound) {
  window.api.onGrabberAssetFound((asset) => {
    grabAssets.set(asset.url, asset);
    grabSelected.add(asset.url); // default to selected; user can deselect
    scheduleGrabRender();
  });
}
if (window.api && window.api.onGrabberDone) {
  window.api.onGrabberDone((result) => {
    const statusText = document.getElementById('grab-status-text');
    if (statusText) {
      const n = (result && result.assets ? result.assets.length : grabAssets.size);
      statusText.textContent = result && result.cancelled ? 'Crawl cancelled.' : `Crawl complete — ${n} file(s) found.`;
    }
    renderGrabTree(); // final, unthrottled render so the last events aren't stuck in the debounce
  });
}

// --- Batch Download Modal (wildcard ranges + multiline URL list) -----------
// expandBatchPattern/expandAllBatchLines deliberately mirror
// core/BatchDownloader.js's expandBatchUrl — the renderer runs sandboxed
// (contextIsolation, no Node integration) so it can't require() that module
// directly. Kept in sync intentionally, same as extension/dashParser.js's
// relationship to core/dash.js.
const BATCH_MAX_EXPANSION = 1000;

function kindForBatchUrl(urlStr) {
  const path = urlStr.split('?')[0].split('#')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'file';
}

function expandBatchPattern(patternUrl, padWidth) {
  const numMatch = /\[(\d+)-(\d+)\](?:%0(\d+)d)?/.exec(patternUrl);
  if (numMatch) {
    const startNum = parseInt(numMatch[1], 10);
    const endNum = parseInt(numMatch[2], 10);
    const inlinePad = numMatch[3] != null ? Number(numMatch[3]) : null;
    const padLen = padWidth != null ? padWidth : inlinePad != null ? inlinePad : numMatch[1].length;
    const step = startNum <= endNum ? 1 : -1;
    const urls = [];
    let n = 0;
    for (let i = startNum; (step > 0 ? i <= endNum : i >= endNum) && n < BATCH_MAX_EXPANSION; i += step, n++) {
      urls.push(patternUrl.replace(numMatch[0], String(i).padStart(padLen, '0')));
    }
    return urls;
  }

  const alphaMatch = /\[([a-zA-Z])-([a-zA-Z])\]/.exec(patternUrl);
  if (alphaMatch) {
    const startChar = alphaMatch[1].charCodeAt(0);
    const endChar = alphaMatch[2].charCodeAt(0);
    const step = startChar <= endChar ? 1 : -1;
    const urls = [];
    for (let i = startChar; step > 0 ? i <= endChar : i >= endChar; i += step) {
      urls.push(patternUrl.replace(alphaMatch[0], String.fromCharCode(i)));
    }
    return urls;
  }

  return patternUrl.trim() ? [patternUrl.trim()] : [];
}

function expandAllBatchLines(text, padWidth) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const urls = [];
  for (const line of lines) {
    for (const u of expandBatchPattern(line, padWidth)) {
      if (!seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
    if (urls.length >= BATCH_MAX_EXPANSION) break;
  }
  return urls.slice(0, BATCH_MAX_EXPANSION);
}

const batchUrls = []; // ordered list of resolved urls from the last preview
const batchSelected = new Set();

function isWildcardPattern(urlStr) {
  return /\[[^\]]+\]/.test(urlStr);
}

function generateBatchPreview() {
  const text = document.getElementById('batch-urls-input')?.value || '';
  const padRaw = document.getElementById('batch-pad-width')?.value;
  const padWidth = padRaw !== '' && padRaw != null ? Number(padRaw) : null;
  const urls = expandAllBatchLines(text, padWidth);
  batchUrls.length = 0;
  batchUrls.push(...urls);
  batchSelected.clear();
  for (const u of urls) batchSelected.add(u);
  renderBatchPreview();
}

function renderBatchPreview() {
  const list = document.getElementById('batch-preview-list');
  if (!list) return;
  list.innerHTML = '';

  if (!batchUrls.length) {
    list.innerHTML = '<div class="grab-empty">No URLs generated yet.</div>';
  } else {
    for (const url of batchUrls) {
      const row = document.createElement('label');
      row.className = 'grab-item';
      const checked = batchSelected.has(url);
      row.innerHTML = `
        <input type="checkbox" class="grab-item-check" ${checked ? 'checked' : ''} />
        <span class="grab-item-name" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        <span class="grab-item-badge">${escapeHtml(kindForBatchUrl(url).toUpperCase())}</span>
      `;
      const cb = row.querySelector('.grab-item-check');
      cb.addEventListener('change', () => {
        if (cb.checked) batchSelected.add(url);
        else batchSelected.delete(url);
        updateBatchCountText();
        updateBatchSelectAllState();
      });
      list.appendChild(row);
    }
  }

  const selectAllWrap = document.getElementById('batch-select-all-wrap');
  if (selectAllWrap) selectAllWrap.style.display = batchUrls.length ? '' : 'none';
  updateBatchCountText();
  updateBatchSelectAllState();
}

function updateBatchCountText() {
  const countText = document.getElementById('batch-count-text');
  if (!countText) return;
  if (!batchUrls.length) {
    countText.textContent = 'Enter URL pattern(s) above and click "Generate Preview".';
    return;
  }
  const capped = batchUrls.length >= BATCH_MAX_EXPANSION ? ` (capped at ${BATCH_MAX_EXPANSION})` : '';
  countText.textContent = `${batchSelected.size} of ${batchUrls.length} URL(s) selected${capped}`;
}

function updateBatchSelectAllState() {
  const cb = document.getElementById('batch-select-all');
  if (cb) cb.checked = batchUrls.length > 0 && batchSelected.size === batchUrls.length;
}

function openBatchModal(prefillText) {
  const input = document.getElementById('batch-urls-input');
  if (input) input.value = prefillText || '';
  const pad = document.getElementById('batch-pad-width');
  if (pad) pad.value = '';
  const cat = document.getElementById('batch-category');
  if (cat) cat.value = 'General';
  batchUrls.length = 0;
  batchSelected.clear();
  renderBatchPreview();
  document.getElementById('batch-modal')?.classList.remove('hidden');
  if (prefillText && prefillText.trim()) generateBatchPreview();
}

function closeBatchModal() {
  document.getElementById('batch-modal')?.classList.add('hidden');
}

// A URL typed/pasted with wildcard syntax routes here instead of the plain
// single-download flow, so the user previews and picks which generated URLs
// to queue rather than every download silently multiplying behind the scenes.
function routeUrlToAddFlow(urlStr) {
  if (isWildcardPattern(urlStr)) openBatchModal(urlStr);
  else showDownloadInfoModal(urlStr);
}

document.getElementById('dd-add-batch')?.addEventListener('click', () => openBatchModal(''));
document.getElementById('batch-close')?.addEventListener('click', closeBatchModal);
document.getElementById('batch-cancel-btn')?.addEventListener('click', closeBatchModal);
document.getElementById('batch-preview-btn')?.addEventListener('click', generateBatchPreview);

document.getElementById('batch-select-all')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    for (const u of batchUrls) batchSelected.add(u);
  } else {
    batchSelected.clear();
  }
  renderBatchPreview();
});

document.getElementById('batch-ok-btn')?.addEventListener('click', () => {
  const category = document.getElementById('batch-category')?.value;
  const destDirs = appConfig.destDirs || {};
  const destDir = category && destDirs[category] ? destDirs[category] : undefined;
  let count = 0;
  for (const url of batchSelected) {
    if (!window.api.add) continue;
    window.api.add({ url, kind: kindForBatchUrl(url), destDir });
    count++;
  }
  closeBatchModal();
  if (count > 0) alert(`${count} file(s) added to the download queue.`);
});

const clearDoneBtn = document.getElementById('clear-done-btn');
if (clearDoneBtn) {
  clearDoneBtn.addEventListener('click', () => {
    for (const [id, item] of items) {
      if (item.status === 'completed') {
        if (window.api.remove) window.api.remove(id);
      }
    }
    clearSelection();
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
    if (currentCategory !== 'queue') currentQueueId = null;
    render();
  });
});

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  // Suppress every global shortcut while a dialog is open, so e.g. Ctrl+N or
  // Delete can't fire over the background list while a modal has visual focus
  // (a focused <button> isn't an INPUT/TEXTAREA/SELECT, so the check above
  // alone wouldn't catch it).
  if (document.querySelector('.idm-modal:not(.hidden)')) return;

  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    // Ctrl+N: Add new URL dialog
    e.preventDefault();
    if (addUrlModal) addUrlModal.classList.remove('hidden');
  } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
    // Ctrl+O: Options dialog
    e.preventDefault();
    openOptions();
  } else if (e.key === 'Insert' || (e.ctrlKey && e.key.toLowerCase() === 'v')) {
    // Insert / Ctrl+V: paste URL from clipboard into the Add URL dialog
    e.preventDefault();
    pasteUrlIntoAddModal();
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    // Ctrl+A: select every row currently on screen. Scoped to the visible
    // (category-filtered) rows on purpose — selecting the hidden ones as well
    // used to highlight only a subset while arming the rest for Delete.
    e.preventDefault();
    selectAllVisible();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // Arrow keys walk the list; Shift extends the range from the anchor.
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    const order = visibleItems().map((i) => i.id);
    if (order.length) {
      const target = e.key === 'Home' ? order[0] : order[order.length - 1];
      _lastFocusedId = target;
      if (e.shiftKey) selectRangeTo(target, false);
      else selectOnly(target);
      scrollRowIntoView(target);
    }
  } else if (e.key === 'Delete' && e.shiftKey) {
    // Shift+Delete: delete selected downloads + delete the file(s) from disk
    e.preventDefault();
    confirmDelete(Array.from(selectedIds), true);
  } else if (e.key === 'Delete') {
    // Delete: delete selected downloads (confirmation modal)
    e.preventDefault();
    confirmDelete(Array.from(selectedIds), false);
  } else if (e.code === 'Space' || e.key === 'F8') {
    // Space / F8: pause (or resume, if already paused) selected download(s)
    e.preventDefault();
    for (const id of selectedIds) {
      const item = items.get(id);
      if (item) {
        if (item.status === 'running' && window.api.pause) window.api.pause(item.id);
        else if (window.api.resume) window.api.resume(item.id);
      }
    }
  } else if (e.altKey && e.key === 'Enter') {
    // Alt+Enter: Download Properties dialog
    e.preventDefault();
    showPropertiesModal(items.get(Array.from(selectedIds)[0]));
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
  if (url) routeUrlToAddFlow(url);
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

// Coalesces bursts of queue:item-updated events (one active download emits a
// progress tick roughly every 400ms; several concurrent downloads can land
// within the same short window) into a single table rebuild + badge
// recompute, instead of doing that full-DOM work on every single event.
let _tableRenderScheduled = false;
function scheduleTableRender() {
  if (_tableRenderScheduled) return;
  _tableRenderScheduled = true;
  setTimeout(() => {
    _tableRenderScheduled = false;
    render();
    updateSidebarBadges();
  }, 100);
}

// --- Named queues ------------------------------------------------------------
// The sidebar's "Queues" node used to be decorative: categoryOf() could never
// return 'queues', so it always showed an empty list. It now expands into the
// real queues, each filtering the table to its own contents.
let knownQueues = [];
let currentQueueId = null;

function queueName(queueId) {
  const q = knownQueues.find((x) => x.id === queueId);
  return q ? q.name : 'Main download queue';
}

function renderQueueTree() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  list.innerHTML = '';
  for (const q of knownQueues) {
    const li = document.createElement('li');
    li.className = 'tree-node';
    li.dataset.cat = 'queue';
    li.dataset.queueId = q.id;
    li.classList.toggle('active', currentCategory === 'queue' && currentQueueId === q.id);
    li.classList.toggle('queue-running', q.running);
    li.innerHTML = `
      <span class="tree-icon icon-queues"></span>
      <span class="tree-title"></span>
      <span class="queue-badge"></span>
    `;
    li.querySelector('.tree-title').textContent = q.name;
    li.querySelector('.queue-badge').textContent = q.count ? String(q.count) : '';
    li.title = `${q.name} — ${q.running ? 'running' : 'stopped'}, ${
      q.maxConcurrent > 0 ? q.maxConcurrent + ' at once' : 'global concurrency'
    }`;
    li.addEventListener('click', () => {
      document.querySelectorAll('.tree-node').forEach((n) => n.classList.remove('active'));
      li.classList.add('active');
      currentCategory = 'queue';
      currentQueueId = q.id;
      render();
    });
    list.appendChild(li);
  }
  renderQueueSubmenu();
}

function renderQueueSubmenu() {
  const menu = document.getElementById('ctx-queue-submenu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const q of knownQueues) {
    const el = document.createElement('div');
    el.className = 'ctx-item';
    el.textContent = q.name;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.api.moveToQueue) window.api.moveToQueue(Array.from(selectedIds), q.id);
      contextMenu?.classList.add('hidden');
    });
    menu.appendChild(el);
  }
}

async function refreshQueues() {
  if (!window.api.listQueues) return;
  try {
    knownQueues = (await window.api.listQueues()) || [];
  } catch (e) {
    knownQueues = [];
  }
  renderQueueTree();
  renderQueuesModal();
}

// --- Queue manager dialog ----------------------------------------------------
function renderQueuesModal() {
  const body = document.getElementById('queues-tbody');
  if (!body || document.getElementById('queues-modal')?.classList.contains('hidden')) return;
  body.innerHTML = '';

  for (const q of knownQueues) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="q-name" /></td>
      <td class="q-count"></td>
      <td><input type="number" class="q-conc" min="0" max="32" step="1" /></td>
      <td class="q-state"></td>
      <td class="q-actions"></td>
    `;
    const nameInput = tr.querySelector('.q-name');
    nameInput.value = q.name;
    // The two built-in queues keep their names, matching IDM.
    nameInput.disabled = q.isDefault;
    nameInput.addEventListener('change', () => {
      if (window.api.renameQueue) window.api.renameQueue(q.id, nameInput.value);
    });

    tr.querySelector('.q-count').textContent = String(q.count || 0);

    const concInput = tr.querySelector('.q-conc');
    concInput.value = String(q.maxConcurrent || 0);
    concInput.addEventListener('change', () => {
      if (window.api.setQueueConcurrency) window.api.setQueueConcurrency(q.id, parseInt(concInput.value, 10) || 0);
    });

    const state = tr.querySelector('.q-state');
    state.textContent = q.running ? 'Running' : 'Stopped';
    state.className = `q-state ${q.running ? 'queue-state-running' : 'queue-state-stopped'}`;

    const actions = tr.querySelector('.q-actions');
    const toggle = document.createElement('button');
    toggle.className = 'idm-btn';
    toggle.textContent = q.running ? 'Stop' : 'Start';
    toggle.addEventListener('click', () => {
      if (q.running) window.api.stopQueue && window.api.stopQueue(q.id);
      else window.api.startQueue && window.api.startQueue(q.id);
    });
    actions.appendChild(toggle);

    if (!q.isDefault) {
      const del = document.createElement('button');
      del.className = 'idm-btn';
      del.textContent = 'Delete';
      del.style.marginLeft = '4px';
      del.title = 'Downloads in this queue move to the main queue';
      del.addEventListener('click', () => {
        if (window.api.deleteQueue) window.api.deleteQueue(q.id);
      });
      actions.appendChild(del);
    }

    body.appendChild(tr);
  }
}

function openQueuesModal() {
  document.getElementById('queues-modal')?.classList.remove('hidden');
  renderQueuesModal();
}
function closeQueuesModal() {
  document.getElementById('queues-modal')?.classList.add('hidden');
}

document.getElementById('queues-close')?.addEventListener('click', closeQueuesModal);
document.getElementById('queues-close-btn')?.addEventListener('click', closeQueuesModal);
document.getElementById('queues-root')?.addEventListener('click', openQueuesModal);
document.getElementById('new-queue-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('new-queue-name');
  const name = (input?.value || '').trim();
  if (!name || !window.api.createQueue) return;
  await window.api.createQueue(name, 0);
  if (input) input.value = '';
});

// --- Reordering within a queue ----------------------------------------------
function moveSelectedBy(delta) {
  if (!window.api.reorder) return;
  // Moving several rows at once has to start from the edge nearest the
  // direction of travel, or the first move blocks the next one.
  const order = visibleItems().map((i) => i.id);
  const chosen = order.filter((id) => selectedIds.has(id));
  const sequence = delta < 0 ? chosen : chosen.slice().reverse();
  for (const id of sequence) window.api.reorder(id, delta);
}

document.getElementById('ctx-move-up')?.addEventListener('click', () => moveSelectedBy(-1));
document.getElementById('ctx-move-down')?.addEventListener('click', () => moveSelectedBy(1));

// --- Download Progress dialog (per-connection view) --------------------------
// IDM's signature window: one live bar per connection, so you can watch the
// multi-part transfer actually happening — including segments being split off
// mid-download and handed to a free worker.
//
// The engine has always emitted this in progress.segments[]; nothing rendered
// it. Rows are created once and then mutated in place: this repaints on every
// progress tick (~400ms per active download), and rebuilding the list each time
// would throw away the CSS transitions and make the bars stutter.
let progressModalId = null;
const progressRows = new Map(); // segment index -> { row, fill, bytes }

const progressModal = document.getElementById('progress-modal');

function closeProgressModal() {
  progressModalId = null;
  progressRows.clear();
  const list = document.getElementById('prog-connections');
  if (list) list.innerHTML = '';
  progressModal?.classList.add('hidden');
}

function showProgressModal(item) {
  if (!item || !progressModal) return;
  progressModalId = item.id;
  progressRows.clear();
  const list = document.getElementById('prog-connections');
  if (list) list.innerHTML = '';
  renderProgressModal(item);
  progressModal.classList.remove('hidden');
}

function statusLabel(item) {
  switch (item.status) {
    case 'running': return 'Downloading';
    case 'paused': return 'Paused';
    case 'queued': return 'Queued';
    case 'held': return 'On Hold';
    case 'error': return 'Error';
    case 'completed': return 'Complete';
    case 'cancelled': return 'Cancelled';
    default: return item.status || '—';
  }
}

function renderProgressModal(item) {
  if (!item || item.id !== progressModalId) return;
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const p = item.progress || {};
  set('prog-filename', item.filename || item.url || '—');
  set('prog-status', item.error ? `Error — ${item.error}` : statusLabel(item));
  set('prog-size', formatBytes(item.size));
  set('prog-downloaded', formatBytes(p.downloaded));
  set('prog-speed', item.status === 'running' ? formatSpeed(p.speedBytesPerSec) : '—');
  set('prog-eta', item.status === 'running' && p.eta ? formatTimeLeft(p.eta) : '—');

  const pct = Math.max(0, Math.min(100, p.percent != null ? p.percent : item.status === 'completed' ? 100 : 0));
  const overallFill = document.getElementById('prog-overall-fill');
  const overallText = document.getElementById('prog-overall-text');
  if (overallFill) overallFill.style.width = `${pct}%`;
  if (overallText) overallText.textContent = `${pct.toFixed(1)}%`;

  const segments = Array.isArray(p.segments) ? p.segments : [];
  const list = document.getElementById('prog-connections');
  const empty = document.getElementById('prog-no-connections');
  if (empty) empty.classList.toggle('hidden', segments.length > 0);
  set('prog-conn-count', segments.length ? `${segments.filter((s) => s.active).length} of ${segments.length} active` : '');
  if (!list) return;

  // Dynamic splitting appends segments mid-download, so the row set can grow
  // between ticks; rows are added on demand and never rebuilt wholesale.
  for (const seg of segments) {
    let entry = progressRows.get(seg.index);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'prog-conn';
      row.innerHTML = `
        <span class="prog-conn-index"></span>
        <div class="prog-conn-bar"><div class="prog-conn-fill"></div></div>
        <span class="prog-conn-bytes"></span>
      `;
      list.appendChild(row);
      entry = {
        row,
        index: row.querySelector('.prog-conn-index'),
        fill: row.querySelector('.prog-conn-fill'),
        bytes: row.querySelector('.prog-conn-bytes'),
      };
      progressRows.set(seg.index, entry);
    }

    const total = seg.total != null ? seg.total : null;
    const segPct = total ? Math.max(0, Math.min(100, (seg.downloaded / total) * 100)) : seg.downloaded > 0 ? 100 : 0;
    const complete = total != null && seg.downloaded >= total;

    entry.index.textContent = `#${seg.index + 1}`;
    entry.fill.style.width = `${segPct}%`;
    entry.bytes.textContent = total != null ? `${formatBytes(seg.downloaded)} / ${formatBytes(total)}` : formatBytes(seg.downloaded);
    entry.row.classList.toggle('active', Boolean(seg.active));
    entry.row.classList.toggle('done', complete && !seg.active);
    entry.row.title =
      total != null
        ? `Connection ${seg.index + 1} — bytes ${seg.start}–${seg.end} (${segPct.toFixed(1)}%)`
        : `Connection ${seg.index + 1} — length unknown`;
  }
}

const openProgressForSelection = () => {
  const item = items.get(Array.from(selectedIds)[0]);
  if (item) showProgressModal(item);
};
document.getElementById('ctx-progress')?.addEventListener('click', openProgressForSelection);
document.getElementById('dd-progress')?.addEventListener('click', openProgressForSelection);
document.getElementById('progress-close')?.addEventListener('click', closeProgressModal);
document.getElementById('progress-close-btn')?.addEventListener('click', closeProgressModal);
document.getElementById('prog-pause-btn')?.addEventListener('click', () => {
  if (progressModalId && window.api.pause) window.api.pause(progressModalId);
});
document.getElementById('prog-resume-btn')?.addEventListener('click', () => {
  if (progressModalId && window.api.resume) window.api.resume(progressModalId);
});

// --- Duplicate download confirmation -----------------------------------------
// The Manager detects the duplicate but deliberately doesn't decide: the same
// add() is reached from the browser extension, where there is no dialog to
// show. It defers here, and a confirmed prompt re-adds with allowDuplicate.
let pendingDuplicate = null;

function closeDuplicateModal() {
  pendingDuplicate = null;
  document.getElementById('duplicate-modal')?.classList.add('hidden');
}

function showDuplicateModal(info) {
  if (!info || !info.payload) return;
  pendingDuplicate = info;
  const label = info.existingFilename || 'This file';
  const statusText = info.existingStatus === 'completed' ? 'has already been downloaded' : 'is already in the list';
  const text = document.getElementById('duplicate-text');
  if (text) text.textContent = `${label} ${statusText}. Download it again?`;
  const urlEl = document.getElementById('duplicate-url');
  if (urlEl) urlEl.textContent = info.url || '';
  document.getElementById('duplicate-modal')?.classList.remove('hidden');
}

document.getElementById('duplicate-close')?.addEventListener('click', closeDuplicateModal);
document.getElementById('duplicate-cancel-btn')?.addEventListener('click', closeDuplicateModal);
document.getElementById('duplicate-add-btn')?.addEventListener('click', () => {
  const info = pendingDuplicate;
  closeDuplicateModal();
  if (info && window.api.add) window.api.add(info.payload);
});

// --- Resizable table columns -------------------------------------------------
// The <colgroup> in index.html is the single source of truth for column
// geometry (the table is `table-layout: fixed`, so <col> widths drive both the
// header and the body from one place). Everything below reads and writes those
// <col> elements; nothing else in the app touches column widths.
//
// The final column is the "fill" column: it has no stored width and instead
// absorbs whatever horizontal space is left, so the table always spans the
// window. It therefore has no drag handle — shrinking it would just be undone
// on the next layout pass.
const COL_WIDTH_STORAGE_KEY = 'idm.columnWidths.v1';
const DEFAULT_COL_MIN = 40;
const MAX_COL_WIDTH = 1200;

function columnDefs() {
  return queueColgroup ? Array.from(queueColgroup.children) : [];
}

function headerCells() {
  return queueTable ? Array.from(queueTable.querySelectorAll('thead th')) : [];
}

function colMin(col) {
  const m = parseInt(col.dataset.min, 10);
  return isFinite(m) && m > 0 ? m : DEFAULT_COL_MIN;
}

function colWidth(col) {
  const px = parseFloat(col.style.width);
  if (isFinite(px) && px > 0) return px;
  // Not sized yet (the fill column before the first layout pass) — fall back
  // to whatever the browser actually laid the matching header cell out at.
  const th = headerCells()[columnDefs().indexOf(col)];
  return th ? Math.round(th.getBoundingClientRect().width) : DEFAULT_COL_MIN;
}

// Recomputes the fill column and the table's own width so that the sum of the
// columns is always exactly the table width. Leaving that to the browser means
// fixed layout redistributes any slack across every column, which makes a drag
// move the divider by something other than the distance the mouse travelled.
function applyColumnLayout() {
  const cols = columnDefs();
  if (!cols.length || !queueTable || !tableWrap) return;

  // Zero means the container hasn't been laid out yet (the window is still
  // hidden, or this ran before the first paint). Sizing the fill column
  // against 0 would collapse it to its minimum and leave it stuck there, so
  // wait — the ResizeObserver below fires as soon as there's a real width.
  const available = tableWrap.clientWidth;
  if (available <= 0) return;

  const lastIndex = cols.length - 1;
  let fixedTotal = 0;
  for (let i = 0; i < lastIndex; i++) fixedTotal += colWidth(cols[i]);

  const fillWidth = Math.max(colMin(cols[lastIndex]), available - fixedTotal);
  cols[lastIndex].style.width = `${fillWidth}px`;
  queueTable.style.width = `${fixedTotal + fillWidth}px`;
}

function loadColumnWidths() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(COL_WIDTH_STORAGE_KEY) || 'null');
  } catch (e) {
    return; // unavailable or corrupt JSON — the markup defaults stand
  }
  if (!saved || typeof saved !== 'object') return;

  for (const col of columnDefs()) {
    const w = saved[col.dataset.key];
    // Anything out of range is ignored rather than clamped: a corrupted entry
    // should fall back to the sane default, not to a 1px sliver the user then
    // has to find and drag back open.
    if (typeof w === 'number' && isFinite(w) && w >= colMin(col) && w <= MAX_COL_WIDTH) {
      col.style.width = `${w}px`;
    }
  }
}

function saveColumnWidths() {
  try {
    const cols = columnDefs();
    const out = {};
    // Keyed by data-key, not index, so adding or reordering a column later
    // can't silently apply the wrong saved width to it.
    for (let i = 0; i < cols.length - 1; i++) out[cols[i].dataset.key] = Math.round(colWidth(cols[i]));
    localStorage.setItem(COL_WIDTH_STORAGE_KEY, JSON.stringify(out));
  } catch (e) {
    /* storage full or disabled — widths just won't persist across restarts */
  }
}

// Intrinsic width of an element's contents, via a Range over them. scrollWidth
// is no use here: for content that already fits it just reports the element's
// own laid-out width, so auto-fit would only ever "fit" a column to itself.
// A Range measures the text's real extent regardless of what's clipping it.
function measureContentWidth(el) {
  if (!el) return 0;
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width;
}

function cellContentWidth(cell) {
  // The inline progress bar is width:100% of its column by design, so it would
  // report the current width straight back and pin auto-fit where it is.
  if (cell.querySelector('.idm-progress')) return 0;

  // The File Name cell holds a type icon next to the label; measure the label
  // and add the icon plus the flex gap.
  const nameText = cell.querySelector('.cell-name-text');
  if (nameText) {
    const icon = cell.querySelector('.cell-name > span');
    return measureContentWidth(nameText) + (icon ? icon.offsetWidth + 6 : 0);
  }
  return measureContentWidth(cell);
}

// Double-clicking a divider sizes the column to its widest visible cell — the
// same gesture Explorer and IDM both support.
function autoFitColumn(index) {
  const col = columnDefs()[index];
  if (!col) return;

  let widest = measureContentWidth(headerCells()[index]?.querySelector('.th-label'));
  for (const tr of queueBody.children) {
    const cell = tr.children[index];
    if (cell) widest = Math.max(widest, cellContentWidth(cell));
  }

  col.style.width = `${Math.max(colMin(col), Math.min(widest + 14, MAX_COL_WIDTH))}px`; // +14 for cell padding + border
  applyColumnLayout();
  saveColumnWidths();
}

function beginColumnResize(e, handle, col) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startWidth = colWidth(col);
  const min = colMin(col);

  handle.classList.add('resizing');
  document.body.classList.add('col-resizing');
  // Pointer capture keeps move/up events flowing to this handle even once the
  // cursor leaves it — without it a fast drag detaches and strands the table
  // in resizing state with no pointerup to clean it up.
  try {
    handle.setPointerCapture(e.pointerId);
  } catch (err) {
    /* capture unsupported — the drag still works, just less forgivingly */
  }

  const onMove = (ev) => {
    col.style.width = `${Math.max(min, Math.min(startWidth + (ev.clientX - startX), MAX_COL_WIDTH))}px`;
    applyColumnLayout();
  };

  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    handle.classList.remove('resizing');
    document.body.classList.remove('col-resizing');
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* pointer already gone */
    }
    saveColumnWidths();
  };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function initColumnResizing() {
  const cols = columnDefs();
  const ths = headerCells();
  if (!queueTable || !tableWrap || !cols.length) return;
  if (cols.length !== ths.length) {
    console.warn('[Columns] <colgroup> and <th> counts differ — skipping resize wiring.');
    return;
  }

  loadColumnWidths();
  applyColumnLayout();

  // Each handle sits on the header cell to the RIGHT of the divider it
  // controls and overhangs leftwards — see .col-resizer in style.css for why
  // overhanging the other way would be unhittable.
  for (let i = 1; i < ths.length; i++) {
    const target = cols[i - 1];
    const handle = document.createElement('div');
    handle.className = 'col-resizer';
    handle.title = 'Drag to resize · double-click to fit contents';
    handle.addEventListener('pointerdown', (ev) => beginColumnResize(ev, handle, target));
    handle.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      autoFitColumn(i - 1);
    });
    ths[i].appendChild(handle);
  }

  // A ResizeObserver rather than window.onresize: it also fires for the first
  // real layout pass (so a window that starts hidden still gets a correctly
  // sized fill column) and for width changes that aren't window resizes at
  // all, such as the sidebar being toggled.
  if (typeof ResizeObserver === 'function') {
    let lastWidth = -1;
    const ro = new ResizeObserver(() => {
      const w = tableWrap.clientWidth;
      if (w === lastWidth) return; // ignore height-only changes; nothing to redo
      lastWidth = w;
      applyColumnLayout();
    });
    ro.observe(tableWrap);
  } else {
    window.addEventListener('resize', applyColumnLayout);
  }
}

// --- Initialization ---
let _initialized = false;
function init() {
  if (_initialized) return; // guard against DOMContentLoaded + fallback double-call
  _initialized = true;
  injectIcons();
  initColumnResizing();
  refreshQueues();

  if (window.api && window.api.getConfig) {
    window.api.getConfig().then((c) => { appConfig = c || {}; }).catch(() => {});
  }

  if (window.api && window.api.isQueueRunning) {
    window.api.isQueueRunning().then(updateQueueUI).catch(() => {});
  }
  if (window.api && window.api.onQueueStateChanged) {
    window.api.onQueueStateChanged((state) => updateQueueUI(state && state.running));
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
        scheduleTableRender();
      }
    });
  }

  if (window.api && window.api.onItemUpdated) {
    window.api.onItemUpdated((item) => {
      if (item) {
        const prev = items.get(item.id);
        const prevStatus = prev ? prev.status : null;
        items.set(item.id, item);
        // Repaint the progress dialog straight from the event rather than
        // waiting on the coalesced table render — the whole point of that view
        // is that the bars move in real time.
        if (progressModalId === item.id) renderProgressModal(item);
        if (item.status !== prevStatus) {
          if (item.status === 'completed' && soundOn('complete')) playSound('complete');
          else if (item.status === 'error' && soundOn('error')) playSound('error');
          if (item.status === 'completed' && appConfig.showCompleteDialog !== false) {
            showDownloadCompleteDialog(item);
          }
        }
        checkQueueComplete();
        scheduleTableRender();
      }
    });
  }

  if (window.api && window.api.onDuplicateDetected) {
    window.api.onDuplicateDetected(showDuplicateModal);
  }

  if (window.api && window.api.onQueuesChanged) {
    window.api.onQueuesChanged((queues) => {
      knownQueues = queues || [];
      renderQueueTree();
      renderQueuesModal();
      // Counts and ordering live in the same payload, so the table may need
      // to re-sort when the user is looking at a queue.
      if (currentCategory === 'queue') scheduleTableRender();
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
        scheduleTableRender();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
init();

