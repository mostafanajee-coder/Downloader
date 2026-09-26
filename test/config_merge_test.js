'use strict';
// core/config.js: saved settings are merged over defaults section by section,
// saves are atomic, and an unreadable file is preserved instead of clobbered.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-merge-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};

const loginItems = [];
const electronStub = {
  app: {
    getPath: (k) => path.join(TMP, `sys-${k}`),
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: (s) => loginItems.push(s),
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return realLoad.apply(this, arguments);
};
const { ConfigManager, mergeWithDefaults } = require(path.join(ROOT, 'core', 'config'));
Module._load = realLoad;

// An old config written before schedule.quota / sounds.queueComplete existed.
const stateDir = path.join(TMP, 'state');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, 'config.json'),
  JSON.stringify({ maxConnections: 16, schedule: { enabled: true, startTime: '02:00' }, sounds: { complete: false }, destDirs: { Video: 'D:\\Movies' } })
);

const cfg = new ConfigManager(stateDir);
const s = cfg.get('schedule');
check('a saved value wins', cfg.get('maxConnections') === 16);
check('a saved nested value wins', s.enabled === true && s.startTime === '02:00');
check('nested defaults missing from the old file are filled in', s.quota && s.quota.mb === 200 && Array.isArray(s.days), s);
check('sibling defaults in a partially saved section survive', cfg.get('sounds').error === true && cfg.get('sounds').complete === false);
check('per-category folders merge instead of replacing the set',
  cfg.get('destDirs').Video === 'D:\\Movies' && Boolean(cfg.get('destDirs').General));
check('arrays are replaced, not merged', JSON.stringify(mergeWithDefaults({ a: [1, 2, 3] }, { a: [9] }).a) === '[9]');

cfg.set('maxConnections', 4);
const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
check('save writes the file', onDisk.maxConnections === 4);
check('no temp file is left behind', !fs.existsSync(path.join(stateDir, 'config.json.tmp')));

// A corrupt file must not be silently replaced with defaults.
const badDir = path.join(TMP, 'bad');
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, 'config.json'), '{"maxConnections": 12, "trunc');
const bad = new ConfigManager(badDir);
check('an unreadable config falls back to defaults', bad.get('maxConnections') === 8);
check('and the unreadable file is kept aside for recovery', fs.readdirSync(badDir).some((f) => f.startsWith('config.json.corrupt-')));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fails === 0 ? 'ALL CONFIG MERGE TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
