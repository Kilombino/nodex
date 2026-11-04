// Splice vs close classification, on real transactions of the BLAKE2b chain.
// Offline by default (fixtures/); LIVE=1 fetches the same txs from mempool.kilombino.com.
//   node --test indexer/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifySpend, pendingState, SPLICE_WINDOW } from '../splice.mjs';

const dir = new URL('./fixtures/', import.meta.url);
async function tx(id) {
  if (process.env.LIVE) return (await fetch(`https://mempool.kilombino.com/api/tx/${id}`)).json();
  return JSON.parse(fs.readFileSync(new URL(`${id}.json`, dir)));
}

test('splice-in, not yet announced (980186x166x0 -> fe543b5b…)', async () => {
  const t = await tx('fe543b5b718ddb687e7c80b32574b81281c7f4a16c0bdbc811d649c35b4392b1');
  const k = classifySpend(t, '95a6af76b570c96a37f9df7172d15a34b4c7ed87b5122d961285827b40e2e469', 0);
  assert.equal(k.splice, true);
  assert.equal(k.out, 274035706);
});

test('splice-out, not yet announced (978048x355x0 -> 13da2e06…)', async () => {
  const t = await tx('13da2e0652e2c1516acbfacb83652d1add6232ddcb86c0f17b7e2889da2fc6d6');
  const k = classifySpend(t, '500057cae3ccd39e998e42f56af5e00bda1719d257f7da2e11d4435b3f810d0c', 0);
  assert.equal(k.splice, true);
  assert.equal(k.out, 18882151);
});

test('cooperative closes stay closes (LND COOPERATIVE_CLOSE 28a7efdd…, 71788d15…)', async () => {
  for (const id of ['28a7efdddf473933267d5cd5db1f729b3b346ba42fe4208798657d58901da45d', '71788d15cd2e577c378593b06c3a33edf84c27493a7f9663c894bfff93b224d5']) {
    const t = await tx(id);
    const k = classifySpend(t, t.vin[0].txid, t.vin[0].vout);
    assert.equal(k.splice, false, id);
  }
});

test('force close (commitment with P2WSH outputs) stays a close (974711x71x0 -> 5b9c5598…)', async () => {
  const t = await tx('5b9c559854abab73b121ddfc79447c2fa53e7351624508dec3bb826554be0bca');
  const k = classifySpend(t, 'a8b031ea133e83e3214b2e87096bc0d4d847e43e6f04cfa75ef74101f3814f45', 0);
  assert.equal(k.splice, false);
  assert.equal(k.why, 'commitment');
});

test('taproot: extra inputs + P2TR is a splice, single input P2TR is a close', () => {
  const base = { locktime: 0, vout: [{ scriptpubkey_type: 'v1_p2tr', value: 1e6 }] };
  assert.equal(classifySpend({ ...base, vin: [{ txid: 'a', vout: 0, sequence: 0xfffffffd }] }, 'a', 0).splice, false);
  assert.equal(classifySpend({ ...base, vin: [{ txid: 'a', vout: 0, sequence: 0xfffffffd }, { txid: 'b', vout: 1, sequence: 0xfffffffd }] }, 'a', 0).splice, true);
});

test('pending window', () => {
  assert.deepEqual(pendingState(980352, 980368), { pending: true, confs: 17 });
  assert.equal(pendingState(980352, 980352 + SPLICE_WINDOW - 1).pending, true);
  assert.equal(pendingState(980352, 980352 + SPLICE_WINDOW).pending, false);
  assert.equal(pendingState(null, 980368).pending, true);
});
