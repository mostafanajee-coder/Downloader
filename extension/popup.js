'use strict';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');

async function refreshStatus() {
  statusEl.textContent = 'Checking connection…';
  statusEl.className = '';
  const res = await chrome.runtime
    .sendMessage({ type: 'get-media-for-tab' })
    .catch(() => ({ bridgeConnected: false }));
  const connected = Boolean(res && res.bridgeConnected);
  statusEl.textContent = connected ? 'Connected to app ✓' : 'App not running — start it to connect';
  statusEl.className = connected ? 'ok' : 'bad';
}

refreshBtn.addEventListener('click', refreshStatus);
refreshStatus();
