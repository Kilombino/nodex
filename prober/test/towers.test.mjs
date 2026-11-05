// towers: which watchtower URIs are listed/probed, and how results are folded in.
// Run: node --test prober/test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTowerUri, towersFromDirectory, probeTowers } from '../towers.mjs';

const PK = '03' + 'ab'.repeat(32);
const NODE = '02' + 'cd'.repeat(32);
const ONION = 'abcdefghijklmnopqrstuvwxyz234567'.repeat(2).slice(0, 56) + '.onion';

test('parseTowerUri', () => {
  assert.deepEqual(parseTowerUri(`${PK}@${ONION}:9911`), { pk: PK, sock: `${ONION}:9911` });
  for (const bad of [null, 5, '', `${PK}`, `${PK}@${ONION}`, `${PK}@short.onion:9911`, `${PK}@localhost:9911`, `04${'a'.repeat(64)}@${ONION}:9911`, `x${PK}@${ONION}:9911`, `${PK}@${ONION}:9911`.padEnd(250, 'x')])
    assert.equal(parseTowerUri(bad), null, String(bad));
});

test('towersFromDirectory: hand-kept list and cards, checked and deduplicated', () => {
  const d = {
    watchtowers: [{ operator: 'someone', uri: `${PK}@${ONION}:9911` }, { operator: 'bad', uri: 'nonsense' }, 'junk', null],
    nodes: {
      [NODE]: { name: 'Op', watchtower: `${PK}@${ONION}:9911` }, // same URI: listed once
      ['02' + 'ef'.repeat(32)]: { name: 'Other', watchtower: `${PK}@1.1.1.1:9911` },
      ['02' + '12'.repeat(32)]: { name: 'NoTower' },
    },
  };
  const t = towersFromDirectory(d);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { uri: `${PK}@${ONION}:9911`, pk: PK, sock: `${ONION}:9911`, operator: 'someone', node: null });
  assert.equal(t[1].node, '02' + 'ef'.repeat(32));
  assert.deepEqual(towersFromDirectory({}), []);
});

test('probeTowers folds results; untestable rounds leave no tick', async () => {
  const towers = towersFromDirectory({ watchtowers: [{ operator: 'a', uri: `${PK}@${ONION}:9911` }, { operator: 'b', uri: `${PK}@1.1.1.1:9911` }] });
  const fake = async (sock) => (sock.includes('.onion') ? { ok: true, handshake: true } : { ok: null, handshake: null, reason: 'unavailable_vpn_down' });
  const r1 = await probeTowers(towers, {}, {}, fake);
  assert.equal(r1[towers[0].uri].recent, '1');
  assert.equal(r1[towers[0].uri].hs, true);
  assert.ok(r1[towers[0].uri].last_hs > 0);
  assert.equal(r1[towers[1].uri].recent, '');
  assert.equal(r1[towers[1].uri].reason, 'unavailable_vpn_down');
  const down = async () => ({ ok: false, handshake: null, reason: 'timeout' });
  const r2 = await probeTowers(towers, r1, {}, down);
  assert.equal(r2[towers[0].uri].recent, '10');
  assert.equal(r2[towers[0].uri].ok, false);
  assert.equal(r2[towers[0].uri].last_ok, r1[towers[0].uri].last_ok);
});
