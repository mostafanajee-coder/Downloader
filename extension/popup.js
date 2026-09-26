'use strict';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const captureSummaryEl = document.getElementById('capture-summary');

async function refreshStatus() {
  statusEl.textContent = 'Checking connection…';
  statusEl.className = '';
  const res = await chrome.runtime
    .sendMessage({ type: 'get-media-for-tab' })
    .catch(() => ({ bridgeConnected: false }));
  const connected = Boolean(res && res.bridgeConnected);
  statusEl.textContent = connected ? 'Connected to app ✓' : 'App not running — start it to connect';
  statusEl.className = connected ? 'ok' : 'bad';
  // Which downloads will be taken automatically (the app's File Types list).
  if (captureSummaryEl) {
    const summary = connected && res && res.captureSummary;
    captureSummaryEl.textContent = summary || '';
    captureSummaryEl.style.display = summary ? '' : 'none';
  }
}

refreshBtn.addEventListener('click', refreshStatus);
refreshStatus();

ddlInitModeToggle({
  floatingBtnId: 'mode-floating-btn',
  sidepanelBtnId: 'mode-sidepanel-btn',
  sectionId: 'mode-toggle-section',
});

// --- Media detection filters -------------------------------------------------
const minSizeInput = document.getElementById('panel-min-size');
const skipHtmlInput = document.getElementById('skip-html');

async function initPanelFilters() {
  if (!minSizeInput || !skipHtmlInput) return;
  try {
    const cfg = await chrome.storage.sync.get(['panelMinSizeKB', 'skipHtml']);
    minSizeInput.value = Number(cfg.panelMinSizeKB) > 0 ? Number(cfg.panelMinSizeKB) : 0;
    skipHtmlInput.checked = cfg.skipHtml === undefined ? true : Boolean(cfg.skipHtml);
  } catch (e) {
    minSizeInput.value = 0;
    skipHtmlInput.checked = true;
  }

  minSizeInput.addEventListener('change', () => {
    const kb = Math.max(0, parseInt(minSizeInput.value, 10) || 0);
    minSizeInput.value = kb;
    chrome.storage.sync.set({ panelMinSizeKB: kb });
  });
  skipHtmlInput.addEventListener('change', () => {
    chrome.storage.sync.set({ skipHtml: skipHtmlInput.checked });
  });
}

initPanelFilters();

// --- Capture override keys ---------------------------------------------------
// Mirrors IDM's Options → General → Keys, including its checkbox model: each
// action has a master enable plus independent key ticks, so combinations like
// Ctrl+Shift are expressible. Defaults follow a real IDM install — the force
// override ships OFF, with Alt-to-bypass ON.
const DEFAULT_CAPTURE_KEYS = {
  force: { enabled: false, alt: false, ctrl: false, shift: false, ins: true },
  bypass: { enabled: true, alt: true, ctrl: false, shift: false, del: false },
};
const KEY_LABELS = { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift', ins: 'Insert', del: 'Delete' };

const captureUi = {
  force: { enable: document.getElementById('force-enabled'), grid: document.getElementById('force-keys'), summary: document.getElementById('force-summary') },
  bypass: { enable: document.getElementById('bypass-enabled'), grid: document.getElementById('bypass-keys'), summary: document.getElementById('bypass-summary') },
};
const keysWarning = document.getElementById('capture-keys-warning');

function readSpec(which) {
  const ui = captureUi[which];
  const spec = { enabled: ui.enable.checked };
  for (const box of ui.grid.querySelectorAll('input[type=checkbox]')) spec[box.dataset.key] = box.checked;
  return spec;
}

function writeSpec(which, spec) {
  const ui = captureUi[which];
  ui.enable.checked = Boolean(spec.enabled);
  for (const box of ui.grid.querySelectorAll('input[type=checkbox]')) box.checked = Boolean(spec[box.dataset.key]);
}

function describe(spec) {
  const keys = Object.keys(KEY_LABELS).filter((k) => spec[k]).map((k) => KEY_LABELS[k]);
  if (!spec.enabled) return 'Off.';
  if (!keys.length) return 'No keys ticked — inactive until you pick at least one.';
  return `Hold ${keys.join(' + ')} while clicking.`;
}

function refreshCaptureUi() {
  const force = readSpec('force');
  const bypass = readSpec('bypass');
  captureUi.force.summary.textContent = describe(force);
  captureUi.bypass.summary.textContent = describe(bypass);
  captureUi.force.grid.classList.toggle('disabled', !force.enabled);
  captureUi.bypass.grid.classList.toggle('disabled', !bypass.enabled);

  // Identical active combinations are ambiguous; bypass is the one that wins.
  const sig = (s) => Object.keys(KEY_LABELS).filter((k) => s[k]).join('+');
  const clash = force.enabled && bypass.enabled && sig(force) && sig(force) === sig(bypass);
  if (keysWarning) {
    keysWarning.textContent = clash ? 'Both actions use the same combination — bypass wins.' : '';
    keysWarning.style.display = clash ? '' : 'none';
  }
  return { force, bypass };
}

function persistCaptureKeys() {
  const { force, bypass } = refreshCaptureUi();
  chrome.storage.sync.set({ captureKeys: { force, bypass } });
}

async function initCaptureKeys() {
  if (!captureUi.force.enable || !captureUi.bypass.enable) return;
  let keys = DEFAULT_CAPTURE_KEYS;
  try {
    const cfg = await chrome.storage.sync.get(['captureKeys']);
    if (cfg.captureKeys && cfg.captureKeys.force && cfg.captureKeys.bypass) keys = cfg.captureKeys;
  } catch (e) {
    /* fall back to defaults */
  }
  writeSpec('force', keys.force);
  writeSpec('bypass', keys.bypass);
  refreshCaptureUi();

  for (const which of ['force', 'bypass']) {
    captureUi[which].enable.addEventListener('change', persistCaptureKeys);
    for (const box of captureUi[which].grid.querySelectorAll('input[type=checkbox]')) {
      box.addEventListener('change', persistCaptureKeys);
    }
  }
}

initCaptureKeys();
