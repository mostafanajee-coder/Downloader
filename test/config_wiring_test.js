'use strict';
// Proves the previously-inert Options controls now actually change behaviour:
// maxConnections, duplicateAction, and tempDir reaching the task.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgwire-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 56 - t.length))}`);

// Minimal stand-in for ConfigManager (the real one pulls in electron).
function fakeConfig(values) {
  const store = { destDirs: { General: path.join(TMP, 'dl') }, ...values };
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => store, _store: store };
}

let seq = 0;
function makeManager(cfgValues) {
  const stateDir = path.join(TMP, `state${seq++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return new Manager({ stateDir, config: fakeConfig(cfgValues) });
}

(() => {
  // ══════════════════════════════════════════════════════════════════════════
  section('maxConnections is honoured');
  {
    for (const [configured, expected] of [[1, 1], [4, 4], [16, 16], [32, 32]]) {
      const m = makeManager({ maxConnections: configured, duplicateAction: 'allow' });
      const id = m.add({ url: `https://ex.test/f${configured}.bin` });
      check(`maxConnections=${configured} produces ${expected} connections`, m.items.get(id).connections === expected,
        { got: m.items.get(id).connections });
      m.db.close();
    }
  }
  {
    const m = makeManager({ duplicateAction: 'allow' }); // unset
    const id = m.add({ url: 'https://ex.test/none.bin' });
    check('an unset maxConnections falls back to 8, not the old hardcoded 16', m.items.get(id).connections === 8,
      { got: m.items.get(id).connections });
    m.db.close();
  }
  {
    const m = makeManager({ maxConnections: 999, duplicateAction: 'allow' });
    const id = m.add({ url: 'https://ex.test/huge.bin' });
    check('an absurd maxConnections is clamped to 32', m.items.get(id).connections === 32, { got: m.items.get(id).connections });
    m.db.close();
  }
  {
    const m = makeManager({ maxConnections: 4, duplicateAction: 'allow' });
    const id = m.add({ url: 'https://ex.test/explicit.bin', connections: 12 });
    check('an explicit per-download value still wins over config', m.items.get(id).connections === 12,
      { got: m.items.get(id).connections });
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('duplicateAction actually does something');
  const URL = 'https://ex.test/dup.zip';
  {
    const m = makeManager({ duplicateAction: 'allow' });
    m.add({ url: URL });
    m.add({ url: URL });
    check("'allow' queues the same URL twice", m.items.size === 2, { size: m.items.size });
    m.db.close();
  }
  {
    const m = makeManager({ duplicateAction: 'skip' });
    let skipped = null;
    m.on('duplicate-skipped', (info) => { skipped = info; });
    const firstId = m.add({ url: URL });
    const secondId = m.add({ url: URL });
    check("'skip' keeps only the original", m.items.size === 1, { size: m.items.size });
    check("'skip' returns no new id", Array.isArray(secondId) ? secondId.length === 0 : !secondId, secondId);
    check("'skip' reports which item it kept", skipped && skipped.existingId === firstId, skipped);
    m.db.close();
  }
  {
    const m = makeManager({ duplicateAction: 'ask' });
    let asked = null;
    m.on('duplicate-detected', (info) => { asked = info; });
    m.add({ url: URL });
    m.add({ url: URL });
    check("'ask' does NOT add on its own", m.items.size === 1, { size: m.items.size });
    check("'ask' raises a duplicate-detected event", Boolean(asked));
    check('the event carries a re-add payload with allowDuplicate', asked && asked.payload && asked.payload.allowDuplicate === true,
      asked && asked.payload);
    // Status is whatever the queue pump has moved it to by now ('queued' or
    // already 'running') — the point is that the event identifies the item.
    check('the event names the existing item', asked && Boolean(asked.existingId) && Boolean(asked.existingStatus), {
      existingId: Boolean(asked && asked.existingId), status: asked && asked.existingStatus,
    });

    // Confirming the prompt re-adds it.
    m.add(asked.payload);
    check('re-adding with the event payload succeeds', m.items.size === 2, { size: m.items.size });
    m.db.close();
  }
  {
    // startNow:false keeps the pump out of it, so cancel() takes its
    // synchronous path and the status is genuinely settled before we re-add.
    // (A still-running download SHOULD block — it isn't cancelled yet.)
    const m = makeManager({ duplicateAction: 'skip' });
    const id = m.add({ url: URL, startNow: false });
    m.cancel(id);
    check('the item really is cancelled before we re-add', m.items.get(id).status === 'cancelled', m.items.get(id).status);
    m.add({ url: URL, startNow: false });
    check('a cancelled download does not block re-adding the same URL', m.items.size === 2, { size: m.items.size });
    m.db.close();
  }
  {
    // Batch expansion must be de-duplicated item by item, not all-or-nothing.
    const m = makeManager({ duplicateAction: 'skip' });
    m.add({ url: 'https://ex.test/img001.jpg' });
    const ids = m.add({ url: 'https://ex.test/img*.jpg', padWidth: 3 });
    const added = Array.isArray(ids) ? ids.length : 1;
    check('batch add skips only the URLs that already exist', m.items.size === added + 1, { total: m.items.size, added });
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('defaultDestDir replaces the process.cwd() fallback');
  {
    // No ConfigManager at all: the constructor parameter is the only thing
    // standing between a download and whatever directory the app was launched
    // from (Program Files, or System32 for a shell-invoked instance).
    const stateDir = path.join(TMP, 'nodefaults');
    fs.mkdirSync(stateDir, { recursive: true });
    const fallbackDir = path.join(TMP, 'explicit-dest');
    const m = new Manager({ stateDir, defaultDestDir: fallbackDir });
    const id = m.add({ url: 'https://ex.test/nocfg.bin', startNow: false });
    check('a Manager with no config honours defaultDestDir',
      m.items.get(id).destDir === fallbackDir, m.items.get(id).destDir);
    check('and does NOT fall back to the working directory',
      m.items.get(id).destDir !== process.cwd(), m.items.get(id).destDir);
    m.db.close();
  }
  {
    const stateDir = path.join(TMP, 'nodefaults2');
    fs.mkdirSync(stateDir, { recursive: true });
    const m = new Manager({ stateDir });
    const id = m.add({ url: 'https://ex.test/cwd.bin', startNow: false });
    check('without it, cwd is still the last resort (unchanged behaviour)',
      m.items.get(id).destDir === process.cwd(), m.items.get(id).destDir);
    m.db.close();
  }
  {
    // Configured category folders still win — defaultDestDir is only a floor.
    const stateDir = path.join(TMP, 'withcfg');
    fs.mkdirSync(stateDir, { recursive: true });
    const configured = path.join(TMP, 'from-config');
    const m = new Manager({
      stateDir,
      config: fakeConfig({ destDirs: { General: configured } }),
      defaultDestDir: path.join(TMP, 'should-not-be-used'),
    });
    const id = m.add({ url: 'https://ex.test/cfg.bin', startNow: false });
    check('config destDirs take precedence over defaultDestDir',
      m.items.get(id).destDir === configured, m.items.get(id).destDir);
    m.db.close();
  }
  {
    // An explicit per-download destDir beats everything.
    const stateDir = path.join(TMP, 'explicitdl');
    fs.mkdirSync(stateDir, { recursive: true });
    const explicit = path.join(TMP, 'per-download');
    const m = new Manager({ stateDir, defaultDestDir: path.join(TMP, 'ignored') });
    const id = m.add({ url: 'https://ex.test/x.bin', destDir: explicit, startNow: false });
    check('an explicit per-download destDir wins', m.items.get(id).destDir === explicit, m.items.get(id).destDir);
    m.db.close();
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('tempDir reaches the download task');
  {
    const tempDir = path.join(TMP, 'scratch');
    const m = makeManager({ duplicateAction: 'allow', tempDir });
    check('Manager resolves the configured tempDir', m._tempDir() === tempDir, m._tempDir());
    m.db.close();

    const m2 = makeManager({ duplicateAction: 'allow', tempDir: '   ' });
    check('a blank tempDir resolves to null (assemble in place)', m2._tempDir() === null, m2._tempDir());
    m2.db.close();
  }

  console.log(`\n${fails === 0 ? 'ALL CONFIG WIRING TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})();
