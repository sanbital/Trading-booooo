/**
 * V27 -- why a live trigger never became an order, pinned as regressions.
 *
 * Between the v51 deploy and 2026-09-18 09:20 UTC production produced 253 signals,
 * armed setups, observed pullbacks, fired triggers -- and wrote ZERO order intents.
 * The refusals recorded on the signal rows (V17_TRIGGER_STALE x14, V17_CHASE_EXPIRED
 * x28, V17_SETUP_EXPIRED x28) named the symptom; the decision log named the cause.
 * Two of them, both latency, neither a policy:
 *
 *   1. THE DISPATCH QUOTE COULD NOT BE FRESH. The final check before the order intent
 *      asserts the pricing quote is younger than E1_POLICY.maxQuoteAgeMs (1000ms).
 *      That quote was read BEFORE the entry-control decision and the BOO pre-dispatch
 *      gate -- five sequential round trips, two of them to the gateway. 7 of the 8
 *      candidates that reached the check in 24h were refused E1_DISPATCH_QUOTE_AGED,
 *      released their claim, and were refused V17_TRIGGER_STALE on the next cycle:
 *        METUSDT  trigger 08:21:00, E1 admitted 08:21:08.1, AGED 08:21:10.3, stale 08:22:09
 *        STRKUSDT trigger 08:49:00, E1 admitted 08:49:36.2, AGED 08:49:39.6, stale 08:50:07
 *   2. ARMING COST A WHOLE CYCLE. advanceSignalSetup armed a setup and returned
 *      without reading a single candle, so a setup whose pullback and re-acceleration
 *      both sat on the bar it was armed FROM triggered at armedAt+60s and was not
 *      discovered until the next minute, after its 60s window had closed. GUSDT 08:20,
 *      UNIUSDT 03:15, OPUSDT 03:20, DRIFTUSDT 06:00, BABYUSDT 00:25.
 *
 * And one arithmetic refusal that was simply wrong: planSlotEntry evaluated ONE point
 * on the quantity lattice and refused the symbol when it overshot the margin ceiling,
 * never asking whether the multiple below it fits. UNIUSDT: qty 11 = 32.70 USDT of
 * margin against a 30.25 ceiling, refused -- while qty 10 = 29.73 USDT and 99.1% of
 * the slot.
 *
 * No threshold in this file was changed to make a test pass. At the time of this
 * incident the slot was 30 USDT at 3x, the drift ceiling was 1%, the trigger TTL was
 * 60s, the setup window was 15 minutes and maxQuoteAgeMs was 1000ms; every one of
 * those is asserted below as unchanged FOR THIS REPLAY, against a contract frozen to
 * that day (CONTRACT_20260918) rather than to whatever the live slot is today. The
 * operator moved the live slot to 200 USDT on 2026-09-19 (leverage and MAX_SLOTS
 * unchanged); test 11b pins that separately, against the live contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {
  SETUP_POLICY, SETUP_REASON, SETUP_STATE, advancePullbackSetup, deserializeSetup,
  entryTriggerFresh, expirePullbackSetup, isTerminal as setupIsTerminal, serializeSetup,
  setupIdentity, startPullbackSetup,
} from '../../supabase/functions/_shared/leader-pullback-reaccel.mjs';
import {POLICY} from '../../supabase/functions/_shared/leader-momentum-v17.mjs';
import {E1_POLICY, startE1} from '../../supabase/functions/_shared/leader-e1-runtime.mjs';
import {
  SLOT_SIZING_CONTRACT, SLOT_SIZING_REASON, planSlotEntry, slotSizingBounds,
} from '../../supabase/functions/_shared/leader-slot-sizing.mjs';
import {
  entryExecutionWindow, entryPriceEvidence, normalizeEntryBook, supportedFuturesMode,
} from '../../supabase/functions/v10-lane-executor/entry-evidence.mjs';
import * as liveChase from '../../supabase/functions/_shared/leader-live-chase.mjs';

// This file replays the frozen v51 (2026-09-18) production window, when the live
// contract targeted a 30 USDT slot. The operator has since moved the target to 200
// USDT (2026-09-19; MAX_SLOTS and leverage unchanged), so every sizing call below
// pins that day's contract explicitly instead of reading whatever SLOT_SIZING_CONTRACT
// resolves to today -- this file exists to prove the lattice-search fix, not to track
// the live margin.
const CONTRACT_20260918 = Object.freeze({...SLOT_SIZING_CONTRACT, targetMarginUsdt: 30});

const SRC = readFileSync(
  new URL('../../supabase/functions/v10-lane-executor/index.ts', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
const OPEN_BULL = SRC.slice(SRC.indexOf('async function openBull('),
  SRC.indexOf('// Best-effort feed for the decision-only exit shadow.'));
const QUEUE = SRC.slice(SRC.indexOf('async function runEntryQueue('),
  SRC.indexOf('async function requireLeaderEntryControls'));

const MIN = 60_000;
const CLOSE = Date.parse('2026-09-18T08:20:00.000Z');   // GUSDT's real 5m close
const REF = 0.007;

/** The signal row shape the executor reads, with an optional persisted setup. */
function row(setup = null, {id = 'sig-1', symbol = 'GUSDT', ref = REF, close = CLOSE} = {}) {
  return {id, symbol, entry_bar_at: new Date(close).toISOString(),
    features: {strategy: 'V17_LEADER_MOMENTUM_1', signal5Close: close, referenceClose: ref,
      ...(setup ? {v17Setup: serializeSetup(setup)} : {})}};
}
/** A 1m kline in the gateway's array shape. */
function bar(openTime, {open, high, low, close}) {
  return [openTime, String(open), String(high), String(low), String(close), '1000',
    openTime + MIN - 1, '1000', 10, '500', '500', '0'];
}
/** Arm, then drive the state machine over bars, exactly as the executor does. */
function drive(bars, now, {ref = REF, close = CLOSE} = {}) {
  const armed = startPullbackSetup(
    {id: 'sig-1', symbol: 'GUSDT', features: {signal5Close: close, referenceClose: ref}},
    close, SETUP_POLICY);
  assert.equal(armed.ok, true);
  let state = armed.state, reason = SETUP_REASON.ARMED;
  const sorted = [...bars].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sorted.length; i++) {
    const out = advancePullbackSetup(state, sorted[i], i > 0 ? sorted[i - 1] : null, now, SETUP_POLICY);
    state = out.state; reason = out.reason;
    if (setupIsTerminal(state) || state.state === SETUP_STATE.TRIGGERED) break;
  }
  return {state, reason};
}
/** The pullback-and-trigger-on-one-bar shape that production kept losing. */
function pullbackThenTrigger(openTime, ref = REF) {
  return [
    bar(openTime - MIN, {open: ref, high: ref, low: ref, close: ref}),
    bar(openTime, {open: ref * 0.998, high: ref * 1.005, low: ref * 0.996, close: ref * 1.004}),
  ];
}

// ---------------------------------------------------------------------------
// 1-4, 22. The trigger clock: what it admits, what it refuses, and what cannot
// move it.
// ---------------------------------------------------------------------------

test('1. a trigger inside its window reaches the execution check with time to spare', () => {
  const {state, reason} = drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000);
  assert.equal(reason, SETUP_REASON.REACCEL_TRIGGERED);
  assert.equal(state.state, SETUP_STATE.TRIGGERED);
  assert.equal(state.triggerAt, CLOSE + MIN, 'the trigger instant is the candle close');
  // The same instant production reached the dispatch check on METUSDT: +8s.
  assert.equal(entryTriggerFresh(state, state.triggerAt + 8_000, REF * 1.004,
    POLICY.maxEntryDriftPct, SETUP_POLICY), null);
  const window = entryExecutionWindow(row(state), true, POLICY.maxEntryAgeMs, SETUP_POLICY);
  assert.equal(window.valid, true);
  assert.equal(window.basis, 'PULLBACK_TRIGGER');
  assert.ok(window.expiresAt - (state.triggerAt + 8_000) >= 50_000,
    'a same-cycle arrival must still hold most of the window');
});

test('2. a trigger found on the NEXT cycle is still executable before it expires', () => {
  const {state} = drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000);
  // Discovered 45 seconds late -- a slow cycle, a restart, a busy queue.
  assert.equal(entryTriggerFresh(state, state.triggerAt + 45_000, REF * 1.004,
    POLICY.maxEntryDriftPct, SETUP_POLICY), null);
});

test('3. a trigger past its deadline is refused, and the deadline is the unchanged 60s', () => {
  const {state} = drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000);
  assert.equal(SETUP_POLICY.entryTriggerTtlMs, 60_000, 'the trigger TTL is not relaxed');
  assert.equal(entryTriggerFresh(state, state.triggerExpiresAt + 1, REF * 1.004,
    POLICY.maxEntryDriftPct, SETUP_POLICY), SETUP_REASON.TRIGGER_STALE);
  // STRKUSDT, 2026-09-18: trigger 08:49:00, refused 08:50:07.517. Still refused.
  assert.equal(entryTriggerFresh(state, state.triggerAt + 67_517, REF * 1.004,
    POLICY.maxEntryDriftPct, SETUP_POLICY), SETUP_REASON.TRIGGER_STALE);
});

test('4. a trigger from the future is refused rather than waited for', () => {
  const {state} = drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000);
  assert.equal(entryTriggerFresh(state, state.triggerAt - 1, REF * 1.004,
    POLICY.maxEntryDriftPct, SETUP_POLICY), SETUP_REASON.TRIGGER_FUTURE);
});

test('22. the deadline is the candle close, never the executor arrival time', () => {
  // Two executors seeing the SAME bar at different moments must compute the same
  // window, or a slow poller silently buys later than a fast one.
  const early = drive(pullbackThenTrigger(CLOSE), CLOSE + 61_000).state;
  const late = drive(pullbackThenTrigger(CLOSE), CLOSE + 119_000).state;
  assert.equal(early.triggerAt, late.triggerAt);
  assert.equal(early.triggerExpiresAt, late.triggerExpiresAt);
  assert.equal(late.triggerExpiresAt, late.triggerAt + SETUP_POLICY.entryTriggerTtlMs);
  // And the window the executor actually uses is min(setup expiry, trigger expiry):
  // an arrival time appears nowhere in it.
  const w = entryExecutionWindow(row(late), true, POLICY.maxEntryAgeMs, SETUP_POLICY);
  assert.equal(w.expiresAt, Math.min(late.expiresAt, late.triggerExpiresAt));
});

// ---------------------------------------------------------------------------
// The arming cycle. 
// ---------------------------------------------------------------------------

/** advanceSignalSetup, lifted into a sandbox with its collaborators stubbed. */
function setupAdvancer({candles, persisted = []}) {
  const audits = [];
  const body = SRC.slice(SRC.indexOf('async function advanceSignalSetup('),
    SRC.indexOf('/**\n * Execution freshness for one entry attempt.'));
  const ctx = {
    Number, Math, Array, String, Object, Error, Promise, JSON, console,
    SETUP_POLICY, SETUP_REASON, SETUP_STATE, SETUP_POLICY_VERSION: SETUP_POLICY.version,
    startPullbackSetup, advancePullbackSetup, expirePullbackSetup, setupIsTerminal,
    serializeSetup, deserializeSetup,
    signalSetup: (r) => deserializeSetup((r?.features?.v17Setup) ?? {}),
    N: (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d),
    rec: (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    audit: async (...a) => { audits.push(a); },
    persistSetup: async (_db, r, state, reason) => {
      persisted.push({reason, state: serializeSetup(state)});
      return {...r, features: {...r.features, v17Setup: serializeSetup(state)}};
    },
    qv3Candles: async () => candles,
    audits, persisted,
    // (2026-09-25) LIVE momentum chase evaluation lives in the same span; these fixtures never chase.
    LIVE_CHASE_ENABLED: true, ...liveChase,
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  return ctx;
}

test('5a. arming and reading the tape are ONE cycle, not two', async () => {
  // GUSDT, 2026-09-18 08:20 UTC. Armed at 08:21:05 and, on the old code, not advanced
  // until 08:22:08 -- by which time its 08:21:00 trigger had expired at 08:22:00.
  const persisted = [];
  const ctx = setupAdvancer({candles: pullbackThenTrigger(CLOSE), persisted});
  const now = CLOSE + 65_000;                       // 08:21:05, the real arm instant
  const out = await ctx.advanceSignalSetup({}, row(), now);
  assert.equal(out.state.state, SETUP_STATE.TRIGGERED,
    'the bar the setup was armed FROM is already complete and must be read now');
  assert.equal(out.state.triggerAt, CLOSE + MIN);
  assert.ok(now < out.state.triggerExpiresAt,
    'the trigger this discovers is still live at the moment it is discovered');
  assert.deepEqual(ctx.audits.map(a => a[5]),
    [SETUP_REASON.ARMED, SETUP_REASON.REACCEL_TRIGGERED],
    'both transitions are audited, in order, in the one cycle');
});

test('5b. a freshly armed setup with nothing to do is still persisted once', async () => {
  const persisted = [];
  // A flat bar: no pullback, no trigger, nothing changes.
  const flat = [bar(CLOSE - MIN, {open: REF, high: REF, low: REF, close: REF}),
    bar(CLOSE, {open: REF, high: REF, low: REF, close: REF})];
  const ctx = setupAdvancer({candles: flat, persisted});
  const out = await ctx.advanceSignalSetup({}, row(), CLOSE + 65_000);
  assert.equal(out.state.state, SETUP_STATE.ARMED);
  assert.equal(persisted.length, 1, 'the armed state must be durable, or it re-arms forever');
  // The proof that the tape WAS read in the arming cycle: the bar is consumed, so the
  // next cycle starts from the one after it instead of re-reading this minute.
  assert.equal(persisted[0].state.lastCandleOpenTime, CLOSE);
  assert.equal(persisted[0].reason, SETUP_REASON.HOLD);
});

test('5c. a market failure right after arming still persists the ARMED state', async () => {
  const persisted = [];
  const ctx = setupAdvancer({candles: null, persisted});
  ctx.qv3Candles = async () => { throw Error('BINANCE_TIMEOUT'); };
  const out = await ctx.advanceSignalSetup({}, row(), CLOSE + 65_000);
  assert.match(out.reason, /^V17_SETUP_MARKET:/);
  assert.equal(persisted.length, 1, 'otherwise the next cycle re-arms and re-audits');
  assert.equal(persisted[0].state.state, SETUP_STATE.ARMED);
});

test('5d. arming does NOT read a bar that has not closed', async () => {
  // The one thing same-cycle advancing must not buy: an unfinished candle.
  const persisted = [];
  const forming = [bar(CLOSE - MIN, {open: REF, high: REF, low: REF, close: REF}),
    bar(CLOSE, {open: REF * 0.998, high: REF * 1.005, low: REF * 0.996, close: REF * 1.004})];
  const ctx = setupAdvancer({candles: forming, persisted});
  // now sits INSIDE the CLOSE bar, so completedCandle must refuse it.
  const out = await ctx.advanceSignalSetup({}, row(), CLOSE + 30_000);
  assert.equal(out.state.state, SETUP_STATE.ARMED, 'a forming bar can never trigger');
});

// ---------------------------------------------------------------------------
// 5, 19, 20, 21. Queue ordering and setup identity.
// ---------------------------------------------------------------------------

test('5. a triggered candidate advances before a merely watching one', () => {
  assert.match(QUEUE, /const stageRank=\(row\)=>\{/,
    'the advance pass must rank by how close a setup is to firing');
  assert.match(QUEUE, /stageRank\(b\)-stageRank\(a\)\|\|Date\.parse\(b\.entry_bar_at\)-Date\.parse\(a\.entry_bar_at\)/,
    'stage first, freshest bar as the tiebreaker');
  // The ranking itself, evaluated exactly as the source writes it.
  const ctx = {SETUP_STATE, setupGoverns: () => true,
    rec: (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})};
  vm.createContext(ctx);
  vm.runInContext(QUEUE.slice(QUEUE.indexOf('const stageRank='),
    QUEUE.indexOf('const advanceOrder=')) + 'this.rank=stageRank;', ctx);
  const of = (state) => ({features: {v17Setup: {state}}});
  assert.ok(ctx.rank(of(SETUP_STATE.TRIGGERED)) > ctx.rank(of(SETUP_STATE.PULLBACK_OBSERVED)));
  assert.ok(ctx.rank(of(SETUP_STATE.PULLBACK_OBSERVED)) > ctx.rank(of(SETUP_STATE.ARMED)));
  assert.ok(ctx.rank(of(SETUP_STATE.ARMED)) > ctx.rank({features: {}}));
  // It is an ordering, not a gate: every one of these still goes through the same
  // advance, the same trigger check and the same admission.
  assert.equal(QUEUE.includes('stageRank') &&
    /if\(state\.state!==SETUP_STATE\.TRIGGERED\)/.test(QUEUE), true);
});

test('20. one symbol holds one queue place, newest bar first', () => {
  assert.match(QUEUE, /if\(seenSymbols\.has\(key\)\)\{superseded\.push\(row\);continue\}/);
  assert.match(QUEUE, /SUPERSEDED_BY_FRESHER_SIGNAL/);
  const ranked = QUEUE.indexOf('Date.parse(b.entry_bar_at)-Date.parse(a.entry_bar_at)');
  const dedupe = QUEUE.indexOf('seenSymbols.has(key)');
  assert.ok(ranked > 0 && ranked < dedupe,
    'the list must be newest-first BEFORE the first row per symbol is kept');
});

test('19+21. a superseded setup cannot resurrect, and identity is bar-scoped', () => {
  const a = setupIdentity({id: 'sig-1', symbol: 'GUSDT', features: {signal5Close: CLOSE}});
  const b = setupIdentity({id: 'sig-2', symbol: 'GUSDT', features: {signal5Close: CLOSE + 300_000}});
  assert.ok(a && b && a !== b, 'a later bar on the same symbol is a different setup');
  assert.ok(a.startsWith(`${SETUP_POLICY.version}:GUSDT:sig-1:`));
  // A persisted setup written by another policy version is refused, not adopted.
  assert.equal(deserializeSetup({...serializeSetup(drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000).state),
    policyVersion: 'V17_SOMETHING_ELSE'}), null);
  // A terminal setup stays terminal whatever arrives next.
  const dead = expirePullbackSetup(
    startPullbackSetup({id: 'sig-1', symbol: 'GUSDT', features: {signal5Close: CLOSE, referenceClose: REF}},
      CLOSE, SETUP_POLICY).state, CLOSE + SETUP_POLICY.setupTtlMs + 1).state;
  assert.equal(setupIsTerminal(dead), true);
  const after = advancePullbackSetup(dead, ...pullbackThenTrigger(CLOSE).reverse(),
    CLOSE + SETUP_POLICY.setupTtlMs + 2, SETUP_POLICY);
  assert.equal(after.changed, false);
  assert.equal(after.state.state, dead.state);
});

// ---------------------------------------------------------------------------
// 6, 7, 17, 18. One symbol's failure is one symbol's failure.
// ---------------------------------------------------------------------------

test('6+7+18. a sizing refusal is symbol-scoped and the queue keeps going', () => {
  const scoped = SRC.match(/const ENTRY_SKIP_SYMBOL_SCOPED=\/\^\(([^)]+)\)/)[1].split('|');
  for (const reason of [SLOT_SIZING_REASON.MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET,
    SLOT_SIZING_REASON.QTY_STEP_EXCEEDS_MARGIN_BUDGET, SLOT_SIZING_REASON.SLOT_FILL_BELOW_FLOOR,
    SLOT_SIZING_REASON.IOC_PRICE_CAP_EXCEEDED, SLOT_SIZING_REASON.INPUT_INVALID,
    SETUP_REASON.TRIGGER_STALE, SETUP_REASON.ENTRY_DRIFT, SETUP_REASON.CHASE_EXPIRED]) {
    assert.ok(scoped.includes(reason),
      `${reason} must be symbol-scoped or one symbol ends the account's cycle`);
  }
  // And the loop must CONTINUE on those, not break.
  assert.match(QUEUE, /if\(!ENTRY_SKIP_SYMBOL_SCOPED\.test\(msg\)\)throw e;\s*\n\s*entry=\{entered:false,reason:msg\};/);
});

test('17. an ACCOUNT-wide refusal still stops the run', () => {
  // (2026-09-25) It also names the stop for every GPT BUY it did not reach.
  assert.match(QUEUE, /if\(releaseStopsRun\(entry\)\)\{stop=\{reason:accountStopReason\(entry\.reason\)[^\n]*\n\s*await noteRest\(index\+1,[^\n]*break\}/);
  assert.match(SRC, /function releaseStopsRun\(entry\)\{return entry\?\.releaseScope!==RELEASE_SCOPE\.SYMBOL\}/,
    'an unlabelled release must keep halting the run -- fail closed');
  for (const accountWide of ['ENTRY_MARGIN_INSUFFICIENT', 'PORTFOLIO_CHANGED_DURING_E1',
    'ENTRY_AVAILABLE_BALANCE_UNREADABLE']) {
    const at = OPEN_BULL.indexOf(accountWide);
    assert.ok(at > 0, `${accountWide} must still exist`);
    const tail = OPEN_BULL.slice(at, at + 400);
    const firstReturn = tail.indexOf('releaseClaim:true');
    if (firstReturn < 0) continue;
    assert.ok(!/releaseScope:RELEASE_SCOPE\.SYMBOL/.test(tail.slice(0, firstReturn + 60)),
      `${accountWide} is account-wide and must not be symbol-scoped`);
  }
});

// ---------------------------------------------------------------------------
// 8-11. The quantity lattice.
// ---------------------------------------------------------------------------

test('8+9. the lattice is searched downward and UNIUSDT becomes an order', () => {
  // UNIUSDT as production refused it, 2026-09-18 03:17 UTC.
  const plan = planSlotEntry(
    {ask: 8.916, quantityStep: 1, priceTick: 0.001, minNotionalUsdt: 5}, CONTRACT_20260918);
  assert.equal(plan.quantity, 10, 'one step below the 11 that overshot');
  assert.equal(plan.boundBy, 'MARGIN_BUDGET_CAP');
  assert.ok(plan.orderMarginUsdt <= slotSizingBounds(CONTRACT_20260918).maxOrderMarginUsdt);
  assert.ok(plan.slotFillBps > 9_900, 'and it is still essentially a full slot');
  // The exact refusal string production wrote, now an order instead.
  let old = null;
  try {
    const bounds = slotSizingBounds(CONTRACT_20260918);
    const ceil = Math.ceil(bounds.requiredNotionalUsdt / 8.916);
    if (ceil * plan.limitPrice / CONTRACT_20260918.leverage > bounds.maxOrderMarginUsdt) old = ceil;
  } catch { /* unreachable */ }
  assert.equal(old, 11, 'the point that used to be the ONLY one evaluated still overshoots');
});

test('10. a genuine exchange minimum above the slot is still a skip', () => {
  assert.throws(
    () => planSlotEntry({ask: 60000, quantityStep: 0.001, priceTick: 0.1, minNotionalUsdt: 100},
      CONTRACT_20260918),
    (e) => e.code === SLOT_SIZING_REASON.MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET &&
      /:max=30\.250000:step=0\.001:qty=0\.002:px=60018$/.test(e.message));
  assert.throws(
    () => planSlotEntry({ask: 95, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5}, CONTRACT_20260918),
    (e) => e.code === SLOT_SIZING_REASON.QTY_STEP_EXCEEDS_MARGIN_BUDGET &&
      e.message === 'QTY_STEP_EXCEEDS_MARGIN_BUDGET:31.676667:max=30.250000:step=1:qty=1:px=95.03');
});

test('11. no admissible quantity can exceed the margin ceiling, over a wide sweep', () => {
  const bounds = slotSizingBounds(CONTRACT_20260918);
  assert.equal(CONTRACT_20260918.targetMarginUsdt, 30, 'the replayed window is pinned to that day\'s slot');
  assert.equal(CONTRACT_20260918.leverage, 3, 'the leverage is unchanged');
  assert.equal(CONTRACT_20260918.maxSlotOvershootBps, 250 / 3, 'the overshoot budget is unchanged');
  assert.equal(bounds.maxOrderMarginUsdt, 30.25);
  let admitted = 0;
  for (const step of [1, 0.1, 0.01, 0.001, 5]) {
    for (let ask = 0.0011; ask < 120; ask *= 1.17) {
      let plan = null;
      try {
        plan = planSlotEntry({ask, quantityStep: step, priceTick: 0.0001, minNotionalUsdt: 5},
          CONTRACT_20260918);
      } catch { continue; }
      admitted++;
      assert.ok(plan.orderMarginUsdt <= bounds.maxOrderMarginUsdt + 1e-9,
        `ask ${ask} step ${step} sized ${plan.orderMarginUsdt} over the ceiling`);
      assert.ok(plan.iocBps <= CONTRACT_20260918.iocMaxBps + 1e-9);
      assert.ok(plan.orderNotionalUsdt + 1e-9 >= 5, 'minNotional is never bypassed');
      assert.ok(plan.referenceNotionalUsdt + 1e-9 >= bounds.minOrderNotionalUsdt);
    }
  }
  assert.ok(admitted > 100, `the sweep must actually admit orders, got ${admitted}`);
});

test('11b. the LIVE contract is 150 USDT at 3x, and its own ceiling is never exceeded', () => {
  // Same sweep, against today's live contract rather than the frozen replay above,
  // so a change to the live slot is caught here even if the historical replay is
  // (correctly) pinned to the day it documents.
  const bounds = slotSizingBounds();
  assert.equal(SLOT_SIZING_CONTRACT.targetMarginUsdt, 150, 'operator instruction, 2026-09-24');
  assert.equal(SLOT_SIZING_CONTRACT.leverage, 3, 'leverage is unchanged by the margin-only resize');
  let admitted = 0;
  for (const step of [1, 0.1, 0.01, 0.001, 5]) {
    for (let ask = 0.0011; ask < 800; ask *= 1.17) {
      let plan = null;
      try { plan = planSlotEntry({ask, quantityStep: step, priceTick: 0.0001, minNotionalUsdt: 5}); }
      catch { continue; }
      admitted++;
      assert.ok(plan.orderMarginUsdt <= bounds.maxOrderMarginUsdt + 1e-9,
        `ask ${ask} step ${step} sized ${plan.orderMarginUsdt} over the ceiling`);
      assert.ok(plan.iocBps <= SLOT_SIZING_CONTRACT.iocMaxBps + 1e-9);
      assert.ok(plan.orderNotionalUsdt + 1e-9 >= 5, 'minNotional is never bypassed');
      assert.ok(plan.referenceNotionalUsdt + 1e-9 >= bounds.minOrderNotionalUsdt);
    }
  }
  assert.ok(admitted > 100, `the sweep must actually admit orders, got ${admitted}`);
});

// ---------------------------------------------------------------------------
// 12-14. Drift and quote freshness: still refusing, for the right reasons.
// ---------------------------------------------------------------------------

test('12. a genuine 1%+ move above the reference is still refused', () => {
  assert.equal(POLICY.maxEntryDriftPct, 0.01, 'the drift ceiling is unchanged');
  const {state} = drive(pullbackThenTrigger(CLOSE), CLOSE + 65_000);
  // GUSDT, 2026-09-18 08:00 UTC: reference 0.007177, limit 0.007255, drift +1.087%.
  const refused = entryTriggerFresh({...state, referencePrice: 0.007177},
    state.triggerAt + 12_000, 0.007255, POLICY.maxEntryDriftPct, SETUP_POLICY);
  assert.equal(refused, SETUP_REASON.ENTRY_DRIFT);
  // Its evidence must name every number the verdict was reached from.
  const evidence = entryPriceEvidence(row(state), 0.007255, state.triggerAt + 12_000,
    'PRE_DISPATCH_PRICE', {best_bid: 0.007250, best_ask: 0.007252,
      timing: {received_at_ms: state.triggerAt + 11_800}},
    entryExecutionWindow(row(state), true, POLICY.maxEntryAgeMs, SETUP_POLICY),
    POLICY.maxEntryDriftPct, refused);
  for (const field of ['signalId', 'symbol', 'setupState', 'referencePrice', 'evaluatedPrice',
    'bestAsk', 'bestBid', 'quoteReceivedAt', 'quoteAgeMs', 'driftPct', 'maxDriftPct',
    'upperAllowedPrice', 'lowerAllowedPrice', 'triggerAt', 'triggerExpiresAt', 'evaluatedAt']) {
    assert.notEqual(evidence[field], null, `${field} must be recorded on a drift refusal`);
    assert.notEqual(evidence[field], undefined, `${field} must be recorded on a drift refusal`);
  }
  assert.equal(evidence.quoteAgeMs, 200);
  assert.equal(evidence.executionWindow.basis, 'PULLBACK_TRIGGER');
  assert.ok(evidence.driftPct > POLICY.maxEntryDriftPct);
});

test('13. a stale, future or crossed book is still refused', () => {
  const now = Date.parse('2026-09-18T08:21:08.000Z');
  const book = (over) => normalizeEntryBook({best_bid: 1, best_ask: 1.001,
    bids: [{price: 1, size: 100}], asks: [{price: 1.001, size: 100}],
    timing: {requested_at_ms: now - 1200, received_at_ms: now - 1100}, ...over},
    E1_POLICY.maxQuoteAgeMs, now);
  assert.equal(E1_POLICY.maxQuoteAgeMs, 1_000, 'the quote-age policy is unchanged');
  assert.ok(book({}).health.reasons.includes('QUOTE_STALE'));
  assert.ok(book({timing: {requested_at_ms: now + 10, received_at_ms: now + 50}})
    .health.reasons.includes('QUOTE_FROM_FUTURE'));
  assert.ok(book({best_bid: 1.002}).health.reasons.includes('CROSSED_BOOK'));
  assert.ok(book({asks: []}).health.reasons.includes('NO_ASK_DEPTH'));
  // And E1's own admission refuses the same stale quote rather than passing it.
  const stale = startE1({decisionAt: now, signalId: 'sig-1', symbol: 'GUSDT',
    signalExpiresAt: now + 50_000, baselineEligible: true,
    tape: {available: true, last10sReturn: 0.001, takerBuyQuoteShare: 0.6,
      startAt: now - 10_000, endAt: now, tradeCount: 20},
    quote: {bid: 1, ask: 1.001, receivedAt: now - 1_100, bookGap: false}});
  assert.equal(stale.allowed, false);
  assert.deepEqual(stale.reasonCodes, ['E1_QUOTE_UNKNOWN']);
});

test('14. a fresh, complete book passes the same checks', () => {
  const now = Date.parse('2026-09-18T08:21:08.000Z');
  const healthy = normalizeEntryBook({best_bid: 1, best_ask: 1.001,
    bids: [{price: 1, size: 100}, {price: 0.999, size: 100}],
    asks: [{price: 1.001, size: 100}, {price: 1.002, size: 100}],
    timing: {requested_at_ms: now - 120, received_at_ms: now - 60}},
    E1_POLICY.maxQuoteAgeMs, now);
  assert.deepEqual(healthy.health.reasons, []);
  assert.equal(healthy.health.bookHealthy, true);
  assert.equal(healthy.health.bookAgeMs, 60);
});

// ---------------------------------------------------------------------------
// The fix itself: nothing may sit between the pricing quote and the dispatch check.
// ---------------------------------------------------------------------------

test('the dispatch quote is read alongside BOO, not before it', () => {
  const tail = OPEN_BULL.slice(OPEN_BULL.indexOf('// Final gateway check uses a new account observation'));
  assert.match(tail, /booGateInputs\(db,s\),\s*\n\s*E1_ENABLED\?gateway\(\{action:"quote",market:s\.symbol\},3000\)/,
    "BOO's reads and the pricing quote must be issued in the SAME round trip");
  assert.match(SRC, /async function booGateInputs\(db,s\)\{/);
  assert.match(SRC, /function booVerdict\(s,phase,inputs,\{quote,info,snapshot,pair,orders\}\)\{/,
    'the verdict itself must be pure so it costs the quote nothing');
  assert.match(SRC, /function decideEntryWith\(controls,pair,candidateSymbol,openOrders,/,
    'the entry-control verdict must be pure for the same reason');
});

test('NOTHING awaits between the dispatch quote and the quote-age check', () => {
  // This is the whole defect, expressed as a property of the source: every `await`
  // in that span is a millisecond charged against E1_POLICY.maxQuoteAgeMs. On the
  // happy path the two calls left below write nothing (recordMismatch returns on an
  // empty issue list; persistDecisionRisk returns as soon as the decision is allowed).
  const from = OPEN_BULL.indexOf('const[rawFinalCheck,finalOrders,dispatchSnap,booInputs,dispatchQuote]');
  const to = OPEN_BULL.indexOf('E1_DISPATCH_QUOTE_AGED');
  assert.ok(from > 0 && to > from, 'the dispatch block must be recognisable');
  const span = OPEN_BULL.slice(OPEN_BULL.indexOf('\n', from), to);
  const awaits = [...span.matchAll(/await\s+([A-Za-z0-9_.]+)\s*\(/g)];
  assert.deepEqual([...new Set(awaits.map(m => m[1]))].sort(),
    ['audit', 'persistDecisionRisk', 'recordBooVerdict', 'recordMismatch'],
    `unexpected awaited work before the dispatch check: ${awaits.map(m => m[1])}`);
  // Each of the four is accounted for. `audit` and `recordBooVerdict` sit inside
  // branches that RETURN a refusal, so neither is on the path to an order...
  for (const m of awaits) {
    if (m[1] !== 'audit' && m[1] !== 'recordBooVerdict') continue;
    const after = span.slice(m.index, m.index + 500);
    assert.ok(/return\{entered:false/.test(after) &&
      after.indexOf('return{entered:false') < (after.indexOf('await ', 10) + 1 || Infinity),
      `${m[1]} must be followed by a refusal return, not by more work on the order path`);
  }
  // ...and the other two write NOTHING when the account is clean and the decision is
  // allowed, which is the only state in which an order is reached.
  const mismatch = SRC.slice(SRC.indexOf('async function recordMismatch(db,match)'));
  assert.ok(mismatch.indexOf('if(!all.length)return[];') > 0 &&
    mismatch.indexOf('if(!all.length)return[];') < mismatch.indexOf('await incident('),
    'recordMismatch must return before any write on a clean classification');
  assert.match(SRC, /if\(decision\.allowed\|\|decision\.scope===CONTROL_SCOPE\.OPERATOR_HALT\)return;/,
    'persistDecisionRisk must return before any write on an allowed decision');
  // And the BOO write, a dashboard concern, is after the decision rather than in it.
  const record = OPEN_BULL.indexOf('await recordBooVerdict(db,{signalId:s.id,symbol:s.symbol,phase:"PRE_DISPATCH"',
    OPEN_BULL.indexOf('E1_DISPATCH_QUOTE_AGED'));
  assert.ok(record > OPEN_BULL.indexOf('E1_DISPATCH_QUOTE_AGED'),
    'the pre-dispatch BOO verdict must be recorded after the freshness check, not before it');
});

test('the quote-age guard itself is unchanged and still fail-closed', () => {
  assert.match(OPEN_BULL,
    /if\(!Number\.isSafeInteger\(receivedAt\)\|\|quoteAge<0\|\|quoteAge>E1_POLICY\.maxQuoteAgeMs\)/,
    'an unknown, future or over-age quote must still refuse the dispatch');
  assert.equal(E1_POLICY.maxQuoteAgeMs, 1_000, 'and the budget it is measured against is unchanged');
  assert.match(OPEN_BULL, /const freshness=checkedEntryFresh\(s,f,checkedAt,limitPrice,attempt,"PRE_DISPATCH_PRICE",q\);if\(freshness\)throw Error\(freshness\);/,
    'the drift and trigger-window recheck immediately before the intent must remain');
});

test('E1 no longer spends a 60s trigger on a 30s watch it was going to discard', () => {
  assert.match(SRC, /while\(watchFastWeak&&state\.confirmationState==="WATCH_FAST_WEAK"\)\{/);
  assert.match(SRC, /runE1Gate\(s,q,step,gateway,filters,!setupGoverns\(s\)\)/,
    'setup-governed signals must not enter the watch at all');
  assert.equal(E1_POLICY.watchMs, 30_000, 'the watch policy itself is unchanged');
  // The initial state the conversion acts on is exactly the one E1 produces, so the
  // conversion is now reachable instead of being dead code behind a drained loop.
  const now = Date.parse('2026-09-18T08:49:07.000Z');
  const weak = startE1({decisionAt: now, signalId: 'sig-1', symbol: 'STRKUSDT',
    signalExpiresAt: now + 53_000, baselineEligible: true,
    tape: {available: true, last10sReturn: -0.004, takerBuyQuoteShare: 0.30,
      startAt: now - 10_000, endAt: now, tradeCount: 30},
    quote: {bid: 1, ask: 1.001, receivedAt: now - 100, bookGap: false}});
  assert.equal(weak.confirmationState, 'WATCH_FAST_WEAK');
  assert.equal(weak.defer, true);
  assert.deepEqual(weak.reasonCodes, ['E1_FAST_WEAK_WATCH'],
    'the executor converts exactly this one code, so it must be exactly this one code');
  // Every OTHER E1 outcome is untouched: unknown data still defers, and the tape
  // being unavailable is never converted into a pass.
  const unknown = startE1({decisionAt: now, signalId: 'sig-1', symbol: 'STRKUSDT',
    signalExpiresAt: now + 53_000, baselineEligible: true,
    tape: {available: false, reason: 'E1_TAPE_TRUNCATED'},
    quote: {bid: 1, ask: 1.001, receivedAt: now - 100, bookGap: false}});
  assert.equal(unknown.allowed, false);
  assert.deepEqual(unknown.reasonCodes, ['E1_TAPE_TRUNCATED']);
  const conversion = OPEN_BULL.slice(OPEN_BULL.indexOf('if(setupGoverns(s)&&e1Decision.defer===true'));
  assert.match(conversion, /e1Decision\.reasonCodes\.length===1&&\s*\n?\s*e1Decision\.reasonCodes\[0\]==="E1_FAST_WEAK_WATCH"/,
    'only the single fast-weak code is converted; a multi-code defer is not');
});

// ---------------------------------------------------------------------------
// 15-16, 23-25. Invariants this change is not allowed to touch.
// ---------------------------------------------------------------------------

test('15+16. OBSERVE records and admits; ENFORCE blocks', () => {
  assert.match(OPEN_BULL, /if\(booFinal\.blocks\)\{/);
  const adapter = readFileSync(new URL(
    '../../supabase/functions/v10-lane-executor/boo-entry-adapter.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /blocks: gateContext\.enforcement === ENFORCEMENT\.ENFORCE && !verdict\.allowed/,
    'a refusal can only BLOCK under ENFORCE');
  assert.match(adapter, /blocks: enforcing && !combined\.allowed/);
  // Under OBSERVE the verdict is recorded and the entry proceeds: `blocks` is the
  // ONLY thing openBull branches on, and it is false whenever enforcement is not
  // ENFORCE, however the verdict itself came out.
  assert.equal(OPEN_BULL.includes('if(booAdmission.blocks)return{entered:false'), true);
  assert.ok(!/if\(!booAdmission\.verdict\.allowed\)return/.test(OPEN_BULL),
    'the raw verdict must never gate the entry on its own');
  assert.ok(!/if\(!booPredispatch\.verdict\.allowed\)return/.test(OPEN_BULL));
  // Both checkpoints record their verdict whatever the enforcement mode.
  assert.equal((OPEN_BULL.match(/recordBooVerdict\(db,\{/g) ?? []).length, 3,
    'admission, the pre-dispatch block branch and the pre-dispatch allow branch');
  // And the writer swallows its own failures, so logging can never refuse a trade.
  assert.match(adapter, /\} catch \{\s*\n\s*\/\/ Intentionally swallowed/);
});

test('23. exit, protection and reconciliation are untouched by this change', () => {
  // Source parity against the merge base for every path that is not entry sizing or
  // entry latency. If one of these moves, this release is no longer what it claims.
  for (const marker of [
    'async function closePos(db,p,fraction,reason,ctx={})',
    'async function reconcileNativeCloseBeforeDispatch(db,p,fraction,gw=opsGateway(db))',
    'lastProtection=await protectNewLeaderPosition({enabled:NATIVE_STOP_ENABLED',
    'if(!ownedEntry(p,orders))throw Error("EXIT_OWNERSHIP_UNPROVEN")',
    'await circuit(db,`EXIT_PENDING:${p.symbol}`,"KNOWN_ORDER_PENDING_RECONCILIATION"',
    'if(current.data.state!=="OPEN")return {closed:current.data.state==="CLOSED"',
  ]) assert.ok(SRC.includes(marker), `exit path changed: ${marker}`);
  assert.match(SRC, /const NATIVE_STOP_ENABLED=env\("V17_NATIVE_STOP"\)==="true";/,
    'the native stop stays an explicit operator action');
  assert.match(SRC, /const MAX_SLOTS=10,/, 'the account-wide slot limit is untouched');
  assert.equal(SETUP_POLICY.setupTtlMs, 900_000, 'the setup window is unchanged');
  assert.equal(SETUP_POLICY.minPullbackPct, 0.0025);
  assert.equal(SETUP_POLICY.minReaccelPct, 0.0025);
  assert.equal(SETUP_POLICY.maxChasePct, 0.01);
  assert.equal(POLICY.maxEntryAgeMs, 120_000, 'the legacy signal clock is unchanged');
});

test('24. nothing in this test file can reach an exchange', () => {
  // Every test above is pure or sandboxed: no fetch, no gateway, no DB client.
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  const body = self.slice(self.indexOf("test('1."), self.indexOf("test('24."));
  // Assembled at runtime so this scanner cannot match its own forbidden list.
  for (const forbidden of ['fet' + 'ch(', 'create' + 'Client', 'fapi.' + 'binance.com',
    'create_' + 'order', 'p10_' + 'portfolio']) {
    assert.ok(!body.includes(forbidden), `a regression test must never reference ${forbidden}`);
  }
  // And the order path is reached only through the gateway command the release gate
  // pins, so a test can never construct one by accident.
  assert.match(SRC, /rp=\{action:"create_order",leverage:LEV,order:\{market:s\.symbol,side:"BUY",type:"LIMIT"/);
});

test('25. the account-mode observation is authenticated, fresh and explicitly one-way', () => {
  assert.match(SRC, /modeSupported:supportedFuturesMode\(positionMode,Date\.now\(\)\)/);
  assert.match(SRC, /opsGateway\(db\)\(\{action:"futures_position_mode"\},2000\)\.catch\(\(\)=>null\)/,
    'an unreadable mode must become an absent observation, never an assumed one');
  const now = Date.parse('2026-09-18T08:21:08.000Z');
  const good = {exchange: 'binance_futures', account_scope: 'futures', dual_side_position: false,
    position_mode: 'ONE_WAY', observation: {id: 'obs-1', source: 'BINANCE_POSITION_MODE_REST',
      requested_at_ms: now - 200, received_at_ms: now - 100}};
  assert.equal(supportedFuturesMode(good, now), true);
  // Absent, unauthenticated, stale, hedge-mode: every one of them refuses.
  assert.equal(supportedFuturesMode(null, now), false);
  assert.equal(supportedFuturesMode({...good, observation: {...good.observation,
    source: 'ASSUMED'}}, now), false);
  assert.equal(supportedFuturesMode({...good, observation: {...good.observation,
    requested_at_ms: now - 9_000, received_at_ms: now - 8_900}}, now), false);
  assert.equal(supportedFuturesMode({...good, dual_side_position: true}, now), false);
  assert.equal(supportedFuturesMode({...good, position_mode: 'HEDGE'}, now), false);
});

// ---------------------------------------------------------------------------
// 2026-09-25 LIVE momentum chase: the frozen machine still says CHASE_EXPIRED; the market
// state at that chase bar decides whether GPT sees a trigger.
// ---------------------------------------------------------------------------
/** 66 completed 1m bars: an hour drifting up to the reference, then the first bar after arm
 * jumps 2% above it (the chase bar). `vol5`/`buy` shape the last five bars. */
function chaseTape({vol5 = 2, buy = 0.6} = {}) {
  const out = [];
  for (let i = 0; i < 66; i++) {
    const t = CLOSE - 65 * MIN + i * MIN, chase = i === 65;
    const c = chase ? REF * 1.02 : REF * (0.97 + 0.0299 * i / 64), o = chase ? REF * 1.0005 : c * 0.9995;
    const q = i >= 61 ? 1000 * vol5 : 1000;
    out.push([t, String(o), String(Math.max(o, c) * 1.0004), String(Math.min(o, c) * 0.9996), String(c), '0', t + MIN - 1,
      String(q), 0, '0', String(q * buy), '0']);
  }
  return out;
}
test('LIVE chase: CHASE LIVE becomes a GPT trigger in the same cycle; CHASE DEAD stays rejected with its evidence', async () => {
  const live = setupAdvancer({candles: chaseTape()});
  const now = CLOSE + MIN + 5_000;                  // the chase bar (armed bar) closed 5 s ago
  const out = await live.advanceSignalSetup({}, row(), now);
  assert.equal(out.state.state, SETUP_STATE.TRIGGERED);
  assert.equal(out.state.triggerMode, 'LIVE_MOMENTUM_CHASE');
  assert.equal(out.state.chase.state, 'LIVE');
  assert.equal(out.state.triggerAt, CLOSE + MIN);
  assert.ok(now < out.state.triggerExpiresAt, 'inside the ordinary 60 s trigger window');
  assert.equal(live.audits.at(-1)[5], 'V17_LIVE_CHASE_TRIGGERED');
  assert.equal(live.audits.at(-1)[6].setup.chase.state, 'LIVE', 'the chase evidence is audited');

  const dead = setupAdvancer({candles: chaseTape({vol5: 0.4, buy: 0.4})});
  const d = await dead.advanceSignalSetup({}, row(), now);
  assert.equal(d.state.state, SETUP_STATE.CHASE_EXPIRED);
  assert.match(d.state.terminalReason, /^V17_CHASE_EXPIRED:DEAD:.*VOLUME_FADING/);
  assert.equal(d.state.chase.state, 'DEAD');

  const off = setupAdvancer({candles: chaseTape()});off.LIVE_CHASE_ENABLED = false;
  const k = await off.advanceSignalSetup({}, row(), now);
  assert.equal(k.state.state, SETUP_STATE.CHASE_EXPIRED);assert.equal(k.state.terminalReason, SETUP_REASON.CHASE_EXPIRED,
    'FD1_LIVE_CHASE_TO_GPT=false restores the original verdict exactly');

  const late = setupAdvancer({candles: chaseTape()});
  const l = await late.advanceSignalSetup({}, row(), CLOSE + 2 * MIN + 1_000);
  assert.equal(l.state.state, SETUP_STATE.CHASE_EXPIRED, 'a chase first seen after its window is not a trigger');
  assert.match(l.state.terminalReason, /^V17_CHASE_EXPIRED:STALE:CHASE_TRIGGER_WINDOW_UNAVAILABLE/);

  const blind = setupAdvancer({candles: chaseTape()});
  let reads = 0;blind.qv3Candles = async () => (++reads === 1 ? chaseTape() : Promise.reject(Error('HTTP_429')));
  const b = await blind.advanceSignalSetup({}, row(), now);
  assert.equal(b.state.state, SETUP_STATE.CHASE_EXPIRED, 'no market data: the rejection stands');
  assert.match(b.state.terminalReason, /CHASE_DATA_UNAVAILABLE/);
});
