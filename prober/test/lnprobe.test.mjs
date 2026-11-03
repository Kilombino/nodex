// lnprobe: address parsing, blocked ranges, BOLT 8 test vectors; with LIVE=1 also real nodes,
// AirVPN-only egress and fail-closed behaviour. Run: node --test prober/test/*.test.mjs  (LIVE=1 for the rest)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseSocket, isBlocked, resolvePublic, noiseInitiator, probeAddress, summarize } from '../lnprobe.mjs';

import fs from 'node:fs';
const OURS = '02' + '11'.repeat(32);
const ONION = 'abcdefghijklmnopqrstuvwxyz234567'.repeat(2).slice(0, 56) + '.onion';
test('parseSocket', () => {
  assert.deepEqual(parseSocket('1.2.3.4:9735'), { host: '1.2.3.4', port: 9735, network: 'ipv4' });
  assert.deepEqual(parseSocket('[2001:470::1]:50002'), { host: '2001:470::1', port: 50002, network: 'ipv6' });
  assert.deepEqual(parseSocket(`${ONION.toUpperCase()}:9735`), { host: ONION, port: 9735, network: 'tor' });
  assert.deepEqual(parseSocket('ln.example.com:9735'), { host: 'ln.example.com', port: 9735, network: 'dns' });
  for (const bad of ['1.2.3.4', '1.2.3.4:0', '1.2.3.4:70000', '[zz::1]:1', 'short.onion:9735', 'localhost:9735', 'a b:1', '', 'x'.repeat(400) + ':1', null, 5])
    assert.equal(parseSocket(bad), null, String(bad));
});

test('blocked: private, local, special and IPv4-mapped addresses', () => {
  for (const ip of ['192.168.0.14', '10.0.0.1', '127.0.0.1', '172.16.5.5', '100.64.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '198.18.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fd7d::1', 'fc00::1', '::ffff:192.168.0.14', '::ffff:c0a8:e', '64:ff9b::a00:1', '2002:c0a8::1', '2001::1', '2001:db8::1', 'ff02::1', 'nonsense'])
    assert.equal(isBlocked(ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2001:470::1', '2606:4700:4700::1111'])
    assert.equal(isBlocked(ip), false, ip);
});

test('hostnames are resolved and the result is checked', async () => {
  const fake = (addr) => async () => ({ address: addr });
  assert.deepEqual(await resolvePublic(parseSocket('ln.example.com:1'), fake('192.168.1.1')), { reason: 'blocked_private' });
  assert.deepEqual(await resolvePublic(parseSocket('ln.example.com:1'), fake('1.1.1.1')), { ip: '1.1.1.1', network: 'ipv4' });
  assert.deepEqual(await resolvePublic(parseSocket('ln.example.com:1'), async () => { throw new Error('x'); }), { reason: 'dns_failed' });
});

test('a LAN address is blocked, whoever announces it', async () => {
  const r = await probeAddress('192.168.0.14:9735', OURS);
  assert.equal(r.ok, null); assert.equal(r.reason, 'blocked_private');
});

test('BOLT 8 act one / act two test vectors (initiator)', () => {
  const n = noiseInitiator(Buffer.from('028d7500dd4c12685d1f568b4c2b5048e8534b873319f3a8daa612b469132ec7f7', 'hex'), Buffer.alloc(32, 0x12));
  assert.equal(n.act1.toString('hex'), '00036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f70df6086551151f58b8afe6c195782c6a');
  const act2 = Buffer.from('0002466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276e2470b93aac583c9ef6eafca3f730ae', 'hex');
  assert.equal(n.check(act2), true);
  const bad = Buffer.from(act2); bad[49] ^= 1; assert.equal(n.check(bad), false); // MAC
  const ver = Buffer.from(act2); ver[0] = 1; assert.equal(n.check(ver), false); // version
  assert.equal(n.check(act2.subarray(0, 49)), false);
});

test('summary per network', () => {
  assert.deepEqual(summarize([
    { network: 'tor', ok: true, handshake: true }, { network: 'ipv4', ok: false, handshake: null },
    { network: 'ipv4', ok: true, handshake: false }, { network: 'ipv6', ok: null, handshake: null },
  ]), { tor: { ok: true, handshake: true }, ipv4: { ok: true, handshake: false }, ipv6: { ok: null, handshake: null } });
});

const LIVE = process.env.LIVE === '1';
// LIVE targets come from Nodex's own graph: nodes that announce IPv4, IPv6 and .onion addresses.
// LIVE_SELF_PK / LIVE_SELF_SOCKETS (comma separated) add a node announced on the tunnel's own exit.
const graph = LIVE ? JSON.parse(fs.readFileSync(new URL('../../data/graph.json', import.meta.url))) : { nodes: [] };
async function firstVerified(re) {
  for (const n of graph.nodes) for (const s of n.sockets || []) {
    if (!re.test(s)) continue;
    const r = await probeAddress(s, n.pk);
    if (r.handshake === true) return { n, s, r };
  }
  return null;
}
test('LIVE: a public node over Tor, IPv4 and IPv6 (out of the VPN only) completes the handshake', { skip: !LIVE }, async () => {
  for (const re of [/\.onion:/, /^\d+\.\d+\.\d+\.\d+:/, /^\[/]) {
    const hit = await firstVerified(re);
    assert.ok(hit, `no node verified for ${re}`);
    // the same address with another node's key must not verify
    const other = graph.nodes.find((x) => x.pk !== hit.n.pk);
    const wrong = await probeAddress(hit.s, other.pk);
    assert.equal(wrong.handshake, false, JSON.stringify(wrong));
  }
});
test('LIVE: a node on the tunnel\'s own exit address (tested through Tor)', { skip: !LIVE || !process.env.LIVE_SELF_PK }, async () => {
  for (const s of process.env.LIVE_SELF_SOCKETS.split(',')) {
    const r = await probeAddress(s, process.env.LIVE_SELF_PK);
    assert.equal(r.handshake, true, JSON.stringify(r));
  }
});

test('LIVE: fail closed', { skip: !LIVE }, () => {
  const run = (env, s) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {probeAddress} from ${JSON.stringify(new URL('../lnprobe.mjs', import.meta.url).pathname)}; console.log(JSON.stringify(await probeAddress(${JSON.stringify(s)}, null)))`],
  { env: { ...process.env, ...env } }).toString());
  const v4 = '1.1.1.1:443', v6 = '[2606:4700:4700::1111]:443';
  // the home line's own source address (main table) is refused too
  const home = JSON.parse(execFileSync('ip', ['-j', '-4', 'route', 'get', '1.1.1.1']).toString())[0].prefsrc;
  for (const [env, s, reason] of [
    [{ PROBE_SRC4: home }, v4, 'unavailable_vpn_route'],
    [{ PROBE_SRC4: '10.255.255.99' }, v4, 'unavailable_vpn_route'], // unused address: no route out of the tunnel
    [{ PROBE_SRC6: 'fd00::99' }, v6, 'unavailable_vpn_route'],
    [{ PROBE_SRC4: '10.255.255.99', PROBE_SKIP_ROUTE_CHECK: '1' }, v4, 'unavailable_bind_EADDRNOTAVAIL'], // the bind itself fails
    [{ PROBE_SRC6: 'fd00::99', PROBE_SKIP_ROUTE_CHECK: '1' }, v6, 'unavailable_bind_EADDRNOTAVAIL'],
    [{ PROBE_VPN_DEV: 'wg-missing' }, v4, 'unavailable_vpn_down'],
    [{ PROBE_VPN_DEV: 'wg-missing' }, v6, 'unavailable_vpn_down'],
  ]) {
    const r = run(env, s);
    assert.equal(r.ok, null, JSON.stringify(r)); assert.equal(r.reason, reason);
  }
});
