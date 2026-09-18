'use strict';
// DRM and live-stream guards: the parsers must flag them, the tasks must refuse
// them with a clear message BEFORE downloading anything, and ordinary
// AES-128 / VOD streams must be untouched.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { parseMediaPlaylist, resolvePlaylist } = require(path.join(ROOT, 'core', 'hls'));
const { parseMpd } = require(path.join(ROOT, 'core', 'dash'));
const { HlsDownloadTask } = require(path.join(ROOT, 'core', 'hlsDownloadTask'));
const { DashDownloadTask } = require(path.join(ROOT, 'core', 'dashDownloadTask'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'));
let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);

const VOD = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
const LIVE = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:120\n#EXTINF:6.0,\nseg120.ts\n#EXTINF:6.0,\nseg121.ts\n';
const AES = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n';
const FAIRPLAY = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n';
const MPD_OK = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S" type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000" width="640" height="360"><SegmentTemplate media="v-$Number$.m4s" initialization="v-init.mp4" startNumber="1" duration="2" timescale="1"/></Representation></AdaptationSet></Period></MPD>';
const MPD_LIVE = MPD_OK.replace('type="static"', 'type="dynamic"');
const MPD_WIDEVINE = MPD_OK.replace('<Representation', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation');

function listen(routes) {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      const body = routes[req.url.split('?')[0]];
      if (body == null) { r.writeHead(404); r.end(); return; }
      r.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(body)) });
      r.end(body);
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

async function outcome(task) {
  try {
    await task.start();
    return 'complete';
  } catch (e) {
    return 'error:' + e.message;
  }
}

(async () => {
  section('HLS parser flags');
  check('VOD playlist is not live', parseMediaPlaylist(VOD, 'http://x/').live === false);
  check('playlist without ENDLIST is live', parseMediaPlaylist(LIVE, 'http://x/').live === true);
  check('plain AES-128 is encrypted but NOT drm', (() => { const p = parseMediaPlaylist(AES, 'http://x/'); return p.encrypted && !p.drm; })());
  check('SAMPLE-AES / FairPlay is drm', /FairPlay|SAMPLE-AES/.test(parseMediaPlaylist(FAIRPLAY, 'http://x/').drm || ''), parseMediaPlaylist(FAIRPLAY, 'http://x/').drm);

  section('DASH parser flags');
  check('static MPD is not live and not drm', (() => { const p = parseMpd(MPD_OK, 'http://x/m.mpd'); return !p.live && !p.drm; })());
  check('dynamic MPD is live', parseMpd(MPD_LIVE, 'http://x/m.mpd').live === true);
  const wv = parseMpd(MPD_WIDEVINE, 'http://x/m.mpd');
  check('ContentProtection is drm, with the system named', wv.drm && /Widevine/.test(wv.drm), wv.drm);
  check('CENC signalling is listed alongside', Array.isArray(wv.drmSystems) && wv.drmSystems.includes('CENC') && wv.drmSystems.includes('Widevine'), wv.drmSystems);

  section('tasks refuse DRM / live before touching the network for segments');
  {
    const { server, port } = await listen({ '/live.m3u8': LIVE, '/fp.m3u8': FAIRPLAY, '/ok.m3u8': VOD, '/live.mpd': MPD_LIVE, '/wv.mpd': MPD_WIDEVINE });
    const base = `http://127.0.0.1:${port}`;

    const r1 = await outcome(new HlsDownloadTask({ playlistUrl: `${base}/live.m3u8`, destPath: path.join(TMP, 'live.mp4') }));
    check('HLS live is refused with a clear message', /live stream/i.test(r1), r1);
    const r2 = await outcome(new HlsDownloadTask({ playlistUrl: `${base}/fp.m3u8`, destPath: path.join(TMP, 'fp.mp4') }));
    check('HLS DRM is refused naming the system', /DRM-protected/.test(r2) && /FairPlay|SAMPLE-AES/.test(r2), r2);
    const r3 = await outcome(new DashDownloadTask({ mpdUrl: `${base}/live.mpd`, destPath: path.join(TMP, 'dl.mp4') }));
    check('DASH live is refused', /live/i.test(r3), r3);
    const r4 = await outcome(new DashDownloadTask({ mpdUrl: `${base}/wv.mpd`, destPath: path.join(TMP, 'wv.mp4') }));
    check('DASH Widevine is refused', /DRM-protected/.test(r4) && /Widevine/.test(r4), r4);

    // A VOD stream must get PAST the guards (it will then fail on missing
    // segments in this fixture, which proves the refusal is not blanket).
    const r5 = await outcome(new HlsDownloadTask({ playlistUrl: `${base}/ok.m3u8`, destPath: path.join(TMP, 'ok.mp4'), retries: 0 }));
    check('an ordinary VOD stream is NOT refused by the guards', !/DRM-protected|live stream/i.test(r5), r5);

    check('no destination file was created for a refused stream', !fs.existsSync(path.join(TMP, 'live.mp4')) && !fs.existsSync(path.join(TMP, 'wv.mp4')));

    const resolved = await resolvePlaylist(`${base}/live.m3u8`);
    check('resolvePlaylist surfaces the live flag to callers', resolved.live === true);
    server.close();
  }

  console.log(`\n${fails === 0 ? 'ALL STREAM GUARD TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
