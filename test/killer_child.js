'use strict';
// Runs a real DownloadTask and prints READY once bytes are flowing, so the
// parent can SIGKILL it mid-transfer. Deliberately does no cleanup — the whole
// point is an abrupt, unhandled death.
const path = require('path');
const { DownloadTask } = require(path.join(__dirname, '..', 'core', 'DownloadTask'));

const [, , url, destPath, connections] = process.argv;
const task = new DownloadTask({ url, destPath, connections: Number(connections) || 4 });

let announced = false;
task.on('progress', (p) => {
  if (!announced && p.downloaded > 0) {
    announced = true;
    process.stdout.write('READY\n');
  }
});
task.on('error', (e) => process.stdout.write('ERR ' + e.message + '\n'));
task.on('complete', () => process.stdout.write('DONE\n'));
task.start().catch((e) => process.stdout.write('THROW ' + e.message + '\n'));
