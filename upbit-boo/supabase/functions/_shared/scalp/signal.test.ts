import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateScalpSignal, DEFAULT_SCALP_SIGNAL, type ScalpMicro, type ScalpTrend } from "./signal.ts";

const goodMicro: ScalpMicro = {
  samples: 10, spread_bps: 4, book_imbalance: 0.22, imbalance_stability: 0.70,
  trade_pressure: 0.45, live_book_age_ms: 800, persistent_bid_wall: true,
  ask_absorption_score: 0.10, breakout_score: 0.60, dynamic_status: "BREAKOUT_CONFIRMED",
};
const flatTrend: ScalpTrend = { h4_trend_signal: 0.1, composite_trend: 0.05 };

// v5.7: pWin is now anchored to the barrier-implied baseline S/(T+S) rather than a flat
// 0.52, so a decision depends on the geometry it is evaluated against. These tests use the
// throughput-optimal split geometry.ts actually produces (near 1:1, ~48% neutral). Under
// the old 2:1 default the same orderflow no longer clears the edge threshold — correctly,
// because a 2:1 barrier caps the neutral win rate at 33%.
const SCALP_GEOMETRY = { ...DEFAULT_SCALP_SIGNAL, targetPct: 0.0083, stopPct: 0.0077, neutralWinRate: 0.481 };

Deno.test("combined healthy orderflow + non-veto trend => BUY", () => {
  const r = evaluateScalpSignal(goodMicro, flatTrend, SCALP_GEOMETRY);
  assertEquals(r.decision, "BUY");
  assertEquals(r.vetoed, false);
  assert(r.provisionalEdge >= DEFAULT_SCALP_SIGNAL.minimumEdge);
});

Deno.test("strong downtrend remains the trend hard-veto", () => {
  const r = evaluateScalpSignal(goodMicro, { h4_trend_signal: -0.8, composite_trend: -0.6 });
  assertEquals(r.decision, "AVOID");
  assertEquals(r.vetoed, true);
  assert(r.reasons.includes("trend_strong_down_veto"));
});

Deno.test("ordinary weak imbalance is soft-scored, not a standalone block", () => {
  const r = evaluateScalpSignal({
    ...goodMicro,
    book_imbalance: 0.02,
    trade_pressure: 0.9,
    breakout_score: 0.9,
    persistent_bid_wall: false,
  }, flatTrend);
  assert(r.reasons.includes("weak_buy_imbalance"));
  assertEquals(r.decision, "BUY");
});

Deno.test("missing support wall does not block by default", () => {
  const r = evaluateScalpSignal({ ...goodMicro, persistent_bid_wall: false }, flatTrend, SCALP_GEOMETRY);
  assert(r.reasons.includes("no_support_wall"));
  assertEquals(r.decision, "BUY");
});

Deno.test("dynamic insufficient is penalized rather than automatically blocked", () => {
  const r = evaluateScalpSignal({ ...goodMicro, dynamic_status: "INSUFFICIENT" }, flatTrend);
  assert(r.reasons.includes("dynamic_insufficient"));
  // 순서 주의: assert() 는 `asserts` 시그니처라 이 줄을 먼저 두면 decision 이
  // "BUY" | "WAIT" 로 좁혀져 다음 "AVOID" 비교가 TS2367 로 거부된다.
  assertEquals(r.decision === "AVOID", false);
  assert(r.decision === "BUY" || r.decision === "WAIT");
});

Deno.test("wide spread waits because it is a real execution-cost issue", () => {
  const r = evaluateScalpSignal({ ...goodMicro, spread_bps: 20 }, flatTrend);
  assert(r.reasons.includes("spread_too_wide"));
  assertEquals(r.decision, "WAIT");
});

Deno.test("explicit ask-absorption risk remains hard AVOID", () => {
  const r = evaluateScalpSignal({ ...goodMicro, dynamic_status: "ASK_ABSORPTION_RISK" }, flatTrend);
  assertEquals(r.decision, "AVOID");
});

Deno.test("stale book blocks entry", () => {
  const r = evaluateScalpSignal({ ...goodMicro, live_book_age_ms: 9000 }, flatTrend);
  assert(r.reasons.includes("stale_book"));
  assertEquals(r.decision, "WAIT");
});

import { resolveScalpSignalConfig, SCALP_BOUNDS } from "./signal.ts";

Deno.test("resolver clamps out-of-range overrides", () => {
  const c = resolveScalpSignalConfig({ targetPct: 0.5, stopPct: 0.0001, minimumEdge: 99 });
  assertEquals(c.targetPct, SCALP_BOUNDS.targetPct.max);
  assertEquals(c.stopPct, SCALP_BOUNDS.stopPct.min);
  assertEquals(c.minimumEdge, SCALP_BOUNDS.minimumEdge.max);
});

Deno.test("resolver enforces target > stop invariant", () => {
  const c = resolveScalpSignalConfig({ targetPct: 0.003, stopPct: 0.005 });
  if (!(c.targetPct > c.stopPct)) throw new Error("target must exceed stop");
});

Deno.test("v5.7: pWin responds to the barrier geometry", () => {
  // THE REGRESSION THIS GUARDS. Through v5.6 pWin was `0.52 + microstructure terms`, with
  // no reference to where the target and stop sat, so widening the reward:risk ratio
  // produced free expected value out of nothing. That is why the design kept drifting
  // toward swing-width targets.
  const wide = evaluateScalpSignal(goodMicro, flatTrend, {
    ...DEFAULT_SCALP_SIGNAL, targetPct: 0.012, stopPct: 0.003, neutralWinRate: 0.2,
  });
  const even = evaluateScalpSignal(goodMicro, flatTrend, {
    ...DEFAULT_SCALP_SIGNAL, targetPct: 0.0075, stopPct: 0.0075, neutralWinRate: 0.5,
  });
  // Identical orderflow, so the claimed EDGE must be identical...
  assert(Math.abs(wide.signalEdge - even.signalEdge) < 1e-12);
  // ...but a 4:1 barrier cannot have the same hit probability as a 1:1 one.
  assert(wide.pWin < even.pWin - 0.25, `${wide.pWin} vs ${even.pWin}`);
  assert(Math.abs(wide.pWin - (wide.neutralWinRate + wide.signalEdge)) < 1e-12);
});

Deno.test("v5.7: without a supplied baseline the barriers still set the anchor", () => {
  const r = evaluateScalpSignal(goodMicro, flatTrend, {
    ...DEFAULT_SCALP_SIGNAL, targetPct: 0.008, stopPct: 0.002, neutralWinRate: 0,
  });
  // 4:1 implies a 20% neutral rate; the flat 0.52 must not survive as a fallback.
  assert(Math.abs(r.neutralWinRate - 0.2) < 1e-9, `anchor ${r.neutralWinRate}`);
});

Deno.test("v5.7: the trend penalty erodes the edge, not the baseline", () => {
  const cfg = { ...DEFAULT_SCALP_SIGNAL, targetPct: 0.0083, stopPct: 0.0077, neutralWinRate: 0.481 };
  const clean = evaluateScalpSignal(goodMicro, flatTrend, cfg);
  const weak = evaluateScalpSignal(goodMicro, { h4_trend_signal: -0.3, composite_trend: -0.4 }, cfg);
  assert(weak.signalEdge < clean.signalEdge);
  // A soft downtrend cannot push the estimate below what the geometry alone implies.
  assert(weak.pWin >= cfg.neutralWinRate - 1e-12);
});
