import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateV10BbPosition,
  evaluateV10ExitBar,
  initialV10ExitState,
  type V10PreparedExitBar,
} from "./v10_lane_exit.ts";

function bar(openTimeMs: number, values: Partial<Omit<V10PreparedExitBar, "openTimeMs">> = {}): V10PreparedExitBar {
  return {
    openTimeMs,
    open: values.open ?? 100,
    high: values.high ?? 101,
    low: values.low ?? 99,
    close: values.close ?? 100,
    bbPos: values.bbPos ?? -1,
  };
}

Deno.test("V10 BB feature uses 20 closes and sample standard deviation", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const value = calculateV10BbPosition(closes);
  assert(value !== null);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 19;
  assertAlmostEquals(value, (119 - mean) / (2 * Math.sqrt(variance)), 1e-12);
});

Deno.test("BULL takes 30 percent at 22.5 percent ROE", () => {
  const decision = evaluateV10ExitBar({
    lane: "BULL", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: initialV10ExitState(100, -1.5),
  }, bar(0, { high: 108, low: 99, bbPos: -1 }));
  assertEquals(decision.action, "PARTIAL_AT_TRIGGER");
  assertEquals(decision.reason, "T1_FIXED");
  assertAlmostEquals(decision.fraction, 0.3);
  assertAlmostEquals(decision.triggerPrice!, 107.5);
  assertAlmostEquals(decision.nextState.remainingFraction, 0.7);
});

Deno.test("BULL residual protection is stop-first", () => {
  const seeded = initialV10ExitState(100, -1.5);
  const decision = evaluateV10ExitBar({
    lane: "BULL", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: {
      ...seeded, t1Completed: true, t1AtMs: 15 * 60_000,
      remainingFraction: 0.7, peakPrice: 112, lastEvaluatedBarOpenMs: 0,
    },
  }, bar(15 * 60_000, { open: 110, high: 115, low: 108, close: 114, bbPos: 0.5 }));
  assertEquals(decision.action, "FULL_AT_TRIGGER");
  assertEquals(decision.reason, "RESIDUAL_PROTECTION");
  assertAlmostEquals(decision.fraction, 0.7);
  assert(decision.triggerPrice! < 110);
});

Deno.test("RANGE exits at next open after one-point BB recovery", () => {
  const decision = evaluateV10ExitBar({
    lane: "RANGE", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: initialV10ExitState(100, -1.4),
  }, bar(60_000, { bbPos: -0.35, close: 102 }));
  assertEquals(decision.action, "FULL_NEXT_OPEN");
  assertEquals(decision.reason, "FULL_STATE_TARGET");
  assertEquals(decision.executeAtNextOpen, true);
});

Deno.test("RANGE arms full trail at 18 percent ROE", () => {
  const arm = evaluateV10ExitBar({
    lane: "RANGE", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: initialV10ExitState(100, -1.4),
  }, bar(0, { high: 106.1, low: 100, close: 105, bbPos: -0.8 }));
  assertEquals(arm.action, "HOLD");
  assertEquals(arm.nextState.trailArmed, true);
  const exit = evaluateV10ExitBar({
    lane: "RANGE", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: arm.nextState,
  }, bar(15 * 60_000, { open: 105, high: 107, low: 105.5, close: 106, bbPos: -0.7 }));
  assertEquals(exit.reason, "FULL_PROFIT_TRAIL");
});

Deno.test("BEAR is hard blocked in live mode", () => {
  const state = initialV10ExitState(100, -2.1);
  const live = evaluateV10ExitBar({ lane: "BEAR", entryPrice: 100, openedAtMs: 0, leverage: 3, state },
    bar(4 * 3_600_000, { close: 97, bbPos: -1.8 }), { liveMode: true });
  assertEquals(live.action, "RISK_CIRCUIT");
  assertEquals(live.reason, "UNVALIDATED_LANE_LIVE_BLOCK");
  const shadow = evaluateV10ExitBar({ lane: "BEAR", entryPrice: 100, openedAtMs: 0, leverage: 3, state },
    bar(4 * 3_600_000, { close: 97, bbPos: -1.8 }), { liveMode: false });
  assertEquals(shadow.reason, "STATE_RECOVERY_FAILED");
});

Deno.test("maximum holding time has first priority", () => {
  const decision = evaluateV10ExitBar({
    lane: "RANGE", entryPrice: 100, openedAtMs: 0, leverage: 3,
    state: initialV10ExitState(100, -1.2),
  }, bar(6 * 3_600_000, { open: 99, high: 110, low: 90, close: 108, bbPos: 2 }));
  assertEquals(decision.reason, "MAX_HOLD_BACKSTOP");
  assertEquals(decision.triggerPrice, 99);
});
