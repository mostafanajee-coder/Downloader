'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { sanitizeFilename } = require('../core/filename');
const { Manager } = require('../core/Manager');

console.log('--- sanitizeFilename unit checks ---');
assert.strictEqual(sanitizeFilename('My Video: Part 1?', 'fallback'), 'My Video Part 1');
assert.strictEqual(sanitizeFilename('  spaced   out  ', 'fallback'), 'spaced out');
assert.strictEqual(sanitizeFilename('', 'fallback'), 'fallback');
assert.strictEqual(sanitizeFilename(null, 'fallback'), 'fallback');
assert.strictEqual(sanitizeFilename('a'.repeat(300), 'fallback').length <= 150, true);
console.log('OK sanitizeFilename');

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-fname-state-'));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-fname-dest-'));
  const manager = new Manager({ stateDir, defaultDestDir: destDir });

  console.log('\n--- HLS download with suggestedFilename ---');
  const hlsId = manager.add({
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    kind: 'hls',
    variantIndex: 4,
    suggestedFilename: 'My Show: Episode 1?',
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 60000);
    manager.on('updated', (item) => {
      if (item.id !== hlsId) return;
      if (item.status === 'completed') {
        clearTimeout(t);
        resolve();
      } else if (item.status === 'error') {
        clearTimeout(t);
        reject(new Error(item.error));
      }
    });
  });

  const hlsFiles = fs.readdirSync(destDir);
  console.log('files in destDir after HLS download:', hlsFiles);
  assert.strictEqual(hlsFiles.includes('My Show Episode 1.mp4'), true, 'expected sanitized HLS filename');
  console.log('OK HLS filename');

  console.log('\n--- plain file download with suggestedFilename ---');
  const fileId = manager.add({
    url: 'https://proof.ovh.net/files/1Mb.dat',
    kind: 'file',
    suggestedFilename: 'My Custom Name',
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 60000);
    manager.on('updated', (item) => {
      if (item.id !== fileId) return;
      if (item.status === 'completed') {
        clearTimeout(t);
        resolve();
      } else if (item.status === 'error') {
        clearTimeout(t);
        reject(new Error(item.error));
      }
    });
  });

  const allFiles = fs.readdirSync(destDir);
  console.log('files in destDir after file download:', allFiles);
  assert.strictEqual(allFiles.includes('My Custom Name.dat'), true, 'expected sanitized filename with preserved extension');
  console.log('OK file filename (extension preserved)');

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });

  console.log('\n=== FILENAME TEST PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
