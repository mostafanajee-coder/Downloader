'use strict';
// Export / import of the download list, round-tripped through a real Manager.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Manager } = require(path.join(ROOT, 'core', 'Manager'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'exim-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);

function fakeConfig(v = {}) {
  const store = { destDirs: { General: path.join(TMP, 'dl') }, duplicateAction: 'allow', ...v };
  return { get: (k) => store[k], set: (k, x) => { store[k] = x; }, getAll: () => store };
}
let seq = 0;
function makeManager(cfg) {
  const stateDir = path.join(TMP, `st${seq++}`);
  fs.mkdirSync(stateDir, { recursive: true });
  return new Manager({ stateDir, config: fakeConfig(cfg) });
}

(() => {
  section('export shape');
  const src = makeManager();
  const night = src.createQueue('Overnight', 2);
  src.add({ url: 'https://ex.test/a.zip', startNow: false, headers: { Cookie: 'sid=1', Referer: 'https://ex.test/' } });
  src.add({ url: 'https://ex.test/b.mp4', startNow: false, queueId: night, kind: 'file' });
  src.add({ url: 'https://ex.test/live/master.m3u8', startNow: false, kind: 'hls', suggestedFilename: 'show', variantIndex: 2 });
  const data = src.exportList();
  check('has a format marker and version', data.format === 'downloader-list' && data.version === 1);
  check('exports every item', data.items.length === 3, data.items.length);
  check('exports custom queues by name', data.queues.some((q) => q.name === 'Overnight' && q.maxConcurrent === 2));
  check('captured headers travel with the item', data.items[0].headers.Cookie === 'sid=1');
  check('stream kind and variant survive', data.items[2].kind === 'hls' && data.items[2].variantIndex === 2);
  check('the export is plain JSON', JSON.parse(JSON.stringify(data)).items.length === 3);
  src.db.close();

  section('import round-trip into a fresh Manager');
  const dst = makeManager();
  const result = dst.importList(JSON.parse(JSON.stringify(data)));
  check('all items imported', result.added === 3 && result.skipped === 0, result);
  const items = Array.from(dst.items.values());
  check('imported items are ON HOLD, not started', items.every((i) => i.status === 'held'), items.map((i) => i.status));
  check('headers restored', items.find((i) => i.url.endsWith('a.zip')).headers.Cookie === 'sid=1');
  const q = dst.listQueues().find((x) => x.name === 'Overnight');
  check('the custom queue was recreated', Boolean(q) && q.maxConcurrent === 2, q);
  check('and the item was placed in it', items.find((i) => i.url.endsWith('b.mp4')).queueId === q.id);
  check('items without a custom queue land in main', items.find((i) => i.url.endsWith('a.zip')).queueId === 'main');
  check('stream metadata restored', (() => { const s = items.find((i) => i.kind === 'hls'); return s && s.variantIndex === 2 && s.suggestedFilename === 'show'; })());

  section('robustness');
  const r2 = dst.importList({ items: [{ url: 'javascript:alert(1)' }, { url: 'not a url' }, { url: 'https://ok.test/f.bin' }, null] });
  check('non-http URLs and junk entries are skipped, valid ones added', r2.added === 1 && r2.skipped === 3, r2);
  let threw = null;
  try { dst.importList({ nope: true }); } catch (e) { threw = e.message; }
  check('a file that is not a list is rejected clearly', /Not a download list/.test(threw || ''), threw);
  const plain = dst.importList({ items: 'https://a.test/x.bin\nhttps://a.test/y.bin'.split('\n').map((url) => ({ url })) });
  check('a plain URL-per-line list (IDM .txt import) works', plain.added === 2, plain);
  dst.db.close();

  console.log(`\n${fails === 0 ? 'ALL EXPORT/IMPORT TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})();
