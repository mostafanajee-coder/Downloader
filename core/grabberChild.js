'use strict';

// Runs a Site Grabber crawl in its own OS process — the same split IDM makes
// with its separate IDMGrHlp.exe. A crawl walks arbitrary third-party HTML with
// unbounded regex work and unbounded network waits; in-process, one pathological
// page could stall or kill the whole application.
//
// Speaks a tiny message protocol over whichever transport the parent used:
// Electron's utilityProcess supplies process.parentPort, a plain
// child_process.fork supplies process.send.

const { SiteGrabber } = require('./siteGrabber');

const parentPort = process.parentPort;
const send = parentPort
  ? (msg) => parentPort.postMessage(msg)
  : (msg) => {
      if (process.send) process.send(msg);
    };

let grabber = null;

function startCrawl(options) {
  if (grabber) grabber.cancel();
  const g = new SiteGrabber(options || {});
  grabber = g;

  g.on('page-start', (p) => send({ type: 'page-start', payload: p }));
  g.on('asset-found', (a) => send({ type: 'asset-found', payload: a }));
  g.on('page-error', (e) => send({ type: 'page-error', payload: e }));

  g.crawl()
    .then((assets) => {
      send({ type: 'done', payload: { assets, cancelled: g.cancelled } });
    })
    .catch((err) => {
      send({ type: 'failed', payload: { message: err && err.message ? err.message : String(err) } });
    });
}

function onMessage(msg) {
  if (!msg) return;
  if (msg.type === 'start') startCrawl(msg.options);
  else if (msg.type === 'cancel' && grabber) grabber.cancel();
}

if (parentPort) parentPort.on('message', (event) => onMessage(event.data));
else process.on('message', onMessage);

// The entire point of this process is that its failures are survivable. Report
// them up the pipe and exit, rather than dying silently and leaving the host
// waiting for a 'done' that will never arrive.
process.on('uncaughtException', (err) => {
  send({ type: 'failed', payload: { message: err && err.message ? err.message : String(err) } });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  send({ type: 'failed', payload: { message: err instanceof Error ? err.message : String(err) } });
  process.exit(1);
});

send({ type: 'ready' });
