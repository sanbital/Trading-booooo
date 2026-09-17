// Deterministic cover for the V17 pullback / re-acceleration entry timing.
//
// The thresholds are frozen inputs, not things this suite is allowed to discover.
// What it pins is the SHAPE of the decision: that a setup cannot enter without a
// real dip, cannot enter on a bar that is not itself a recovery, cannot chase more
// than 1% above the level it was armed at, cannot be re-entered, cannot be revived
// after it ends, and cannot read a bar that has not finished forming.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advancePullbackSetup,
  completedCandle,
  deserializeSetup,
  enterPullbackSetup,
  entryTriggerFresh,
  expirePullbackSetup,
  invalidatePullbackSetup,
  isTerminal,
  serializeSetup,
  SETUP_POLICY,
  SETUP_REASON,
  SETUP_STATE,
  setupIdentity,
  startPullbackSetup,
} from "./leader-pullback-reaccel.mjs";
import { POLICY, STRATEGY } from "./leader-momentum-v17.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-09-15T12:00:00.000Z");
const REF = 100;

/** A completed 1m kline in the gateway's array shape. */
function bar(openTime: number, o: number, h: number, l: number, c: number): any[] {
  return [openTime, String(o), String(h), String(l), String(c), "1000", openTime + MIN - 1,
    "1000", 10, "500", "500", "0"];
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    id: "sig-1",
    symbol: "TESTUSDT",
    features: { strategy: STRATEGY, referenceClose: REF, signal5Close: T0, ...overrides },
  };
}

/** Arm, then feed bars in order. `now` tracks one millisecond past each close. */
function drive(bars: any[][], startAt = T0): { state: any; last: string } {
  const armed: any = startPullbackSetup(signal(), startAt);
  assert(armed.ok);
  let state: any = armed.state, last: string = SETUP_REASON.ARMED;
  for (let i = 0; i < bars.length; i++) {
    const now = Number(bars[i][6]) + 1;
    const out: any = advancePullbackSetup(state, bars[i], i > 0 ? bars[i - 1] : null, now);
    state = out.state;
    last = out.reason;
  }
  return { state, last };
}

// ---------------------------------------------------------------- 1
Deno.test("CASE 1: a confirmed signal arms a setup and orders nothing", () => {
  const out: any = startPullbackSetup(signal(), T0);
  assert(out.ok);
  assertEquals(out.state.state, SETUP_STATE.ARMED);
  assertEquals(out.state.referencePrice, REF);
  assertEquals(out.state.expiresAt, T0 + SETUP_POLICY.setupTtlMs);
  assertEquals(out.state.pullbackObserved, false);
  assertEquals(out.state.triggerAt, null, "no trigger, therefore nothing executable");
  assertEquals(SETUP_POLICY.setupTtlMs, 15 * MIN);
});

// ---------------------------------------------------------------- 2
Deno.test("CASE 2: a 0.24% dip is not a pullback", () => {
  const { state } = drive([bar(T0, 100, 100.1, 99.76, 99.9)]);
  assertEquals(state.state, SETUP_STATE.ARMED);
  assertEquals(state.pullbackObserved, false);
});

// ---------------------------------------------------------------- 3
Deno.test("CASE 3: a 0.25% dip is a pullback, and the low is remembered", () => {
  const { state } = drive([bar(T0, 100, 100.1, 99.75, 99.9)]);
  assertEquals(state.state, SETUP_STATE.PULLBACK_OBSERVED);
  assertEquals(state.pullbackObserved, true);
  assertEquals(state.pullbackLow, 99.75);
});

Deno.test("the remembered pullback low only ever deepens", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.70, 99.9),
    bar(T0 + MIN, 99.9, 100, 99.50, 99.8),
    bar(T0 + 2 * MIN, 99.8, 100, 99.90, 99.95),
  ]);
  assertEquals(state.pullbackLow, 99.50);
});

// ---------------------------------------------------------------- 4
Deno.test("CASE 4: a bearish candle after the pullback does not trigger", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 100.6, 100.7, 99.8, 100.4), // bearish: close < open
  ]);
  assertEquals(state.state, SETUP_STATE.PULLBACK_OBSERVED);
});

// ---------------------------------------------------------------- 5
Deno.test("CASE 5: bullish but not above the previous close does not trigger", () => {
  const { state } = drive([
    bar(T0, 100, 100.7, 99.7, 100.6),
    bar(T0 + MIN, 100.2, 100.7, 100.1, 100.5), // bullish, but 100.5 < prev 100.6
  ]);
  assertEquals(state.state, SETUP_STATE.PULLBACK_OBSERVED);
});

// ---------------------------------------------------------------- 6
Deno.test("CASE 6: a recovery to only +0.20% does not trigger", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.25, 99.9, 100.20), // +0.20%, below the +0.25% gate
  ]);
  assertEquals(state.state, SETUP_STATE.PULLBACK_OBSERVED);
});

// ---------------------------------------------------------------- 7
Deno.test("CASE 7: pullback then +0.25% bullish recovery triggers", () => {
  const { state, last } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.30, 99.9, 100.25),
  ]);
  assertEquals(last, SETUP_REASON.REACCEL_TRIGGERED);
  assertEquals(state.state, SETUP_STATE.TRIGGERED);
  assertEquals(state.triggerClose, 100.25);
  // The executable window starts when the candle CLOSED, not when it was polled.
  assertEquals(state.triggerAt, T0 + 2 * MIN);
  assertEquals(state.triggerExpiresAt, T0 + 2 * MIN + SETUP_POLICY.entryTriggerTtlMs);
});

Deno.test("a re-acceleration without a prior pullback never triggers", () => {
  const { state } = drive([
    bar(T0, 100, 100.4, 99.99, 100.3),
    bar(T0 + MIN, 100.3, 100.6, 100.2, 100.5),
  ]);
  assertEquals(state.state, SETUP_STATE.ARMED, "no dip, no entry -- this is the whole point");
});

// ---------------------------------------------------------------- 8
Deno.test("CASE 8: a close above +1% ends the setup as a chase, before any entry", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 101.2, 99.9, 101.01),
  ]);
  assertEquals(state.state, SETUP_STATE.CHASE_EXPIRED);
  assertEquals(state.terminalReason, SETUP_REASON.CHASE_EXPIRED);
  assert(isTerminal(state));
});

Deno.test("the chase ceiling applies before a pullback too", () => {
  const { state } = drive([bar(T0, 100, 101.5, 99.99, 101.2)]);
  assertEquals(state.state, SETUP_STATE.CHASE_EXPIRED);
});

Deno.test("a close at exactly +1% is still inside the ceiling", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 101.1, 99.9, 101),
  ]);
  assertEquals(state.state, SETUP_STATE.TRIGGERED, "1.00% exactly is allowed, 1.01% is not");
});

// ---------------------------------------------------------------- 9
Deno.test("CASE 9: the setup expires 15 minutes after arming", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  const never: any = expirePullbackSetup(armed.state, T0 + 15 * MIN + 1);
  assertEquals(never.state.state, SETUP_STATE.EXPIRED_NO_PULLBACK);
  assertEquals(never.state.terminalReason, SETUP_REASON.SETUP_EXPIRED);

  const { state } = drive([bar(T0, 100, 100.1, 99.7, 99.9)]);
  const pulled: any = expirePullbackSetup(state, T0 + 15 * MIN + 1);
  assertEquals(pulled.state.state, SETUP_STATE.EXPIRED_NO_REACCEL,
    "a setup that dipped but never recovered is a different miss from one that never dipped");
});

Deno.test("a bar arriving after the window closed cannot rescue the setup", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  const late: any = advancePullbackSetup(armed.state,
    bar(T0 + 16 * MIN, 99.9, 100.3, 99.7, 100.25), null, T0 + 17 * MIN);
  assert(isTerminal(late.state), "expiry is evaluated before the bar");
  assertEquals(late.state.state, SETUP_STATE.EXPIRED_NO_PULLBACK);
});

// ---------------------------------------------------------------- 10
Deno.test("CASE 10: re-applying the same candle changes nothing", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  const b = bar(T0, 100, 100.1, 99.5, 99.9);
  const first: any = advancePullbackSetup(armed.state, b, null, T0 + MIN);
  const again: any = advancePullbackSetup(first.state, b, null, T0 + MIN);
  assertEquals(again.reason, SETUP_REASON.CANDLE_IGNORED_DUPLICATE);
  assertEquals(again.changed, false);
  assertEquals(again.state.pullbackLow, first.state.pullbackLow);
  assertEquals(again.state.transitions.length, first.state.transitions.length);
});

Deno.test("a trigger cannot be produced twice from the same minute", () => {
  const b0 = bar(T0, 100, 100.1, 99.7, 99.9), b1 = bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25);
  const armed: any = startPullbackSetup(signal(), T0);
  const s1: any = advancePullbackSetup(armed.state, b0, null, T0 + MIN).state;
  const s2: any = advancePullbackSetup(s1, b1, b0, T0 + 2 * MIN);
  assertEquals(s2.state.state, SETUP_STATE.TRIGGERED);
  const s3: any = advancePullbackSetup(s2.state, b1, b0, T0 + 2 * MIN);
  assertEquals(s3.reason, SETUP_REASON.AWAITING_ENTRY,
    "a triggered setup stops reading the tape; it is executed or it expires");
  assertEquals(s3.changed, false);
  assertEquals(s3.state.triggerAt, s2.state.triggerAt, "and never re-arms a second trigger");
});

Deno.test("out-of-order bars are refused rather than reordered", () => {
  const b0 = bar(T0, 100, 100.1, 99.7, 99.9), b1 = bar(T0 + MIN, 99.9, 100, 99.8, 99.95);
  const armed: any = startPullbackSetup(signal(), T0);
  const s1: any = advancePullbackSetup(armed.state, b1, b0, T0 + 2 * MIN).state;
  const back: any = advancePullbackSetup(s1, b0, null, T0 + 2 * MIN);
  assertEquals(back.reason, SETUP_REASON.CANDLE_IGNORED_DUPLICATE);
});

Deno.test("a bar from before the signal is ignored", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  const out: any = advancePullbackSetup(armed.state,
    bar(T0 - 5 * MIN, 100, 100.1, 99.0, 99.2), null, T0 + MIN);
  assertEquals(out.reason, SETUP_REASON.CANDLE_IGNORED_BEFORE_ARM);
  assertEquals(out.state.pullbackObserved, false);
});

// ---------------------------------------------------------------- 11
Deno.test("CASE 11: a second signal on the same symbol maps to a different identity", () => {
  const a: any = setupIdentity(signal());
  const b: any = setupIdentity({ ...signal(), id: "sig-2", features: { ...signal().features, signal5Close: T0 + 5 * MIN } });
  assert(a && b && a !== b);
  // Identity is deterministic: two executors derive the same string with no coordination.
  assertEquals(setupIdentity(signal()), a);
  assert(a.startsWith(SETUP_POLICY.version));
});

Deno.test("an identity cannot be formed from an incomplete signal", () => {
  assertEquals(setupIdentity({ symbol: "X", features: {} }), null);
  assertEquals(setupIdentity({ id: "s", features: { signal5Close: T0 } }), null);
});

// ---------------------------------------------------------------- 12
Deno.test("CASE 12: a terminal setup cannot be resurrected by anything", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 101.2, 99.9, 101.01), // CHASE_EXPIRED
  ]);
  assert(isTerminal(state));
  const after: any = advancePullbackSetup(state, bar(T0 + 2 * MIN, 100, 100.4, 99.6, 100.3),
    bar(T0 + MIN, 99.95, 101.2, 99.9, 101.01), T0 + 3 * MIN);
  assertEquals(after.changed, false);
  assertEquals(after.state.state, SETUP_STATE.CHASE_EXPIRED);
  assertEquals(expirePullbackSetup(state, T0 + 20 * MIN).changed, false);
  assertEquals(invalidatePullbackSetup(state, T0 + 20 * MIN, "X").changed, false);
  assertEquals(enterPullbackSetup(state, T0 + 20 * MIN).reason, SETUP_REASON.NOT_TRIGGERED);
});

Deno.test("an entered setup is terminal and cannot be entered twice", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25),
  ]);
  const entered: any = enterPullbackSetup(state, T0 + 2 * MIN + 5_000, { price: 100.3 });
  assertEquals(entered.state.state, SETUP_STATE.ENTERED);
  assertEquals(entered.state.entryPrice, 100.3);
  assertEquals(enterPullbackSetup(entered.state, T0 + 2 * MIN + 6_000).reason,
    SETUP_REASON.NOT_TRIGGERED);
});

// ---------------------------------------------------------------- 13
Deno.test("CASE 13: a setup round-trips through persistence unchanged", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25),
  ]);
  const restored: any = deserializeSetup(JSON.parse(JSON.stringify(serializeSetup(state))));
  assert(restored);
  assertEquals(restored.state, SETUP_STATE.TRIGGERED);
  assertEquals(restored.referencePrice, state.referencePrice);
  assertEquals(restored.triggerAt, state.triggerAt);
  assertEquals(restored.pullbackLow, state.pullbackLow);
  assertEquals(restored.lastCandleOpenTime, state.lastCandleOpenTime);
  // And the restored setup behaves identically from here.
  assertEquals(entryTriggerFresh(restored, state.triggerAt + 1_000, 100.3, POLICY.maxEntryDriftPct),
    null);
});

Deno.test("a persisted setup from another policy version is refused, not adapted", () => {
  const { state } = drive([bar(T0, 100, 100.1, 99.7, 99.9)]);
  const foreign = { ...serializeSetup(state), policyVersion: "SOMETHING_ELSE" };
  assertEquals(deserializeSetup(foreign), null);
  assertEquals(deserializeSetup({ ...serializeSetup(state), referencePrice: 0 }), null);
  assertEquals(deserializeSetup(null), null);
});

Deno.test("transitions are capped so a long watch cannot grow the row without bound", () => {
  const bars = [];
  for (let i = 0; i < 14; i++) bars.push(bar(T0 + i * MIN, 100, 100.1, 99.5, 99.9));
  const { state } = drive(bars);
  // 14 bars, but only the transitions that actually changed something are recorded:
  // ARMED and the first PULLBACK_CONFIRMED. A long watch does not grow the row.
  assertEquals(state.transitions.length, 2);
  assert(serializeSetup(state, 1).transitions.length <= 1);
  const many = { ...state, transitions: Array.from({ length: 50 }, (_, i) => ({ at: i })) };
  assertEquals(serializeSetup(many, 4).transitions.length, 4);
});

// ---------------------------------------- completeness of the bar contract
Deno.test("an incomplete or malformed candle is never read", () => {
  const b = bar(T0, 100, 100.1, 99.5, 99.9);
  assertEquals(completedCandle(b, Number(b[6])), null, "closeTime == now is still forming");
  assertEquals(completedCandle(b, Number(b[6]) + 1)?.close, 99.9);
  assertEquals(completedCandle([T0, "1", "1", "1", "1", "0", T0 + 1000], T0 + MIN), null,
    "a closeTime that is not openTime+59999 is not a 1m bar");
  assertEquals(completedCandle([T0 + 1, "1", "1", "1", "1", "0", T0 + MIN], T0 + 5 * MIN), null,
    "an open time off the minute boundary is refused");
  assertEquals(completedCandle([T0, "1", "0.5", "1", "1", "0", T0 + MIN - 1], T0 + MIN), null,
    "high below the body is refused");
  assertEquals(completedCandle(null, T0), null);
});

Deno.test("an unfinished candle cannot advance a setup", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  const forming = bar(T0, 100, 100.1, 99.5, 99.9);
  const out: any = advancePullbackSetup(armed.state, forming, null, Number(forming[6]));
  assertEquals(out.reason, SETUP_REASON.CANDLE_INCOMPLETE);
  assertEquals(out.state.pullbackObserved, false);
});

Deno.test("a trigger needs the immediately preceding bar, not any earlier one", () => {
  const b0 = bar(T0, 100, 100.1, 99.7, 99.9);
  const gap = bar(T0 + 3 * MIN, 99.95, 100.3, 99.9, 100.25);
  const armed: any = startPullbackSetup(signal(), T0);
  const s1: any = advancePullbackSetup(armed.state, b0, null, T0 + MIN).state;
  const out: any = advancePullbackSetup(s1, gap, b0, T0 + 4 * MIN);
  assertEquals(out.state.state, SETUP_STATE.PULLBACK_OBSERVED,
    "a non-adjacent previous bar cannot satisfy close > previous close");
});

// ---------------------------------------- trigger freshness (execution side)
Deno.test("CASE 14: the entry trigger is executable for 60 seconds", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25),
  ]);
  const t = state.triggerAt;
  assertEquals(entryTriggerFresh(state, t, 100.3, POLICY.maxEntryDriftPct), null);
  assertEquals(entryTriggerFresh(state, t + 60_000, 100.3, POLICY.maxEntryDriftPct), null);
  assertEquals(entryTriggerFresh(state, t + 60_001, 100.3, POLICY.maxEntryDriftPct),
    SETUP_REASON.TRIGGER_STALE);
  assertEquals(entryTriggerFresh(state, t - 1, 100.3, POLICY.maxEntryDriftPct),
    SETUP_REASON.TRIGGER_FUTURE, "no entry before the bar that justified it closed");
  assertEquals(SETUP_POLICY.entryTriggerTtlMs, 60_000);
});

Deno.test("CASE 16: a fill more than 1% from the ORIGINAL reference is refused", () => {
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25),
  ]);
  const t = state.triggerAt;
  assertEquals(entryTriggerFresh(state, t, 101.01, POLICY.maxEntryDriftPct), SETUP_REASON.ENTRY_DRIFT);
  assertEquals(entryTriggerFresh(state, t, 98.9, POLICY.maxEntryDriftPct), SETUP_REASON.ENTRY_DRIFT);
  assertEquals(entryTriggerFresh(state, t, 100.9, POLICY.maxEntryDriftPct), null);
  assertEquals(POLICY.maxEntryDriftPct, 0.01, "the drift ceiling is not widened by this policy");
});

Deno.test("CASE 15: an untriggered or foreign setup is never executable", () => {
  const armed: any = startPullbackSetup(signal(), T0);
  assertEquals(entryTriggerFresh(armed.state, T0 + 1_000, 100, POLICY.maxEntryDriftPct),
    SETUP_REASON.NOT_TRIGGERED);
  const { state } = drive([
    bar(T0, 100, 100.1, 99.7, 99.9),
    bar(T0 + MIN, 99.95, 100.3, 99.9, 100.25),
  ]);
  assertEquals(
    entryTriggerFresh({ ...state, policyVersion: "OTHER" }, state.triggerAt, 100.3, 0.01),
    SETUP_REASON.WRONG_STRATEGY,
  );
  assertEquals(entryTriggerFresh(state, state.triggerAt, 0, POLICY.maxEntryDriftPct),
    SETUP_REASON.INVALID_PRICE);
});

Deno.test("the frozen parameters are exactly the researched ones", () => {
  assertEquals(SETUP_POLICY.minPullbackPct, 0.0025);
  assertEquals(SETUP_POLICY.minReaccelPct, 0.0025);
  assertEquals(SETUP_POLICY.maxChasePct, 0.01);
  assertEquals(SETUP_POLICY.setupTtlMs, 900_000);
  assertEquals(SETUP_POLICY.entryTriggerTtlMs, 60_000);
  assertEquals(SETUP_POLICY.version, "V17_PULLBACK_REACCEL_ENTRY_1");
  assertEquals(SETUP_POLICY.parametersValidatedByBacktest, false,
    "a 7-day sample is not a market-wide validation and must not claim to be");
});
