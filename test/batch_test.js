'use strict';
const path = require('path');
// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { expandBatchUrl, MAX_EXPANSION } = require(path.join(ROOT, 'core', 'BatchDownloader'));

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

// Backward-compat: existing behavior unchanged for callers with no options.
let r = expandBatchUrl('http://x/video_[1-5].mp4');
check('basic numeric range, no padding', r.length === 5 && r[0] === 'http://x/video_1.mp4' && r[4] === 'http://x/video_5.mp4', JSON.stringify(r));

r = expandBatchUrl('http://x/video_[01-05].mp4');
check('auto-inferred 2-digit padding from bracket', r[0] === 'http://x/video_01.mp4' && r[4] === 'http://x/video_05.mp4', JSON.stringify(r));

r = expandBatchUrl('http://x/video_[5-1].mp4');
check('descending range', r.length === 5 && r[0] === 'http://x/video_5.mp4' && r[4] === 'http://x/video_1.mp4', JSON.stringify(r));

r = expandBatchUrl('http://x/chapter_[a-e].pdf');
check('alpha range unaffected', r.length === 5 && r[0] === 'http://x/chapter_a.pdf' && r[4] === 'http://x/chapter_e.pdf', JSON.stringify(r));

r = expandBatchUrl('http://x/plain.zip');
check('plain URL passthrough (no pattern)', r.length === 1 && r[0] === 'http://x/plain.zip');

// New: inline %0Nd override even when the start number itself isn't padded.
r = expandBatchUrl('http://x/video_[1-3]%03d.mp4');
check('inline %03d overrides padding despite unpadded "1"', r[0] === 'http://x/video_001.mp4' && r[2] === 'http://x/video_003.mp4', JSON.stringify(r));

// New: options.padWidth overrides everything (bracket's own padding AND inline token).
r = expandBatchUrl('http://x/video_[01-03].mp4', { padWidth: 4 });
check('options.padWidth overrides bracket-inferred padding', r[0] === 'http://x/video_0001.mp4', JSON.stringify(r));

r = expandBatchUrl('http://x/video_[1-3]%03d.mp4', { padWidth: 1 });
check('options.padWidth overrides inline %0Nd too (explicit override wins)', r[0] === 'http://x/video_1.mp4', JSON.stringify(r));

r = expandBatchUrl('http://x/video_[1-3].mp4', { padWidth: 0 });
check('padWidth:0 explicitly means no padding (not treated as falsy/ignored)', r[0] === 'http://x/video_1.mp4', JSON.stringify(r));

// New: MAX_EXPANSION safety cap.
r = expandBatchUrl('http://x/video_[1-999999].mp4');
check(`huge range capped at MAX_EXPANSION (${MAX_EXPANSION})`, r.length === MAX_EXPANSION, `got ${r.length}`);
check('cap starts from the beginning of the range', r[0] === 'http://x/video_1.mp4' && r[MAX_EXPANSION - 1] === `http://x/video_${MAX_EXPANSION}.mp4`, JSON.stringify([r[0], r[r.length-1]]));

console.log(`\n${fails === 0 ? 'ALL BATCH DOWNLOADER TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
