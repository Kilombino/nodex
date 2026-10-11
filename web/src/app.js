import { DICT } from './i18n.js';

const MEMPOOL = 'https://mempool.kilombino.com';
const $app = document.getElementById('app');

// ---------- i18n ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let lang = new URLSearchParams(location.search).get('lang') || store.get('nodex.lang') || 'en';
if (!DICT[lang]) lang = 'en';
const t = (k, vars = {}) => (DICT[lang][k] ?? DICT.es[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
const loc = () => (lang === 'es' ? 'es-ES' : 'en-GB');

function applyStatic() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.getElementById('lang').textContent = lang === 'es' ? 'EN' : 'ES';
}

// ---------- formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString(loc(), { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const sats = (n) => `${nf(n)} sats`;
function cap(n) {
  if (n == null) return '–';
  if (n >= 1e6) return `${nf(n / 1e8, n >= 1e9 ? 2 : 3)} XBT`;
  return sats(n);
}
const capTitle = (n) => `title="${esc(sats(n))}"`;
const msat = (m) => {
  if (m == null) return '–';
  if (m % 1000 === 0) return `${nf(m / 1000)} sat`;
  return `${nf(m)} msat`;
};
const pct = (x) => (x == null ? '–' : `${nf(x * 100, x < 0.01 ? 2 : 1)} %`);
function dateStr(ts, withTime = false) {
  if (!ts) return '–';
  return new Date(ts * 1000).toLocaleString(loc(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
function ago(ts) {
  if (!ts) return '–';
  const s = Math.round(ts - Date.now() / 1000);
  const rtf = new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' });
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 60) return rtf.format(Math.round(s / 86400), 'day');
  return rtf.format(Math.round(s / (86400 * 30)), 'month');
}
function age(ts) {
  if (!ts) return '–';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`;
  if (d < 60) return `${Math.round(d)} d`;
  return `${nf(d / 30, 1)} ${lang === 'es' ? 'meses' : 'mo'}`;
}
const short = (pk) => `${pk.slice(0, 10)}…${pk.slice(-6)}`;
const blockOf = (sid) => (sid ? Number(String(sid).split('x')[0]) : null);

// ---------- data ----------
let graph = null; let graphAt = 0; let dir = null; let hist = null;
const idx = { node: new Map(), ch: new Map(), chBySid: new Map(), chOf: new Map() };

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function loadGraph(force = false) {
  if (graph && !force && Date.now() - graphAt < 120000) return graph;
  const g = await getJSON('/data/graph.json');
  graph = g; graphAt = Date.now();
  idx.node.clear(); idx.ch.clear(); idx.chBySid.clear(); idx.chOf.clear();
  for (const n of g.nodes) { idx.node.set(n.pk, n); idx.chOf.set(n.pk, []); }
  for (const c of g.channels) {
    idx.ch.set(c.id, c); idx.chBySid.set(c.short_id, c);
    idx.chOf.get(c.n1)?.push(c); idx.chOf.get(c.n2)?.push(c);
  }
  footStatus();
  return g;
}
async function loadDir() {
  if (dir) return dir;
  try { dir = (await getJSON('/resources/lightning-directory.json')).nodes || {}; } catch { dir = {}; }
  return dir;
}
async function loadHist() {
  if (hist && Date.now() - hist._at < 120000) return hist;
  try { hist = await getJSON('/data/history.json'); } catch { hist = { since: null, changes: [] }; }
  hist._at = Date.now();
  return hist;
}
const api = (p) => getJSON(`/api/v1/lightning${p}`);

function footStatus() {
  const el = document.getElementById('foot-status');
  if (!graph) return;
  const stale = Date.now() / 1000 - graph.generated > 3600;
  el.textContent = t(stale ? 'foot.stale' : 'foot.updated', { ago: ago(graph.generated) });
  el.className = stale ? 'err' : '';
}

// ---------- small components ----------
const alias = (pk) => idx.node.get(pk)?.alias || short(pk);
const color = (pk) => idx.node.get(pk)?.color || '#556';
const nodeLink = (pk, label) => `<a href="/node/${esc(pk)}" data-link>${esc(label ?? alias(pk))}</a>`;
const peerCell = (pk) => `<span class="peer"><span class="dot" style="background:${esc(color(pk))}"></span>${nodeLink(pk)}</span>`;
const opName = (pk) => dir?.[pk]?.name;

function feeCell(p) {
  if (!p) return '<span class="dim">–</span>';
  const off = p.disabled ? ` <span class="off">${t('disabled')}</span>` : '';
  return `<span class="fee" title="CLTV ${p.cltv} · min ${esc(msat(p.min))} · max ${esc(msat(p.max))}"><b>${nf(p.ppm)}</b> <span class="u">ppm</span> + ${esc(msat(p.base))}${off}</span>`;
}

function copyBtn(text) {
  return `<button class="copy" type="button" data-copy="${esc(text)}">${t('node.copy')}</button>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const v = b.dataset.copy;
  try { await navigator.clipboard.writeText(v); } catch {
    const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  b.textContent = t('node.copied'); b.classList.add('ok');
  setTimeout(() => { b.textContent = t('node.copy'); b.classList.remove('ok'); }, 1400);
});

function initials(a) {
  const w = String(a || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return esc(((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase());
}

// Sortable table. cols: [{k, label, v(row) -> sort value, h(row) -> html, r: right-aligned, cls}]
function sortable(el, cols, rows, { key, asc = false, onRow } = {}) {
  let sk = key ?? cols[0].k; let sa = asc;
  const draw = () => {
    const c = cols.find((x) => x.k === sk);
    const sorted = [...rows].sort((a, b) => {
      const x = c.v(a); const y = c.v(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'string' ? x.localeCompare(y, loc(), { sensitivity: 'base' }) : x - y;
      return sa ? r : -r;
    });
    el.innerHTML = `<div class="tablewrap"><table><thead><tr>${cols.map((x) => `<th class="${x.v ? 'sort' : ''} ${x.r ? 'r' : ''} ${x.cls || ''} ${x.k === sk ? 'on' : ''} ${x.k === sk && sa ? 'asc' : ''}" data-k="${x.k}" ${x.title ? `title="${esc(x.title)}"` : ''}>${x.label}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map((row, i) => `<tr>${cols.map((x) => `<td class="${x.r ? 'r' : ''} ${x.cls || ''}">${x.h(row, i)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="mute">${t('sr.none')}</td></tr>`}</tbody></table></div>`;
    el.querySelectorAll('th.sort').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (k === sk) sa = !sa; else { sk = k; sa = !!cols.find((x) => x.k === k).asc; }
      draw();
      onRow?.(sk, sa);
    }));
  };
  draw();
  return { set(r) { rows = r; draw(); } };
}

// Tiny two-series line chart (SVG, no libs). pts: [{x, a, b}]
function lineChart(pts, la, lb, fa = (v) => v, fb = (v) => v) {
  if (!pts || pts.length < 2) return `<p class="mute small">–</p>`;
  const W = 600; const H = 160; const P = 6;
  const xs = pts.map((p) => p.x); const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  const path = (key) => {
    const vs = pts.map((p) => p[key]); const lo = Math.min(...vs) * 0.97; const hi = Math.max(...vs) * 1.01 || 1;
    return pts.map((p, i) => `${i ? 'L' : 'M'}${(P + ((p.x - x0) / (x1 - x0 || 1)) * (W - 2 * P)).toFixed(1)},${(H - 18 - ((p[key] - lo) / (hi - lo || 1)) * (H - 30)).toFixed(1)}`).join('');
  };
  const last = pts[pts.length - 1];
  return `<div class="chart"><div class="legend"><span><i style="background:var(--acc)"></i>${la}: <b>${fa(last.a)}</b></span><span><i style="background:var(--acc2)"></i>${lb}: <b>${fb(last.b)}</b></span></div>
  <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(la)} / ${esc(lb)}">
    <path d="${path('a')}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="${path('b')}" fill="none" stroke="var(--acc2)" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
  </svg><div class="legend" style="justify-content:space-between"><span>${dateStr(x0)}</span><span>${dateStr(x1)}</span></div></div>`;
}

function quant(q, unit = 'ppm') {
  if (!q) return `<p class="mute">–</p>`;
  const max = Math.max(q.max, 1);
  const pos = (v) => `${Math.min(100, (Math.log1p(v) / Math.log1p(max)) * 100).toFixed(1)}%`;
  return `<div class="quant">
    <div><div class="k">${t('q.min')}</div><div class="v">${nf(q.min)}</div></div>
    <div><div class="k">${t('q.median')}</div><div class="v">${nf(q.median, 1)}</div></div>
    <div><div class="k">${t('q.avg')}</div><div class="v">${nf(q.avg, 1)}</div></div>
    <div><div class="k">${t('q.max')}</div><div class="v">${nf(q.max)}</div></div>
  </div><div class="feebar" title="p25–p75 · ${unit}"><span style="left:${pos(q.p25)};right:calc(100% - ${pos(q.p75)})"></span><i style="left:${pos(q.median)}"></i></div>
  <div class="small dim">${unit} · n=${q.n}</div>`;
}

// ---------- pages ----------
function setNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
}
const setTitle = (s) => { document.title = s ? `${s} · Nodex` : 'Nodex · Lightning XBT'; };

function topList(nodes, val) {
  return `<ol class="toplist">${nodes.map((n) => `<li><span class="dot" style="background:${esc(n.color || '#556')}"></span><span class="who">${nodeLink(n.pk)}${opName(n.pk) && opName(n.pk) !== n.alias ? ` <span class="dim small">· ${esc(opName(n.pk))}</span>` : ''}</span><span class="val">${val(n)}</span></li>`).join('')}</ol>`;
}

function changeText(c) {
  if (c.kind === 'new') return `<span class="mute">${t('act.new')}</span> ${feeCell(c.new)}`;
  if (c.kind === 'gone') return `<span class="mute">${t('act.gone')}</span>`;
  const parts = [];
  for (const f of c.fields || []) {
    const o = c.old[f]; const n = c.new[f];
    if (f === 'disabled') { parts.push(n ? `<span class="off">${t('act.disabled')}</span>` : `<span class="down">${t('act.enabled')}</span>`); continue; }
    const fmtv = f === 'ppm' ? (v) => `${nf(v)} ppm` : f === 'cltv' ? (v) => `CLTV ${v}` : (v) => (f === 'base' ? `base ${msat(v)}` : `${f} ${msat(v)}`);
    const cls = typeof o === 'number' && typeof n === 'number' && f !== 'max' ? (n > o ? 'up' : 'down') : '';
    parts.push(`<span class="chg ${cls}">${esc(fmtv(o))} → ${esc(fmtv(n))}</span>`);
  }
  return parts.join(' · ');
}
// A channel side switched off or on and nothing else: what a node does when its peer goes
// offline and comes back. Real, but noise next to fee changes, so the network-wide feeds skip it.
const feeChange = (c) => !(c.kind === 'update' && (c.fields || []).every((f) => f === 'disabled'));
function feedList(changes) {
  if (!changes.length) return `<p class="mute">${t('node.history.none')}</p>`;
  return `<ul class="feed">${changes.map((c) => `<li><time title="${esc(dateStr(c.t, true))}">${esc(ago(c.t))}</time>
    <span>${nodeLink(c.from)} → ${nodeLink(c.to)}</span>
    <span class="small"><a href="/channel/${esc(c.ch)}" data-link class="mono">${esc(c.short_id || c.ch)}</a></span>
    <span>${changeText(c)}</span></li>`).join('')}</ul>`;
}

async function pageHome() {
  setNav('home'); setTitle('');
  const [g] = await Promise.all([loadGraph(), loadDir()]);
  const N = g.network; const nodes = g.nodes.filter((n) => n.channels > 0);
  const top = (k, n = 8) => [...nodes].sort((a, b) => (b[k] || 0) - (a[k] || 0)).slice(0, n);
  const newest = [...g.nodes].sort((a, b) => (b.first_seen || 0) - (a.first_seen || 0)).slice(0, 8);
  const ops = g.nodes.filter((n) => dir[n.pk]).sort((a, b) => b.capacity - a.capacity).slice(0, 8);
  const newCh = [...g.channels].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 8);
  // By the median fee a node charges to route out (ppm), among nodes that route at all.
  const withFee = nodes.filter((n) => Number.isFinite(n.fee_out?.median));
  const byFee = (asc) => [...withFee].sort((a, b) => (asc ? 1 : -1) * (a.fee_out.median - b.fee_out.median) || (b.capacity || 0) - (a.capacity || 0)).slice(0, 8);
  const feeVal = (n) => `${nf(n.fee_out.median, 1)} ppm`;
  $app.innerHTML = `
  <section class="hero">
    <h1>${t('hero.title')}</h1>
    <p>${t('hero.sub')}</p>
    <form class="bigsearch" id="bigsearch"><input type="search" name="q" autocomplete="off" spellcheck="false" placeholder="${esc(t('search.ph'))}"><button class="btn">${t('search.go')}</button></form>
  </section>
  <div class="grid stats">
    <div class="stat"><div class="k">${t('st.nodes')}</div><div class="v">${nf(N.nodes)}</div><div class="s">${t('st.nodes.s', { n: N.no_address })}</div></div>
    <div class="stat"><div class="k">${t('st.channels')}</div><div class="v">${nf(N.channels)}</div><div class="s">${t('st.avgch', { v: nf(N.channels * 2 / Math.max(1, N.nodes_with_channels), 1) })} ${lang === 'es' ? 'por nodo' : 'per node'}</div></div>
    <div class="stat"><div class="k">${t('st.capacity')}</div><div class="v" ${capTitle(N.capacity)}>${cap(N.capacity)}</div><div class="s">${t('st.avgch', { v: cap(N.channel_size?.avg) })}</div></div>
    <div class="stat"><div class="k">${t('st.chsize')}</div><div class="v">${cap(N.channel_size?.median)}</div><div class="s">p25 ${cap(N.channel_size?.p25)} · p75 ${cap(N.channel_size?.p75)}</div></div>
    <div class="stat"><div class="k">${t('st.avgfee')}</div><div class="v">${nf(N.fee_ppm?.avg, 1)} <small class="dim">ppm</small></div><div class="s">${t('st.fee.s', { n: nf(N.fee_ppm?.n) })}</div></div>
    <div class="stat"><div class="k">${t('st.medfee')}</div><div class="v">${nf(N.fee_ppm?.median, 1)} <small class="dim">ppm</small></div><div class="s">${t('st.medbase')}: ${msat(N.base_msat?.median)}</div></div>
    <div class="stat"><div class="k">${t('st.tor')}</div><div class="v">${nf(N.tor_only)}</div><div class="s">${pct(N.tor_only / Math.max(1, N.nodes))}</div></div>
    <div class="stat"><div class="k">${t('st.clear')}</div><div class="v">${nf(N.clearnet_only + N.hybrid)}</div><div class="s">${t('st.clear.s', { c: N.clearnet_only, h: N.hybrid })}</div></div>
  </div>
  <div class="grid cols2">
    <div class="card"><h2>${t('top.capacity')} <a href="/rankings/capacity" data-link>${t('top.all')} →</a></h2>${topList(top('capacity'), (n) => `<span ${capTitle(n.capacity)}>${cap(n.capacity)}</span>`)}</div>
    <div class="card"><h2>${t('top.channels')} <a href="/rankings/channels" data-link>${t('top.all')} →</a></h2>${topList(top('channels'), (n) => `${nf(n.channels)} ${t('u.ch')} · ${nf(n.peers)} ${t('col.peers').toLowerCase()}`)}</div>
    <div class="card"><h2><span title="${esc(t('top.central.help'))}">${t('top.central')} <span class="help">?</span></span> <a href="/rankings/central" data-link>${t('top.all')} →</a></h2>${topList(top('betweenness'), (n) => pct(n.betweenness))}</div>
    <div class="card"><h2>${t('top.newest')} <a href="/rankings/age" data-link>${t('top.all')} →</a></h2>${topList(newest, (n) => `<span title="${esc(dateStr(n.first_seen, true))}">${esc(ago(n.first_seen))}</span>`)}</div>
    <div class="card"><h2>${t('top.expensive')} <a href="/rankings/expensive" data-link>${t('top.all')} →</a></h2>${topList(byFee(false), feeVal)}</div>
    <div class="card"><h2>${t('top.cheap')} <a href="/rankings/cheap" data-link>${t('top.all')} →</a></h2>${topList(byFee(true), feeVal)}</div>
  </div>
  <div class="grid cols2 section">
    <div class="card"><h2>${t('chart.title')}</h2><div id="netchart" class="loading">${t('loading')}</div></div>
    <div class="card"><h2>${t('top.directory')} <a href="${MEMPOOL}/${lang === 'es' ? 'es/' : ''}lightning/directory" rel="noopener">${lang === 'es' ? 'directorio' : 'directory'} →</a></h2>${ops.length ? topList(ops, (n) => cap(n.capacity)) : `<p class="mute">–</p>`}</div>
  </div>
  <div class="grid cols2 section">
    <div class="card"><h2>${t('top.newch')} <a href="/activity" data-link>${t('nav.activity')} →</a></h2>
      <ul class="feed">${newCh.map((c) => `<li><time title="${esc(dateStr(c.created, true))}">${esc(ago(c.created))}</time><span>${nodeLink(c.n1)} ⇄ ${nodeLink(c.n2)}</span><span class="val small" ${capTitle(c.capacity)}>${cap(c.capacity)}</span></li>`).join('')}</ul></div>
    <div class="card"><h2>${t('top.changes')} <a href="/activity" data-link>${t('nav.activity')} →</a></h2><div id="homefeed" class="loading">${t('loading')}</div></div>
  </div>`;
  bindSearch(document.getElementById('bigsearch'));
  api('/statistics/all').then((s) => {
    const pts = s.map((r) => ({ x: r.added, a: r.total_capacity, b: r.channel_count })).sort((a, b) => a.x - b.x);
    const el = document.getElementById('netchart');
    if (el) { el.className = ''; el.innerHTML = lineChart(pts, t('chart.cap'), t('chart.ch'), cap, nf); }
  }).catch(() => { const el = document.getElementById('netchart'); if (el) el.textContent = '–'; });
  loadHist().then((h) => {
    const el = document.getElementById('homefeed');
    if (!el) return;
    el.className = '';
    el.innerHTML = feedList(h.changes.filter((c) => c.kind === 'update' && feeChange(c)).slice(0, 8)) + (h.since ? `<p class="small dim">${t('node.history.note', { since: dateStr(h.since) })}</p>` : '');
  });
}

function opCard(pk) {
  const e = dir?.[pk];
  const editUrl = `${MEMPOOL}/es/lightning/directory?node=${encodeURIComponent(pk)}`;
  if (!e) {
    return `<div class="card"><h2>${t('node.op')}</h2><div class="empty"><p style="margin:0 0 8px"><b>${t('node.op.none')}</b></p><p class="small" style="margin:0 0 10px">${t('node.op.none.s')}</p>
      <a class="btn sm" href="${esc(editUrl)}" rel="noopener">${t('node.op.none')} →</a></div></div>`;
  }
  const C = e.contacts || {};
  const link = (href, label) => `<a href="${esc(href)}" rel="noopener noreferrer nofollow" target="_blank">${esc(label)}</a>`;
  const rows = [];
  if (C.website && /^https:\/\//.test(C.website)) rows.push(['Web', link(C.website, C.website.replace(/^https:\/\//, ''))]);
  if (C.nostr) rows.push(['Nostr', link(`https://njump.me/${C.nostr}`, `${C.nostr.slice(0, 14)}…${C.nostr.slice(-6)}`) + ' ' + copyBtn(C.nostr)]);
  if (C.lightning_address) rows.push(['Lightning', link(`lightning:${C.lightning_address}`, C.lightning_address)]);
  if (C.telegram) rows.push(['Telegram', link(`https://t.me/${C.telegram.replace(/^@/, '')}`, C.telegram)]);
  if (C.x) rows.push(['X', link(`https://x.com/${C.x.replace(/^@/, '')}`, C.x)]);
  if (C.email) rows.push(['Email', link(`mailto:${C.email}`, C.email)]);
  if (C.discord) rows.push(['Discord', /^https:\/\//.test(C.discord) ? link(C.discord, C.discord) : `<span>${esc(C.discord)}</span> ${copyBtn(C.discord)}`]);
  if (C.simplex) rows.push(['SimpleX', /^https:\/\//.test(C.simplex) ? link(C.simplex, 'SimpleX') : `${copyBtn(C.simplex)}`]);
  return `<div class="card opcard"><h2>${t('node.op')} <a href="${esc(editUrl)}" rel="noopener">${t('node.op.edit')} ✎</a></h2>
    ${e.name ? `<div class="name">${esc(e.name)}</div>` : ''}
    ${e.description ? `<p style="margin:6px 0">${esc(e.description)}</p>` : ''}
    ${e.tags?.length ? `<div class="tags">${e.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
    ${rows.length ? `<div class="contacts">${rows.map(([k, v]) => `<div><span class="ck">${k}</span>${v}</div>`).join('')}</div>` : ''}
    <dl class="kv" style="margin-top:10px">
      ${e.min_channel_size ? `<dt>${t('node.op.min')}</dt><dd>${cap(e.min_channel_size)}</dd>` : ''}
      ${e.since ? `<dt>${t('node.op.since')}</dt><dd>${esc(e.since)}</dd>` : ''}
    </dl></div>`;
}

async function pageNode(pk) {
  setNav('');
  pk = String(pk).toLowerCase();
  const [g] = await Promise.all([loadGraph(), loadDir()]);
  let n = idx.node.get(pk);
  if (!n) {
    try {
      const r = await api(`/nodes/${pk}`);
      n = { pk, alias: r.alias, color: r.color, first_seen: r.first_seen, updated: r.updated_at, sockets: String(r.sockets || '').split(',').filter(Boolean), capacity: 0, channels: 0, peers: 0, features: [], missing: true };
    } catch {
      $app.innerHTML = `<p class="err">${t('node.notfound')}</p><p class="mono small">${esc(pk)}</p>`;
      return;
    }
  }
  setTitle(n.alias);
  const chans = (idx.chOf.get(pk) || []).map((c) => {
    const mine = c.n1 === pk;
    return { c, peer: mine ? c.n2 : c.n1, out: mine ? c.p1 : c.p2, inn: mine ? c.p2 : c.p1 };
  });
  const sock = n.sockets || [];
  const rankB = (k, label) => (n[`rank_${k}`] && n[`rank_${k}`] <= 10 ? `<span class="badge rank">${t('node.rank', { n: n[`rank_${k}`], what: label })}</span>` : '');
  $app.innerHTML = `
  <section class="nodehead">
    <div class="avatar" style="background:${esc(n.color || '#556')}">${initials(n.alias)}</div>
    <div class="t">
      <h1>${esc(n.alias)}</h1>
      <div class="pk"><code>${esc(pk)}</code>${copyBtn(pk)}</div>
      <div class="badges">
        ${n.tor ? `<span class="badge tor">${t('tor')}</span>` : ''}${n.clearnet ? `<span class="badge net">${t('clearnet')}</span>` : ''}
        ${dir[pk] ? `<span class="badge ok">✓ ${t('node.op')}</span>` : ''}
        ${rankB('capacity', t('rk.capacity').toLowerCase())}${rankB('channels', t('rk.channels').toLowerCase())}${rankB('betweenness', t('rk.central').toLowerCase())}
      </div>
    </div>
    <a class="btn ghost sm" href="${MEMPOOL}/lightning/node/${esc(pk)}" rel="noopener">${t('node.onmempool')} ↗</a>
  </section>
  ${n.missing ? `<p class="note">${t('node.notingraph')}</p>` : ''}
  <div class="grid stats">
    <div class="stat"><div class="k">${t('node.capacity')}</div><div class="v" ${capTitle(n.capacity)}>${cap(n.capacity)}</div><div class="s">${n.rank_capacity ? `#${n.rank_capacity} / ${g.network.nodes}` : ''}</div></div>
    <div class="stat"><div class="k">${t('node.channels')}</div><div class="v">${nf(n.channels)}</div><div class="s">${n.rank_channels ? `#${n.rank_channels} / ${g.network.nodes}` : ''}</div></div>
    <div class="stat"><div class="k">${t('node.peers')}</div><div class="v">${nf(n.peers)}</div><div class="s">${n.channels ? `${t('st.avgch', { v: cap(n.capacity / n.channels) })}` : ''}</div></div>
    <div class="stat"><div class="k" title="${esc(t('top.central.help'))}">${t('node.central')} <span class="help">?</span></div><div class="v">${pct(n.betweenness)}</div><div class="s">${n.rank_betweenness ? `#${n.rank_betweenness} / ${g.network.nodes}` : ''}</div></div>
  </div>
  <div class="grid cols2">
    <div class="card">
      <dl class="kv">
        <dt>${t('node.addresses')}</dt><dd>${sock.length ? sock.map((s) => `<div class="addr"><span class="badge ${s.includes('.onion') ? 'tor' : 'net'}">${s.includes('.onion') ? 'Tor' : s.startsWith('[') ? 'IPv6' : 'IPv4'}</span><code>${esc(s)}</code>${copyBtn(`${pk}@${s}`)}</div>`).join('') : `<span class="mute">${t('node.noaddr')}</span>`}</dd>
        <dt>${t('node.firstseen')}</dt><dd>${dateStr(n.first_seen, true)} <span class="dim">(${esc(ago(n.first_seen))})</span></dd>
        <dt>${t('node.updated')}</dt><dd>${dateStr(n.updated, true)} <span class="dim">(${esc(ago(n.updated))})</span></dd>
        ${n.city || n.country ? `<dt>${t('node.location')}</dt><dd>${esc([n.city, lang === 'es' ? (n.country_es || n.country) : n.country].filter(Boolean).join(', '))}</dd>` : ''}
        ${n.as_org ? `<dt>${t('node.isp')}</dt><dd>${esc(n.as_org)} <span class="dim">AS${esc(n.as_number)}</span></dd>` : ''}
        ${n.features?.length ? `<dt>${t('node.features')}</dt><dd class="small mute">${n.features.map(esc).join(', ')}</dd>` : ''}
      </dl>
    </div>
    ${opCard(pk)}
  </div>
  <div class="grid cols3 section">
    <div class="card"><h2>${t('node.feesout')}</h2><div class="small mute">${t('node.feesout.s')}</div>${quant(n.fee_out)}</div>
    <div class="card"><h2>${t('node.feesin')}</h2><div class="small mute">${t('node.feesin.s')}</div>${quant(n.fee_in)}</div>
    <div class="card"><h2>${t('node.growth')}</h2><div id="nodechart" class="loading">${t('loading')}</div></div>
  </div>
  <section class="section"><h2>${t('node.chlist', { n: chans.length })}</h2><div id="chtable"></div></section>
  <section class="section card"><h2>${t('node.history')}</h2><div id="nodehist" class="loading">${t('loading')}</div></section>`;

  sortable(document.getElementById('chtable'), [
    { k: 'peer', label: t('col.peer'), v: (r) => alias(r.peer), h: (r) => peerCell(r.peer) + (opName(r.peer) && opName(r.peer) !== alias(r.peer) ? `<div class="small dim">${esc(opName(r.peer))}</div>` : ''), asc: true },
    { k: 'cap', label: t('col.capacity'), v: (r) => r.c.capacity, h: (r) => `<span class="num" ${capTitle(r.c.capacity)}>${cap(r.c.capacity)}</span>`, r: true },
    { k: 'age', label: t('col.age'), v: (r) => -(blockOf(r.c.short_id) || 0), h: (r) => `<span title="${esc(dateStr(r.c.created, true))}">${age(r.c.created)}</span>`, r: true },
    { k: 'out', label: t('col.out'), title: t('node.feesout.s'), v: (r) => r.out?.ppm, h: (r) => feeCell(r.out), r: true },
    { k: 'in', label: t('col.in'), title: t('node.feesin.s'), v: (r) => r.inn?.ppm, h: (r) => feeCell(r.inn), r: true },
    { k: 'cltv', label: t('col.cltv'), v: (r) => r.out?.cltv, h: (r) => `<span class="num">${r.out?.cltv ?? '–'} / ${r.inn?.cltv ?? '–'}</span>`, r: true, cls: 'hide-m' },
    { k: 'fund', label: t('col.funding'), v: (r) => blockOf(r.c.short_id), h: (r) => `<a class="mono small" href="/channel/${esc(r.c.id)}" data-link>${esc(r.c.short_id)}</a> <a class="small" href="${MEMPOOL}/tx/${esc(r.c.txid)}:${esc(r.c.vout)}" rel="noopener" title="${esc(t('ch.funding'))}">tx ↗</a>`, cls: 'hide-m nowrap' },
  ], chans, { key: 'cap' });

  api(`/nodes/${pk}/statistics`).then((s) => {
    const el = document.getElementById('nodechart');
    if (!el) return;
    el.className = '';
    el.innerHTML = lineChart(s.map((r) => ({ x: r.added, a: r.capacity, b: r.channels })).sort((a, b) => a.x - b.x), t('chart.cap'), t('chart.ch'), cap, nf);
  }).catch(() => { const el = document.getElementById('nodechart'); if (el) el.textContent = '–'; });

  loadHist().then((h) => {
    const el = document.getElementById('nodehist');
    if (!el) return;
    el.className = '';
    const mine = h.changes.filter((c) => c.from === pk || c.to === pk).slice(0, 100);
    const lastUpd = chans.map((r) => r.out?.updated).filter(Boolean).sort((a, b) => b - a)[0];
    el.innerHTML = `<p class="note">${t('node.history.note', { since: h.since ? dateStr(h.since, true) : '–' })}${lastUpd ? ` · ${t('ch.updated')}: ${esc(dateStr(lastUpd, true))}` : ''}</p>${feedList(mine)}`;
  });
}

async function pageChannel(id) {
  setNav('');
  await Promise.all([loadGraph(), loadDir()]);
  let c = idx.ch.get(String(id)) || idx.chBySid.get(String(id));
  let raw = null;
  if (!c) {
    try {
      raw = await api(`/channels/${encodeURIComponent(id)}`);
      c = { id: raw.id, short_id: raw.short_id, capacity: raw.capacity, txid: raw.transaction_id, vout: raw.transaction_vout, created: Date.parse(raw.created) / 1000, status: raw.status, n1: raw.node_left?.public_key, n2: raw.node_right?.public_key, closed: raw.closing_date };
    } catch { $app.innerHTML = `<p class="err">${t('ch.notfound')}</p>`; return; }
  }
  setTitle(c.short_id);
  const pol = (p, a, b) => `<div class="card"><h2>${t('ch.policy', { a: esc(alias(a)) })}</h2><div class="small mute">${t('ch.policy.s', { a: esc(alias(a)), b: esc(alias(b)) })}</div>
    ${p ? `<dl class="kv" style="margin-top:10px">
      <dt>${t('ch.ppm')}</dt><dd><b>${nf(p.ppm)}</b> ppm ${p.disabled ? `<span class="off">${t('ch.disabled')}</span>` : ''}</dd>
      <dt>${t('ch.base')}</dt><dd>${esc(msat(p.base))}</dd><dt>${t('ch.cltv')}</dt><dd>${p.cltv}</dd>
      <dt>${t('ch.minhtlc')}</dt><dd>${esc(msat(p.min))}</dd><dt>${t('ch.maxhtlc')}</dt><dd>${esc(msat(p.max))}</dd>
      <dt>${t('ch.updated')}</dt><dd>${dateStr(p.updated, true)} <span class="dim">(${esc(ago(p.updated))})</span></dd></dl>` : '<p class="mute">–</p>'}</div>`;
  $app.innerHTML = `<h1>${t('ch.title', { id: `<span class="mono">${esc(c.short_id)}</span>` })}</h1>
    <p>${peerCell(c.n1)} ⇄ ${peerCell(c.n2)}</p>
    ${c.closed ? `<p class="note">${t('act.gone')}</p>` : ''}
    <div class="grid stats">
      <div class="stat"><div class="k">${t('ch.capacity')}</div><div class="v" ${capTitle(c.capacity)}>${cap(c.capacity)}</div><div class="s">${esc(sats(c.capacity))}</div></div>
      <div class="stat"><div class="k">${t('ch.block')}</div><div class="v"><a href="${MEMPOOL}/block/${blockOf(c.short_id)}" rel="noopener">${nf(blockOf(c.short_id))}</a></div><div class="s">${t('ch.opened')} ${esc(ago(c.created))}</div></div>
    </div>
    <p>${t('ch.funding')}: <a class="mono small" style="word-break:break-all" href="${MEMPOOL}/tx/${esc(c.txid)}:${esc(c.vout)}" rel="noopener">${esc(c.txid)}:${esc(c.vout)}</a></p>
    <div class="grid cols2">${pol(c.p1, c.n1, c.n2)}${pol(c.p2, c.n2, c.n1)}</div>
    <section class="section card"><h2>${t('node.history')}</h2><div id="chhist"></div></section>`;
  const h = await loadHist();
  const el = document.getElementById('chhist');
  if (el) el.innerHTML = feedList(h.changes.filter((x) => x.ch === String(c.id)));
}

const METRICS = {
  capacity: 'cap', channels: 'ch', central: 'bc', peers: 'peers', cheap: 'out', expensive: 'out', age: 'first',
};
// The fee tabs sort by the median outbound fee; only nodes that charge one are listed there.
const FEE_TABS = { cheap: true, expensive: false };
async function pageRankings(metric = 'capacity') {
  setNav('rankings'); setTitle(t('rk.title'));
  const g = await loadGraph(); await loadDir();
  if (!METRICS[metric]) metric = 'capacity';
  let all = g.nodes.filter((n) => n.channels > 0);
  if (metric in FEE_TABS) all = all.filter((n) => Number.isFinite(n.fee_out?.median));
  $app.innerHTML = `<h1>${t('rk.title')}</h1><p class="mute">${t('rk.sub')}</p>
    <div class="tabs">${Object.keys(METRICS).map((m) => `<a class="tab ${m === metric ? 'on' : ''}" href="/rankings/${m}" data-link>${t(`rk.${m}`)}</a>`).join('')}</div>
    <input type="text" id="rkfilter" placeholder="${esc(t('rk.filter'))}" style="max-width:320px;width:100%;margin-bottom:10px">
    <div id="rktable"></div>`;
  const cols = [
    { k: 'pos', label: '#', h: (r, i) => `<span class="dim num">${i + 1}</span>` },
    { k: 'name', label: t('col.node'), v: (r) => r.alias, h: (r) => `<span class="peer"><span class="dot" style="background:${esc(r.color || '#556')}"></span>${nodeLink(r.pk)}</span>${opName(r.pk) && opName(r.pk) !== r.alias ? `<div class="small dim">${esc(opName(r.pk))}</div>` : ''}`, asc: true },
    { k: 'cap', label: t('col.capacity'), v: (r) => r.capacity, h: (r) => `<span class="num" ${capTitle(r.capacity)}>${cap(r.capacity)}</span>`, r: true },
    { k: 'ch', label: t('col.channels'), v: (r) => r.channels, h: (r) => `<span class="num">${nf(r.channels)}</span>`, r: true },
    { k: 'peers', label: t('col.peers'), v: (r) => r.peers, h: (r) => `<span class="num">${nf(r.peers)}</span>`, r: true, cls: 'hide-m' },
    { k: 'bc', label: t('col.central'), title: t('top.central.help'), v: (r) => r.betweenness, h: (r) => `<span class="num">${pct(r.betweenness)}</span>`, r: true },
    { k: 'out', label: t('col.outmed'), v: (r) => r.fee_out?.median, h: (r) => `<span class="num">${nf(r.fee_out?.median, 1)}</span>`, r: true, asc: true },
    { k: 'in', label: t('col.inmed'), v: (r) => r.fee_in?.median, h: (r) => `<span class="num">${nf(r.fee_in?.median, 1)}</span>`, r: true, asc: true, cls: 'hide-m' },
    { k: 'net', label: t('col.net'), h: (r) => `${r.tor ? '<span class="badge tor">Tor</span> ' : ''}${r.clearnet ? '<span class="badge net">IP</span>' : ''}`, cls: 'hide-m nowrap' },
    { k: 'first', label: t('col.first'), v: (r) => r.first_seen, h: (r) => `<span class="small" title="${esc(dateStr(r.first_seen, true))}">${dateStr(r.first_seen)}</span>`, r: true, asc: true, cls: 'hide-m' },
  ];
  const key = METRICS[metric];
  const asc = metric in FEE_TABS ? FEE_TABS[metric] : !!cols.find((c) => c.k === key).asc;
  const tbl = sortable(document.getElementById('rktable'), cols, all, { key, asc });
  document.getElementById('rkfilter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    tbl.set(q ? all.filter((n) => n.alias.toLowerCase().includes(q) || n.pk.startsWith(q) || (opName(n.pk) || '').toLowerCase().includes(q)) : all);
  });
}

async function pageActivity() {
  setNav('activity'); setTitle(t('act.title'));
  const [g, h] = await Promise.all([loadGraph(), loadHist(), loadDir()]);
  const newCh = [...g.channels].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 40);
  $app.innerHTML = `<h1>${t('act.title')}</h1><p class="mute">${t('act.sub')}</p>
    <p class="note">${t('node.history.note', { since: h.since ? dateStr(h.since, true) : '–' })}</p>
    <div class="grid cols2">
      <div class="card"><h2>${t('top.changes')}</h2>${feedList(h.changes.filter(feeChange).slice(0, 150))}</div>
      <div class="card"><h2>${t('top.newch')}</h2><ul class="feed">${newCh.map((c) => `<li><time title="${esc(dateStr(c.created, true))}">${esc(ago(c.created))}</time><span>${nodeLink(c.n1)} ⇄ ${nodeLink(c.n2)}</span><span class="small"><a class="mono" href="/channel/${esc(c.id)}" data-link>${esc(c.short_id)}</a> · <span ${capTitle(c.capacity)}>${cap(c.capacity)}</span></span></li>`).join('')}</ul></div>
    </div>`;
}

async function pageSearch(q) {
  setNav(''); setTitle(q);
  q = String(q || '').trim();
  const [g] = await Promise.all([loadGraph(), loadDir()]);
  const ql = q.toLowerCase();
  if (/^[0-9a-f]{66}$/.test(ql)) return go(`/node/${ql}`, true);
  if (/^\d+x\d+x\d+$/.test(ql) && idx.chBySid.has(ql)) return go(`/channel/${idx.chBySid.get(ql).id}`, true);
  if (/^\d{15,20}$/.test(ql) && idx.ch.has(ql)) return go(`/channel/${ql}`, true);
  const nodes = ql ? g.nodes.filter((n) => n.alias.toLowerCase().includes(ql) || n.pk.startsWith(ql) || (opName(n.pk) || '').toLowerCase().includes(ql) || (n.sockets || []).some((s) => s.toLowerCase().includes(ql))) : [];
  const chans = ql.length >= 3 ? g.channels.filter((c) => c.short_id.startsWith(ql) || c.id.startsWith(ql) || c.txid.startsWith(ql)).slice(0, 30) : [];
  if (ql.length >= 2) {
    try {
      const r = await api(`/search?searchText=${encodeURIComponent(q)}`);
      for (const n of r.nodes || []) if (!nodes.some((x) => x.pk === n.public_key)) nodes.push({ pk: n.public_key, alias: n.alias, capacity: n.capacity, channels: n.channels });
      for (const c of r.channels || []) if (!chans.some((x) => String(x.id) === String(c.id))) chans.push(idx.ch.get(String(c.id)) || { id: c.id, short_id: c.short_id, capacity: c.capacity });
    } catch { /* local results only */ }
  }
  if (nodes.length === 1 && !chans.length) return go(`/node/${nodes[0].pk}`, true);
  if (chans.length === 1 && !nodes.length) return go(`/channel/${chans[0].id}`, true);
  $app.innerHTML = `<h1>${t('sr.title', { q: esc(q) })}</h1>
    ${!nodes.length && !chans.length ? `<p class="mute">${t('sr.none')}</p>` : ''}
    ${nodes.length ? `<div class="card section"><h2>${t('sr.nodes')} (${nodes.length})</h2>${topList(nodes.sort((a, b) => (b.capacity || 0) - (a.capacity || 0)), (n) => `${cap(n.capacity)} · ${nf(n.channels)} ${t('u.ch')}`)}</div>` : ''}
    ${chans.length ? `<div class="card section"><h2>${t('sr.channels')} (${chans.length})</h2><ul class="feed">${chans.map((c) => `<li><a class="mono" href="/channel/${esc(c.id)}" data-link>${esc(c.short_id)}</a>${c.n1 ? `<span>${nodeLink(c.n1)} ⇄ ${nodeLink(c.n2)}</span>` : ''}<span class="val small">${cap(c.capacity)}</span></li>`).join('')}</ul></div>` : ''}`;
}

// ---------- suggestions as you type ----------
function suggestNodes(q) {
  q = q.trim().toLowerCase();
  if (!q || !graph) return [];
  const out = [];
  for (const n of graph.nodes) {
    const alias = (n.alias || '').toLowerCase(); const op = (opName(n.pk) || '').toLowerCase();
    let score = -1;
    if (alias.startsWith(q) || op.startsWith(q)) score = 3;
    else if (alias.split(/[\s_.-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (alias.includes(q) || op.includes(q)) score = 1;
    else if (n.pk.startsWith(q)) score = 1;
    // One letter: only names starting with it (or a word in them); from two on, anywhere.
    if (score >= 0 && (q.length > 1 || score >= 2)) out.push([score, n]);
  }
  return out.sort((a, b) => b[0] - a[0] || (b[1].capacity || 0) - (a[1].capacity || 0)).slice(0, 8).map((x) => x[1]);
}
function attachSuggest(form) {
  const input = form?.querySelector('input'); if (!input) return;
  form.style.position = 'relative';
  const box = document.createElement('ul'); box.className = 'suggest'; box.hidden = true; form.appendChild(box);
  let items = []; let sel = -1;
  const close = () => { box.hidden = true; sel = -1; };
  const draw = () => {
    box.innerHTML = items.map((n, i) => `<li class="${i === sel ? 'on' : ''}" data-pk="${esc(n.pk)}"><span class="dot" style="background:${esc(n.color || '#556')}"></span><span class="sa">${esc(n.alias || n.pk.slice(0, 16))}${opName(n.pk) && opName(n.pk) !== n.alias ? ` <span class="dim">· ${esc(opName(n.pk))}</span>` : ''}</span><span class="sv dim small">${cap(n.capacity)}</span></li>`).join('');
    box.hidden = !items.length;
  };
  input.addEventListener('input', async () => {
    if (!graph) { try { await loadGraph(); } catch { return; } }
    items = suggestNodes(input.value); sel = -1; draw();
  });
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(-1, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); const pk = items[sel].pk; close(); input.value = ''; input.blur(); go(`/node/${pk}`); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    e.preventDefault(); close(); input.value = ''; input.blur(); go(`/node/${li.dataset.pk}`);
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- router ----------
function bindSearch(form) {
  attachSuggest(form);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(form).get('q')?.toString().trim();
    if (q) { form.querySelector('input').blur(); go(`/search?q=${encodeURIComponent(q)}`); }
  });
}

async function route() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const qs = new URLSearchParams(location.search);
  window.scrollTo(0, 0);
  $app.innerHTML = `<p class="loading">${t('loading')}</p>`;
  try {
    let m;
    if (p === '/') await pageHome();
    else if ((m = p.match(/^\/node\/([0-9a-fA-F]{66})$/))) await pageNode(m[1]);
    else if ((m = p.match(/^\/channel\/([0-9x]+)$/))) await pageChannel(m[1]);
    else if ((m = p.match(/^\/rankings(?:\/(\w+))?$/))) await pageRankings(m[1]);
    else if (p === '/activity') await pageActivity();
    else if (p === '/search') await pageSearch(qs.get('q'));
    else { $app.innerHTML = '<h1>404</h1>'; }
  } catch (e) {
    $app.innerHTML = `<p class="err">${esc(t('error', { e: e.message }))}</p>`;
  }
}
function go(url, replace = false) {
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', route);
document.getElementById('lang').addEventListener('click', () => {
  lang = lang === 'es' ? 'en' : 'es';
  store.set('nodex.lang', lang);
  const u = new URL(location.href); u.searchParams.delete('lang'); history.replaceState(null, '', u.pathname + u.search);
  applyStatic(); footStatus(); route();
});
bindSearch(document.getElementById('topsearch'));
setInterval(() => { loadGraph(true).catch(() => {}); }, 5 * 60 * 1000);
applyStatic();
route();
