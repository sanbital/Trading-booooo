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

// This whole file replays a frozen historical window (v48, 2026-09-16/17), when the
// live contract targeted a 30 USDT slot. The operator has since moved the target to
// 200 USDT (2026-09-19; MAX_SLOTS and leverage unchanged), so every planSlotEntry
// call below is pinned to that DAY's contract explicitly rather than to whatever
// SLOT_SIZING_CONTRACT resolves to today -- otherwise this replay would silently
// start asking a different question (what a 200 USDT slot would have done) instead
// of the one it exists to answer (what the lattice-search fix did to that day's
// real rejections, at that day's 30 USDT margin).
const CONTRACT_20260917 = Object.freeze({...SLOT_SIZING_CONTRACT, targetMarginUsdt: 30});

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
          priceTick: signal.priceTick ?? 0, minNotionalUsdt: 5}, CONTRACT_20260917);
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
        priceTick: signal.priceTick ?? 0, minNotionalUsdt: 5}, CONTRACT_20260917);
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
  // NEARUSDT (step 1 at ~2.7-2.9) and UNIUSDT (step 1 at 6.75) were previously
  // refused QTY_STEP_EXCEEDS_MARGIN_BUDGET, on the claim that the slot could not
  // afford them. That claim was false: it came from evaluating exactly ONE point on
  // the quantity lattice -- ceil(target / ask) -- and refusing the symbol when that
  // point overshot the ceiling, without ever asking whether the multiple BELOW it
  // fits. It does, comfortably. NEARUSDT at ask 3.2470 costs 30.31 USDT at 28 lots
  // and 29.23 at 27; UNIUSDT at 8.916 costs 32.70 at 11 lots and 29.73 at 10. Both
  // are inside the unchanged 30.25 ceiling and carry over 97% of the slot.
  for (const symbol of ['NEARUSDT', 'UNIUSDT']) {
    const entry = bySymbol.get(symbol);
    assert.ok(entry, `${symbol} must be in the window`);
    assert.equal(entry.admit, entry.n,
      `${symbol}: ${entry.n - entry.admit} of ${entry.n} still refused (${[...entry.skip]})`);
  }
  // The ceiling and the floor are what make that admission safe, so they are asserted
  // on every plan this replay produced, not just on the two symbols above. A sizing
  // change that bought its entries by spending more margin would fail here.
  const bounds = slotSizingBounds(CONTRACT_20260917);
  for (const row of replayed) {
    if (!row.now) continue;
    assert.ok(row.now.orderMarginUsdt <= bounds.maxOrderMarginUsdt + 1e-9,
      `${row.signal.symbol} sized ${row.now.orderMarginUsdt} over the ${bounds.maxOrderMarginUsdt} ceiling`);
    assert.ok(row.now.referenceNotionalUsdt + 1e-9 >= bounds.minOrderNotionalUsdt,
      `${row.signal.symbol} sized ${row.now.referenceNotionalUsdt} under the slot-fill floor`);
    assert.equal(row.now.quantity % row.chosen.step < 1e-9 ||
      Math.abs(row.now.quantity % row.chosen.step - row.chosen.step) < 1e-9, true,
      `${row.signal.symbol} quantity ${row.now.quantity} is off the ${row.chosen.step} lattice`);
  }
});

test('a lot the slot cannot afford at ALL is still refused, by its own reason', () => {
  // The lattice search must not become a way to buy something unaffordable. At
  // 95 USDT a single lot needs 31.68 USDT of margin against a 30.25 ceiling: there is
  // no smaller admissible quantity, so the refusal stands and still names the step.
  let reason = null;
  try { planSlotEntry({ask: 95, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5}, CONTRACT_20260917); }
  catch (error) { reason = error.message; }
  assert.match(reason ?? '', /^QTY_STEP_EXCEEDS_MARGIN_BUDGET:31\.676667:max=30\.250000:step=1:qty=1:px=95\.03$/);
  // An exchange minimum the slot cannot pay for is a DIFFERENT refusal: BTCUSDT's
  // 100 USDT minNotional is above the whole 90 USDT slot, whatever the lot step.
  let btc = null;
  try { planSlotEntry({ask: 60000, quantityStep: 0.001, priceTick: 0.1, minNotionalUsdt: 100}, CONTRACT_20260917); }
  catch (error) { btc = error.message; }
  assert.match(btc ?? '', /^MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET:/);
});

test('the slot-fill floor is slack today and binds if the overshoot budget widens', () => {
  // Under the SHIPPED contract the floor is provably unreachable, and that is worth
  // pinning rather than leaving as an accident. The largest affordable multiple k
  // satisfies (k+1) x limit > maxNotional, so k x limit > maxNotional - limit; if
  // limit <= maxNotional/2 that is already more than half the slot, and if
  // limit > maxNotional/2 then k = 1 and the single lot is itself more than half.
  // Either way no admitted order can carry less than 50% of the target notional.
  for (let ask = 1; ask <= 90; ask += 0.37) {
    let plan = null;
    try { plan = planSlotEntry({ask, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5}, CONTRACT_20260917); }
    catch { continue; }
    assert.ok(plan.slotFillBps >= CONTRACT_20260917.minSlotFillBps,
      `ask ${ask} sized ${plan.slotFillBps} bps of the slot`);
  }
  // The floor is not decoration: raise it and the same thin lattice point is refused,
  // which is what protects the slot if maxSlotOvershootBps is ever widened.
  const thin = planSlotEntry({ask: 60, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5}, CONTRACT_20260917);
  assert.equal(thin.quantity, 1, 'one lot of a 60 USDT symbol is all a 90 USDT slot affords');
  const strict = {...CONTRACT_20260917, minSlotFillBps: 8_000};
  let below = null;
  try { planSlotEntry({ask: 60, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5}, strict); }
  catch (error) { below = error.message; }
  assert.match(below ?? '', /^QTY_STEP_BELOW_SLOT_FLOOR:.*:floor=72\.000000$/);
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
  const bounds = slotSizingBounds(CONTRACT_20260917);
  const lines = [
    '',
    `contract ${CONTRACT_20260917.version} (2026-09-17 replay)  target ${CONTRACT_20260917.targetMarginUsdt} USDT ` +
      `@ ${CONTRACT_20260917.leverage}x = ${bounds.targetNotionalUsdt} notional  ` +
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
    `margin than a ${CONTRACT_20260917.targetMarginUsdt} USDT slot has.`);
  console.log(lines.join('\n'));
  assert.ok(admitted > 0);
});
