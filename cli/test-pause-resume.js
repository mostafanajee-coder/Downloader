'use strict';

const fs = require('fs');
const path = require('path');
const { DownloadTask } = require('../core/DownloadTask');

const URL_ = 'https://proof.ovh.net/files/100Mb.dat';
const DEST = path.join(__dirname, '..', 'downloads', 'test-resume.dat');

function fmt(n) {
  return n == null ? '?' : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  for (const f of [DEST, `${DEST}.ddl.json`, ...Array.from({ length: 8 }, (_, i) => `${DEST}.part${i}`)]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }

  console.log('--- Phase 1: start download, pause programmatically after ~5s of progress ---');
  const task1 = new DownloadTask({ url: URL_, destPath: DEST, connections: 8 });

  let paused = false;
  task1.on('progress', (p) => {
    process.stdout.write(`\r[progress] ${p.percent.toFixed(1)}% ${fmt(p.downloaded)}/${fmt(p.size)}   `);
    if (!paused && p.downloaded > 8 * 1024 * 1024) {
      paused = true;
      task1.pause();
    }
  });

  await new Promise((resolve, reject) => {
    task1.once('paused', resolve);
    task1.once('complete', () => reject(new Error('Task completed before pause could trigger - test inconclusive')));
    task1.once('error', reject);
    task1.start().catch(reject);
  });

  console.log('\n[phase 1 done] task paused.');
  const partSizes = fs
    .readdirSync(path.dirname(DEST))
    .filter((f) => f.startsWith(path.basename(DEST) + '.part'))
    .map((f) => fs.statSync(path.join(path.dirname(DEST), f)).size);
  console.log('part file sizes:', partSizes.map((s) => fmt(s)).join(', '));
  const metaExists = fs.existsSync(`${DEST}.ddl.json`);
  console.log('meta file exists:', metaExists);
  if (!metaExists || partSizes.length === 0) {
    throw new Error('Expected partial part files and meta after pause');
  }

  console.log('\n--- Phase 2: fresh DownloadTask instance (simulates app restart), resume ---');
  const task2 = new DownloadTask({ url: URL_, destPath: DEST, connections: 8 });
  let resumed = false;
  task2.on('start', (info) => {
    resumed = info.resumed;
    console.log(`[start] resumed=${info.resumed}`);
  });
  task2.on('progress', (p) => {
    process.stdout.write(`\r[progress] ${p.percent.toFixed(1)}% ${fmt(p.downloaded)}/${fmt(p.size)}   `);
  });

  await new Promise((resolve, reject) => {
    task2.once('complete', resolve);
    task2.once('error', reject);
    task2.start().catch(reject);
  });

  console.log('\n[phase 2 done] download completed.');
  if (!resumed) throw new Error('Expected task2 to report resumed=true');

  const finalSize = fs.statSync(DEST).size;
  console.log('final file size:', fmt(finalSize), `(${finalSize} bytes)`);
  if (finalSize !== 104857600) {
    throw new Error(`Expected final size 104857600, got ${finalSize}`);
  }

  const leftovers = fs
    .readdirSync(path.dirname(DEST))
    .filter((f) => f.startsWith(path.basename(DEST)) && f !== path.basename(DEST));
  console.log('leftover temp files:', leftovers.length === 0 ? 'none - clean' : leftovers);
  if (leftovers.length !== 0) throw new Error('Expected no leftover part/meta files after completion');

  console.log('\n=== ALL CHECKS PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
