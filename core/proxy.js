'use strict';

const net = require('net');
const { URL } = require('url');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { Socks5Agent } = require('./socksAgent');
const { PacEngine, shExpToRegExp } = require('./pac');

const DIRECT = { type: 'direct' };

/**
 * Proxy resolution, mirroring the structure found in IDM's registry:
 * per-protocol HTTP/HTTPS/FTP servers, a SOCKS server with its own
 * remote-DNS flag, an exception list, and a PAC mode with a cached script.
 *
 * Everything is lazy: with no proxy configured this costs one boolean check
 * per request and builds nothing.
 */
class ProxyResolver {
  constructor() {
    this.settings = { mode: 'direct' };
    this.exceptionPatterns = [];
    this.pac = null;
    this.pacSource = null;
    this.pacError = null;
    this.pacLoading = null;
    this._agentCache = new Map();
  }

  /**
   * `settings` shape:
   *   mode: 'direct' | 'manual' | 'pac'
   *   http/https/ftp: { host, port, username, password }
   *   socks: { host, port, username, password, remoteDns }
   *   useSocksForAll: boolean   — route everything through SOCKS
   *   exceptions: 'localhost 192.168.* *.internal'
   *   pacUrl: 'http://…/proxy.pac' | 'file:///…'
   */
  configure(settings = {}) {
    const next = settings || {};
    this.settings = next;
    this.exceptionPatterns = String(next.exceptions || '')
      .split(/[\s,;]+/)
      .filter(Boolean);

    // Agents embed host/port/credentials, so a settings change must invalidate
    // them or requests would keep using the previous proxy.
    this._agentCache.clear();

    const source = next.mode === 'pac' ? String(next.pacUrl || '').trim() : null;
    if (source !== this.pacSource) {
      this.pacSource = source;
      this.pac = null;
      this.pacError = null;
      this.pacLoading = null;
    }
  }

  get enabled() {
    return this.settings.mode === 'manual' || this.settings.mode === 'pac';
  }

  /**
   * Exception list matching. Entries are shell globs against the hostname
   * ("*.internal"), plain hostnames, or a bare IP. `<local>` is honoured as the
   * Windows convention for "any name without a dot".
   */
  isException(hostname) {
    const host = String(hostname || '').toLowerCase();
    for (const pattern of this.exceptionPatterns) {
      const p = pattern.toLowerCase();
      if (p === '<local>') {
        if (!host.includes('.')) return true;
        continue;
      }
      if (p === host) return true;
      if (p.includes('*') || p.includes('?')) {
        if (shExpToRegExp(p).test(host)) return true;
        // "*.example.com" idiomatically also covers "example.com" itself.
        if (p.startsWith('*.') && host === p.slice(2)) return true;
      }
    }
    return false;
  }

  async _ensurePac() {
    if (this.pac || !this.pacSource) return this.pac;
    if (this.pacLoading) return this.pacLoading;

    this.pacLoading = (async () => {
      try {
        const text = await fetchPacScript(this.pacSource);
        this.pac = new PacEngine(text);
        this.pacError = null;
      } catch (err) {
        // A broken PAC must not take the network down with it — record the
        // reason and fall through to DIRECT.
        this.pacError = err.message;
        this.pac = null;
        console.warn(`[Proxy] Could not load PAC from ${this.pacSource}: ${err.message}`);
      } finally {
        this.pacLoading = null;
      }
      return this.pac;
    })();
    return this.pacLoading;
  }

  /** The proxy to use for `urlStr`, as a plain descriptor. */
  async resolve(urlStr) {
    if (!this.enabled) return DIRECT;

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return DIRECT;
    }
    if (this.isException(parsed.hostname)) return DIRECT;

    if (this.settings.mode === 'pac') {
      const engine = await this._ensurePac();
      if (!engine) return DIRECT;
      try {
        const candidates = await engine.resolve(urlStr, parsed.hostname);
        // Only the first candidate is honoured; PAC's fallback list is a
        // failover mechanism, and retrying through a second proxy belongs to
        // the download engine's own retry logic rather than here.
        return candidates[0] || DIRECT;
      } catch (err) {
        console.warn(`[Proxy] PAC evaluation failed for ${parsed.hostname}: ${err.message}`);
        return DIRECT;
      }
    }

    const s = this.settings;
    const socks = s.socks && s.socks.host ? s.socks : null;
    if (socks && s.useSocksForAll) {
      return { type: 'socks5', ...socks };
    }

    const protocol = parsed.protocol.replace(':', '');
    const perProtocol = protocol === 'https' ? s.https : protocol === 'ftp' ? s.ftp : s.http;
    // An https request with no https-specific proxy falls back to the http one,
    // which is what every browser does and what IDM's dialog implies.
    const chosen = perProtocol && perProtocol.host ? perProtocol : s.http && s.http.host ? s.http : null;
    if (chosen) return { type: protocol === 'https' ? 'https-via-http' : 'http', ...chosen };
    if (socks) return { type: 'socks5', ...socks };
    return DIRECT;
  }

  /**
   * A Node http(s).Agent implementing `descriptor`, or null for a direct
   * connection. Agents are cached: creating one per request would defeat
   * keep-alive and leak sockets.
   */
  agentFor(descriptor, secureEndpoint) {
    if (!descriptor || descriptor.type === 'direct') return null;
    const key = `${descriptor.type}|${descriptor.host}|${descriptor.port}|${descriptor.username || ''}|${
      descriptor.remoteDns !== false
    }|${secureEndpoint ? 's' : 'p'}`;
    if (this._agentCache.has(key)) return this._agentCache.get(key);

    let agent = null;
    if (descriptor.type === 'socks5' || descriptor.type === 'socks4') {
      agent = new Socks5Agent({
        host: descriptor.host,
        port: descriptor.port,
        username: descriptor.username,
        password: descriptor.password,
        remoteDns: descriptor.remoteDns !== false,
      });
    } else {
      const auth = descriptor.username
        ? `${encodeURIComponent(descriptor.username)}:${encodeURIComponent(descriptor.password || '')}@`
        : '';
      const scheme = descriptor.type === 'https' ? 'https' : 'http';
      const url = `${scheme}://${auth}${descriptor.host}:${descriptor.port}`;
      // An https target goes through CONNECT tunnelling; plain http is a
      // straightforward absolute-URI request to the proxy.
      agent = secureEndpoint ? new HttpsProxyAgent(url) : new HttpProxyAgent(url);
    }

    this._agentCache.set(key, agent);
    return agent;
  }

  /** Diagnostics for the Options dialog's "test" affordance. */
  describe() {
    if (!this.enabled) return { mode: this.settings.mode || 'direct', detail: 'No proxy — connecting directly.' };
    if (this.settings.mode === 'pac') {
      return {
        mode: 'pac',
        detail: this.pacError ? `PAC failed: ${this.pacError}` : `PAC script: ${this.pacSource || '(none set)'}`,
      };
    }
    const parts = [];
    for (const k of ['http', 'https', 'ftp']) {
      const p = this.settings[k];
      if (p && p.host) parts.push(`${k.toUpperCase()} ${p.host}:${p.port}`);
    }
    if (this.settings.socks && this.settings.socks.host) {
      parts.push(`SOCKS5 ${this.settings.socks.host}:${this.settings.socks.port}`);
    }
    return { mode: 'manual', detail: parts.length ? parts.join(', ') : 'Manual mode with no servers configured.' };
  }
}

async function fetchPacScript(source) {
  if (!source) throw new Error('No PAC address configured');

  if (/^file:/i.test(source) || (!/^https?:/i.test(source) && !net.isIP(source))) {
    const fs = require('fs').promises;
    const path = require('path');
    const filePath = /^file:/i.test(source) ? require('url').fileURLToPath(source) : path.resolve(source);
    return fs.readFile(filePath, 'utf8');
  }

  // Deliberately uses plain http(s) rather than core/httpUtils: routing the PAC
  // fetch through the proxy layer that is still waiting on this very script
  // would deadlock.
  const mod = /^https:/i.test(source) ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.get(source, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const sharedResolver = new ProxyResolver();

module.exports = { ProxyResolver, sharedResolver, fetchPacScript, DIRECT };
