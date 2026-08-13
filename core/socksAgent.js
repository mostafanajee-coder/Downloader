'use strict';

const net = require('net');
const tls = require('tls');
const { Agent } = require('agent-base');

// SOCKS5 wire constants (RFC 1928 / RFC 1929).
const VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REPLY_ERRORS = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

/**
 * Reads an exact number of bytes off a socket.
 *
 * A SOCKS handshake is a sequence of small fixed-size replies, and TCP is free
 * to deliver them split across packets or coalesced with the next one — so
 * every step buffers until it has precisely what it asked for and pushes any
 * surplus back for the following read.
 */
function createReader(socket) {
  let buffer = Buffer.alloc(0);
  let pending = null;

  const pump = () => {
    if (!pending || buffer.length < pending.want) return;
    const { want, resolve } = pending;
    pending = null;
    const out = buffer.subarray(0, want);
    buffer = buffer.subarray(want);
    resolve(out);
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });

  return {
    read(want) {
      return new Promise((resolve, reject) => {
        if (pending) {
          reject(new Error('Concurrent SOCKS reads are not supported'));
          return;
        }
        pending = { want, resolve, reject };
        pump();
      });
    },
    // Whatever arrived after the handshake belongs to the tunnelled protocol.
    leftovers() {
      const rest = buffer;
      buffer = Buffer.alloc(0);
      return rest;
    },
  };
}

function encodeAddress(host, port) {
  let head;
  if (net.isIPv4(host)) {
    head = Buffer.concat([Buffer.from([ATYP_IPV4]), Buffer.from(host.split('.').map(Number))]);
  } else if (net.isIPv6(host)) {
    const segments = expandIPv6(host);
    head = Buffer.concat([Buffer.from([ATYP_IPV6]), Buffer.from(segments)]);
  } else {
    const name = Buffer.from(host, 'utf8');
    if (name.length > 255) throw new Error(`Hostname too long for SOCKS5: ${host}`);
    head = Buffer.concat([Buffer.from([ATYP_DOMAIN, name.length]), name]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return Buffer.concat([head, portBuf]);
}

function expandIPv6(host) {
  const halves = host.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  const bytes = [];
  for (const g of groups.slice(0, 8)) {
    const v = parseInt(g || '0', 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

async function handshake(socket, { host, port, username, password }) {
  const reader = createReader(socket);

  // 1. Offer the auth methods we support.
  const methods = username ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE];
  socket.write(Buffer.from([VERSION, methods.length, ...methods]));

  const greeting = await reader.read(2);
  if (greeting[0] !== VERSION) throw new Error('Not a SOCKS5 proxy');
  if (greeting[1] === AUTH_NONE_ACCEPTABLE) {
    throw new Error('The SOCKS5 proxy rejected every authentication method we offered');
  }

  // 2. Username/password sub-negotiation, if that's what it picked.
  if (greeting[1] === AUTH_USERPASS) {
    if (!username) throw new Error('The SOCKS5 proxy requires a username and password');
    const u = Buffer.from(username, 'utf8');
    const p = Buffer.from(password || '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const authReply = await reader.read(2);
    if (authReply[1] !== 0x00) throw new Error('The SOCKS5 proxy rejected those credentials');
  } else if (greeting[1] !== AUTH_NONE) {
    throw new Error(`Unsupported SOCKS5 auth method 0x${greeting[1].toString(16)}`);
  }

  // 3. Ask it to connect onwards.
  socket.write(Buffer.concat([Buffer.from([VERSION, CMD_CONNECT, 0x00]), encodeAddress(host, port)]));

  const reply = await reader.read(4);
  if (reply[1] !== 0x00) {
    throw new Error(`SOCKS5 connect failed: ${REPLY_ERRORS[reply[1]] || `code 0x${reply[1].toString(16)}`}`);
  }

  // 4. Drain the bound address so the socket is left exactly at the start of
  //    the tunnelled stream.
  const atyp = reply[3];
  if (atyp === ATYP_IPV4) await reader.read(4 + 2);
  else if (atyp === ATYP_IPV6) await reader.read(16 + 2);
  else if (atyp === ATYP_DOMAIN) {
    const len = await reader.read(1);
    await reader.read(len[0] + 2);
  } else {
    throw new Error(`SOCKS5 proxy returned an unknown address type 0x${atyp.toString(16)}`);
  }

  return reader.leftovers();
}

/**
 * A SOCKS5 agent, implemented here because no SOCKS library is available in
 * this project's dependency tree.
 *
 * `remoteDns` (SOCKS5h) is the important option: with it on, the hostname is
 * sent to the proxy and resolved there, so the local machine never leaks a DNS
 * query for a host it is deliberately reaching through a proxy. IDM exposes
 * exactly this as its Socks5ProxyDNS setting.
 */
class Socks5Agent extends Agent {
  constructor({ host, port, username, password, remoteDns = true, timeout = 30000 } = {}) {
    super();
    this.proxyHost = host;
    this.proxyPort = Number(port);
    this.username = username || null;
    this.password = password || null;
    this.remoteDns = remoteDns !== false;
    this.timeout = timeout;
  }

  async connect(req, opts) {
    const targetHost = opts.host;
    const targetPort = Number(opts.port) || (opts.secureEndpoint ? 443 : 80);

    const socket = net.connect({ host: this.proxyHost, port: this.proxyPort });
    socket.setTimeout(this.timeout);

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        socket.destroy();
        reject(new Error(`Cannot reach the SOCKS5 proxy at ${this.proxyHost}:${this.proxyPort} — ${err.message}`));
      };
      socket.once('error', onError);
      socket.once('timeout', () => onError(new Error('timed out')));
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve();
      });
    });
    socket.setTimeout(0);

    let host = targetHost;
    if (!this.remoteDns && !net.isIP(targetHost)) {
      const { promises: dns } = require('dns');
      const [first] = await dns.lookup(targetHost, { all: true });
      host = first.address;
    }

    let leftovers;
    try {
      leftovers = await handshake(socket, {
        host,
        port: targetPort,
        username: this.username,
        password: this.password,
      });
    } catch (err) {
      socket.destroy();
      throw err;
    }

    // Anything the server already sent belongs to the tunnelled stream — put
    // it back at the front before handing the socket on.
    if (leftovers && leftovers.length) socket.unshift(leftovers);
    // Remove the handshake's own 'data' listener so it can't keep swallowing
    // bytes once the real protocol takes over.
    socket.removeAllListeners('data');

    if (opts.secureEndpoint) {
      return tls.connect({
        socket,
        servername: opts.servername || (typeof targetHost === 'string' ? targetHost : undefined),
        rejectUnauthorized: opts.rejectUnauthorized,
      });
    }
    return socket;
  }
}

module.exports = { Socks5Agent, encodeAddress, expandIPv6 };
