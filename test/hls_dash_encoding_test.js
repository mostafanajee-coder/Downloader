'use strict';
// Targeted regression guard for the httpUtils change. The download engine now
// requests `identity` and skips transparent decoding, but the HLS/DASH/crawler
// paths deliberately stay on the DECODING path — they want text, and they do no
// byte arithmetic. If `raw` ever leaked into those callers, a gzipped playlist
// would arrive as binary garbage and every stream download would break.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { resolvePlaylist } = require(path.join(ROOT, 'core', 'hls'));
const { parseMpd } = require(path.join(ROOT, 'core', 'dash'));
const { streamToFile } = require(path.join(ROOT, 'core', 'streamFile'));
const { request } = require(path.join(ROOT, 'core', 'httpUtils'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hlsenc-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e"',
  'low.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f"',
  'high.m3u8',
  '',
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
  '#EXTINF:6.0,',
  'seg0.ts',
  '#EXTINF:6.0,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n');

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT30S" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v0" bandwidth="1200000" width="1280" height="720">
        <SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a0" bandwidth="128000">
        <SegmentTemplate media="a-$Number$.m4s" initialization="a-init.mp4" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const SEGMENT = crypto.randomBytes(96 * 1024);

function listen(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

(async () => {
  // Every text asset is served GZIPPED, which is exactly how a real CDN serves
  // playlists and manifests.
  const { server, port } = await listen((req, res) => {
    const url = req.url.split('?')[0];
    const sendGzipText = (text, type) => {
      const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': String(gz.length) });
      res.end(gz);
    };
    if (url === '/master.m3u8') return sendGzipText(MASTER, 'application/vnd.apple.mpegurl');
    if (url === '/high.m3u8') return sendGzipText(MEDIA, 'application/vnd.apple.mpegurl');
    if (url === '/manifest.mpd') return sendGzipText(MPD, 'application/dash+xml');
    if (url === '/seg0.ts') {
      res.writeHead(200, { 'Content-Length': String(SEGMENT.length) });
      return res.end(SEGMENT);
    }
    res.writeHead(404);
    res.end();
  });
  const base = `http://127.0.0.1:${port}`;

  // --- HLS master playlist over gzip ---------------------------------------
  const master = await resolvePlaylist(`${base}/master.m3u8`);
  check('gzipped HLS master parses', master.type === 'master', master.type);
  check('both variants recovered', master.variants.length === 2, master.variants.map((v) => v.resolution));
  check('variants sorted best-first', master.variants[0].bandwidth === 2400000, master.variants[0].bandwidth);

  // --- HLS media playlist over gzip ----------------------------------------
  const media = await resolvePlaylist(`${base}/high.m3u8`);
  check('gzipped HLS media playlist parses', media.type === 'media', media.type);
  check('segments recovered', media.segments.length === 2, media.segments.length);
  check('AES-128 key survives decoding', media.encrypted === true && media.segments[0].key.method === 'AES-128',
    media.segments[0].key);

  // --- DASH manifest over gzip ---------------------------------------------
  const { res } = await request(`${base}/manifest.mpd`, { method: 'GET' });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const mpdText = Buffer.concat(chunks).toString('utf8');
  check('gzipped MPD arrives as readable XML', mpdText.startsWith('<?xml'), mpdText.slice(0, 24));
  const parsed = parseMpd(mpdText, `${base}/manifest.mpd`);
  check('MPD duration parsed', parsed.durationSec === 30, parsed.durationSec);
  check('video representation parsed', parsed.video.length === 1 && parsed.video[0].height === 720, parsed.video[0]);
  check('audio representation parsed', parsed.audio.length === 1, parsed.audio.length);
  check('segment URLs templated', parsed.video[0].segments.length > 0, parsed.video[0].segments.slice(0, 2));

  // --- Binary media segment via streamFile (the HLS/DASH download path) -----
  const segDest = path.join(TMP, 'seg0.ts');
  await streamToFile(`${base}/seg0.ts`, segDest, {});
  check('streamToFile still writes segments byte-exactly',
    fs.readFileSync(segDest).equals(SEGMENT),
    { onDisk: fs.statSync(segDest).size, want: SEGMENT.length });

  server.close();
  console.log(`\n${fails === 0 ? 'ALL HLS/DASH ENCODING TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
