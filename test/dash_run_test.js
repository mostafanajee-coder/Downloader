'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { DashDownloadTask } = require(path.join(ROOT, 'core', 'dashDownloadTask'));
const { RateLimiter } = require(path.join(ROOT, 'core', 'rateLimiter'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dashrun-'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

const MPD = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT0H0M6.0S" type="static">
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate timescale="1000" startNumber="1" initialization="v-init.mp4" media="v-$Number$.m4s">
     <SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="v0" bandwidth="800000" width="1280" height="720"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio">
   <SegmentTemplate timescale="1000" startNumber="1" initialization="a-init.mp4" media="a-$Number$.m4s">
     <SegmentTimeline><S t="0" d="2000" r="2"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="a0" bandwidth="128000"/>
  </AdaptationSet>
 </Period>
</MPD>`;

const files = {
  '/v-init.mp4': Buffer.from('VINIT|'),
  '/v-1.m4s': Buffer.from('V1|'),
  '/v-2.m4s': Buffer.from('V2|'),
  '/v-3.m4s': Buffer.from('V3|'),
  '/a-init.mp4': Buffer.from('AINIT|'),
  '/a-1.m4s': Buffer.from('A1|'),
  '/a-2.m4s': Buffer.from('A2|'),
  '/a-3.m4s': Buffer.from('A3|'),
};

function startServer(onReq) {
  const server = http.createServer((req, res) => {
    if (onReq) onReq(req.url);
    if (req.url === '/manifest.mpd') {
      res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Content-Length': Buffer.byteLength(MPD) });
      res.end(MPD);
      return;
    }
    const f = files[req.url];
    if (f) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': f.length });
      res.end(f);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function run() {
  const server = await startServer();
  const port = server.address().port;
  const dest = path.join(TMP, 'out.mp4');

  const task = new DashDownloadTask({
    mpdUrl: `http://127.0.0.1:${port}/manifest.mpd`,
    destPath: dest,
    concurrency: 4,
    keepSegments: true, // keep assembled tracks so we can inspect them
    rateLimiter: new RateLimiter(0),
  });

  // Stub the ffmpeg mux: just copy the assembled video track to the destination
  // and remember which tracks were passed.
  let muxVideo = null, muxAudio = null;
  task._remux = async (v, a) => { muxVideo = v; muxAudio = a; fs.copyFileSync(v, dest); };

  let variant = null;
  task.on('variant-selected', (v) => (variant = v));
  await task.start();

  check('variant selected 1280x720 with audio', variant && variant.resolution === '1280x720' && variant.hasAudio === true, JSON.stringify(variant));
  check('completed all 8 jobs', task.completed === 8, `completed=${task.completed}`);
  check('mux received separate video+audio tracks', Boolean(muxVideo) && Boolean(muxAudio));

  const vTrack = fs.readFileSync(muxVideo).toString();
  const aTrack = fs.readFileSync(muxAudio).toString();
  check('video track = init+3 segs in order', vTrack === 'VINIT|V1|V2|V3|', vTrack);
  check('audio track = init+3 segs in order', aTrack === 'AINIT|A1|A2|A3|', aTrack);
  check('downloaded byte counter > 0', task.downloadedBytes > 0, `${task.downloadedBytes} bytes`);

  // --- Resume behavior: pre-create some parts, ensure they are skipped ---
  const dest2 = path.join(TMP, 'out2.mp4');
  const segDir2 = `${dest2}.dash_parts`;
  fs.mkdirSync(segDir2, { recursive: true });
  // Pre-place the video init + first video segment as if already downloaded.
  fs.writeFileSync(path.join(segDir2, 'v_init.m4s'), files['/v-init.mp4']);
  fs.writeFileSync(path.join(segDir2, 'v_000000.m4s'), files['/v-1.m4s']);

  const requested = [];
  const server2 = await startServer((u) => requested.push(u));
  const port2 = server2.address().port;
  const task2 = new DashDownloadTask({
    mpdUrl: `http://127.0.0.1:${port2}/manifest.mpd`,
    destPath: dest2,
    concurrency: 4,
    keepSegments: true,
    rateLimiter: new RateLimiter(0),
  });
  task2._remux = async (v) => { fs.copyFileSync(v, dest2); };
  await task2.start();
  check('resume skipped pre-existing v-init', !requested.includes('/v-init.mp4'));
  check('resume skipped pre-existing v-1', !requested.includes('/v-1.m4s'));
  check('resume still fetched v-2', requested.includes('/v-2.m4s'));
  const vTrack2 = fs.readFileSync(path.join(segDir2, 'v_track.mp4')).toString();
  check('resume assembled correct video track', vTrack2 === 'VINIT|V1|V2|V3|', vTrack2);

  server.close(); server2.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fails === 0 ? 'ALL DASH RUNTIME TESTS PASSED' : fails + ' FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
