// Section 8 promotion rules, asserted rather than assumed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compareVariants, evaluate, MIN_TRADES } from "./evaluation.mjs";

function trade(day: string, net: string, extra: Record<string, unknown> = {}) {
  return {
    symbol: "AAAUSDT",
    exit_at: `${day}T12:00:00Z`,
    net_pnl: net,
    r_multiple: net,
    strategy_exit_reason: "TREND_BREAK",
    execution_exit_route: "MARKET",
    ...extra,
  };
}

/** n winning trades spread across `days` distinct days. */
function spread(n: number, days: number, net: string) {
  return Array.from({ length: n }, (_, i) =>
    trade(`2026-09-${String((i % days) + 1).padStart(2, "0")}`, net));
}

Deno.test("evaluation: zero trades is INSUFFICIENT_SAMPLE, never a clean result", () => {
  const r = evaluate([]);
  assertEquals(r.verdict, "INSUFFICIENT_SAMPLE");
  assertEquals(r.netExpectancyLowerBound, null);
  // Explicitly NOT "no losses, therefore fine".
  assert(!/PROMOTE/.test(r.verdict));
});

Deno.test("evaluation: a thin but flattering sample is not promoted", () => {
  // 5 big wins on 2 days: mean is wonderful, sample is nothing.
  const r = evaluate(spread(5, 2, "100"));
  assertEquals(r.verdict, "INSUFFICIENT_SAMPLE");
  assert(r.verdictDetail.includes("need >="));
});

Deno.test("evaluation: sample adequacy is checked before the point estimate", () => {
  const r = evaluate(spread(MIN_TRADES - 1, 10, "50"));
  assertEquals(r.verdict, "INSUFFICIENT_SAMPLE");
});

Deno.test("evaluation: a consistently profitable, well-spread sample promotes", () => {
  const r = evaluate(spread(60, 20, "1"));
  assertEquals(r.verdict, "PROMOTE");
  assert(r.netExpectancyLowerBound.gt(0));
});

Deno.test("evaluation: a losing strategy is rejected on the lower bound", () => {
  const r = evaluate(spread(60, 20, "-1"));
  assertEquals(r.verdict, "REJECT");
  assert(r.netExpectancyLowerBound.lte(0));
});

Deno.test("evaluation: profit concentrated in one day does not promote", () => {
  // 59 small losses spread over 20 days, one enormous win. The mean is
  // positive; the day-block bound must not be.
  const trades = [
    ...Array.from({ length: 59 }, (_, i) =>
      trade(`2026-09-${String((i % 20) + 1).padStart(2, "0")}`, "-1")),
    trade("2026-09-21", "500"),
  ];
  const r = evaluate(trades);
  assert(r.metrics.netExpectancyPerTrade.gt(0), "point estimate should look positive");
  assertEquals(r.verdict, "REJECT", "one lucky day must not carry a promotion");
});

Deno.test("evaluation: the bootstrap is deterministic", () => {
  const t = spread(60, 20, "1");
  assertEquals(evaluate(t).netExpectancyLowerBound.toString(), evaluate(t).netExpectancyLowerBound.toString());
});

Deno.test("evaluation: day blocks, not trades, drive the interval", () => {
  // Same 60 trades; one version has them on 20 days, the other on 2.
  const spreadOut = evaluate(spread(60, 20, "1"));
  const clustered = evaluate(spread(60, 2, "1"));
  assertEquals(spreadOut.verdict, "PROMOTE");
  // Two days is below the independent-period floor, so it cannot promote no
  // matter how many trades it contains.
  assertEquals(clustered.verdict, "INSUFFICIENT_SAMPLE");
});

Deno.test("evaluation: cost share is null when gross is unknown, never back-solved", () => {
  const r = evaluate(spread(60, 20, "1"));
  assertEquals(r.metrics.costShareOfGross, null);
  const withCosts = evaluate(
    Array.from({ length: 60 }, (_, i) =>
      trade(`2026-09-${String((i % 20) + 1).padStart(2, "0")}`, "1", {
        gross_pnl: "1.5",
        fees: "0.5",
        funding: "0",
      })),
  );
  assert(withCosts.metrics.costShareOfGross !== null);
  assertEquals(withCosts.metrics.costShareOfGross.toString(), "0.333333333333333333");
});

Deno.test("evaluation: drawdown, worst day and losing streak are reported", () => {
  const r = evaluate([
    trade("2026-09-01", "10"),
    trade("2026-09-02", "-4"),
    trade("2026-09-02", "-6"),
    trade("2026-09-03", "-2"),
    trade("2026-09-04", "5"),
  ]);
  assertEquals(r.metrics.maxDrawdown.toString(), "12");
  assertEquals(r.metrics.worstDay.toString(), "-10");
  assertEquals(r.metrics.worstDayAt, "2026-09-02");
  assertEquals(r.metrics.worstLosingStreak, 3);
});

Deno.test("comparison: variants on different bases are flagged incomparable", () => {
  const mixed = compareVariants([
    { id: "A", trades: spread(40, 15, "1"), costModelVersion: "v1", riskBasis: "legacy", candidateSetHash: "h1" },
    { id: "B", trades: spread(40, 15, "2"), costModelVersion: "v2", riskBasis: "normalized", candidateSetHash: "h2" },
  ]);
  assertEquals(mixed.comparable, false);
  assert(mixed.incomparableReason?.includes("different cost/risk/candidate bases"));
  for (const v of mixed.variants) assertEquals(v.comparable, false);
});

Deno.test("comparison: a shared basis is comparable", () => {
  const same = compareVariants([
    { id: "B", trades: spread(40, 15, "1"), costModelVersion: "v1", riskBasis: "normalized", candidateSetHash: "h1" },
    { id: "C", trades: spread(40, 15, "2"), costModelVersion: "v1", riskBasis: "normalized", candidateSetHash: "h1" },
  ]);
  assertEquals(same.comparable, true);
  assertEquals(same.incomparableReason, null);
});

Deno.test("evaluation: the live SHADOW sample today cannot promote anything", () => {
  // boo_shadow_positions held 0 closed rows at 2026-09-16T13:53Z.
  const r = evaluate([]);
  assertEquals(r.verdict, "INSUFFICIENT_SAMPLE");
  assertEquals(r.trades, 0);
});
