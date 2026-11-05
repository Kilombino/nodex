// Public altruist watchtowers listed on Nodex: where they come from and whether they answer.
//
// The list lives in the operator directory file (the same JSON ln-directory writes):
//   nodes[<node pk>].watchtower = '<tower pk>@<host>:<port>'   set by the node's operator on their card
//   watchtowers = [{ operator, uri, node? }]                     kept by hand, for towers without a card
// Every URI is checked again here (ln-directory validates what operators send; the hand-kept list
// is checked only here). The probe is the same as for nodes (lnprobe.mjs): .onion through Tor,
// IPv4/IPv6 only out of AirVPN, never private addresses, and the BOLT 8 act one/two against the
// tower's key, which proves the tower itself answers (LND's tower speaks Brontide too).
//   data/watchtowers.json { generated, towers: { '<uri>': { ok, hs, reason, via, last_try, last_ok, last_hs, recent } } }
import { parseSocket, probeAddress } from './lnprobe.mjs';

export const MAX_TOWERS = 100;
const PK_RE = /^0[23][0-9a-f]{64}$/;

// '<pk>@<socket>' -> { pk, sock } or null. The socket must parse (v3 onion, DNS name, IP).
export function parseTowerUri(uri) {
  if (typeof uri !== 'string' || uri.length > 200) return null;
  const at = uri.indexOf('@');
  if (at !== 66) return null;
  const pk = uri.slice(0, 66).toLowerCase();
  const sock = uri.slice(67);
  if (!PK_RE.test(pk) || !parseSocket(sock)) return null;
  return { pk, sock };
}

// The towers to list / probe, deduplicated by URI: hand-kept ones first, then from the cards.
export function towersFromDirectory(d) {
  const out = []; const seen = new Set();
  const add = (uri, operator, node) => {
    const p = parseTowerUri(typeof uri === 'string' ? uri.trim() : uri);
    if (!p) return;
    const key = `${p.pk}@${p.sock.toLowerCase()}`;
    if (seen.has(key) || out.length >= MAX_TOWERS) return;
    seen.add(key);
    out.push({ uri: key, pk: p.pk, sock: p.sock, operator: typeof operator === 'string' ? operator.slice(0, 40) : '', node: node && PK_RE.test(node) ? node : null });
  };
  for (const w of Array.isArray(d?.watchtowers) ? d.watchtowers : []) if (w && typeof w === 'object') add(w.uri, w.operator, w.node);
  for (const [pk, e] of Object.entries(d?.nodes || {})) if (e?.watchtower) add(e.watchtower, e.name, pk);
  return out;
}

// Probe each tower and fold the result into the previous state. `recent` keeps the last 144
// rounds (24 h) as '1'/'0'; rounds where nothing could be tested (Tor or tunnel down) add nothing.
export async function probeTowers(towers, prev = {}, opts = {}, probe = probeAddress) {
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  let i = 0;
  await Promise.all(Array.from({ length: opts.concurrency || 4 }, async () => {
    while (i < towers.length) {
      const tw = towers[i++];
      const r = await probe(tw.sock, tw.pk, opts);
      const o = prev[tw.uri] || {};
      const x = { ok: r.ok, hs: r.handshake, reason: r.reason || undefined, via: r.via, last_try: o.last_try, last_ok: o.last_ok, last_hs: o.last_hs, recent: o.recent || '' };
      if (r.ok !== null) { x.last_try = now; x.recent = (x.recent + (r.ok ? '1' : '0')).slice(-144); }
      if (r.ok) x.last_ok = now;
      if (r.handshake) x.last_hs = now;
      out[tw.uri] = x;
    }
  }));
  return out;
}
