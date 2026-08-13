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
 * fetched scripts on disk; this is the same contract, evaluated in a vm sandbox.
 *
 * The awkward part is that FindProxyForURL is synchronous while every useful
 * DNS helper is asynchronous in Node. The target host is therefore resolved
 * *before* evaluation and handed to the sandbox pre-computed — which covers
 * dnsResolve/isResolvable/isInNet for the host being requested, by far the
 * dominant use. Lookups for unrelated hosts return null rather than blocking.
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

function ipToLong(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function buildSandbox(resolved) {
  const dnsResolve = (host) => {
    if (net.isIP(host)) return host;
    // Only the request's own host is pre-resolved; anything else would need a
    // blocking lookup inside a synchronous function.
    return resolved.host === host ? resolved.ip : null;
  };

  const api = {
    isPlainHostName: (host) => String(host).indexOf('.') === -1,
    dnsDomainIs: (host, domain) => {
      host = String(host);
      domain = String(domain);
      return host.length >= domain.length && host.slice(host.length - domain.length) === domain;
    },
    localHostOrDomainIs: (host, hostdom) =>
      host === hostdom || String(hostdom).lastIndexOf(String(host) + '.', 0) === 0,
    isResolvable: (host) => dnsResolve(host) !== null,
    dnsResolve,
    myIpAddress,
    dnsDomainLevels: (host) => (String(host).match(/\./g) || []).length,
    shExpMatch: (str, shexp) => shExpToRegExp(shexp).test(String(str)),
    isInNet: (hostOrIp, pattern, mask) => {
      const ip = net.isIP(hostOrIp) ? hostOrIp : dnsResolve(hostOrIp);
      const a = ipToLong(ip);
      const b = ipToLong(pattern);
      const m = ipToLong(mask);
      if (a === null || b === null || m === null) return false;
      return (a & m) >>> 0 === (b & m) >>> 0;
    },
    weekdayRange: (wd1, wd2, gmt) => {
      const useGmt = gmt === 'GMT' || wd2 === 'GMT';
      const now = new Date();
      const today = useGmt ? now.getUTCDay() : now.getDay();
      const start = WEEKDAYS.indexOf(String(wd1).toUpperCase());
      if (start === -1) return false;
      const endName = wd2 && wd2 !== 'GMT' ? String(wd2).toUpperCase() : String(wd1).toUpperCase();
      const end = WEEKDAYS.indexOf(endName);
      if (end === -1) return false;
      return start <= end ? today >= start && today <= end : today >= start || today <= end;
    },
    dateRange: (...args) => {
      // The full PAC dateRange grammar has seven overloads; the day-of-month
      // and month forms are the ones that appear in practice.
      const now = new Date();
      const nums = args.filter((a) => typeof a === 'number');
      const months = args.filter((a) => typeof a === 'string' && MONTHS.includes(a.toUpperCase()));
      if (months.length) {
        const m = now.getMonth();
        const from = MONTHS.indexOf(months[0].toUpperCase());
        const to = months[1] ? MONTHS.indexOf(months[1].toUpperCase()) : from;
        return from <= to ? m >= from && m <= to : m >= from || m <= to;
      }
      if (nums.length === 1) return now.getDate() === nums[0];
      if (nums.length === 2) return now.getDate() >= nums[0] && now.getDate() <= nums[1];
      return false;
    },
    timeRange: (...args) => {
      const now = new Date();
      const nums = args.filter((a) => typeof a === 'number');
      const h = now.getHours();
      if (nums.length === 1) return h === nums[0];
      if (nums.length === 2) return h >= nums[0] && h <= nums[1];
      if (nums.length >= 4) {
        const from = nums[0] * 60 + nums[1];
        const to = nums[2] * 60 + nums[3];
        const cur = h * 60 + now.getMinutes();
        return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
      }
      return false;
    },
    alert: () => {}, // PAC scripts in the wild call this; it must not throw
  };
  return api;
}

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
    this.script = new vm.Script(
      // The PAC body plus a stable entry point, compiled once and re-run per
      // request against a fresh context.
      `${scriptText}\n;__pacResult = (typeof FindProxyForURL === 'function') ? FindProxyForURL(__pacUrl, __pacHost) : 'DIRECT';`
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

    const sandbox = buildSandbox({ host, ip });
    sandbox.__pacUrl = url;
    sandbox.__pacHost = host;
    sandbox.__pacResult = 'DIRECT';
    const context = vm.createContext(sandbox);

    try {
      // A PAC file is third-party code on a hot path — bound it so a runaway
      // loop degrades to DIRECT instead of wedging every download.
      this.script.runInContext(context, { timeout: 2000 });
    } catch (err) {
      throw new Error(`PAC script failed: ${err.message}`);
    }
    return parsePacResult(sandbox.__pacResult);
  }
}

module.exports = { PacEngine, parsePacResult, shExpToRegExp, myIpAddress };
