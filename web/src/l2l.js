// Lightning2Lightning: channel rings between node operators, with a reputation read from the
// chain. The API is ln-directory's (/api/ln-directory/l2l/*), proxied same-origin by nginx; the
// login is the directory's own (the node signs a one-time text), so the same session serves the
// operator card and the rings. Everything users write is shown as text, never as HTML.

const API = '/api/ln-directory';
const MEMPOOL_ORIGIN = 'https://mempool.kilombino.com';

export function initL2L(h) {
  const { t, esc, nf, cap, dateStr, ago, nodeLink, copyBtn, setNav, setTitle, loadGraph, go, app } = h;
  const lang = () => h.lang();
  const msDate = (ms, time = true) => (ms ? dateStr(ms / 1000, time) : '–');
  const msAgo = (ms) => (ms ? ago(ms / 1000) : '–');
  let me = null; let cfg = null;

  async function req(method, path, body, csrf) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-LnDir-CSRF'] = csrf;
    const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let j = {};
    try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok || j.ok === false) { const e = new Error(j.message || `HTTP ${r.status}`); e.code = j.error; e.data = j; throw e; }
    return j;
  }
  const act = (method, path, body = {}) => req(method, path, body, me?.csrf);
  async function loadMe(force = false) {
    if (!me || force) { try { me = await req('GET', '/l2l/me'); } catch { me = { logged_in: false }; } }
    return me;
  }
  async function loadCfg() {
    if (!cfg) { try { cfg = await req('GET', '/l2l/config'); } catch { cfg = { bot: null, limits: {}, defaults: {}, handoff_from: [] }; } }
    return cfg;
  }
  function errText(e) {
    const k = `l2l.err.${e.code}`;
    const v = t(k);
    let s = v !== k ? v : e.message;
    if (e.data?.unmet?.length) s += ` ${e.data.unmet.map(unmetText).join(' · ')}`;
    return s;
  }
  const unmetText = (u) => t(`l2l.unmet.${u.req}`, { need: u.req === 'min_capacity' ? cap(u.need) : nf(u.need), have: u.req === 'min_capacity' ? cap(u.have) : nf(u.have) });
  const stateBadge = (s) => `<span class="badge l2l-st st-${esc(s)}">${esc(t(`l2l.state.${s}`))}</span>`;
  const scoreBadge = (n) => (n == null ? '' : `<span class="l2l-sc ${n >= 70 ? 'hi' : n >= 40 ? 'mid' : 'lo'}" title="${esc(t('l2l.score'))}">${nf(n)}</span>`);
  const opName = (pk, nodes) => { const n = h.dirEntry(pk)?.name; return n && n !== nodes?.[pk]?.alias ? ` <span class="small dim">· ${esc(n)}</span>` : ''; };
  const who = (pk, nodes) => `${nodeLink(pk, nodes?.[pk]?.alias || undefined)}${opName(pk, nodes)}${nodes?.[pk] ? ` ${scoreBadge(nodes[pk].score)}` : ''}`;
  const msgBox = (id) => `<div id="${id}" class="l2l-msg" role="status"></div>`;
  function say(id, text, ok = false) {
    const el = document.getElementById(id);
    if (el) { el.className = `l2l-msg ${ok ? 'ok' : 'err'}`; el.textContent = text; }
  }

  // ---------- login box / my profile ----------
  async function renderMe(el) {
    await Promise.all([loadMe(), loadCfg()]);
    if (!me.logged_in) {
      const peer = (cfg.handoff_from || []).find((o) => o === MEMPOOL_ORIGIN) || (cfg.handoff_from || [])[0];
      el.innerHTML = `<h2>${t('l2l.login')}</h2><p class="small mute">${t('l2l.login.s')}</p>
        <div class="l2l-row"><button class="btn sm" type="button" id="l2l-login-start">${t('l2l.login.start')}</button>
        ${peer ? `<button class="btn ghost sm" type="button" id="l2l-handoff" data-from="${esc(peer)}">${esc(t('l2l.login.handoff', { site: peer.replace(/^https?:\/\//, '') }))}</button>` : ''}</div>
        <div id="l2l-login-steps"></div>${msgBox('l2l-login-msg')}`;
      el.querySelector('#l2l-login-start').addEventListener('click', () => loginSteps(el));
      el.querySelector('#l2l-handoff')?.addEventListener('click', async (e) => {
        try {
          const r = await req('POST', '/handoff/begin', { from: e.currentTarget.dataset.from, back: '/l2l' }, 'login');
          location.href = r.url;
        } catch (err) { say('l2l-login-msg', errText(err)); }
      });
      return;
    }
    const tg = me.telegram || {};
    await h.loadDir();
    const card = h.dirEntry(me.pubkey);
    el.innerHTML = `<h2>${t('l2l.me')}</h2>
      <div class="l2l-me"><div><b>${nodeLink(me.pubkey, me.alias || undefined)}</b> ${scoreBadge(me.score)}</div>
      <div class="small mute mono">${esc(me.pubkey.slice(0, 20))}…</div></div>
      <div class="l2l-mycard opcard">${card ? h.opCardBody(card) : `<p class="mute small">${t('node.op.nocard.mine')}</p>`}</div>
      <dl class="kv" style="margin-top:10px">
        <dt>${t('l2l.tg')}</dt><dd id="l2l-tg">${tg.linked ? `<span class="badge ok">${t('l2l.tg.on')}</span> <button class="copy" type="button" id="l2l-tg-off">${t('l2l.tg.off')}</button>`
          : tg.bot ? `<button class="btn sm" type="button" id="l2l-tg-link">${t('l2l.tg.link')}</button>` : `<span class="mute small">${t('l2l.tg.none')}</span>`}</dd>
        <dt>${t('node.op')}</dt><dd><a href="/card" data-link id="l2l-edit-card">${t(card ? 'node.op.edit' : 'node.op.add')} ✎</a></dd>
      </dl>
      <div class="l2l-row"><a class="btn ghost sm" href="/node/${esc(me.pubkey)}" data-link>${t('l2l.myrep')}</a>
      <button class="btn ghost sm" type="button" id="l2l-logout">${t('l2l.logout')}</button></div>${msgBox('l2l-me-msg')}`;
    el.querySelector('#l2l-logout').addEventListener('click', async () => {
      try { await act('POST', '/logout'); } catch { /* gone anyway */ }
      me = null; renderMe(el); route();
    });
    el.querySelector('#l2l-tg-off')?.addEventListener('click', async () => {
      try { await act('DELETE', '/l2l/telegram'); await loadMe(true); renderMe(el); } catch (e) { say('l2l-me-msg', errText(e)); }
    });
    el.querySelector('#l2l-tg-link')?.addEventListener('click', async () => {
      try {
        const r = await act('POST', '/l2l/telegram/link');
        const box = el.querySelector('#l2l-tg');
        box.innerHTML = `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(t('l2l.tg.open', { bot: `@${me.telegram.bot}` }))} ↗</a>
          <div class="small mute">${esc(t('l2l.tg.wait', { when: msDate(r.expires) }))}</div>`;
        const until = Date.now() + 15 * 60 * 1000;
        const poll = setInterval(async () => {
          if (!document.body.contains(box) || Date.now() > until) { clearInterval(poll); return; }
          await loadMe(true);
          if (me.telegram?.linked) { clearInterval(poll); renderMe(el); }
        }, 3000);
      } catch (e) { say('l2l-me-msg', errText(e)); }
    });
  }

  async function loginSteps(el) {
    const box = el.querySelector('#l2l-login-steps');
    try {
      const c = await req('POST', '/login/challenge', {}, 'login');
      const cmd = `lncli signmessage "${c.text}"`;
      box.innerHTML = `<ol class="l2l-steps">
        <li>${t('l2l.login.sign')}<div class="l2l-code"><code>${esc(c.text)}</code>${copyBtn(c.text)}</div>
          <div class="small mute">${t('l2l.login.cmd')}</div><div class="l2l-code"><code>${esc(cmd)}</code>${copyBtn(cmd)}</div>
          <div class="small mute">${esc(t('l2l.login.valid', { when: c.expires.replace('T', ' ').replace('Z', ' UTC') }))}</div></li>
        <li><label for="l2l-sig">${t('l2l.login.paste')}</label><textarea id="l2l-sig" rows="3" spellcheck="false" autocomplete="off" maxlength="300"></textarea>
          <button class="btn sm" type="button" id="l2l-login-go">${t('l2l.login.go')}</button></li></ol>`;
      box.querySelector('#l2l-login-go').addEventListener('click', async () => {
        try {
          let sig = box.querySelector('#l2l-sig').value.trim();
          try { sig = JSON.parse(sig).signature || sig; } catch { /* plain signature */ }
          await req('POST', '/login', { challenge: c.text, signature: sig }, 'login');
          me = null; route();
        } catch (e) { say('l2l-login-msg', errText(e)); }
      });
    } catch (e) { say('l2l-login-msg', errText(e)); }
  }

  // ---------- list + create ----------
  const TABS = ['open', 'active', 'done', 'mine'];
  function reqSummary(q) {
    const parts = [];
    if (q.min_channels) parts.push(t('l2l.req.ch', { n: nf(q.min_channels) }));
    if (q.min_capacity) parts.push(t('l2l.req.cap', { v: cap(q.min_capacity) }));
    if (q.min_age_days) parts.push(t('l2l.req.age', { n: nf(q.min_age_days) }));
    if (q.min_score) parts.push(t('l2l.req.score', { n: nf(q.min_score) }));
    return parts.length ? parts.map(esc).join(' · ') : `<span class="dim">${t('l2l.req.none')}</span>`;
  }
  function ringRows(list, nodes) {
    if (!list.length) return `<p class="mute">${t('l2l.none')}</p>`;
    return `<div class="tablewrap"><table><thead><tr><th>${t('l2l.col.ring')}</th><th>${t('l2l.col.state')}</th><th>${t('l2l.col.members')}</th>
      <th class="r">${t('l2l.col.cap')}</th><th class="hide-m">${t('l2l.col.req')}</th><th class="r">${t('l2l.col.when')}</th></tr></thead><tbody>
      ${list.map((r) => {
        const when = r.state === 'open' ? [t('l2l.dl.fill'), r.fill_deadline] : r.state === 'opening' ? [t('l2l.dl.open'), r.open_deadline] : [t('l2l.created'), r.created_at];
        return `<tr><td><a class="mono" href="/l2l/ring/${esc(r.id)}" data-link>${esc(r.id)}</a></td><td>${stateBadge(r.state)}</td>
        <td><span class="num">${r.members.length}/${r.size}</span> <span class="small">${r.members.map((pk) => nodeLink(pk, nodes[pk]?.alias || undefined)).join(', ')}</span></td>
        <td class="r num">${cap(r.capacity)}<div class="small dim">${esc(t('l2l.commit.short', { n: r.commit_days || 30 }))}</div></td><td class="small hide-m">${reqSummary(r.req)}</td>
        <td class="r small nowrap" title="${esc(msDate(when[1]))}">${esc(when[0])} ${esc(msAgo(when[1]))}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  function createForm() {
    const L = cfg.limits || {}; const D = cfg.defaults || {};
    const opt = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${v}</option>`).join('');
    const field = (key, control, wide = false) => `<label class="${wide ? 'wide' : ''}"><span>${t(`l2l.f.${key}`)}</span>${control}<small class="l2l-hint">${t(`l2l.f.${key}.h`)}</small></label>`;
    return `<section class="section card"><h2>${t('l2l.create')}</h2><p class="small mute">${t('l2l.create.s')}</p>
      <form id="l2l-create" class="l2l-form" autocomplete="off">
        ${field('size', `<select name="size">${opt(L.minSize || 2, L.maxSize || 5, D.size || 3)}</select>`)}
        ${field('cap', `<input type="number" name="capacity" min="${L.minCapacity || 20000}" max="${L.maxCapacity || 1e9}" step="1" required placeholder="1000000">`)}
        ${field('open', `<select name="open_days">${opt(1, L.maxOpenDays || 14, D.open_days || 3)}</select>`)}
        ${field('fill', `<select name="fill_days">${opt(1, L.maxFillDays || 30, D.fill_days || 7)}</select>`)}
        ${field('commit', `<input type="number" name="commit_days" min="${L.minCommitDays || 7}" max="${L.maxCommitDays || 365}" step="1" value="${D.commit_days || 30}" required>`)}
        ${field('minch', '<input type="number" name="min_channels" min="0" step="1" placeholder="0">')}
        ${field('mincap', '<input type="number" name="min_capacity" min="0" step="1" placeholder="0">')}
        ${field('minage', '<input type="number" name="min_age_days" min="0" step="1" placeholder="0">')}
        ${field('minscore', '<input type="number" name="min_score" min="0" max="100" step="1" placeholder="0">')}
        ${field('note', `<textarea name="note" rows="2" maxlength="${L.note || 280}"></textarea>`, true)}
        <div class="wide"><button class="btn" type="submit">${t('l2l.create.go')}</button></div>
      </form>${msgBox('l2l-create-msg')}</section>`;
  }

  async function pageL2L(tab = 'open') {
    setNav('l2l'); setTitle('Lightning2Lightning');
    if (!TABS.includes(tab)) tab = 'open';
    await Promise.all([loadGraph(), loadMe(true), loadCfg()]);
    const ho = new URLSearchParams(location.search).get('handoff');
    if (ho) history.replaceState(null, '', location.pathname);
    app.innerHTML = `<section class="hero l2l-hero"><h1>Lightning2Lightning</h1><p>${t('l2l.sub')}</p></section>
      ${ho ? `<p class="l2l-msg ${ho === 'ok' ? 'ok' : 'err'}">${esc(t(`l2l.handoff.${ho === 'ok' ? 'ok' : ho === 'none' ? 'none' : 'failed'}`))}</p>` : ''}
      <div class="grid cols2">
        <div class="card"><h2>${t('l2l.how')}</h2><ol class="l2l-steps"><li>${t('l2l.how1')}</li><li>${t('l2l.how2')}</li><li>${t('l2l.how3')}</li><li>${t('l2l.how4')}</li></ol></div>
        <div class="card" id="l2l-me"></div>
      </div>
      <div class="tabs section">${TABS.filter((x) => x !== 'mine' || me.logged_in).map((x) => `<a class="tab ${x === tab ? 'on' : ''}" href="/l2l${x === 'open' ? '' : `/${x}`}" data-link>${t(`l2l.tab.${x}`)}</a>`).join('')}</div>
      <div id="l2l-list" class="loading">${t('loading')}</div>
      ${me.logged_in ? createForm() : ''}`;
    renderMe(document.getElementById('l2l-me'));
    req('GET', `/l2l/rings?filter=${tab}`).then((r) => {
      const el = document.getElementById('l2l-list');
      if (el) { el.className = ''; el.innerHTML = ringRows(r.rings, r.nodes || {}); }
    }).catch((e) => { const el = document.getElementById('l2l-list'); if (el) el.textContent = errText(e); });
    document.getElementById('l2l-create')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target); const ring = {};
      for (const [k, v] of f.entries()) { const s = String(v).trim(); if (s === '') continue; ring[k] = k === 'note' ? s : Number(s); }
      try { const r = await act('POST', '/l2l/rings', { ring }); go(`/l2l/ring/${r.ring.id}`); } catch (err) { say('l2l-create-msg', errText(err)); }
    });
  }

  // ---------- ring detail ----------
  async function pageRing(id) {
    setNav('l2l');
    const [, r] = await Promise.all([loadGraph(), req('GET', `/l2l/rings/${encodeURIComponent(id)}`), loadMe(true), h.loadDir()]);
    const g = r.ring; const nodes = r.nodes; const m = r.me;
    setTitle(`${t('l2l.ring')} ${g.id}`);
    const deadline = g.state === 'open' ? [t('l2l.fillby'), g.fill_deadline] : [t('l2l.openby'), g.open_deadline];
    const asg = g.assignments || [];
    const statusTag = (a) => `<span class="ktag ${a.status === 'opened' ? 'k-down' : a.status === 'missed' ? 'k-off' : 'k-chg'}">${esc(t(`l2l.as.${a.status}`))}</span>`;
    const chanInfo = (c) => (c ? ` <a class="mono small" href="/channel/${esc(c.id)}" data-link>${esc(c.short_id)}</a> <span class="small dim" title="${esc(t(`l2l.proof.${c.proof}.s`))}">· ${esc(t(`l2l.proof.${c.proof}`))}</span>${c.closed_at ? ` <span class="ktag ${c.penalty ? 'k-off' : 'k-chg'}">${esc(t(c.early ? 'l2l.closed.early' : 'l2l.closed'))}${c.close_type === 'force' ? ` · ${esc(t('l2l.closed.force'))}` : c.close_type === 'mutual' ? ` · ${esc(t('l2l.closed.coop'))}` : ''}</span>` : ''}${c.penalty ? ` <span class="ktag ${c.penalty.status === 'confirmed' ? 'k-off' : c.penalty.status === 'pending' ? 'k-up' : 'k-down'}" title="${esc(t('l2l.pen.s'))}">${esc(t(`l2l.pen.${c.penalty.status}${c.penalty.expired ? '.exp' : ''}`))}</span>` : ''}` : '');
    app.innerHTML = `<p class="small"><a href="/l2l" data-link>← Lightning2Lightning</a></p>
      <h1>${t('l2l.ring')} <span class="mono">${esc(g.id)}</span> ${stateBadge(g.state)}</h1>
      <div class="grid stats">
        <div class="stat"><div class="k">${t('l2l.col.cap')}</div><div class="v">${cap(g.capacity)}</div><div class="s">${t('l2l.cap.s')}</div></div>
        <div class="stat"><div class="k">${t('l2l.col.members')}</div><div class="v">${g.members.length}/${g.size}</div><div class="s">${t('l2l.byx', { a: nodeLink(g.creator, nodes[g.creator]?.alias || undefined) })}</div></div>
        <div class="stat"><div class="k">${esc(deadline[0])}</div><div class="v small">${esc(msDate(deadline[1]))}</div><div class="s">${esc(msAgo(deadline[1]))} · ${esc(t('l2l.opendays', { n: g.open_days }))}</div></div>
        <div class="stat"><div class="k">${t('l2l.commit')}</div><div class="v">${nf(g.min_lifetime_days || 30)} <small class="dim">${t('l2l.days')}</small></div><div class="s">${t('l2l.commit.s')}</div></div>
      </div>
      ${g.note ? `<div class="card section"><p class="l2l-text">${esc(g.note)}</p></div>` : ''}
      <div class="grid cols2 section">
        <div class="card"><h2>${t('l2l.col.req')}</h2><p>${reqSummary(g.req)}</p><div id="ring-me"></div>${msgBox('ring-msg')}</div>
        <div class="card"><h2>${asg.length ? t('l2l.order') : t('l2l.col.members')}</h2>
          ${asg.length ? `<ul class="feed l2l-order">${asg.map((a) => `<li><span>${who(a.from, nodes)} → ${who(a.to, nodes)}</span><span>${statusTag(a)}${chanInfo(a.channel)}</span></li>`).join('')}</ul>
            <p class="small dim">${t('l2l.order.s')}</p>`
          : `<ul class="feed">${g.members.map((x) => `<li><span>${who(x.pk, nodes)}</span><time>${esc(msAgo(x.joined_at))}</time></li>`).join('')}</ul>`}</div>
      </div>
      <section class="section card"><h2>${t('l2l.events')}</h2><ul class="feed">${[...g.events].reverse().slice(0, 40).map((e) => `<li><time title="${esc(msDate(e.t))}">${esc(msAgo(e.t))}</time><span>${esc(t(`l2l.ev.${e.kind}`))}${e.pk ? ` · ${nodeLink(e.pk, nodes[e.pk]?.alias || undefined)}` : ''}${e.to ? ` → ${nodeLink(e.to, nodes[e.to]?.alias || undefined)}` : ''}</span></li>`).join('')}</ul></section>
      <div id="ring-comment"></div>`;

    const box = document.getElementById('ring-me');
    const button = (a, label, cls = 'btn sm') => `<button class="${cls}" type="button" data-act="${a}">${esc(label)}</button>`;
    if (!m) {
      box.innerHTML = g.state === 'open' ? `<p class="small"><a href="/l2l" data-link>${t('l2l.login.tojoin')}</a></p>` : '';
    } else if (g.state === 'open') {
      if (m.member) box.innerHTML = `<p class="small ok">${t('l2l.you.in')}</p>${m.creator ? button('cancel', t('l2l.cancel'), 'btn ghost sm') : button('leave', t('l2l.leave'), 'btn ghost sm')}`;
      else if (m.unmet?.length) box.innerHTML = `<p class="small err">${t('l2l.you.unmet')}</p><ul class="small">${m.unmet.map((u) => `<li>${esc(unmetText(u))}</li>`).join('')}</ul>`;
      else box.innerHTML = `<p class="small">${esc(t('l2l.join.s', { cap: cap(g.capacity), days: g.open_days, commit: g.min_lifetime_days || 30 }))}</p>${button('join', t('l2l.join'))}`;
    } else if (m.mine && g.state === 'opening' && m.mine.status === 'pending') {
      const peer = m.mine.to;
      const c1 = `lncli connect ${m.mine.uri}`;
      const c2 = `lncli openchannel --node_key ${peer} --local_amt ${g.capacity}`;
      box.innerHTML = `<div class="l2l-turn"><p><b>${t('l2l.turn', { cap: esc(cap(g.capacity)), a: nodeLink(peer, nodes[peer]?.alias || undefined) })}</b></p>
        <div class="l2l-code"><code>${esc(m.mine.uri)}</code>${copyBtn(m.mine.uri, t('node.copyuri'))}</div>
        <div class="l2l-code"><code>${esc(c1)}</code>${copyBtn(c1)}</div><div class="l2l-code"><code>${esc(c2)}</code>${copyBtn(c2)}</div>
        <p class="small mute">${t('l2l.turn.s', { when: esc(msDate(g.open_deadline)) })}</p></div>`;
    } else if (m.mine) {
      box.innerHTML = `<p class="small">${t('l2l.you.status', { s: esc(t(`l2l.as.${m.mine.status}`)) })}</p>`;
    }
    if (m?.penalties?.length) {
      box.insertAdjacentHTML('beforeend', m.penalties.map((p) => `<div class="note l2l-pen"><p class="small">${t('l2l.pen.ask', { a: nodeLink(p.from, nodes[p.from]?.alias || undefined), sid: esc(p.short_id), when: esc(msDate(p.until)) })}</p>
        <div class="l2l-row"><button class="btn sm" type="button" data-penalty="${esc(p.channel)}" data-accept="1">${t('l2l.pen.apply')}</button>
        <button class="btn ghost sm" type="button" data-penalty="${esc(p.channel)}" data-accept="0">${t('l2l.pen.forgive')}</button></div></div>`).join(''));
    }
    if (m?.confirmable?.length) {
      box.insertAdjacentHTML('beforeend', `<div class="note"><p class="small">${t('l2l.confirm.s')}</p>${m.confirmable.map((c) => `<div class="l2l-row"><a class="mono small" href="/channel/${esc(c.id)}" data-link>${esc(c.short_id)}</a> <span class="small">${cap(c.capacity)}</span> <button class="btn ghost sm" type="button" data-confirm="${esc(c.id)}">${t('l2l.confirm')}</button></div>`).join('')}</div>`);
    }
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act],[data-confirm],[data-penalty]');
      if (!b) return;
      if (b.dataset.act === 'cancel' && !confirm(t('l2l.cancel.q'))) return;
      if (b.dataset.act === 'join' && !confirm(t('l2l.join.q', { cap: cap(g.capacity), days: g.open_days, commit: g.min_lifetime_days || 30 }))) return;
      b.disabled = true;
      try {
        if (b.dataset.penalty) {
          if (!confirm(t(b.dataset.accept === '1' ? 'l2l.pen.apply.q' : 'l2l.pen.forgive.q'))) { b.disabled = false; return; }
          await act('POST', `/l2l/rings/${g.id}/penalty`, { channel: b.dataset.penalty, accept: b.dataset.accept === '1' });
        } else if (b.dataset.confirm) await act('POST', `/l2l/rings/${g.id}/confirm`, { channel: b.dataset.confirm });
        else await act('POST', `/l2l/rings/${g.id}/${b.dataset.act}`);
        pageRing(g.id);
      } catch (err) { b.disabled = false; say('ring-msg', errText(err)); }
    });

    // Comments: members about members, once the ring filled. Text only, no weight.
    const others = g.members.map((x) => x.pk).filter((pk) => pk !== m?.pk);
    if (m?.member && ['opening', 'complete', 'failed'].includes(g.state) && others.length) {
      const el = document.getElementById('ring-comment');
      el.innerHTML = `<section class="section card"><h2>${t('l2l.comment')}</h2><p class="small mute">${t('l2l.comment.s')}</p>
        <form id="l2l-cform" class="l2l-form" autocomplete="off"><label>${t('l2l.comment.about')}<select name="about">${others.map((pk) => `<option value="${esc(pk)}">${esc(nodes[pk]?.alias || pk.slice(0, 16))}</option>`).join('')}</select></label>
        <label class="wide">${t('l2l.comment.text')}<textarea name="text" rows="2" maxlength="280" required></textarea></label>
        <div class="wide"><button class="btn sm" type="submit">${t('l2l.comment.go')}</button></div></form>${msgBox('l2l-cmsg')}</section>`;
      el.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try { await act('POST', '/l2l/comments', { ring: g.id, about: f.get('about'), text: f.get('text') }); e.target.reset(); say('l2l-cmsg', t('l2l.comment.ok'), true); } catch (err) { say('l2l-cmsg', errText(err)); }
      });
    }
  }

  // ---------- the operator card editor (same API and checks as the mempool directory) ----------
  const CONTACTS = ['telegram', 'nostr', 'email', 'website', 'lightning_address', 'x', 'discord', 'simplex'];
  async function pageCard() {
    setNav(''); setTitle(t('card.title'));
    await loadCfg();
    let d;
    try { d = await req('GET', '/me'); } catch { d = { logged_in: false }; }
    if (!d.logged_in) {
      app.innerHTML = `<h1>${t('card.title')}</h1><p class="mute">${t('card.sub')}</p><div class="grid cols2"><div class="card" id="l2l-me"></div></div>`;
      me = null;
      renderMe(document.getElementById('l2l-me'));
      return;
    }
    const e = d.entry || {}; const c = e.contacts || {};
    const input = (name, val, attrs = '') => `<input type="text" name="${name}" value="${esc(val ?? '')}" ${attrs}>`;
    const field = (key, control, wide = false) => `<label class="${wide ? 'wide' : ''}" data-field="${key}"><span>${t(`card.f.${key}`)}</span>${control}<small class="l2l-hint">${t(`card.f.${key}.h`)}</small></label>`;
    app.innerHTML = `<p class="small"><a href="/node/${esc(d.pubkey)}" data-link>← ${esc(d.alias || d.pubkey.slice(0, 16))}</a></p>
      <h1>${t('card.title')}</h1><p class="mute">${t(d.entry ? 'card.sub.edit' : 'card.sub.new', { a: esc(d.alias || d.pubkey.slice(0, 16)) })}</p>
      <section class="card"><form id="card-form" class="l2l-form" autocomplete="off">
        ${field('name', input('name', e.name, 'maxlength="40"'))}
        ${field('tags', input('tags', (e.tags || []).join(', '), 'maxlength="140"'))}
        ${field('min_channel_size', `<input type="number" name="min_channel_size" min="0" step="1" value="${esc(e.min_channel_size ?? '')}">`)}
        ${field('description', `<textarea name="description" rows="4" maxlength="500">${esc(e.description || '')}</textarea>`, true)}
        ${field('watchtower', input('watchtower', e.watchtower, 'maxlength="200" spellcheck="false" autocapitalize="off" class="mono" placeholder="02…@….onion:9911"'), true)}
        <div class="wide"><h3>${t('card.contacts')}</h3><p class="small mute">${t('card.contacts.s')}</p></div>
        ${CONTACTS.map((k) => field(k, input(`c.${k}`, c[k], `maxlength="${k === 'simplex' ? 1000 : 200}"`))).join('')}
        <div class="wide l2l-row"><button class="btn" type="submit" id="card-save">${t('card.save')}</button>
          ${d.entry ? `<button class="btn ghost sm" type="button" id="card-delete">${t('card.delete')}</button>` : ''}
          <a class="small" href="/node/${esc(d.pubkey)}" data-link>${t('card.view')}</a></div>
      </form>${msgBox('card-msg')}</section>`;
    const form = document.getElementById('card-form');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      form.querySelectorAll('.bad').forEach((x) => x.classList.remove('bad'));
      const f = new FormData(form); const entry = {}; const contacts = {};
      const v = (k) => String(f.get(k) || '').trim();
      if (v('name')) entry.name = v('name');
      if (String(f.get('description') || '').trim()) entry.description = String(f.get('description'));
      const tags = v('tags').split(',').map((x) => x.trim()).filter(Boolean);
      if (tags.length) entry.tags = tags;
      if (v('min_channel_size')) entry.min_channel_size = Number(v('min_channel_size'));
      entry.watchtower = v('watchtower'); // always sent: empty removes it
      for (const k of CONTACTS) if (v(`c.${k}`)) contacts[k] = v(`c.${k}`);
      if (Object.keys(contacts).length) entry.contacts = contacts;
      try {
        const r = await req('PUT', '/card', { entry }, d.csrf);
        h.resetDir();
        say('card-msg', t(`card.saved.${r.result}`), true);
        if (r.result === 'new') setTimeout(() => pageCard(), 800);
      } catch (err) {
        const fld = err.data?.field;
        const lab = fld && form.querySelector(`[data-field="${CSS.escape(fld)}"]`);
        if (lab) { lab.classList.add('bad'); lab.querySelector('input,textarea')?.focus(); }
        say('card-msg', err.code === 'bad_entry' ? `${lab ? lab.querySelector('span').textContent : fld}: ${err.data.reason}` : errText(err));
      }
    });
    document.getElementById('card-delete')?.addEventListener('click', async () => {
      if (!confirm(t('card.delete.q'))) return;
      try { await req('DELETE', '/card', undefined, d.csrf); h.resetDir(); say('card-msg', t('card.deleted'), true); setTimeout(() => pageCard(), 800); } catch (err) { say('card-msg', errText(err)); }
    });
  }

  // ---------- reputation on node pages ----------
  const nodeCardShell = () => `<section class="section card" id="l2l-rep"><h2>${t('l2l.rep')} <a href="/l2l" data-link>Lightning2Lightning →</a></h2><div class="loading">${t('loading')}</div></section>`;
  async function fillNodeCard(pk) {
    const el = document.getElementById('l2l-rep');
    if (!el) return;
    let r;
    try { r = await req('GET', `/l2l/nodes/${pk}`); } catch { el.querySelector('.loading').textContent = '–'; return; }
    const part = (p) => {
      const label = p.k === 'uptime' ? t('l2l.p.uptime', { v: `${nf(p.v * 100, 1)} %` }) : t(`l2l.p.${p.k}`, { n: p.n });
      return `<li><span>${esc(label)}</span><span class="val num ${p.pts > 0 && p.k !== 'base' ? 'l2l-pos' : p.pts < 0 ? 'l2l-neg' : ''}">${p.k === 'base' ? '' : p.pts > 0 ? '+' : ''}${nf(p.pts)}</span></li>`;
    };
    const ringLine = (x) => `<li><span><a class="mono" href="/l2l/ring/${esc(x.id)}" data-link>${esc(x.id)}</a> ${stateBadge(x.state)} <span class="small">${cap(x.capacity)}</span></span>
      <span class="small">${x.to ? `→ ${nodeLink(x.to, r.nodes[x.to]?.alias || undefined)}: ${esc(t(`l2l.as.${x.status}`))}${x.channel?.short_id ? ` <span class="mono">${esc(x.channel.short_id)}</span>` : ''}${x.channel?.closed_at ? ` <span class="ktag k-chg">${esc(t(x.channel.early ? 'l2l.closed.early' : 'l2l.closed'))}</span>` : ''}${x.channel?.penalty ? ` <span class="ktag ${x.channel.penalty === 'confirmed' ? 'k-off' : 'k-down'}">${esc(t(`l2l.pen.${x.channel.penalty}`))}</span>` : ''}` : `<span class="dim">${t('l2l.waiting')}</span>`}</span></li>`;
    el.innerHTML = `<h2>${t('l2l.rep')} <a href="/l2l" data-link>Lightning2Lightning →</a></h2>
      <div class="grid cols3">
        <div><div class="l2l-big">${scoreBadge(r.score)}<span class="dim">/100</span></div><ul class="feed l2l-parts">${r.parts.map(part).join('')}</ul>
          <p class="small dim">${t('l2l.rep.note')}</p></div>
        <div><h3>${t('l2l.history')}</h3>${r.rings.length ? `<ul class="feed">${r.rings.slice(0, 30).map(ringLine).join('')}</ul>` : `<p class="mute small">${t('l2l.history.none')}</p>`}</div>
        <div><h3>${t('l2l.comments')}</h3>${r.comments.length ? `<ul class="feed">${r.comments.slice(0, 30).map((c) => `<li><span>${nodeLink(c.from, c.from_alias)} <span class="small dim">· <a class="mono" href="/l2l/ring/${esc(c.ring)}" data-link>${esc(c.ring)}</a> · ${esc(msAgo(c.at))}</span><span class="l2l-text small" style="display:block">${esc(c.text)}</span></span></li>`).join('')}</ul>` : `<p class="mute small">${t('l2l.comments.none')}</p>`}
          <p class="small dim">${t('l2l.comments.s')}</p></div>
      </div>`;
  }

  // Edit / add-card links on node pages, only for the node's own operator.
  async function fillOwnerLinks() {
    const spots = [...document.querySelectorAll('.op-own')];
    if (!spots.length) return;
    await loadMe();
    for (const el of spots) {
      if (me.logged_in && me.pubkey === el.dataset.pk) el.innerHTML = `<a href="/card" data-link>${t(el.dataset.has === '1' ? 'node.op.edit' : 'node.op.add')} ✎</a>`;
      else if (!me.logged_in && el.dataset.has !== '1') el.innerHTML = `<a class="small" href="/card" data-link>${t('node.op.mine')}</a>`;
    }
  }

  let route = () => {};
  return {
    pageL2L, pageRing, pageCard, nodeCardShell, fillNodeCard, fillOwnerLinks,
    setRoute(fn) { route = fn; },
    resetSession() { me = null; },
  };
}
