import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateScalpSignal, DEFAULT_SCALP_SIGNAL, type ScalpMicro, type ScalpTrend } from "./signal.ts";

const goodMicro: ScalpMicro = {
  samples: 10, spread_bps: 4, book_imbalance: 1.6, imbalance_stability: 0.8,
  trade_pressure: 0.5, live_book_age_ms: 800, persistent_bid_wall: true,
  ask_absorption_score: 0.1, breakout_score: 0.6, dynamic_status: "BREAKOUT_CONFIRMED",
};
const flatTrend: ScalpTrend = { h4_trend_signal: 0.1, composite_trend: 0.05 };

Deno.test("clean orderbook + non-veto trend => BUY", () => {
  const r = evaluateScalpSignal(goodMicro, flatTrend);
  assertEquals(r.decision, "BUY");
  assertEquals(r.vetoed, false);
  assert(r.pWin > 0.5);
  assert(r.provisionalEdge >= DEFAULT_SCALP_SIGNAL.minimumEdge);
});

Deno.test("strong downtrend hard-vetoes even with a perfect book", () => {
  const r = evaluateScalpSignal(goodMicro, { h4_trend_signal: -0.7, composite_trend: -0.6 });
  assertEquals(r.decision, "AVOID");
  assertEquals(r.vetoed, true);
  assert(r.reasons.includes("trend_strong_down_veto"));
});

Deno.test("weak downtrend penalizes pWin but does NOT block", () => {
  const strong = evaluateScalpSignal(goodMicro, flatTrend);
  const weak = evaluateScalpSignal(goodMicro, { h4_trend_signal: -0.2, composite_trend: -0.3 });
  assert(weak.pWin < strong.pWin);          // penalty applied
  assert(weak.decision === "BUY" || weak.decision === "WAIT"); // not vetoed
  assertEquals(weak.vetoed, false);
});

Deno.test("wide spread blocks entry (WAIT, recoverable)", () => {
  const r = evaluateScalpSignal({ ...goodMicro, spread_bps: 20 }, flatTrend);
  assert(r.reasons.includes("spread_too_wide"));
  assertEquals(r.decision, "WAIT");
});

Deno.test("ask absorption risk is a hard AVOID", () => {
  const r = evaluateScalpSignal({ ...goodMicro, dynamic_status: "ASK_ABSORPTION_RISK" }, flatTrend);
  assertEquals(r.decision, "AVOID");
});

Deno.test("stale book blocks entry", () => {
  const r = evaluateScalpSignal({ ...goodMicro, live_book_age_ms: 9000 }, flatTrend);
  assert(r.reasons.includes("stale_book"));
  assert(r.decision !== "BUY");
});

Deno.test("missing support wall blocks when required", () => {
  const r = evaluateScalpSignal({ ...goodMicro, persistent_bid_wall: false }, flatTrend);
  assert(r.reasons.includes("no_support_wall"));
  assert(r.decision !== "BUY");
});
