// Nodex uptime prober. Runs on the host (it needs the local Tor SOCKS port and the AirVPN tunnel)
// from a systemd user timer every 10 minutes: probes every address a node announces with
// lnprobe.mjs (.onion through Tor; IPv4/IPv6 only out of AirVPN, never from the home line, fail
// closed; private addresses never) including the BOLT 8 act one/two that proves the node's key.
//   data/uptime.json  { since, generated, egress, nodes: { pk: {
//       days: { 'YYYY-MM-DD': [up, tries] }, recent: '1101…', last, last_up,      <- "any address answered"
//       net:   { tor|ipv4|ipv6: { ok, hs, last_try, last_ok, last_hs } },          <- per network, this round
//       addrs: { '<socket>': { net, ok, hs, reason, via, last_try, last_ok, last_hs } } } } }
// recent holds the last 144 probes (24 h), oldest first; days are kept for 90 days. A node whose
// addresses could not be tested at all this round (tunnel or Tor down) gets no tick, not a "down".
import fs from 'node:fs';
import path from 'node:path';
import { probeNode } from './lnprobe.mjs';
import { towersFromDirectory, probeTowers } from './towers.mjs';

const DATA_DIR = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const KEEP_DAYS = 90, RECENT = 144, CONCURRENCY = 8;
const OPTS = { torTimeout: 60000, clearTimeout: 15000 };
const DIRECTORY_FILE = process.env.DIRECTORY_FILE || new URL('../../mempool-deploy/lightning-directory/lightning-directory.json', import.meta.url).pathname;

const graph = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'graph.json'), 'utf8'));
const file = path.join(DATA_DIR, 'uptime.json');
let db;
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = { since: Math.floor(Date.now() / 1000), nodes: {} }; }

const targets = graph.nodes.filter((n) => n.sockets?.length);
const results = new Map();
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < targets.length) { const n = targets[i++]; results.set(n.pk, await probeNode(n.pk, n.sockets, OPTS)); }
}));

const now = Math.floor(Date.now() / 1000);
const day = new Date(now * 1000).toISOString().slice(0, 10);
const oldest = new Date((now - KEEP_DAYS * 86400) * 1000).toISOString().slice(0, 10);
let up = 0, skipped = 0, unavailable = 0;
for (const [pk, res] of results) {
  const e = (db.nodes[pk] ||= { days: {}, recent: '' });
  // per address
  const addrs = {};
  for (const r of res) {
    const o = e.addrs?.[r.address] || {};
    const x = { net: r.network, ok: r.ok, hs: r.handshake, reason: r.reason || undefined, via: r.via, last_try: o.last_try, last_ok: o.last_ok, last_hs: o.last_hs };
    if (r.ok !== null) x.last_try = now;
    if (r.ok) x.last_ok = now;
    if (r.handshake) x.last_hs = now;
    if (String(r.reason || '').startsWith('unavailable')) unavailable++;
    addrs[r.address] = x;
  }
  e.addrs = addrs; // addresses no longer announced drop out
  // per network
  const net = {};
  for (const x of Object.values(addrs)) {
    if (!['tor', 'ipv4', 'ipv6'].includes(x.net)) continue;
    const n = (net[x.net] ||= { ok: null, hs: null, last_try: undefined, last_ok: undefined, last_hs: undefined });
    if (x.ok === true) n.ok = true; else if (x.ok === false && n.ok !== true) n.ok = false;
    if (x.hs === true) n.hs = true; else if (x.hs === false && n.hs !== true) n.hs = false;
    for (const k of ['last_try', 'last_ok', 'last_hs']) if (x[k] && !(n[k] >= x[k])) n[k] = x[k];
  }
  e.net = net;
  // "any address answered" (unchanged meaning), but no tick when nothing could be tested
  const tested = res.some((r) => r.ok !== null || r.reason === 'blocked_private' || r.reason === 'bad_address' || r.reason === 'dns_failed');
  const isUp = res.some((r) => r.ok === true);
  if (!tested && res.some((r) => /^unavailable|tor_not_running/.test(r.reason || ''))) { skipped++; continue; }
  const d = (e.days[day] ||= [0, 0]);
  d[0] += isUp ? 1 : 0; d[1] += 1;
  e.recent = (e.recent + (isUp ? '1' : '0')).slice(-RECENT);
  e.last = now;
  if (isUp) { e.last_up = now; up++; }
  for (const k of Object.keys(e.days)) if (k < oldest) delete e.days[k];
}
db.egress = 'tor+airvpn';
db.generated = now;
fs.writeFileSync(file + '.tmp', JSON.stringify(db));
fs.renameSync(file + '.tmp', file);
console.log(`probed ${results.size}, up ${up}, no tick ${skipped}, clearnet unavailable (tunnel) ${unavailable}`);

// Watchtowers listed on Nodex (see towers.mjs). Separate file, and a failure here never touches
// the node uptime written above.
try {
  const towers = towersFromDirectory(JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8')));
  const tfile = path.join(DATA_DIR, 'watchtowers.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(tfile, 'utf8')).towers || {}; } catch { /* first run */ }
  const res = await probeTowers(towers, prev, OPTS);
  fs.writeFileSync(tfile + '.tmp', JSON.stringify({ generated: Math.floor(Date.now() / 1000), towers: res }));
  fs.renameSync(tfile + '.tmp', tfile);
  console.log(`watchtowers: ${towers.length}, answering ${Object.values(res).filter((x) => x.ok).length}`);
} catch (e) {
  console.log('watchtowers: skipped:', e.message);
}
