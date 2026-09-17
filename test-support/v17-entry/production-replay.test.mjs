// Offline replay of the real rejections v10-lane-executor v48 wrote in production
// between its deploy (2026-09-16T23:09:24Z) and 2026-09-17T13:05Z.
//
// The point is not a pass count. For every stored rejection this reconstructs the
// exact (quantity, ask) the old code was looking at, verifies the reconstruction
// reproduces the STORED refusal figure to the digit, then re-runs the same inputs
// through the new sizing contract and prints what changes and why. A row whose
// reconstruction does not reproduce the stored figure fails the test instead of
// being quietly reported as fixed.
//
// Run it on its own to read the table:
//   node --test test-support/v17-entry/production-replay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planSlotEntry, SLOT_SIZING_CONTRACT, slotSizingBounds}
  from '../../supabase/functions/_shared/leader-slot-sizing.mjs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';

const EVIDENCE = JSON.parse(readFileSync(
  new URL('./evidence/rejected-signals-20260917.json', import.meta.url), 'utf8'));

// ---- the deployed v48 arithmetic, reproduced exactly ------------------------
const OLD = {MARGIN: 30, LEV: 3, NOTIONAL: 90, NOTIONAL_BUFFER_USDT: 0.12,
  MAX_MARGIN_BUFFER_USDT: 0.25, IOC_BASE_BPS: 3, IOC_MAX_BPS: 12};
const dec = s => Math.min(12, Math.max(0, Math.ceil(-Math.log10(s)) + 2));
const ceilStep = (v, s) => (!(v > 0 && s > 0) ? 0
  : Number((Math.ceil((v - s * 1e-9) / s) * s).toFixed(dec(s))));
const addStep = (v, s) => Number((v + s).toFixed(dec(s)));

/** v48's sizeEntry + gate, returning the refusal string it would have written. */
function oldSizing(ask, step) {
  let amount = ceilStep(OLD.NOTIONAL / ask, step);
  if (!(amount > 0)) return {reason: 'QTY_INVALID'};
  let sizedNotional = amount * ask;
  if (sizedNotional < OLD.NOTIONAL + OLD.NOTIONAL_BUFFER_USDT) {
    const bumped = addStep(amount, step), bumpedMargin = bumped * ask / OLD.LEV;
    if (bumpedMargin <= OLD.MARGIN + OLD.MAX_MARGIN_BUFFER_USDT) {
      amount = bumped; sizedNotional = amount * ask;
    }
  }
  const sizedMargin = sizedNotional / OLD.LEV;
  if (sizedMargin > OLD.MARGIN + OLD.MAX_MARGIN_BUFFER_USDT + 1e-9) {
    return {reason: `ENTRY_SLOT_GRANULARITY_MARGIN:${sizedMargin.toFixed(6)}`, amount, sizedNotional};
  }
  const gatePrice = (OLD.NOTIONAL + OLD.NOTIONAL_BUFFER_USDT) / amount;
  const limitPrice = Math.max(ask * (1 + OLD.IOC_BASE_BPS / 10_000), gatePrice);
  const iocBps = (limitPrice / ask - 1) * 10_000;
  if (iocBps > OLD.IOC_MAX_BPS) {
    return {reason: `ENTRY_GRANULARITY_BPS:${iocBps.toFixed(3)}`, amount, sizedNotional, iocBps};
  }
  return {reason: null, amount, sizedNotional, sizedMargin, limitPrice, iocBps};
}

/**
 * Recover the (ask, step) the executor actually saw.
 *
 * The stored refusal pins `quantity x ask` exactly. Sweep the lot steps a USDⓈ-M
 * symbol can have and, for each, every quantity whose implied ask lands inside the
 * 1% entry-drift band the signal had already passed; keep the candidates whose old
 * sizing reproduces the stored string character for character.
 */
function reconstruct(signal) {
  const target = signal.rejectReason;
  const steps = signal.quantityStep ? [signal.quantityStep] : [1, 0.1, 0.01, 0.001];
  const ref = signal.referenceClose, band = POLICY.maxEntryDriftPct;
  const hits = [];
  for (const step of steps) {
    const loAsk = ref * (1 - band), hiAsk = ref * (1 + band);
    // quantity x ask is ~90-95 USDT, so the quantity range follows from the band.
    const loQty = Math.floor(89 / hiAsk / step) * step, hiQty = Math.ceil(96 / loAsk / step) * step;
    const lots = Math.round((hiQty - loQty) / step);
    if (lots > 4_000_000) continue;
    for (let i = 0; i <= lots; i++) {
      const quantity = Number((loQty + i * step).toFixed(dec(step)));
      if (!(quantity > 0)) continue;
      // The ask that makes THIS quantity the one v48 sized, read off the refusal.
      const stored = Number(target.split(':')[1]);
      if (!Number.isFinite(stored)) continue;
      const ask = target.startsWith('ENTRY_SLOT_GRANULARITY_MARGIN')
        ? stored * OLD.LEV / quantity
        : (OLD.NOTIONAL + OLD.NOTIONAL_BUFFER_USDT) / (1 + stored / 10_000) / quantity;
      if (!(ask >= loAsk && ask <= hiAsk)) continue;
      const replayed = oldSizing(ask, step);
      if (replayed.reason === target && replayed.amount === quantity) {
        hits.push({ask, step, quantity, old: replayed});
      }
    }
  }
  return hits;
}

const sizingRows = EVIDENCE.signals.filter(s =>
  /^(ENTRY_GRANULARITY_BPS|ENTRY_SLOT_GRANULARITY_MARGIN)/.test(s.rejectReason));
const nonSizingRows = EVIDENCE.signals.filter(s =>
  !/^(ENTRY_GRANULARITY_BPS|ENTRY_SLOT_GRANULARITY_MARGIN)/.test(s.rejectReason));

const replayed = [];

test('every stored sizing rejection is reproduced exactly by the v48 arithmetic', () => {
  assert.ok(sizingRows.length >= 26, `${sizingRows.length} sizing rejections in the window`);
  for (const signal of sizingRows) {
    const hits = reconstruct(signal);
    assert.ok(hits.length > 0,
      `${signal.symbol} ${signal.rejectReason} could not be reconstructed from primary evidence`);
    // Every consistent (ask, step) must agree on what the NEW contract does, or the
    // reconstruction is too loose to draw a conclusion from.
    const verdicts = new Set();
    for (const hit of hits) {
      let verdict;
      try {
        const plan = planSlotEntry({ask: hit.ask, quantityStep: hit.step,
          priceTick: signal.priceTick ?? 0, minNotionalUsdt: 5});
        verdict = `ADMIT:${plan.boundBy}`;
      } catch (error) { verdict = `SKIP:${error.code}`; }
      verdicts.add(verdict);
    }
    assert.equal(verdicts.size, 1,
      `${signal.symbol}: reconstruction is ambiguous about the new verdict (${[...verdicts]})`);
    const chosen = hits[0];
    let now = null, reason = null;
    try {
      now = planSlotEntry({ask: chosen.ask, quantityStep: chosen.step,
        priceTick: signal.priceTick ?? 0, minNotionalUsdt: 5});
    } catch (error) { reason = error.message; }
    replayed.push({signal, chosen, now, reason, candidates: hits.length});
  }
});

test('the symbols refused by arithmetic are admitted; the unaffordable ones are not', () => {
  assert.ok(replayed.length === sizingRows.length, 'the reconstruction test must run first');
  const bySymbol = new Map();
  for (const row of replayed) {
    const entry = bySymbol.get(row.signal.symbol) ?? {admit: 0, skip: new Set(), n: 0};
    entry.n++;
    if (row.now) entry.admit++; else entry.skip.add(row.reason.split(':')[0]);
    bySymbol.set(row.signal.symbol, entry);
  }

  // ONEUSDT, REZUSDT and SAGAUSDT have lot steps FINER than the slot needs. They were
  // refused purely by the 0.12-USDT-against-12-bps contradiction, and must now size.
  for (const symbol of ['ONEUSDT', 'REZUSDT', 'SAGAUSDT']) {
    const entry = bySymbol.get(symbol);
    assert.ok(entry, `${symbol} must be in the window`);
    assert.equal(entry.admit, entry.n,
      `${symbol}: ${entry.n - entry.admit} of ${entry.n} still refused (${[...entry.skip]})`);
  }
  // NEARUSDT (step 1 at ~2.7-2.9) and UNIUSDT (step 1 at 6.75) genuinely cannot be
  // bought in 90 USDT of notional at that granularity. They must STILL be skipped,
  // and for the reason that names the lot step rather than a price cap.
  for (const symbol of ['NEARUSDT', 'UNIUSDT']) {
    const entry = bySymbol.get(symbol);
    assert.ok(entry, `${symbol} must be in the window`);
    assert.equal(entry.admit, 0, `${symbol} must remain unaffordable at a 30 USDT slot`);
    assert.deepEqual([...entry.skip], ['QTY_STEP_EXCEEDS_MARGIN_BUDGET']);
  }
});

test('nothing outside the sizing layer is loosened by this change', () => {
  // ENTRY_DRIFT and the gateway error are not sizing verdicts and must stay exactly
  // as they were: this change must not turn a market refusal into an entry.
  for (const signal of nonSizingRows) {
    assert.match(signal.rejectReason, /^(ENTRY_DRIFT|GW_400)/);
  }
  assert.equal(nonSizingRows.filter(s => s.rejectReason === 'ENTRY_DRIFT').length, 15);
  assert.equal(POLICY.maxEntryDriftPct, 0.01, 'the drift limit is untouched');
});

test('REPORT: every replayed rejection, old verdict vs new', () => {
  const bounds = slotSizingBounds(SLOT_SIZING_CONTRACT);
  const lines = [
    '',
    `contract ${SLOT_SIZING_CONTRACT.version}  target ${SLOT_SIZING_CONTRACT.targetMarginUsdt} USDT ` +
      `@ ${SLOT_SIZING_CONTRACT.leverage}x = ${bounds.targetNotionalUsdt} notional  ` +
      `required >= ${bounds.requiredNotionalUsdt.toFixed(4)}  max margin ${bounds.maxOrderMarginUsdt.toFixed(4)}`,
    '',
    ['symbol', 'stored reject', 'ask', 'step', 'new', 'qty', 'notional', 'margin', 'ioc bps', 'why']
      .map((h, i) => h.padEnd([11, 40, 11, 7, 7, 12, 10, 9, 8, 32][i])).join(''),
  ];
  for (const {signal, chosen, now, reason} of replayed) {
    lines.push([
      signal.symbol.padEnd(11),
      signal.rejectReason.slice(0, 39).padEnd(40),
      chosen.ask.toPrecision(7).padEnd(11),
      String(chosen.step).padEnd(7),
      (now ? 'ADMIT' : 'SKIP').padEnd(7),
      String(now ? now.quantity : chosen.quantity).padEnd(12),
      (now ? now.orderNotionalUsdt : chosen.old.sizedNotional).toFixed(4).padEnd(10),
      (now ? now.orderMarginUsdt : chosen.old.sizedNotional / 3).toFixed(4).padEnd(9),
      (now ? now.iocBps.toFixed(3) : '-').padEnd(8),
      now
        ? `priced from the ask alone; buffer in qty`
        : reason.split(':')[0] + ' (lot step too coarse for the slot)',
    ].join(''));
  }
  lines.push('');
  const admitted = replayed.filter(r => r.now).length;
  lines.push(`${admitted} of ${replayed.length} replayed rejections are admitted by the new contract; ` +
    `${replayed.length - admitted} remain skipped, every one because its lot step costs more ` +
    `margin than a ${SLOT_SIZING_CONTRACT.targetMarginUsdt} USDT slot has.`);
  console.log(lines.join('\n'));
  assert.ok(admitted > 0);
});
