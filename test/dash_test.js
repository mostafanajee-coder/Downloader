'use strict';
const path = require('path');
// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { parseMpd, selectTracks, parseDuration } = require(path.join(ROOT, 'core', 'dash'));

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fails++;
}

// 1) SegmentTimeline with @r repeats + padded $Number$ + separate audio set
const timelineMpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT0H0M10.0S" type="static">
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate timescale="1000" startNumber="1"
     initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number%05d$.m4s">
     <SegmentTimeline>
       <S t="0" d="2000" r="2"/>
       <S d="1000"/>
     </SegmentTimeline>
   </SegmentTemplate>
   <Representation id="v0" bandwidth="800000" width="1280" height="720"/>
   <Representation id="v1" bandwidth="400000" width="640" height="360"/>
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

let p = parseMpd(timelineMpd, 'https://cdn.example.com/media/manifest.mpd');
check('timeline: 2 video reps', p.video.length === 2);
check('timeline: video sorted (720p first)', p.video[0].height === 720);
check('timeline: 1 audio rep', p.audio.length === 1);
const t = selectTracks(p, 0);
// Timeline: S t=0 d=2000 r=2 => 3 segs (numbers 1,2,3), then S d=1000 => 1 seg (number 4). Total 4.
check('timeline: 4 video segments', t.video.segments.length === 4, `got ${t.video.segments.length}`);
check('timeline: init url resolved', t.video.initUrl === 'https://cdn.example.com/media/init-v0.mp4', t.video.initUrl);
check('timeline: padded number in url', t.video.segments[0].url === 'https://cdn.example.com/media/seg-v0-00001.m4s', t.video.segments[0].url);
check('timeline: 4th seg number 00004', t.video.segments[3].url.endsWith('seg-v0-00004.m4s'), t.video.segments[3].url);
check('timeline: audio 5 segments', t.audio.segments.length === 5, `got ${t.audio.segments.length}`);

// 2) SegmentTemplate duration/number (no timeline)
const durMpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT10S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
     initialization="i-$RepresentationID$.mp4" media="s-$RepresentationID$-$Number$.m4s"/>
   <Representation id="V" bandwidth="1000000" width="1920" height="1080"/>
  </AdaptationSet>
 </Period>
</MPD>`;
p = parseMpd(durMpd, 'https://x.test/a/b/mpd.mpd');
const t2 = selectTracks(p);
// 10s / 4s = ceil(2.5) = 3 segments
check('duration: 3 segments (ceil 10/4)', t2.video.segments.length === 3, `got ${t2.video.segments.length}`);
check('duration: number url', t2.video.segments[2].url === 'https://x.test/a/b/s-V-3.m4s', t2.video.segments[2].url);

// 3) SegmentList
const listMpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT6S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="R" bandwidth="500000" width="854" height="480">
     <SegmentList>
       <Initialization sourceURL="init.mp4"/>
       <SegmentURL media="seg1.m4s"/>
       <SegmentURL media="seg2.m4s"/>
     </SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;
p = parseMpd(listMpd, 'https://host.tld/vid/play.mpd');
const t3 = selectTracks(p);
check('list: 2 segments', t3.video.segments.length === 2, `got ${t3.video.segments.length}`);
check('list: init resolved', t3.video.initUrl === 'https://host.tld/vid/init.mp4', t3.video.initUrl);
check('list: seg resolved', t3.video.segments[1].url === 'https://host.tld/vid/seg2.m4s', t3.video.segments[1].url);

// 4) Single-file on-demand with cumulative BaseURL
const singleMpd = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT30S">
 <BaseURL>https://dl.example.net/root/</BaseURL>
 <Period>
  <BaseURL>period/</BaseURL>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="hd" bandwidth="2000000" width="1920" height="1080">
     <BaseURL>video-1080.mp4</BaseURL>
     <SegmentBase indexRange="0-800"><Initialization range="0-800"/></SegmentBase>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;
p = parseMpd(singleMpd, 'https://ignored.example/manifest.mpd');
const t4 = selectTracks(p);
check('single: isSingleFile', t4.video.isSingleFile === true);
check('single: cumulative BaseURL', t4.video.url === 'https://dl.example.net/root/period/video-1080.mp4', t4.video.url);

// 5) ISO duration parse spot checks
check('dur PT1H2M3.5S', Math.abs(parseDuration('PT1H2M3.5S') - 3723.5) < 1e-6);
check('dur PT45S', parseDuration('PT45S') === 45);

console.log(`\n${fails === 0 ? 'ALL DASH TESTS PASSED' : fails + ' DASH TEST(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
