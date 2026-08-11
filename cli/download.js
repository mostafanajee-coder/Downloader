'use strict';

const path = require('path');
const { DownloadTask } = require('../core/DownloadTask');

function formatBytes(bytes) {
  if (bytes == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

async function main() {
  const [, , url, destArg, connArg] = process.argv;
  if (!url) {
    console.error('Usage: node cli/download.js <url> [destPath] [connections]');
    process.exit(1);
  }

  const connections = connArg ? Number(connArg) : 8;
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  const destPath = destArg ? path.resolve(destArg) : null;

  const task = new DownloadTask(
    destPath ? { url, destPath, connections } : { url, destDir: downloadsDir, connections }
  );

  task.on('start', (info) => {
    console.log(
      `[start] ${info.filename || '(unknown filename)'} | size=${formatBytes(info.size)} | segments=${info.segments}${
        info.resumed ? ' | resuming previous progress' : ''
      }`
    );
  });

  task.on('progress', (p) => {
    const pct = p.percent != null ? `${p.percent.toFixed(1)}%` : 'n/a';
    process.stdout.write(
      `\r[progress] ${pct} | ${formatBytes(p.downloaded)}/${formatBytes(p.size)} | ${formatBytes(p.speedBytesPerSec)}/s   `
    );
  });

  task.on('segment-error', (e) => {
    console.error(`\n[segment-error] segment ${e.index} attempt ${e.attempt}: ${e.error}`);
  });

  task.on('paused', () => {
    console.log('\n[paused] progress saved, re-run the same command to resume.');
  });

  task.on('cancelled', () => {
    console.log('\n[cancelled]');
  });

  task.on('error', (err) => {
    console.error(`\n[error] ${err.message}`);
    process.exitCode = 1;
  });

  task.on('complete', (info) => {
    console.log(`\n[complete] saved to ${info.destPath} (${formatBytes(info.size)})`);
  });

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, pausing gracefully...');
    task.pause();
  });

  await task.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
