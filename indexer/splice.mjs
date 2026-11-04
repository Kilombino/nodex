// Telling a splice from a close by the transaction that spent a channel's funding output.
//
// A splice spends the old funding output into a new 2-of-2 funding output (P2WSH, or P2TR for
// taproot channels), usually with wallet inputs/outputs alongside. The new channel only shows
// up in the graph once it is announced: LND locks a splice at 36 confirmations and the
// announcement takes ~6 more, so for a while the old channel looks closed with nothing new.
//
// Rule, for a transaction spending the funding outpoint:
//   - commitment transaction (force close: locktime upper byte 0x20 and the funding input's
//     sequence upper byte 0x80, BOLT 3) -> close. Its to_local/HTLC/anchor outputs are P2WSH
//     too, so this check must come first.
//   - any P2WSH output -> splice (strong: cooperative closes pay wallet outputs, P2WPKH/P2TR).
//   - more than one input and a P2TR output -> splice (a cooperative close spends only the
//     funding output; extra inputs mean someone added funds: a taproot-channel splice-in).
//   - otherwise -> close (a single-input P2TR-only spend is what a cooperative close to taproot
//     wallets looks like; treating it as a splice would hold real closes back for a day).
// While a splice has not shown up in the graph, it stays "pending" for SPLICE_WINDOW blocks
// after the spending transaction confirms; past that with no new channel it counts as closed.

export const SPLICE_WINDOW = 144;

const isCommitment = (tx, fundingTxid, fundingVout) => {
  const vin = (tx.vin || []).find((i) => i.txid === fundingTxid && i.vout === fundingVout) || tx.vin?.[0];
  return tx.vin?.length === 1 && (tx.locktime >>> 24) === 0x20 && (vin?.sequence >>> 24) === 0x80;
};

// Returns { splice: bool, why, out: value of the likely new funding output or null }.
export function classifySpend(tx, fundingTxid, fundingVout) {
  const outs = tx.vout || [];
  if (isCommitment(tx, fundingTxid, fundingVout)) return { splice: false, why: 'commitment', out: null };
  const wsh = outs.filter((o) => o.scriptpubkey_type === 'v0_p2wsh');
  if (wsh.length) {
    return { splice: true, why: 'p2wsh', out: wsh.length === 1 ? wsh[0].value : null };
  }
  const tr = outs.filter((o) => o.scriptpubkey_type === 'v1_p2tr');
  if ((tx.vin || []).length > 1 && tr.length) {
    return { splice: true, why: 'p2tr+inputs', out: tr.length === 1 ? tr[0].value : null };
  }
  return { splice: false, why: 'wallet-outputs', out: null };
}

// State of a closed-looking channel whose spend is splice-like and not yet linked:
// 'pending' while within the window (or unconfirmed), 'closed' after it.
export function pendingState(spendHeight, tip, window = SPLICE_WINDOW) {
  if (!spendHeight) return { pending: true, confs: 0 };
  const confs = tip - spendHeight + 1;
  return { pending: confs <= window, confs };
}
