'use strict';
// Replays realistic YouTube / HLS / DASH player traffic through the REAL
// extension background script and asserts the panel ends up looking like IDM's:
// a short list of distinct qualities, not one row per chunk.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const bgSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
const dashParserSrc = fs.readFileSync(path.join(ROOT, 'extension', 'dashParser.js'), 'utf8');
const exclusionsSrc = fs.readFileSync(path.join(ROOT, 'extension', 'exclusions.js'), 'utf8');

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackground() {
  const listeners = { beforeRequest: [], headersReceived: [], message: [], downloadCreated: [] };
  const mockChrome = {
    downloads: { onCreated: { addListener: (f) => listeners.downloadCreated.push(f) }, cancel: (i, cb) => cb && cb(), erase: () => {}, download: () => {} },
    runtime: {
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onConnect: { addListener: () => {} }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} },
      lastError: null, getURL: (p) => p, id: 'test',
    },
    webRequest: {
      onBeforeRequest: { addListener: (f) => listeners.beforeRequest.push(f) },
      onHeadersReceived: { addListener: (f) => listeners.headersReceived.push(f) },
      onBeforeSendHeaders: { addListener: () => {} },
    },
    tabs: {
      onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
      get: () => Promise.resolve({ title: 'Gintama Episode 233', url: 'https://youtube.com/watch?v=abc' }),
      query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(),
    },
    cookies: { getAll: () => Promise.resolve([]) },
    storage: {
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      sync: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} }, removeAll: (cb) => cb && cb() },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
  };

  const sandbox = {
    chrome: mockChrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    URL, TextDecoder, navigator: { userAgent: 'test' },
    // No network in the test: manifest inspection must degrade, not hang.
    fetch: () => Promise.reject(new Error('offline')),
    importScripts: () => {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.WebSocket = function () {
    this.readyState = 1; this.send = () => {};
    setTimeout(() => { if (this.onopen) this.onopen(); if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'hello-ack' }) }); }, 0);
  };
  sandbox.WebSocket.OPEN = 1;

  vm.createContext(sandbox);
  vm.runInContext(exclusionsSrc, sandbox, { filename: 'exclusions.js' });
  vm.runInContext(dashParserSrc, sandbox, { filename: 'dashParser.js' });
  vm.runInContext(bgSrc, sandbox, { filename: 'background.js' });
  return { sandbox, listeners };
}

const fire = (L, url, extra = {}) =>
  L.beforeRequest.forEach((f) => f({ tabId: 1, type: 'xmlhttprequest', url, ...extra }));

(async () => {
  // ══════════════════════════════════════════════════════════════════════════
  section('YouTube: chunk spam collapses to the parsed formats');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);

    // The player config arrives first, exactly as content.js forwards it.
    const formats = [144, 240, 360, 480, 720, 1080].map((h, i) => ({
      mimeType: 'video/mp4; codecs="avc1"',
      qualityLabel: `${h}p`,
      height: h,
      url: `https://rr3---sn-abc.googlevideo.com/videoplayback?itag=${20 + i}&mime=video%2Fmp4`,
    }));
    listeners.message.forEach((f) =>
      f({ type: 'yt-player-response', data: { streamingData: { adaptiveFormats: formats } } }, { tab: { id: 1, title: 'Gintama Episode 233' } }, () => {})
    );

    // Then the player hammers the network with hundreds of range'd chunks,
    // across several CDN shards, for each itag.
    let chunkCount = 0;
    for (const itag of [20, 21, 22, 23, 24, 25]) {
      for (let i = 0; i < 40; i++) {
        const shard = `rr${(i % 5) + 1}---sn-${['abc', 'xyz', 'q7v'][i % 3]}`;
        fire(listeners, `https://${shard}.googlevideo.com/videoplayback?itag=${itag}&mime=video%2Fmp4&range=${i * 100000}-${(i + 1) * 100000 - 1}&rn=${i}&rbuf=${i * 7}&cpn=abc${i}`);
        chunkCount++;
      }
    }

    const tracked = sandbox.getTabState(1);
    console.log(`  fired ${chunkCount} chunk requests -> tracked ${tracked.manifests.size} stream(s)`);
    check('chunk requests are not tracked individually', tracked.manifests.size === 0, tracked.manifests.size);

    const snap = await sandbox.buildMediaSnapshot(1);
    const labels = snap.items.map((i) => i.label);
    console.log('  panel items:\n' + labels.map((l) => '    - ' + l).join('\n'));
    check('exactly six rows, one per resolution', snap.items.length === 6, snap.items.length);
    for (const q of ['144p', '240p', '360p', '480p', '720p', '1080p']) {
      check(`  ${q} present exactly once`, labels.filter((l) => l.includes(q)).length === 1);
    }
    check('no generic "Captured Video Stream" rows', !labels.some((l) => /Captured Video Stream/i.test(l)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('HLS: .ts segments never appear, the playlist does');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    fire(listeners, 'https://cdn.test/hls/master.m3u8');
    for (let i = 0; i < 120; i++) {
      fire(listeners, `https://cdn.test/hls/720p/media_${String(i).padStart(5, '0')}.ts`);
      fire(listeners, `https://cdn.test/hls/720p/seg-${i}.ts`);
    }
    const tracked = sandbox.getTabState(1);
    const urls = Array.from(tracked.manifests.values());
    console.log(`  fired 240 segments + 1 playlist -> tracked ${urls.length}`);
    check('only the master playlist is tracked', urls.length === 1 && /master\.m3u8/.test(urls[0]), urls);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('DASH: .m4s and init segments are rejected');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    fire(listeners, 'https://cdn.test/dash/manifest.mpd');
    fire(listeners, 'https://cdn.test/dash/init.mp4');
    for (let i = 0; i < 80; i++) fire(listeners, `https://cdn.test/dash/chunk-stream0-${String(i).padStart(5, '0')}.m4s`);
    const urls = Array.from(sandbox.getTabState(1).manifests.values());
    check('only the MPD survives', urls.length === 1 && /\.mpd$/.test(urls[0]), urls);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Genuine files are still captured');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    fire(listeners, 'https://files.test/setup.exe');
    fire(listeners, 'https://files.test/archive.zip');
    fire(listeners, 'https://files.test/movie.mp4');
    const urls = Array.from(sandbox.getTabState(1).manifests.values());
    check('ordinary downloads are unaffected', urls.length === 3, urls);

    // An unambiguous cache-buster collapses onto the file it busts.
    fire(listeners, 'https://files.test/movie.mp4?_=123');
    fire(listeners, 'https://files.test/movie.mp4?_=456');
    check('unambiguous cache-busters collapse', sandbox.getTabState(1).manifests.size === 3,
      sandbox.getTabState(1).manifests.size);

    // An ambiguous param is kept distinct on purpose: ?v=2 may be a genuinely
    // different file, and wrongly merging two files is worse than an extra row.
    fire(listeners, 'https://files.test/clip.mp4?v=1');
    fire(listeners, 'https://files.test/clip.mp4?v=2');
    check('ambiguous version params stay distinct (conservative)',
      sandbox.getTabState(1).manifests.size === 5, sandbox.getTabState(1).manifests.size);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Unbounded growth is capped');
  {
    const { sandbox, listeners } = loadBackground();
    await sleep(20);
    for (let i = 0; i < 500; i++) fire(listeners, `https://spam.test/file${i}.mp4`);
    const size = sandbox.getTabState(1).manifests.size;
    check('per-tab tracking is capped', size <= 60, size);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('Stream keying unit checks');
  {
    const { sandbox } = loadBackground();
    const k = sandbox.streamKeyFor;
    check('CDN shards fold together',
      k('https://rr3---sn-abc.googlevideo.com/videoplayback?itag=22') ===
      k('https://rr7---sn-xyz.googlevideo.com/videoplayback?itag=22'));
    check('different itags stay distinct',
      k('https://rr3---sn-abc.googlevideo.com/videoplayback?itag=22') !==
      k('https://rr3---sn-abc.googlevideo.com/videoplayback?itag=18'));
    check('range/rn/cpn are ignored',
      k('https://a.test/v?itag=22&range=0-99&rn=1&cpn=x') === k('https://a.test/v?itag=22&range=100-199&rn=2&cpn=y'));
    check('numbered path segments fold',
      k('https://a.test/media_00001.ts') === k('https://a.test/media_00002.ts'));
    check('different paths stay distinct', k('https://a.test/a.mp4') !== k('https://a.test/b.mp4'));
  }

  console.log(`\n${fails === 0 ? 'ALL GRABBER DEDUP TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
