// Nodex reachability probes, shared by the 10-minute uptime prober and the "Ping" button.
//
// For each address a node announces:
//   - .onion            -> through the local Tor SOCKS port (127.0.0.1:9050)
//   - IPv4 / IPv6       -> bound to the AirVPN tunnel's own address, so the connection leaves through
//                          AirVPN and never from the home line. Fail closed: if the tunnel has no
//                          address, or the kernel would not route the probe out of the tunnel, the
//                          probe is not made and the result is "unavailable".
//   - private / local addresses are never probed (anyone can announce 192.168.x as a socket);
//     hostnames are resolved first and the resolved address is checked.
// After the TCP connection, a BOLT 8 (Noise_XK) act one is sent to the node's known key and act two
// is read and decrypted: that only works if whoever answers holds the node's private key, so
// "handshake: true" means a channel open to this node would connect. We then close without act
// three or init, so nothing beyond the handshake reaches the node.
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFile } from 'node:child_process';
import * as secp from '@noble/secp256k1';

export const SOCKS = { host: process.env.PROBE_SOCKS_HOST || '127.0.0.1', port: Number(process.env.PROBE_SOCKS_PORT) || 9050 };
export const VPN_DEV = process.env.PROBE_VPN_DEV || 'wg-airvpn';
export const TIMEOUT_CLEAR = 8000;
export const TIMEOUT_TOR = 25000; // the whole ping must fit in nginx's 30 s proxy timeout
export const MAX_ADDRS = 8;

// ---------- addresses ----------

export function parseSocket(sock) {
  if (typeof sock !== 'string' || sock.length > 300) return null;
  const m = sock.trim().match(/^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/);
  if (!m) return null;
  const host = (m[1] || m[2]).toLowerCase();
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  if (m[1] && net.isIPv6(host) === false) return null;
  let network;
  if (host.endsWith('.onion')) {
    if (!/^[a-z2-7]{56}\.onion$/.test(host)) return null; // v3 only (v2 onions are gone from Tor)
    network = 'tor';
  } else if (net.isIPv4(host)) network = 'ipv4';
  else if (net.isIPv6(host)) network = 'ipv6';
  else if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) network = 'dns';
  else return null;
  return { host, port, network };
}

// Anything that is not public unicast internet.
export const BLOCKED = new net.BlockList();
for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCKED.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, b, 'ipv6');

// IPv4-mapped IPv6 (::ffff:a.b.c.d) kept apart: node's BlockList also matches plain IPv4 against it.
const MAPPED = new net.BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

export function isBlocked(ip) {
  const fam = net.isIP(ip);
  if (!fam) return true;
  if (fam === 6 && MAPPED.check(ip, 'ipv6')) return true;
  return BLOCKED.check(ip, fam === 6 ? 'ipv6' : 'ipv4');
}

// Public IP for a parsed address, or {reason}. Hostnames resolve to one address (IPv4 first).
export async function resolvePublic(a, lookup = dns.lookup) {
  let ip = a.host;
  if (a.network === 'dns') {
    try { ip = (await lookup(a.host, { verbatim: false })).address; } catch { return { reason: 'dns_failed' }; }
  }
  if (isBlocked(ip)) return { reason: 'blocked_private' };
  return { ip, network: net.isIPv6(ip) ? 'ipv6' : 'ipv4' };
}

// ---------- AirVPN egress (fail closed) ----------

function run(cmd, args) {
  return new Promise((ok) => execFile(cmd, args, { timeout: 3000 }, (e, out) => ok(e ? null : out)));
}

// The tunnel's own address for a family, or null. PROBE_SRC4/PROBE_SRC6 override (tests).
export async function vpnSource(family) {
  const o = process.env[family === 6 ? 'PROBE_SRC6' : 'PROBE_SRC4'];
  if (o) return o;
  const out = await run('ip', ['-j', `-${family}`, 'addr', 'show', 'dev', VPN_DEV]);
  if (!out) return null;
  try {
    const [d] = JSON.parse(out);
    if (!d || !(d.flags || []).includes('UP')) return null;
    const a = (d.addr_info || []).find((x) => x.scope === 'global');
    return a ? a.local : null;
  } catch { return null; }
}

// True only if the kernel would send dst, from src, out of the tunnel.
export async function routesViaVpn(dst, src) {
  if (process.env.PROBE_SKIP_ROUTE_CHECK === '1') return true; // tests only: let the bind itself fail
  const out = await run('ip', ['-j', net.isIPv6(dst) ? '-6' : '-4', 'route', 'get', dst, 'from', src]);
  if (!out) return false;
  try { const [r] = JSON.parse(out); return !!r && r.dev === VPN_DEV; } catch { return false; }
}

// The tunnel's public exit addresses. A connection from the tunnel to its own exit address does
// not come back in (no hairpin), so nodes announced on that same address (ours, or anyone else's
// forwarded port on the same AirVPN exit) are tested through Tor instead. Learned by asking
// ifconfig.co through the tunnel (cached 6 h); PROBE_SELF_IPS is the fallback.
const SELF_FALLBACK = (process.env.PROBE_SELF_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
let selfCache = { at: 0, ips: new Set(SELF_FALLBACK) };
let selfPending = null;
function exitIp(family) {
  return new Promise(async (ok) => {
    const src = await vpnSource(family);
    if (!src || !(await routesViaVpn(family === 6 ? '2606:4700:4700::1111' : '1.1.1.1', src))) return ok(null);
    const req = https.get({ host: 'ifconfig.co', path: '/ip', family, localAddress: src, timeout: 8000, headers: { 'User-Agent': 'curl/8' } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; if (b.length > 100) req.destroy(); });
      r.on('end', () => { const ip = b.trim(); ok(net.isIP(ip) ? ip : null); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => ok(null));
  });
}
export async function selfIps() {
  if (process.env.PROBE_SELF_DISCOVER === '0' || Date.now() - selfCache.at < 6 * 3600 * 1000) return selfCache.ips;
  selfPending ||= (async () => {
    const found = (await Promise.all([exitIp(4), exitIp(6)])).filter(Boolean);
    selfCache = { at: Date.now(), ips: new Set([...SELF_FALLBACK, ...found]) };
    selfPending = null;
    return selfCache.ips;
  })();
  return selfPending;
}
export function isSelf(ip, set) {
  const k = (x) => (net.isIPv6(x) ? expand6(x) : x);
  for (const x of set) if (net.isIP(x) === net.isIP(ip) && k(x) === k(ip)) return true;
  return false;
}
function expand6(a) {
  const [h, t = ''] = a.toLowerCase().split('::');
  const hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
  const mid = a.includes('::') ? Array(8 - hs.length - ts.length).fill('0') : [];
  return [...hs, ...mid, ...ts].map((x) => x.padStart(4, '0')).join(':');
}

// ---------- sockets ----------

// Promise-based exact reads on a socket (keeps whatever arrives early).
function reader(s) {
  let buf = Buffer.alloc(0), want = 0, waiting = null, failed = null;
  const pump = () => {
    if (waiting && buf.length >= want) { const out = buf.subarray(0, want); buf = buf.subarray(want); const w = waiting; waiting = null; w.ok(out); }
  };
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
  const fail = (e) => { failed = e; if (waiting) { const w = waiting; waiting = null; w.no(e); } };
  s.once('error', (e) => fail(Object.assign(new Error('closed'), { code: e.code || 'error' })));
  s.once('close', () => fail(Object.assign(new Error('closed'), { code: 'closed' })));
  return (n) => new Promise((ok, no) => {
    if (failed && buf.length < n) return no(failed);
    want = n; waiting = { ok, no }; pump();
  });
}

function connectTcp(opts) {
  return new Promise((ok, no) => {
    const s = net.connect(opts);
    s.once('connect', () => ok(s));
    s.once('error', (e) => no(Object.assign(new Error(e.message), { code: e.code || 'error', sock: s })));
    opts.track?.(s);
  });
}

async function socksConnect(host, port, track) {
  const s = await connectTcp({ ...SOCKS, track });
  const read = reader(s);
  s.write(Buffer.from([5, 1, 0]));
  const g = await read(2);
  if (g[0] !== 5 || g[1] !== 0) throw Object.assign(new Error('socks'), { code: 'socks_refused' });
  const h = Buffer.from(host);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
  const r = await read(4);
  if (r[0] !== 5 || r[1] !== 0) throw Object.assign(new Error('socks'), { code: r[1] === 4 ? 'tor_unreachable' : `tor_error_${r[1]}` });
  const alen = r[3] === 1 ? 4 : r[3] === 4 ? 16 : (await read(1))[0];
  await read(alen + 2);
  return { s, read };
}

// ---------- BOLT 8 act one / act two (initiator) ----------

const sha = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
const PROTOCOL = Buffer.from('Noise_XK_secp256k1_ChaChaPoly_SHA256');
const PROLOGUE = Buffer.from('lightning');
const ecdh = (priv, pub) => sha(Buffer.from(secp.getSharedSecret(priv, pub, true)));
function hkdf(ck, ikm) {
  const o = Buffer.from(crypto.hkdfSync('sha256', ikm, ck, Buffer.alloc(0), 64));
  return [o.subarray(0, 32), o.subarray(32)];
}
const NONCE0 = Buffer.alloc(12); // 32 zero bits + 64-bit little-endian nonce 0
function encrypt(k, ad, plain) {
  const c = crypto.createCipheriv('chacha20-poly1305', k, NONCE0, { authTagLength: 16 });
  c.setAAD(ad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function decrypt(k, ad, ct) {
  const d = crypto.createDecipheriv('chacha20-poly1305', k, NONCE0, { authTagLength: 16 });
  d.setAAD(ad, { plaintextLength: ct.length - 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// Returns {act1, check(act2) -> boolean}. ephemeral may be given for test vectors.
export function noiseInitiator(remotePub, ephemeral) {
  const rs = Buffer.from(remotePub);
  const e = ephemeral ? Buffer.from(ephemeral) : Buffer.from(secp.utils.randomSecretKey());
  const ePub = Buffer.from(secp.getPublicKey(e, true));
  let h = sha(PROTOCOL);
  let ck = h;
  h = sha(h, PROLOGUE);
  h = sha(h, rs);
  h = sha(h, ePub);
  let k;
  [ck, k] = hkdf(ck, ecdh(e, rs));
  const c = encrypt(k, h, Buffer.alloc(0));
  h = sha(h, c);
  const act1 = Buffer.concat([Buffer.from([0]), ePub, c]);
  return {
    act1,
    check(m) {
      if (m.length !== 50 || m[0] !== 0) return false;
      const re = m.subarray(1, 34), c2 = m.subarray(34);
      try {
        secp.Point.fromBytes(re); // valid curve point
        const h2 = sha(h, re);
        const [, k2] = hkdf(ck, ecdh(e, re));
        decrypt(k2, h2, c2);
        return true;
      } catch { return false; }
    },
  };
}

// ---------- one address ----------

function hex33(pk) { return typeof pk === 'string' && /^0[23][0-9a-f]{64}$/.test(pk) ? Buffer.from(pk, 'hex') : null; }

// Probe one announced socket. Result: {network, address, ok, ms, handshake, reason}
//   ok: true (TCP connected) / false (did not answer) / null (not tested: blocked, VPN down, bad address)
//   handshake: true (BOLT 8 act two verified for pubkey) / false (connected but no valid act two) / null (not tried)
export async function probeAddress(sock, pubkey, opts = {}) {
  const a = parseSocket(sock);
  const res = { network: a ? (a.network === 'dns' ? 'dns' : a.network) : 'unknown', address: String(sock).slice(0, 300), ok: null, ms: null, handshake: null, reason: null };
  if (!a) return { ...res, reason: 'bad_address' };
  const rs = hex33(pubkey);
  const doHs = opts.handshake !== false && !!rs;
  const tor = a.network === 'tor';
  let budget;
  let ip, src;
  if (!tor) {
    const p = await (opts.resolve || resolvePublic)(a);
    if (!p.ip) return { ...res, reason: p.reason };
    ip = p.ip; res.network = p.network;
    if (isSelf(ip, await selfIps())) { res.via = 'tor'; }
  }
  if (!tor && !res.via) {
    src = await vpnSource(net.isIPv6(ip) ? 6 : 4);
    if (!src) return { ...res, reason: 'unavailable_vpn_down' };
    if (!(await routesViaVpn(ip, src))) return { ...res, reason: 'unavailable_vpn_route' };
  }
  budget = opts.timeout ?? (tor || res.via === 'tor' ? (opts.torTimeout ?? TIMEOUT_TOR) : (opts.clearTimeout ?? TIMEOUT_CLEAR));
  let sockRef = null;
  const track = (s) => { sockRef = s; };
  const t0 = Date.now();
  let timer;
  const timeout = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'timeout' })), budget); });
  let stage = 'connect';
  try {
    const work = (async () => {
      let s, read;
      if (tor) ({ s, read } = await socksConnect(a.host, a.port, track));
      else if (res.via === 'tor') ({ s, read } = await socksConnect(ip, a.port, track));
      else {
        s = await connectTcp({ host: ip, port: a.port, localAddress: src, family: net.isIPv6(ip) ? 6 : 4, track });
        // Belt and braces: the socket really is bound to the tunnel's address.
        if (s.localAddress !== src) throw Object.assign(new Error('bad source'), { code: 'unavailable_wrong_source' });
        read = reader(s);
      }
      res.ok = true;
      res.ms = Date.now() - t0;
      if (!doHs) return;
      stage = 'handshake';
      const n = noiseInitiator(rs);
      s.write(n.act1);
      const act2 = await read(50);
      res.handshake = n.check(act2);
      if (!res.handshake) res.reason = 'handshake_bad_act2';
      res.ms_handshake = Date.now() - t0;
    })();
    await Promise.race([work, timeout]);
  } catch (e) {
    const code = e.code || 'error';
    if (code === 'unavailable_wrong_source') { res.ok = null; res.reason = code; }
    else if (stage === 'connect') {
      res.ok = /^EADDRNOTAVAIL$|^EINVAL$/.test(code) ? null : false;
      const viaTor = tor || res.via === 'tor';
      res.reason = res.ok === null ? `unavailable_bind_${code}` : (viaTor && code === 'ECONNREFUSED' ? 'tor_not_running' : code === 'ECONNREFUSED' ? 'refused' : code === 'EACCES' ? 'rejected' : /^E(HOST|NET)UNREACH$/.test(code) ? 'unreachable' : code === 'timeout' ? 'timeout' : String(code).toLowerCase());
      if (viaTor && code === 'ECONNREFUSED') res.ok = null;
      res.ms = null;
    } else { res.handshake = false; res.reason = code === 'timeout' ? 'handshake_timeout' : 'handshake_closed'; }
  } finally {
    clearTimeout(timer);
    sockRef?.destroy();
  }
  if (res.ok && !doHs) res.reason = rs ? 'tcp_only' : 'tcp_only_no_pubkey';
  return res;
}

// All of a node's addresses (deduplicated, at most MAX_ADDRS), in parallel.
export async function probeNode(pubkey, sockets, opts = {}) {
  const list = [...new Set((sockets || []).filter((s) => typeof s === 'string'))].slice(0, opts.max ?? MAX_ADDRS);
  return Promise.all(list.map((s) => probeAddress(s, pubkey, opts)));
}

// Per-network summary: {tor|ipv4|ipv6: {ok, handshake}} for networks present.
export function summarize(results) {
  const out = {};
  for (const r of results) {
    if (!['tor', 'ipv4', 'ipv6'].includes(r.network)) continue;
    const n = (out[r.network] ||= { ok: null, handshake: null });
    if (r.ok === true) n.ok = true; else if (r.ok === false && n.ok !== true) n.ok = false;
    if (r.handshake === true) n.handshake = true; else if (r.handshake === false && n.handshake !== true) n.handshake = false;
  }
  return out;
}
