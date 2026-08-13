'use strict';

// Runs every suite in this directory as its own process and reports a summary.
//
// Separate processes on purpose: several suites bind sockets, install global
// process handlers, stub `fs` methods, or drive the shared HTTP client's proxy
// configuration. Sharing one process would let them leak into each other and
// produce failures that depend on ordering.
//
// Network-dependent integration scripts live in cli/ and are NOT run here —
// see `npm run test:integration`.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const PER_SUITE_TIMEOUT_MS = 5 * 60 * 1000;

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

const suites = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('_test.js'))
  .filter((f) => (only.length ? only.some((o) => f.includes(o)) : true))
  .sort();

if (!suites.length) {
  console.error(only.length ? `No suites matched: ${only.join(', ')}` : 'No suites found.');
  process.exit(1);
}

function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, file)], {
      cwd: path.join(DIR, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[runner] killed after ${PER_SUITE_TIMEOUT_MS / 1000}s`;
    }, PER_SUITE_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ file, code, output, ms: Date.now() - started });
    });
  });
}

(async () => {
  console.log(`Running ${suites.length} suite(s)\n`);
  const results = [];

  for (const file of suites) {
    process.stdout.write(`  ${file.padEnd(28)}`);
    const r = await runSuite(file);
    results.push(r);

    const skipped = (r.output.match(/^SKIP /gm) || []).length;
    const passed = (r.output.match(/^PASS /gm) || []).length;
    const failed = (r.output.match(/^FAIL /gm) || []).length;
    const detail = [
      passed ? `${passed} passed` : null,
      failed ? `${failed} failed` : null,
      skipped ? `${skipped} skipped` : null,
    ].filter(Boolean).join(', ') || 'no assertions reported';

    console.log(`${r.code === 0 ? 'OK  ' : 'FAIL'}  ${String(r.ms + 'ms').padStart(7)}  ${detail}`);
    if (verbose || r.code !== 0) {
      const lines = r.output.split('\n');
      const interesting = r.code === 0 ? lines : lines.filter((l) => /^(FAIL|ERROR|\s+at )/.test(l) || l.includes('Error'));
      console.log(interesting.slice(0, verbose ? lines.length : 25).map((l) => '      ' + l).join('\n'));
    }
  }

  const failedSuites = results.filter((r) => r.code !== 0);
  const totalAssertions = results.reduce((a, r) => a + (r.output.match(/^PASS /gm) || []).length, 0);
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  console.log(
    `\n${results.length - failedSuites.length}/${results.length} suites passed ` +
    `(${totalAssertions} assertions, ${(totalMs / 1000).toFixed(1)}s)`
  );
  if (failedSuites.length) {
    console.log('Failed: ' + failedSuites.map((r) => r.file).join(', '));
    process.exit(1);
  }
})();
