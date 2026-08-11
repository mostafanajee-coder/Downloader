'use strict';

/**
 * Shared "Floating Button vs Side Panel" mode toggle.
 *
 * Used by BOTH popup.html and sidepanel.html — not just popup.html — because
 * chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}) makes the
 * toolbar-icon click open the side panel INSTEAD of the popup (this is
 * documented Chrome behavior, not a bug to work around): once side-panel
 * mode is active, popup.html becomes unreachable via the icon. The toggle
 * has to live inside the panel too, or a user who switches to side-panel
 * mode would have no way back to floating-button mode.
 *
 * `chrome.storage.sync` holds the preference (small, cross-device, and
 * distinct from the per-tab media cache in chrome.storage.session) — no new
 * permission needed, "storage" is already declared in manifest.json.
 *
 * Call ddlInitModeToggle({ floatingBtnId, sidepanelBtnId, sectionId }) once
 * per page after its DOM is ready.
 */
async function ddlInitModeToggle({ floatingBtnId, sidepanelBtnId, sectionId }) {
  const section = sectionId ? document.getElementById(sectionId) : null;
  const floatingBtn = document.getElementById(floatingBtnId);
  const sidepanelBtn = document.getElementById(sidepanelBtnId);

  // chrome.sidePanel doesn't exist on Firefox (different sidebar_action API
  // entirely) or on Chrome < 114 — feature-detect and hide the whole section
  // rather than show a toggle that can't work.
  const supported = typeof chrome !== 'undefined' && typeof chrome.sidePanel !== 'undefined';
  if (!supported) {
    if (section) section.style.display = 'none';
    return;
  }

  function updateButtons(mode) {
    if (floatingBtn) floatingBtn.classList.toggle('active', mode !== 'sidepanel');
    if (sidepanelBtn) sidepanelBtn.classList.toggle('active', mode === 'sidepanel');
  }

  async function setMode(mode) {
    try {
      await chrome.storage.sync.set({ uiMode: mode });
    } catch (e) {
      console.warn('[ModeToggle] Failed to save uiMode:', e);
      return;
    }
    updateButtons(mode);
    try {
      // No new call to chrome.action.setPopup() needed: manifest.json's
      // default_popup already points at popup.html, and we never override it
      // to '' — setPanelBehavior's own documented precedence over the popup
      // is exactly what makes side-panel mode take effect.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: mode === 'sidepanel' });
    } catch (e) {
      console.warn('[ModeToggle] Failed to set panel behavior:', e);
    }
  }

  if (floatingBtn) floatingBtn.addEventListener('click', () => setMode('floating'));
  if (sidepanelBtn) sidepanelBtn.addEventListener('click', () => setMode('sidepanel'));

  let uiMode = 'floating';
  try {
    const stored = await chrome.storage.sync.get('uiMode');
    uiMode = stored.uiMode || 'floating';
  } catch (e) {}
  updateButtons(uiMode);

  // Keep every open surface (popup + panel, if both happen to be open) in
  // sync if the mode changes from elsewhere.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.uiMode) updateButtons(changes.uiMode.newValue || 'floating');
    });
  } catch (e) {}
}
