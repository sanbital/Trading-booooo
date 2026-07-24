import { computeAccuracyMetrics, computeMetrics } from "./metrics.ts";
import type { SignalEvaluation, Trade } from "./simulate.ts";

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
    secondTarget: null,
    stop: 95,
    targetStrategy: "SHORT_ONLY",
    barsHeld: 1,
    assetNetPct: netPct * 2,
    netPct,
    allocationPct,
    exitReason: netPct > 0 ? "TARGET" : "STOP",
    score: 75,
    plannedRR: 2,
    rawPredictedUpsidePct: 4,
    predictedUpsidePct: 3,
    predictedHitProbabilityPct: 60,
    maxFavorableExcursionPct: netPct > 0 ? 4 : 1,
    maxAdverseExcursionPct: netPct > 0 ? 1 : 4,
    forecastErrorPct: netPct > 0 ? 1 : -2,
    ambiguousSameBar: false,
  };
}

function signal(
  outcome: SignalEvaluation["outcome"],
  decision: SignalEvaluation["decision"],
  entryStatus: SignalEvaluation["entryStatus"],
  failedGates: string[] = [],
): SignalEvaluation {
  const entered = entryStatus === "ENTERED";
  const hit = outcome === "TARGET_FIRST";
  return {
    market: "KRW-TEST",
    exchange: "upbit",
    signalTime: 0,
    decision,
    score: 75,
    confidence: 70,
    horizonCode: "SHORT",
    targetStrategy: "SHORT_ONLY",
    entryStatus,
    entryTime: entered ? 1 : null,
    entryPrice: entered ? 100 : null,
    exitTime: entered ? 2 : null,
    exitPrice: entered ? (hit ? 103 : 98) : null,
    outcome,
    exitReason: entered ? (hit ? "TARGET" : "STOP") : null,
    rawPredictedUpsidePct: 4,
    predictedUpsidePct: 3,
    predictedHitProbabilityPct: 60,
    realizedNetPct: entered ? (hit ? 3 : -2) : null,
    maxFavorableExcursionPct: entered ? (hit ? 3.5 : 1) : null,
    maxAdverseExcursionPct: entered ? (hit ? 1 : 2.5) : null,
    forecastErrorPct: entered ? (hit ? 0.5 : -2) : null,
    brierScore: entered ? ((0.6 - (hit ? 1 : 0)) ** 2) : null,
    directionCorrect: outcome === "REJECT_CORRECT" ? true :
      outcome === "MISSED_OPPORTUNITY" ? false : entered ? hit : null,
    ambiguousSameBar: false,
    failedGates,
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
  if (metrics.forecastMaePct <= 0 || metrics.avgMfePct <= 0) {
    throw new Error("forecast/MFE diagnostics must be populated");
  }
});

Deno.test("accuracy metrics separate BUY, WAIT and rejected-signal quality", () => {
  const metrics = computeAccuracyMetrics([
    signal("TARGET_FIRST", "BUY", "ENTERED"),
    signal("STOP_FIRST", "BUY", "ENTERED"),
    signal("TARGET_FIRST", "WAIT", "ENTERED"),
    signal("NO_ENTRY", "WAIT", "NO_ENTRY"),
    signal("REJECT_CORRECT", "AVOID", "NOT_APPLICABLE", ["손익비"]),
    signal("MISSED_OPPORTUNITY", "AVOID", "NOT_APPLICABLE", ["손익비"]),
  ]);
  if (metrics.buyHitRatePct !== 50) throw new Error("BUY hit rate mismatch");
  if (metrics.waitEntryRatePct !== 50) throw new Error("WAIT entry rate mismatch");
  if (metrics.waitHitRatePct !== 100) throw new Error("WAIT hit rate mismatch");
  if (metrics.rejectionAccuracyPct !== 50) throw new Error("rejection accuracy mismatch");
  if (metrics.missedOpportunityRatePct !== 50) throw new Error("missed opportunity mismatch");
  if (metrics.byGate[0]?.samples !== 2) throw new Error("gate samples mismatch");
});
