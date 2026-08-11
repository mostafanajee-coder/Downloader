'use strict';

const fs = require('fs');
const path = require('path');
const { HlsDownloadTask, listVariants } = require('../core/hlsDownloadTask');

const PLAYLIST = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const DEST = path.join(__dirname, '..', 'downloads', 'test-hls.mp4');

async function main() {
  try {
    fs.unlinkSync(DEST);
  } catch {}

  console.log('--- listing variants ---');
  const variants = await listVariants(PLAYLIST);
  variants.forEach((v, i) => console.log(`  [${i}] ${v.resolution || '?'} ${v.bandwidth || ''}`));

  const task = new HlsDownloadTask({ playlistUrl: PLAYLIST, destPath: DEST, variantIndex: variants.length - 1, concurrency: 8 });

  task.on('variant-selected', (v) => console.log('[variant-selected]', v.resolution, v.bandwidth));
  task.on('start', (info) => console.log('[start] segments =', info.segments, 'encrypted =', info.encrypted));
  task.on('segment-error', (e) => console.log('[segment-error]', e));
  task.on('progress', (p) => process.stdout.write(`\r[progress] ${p.completed}/${p.total} (${p.percent.toFixed(1)}%)   `));
  task.on('remuxing', () => console.log('\n[remuxing] running ffmpeg...'));

  await new Promise((resolve, reject) => {
    task.once('complete', resolve);
    task.once('error', reject);
    task.start().catch(reject);
  });

  const stat = fs.statSync(DEST);
  console.log(`\n[complete] ${DEST} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  if (stat.size < 100000) throw new Error('output file suspiciously small');
  console.log('\n=== HLS TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
