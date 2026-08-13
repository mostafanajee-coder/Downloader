'use strict';

// End-to-end pause/resume check against a real server.
//
// NOTE: this hits the real network on purpose. It is manual/integration
// tooling, not part of `npm test` — run it with `npm run test:integration`.
//
// It exercises the CURRENT on-disk architecture, which is worth stating because
// the old version of this script tested one that never shipped:
//
//   * There are no ".partN" files. Every connection writes into ONE
//     preallocated file at its own byte offset, so a paused download is a
//     single sparse-ish file plus a ".ddl.json" sidecar recording each
//     segment's progress.
//   * With a tempDir configured, that file is assembled in a workspace folder
//     keyed by a hash of the destination. Nothing appears at the destination
//     until the download has been verified complete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DownloadTask } = require('../core/DownloadTask');
const { resolveWorkspace } = require('../core/workspace');

const URL_ = 'https://proof.ovh.net/files/100Mb.dat';
const EXPECTED_BYTES = 104857600;

function fmt(n) {
  return n == null ? '?' : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-resume-work-'));
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-resume-dest-'));
  const DEST = path.join(destDir, 'test-resume.dat');

  // Where the bytes will actually be assembled, derived the same way the task
  // derives it — that determinism is what lets a resume find its partial file.
  const workspace = resolveWorkspace({ destPath: DEST, tempDir });
  console.log('[setup] destination :', DEST);
  console.log('[setup] workspace   :', workspace.workDir);

  console.log('\n--- Phase 1: start, then pause after ~8 MB ---');
  const task1 = new DownloadTask({ url: URL_, destPath: DEST, connections: 8, tempDir });

  let paused = false;
  task1.on('progress', (p) => {
    process.stdout.write(`\r[progress] ${(p.percent || 0).toFixed(1)}% ${fmt(p.downloaded)}/${fmt(p.size)}   `);
    if (!paused && p.downloaded > 8 * 1024 * 1024) {
      paused = true;
      task1.pause();
    }
  });

  await new Promise((resolve, reject) => {
    task1.once('paused', resolve);
    task1.once('complete', () => reject(new Error('finished before it could be paused — test inconclusive')));
    task1.once('error', reject);
    task1.start().catch(reject);
  });
  console.log('\n[phase 1] paused.');

  // --- What a paused download should look like on disk ---------------------
  const workFile = workspace.workPath;
  const sidecar = `${workFile}.ddl.json`;

  if (!fs.existsSync(workFile)) throw new Error(`expected the partial file at ${workFile}`);
  if (!fs.existsSync(sidecar)) throw new Error(`expected the sidecar at ${sidecar}`);
  console.log('[verify] partial file and .ddl.json sidecar both present');

  const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  if (!Array.isArray(meta.segments) || meta.segments.length === 0) {
    throw new Error('the sidecar records no segments');
  }
  const recorded = meta.segments.reduce((a, s) => a + s.downloaded, 0);
  console.log(`[verify] sidecar records ${meta.segments.length} segments, ${fmt(recorded)} downloaded`);
  if (recorded <= 0 || recorded >= EXPECTED_BYTES) {
    throw new Error(`expected partial progress, sidecar says ${recorded} bytes`);
  }
  if (meta.segments.some((s) => 'active' in s)) {
    throw new Error('the sidecar persisted a transient `active` flag');
  }

  // The destination must still be untouched — publishing happens only on success.
  const destContents = listDir(destDir);
  if (destContents.length !== 0) {
    throw new Error(`destination should still be empty while paused, found ${JSON.stringify(destContents)}`);
  }
  console.log('[verify] destination is still empty, as it should be mid-download');

  console.log('\n--- Phase 2: fresh DownloadTask (simulates an app restart), resume ---');
  const task2 = new DownloadTask({ url: URL_, destPath: DEST, connections: 8, tempDir });
  let resumed = false;
  task2.on('start', (info) => {
    resumed = info.resumed;
    console.log(`[start] resumed=${info.resumed}`);
  });
  task2.on('progress', (p) => {
    process.stdout.write(`\r[progress] ${(p.percent || 0).toFixed(1)}% ${fmt(p.downloaded)}/${fmt(p.size)}   `);
  });

  await new Promise((resolve, reject) => {
    task2.once('complete', resolve);
    task2.once('error', reject);
    task2.start().catch(reject);
  });
  console.log('\n[phase 2] completed.');

  if (!resumed) throw new Error('expected the second task to report resumed=true');

  // --- What a finished download should look like ---------------------------
  const finalSize = fs.statSync(DEST).size;
  console.log('[verify] final file size:', fmt(finalSize), `(${finalSize} bytes)`);
  if (finalSize !== EXPECTED_BYTES) throw new Error(`expected ${EXPECTED_BYTES} bytes, got ${finalSize}`);

  if (fs.existsSync(workspace.workDir)) {
    throw new Error(`the workspace ${workspace.workDir} should have been torn down`);
  }
  console.log('[verify] workspace cleaned up');

  const leftovers = listDir(destDir).filter((f) => f !== path.basename(DEST));
  if (leftovers.length !== 0) throw new Error(`unexpected leftovers beside the file: ${JSON.stringify(leftovers)}`);
  console.log('[verify] no sidecar or scratch files beside the finished download');

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });
  console.log('\n=== ALL CHECKS PASSED ===');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
