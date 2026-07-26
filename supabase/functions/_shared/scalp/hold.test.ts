import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_SCALP_HOLD,
  decayedPWin,
  evaluateHold,
  resolveHoldConfig,
  safetyTtlExceeded,
  type HoldInputs,
} from "./hold.ts";

const cfg = { ...DEFAULT_SCALP_HOLD, exitCostFraction: 0.0008 };

/** Entry 100, target 102, stop 99, strong entry signal, book still supportive. */
const base: HoldInputs = {
  entryPrice: 100,
  currentPrice: 100.2,
  targetPrice: 102,
  stopPrice: 99,
  entryPWin: 0.62,
  liveImbalance: 0.20,
  reversalStreak: 0,
  heldMinutes: 5,
  expectedMinutes: 90,
  t1Completed: false,
};

Deno.test("a live position is not sold merely because time passed", () => {
  // Two hours in, past the expected resolution time, but the book still supports it.
  const d = evaluateHold({ ...base, heldMinutes: 120, expectedMinutes: 90 }, cfg);
  assertEquals(d.pastExpected, true);
  assertEquals(d.action, "HOLD");
  assert(d.liveEdge > 0);
});

Deno.test("upside is measured from the current price, not the entry", () => {
  const early = evaluateHold({ ...base, currentPrice: 100.1 }, cfg);
  const late = evaluateHold({ ...base, currentPrice: 101.8 }, cfg);
  assert(late.remainingUpside < early.remainingUpside);
  // Almost no room left and the stop is far below: holding is no longer worth it.
  assert(late.liveEdge < early.liveEdge);
});

Deno.test("entry cost is sunk — only the exit leg is charged", () => {
  const oneSide = { ...cfg, exitCostFraction: 0.0008 };
  const roundTrip = { ...cfg, exitCostFraction: 0.0016 };
  const a = evaluateHold(base, oneSide);
  const b = evaluateHold(base, roundTrip);
  assertAlmostEquals(a.liveEdge - b.liveEdge, 0.0008, 1e-9);
});

Deno.test("entry signal decays toward the base rate as the position ages", () => {
  const fresh = decayedPWin(0.75, 0, 0, cfg);
  const aged = decayedPWin(0.75, 0, 60, cfg);
  assertAlmostEquals(fresh, 0.75, 1e-9);
  assert(aged < fresh);
  assert(Math.abs(aged - cfg.basePWin) < Math.abs(fresh - cfg.basePWin));
});

Deno.test("a faded position with no room left is exited", () => {
  const d = evaluateHold({
    ...base,
    currentPrice: 101.95,
    heldMinutes: 200,
    expectedMinutes: 90,
    liveImbalance: 0,
  }, cfg);
  assertEquals(d.action, "EXIT");
  assert(d.reason.startsWith("edge_"));
});

Deno.test("a confirmed orderbook reversal exits regardless of edge", () => {
  const first = evaluateHold({ ...base, liveImbalance: -0.45 }, cfg);
  assertEquals(first.reversalStreak, 1);
  assertEquals(first.action, "HOLD");
  const second = evaluateHold({ ...base, liveImbalance: -0.45, reversalStreak: first.reversalStreak }, cfg);
  assertEquals(second.reversalStreak, 2);
  assertEquals(second.action, "EXIT");
  assertEquals(second.reason, "orderbook_reversal_confirmed");
});

Deno.test("a single reversal reading does not exit, and recovery clears the streak", () => {
  const dip = evaluateHold({ ...base, liveImbalance: -0.45 }, cfg);
  const recovered = evaluateHold({ ...base, liveImbalance: 0.3, reversalStreak: dip.reversalStreak }, cfg);
  assertEquals(recovered.reversalStreak, 0);
  assertEquals(recovered.action, "HOLD");
});

Deno.test("live orderflow danger exits immediately", () => {
  for (const status of ["SPOOF_LIKE_RISK", "ASK_ABSORPTION_RISK", "SUPPORT_BREAKDOWN_RISK"]) {
    const d = evaluateHold({ ...base, dynamicStatus: status }, cfg);
    assertEquals(d.action, "EXIT");
    assert(d.reason.startsWith("live_risk_"));
  }
});

Deno.test("a trend flip to strong down exits", () => {
  const d = evaluateHold({ ...base, h4TrendSignal: -0.8 }, cfg);
  assertEquals(d.action, "EXIT");
  assertEquals(d.reason, "trend_flipped_strong_down");
  // A mild downtrend is not an exit on its own.
  assertEquals(evaluateHold({ ...base, h4TrendSignal: -0.3 }, cfg).action, "HOLD");
});

Deno.test("past the expected time the bar rises but stays finite", () => {
  // Stop already trailed up to 100.2, so the remaining risk is small and the position is
  // genuinely marginal rather than obviously bad. Before the expected time the bar is
  // "positive"; after it the position must clear minEdgeAfterExpected to keep its slot.
  const strict = { ...cfg, minEdgeAfterExpected: 0.0035 };
  const marginal = { ...base, currentPrice: 100.8, stopPrice: 100.2, expectedMinutes: 90 };
  const before = evaluateHold({ ...marginal, heldMinutes: 10 }, strict);
  const after = evaluateHold({ ...marginal, heldMinutes: 100 }, strict);
  assertEquals(before.action, "HOLD");
  assertEquals(after.action, "EXIT");
  assertEquals(after.reason, "edge_below_hold_threshold");
  // Still positive edge — it is being closed for slot economics, not because it is losing.
  assert(after.liveEdge > 0);
});

Deno.test("a near-target position with a distant stop is closed on economics alone", () => {
  // Almost no upside left and a stop 2.5% below: continuing to hold is negative EV even
  // though nothing is "wrong". This is the case the old 30-minute clock got right only by
  // accident, and got wrong whenever the clock and the geometry disagreed.
  const d = evaluateHold({ ...base, currentPrice: 101.9, stopPrice: 99, heldMinutes: 5 }, cfg);
  assertEquals(d.action, "EXIT");
  assert(d.liveEdge < 0);
});

Deno.test("a profitable runner past T1 is tightened rather than dumped", () => {
  const d = evaluateHold({
    ...base,
    currentPrice: 101.9,
    heldMinutes: 200,
    expectedMinutes: 90,
    t1Completed: true,
    liveImbalance: 0,
  }, cfg);
  assertEquals(d.action, "TIGHTEN");
});

Deno.test("safety TTL is a backstop, not a trading rule", () => {
  assertEquals(safetyTtlExceeded(359, cfg), false);
  assertEquals(safetyTtlExceeded(360, cfg), true);
  // And it is nowhere near the old 30-minute forced exit.
  assert(cfg.safetyTtlMinutes >= 60);
});

Deno.test("hold config clamps hostile overrides", () => {
  const c = resolveHoldConfig({ safetyTtlMinutes: 1, reversalConfirmations: 99, alphaHalfLifeMinutes: -5 });
  assert(c.safetyTtlMinutes >= 10);
  assert(c.reversalConfirmations <= 10);
  assert(c.alphaHalfLifeMinutes >= 1);
});
