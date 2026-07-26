import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateScalpSignal, DEFAULT_SCALP_SIGNAL, type ScalpMicro, type ScalpTrend } from "./signal.ts";

const goodMicro: ScalpMicro = {
  samples: 10, spread_bps: 4, book_imbalance: 0.22, imbalance_stability: 0.70,
  trade_pressure: 0.45, live_book_age_ms: 800, persistent_bid_wall: true,
  ask_absorption_score: 0.10, breakout_score: 0.60, dynamic_status: "BREAKOUT_CONFIRMED",
};
const flatTrend: ScalpTrend = { h4_trend_signal: 0.1, composite_trend: 0.05 };

Deno.test("combined healthy orderflow + non-veto trend => BUY", () => {
  const r = evaluateScalpSignal(goodMicro, flatTrend);
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
  const r = evaluateScalpSignal({ ...goodMicro, persistent_bid_wall: false }, flatTrend);
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
