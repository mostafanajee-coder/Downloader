'use strict';
// Verifies the approved decisions from the architecture review:
//  1. Firefox / old-Chrome (no chrome.sidePanel) -> toggle section hidden entirely.
//  2. Chrome/Edge/Brave (chrome.sidePanel present) -> toggle works, persists to
//     chrome.storage.sync, and calls setPanelBehavior with the right flag.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'modeToggle.js'), 'utf8');

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

function makeEl() {
  return {
    style: {},
    classList: {
      _set: new Set(),
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    _listeners: [],
    addEventListener(type, fn) { this._listeners.push(fn); },
    click() { this._listeners.forEach((fn) => fn()); },
  };
}

function runToggleTest({ sidePanelSupported, storedMode }) {
  const section = makeEl();
  const floatingBtn = makeEl();
  const sidepanelBtn = makeEl();
  const elements = { section, 'mode-floating-btn': floatingBtn, 'mode-sidepanel-btn': sidepanelBtn };

  let storedSync = { uiMode: storedMode };
  const setPanelBehaviorCalls = [];
  const mockChrome = {
    storage: {
      sync: {
        get: (k) => Promise.resolve({ uiMode: storedSync.uiMode }),
        set: (obj) => { Object.assign(storedSync, obj); return Promise.resolve(); },
      },
      onChanged: { addListener: () => {} },
    },
  };
  if (sidePanelSupported) {
    mockChrome.sidePanel = {
      setPanelBehavior: (opts) => { setPanelBehaviorCalls.push(opts); return Promise.resolve(); },
    };
  }

  const sandbox = {
    chrome: mockChrome,
    document: { getElementById: (id) => (id === 'mode-toggle-section' ? section : elements[id] || null) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'modeToggle.js' });

  return { sandbox, section, floatingBtn, sidepanelBtn, storedSync, setPanelBehaviorCalls };
}

(async () => {
  // --- Firefox / old Chrome: chrome.sidePanel is undefined ----------------
  {
    const { sandbox, section } = runToggleTest({ sidePanelSupported: false, storedMode: 'floating' });
    await sandbox.ddlInitModeToggle({ floatingBtnId: 'mode-floating-btn', sidepanelBtnId: 'mode-sidepanel-btn', sectionId: 'mode-toggle-section' });
    check('Firefox/unsupported: section is hidden entirely', section.style.display === 'none');
  }

  // --- Chrome/Edge/Brave: chrome.sidePanel present, default floating mode ---
  {
    const { sandbox, section, floatingBtn, sidepanelBtn, storedSync, setPanelBehaviorCalls } = runToggleTest({ sidePanelSupported: true, storedMode: undefined });
    await sandbox.ddlInitModeToggle({ floatingBtnId: 'mode-floating-btn', sidepanelBtnId: 'mode-sidepanel-btn', sectionId: 'mode-toggle-section' });
    check('supported: section is NOT hidden', section.style.display !== 'none');
    check('supported: defaults to floating when no stored preference', floatingBtn.classList.contains('active') && !sidepanelBtn.classList.contains('active'));

    sidepanelBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    check('clicking Side Panel persists uiMode to chrome.storage.sync', storedSync.uiMode === 'sidepanel');
    check('clicking Side Panel calls setPanelBehavior(openPanelOnActionClick: true)', setPanelBehaviorCalls.some((c) => c.openPanelOnActionClick === true));
    check('active class moves to the Side Panel button', sidepanelBtn.classList.contains('active') && !floatingBtn.classList.contains('active'));

    floatingBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    check('clicking Floating Button reverts uiMode', storedSync.uiMode === 'floating');
    check('clicking Floating Button calls setPanelBehavior(openPanelOnActionClick: false)', setPanelBehaviorCalls.some((c) => c.openPanelOnActionClick === false));
  }

  console.log(`\n${fails === 0 ? 'ALL MODE TOGGLE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
