import { assert, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateJointObjective, jointParetoDominates } from "./joint-objective.ts";

Deno.test("idle capital remains visible through account growth and utilization", () => {
  const metrics = calculateJointObjective({
    startEquityQuote: 10_000,
    endEquityQuote: 10_010,
    averageManagedCapitalQuote: 10_000,
    observationSeconds: 3600,
    trades: [{ netReturnFraction: 0.01, notionalQuote: 100, heldSeconds: 60, profitable: true }],
  });
  assertAlmostEquals(metrics.accountLogGrowth, Math.log(1.001), 1e-12);
  assert(metrics.capitalUtilization < 0.001, "tiny deployed capital must not look fully utilized");
});

Deno.test("Pareto contract rejects return gain purchased with lower win rate", () => {
  assert(!jointParetoDominates({
    baseline: { accountLogGrowthPerHour: 1, winRate: 0.60, capitalTurnsPerHour: 2 },
    candidate: { accountLogGrowthPerHour: 1.1, winRate: 0.55, capitalTurnsPerHour: 2.1 },
  }));
});
