'use strict';

const vm = require('vm');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;

/**
 * Proxy Auto-Config support.
 *
 * A PAC file is a JavaScript program exposing FindProxyForURL(url, host), whose
 * return value is a string like "PROXY p1:8080; SOCKS5 p2:1080; DIRECT". IDM
 * ships Microsoft's own JScript PAC engine (oldjsproxy.dll) for this and caches
 * fetched scripts on disk; this is the same contract, evaluated in a vm context.
 *
 * The awkward part is that FindProxyForURL is synchronous while every useful
 * DNS helper is asynchronous in Node. The target host is therefore resolved
 * *before* evaluation and handed to the sandbox pre-computed — which covers
 * dnsResolve/isResolvable/isInNet for the host being requested, by far the
 * dominant use. Lookups for unrelated hosts return null rather than blocking.
 *
 * ISOLATION. A PAC file is code from the network — often fetched over plain
 * http, so anyone on the path can rewrite it. The context must therefore hold
 * nothing from the main process's realm: the old sandbox passed in host-realm
 * helper functions, and `dnsResolve.constructor("return process")()` walked
 * straight out to Node's `process` (and from there to child_process). Now every
 * helper is compiled INSIDE the context from source, the context's global
 * object has a null prototype, and only primitives (strings, numbers) cross the
 * boundary in either direction. A vm context still isn't a hard security
 * boundary, but it no longer hands out the keys.
 */

function myIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/** Converts a shell glob (`*`, `?`) to an anchored regular expression. */
function shExpToRegExp(shexp) {
  const escaped = String(shexp).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

// --- The PAC standard library, as it runs inside the context -----------------
// These are ordinary functions so they can be read and linted here, but they
// are never called in this realm: their SOURCE is compiled into each context.
// They may only use builtins and the __-prefixed context globals.

/* eslint-disable no-undef */
const PAC_LIBRARY = [
  function __isIPv4(s) {
    return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s));
  },
  function __isIP(s) {
    return __isIPv4(s) || (String(s).indexOf(':') !== -1 && /^[0-9a-fA-F:.]+$/.test(String(s)));
  },
  function __shToRe(s) {
    var escaped = String(s).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  },
  function __ipToLong(ip) {
    if (!__isIPv4(ip)) return null;
    var parts = String(ip).split('.');
    var n = 0;
    for (var i = 0; i < 4; i++) n = n * 256 + Number(parts[i]);
    return n;
  },
  function isPlainHostName(host) {
    return String(host).indexOf('.') === -1;
  },
  function dnsDomainIs(host, domain) {
    host = String(host);
    domain = String(domain);
    return host.length >= domain.length && host.slice(host.length - domain.length) === domain;
  },
  function localHostOrDomainIs(host, hostdom) {
    return host === hostdom || String(hostdom).lastIndexOf(String(host) + '.', 0) === 0;
  },
  function dnsResolve(host) {
    if (__isIP(host)) return String(host);
    // Only the request's own host is pre-resolved; anything else would need a
    // blocking lookup inside a synchronous function.
    return String(host) === __host ? __ip : null;
  },
  function isResolvable(host) {
    return dnsResolve(host) !== null;
  },
  function myIpAddress() {
    return __myIp;
  },
  function dnsDomainLevels(host) {
    return (String(host).match(/\./g) || []).length;
  },
  function shExpMatch(str, shexp) {
    return __shToRe(shexp).test(String(str));
  },
  function isInNet(hostOrIp, pattern, mask) {
    var ip = __isIP(hostOrIp) ? String(hostOrIp) : dnsResolve(hostOrIp);
    var a = __ipToLong(ip);
    var b = __ipToLong(pattern);
    var m = __ipToLong(mask);
    if (a === null || b === null || m === null) return false;
    // Unsigned 32-bit AND, done arithmetically to stay clear of sign issues.
    var and = function (x, y) {
      var r = 0;
      var bit = 1;
      for (var i = 0; i < 32; i++) {
        if (x % 2 === 1 && y % 2 === 1) r += bit;
        x = Math.floor(x / 2);
        y = Math.floor(y / 2);
        bit *= 2;
      }
      return r;
    };
    return and(a, m) === and(b, m);
  },
  function weekdayRange(wd1, wd2, gmt) {
    var days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    var useGmt = gmt === 'GMT' || wd2 === 'GMT';
    var now = new Date();
    var today = useGmt ? now.getUTCDay() : now.getDay();
    var start = days.indexOf(String(wd1).toUpperCase());
    if (start === -1) return false;
    var endName = wd2 && wd2 !== 'GMT' ? String(wd2).toUpperCase() : String(wd1).toUpperCase();
    var end = days.indexOf(endName);
    if (end === -1) return false;
    return start <= end ? today >= start && today <= end : today >= start || today <= end;
  },
  function dateRange() {
    // The full PAC dateRange grammar has seven overloads; the day-of-month
    // and month forms are the ones that appear in practice.
    var months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    var args = Array.prototype.slice.call(arguments);
    var now = new Date();
    var nums = args.filter(function (a) { return typeof a === 'number'; });
    var named = args.filter(function (a) { return typeof a === 'string' && months.indexOf(a.toUpperCase()) !== -1; });
    if (named.length) {
      var m = now.getMonth();
      var from = months.indexOf(named[0].toUpperCase());
      var to = named[1] ? months.indexOf(named[1].toUpperCase()) : from;
      return from <= to ? m >= from && m <= to : m >= from || m <= to;
    }
    if (nums.length === 1) return now.getDate() === nums[0];
    if (nums.length === 2) return now.getDate() >= nums[0] && now.getDate() <= nums[1];
    return false;
  },
  function timeRange() {
    var args = Array.prototype.slice.call(arguments);
    var now = new Date();
    var nums = args.filter(function (a) { return typeof a === 'number'; });
    var h = now.getHours();
    if (nums.length === 1) return h === nums[0];
    if (nums.length === 2) return h >= nums[0] && h <= nums[1];
    if (nums.length >= 4) {
      var from = nums[0] * 60 + nums[1];
      var to = nums[2] * 60 + nums[3];
      var cur = h * 60 + now.getMinutes();
      return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
    }
    return false;
  },
  function alert() {
    // PAC scripts in the wild call this; it must not throw.
  },
];
/* eslint-enable no-undef */

const PAC_PRELUDE = PAC_LIBRARY.map((fn) => fn.toString()).join('\n');

/**
 * Parse a PAC return string into ordered proxy candidates.
 * "PROXY a:8080; SOCKS5 b:1080; DIRECT" -> [{type:'http'...}, {type:'socks5'...}, {type:'direct'}]
 */
function parsePacResult(result) {
  const out = [];
  for (const raw of String(result || '').split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [keywordRaw, target] = entry.split(/\s+/);
    const keyword = (keywordRaw || '').toUpperCase();
    if (keyword === 'DIRECT') {
      out.push({ type: 'direct' });
      continue;
    }
    if (!target) continue;
    const idx = target.lastIndexOf(':');
    const host = idx === -1 ? target : target.slice(0, idx);
    const port = idx === -1 ? null : parseInt(target.slice(idx + 1), 10);
    if (!host || !Number.isFinite(port)) continue;

    if (keyword === 'PROXY' || keyword === 'HTTP') out.push({ type: 'http', host, port });
    else if (keyword === 'HTTPS') out.push({ type: 'https', host, port });
    else if (keyword === 'SOCKS' || keyword === 'SOCKS4') out.push({ type: 'socks4', host, port });
    else if (keyword === 'SOCKS5') out.push({ type: 'socks5', host, port });
  }
  return out.length ? out : [{ type: 'direct' }];
}

class PacEngine {
  constructor(scriptText) {
    // The PAC body plus a stable entry point, compiled once and re-run per
    // request against a fresh context. The result is coerced to a string
    // INSIDE the timed run, so a hostile return value (an object with a
    // looping toString) is dealt with under the timeout, not out here.
    this.script = new vm.Script(
      `${PAC_PRELUDE}\n${scriptText}\n;__pacResult = String((typeof FindProxyForURL === 'function') ? FindProxyForURL(__pacUrl, __pacHost) : 'DIRECT');`,
      { filename: 'proxy.pac' }
    );
  }

  /** Returns an ordered list of proxy candidates for `url`. */
  async resolve(url, host) {
    let ip = null;
    if (net.isIP(host)) {
      ip = host;
    } else {
      try {
        const res = await dns.lookup(host);
        ip = res.address;
      } catch (e) {
        ip = null; // unresolvable — isResolvable() will correctly say false
      }
    }

    // Null prototype: nothing on the global object leads back to this realm.
    const sandbox = Object.create(null);
    sandbox.__pacUrl = String(url);
    sandbox.__pacHost = String(host);
    sandbox.__host = String(host);
    sandbox.__ip = ip == null ? null : String(ip);
    sandbox.__myIp = myIpAddress();
    sandbox.__pacResult = 'DIRECT';
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

    try {
      // A PAC file is third-party code on a hot path — bound it so a runaway
      // loop degrades to DIRECT instead of wedging every download.
      this.script.runInContext(context, { timeout: 2000 });
    } catch (err) {
      throw new Error(`PAC script failed: ${err && err.message ? err.message : 'error'}`);
    }
    const result = sandbox.__pacResult;
    return parsePacResult(typeof result === 'string' ? result : 'DIRECT');
  }
}

module.exports = { PacEngine, parsePacResult, shExpToRegExp, myIpAddress };
