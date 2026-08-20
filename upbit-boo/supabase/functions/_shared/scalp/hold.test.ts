import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_SCALP_HOLD,
  decayedPWin,
  evaluateHold,
  marketDataStale,
  resolveHoldConfig,
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
  t1Completed: false,
};

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
    t1Completed: true,
    liveImbalance: 0,
  }, cfg);
  assertEquals(d.action, "TIGHTEN");
});

Deno.test("hold config clamps hostile overrides", () => {
  const c = resolveHoldConfig({ staleDataMinutes: 1, reversalConfirmations: 99, alphaHalfLifeMinutes: -5 });
  assert(c.staleDataMinutes >= 5);
  assert(c.reversalConfirmations <= 10);
  assert(c.alphaHalfLifeMinutes >= 1);
});

Deno.test("elapsed time alone never closes a position", () => {
  // The constraint: a scalp is sold on market data, not on a clock. A position with an
  // intact live edge is held whether it is five minutes or five hours old.
  for (const held of [5, 45, 120, 600, 5000]) {
    assertEquals(evaluateHold({ ...base, heldMinutes: held, liveImbalance: 0.35 }, cfg).action, "HOLD");
  }
});

Deno.test("executed flow turning against the position closes it", () => {
  // Resting orders state intent; trades state what actually happened.
  const first = evaluateHold({ ...base, tradePressure: -0.55 }, cfg);
  assertEquals(first.flowReversalStreak, 1);
  assertEquals(first.action, "HOLD");
  const second = evaluateHold({ ...base, tradePressure: -0.55, flowReversalStreak: first.flowReversalStreak }, cfg);
  assertEquals(second.action, "EXIT");
  assertEquals(second.reason, "trade_flow_reversal_confirmed");
  // Buying pressure clears the streak.
  assertEquals(evaluateHold({ ...base, tradePressure: 0.4, flowReversalStreak: 1 }, cfg).flowReversalStreak, 0);
});

Deno.test("a liquidity event closes the position", () => {
  const wide = evaluateHold({ ...base, spreadBps: cfg.maxSpreadBps + 10 }, cfg);
  assertEquals(wide.action, "EXIT");
  assertEquals(wide.reason, "spread_blowout");
  const thin = evaluateHold({ ...base, bidDepthRatio: cfg.minBidDepthRatio / 2 }, cfg);
  assertEquals(thin.action, "EXIT");
  assertEquals(thin.reason, "bid_support_evaporated");
  // Healthy readings do not.
  assertEquals(evaluateHold({ ...base, spreadBps: 8, bidDepthRatio: 0.9 }, cfg).action, "HOLD");
});

Deno.test("missing market data is an alert, not a sell", () => {
  // The only remaining time-shaped check asks whether DATA is arriving, and it closes
  // nothing — the caller raises an operator alert instead.
  assertEquals(marketDataStale(cfg.staleDataMinutes - 1, cfg), false);
  assertEquals(marketDataStale(cfg.staleDataMinutes, cfg), true);
  // Even at that point evaluateHold itself still refuses to exit on time alone.
  assertEquals(evaluateHold({ ...base, heldMinutes: 10_000, liveImbalance: 0.35 }, cfg).action, "HOLD");
});
