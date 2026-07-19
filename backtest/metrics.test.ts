import { computeMetrics } from "./metrics.ts";
import type { Trade } from "./simulate.ts";

function trade(netPct: number, allocationPct = 50): Trade {
  return {
    market: "KRW-TEST",
    signalType: "BUY",
    signalTime: 0,
    entryTime: 0,
    exitTime: 1,
    entryPrice: 100,
    exitPrice: 100 + netPct,
    target: 110,
    stop: 95,
    barsHeld: 1,
    assetNetPct: netPct * 2,
    netPct,
    allocationPct,
    exitReason: netPct > 0 ? "TARGET" : "STOP",
    score: 75,
    plannedRR: 2,
  };
}

Deno.test("metrics use capital return and report a finite confidence interval", () => {
  const metrics = computeMetrics([trade(1), trade(-0.5), trade(1)]);
  if (Math.abs(metrics.expectancyPct - 0.5) > 1e-12) {
    throw new Error(`unexpected expectancy ${metrics.expectancyPct}`);
  }
  if (!(metrics.winRate95LowPct < metrics.winRatePct)) {
    throw new Error("lower confidence bound must be below point estimate");
  }
  if (!(metrics.winRate95HighPct > metrics.winRatePct)) {
    throw new Error("upper confidence bound must be above point estimate");
  }
  if (metrics.avgAllocationPct !== 50) {
    throw new Error(`unexpected allocation ${metrics.avgAllocationPct}`);
  }
});
