// Nodex indexer: walks the Lightning graph of the BLAKE2b chain through the read-only mempool API,
// computes rankings / centrality / fee stats, and records channel policy changes over time
// (the mempool backend only keeps the CURRENT policy of each channel, not its history).
//
// Output (in DATA_DIR, served read-only by nginx under /data/):
//   graph.json          full snapshot: nodes, channels with both directions' policies, network stats
//   history.json        latest policy changes (newest first), built from history.jsonl
//   history.jsonl       append-only log of every policy change seen since the indexer started
//   policies.json       last known policy per channel direction (internal state)
//   status.json         when the last run started/finished and how it went

import fs from 'node:fs';
import path from 'node:path';

const API = (process.env.API_BASE || 'http://mempool-api:8999/api/v1/lightning').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || '/data';
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 600) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const HISTORY_KEEP = Number(process.env.HISTORY_KEEP || 5000);

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function get(p, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(API + p, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
      return { json: await r.json(), headers: r.headers };
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1000 * i));
    }
  }
}

async function pool(items, fn, n = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; log('warn', e.message); }
    }
  }));
  return out;
}

function writeAtomic(name, obj) {
  const f = path.join(DATA_DIR, name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, typeof obj === 'string' ? obj : JSON.stringify(obj));
  fs.renameSync(tmp, f);
}

function readJson(name, dflt) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return dflt; }
}

const ts = (v) => (v == null ? null : typeof v === 'number' ? v : Math.floor(Date.parse(v) / 1000) || null);

function policyOf(side) {
  if (!side || side.fee_rate == null && side.base_fee_mtokens == null) return null;
  return {
    base: Number(side.base_fee_mtokens ?? 0),       // msat
    ppm: Number(side.fee_rate ?? 0),
    cltv: Number(side.cltv_delta ?? 0),
    min: Number(side.min_htlc_mtokens ?? 0),        // msat
    max: Number(side.max_htlc_mtokens ?? 0),        // msat
    disabled: !!Number(side.is_disabled ?? 0),
    updated: ts(side.updated_at),
  };
}

function quantiles(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => {
    const i = (s.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1], avg: s.reduce((a, b) => a + b, 0) / s.length };
}

// Brandes betweenness + closeness on the undirected, unweighted peer graph.
function centrality(pks, adj) {
  const bc = Object.fromEntries(pks.map((p) => [p, 0]));
  const close = {};
  for (const s of pks) {
    const S = []; const P = {}; const sigma = {}; const d = {};
    for (const v of pks) { P[v] = []; sigma[v] = 0; d[v] = -1; }
    sigma[s] = 1; d[s] = 0;
    const Q = [s];
    while (Q.length) {
      const v = Q.shift(); S.push(v);
      for (const w of adj[v] || []) {
        if (d[w] < 0) { Q.push(w); d[w] = d[v] + 1; }
        if (d[w] === d[v] + 1) { sigma[w] += sigma[v]; P[w].push(v); }
      }
    }
    const reach = pks.filter((v) => v !== s && d[v] > 0);
    const sum = reach.reduce((a, v) => a + d[v], 0);
    // Wasserman-Faust closeness: works for disconnected graphs
    close[s] = sum > 0 ? (reach.length / (pks.length - 1)) * (reach.length / sum) : 0;
    const delta = Object.fromEntries(pks.map((v) => [v, 0]));
    while (S.length) {
      const w = S.pop();
      for (const v of P[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) bc[w] += delta[w];
    }
  }
  const n = pks.length;
  const norm = n > 2 ? (n - 1) * (n - 2) : 1; // undirected: each pair counted twice above
  for (const p of pks) bc[p] = bc[p] / norm;
  return { bc, close };
}

async function run() {
  const started = new Date().toISOString();
  writeAtomic('status.json', { ...readJson('status.json', {}), running: true, started });

  // 1. Seed node list from the rankings, then BFS through channel peers.
  const seeds = new Set();
  for (const p of ['/nodes/rankings/connectivity', '/nodes/rankings/liquidity', '/nodes/rankings/age']) {
    const { json } = await get(p);
    for (const n of json) seeds.add(n.publicKey);
  }
  const known = new Set(seeds);
  const queue = [...seeds];
  const channelIds = new Set();
  const nodeChannelCount = {};
  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    await pool(batch, async (pk) => {
      let index = 0; let total = Infinity;
      while (index < total) {
        const { json, headers } = await get(`/channels?public_key=${pk}&status=open&index=${index}`);
        total = Number(headers.get('x-total-count') || 0);
        if (!json.length) break;
        for (const c of json) {
          channelIds.add(String(c.id));
          const peer = c.node?.public_key;
          if (peer && !known.has(peer)) { known.add(peer); queue.push(peer); }
        }
        index += json.length;
      }
      nodeChannelCount[pk] = total === Infinity ? 0 : total;
    });
  }

  // 2. Channel details (both directions' policies).
  const chRaw = await pool([...channelIds], (id) => get(`/channels/${id}`).then((r) => r.json));
  const channels = [];
  for (const c of chRaw) {
    if (!c || !c.node_left || !c.node_right) continue;
    channels.push({
      id: String(c.id), short_id: c.short_id, capacity: Number(c.capacity),
      txid: c.transaction_id, vout: c.transaction_vout, status: c.status,
      created: ts(c.created), updated: ts(c.updated_at),
      n1: c.node_left.public_key, n2: c.node_right.public_key,
      p1: policyOf(c.node_left), p2: policyOf(c.node_right), // p1 = what n1 charges to forward n1 -> n2
    });
  }

  // 3. Node details.
  const pks = [...known];
  const nodeRaw = await pool(pks, (pk) => get(`/nodes/${pk}`).then((r) => r.json));
  const nodes = {};
  pks.forEach((pk, i) => {
    const n = nodeRaw[i];
    if (!n) return;
    const sockets = String(n.sockets || '').split(',').map((s) => s.trim()).filter(Boolean);
    nodes[pk] = {
      pk, alias: n.alias || pk.slice(0, 20), color: n.color || null,
      first_seen: ts(n.first_seen), updated: ts(n.updated_at),
      sockets, tor: sockets.some((s) => s.includes('.onion')), clearnet: sockets.some((s) => !s.includes('.onion')),
      country: n.country?.en || null, country_es: n.country?.es || null, iso: n.iso_code || null,
      city: n.city?.en || null, as_org: n.as_organization || null, as_number: n.as_number || null,
      features: (n.features || []).filter((f) => f.is_known).map((f) => f.name),
      capacity: 0, channels: 0, peers: 0,
    };
  });

  // 4. Aggregates per node.
  const adjSet = Object.fromEntries(Object.keys(nodes).map((p) => [p, new Set()]));
  const outFees = {}; const inFees = {}; const outBase = {}; const inBase = {};
  for (const c of channels) {
    for (const [me, other, mine, theirs] of [[c.n1, c.n2, c.p1, c.p2], [c.n2, c.n1, c.p2, c.p1]]) {
      const n = nodes[me];
      if (!n) continue;
      n.capacity += c.capacity; n.channels += 1;
      if (nodes[other]) adjSet[me].add(other);
      if (mine && !mine.disabled) { (outFees[me] ||= []).push(mine.ppm); (outBase[me] ||= []).push(mine.base); }
      if (theirs && !theirs.disabled) { (inFees[me] ||= []).push(theirs.ppm); (inBase[me] ||= []).push(theirs.base); }
      n.newest_channel = Math.max(n.newest_channel || 0, c.created || 0);
    }
  }
  const adj = Object.fromEntries(Object.entries(adjSet).map(([k, v]) => [k, [...v]]));
  const { bc, close } = centrality(Object.keys(nodes), adj);
  for (const n of Object.values(nodes)) {
    n.peers = adj[n.pk].length;
    n.betweenness = bc[n.pk];
    n.closeness = close[n.pk];
    n.fee_out = quantiles(outFees[n.pk] || []);
    n.fee_in = quantiles(inFees[n.pk] || []);
    n.base_out = quantiles(outBase[n.pk] || []);
    n.base_in = quantiles(inBase[n.pk] || []);
  }
  const rank = (key) => Object.values(nodes).sort((a, b) => (b[key] || 0) - (a[key] || 0)).forEach((n, i) => { n[`rank_${key}`] = i + 1; });
  ['capacity', 'channels', 'betweenness', 'peers'].forEach(rank);

  // 5. Network stats.
  const allPpm = []; const allBase = [];
  for (const c of channels) for (const p of [c.p1, c.p2]) if (p && !p.disabled) { allPpm.push(p.ppm); allBase.push(p.base); }
  let latest = null;
  try { latest = (await get('/statistics/latest')).json.latest; } catch { /* optional */ }
  const caps = channels.map((c) => c.capacity);
  const network = {
    nodes: Object.keys(nodes).length,
    nodes_with_channels: Object.values(nodes).filter((n) => n.channels > 0).length,
    channels: channels.length,
    capacity: caps.reduce((a, b) => a + b, 0),
    channel_size: quantiles(caps),
    fee_ppm: quantiles(allPpm),
    base_msat: quantiles(allBase),
    tor_only: Object.values(nodes).filter((n) => n.tor && !n.clearnet).length,
    clearnet_only: Object.values(nodes).filter((n) => n.clearnet && !n.tor).length,
    hybrid: Object.values(nodes).filter((n) => n.clearnet && n.tor).length,
    no_address: Object.values(nodes).filter((n) => !n.sockets.length).length,
    backend: latest,
  };

  // 6. Policy history (diff against last run).
  const prev = readJson('policies.json', null);
  const cur = {};
  const changes = [];
  const now = Math.floor(Date.now() / 1000);
  const FIELDS = ['base', 'ppm', 'cltv', 'min', 'max', 'disabled'];
  for (const c of channels) {
    for (const [dir, from, to, p] of [['1', c.n1, c.n2, c.p1], ['2', c.n2, c.n1, c.p2]]) {
      if (!p) continue;
      const key = `${c.id}:${dir}`;
      cur[key] = { from, to, ...Object.fromEntries(FIELDS.map((f) => [f, p[f]])), updated: p.updated };
      const old = prev?.[key];
      if (prev && !old) {
        changes.push({ t: p.updated || now, seen: now, ch: c.id, short_id: c.short_id, from, to, kind: 'new', new: cur[key] });
      } else if (old) {
        const diff = FIELDS.filter((f) => old[f] !== p[f]);
        if (diff.length) changes.push({ t: p.updated || now, seen: now, ch: c.id, short_id: c.short_id, from, to, kind: 'update', fields: diff, old: Object.fromEntries(FIELDS.map((f) => [f, old[f]])), new: cur[key] });
      }
    }
  }
  if (prev) {
    for (const [key, old] of Object.entries(prev)) {
      if (!cur[key]) changes.push({ t: now, seen: now, ch: key.split(':')[0], from: old.from, to: old.to, kind: 'gone', old });
    }
  }
  if (changes.length) fs.appendFileSync(path.join(DATA_DIR, 'history.jsonl'), changes.map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeAtomic('policies.json', cur);
  let tracking = readJson('status.json', {}).history_since || null;
  if (!tracking) tracking = now;
  let hist = [];
  try {
    hist = fs.readFileSync(path.join(DATA_DIR, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-HISTORY_KEEP).map((l) => JSON.parse(l)).reverse();
  } catch { /* none yet */ }
  writeAtomic('history.json', { since: tracking, generated: now, changes: hist });

  writeAtomic('graph.json', { generated: now, network, nodes: Object.values(nodes), channels });
  writeAtomic('status.json', { running: false, started, finished: new Date().toISOString(), ok: true, history_since: tracking, nodes: network.nodes, channels: network.channels, changes: changes.length });
  log(`ok: ${network.nodes} nodes, ${network.channels} channels, ${changes.length} policy changes`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
for (;;) {
  try { await run(); } catch (e) {
    log('run failed:', e.message);
    writeAtomic('status.json', { ...readJson('status.json', {}), running: false, ok: false, error: e.message, failed: new Date().toISOString() });
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
