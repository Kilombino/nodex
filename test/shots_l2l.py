# Playwright checks + screenshots of the Lightning2Lightning pages.
# Usage: shots_l2l.py <base> <out_dir> [fixture_api fixture_dir]
#   Part A, against the staging site: logs in for real with the lnd-blake2b node (lncli signmessage),
#   creates a ring through the form, looks at it, cancels it, checks the reputation card, logs out.
#   Part B, optional: fixture_api is a TEST ln-directory instance (L2L_TEST_LOGIN=1, e.g. the one of
#   ln-directory/test/run-l2l-tests.sh started again on its work dir). A full ring is made there with
#   simulated members, and the browser's /api/ln-directory/* calls are routed to it, to see the
#   "opening" states (your turn, pubkey@address, lncli commands) that staging can't produce alone.
import json, subprocess, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip('/')
OUT = sys.argv[2]
FIX = sys.argv[3].rstrip('/') if len(sys.argv) > 3 else None
FIXDIR = sys.argv[4] if len(sys.argv) > 4 else None
SAVE_CARD = '--no-card-save' not in sys.argv  # the card is saved unchanged; on production that rewrites nothing
PK = '0222d36d7b634ead665c982145f6e4507ad65c4f369902ab3ca11e379d2139dc60'
errors, fails = [], []


def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        fails.append(msg)


def sign(text):
    out = subprocess.run(['docker', 'exec', 'lnd-blake2b', 'lncli', 'signmessage', text], capture_output=True, text=True, check=True).stdout
    return json.loads(out)['signature']


def fix_call(method, path, body=None, cookie=None, csrf=None):
    h = {'Content-Type': 'application/json', 'Origin': FIX}
    if cookie:
        h['Cookie'] = cookie
    if csrf:
        h['X-LnDir-CSRF'] = csrf
    r = urllib.request.urlopen(urllib.request.Request(FIX + '/api/ln-directory' + path, data=json.dumps(body or {}).encode() if method != 'GET' else None, headers=h, method=method))
    return json.load(r), r.headers.get('Set-Cookie', '')


with sync_playwright() as p:
    b = p.chromium.launch()
    for mode, vp in [('desktop', {'width': 1366, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
        ctx = b.new_context(viewport=vp, device_scale_factor=1, is_mobile=(mode == 'mobile'))
        ctx.add_init_script("if (!localStorage.getItem('nodex.lang')) localStorage.setItem('nodex.lang', 'es')")
        pg = ctx.new_page()
        pg.on('console', lambda m: m.type == 'error' and 'status of 4' not in m.text and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('request', lambda r: (not r.url.startswith(BASE)) and errors.append('EXTERNAL REQUEST ' + r.url))
        noscroll = lambda name: check(pg.evaluate('document.documentElement.scrollWidth') <= vp['width'] + 1, f'{mode} {name}: no horizontal scroll')

        # --- logged out ---
        pg.goto(BASE + '/l2l'); pg.wait_for_selector('#l2l-login-start'); pg.wait_for_timeout(600)
        txt = pg.inner_text('main')
        check(all(x in txt.lower() for x in ('lightning2lightning', 'cómo funciona', 'entra con tu nodo')), f'{mode} /l2l logged out (ES)')
        check(pg.locator('.nav a.on[data-nav=l2l]').count() == 1, f'{mode} nav item on')
        check('XBT' not in txt and 'fork' not in txt.lower(), f'{mode} wording: no XBT / fork')
        noscroll('/l2l'); pg.screenshot(path=f'{OUT}/{mode}-l2l-out-es.png', full_page=True)

        # --- login: wrong signature, then the real one ---
        pg.click('#l2l-login-start'); pg.wait_for_selector('#l2l-sig')
        text = pg.locator('.l2l-code code').first.inner_text().strip()
        check(text.startswith('mempool.kilombino.com directory login. Nonce '), f'{mode} login text shown')
        check(pg.locator('.l2l-code code', has_text='lncli signmessage').count() == 1, f'{mode} lncli command shown')
        pg.fill('#l2l-sig', 'd' + sign('something else')[1:]); pg.click('#l2l-login-go'); pg.wait_for_selector('#l2l-login-msg.err')
        check('no es de ningún nodo' in pg.inner_text('#l2l-login-msg'), f'{mode} wrong signature refused (ES message)')
        pg.screenshot(path=f'{OUT}/{mode}-l2l-login-bad.png', full_page=False)
        raw = subprocess.run(['docker', 'exec', 'lnd-blake2b', 'lncli', 'signmessage', text], capture_output=True, text=True, check=True).stdout
        pg.fill('#l2l-sig', raw)  # the whole JSON output is accepted too
        pg.click('#l2l-login-go'); pg.wait_for_selector('#l2l-logout', timeout=20000); pg.wait_for_timeout(500)
        check('Kilombino' in pg.inner_text('#l2l-me'), f'{mode} logged in as Kilombino')
        check('Nodo de Kilombino' in pg.inner_text('#l2l-me') and pg.locator('#l2l-me .contacts a').count() >= 5, f'{mode} "your node" shows his card (description, contacts)')
        ck = [c for c in ctx.cookies() if c['name'] == 'lndir_session']
        check(ck and ck[0]['httpOnly'] and ck[0]['sameSite'] == 'Strict' and ck[0]['path'] == '/api/ln-directory', f'{mode} session cookie HttpOnly/Strict/path')
        check('lndir_session' not in pg.evaluate('document.cookie'), f'{mode} cookie not readable from JS')
        if pg.locator('#l2l-tg-link').count():
            pg.click('#l2l-tg-link'); pg.wait_for_selector('#l2l-tg a.btn')
            href = pg.get_attribute('#l2l-tg a.btn', 'href')
            check(href.startswith('https://t.me/') and '?start=' in href and len(href.split('?start=')[1]) >= 20, f'{mode} telegram: one-time deep link ({href.split("?")[0]})')
        else:
            check('aún no están disponibles' in pg.inner_text('#l2l-me') or 'avisos activados' in pg.inner_text('#l2l-me'), f'{mode} telegram: state shown')
        pg.screenshot(path=f'{OUT}/{mode}-l2l-in.png', full_page=True)

        # --- the operator card editor ---
        pg.goto(BASE + '/card'); pg.wait_for_selector('#card-form'); pg.wait_for_timeout(400)
        check(pg.input_value('#card-form input[name=name]') == 'Kilombino', f'{mode} card editor prefilled')
        check(pg.locator('#card-form [data-field]').count() == 12, f'{mode} card editor: all fields')
        email = pg.input_value('#card-form input[name="c.email"]')
        pg.fill('#card-form input[name="c.email"]', 'not an email')
        pg.click('#card-save'); pg.wait_for_selector('#card-msg.err')
        check(pg.locator('[data-field=email].bad').count() == 1 and 'Email' in pg.inner_text('#card-msg'), f'{mode} card: bad email refused by the server and marked')
        pg.fill('#card-form input[name="c.email"]', email)
        noscroll('card'); pg.screenshot(path=f'{OUT}/{mode}-card-editor.png', full_page=True)
        if SAVE_CARD:
            pg.click('#card-save'); pg.wait_for_selector('#card-msg.ok')
            check('Sin cambios' in pg.inner_text('#card-msg'), f'{mode} card saved unchanged')

        # --- create a ring, look at it, cancel it ---
        pg.goto(BASE + '/l2l'); pg.wait_for_selector('#l2l-create')
        pg.select_option('#l2l-create select[name=size]', '2')
        pg.fill('#l2l-create input[name=capacity]', '10')
        check(pg.eval_on_selector('#l2l-create input[name=capacity]', 'e => !e.validity.valid'), f'{mode} capacity below the minimum is flagged by the form')
        pg.fill('#l2l-create input[name=capacity]', '250000')
        pg.fill('#l2l-create input[name=min_channels]', '3')
        pg.fill('#l2l-create input[name=commit_days]', '45')
        check('caduca sin penalizar a nadie' in pg.inner_text('#l2l-create'), f'{mode} create form explains days to fill up')
        pg.fill('#l2l-create textarea[name=note]', 'Prueba de staging\nsegunda línea & "comillas"')
        pg.click('#l2l-create button[type=submit]'); pg.wait_for_url('**/l2l/ring/*', timeout=15000); pg.wait_for_timeout(800)
        txt = pg.inner_text('main')
        check('abierto' in txt and '≥ 3 canales' in txt and 'segunda línea & "comillas"' in txt and '45' in pg.inner_text('.stats'), f'{mode} ring page: state, requirements, commitment, note as text')
        check(pg.locator('.l2l-text').evaluate('e => e.children.length') == 0, f'{mode} note rendered as text only')
        check(pg.locator('[data-act=cancel]').count() == 1, f'{mode} creator sees cancel')
        noscroll('ring'); pg.screenshot(path=f'{OUT}/{mode}-l2l-ring-open.png', full_page=True)
        rid = pg.url.rsplit('/', 1)[-1]
        pg.goto(BASE + '/l2l'); pg.wait_for_selector('#l2l-list table')
        check(pg.locator(f'#l2l-list a[href="/l2l/ring/{rid}"]').count() == 1, f'{mode} ring listed as open')
        pg.click('a.tab[href="/l2l/mine"]'); pg.wait_for_selector('#l2l-list table')
        check(pg.locator(f'#l2l-list a[href="/l2l/ring/{rid}"]').count() == 1, f'{mode} ring under "mine"')
        pg.goto(BASE + '/l2l/ring/' + rid); pg.wait_for_selector('[data-act=cancel]')
        pg.once('dialog', lambda d: d.accept())
        pg.click('[data-act=cancel]'); pg.wait_for_selector('.l2l-st.st-cancelled', timeout=15000)
        check(True, f'{mode} ring cancelled')

        # --- reputation on the node page ---
        pg.goto(BASE + '/node/' + PK); pg.wait_for_selector('#l2l-rep .l2l-big', timeout=20000)
        check('Nodo de Kilombino' in pg.inner_text('.opcard') and pg.locator('.op-own a[href="/card"]').count() == 1, f'{mode} node page: his card with the owner edit link')
        txt = pg.inner_text('#l2l-rep')
        check(all(x in txt.lower() for x in ('reputación l2l', 'punto de partida', '/100')), f'{mode} node page reputation card')
        pg.locator('#l2l-rep').screenshot(path=f'{OUT}/{mode}-node-rep-es.png')

        # --- English, logout ---
        pg.click('#lang'); pg.goto(BASE + '/l2l'); pg.wait_for_selector('#l2l-logout'); pg.wait_for_timeout(500)
        check(all(x in pg.inner_text('main').lower() for x in ('how it works', 'your node')), f'{mode} /l2l in English')
        pg.screenshot(path=f'{OUT}/{mode}-l2l-in-en.png', full_page=True)
        pg.click('#l2l-logout'); pg.wait_for_selector('#l2l-login-start', timeout=15000)
        check(pg.locator('#l2l-create').count() == 0, f'{mode} logged out: no create form')
        pg.click('#lang')
        ctx.close()

    # --- Part B: the opening states, from a test instance ---
    if FIX:
        K, B, C = PK, '02' + 'b1' * 32, '03' + 'c2' * 32
        cookies = {}
        for pk in (K, B, C):
            r, sc = fix_call('POST', '/test/login', {'pubkey': pk})
            cookies[pk] = (sc.split(';')[0], r['csrf'])
        r, _ = fix_call('POST', '/l2l/rings', {'ring': {'size': 3, 'capacity': 9_000_000, 'note': 'Ring for the screenshots'}}, *cookies[K])
        rid = r['ring']['id']
        for pk in (B, C):
            ring, _ = fix_call('POST', f'/l2l/rings/{rid}/join', {}, *cookies[pk])
        # A second ring where the channel opened TO Kilombino gets force-closed before the commitment:
        # Kilombino has to apply or forgive the penalty.
        pen_rid = None
        if FIXDIR:
            import os, time
            r2, _ = fix_call('POST', '/l2l/rings', {'ring': {'size': 2, 'capacity': 7_000_000, 'commit_days': 60}}, *cookies[K])
            pen_rid = r2['ring']['id']
            r2, _ = fix_call('POST', f'/l2l/rings/{pen_rid}/join', {}, *cookies[B])
            gf, cf = os.path.join(FIXDIR, 'graph.json'), os.path.join(FIXDIR, 'closed.json')
            graph, closed = json.load(open(gf)), json.load(open(cf))
            h = r2['ring']['filled_height']; now = int(time.time())
            chans = []
            for i, a in enumerate(r2['ring']['assignments']):
                cid = str(8_000_000_000 + i + now % 100000 * 10)
                chans.append({'id': cid, 'short_id': f'{h + 1}x{i}x0', 'capacity': 7_000_000, 'txid': f'{int(cid):064x}', 'vout': 0, 'status': 1, 'created': now, 'updated': now, 'n1': a['from'], 'n2': a['to'], 'p1': None, 'p2': None})
            graph['channels'] += chans
            json.dump(graph, open(gf, 'w')); json.dump(closed, open(cf, 'w'))
            fix_call('POST', '/test/verify', {})
            incoming = next(c for c in chans if c['n2'] == K)
            graph['channels'].remove(incoming)
            force_tx = next(c['spent_by'] for c in closed.values() if c.get('short_id') == '974616x209x0')
            closed[incoming['id']] = {k: incoming[k] for k in ('id', 'short_id', 'capacity', 'txid', 'vout', 'created', 'n1', 'n2')} | {'spent_by': force_tx, 'closed_at': now + 86400}
            json.dump(graph, open(gf, 'w')); json.dump(closed, open(cf, 'w'))
            fix_call('POST', '/test/verify', {})
        for mode, vp in [('desktop', {'width': 1366, 'height': 900}), ('mobile', {'width': 390, 'height': 844})]:
            ctx = b.new_context(viewport=vp, device_scale_factor=1, is_mobile=(mode == 'mobile'))
            ctx.add_init_script("localStorage.setItem('nodex.lang', 'en')")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(str(e)))

            def to_fixture(route):
                u = route.request.url.split('/api/ln-directory', 1)[1]
                resp = route.fetch(url=FIX + '/api/ln-directory' + u, headers={**route.request.headers, 'cookie': cookies[K][0]})
                route.fulfill(response=resp)
            pg.route('**/api/ln-directory/**', to_fixture)
            pg.goto(BASE + '/l2l/ring/' + rid); pg.wait_for_selector('.l2l-order'); pg.wait_for_timeout(600)
            txt = pg.inner_text('main')
            check('Your turn' in txt and 'lncli openchannel --node_key' in txt and 'lncli connect' in txt, f'{mode} B: your turn with lncli commands')
            uri = pg.locator('.l2l-turn .l2l-code code').first.inner_text()
            check('@' in uri and len(uri.split('@')[0]) == 66, f'{mode} B: pubkey@address to open to ({uri[:20]}…)')
            check(pg.locator('.l2l-order li').count() == 3, f'{mode} B: order of 3')
            check(pg.locator('#l2l-cform').count() == 1, f'{mode} B: comment form for members')
            check(pg.evaluate('document.documentElement.scrollWidth') <= vp['width'] + 1, f'{mode} B: no horizontal scroll')
            pg.screenshot(path=f'{OUT}/{mode}-l2l-ring-opening-en.png', full_page=True)
            if pen_rid and mode == 'desktop':
                pg.goto(BASE + '/l2l/ring/' + pen_rid); pg.wait_for_selector('.l2l-pen'); pg.wait_for_timeout(400)
                check(pg.locator('[data-penalty][data-accept="1"]').count() == 1 and pg.locator('[data-penalty][data-accept="0"]').count() == 1, f'{mode} receiver sees Apply penalty / Forgive')
                check('penalty pending confirmation' in pg.inner_text('.l2l-order').lower(), f'{mode} ring shows the penalty as pending')
                pg.screenshot(path=f'{OUT}/{mode}-l2l-penalty-en.png', full_page=True)
                pg.once('dialog', lambda d: d.accept())
                pg.click('[data-penalty][data-accept="0"]'); pg.wait_for_timeout(1500)
                check('forgiven' in pg.inner_text('.l2l-order').lower() and pg.locator('.l2l-pen').count() == 0, f'{mode} forgiven: recorded on the ring, buttons gone')
            ctx.close()
    b.close()

print('console/page errors:', json.dumps(errors[:20], indent=1))
print('FAILS:', fails)
sys.exit(1 if fails or errors else 0)
