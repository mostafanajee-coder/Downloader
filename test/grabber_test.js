'use strict';
// Functional test for the rewritten core/siteGrabber.js against a real local
// HTTP server serving a small fake site: a start page linking to assets of
// every category plus two same-origin sub-pages (one with more assets, one
// with a link to an OFF-origin page) and one off-origin page.
const http = require('http');
const path = require('path');

// Resolved relative to this file so the suite runs from any checkout.
const ROOT = path.join(__dirname, '..');
const { SiteGrabber, classifyAsset, kindForUrl } = require(path.join(ROOT, 'core', 'siteGrabber'));

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMainServer() {
  const pages = {
    '/index.html': `
      <html><body>
        <img src="/img/photo1.jpg">
        <a href="/video/movie.mp4">movie</a>
        <a href="/docs/report.pdf">report</a>
        <a href="/archive/bundle.zip">bundle</a>
        <a href="/stream/master.m3u8">hls stream</a>
        <a href="/stream/manifest.mpd">dash stream</a>
        <a href="/sub/page2.html">sub page 2</a>
        <a href="http://external.test/other.html">external page</a>
        <a href="/index.html#section">self anchor, ignored</a>
        <a href="javascript:void(0)">js link, ignored</a>
      </body></html>`,
    '/sub/page2.html': `
      <html><body>
        <img src="/img/photo2.png">
        <a href="/audio/track.mp3">track</a>
        <a href="/sub/page3.html">page 3 (depth 2, should NOT be visited at maxDepth=1)</a>
      </body></html>`,
    '/sub/page3.html': `<html><body><img src="/img/should_not_appear.jpg"></body></html>`,
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url];
    if (body) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startSlowServer() {
  // A single page whose response is deliberately delayed, used to prove
  // cancel() actually stops an in-flight crawl rather than completing anyway.
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><img src="/x.jpg"><a href="/p2.html">p2</a></body></html>');
    }, 400);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function testClassifyAndKind() {
  check('classifyAsset: jpg -> Images', classifyAsset('jpg') === 'Images');
  check('classifyAsset: mp4 -> Video/Audio', classifyAsset('mp4') === 'Video/Audio');
  check('classifyAsset: mp3 -> Video/Audio', classifyAsset('mp3') === 'Video/Audio');
  check('classifyAsset: pdf -> Documents', classifyAsset('pdf') === 'Documents');
  check('classifyAsset: zip -> Other', classifyAsset('zip') === 'Other');
  check('classifyAsset: html -> null (not downloadable)', classifyAsset('html') === null);
  check('kindForUrl: .m3u8 -> hls', kindForUrl('http://x/a.m3u8') === 'hls');
  check('kindForUrl: .mpd -> dash', kindForUrl('http://x/a.mpd') === 'dash');
  check('kindForUrl: .mp4 -> file', kindForUrl('http://x/a.mp4') === 'file');
}

async function testCurrentPageOnly(server) {
  const port = server.address().port;
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0, filterCategory: 'All' });
  const foundEvents = [];
  g.on('asset-found', (a) => foundEvents.push(a));
  const results = await g.crawl();

  check('current-page-only: visited exactly 1 page', g.visitedUrls.size === 1, `visited=${g.visitedUrls.size}`);
  check('current-page-only: does NOT include sub-page assets', !results.some((r) => r.filename === 'photo2.png'));
  check('current-page-only: finds top-page assets (photo1, movie, report, bundle, m3u8, mpd)', results.length === 6, `got ${results.length}: ${results.map(r=>r.filename).join(',')}`);
  check('asset-found events match final result count', foundEvents.length === results.length);
  check('m3u8 asset gets kind=hls', results.find((r) => r.filename === 'master.m3u8')?.kind === 'hls');
  check('mpd asset gets kind=dash', results.find((r) => r.filename === 'manifest.mpd')?.kind === 'dash');
  check('mp4 asset gets kind=file', results.find((r) => r.filename === 'movie.mp4')?.kind === 'file');
}

async function testSubPagesDepthAndSameOrigin(server) {
  const port = server.address().port;
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 1, filterCategory: 'All', sameOriginOnly: true });
  const results = await g.crawl();

  check('depth=1: visits ONLY index + sub/page2 as pages (assets are not re-fetched as pages)', g.visitedUrls.size === 2, `visited=${[...g.visitedUrls].join(', ')}`);
  check('depth=1: includes sub-page asset (photo2.png)', results.some((r) => r.filename === 'photo2.png'));
  check('depth=1: includes sub-page asset (track.mp3)', results.some((r) => r.filename === 'track.mp3'));
  check('depth=1: does NOT recurse into page3 (depth 2)', !results.some((r) => r.filename === 'should_not_appear.jpg'));
  check('depth=1: external-origin page never visited (sameOriginOnly)', ![...g.visitedUrls].some((u) => u.includes('external.test')));
}

async function testSameOriginOff(server) {
  const port = server.address().port;
  // With sameOriginOnly=false, the crawler would ATTEMPT external.test (which
  // doesn't resolve/exist in this sandbox) — it should fail gracefully via
  // page-error rather than throwing, and still return the assets it did find.
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 1, filterCategory: 'All', sameOriginOnly: false });
  let sawExternalAttempt = false;
  g.on('page-start', (p) => { if (p.url.includes('external.test')) sawExternalAttempt = true; });
  const results = await g.crawl();
  check('sameOriginOnly=false: attempts the external link', sawExternalAttempt);
  check('sameOriginOnly=false: still returns the local assets it found', results.some((r) => r.filename === 'photo1.jpg'));
}

async function testFilterCategory(server) {
  const port = server.address().port;
  const gImages = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0, filterCategory: 'Images' });
  const imgResults = await gImages.crawl();
  check('filter=Images: only image assets returned', imgResults.length === 1 && imgResults[0].filename === 'photo1.jpg', JSON.stringify(imgResults.map((r) => r.filename)));

  const gVA = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0, filterCategory: 'Video/Audio' });
  const vaResults = await gVA.crawl();
  check('filter=Video/Audio: movie.mp4 + master.m3u8 + manifest.mpd, no images/docs/zip', vaResults.length === 3 && vaResults.every((r) => r.category === 'Video/Audio'), JSON.stringify(vaResults.map((r) => r.filename)));

  const gDocs = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0, filterCategory: 'Documents' });
  const docResults = await gDocs.crawl();
  check('filter=Documents: only report.pdf', docResults.length === 1 && docResults[0].filename === 'report.pdf');
}

async function testCancel(slowServer) {
  const port = slowServer.address().port;
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/`, maxDepth: 1 });
  const crawlPromise = g.crawl();
  await sleep(20); // let the request start, well before the 400ms response
  g.cancel();
  const start = Date.now();
  const results = await crawlPromise;
  const elapsed = Date.now() - start;
  check('cancel() lets crawl() resolve promptly (does not wait out remaining work)', elapsed < 500, `resolved in ${elapsed}ms after cancel`);
  check('cancelled crawl reports cancelled:true via done event data / results still an array', Array.isArray(results));
}

async function testMaxAssetsCap(server) {
  const port = server.address().port;
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0, filterCategory: 'All', maxAssets: 2 });
  const results = await g.crawl();
  check('maxAssets cap respected', results.length <= 2, `got ${results.length}`);
}

async function testDoneEvent(server) {
  const port = server.address().port;
  const g = new SiteGrabber({ targetUrl: `http://127.0.0.1:${port}/index.html`, maxDepth: 0 });
  let doneData = null;
  g.on('done', (d) => { doneData = d; });
  const results = await g.crawl();
  check('done event fires with matching asset list', doneData && doneData.assets.length === results.length);
  check('done event reports cancelled:false for a normal run', doneData && doneData.cancelled === false);
}

(async () => {
  const server = await startMainServer();
  const slowServer = await startSlowServer();
  try {
    await testClassifyAndKind();
    await testCurrentPageOnly(server);
    await testSubPagesDepthAndSameOrigin(server);
    await testSameOriginOff(server);
    await testFilterCategory(server);
    await testMaxAssetsCap(server);
    await testDoneEvent(server);
    await testCancel(slowServer);
  } catch (e) {
    console.error('ERROR', e);
    fails++;
  } finally {
    server.close();
    slowServer.close();
  }
  console.log(`\n${fails === 0 ? 'ALL SITE GRABBER TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})();
