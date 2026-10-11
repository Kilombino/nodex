// Nodex uptime prober. Runs on the host (it needs the local Tor SOCKS port) from a systemd
// user timer every 10 minutes: tries a TCP connection to every address a node announces
// (.onion through Tor) and records whether at least one answered.
//   data/uptime.json  { since, generated, nodes: { pk: { days: { 'YYYY-MM-DD': [up, tries] }, recent: '1101…', last, last_up } } }
// recent holds the last 144 probes (24 h), oldest first; days are kept for 90 days.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const SOCKS = { host: '127.0.0.1', port: 9050 };
const KEEP_DAYS = 90, RECENT = 144, CONCURRENCY = 8;

function tcp(host, port, ms) {
  return new Promise((ok) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); ok(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Minimal SOCKS5 CONNECT by hostname; resolves true once Tor reports the circuit connected.
function socks(host, port, ms) {
  return new Promise((ok) => {
    const s = net.connect(SOCKS);
    let stage = 0;
    const done = (v) => { s.destroy(); ok(v); };
    s.setTimeout(ms, () => done(false));
    s.once('error', () => done(false));
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (b) => {
      if (stage === 0) {
        if (b[0] !== 5 || b[1] !== 0) return done(false);
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
        stage = 1;
      } else done(b[0] === 5 && b[1] === 0);
    });
  });
}

function parse(sock) {
  const m = sock.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

// Anyone can announce any address, so never let a node make us knock on our own LAN:
// only public unicast IPs are probed directly (hostnames are resolved first), .onion goes via Tor.
const BLOCKED = new net.BlockList();
for (const [a, b] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) BLOCKED.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, b, 'ipv6');
async function publicIp(host) {
  let ip = host;
  if (!net.isIP(host)) { try { ip = (await dns.lookup(host)).address; } catch { return null; } }
  return BLOCKED.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4') ? null : ip;
}

async function probe(sockets) {
  for (const s of sockets) {
    const a = parse(s);
    if (!a || a.port < 1 || a.port > 65535) continue;
    let up = false;
    if (a.host.endsWith('.onion')) up = await socks(a.host, a.port, 60000);
    else { const ip = await publicIp(a.host); if (ip) up = await tcp(ip, a.port, 15000); }
    if (up) return true;
  }
  return false;
}

const graph = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'graph.json'), 'utf8'));
const file = path.join(DATA_DIR, 'uptime.json');
let db;
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = { since: Math.floor(Date.now() / 1000), nodes: {} }; }

const targets = graph.nodes.filter((n) => n.sockets?.length);
const results = new Map();
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < targets.length) { const n = targets[i++]; results.set(n.pk, await probe(n.sockets)); }
}));

const now = Math.floor(Date.now() / 1000);
const day = new Date(now * 1000).toISOString().slice(0, 10);
const oldest = new Date((now - KEEP_DAYS * 86400) * 1000).toISOString().slice(0, 10);
for (const [pk, up] of results) {
  const e = (db.nodes[pk] ||= { days: {}, recent: '' });
  const d = (e.days[day] ||= [0, 0]);
  d[0] += up ? 1 : 0; d[1] += 1;
  e.recent = (e.recent + (up ? '1' : '0')).slice(-RECENT);
  e.last = now;
  if (up) e.last_up = now;
  for (const k of Object.keys(e.days)) if (k < oldest) delete e.days[k];
}
db.generated = now;
fs.writeFileSync(file + '.tmp', JSON.stringify(db));
fs.renameSync(file + '.tmp', file);
console.log(`probed ${results.size}, up ${[...results.values()].filter(Boolean).length}`);
