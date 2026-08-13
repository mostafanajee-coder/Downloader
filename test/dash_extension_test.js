'use strict';
// Verifies extension/dashParser.js (a browser/service-worker script, loaded
// here via Node's vm module with a mocked `self`) against real MPD fixtures,
// AND cross-checks its variant order against core/dash.js's parseMpd() on the
// identical manifest. The extension displays variantIndex N; the app's
// core/dashDownloadTask.js later calls selectTracks(parsed, N) from
// core/dash.js. If the two parsers ever disagree on sort order, the user would
// pick "720p" in the browser and silently get 1080p (or vice versa) — this
// test exists specifically to catch that class of bug.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { parseMpd } = require(path.join(ROOT, 'core', 'dash'));

// Load extension/dashParser.js as a classic script into a sandbox with a
// mocked `self`, exactly like a service worker's importScripts() context.
const src = fs.readFileSync(path.join(ROOT, 'extension', 'dashParser.js'), 'utf8');
const sandbox = { self: {}, URL };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const parseMpdVariants = sandbox.self.parseMpdVariants;

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

check('dashParser.js exposes self.parseMpdVariants', typeof parseMpdVariants === 'function');

// --- Fixture 1: multi-resolution video + separate audio (SegmentTimeline) ---
const mpd1 = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT0H0M10.0S" type="static">
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate timescale="1000" startNumber="1"
     initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s">
     <SegmentTimeline><S t="0" d="2000" r="4"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="v_1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
   <Representation id="v_720" bandwidth="2500000" width="1280" height="720" codecs="avc1.4d401f"/>
   <Representation id="v_480" bandwidth="1000000" width="854" height="480" codecs="avc1.4d401e"/>
   <Representation id="v_360" bandwidth="600000" width="640" height="360" codecs="avc1.4d401e"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <SegmentTemplate timescale="1000" startNumber="1"
     initialization="ainit-$RepresentationID$.mp4" media="aseg-$RepresentationID$-$Number$.m4s">
     <SegmentTimeline><S t="0" d="2000" r="4"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="a0" bandwidth="128000"/>
  </AdaptationSet>
 </Period>
</MPD>`;

const extVariants = parseMpdVariants(mpd1).video;
check('extension: 4 video variants found', extVariants.length === 4, `got ${extVariants.length}`);
check('extension: sorted highest-first (1080p @ idx0)', extVariants[0].height === 1080);
check('extension: idx1 = 720p', extVariants[1].height === 720);
check('extension: idx2 = 480p', extVariants[2].height === 480);
check('extension: idx3 = 360p', extVariants[3].height === 360);
check('extension: width/bandwidth carried through', extVariants[0].width === 1920 && extVariants[0].bandwidth === 4500000);

const engineParsed = parseMpd(mpd1, 'https://cdn.example.com/media/manifest.mpd');
check('engine: same 4 video variants', engineParsed.video.length === 4);

// The critical cross-consistency property: index N in the extension's list
// must be the SAME representation (by id) that core/dash.js would put at
// index N, since that's what selectTracks(parsed, N) picks on the app side.
for (let i = 0; i < 4; i++) {
  check(
    `variantIndex ${i} matches between extension and engine`,
    extVariants[i].height === engineParsed.video[i].height && extVariants[i].bandwidth === engineParsed.video[i].bandwidth,
    `ext=${extVariants[i].height}p/${extVariants[i].bandwidth} engine=${engineParsed.video[i].height}p/${engineParsed.video[i].bandwidth}`
  );
}

// --- Fixture 2: contentType inferred from mimeType (no explicit contentType attr) ---
const mpd2 = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT8S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="i-$RepresentationID$.mp4" media="s-$RepresentationID$-$Number$.m4s"/>
   <Representation id="hd" bandwidth="3000000" width="1920" height="1080"/>
   <Representation id="sd" bandwidth="800000" width="720" height="404"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="ai-$RepresentationID$.mp4" media="as-$RepresentationID$-$Number$.m4s"/>
   <Representation id="aac" bandwidth="96000"/>
  </AdaptationSet>
 </Period>
</MPD>`;

const ext2 = parseMpdVariants(mpd2);
check('mimeType-inferred: 2 video, 1 audio', ext2.video.length === 2 && ext2.audio.length === 1, `video=${ext2.video.length} audio=${ext2.audio.length}`);
check('mimeType-inferred: sorted 1080 then 404', ext2.video[0].height === 1080 && ext2.video[1].height === 404);

// --- Fixture 3: single video-only representation, no audio set ---
const mpd3 = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT5S">
 <Period>
  <AdaptationSet contentType="video">
   <Representation id="only" bandwidth="500000" width="640" height="360" mimeType="video/mp4">
     <SegmentList>
       <Initialization sourceURL="init.mp4"/>
       <SegmentURL media="seg1.m4s"/>
     </SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;
const ext3 = parseMpdVariants(mpd3);
check('single video-only representation parsed', ext3.video.length === 1 && ext3.video[0].height === 360);
check('no audio set -> empty audio array', ext3.audio.length === 0);

// --- Fixture 4: malformed / non-MPD input should throw, not hang ---
let threw = false;
try {
  parseMpdVariants('<not-an-mpd/>');
} catch (e) {
  threw = true;
}
check('malformed manifest throws (caller wraps in try/catch + timeout)', threw);

console.log(`\n${fails === 0 ? 'ALL EXTENSION DASH TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
