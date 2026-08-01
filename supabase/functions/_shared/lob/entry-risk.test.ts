import { assessLobEntryRisk, evaluateLobEntry } from "./entry.ts";
import type { LobCostEstimate, LobFeatureVector } from "./types.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    universeMode: "TOP10_24H_GAINERS_LOB_ONLY",
    gainerRank: 3,
    samples: 80,
    observationMs: 55_000,
    bookAgeMs: 50,
    spreadBps: 3,
    bookImbalance: 0.20,
    imbalanceStability: 0.75,
    tradePressureFast: 0.30,
    tradeCount: 120,
    buyNotional: 120_000,
    sellNotional: 65_000,
    averageTradeNotional: 1_540,
    bookUpdateRate: 20,
    tradeArrivalRate: 8,
    aggressiveNotionalPerSecond: 3_360,
    micropriceDeviationBps: 2,
    bidDepthQuote: 500_000,
    askDepthQuote: 350_000,
    depthRatio: 1.43,
    spoofLikeScore: 0.05,
    askSpoofScore: 0.05,
    askAbsorptionScore: 0.10,
    askRefillRatio: 0.10,
    bidAbsorptionScore: 0.20,
    breakoutScore: 0.70,
    sweepReclaimScore: 0.20,
    ofiPersistence: 0.50,
    persistentBidWall: true,
    persistentAskWall: false,
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.80,
    turnover24hQuote: 50_000_000_000,
    minActionableTurnover24h: 1_000_000_000,
    trendContext: 0,
    marketHeatScore: 60,
    recentNotionalPerSecond: 3_360,
    notionalAcceleration: 0,
    tradeCountPerSecond: 8,
    notionalTrend: 0,
    tradeSpeedTrend: 0,
    tradeArrivalTrend: 0,
    pathEfficiency: 0.60,
    reversalRate: 0.20,
    noiseBandBps: 4,
    quoteFlickerRate: 2,
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    ...overrides,
  };
}

const costs: LobCostEstimate = {
  roundTripFeeBps: 10,
  entrySlippageBps: 1,
  targetExitSlippageBps: 1,
  stopExitSlippageBps: 2,
  spreadBps: 3,
};

Deno.test("support breakdown is an unconditional LOB entry block", () => {
  const decision = evaluateLobEntry(
    features({
      dynamicStatus: "SUPPORT_BREAKDOWN_RISK",
    }),
    costs,
  );
  assert(decision.decision === "WAIT");
  assert(decision.reasons.includes("SUPPORT_BREAKDOWN_RISK"));
});

Deno.test("ask spoof warning is an unconditional entry block", () => {
  const decision = evaluateLobEntry(features({ askSpoofScore: 0.90 }), costs);
  assert(decision.decision === "WAIT");
  assert(decision.reasons.includes("SPOOF_WARNING"));
});

Deno.test("negative trade pressure is an unconditional entry block", () => {
  const decision = evaluateLobEntry(features({ tradePressureFast: -0.0001 }), costs);
  assert(decision.decision === "WAIT");
  assert(decision.reasons.includes("NEGATIVE_TRADE_PRESSURE"));
});

Deno.test("bid and ask spoof together block the painted book", () => {
  const decision = evaluateLobEntry(
    features({
      spoofLikeScore: 0.65,
      askSpoofScore: 0.90,
    }),
    costs,
  );
  assert(decision.reasons.includes("TWO_SIDED_SPOOF_RISK"));
  assert(decision.decision === "WAIT");
});

Deno.test("severe bid spoof needs one adverse flow confirmation", () => {
  const clean = evaluateLobEntry(features({ spoofLikeScore: 0.92 }), costs);
  const confirmed = evaluateLobEntry(
    features({
      spoofLikeScore: 0.92,
      tradeSpeedTrend: -0.30,
    }),
    costs,
  );
  assert(!clean.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
  assert(confirmed.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
});

Deno.test("normal bid spoof threshold needs two independent adverse signs", () => {
  const one = evaluateLobEntry(
    features({
      spoofLikeScore: 0.65,
      tradeSpeedTrend: -0.30,
    }),
    costs,
  );
  const two = evaluateLobEntry(
    features({
      spoofLikeScore: 0.65,
      tradeSpeedTrend: -0.30,
      notionalTrend: -0.30,
    }),
    costs,
  );
  assert(!one.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
  assert(two.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
});

Deno.test("a spoofed persistent bid wall cannot cast a positive vote", () => {
  const assessment = assessLobEntryRisk(features({
    spoofLikeScore: 0.65,
    tradeSpeedTrend: -0.30,
    tradePressureFast: 0,
    micropriceDeviationBps: 0,
    bookImbalance: -0.11,
    ofiPersistence: 0.08,
    persistentBidWall: true,
  }));
  assert(assessment.positiveVotes === 2);
  assert(assessment.reasons.includes("LOB_FLOW_NOT_BUYABLE_NOW"));
  assert(!assessment.reasons.includes("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW"));
});

Deno.test("insufficient dynamic evidence waits after the collector extension", () => {
  const decision = evaluateLobEntry(features({ dynamicStatus: "INSUFFICIENT" }), costs);
  assert(decision.decision === "WAIT");
  assert(decision.reasons.includes("LOB_DYNAMIC_EVIDENCE_INSUFFICIENT"));
});

Deno.test("untradeable costs cannot be ignored by LOB admission", () => {
  const baseline = evaluateLobEntry(features(), costs);
  const hostileCosts = evaluateLobEntry(features({ trendContext: -1 }), {
    ...costs,
    roundTripFeeBps: 10_000,
    forecastBiasPenaltyBps: 10_000,
  });
  assert(baseline.decision === "BUY");
  assert(hostileCosts.decision === "WAIT");
  assert(hostileCosts.reasons.includes("REWARD_RISK_FAILED"));
});

Deno.test("reward-risk failure cannot be bypassed", () => {
  const decision = evaluateLobEntry(features(), costs, {
    fixedTargetBps: 20,
    fixedStopBps: 100,
    minNetRewardRiskRatio: 0.5,
  });
  assert(decision.decision === "WAIT");
  assert(decision.reasons.includes("REWARD_RISK_FAILED"));
});

Deno.test("planned stop comes from observed LOB noise instead of the 5 percent emergency cap", () => {
  const decision = evaluateLobEntry(features({ noiseBandBps: 12 }), costs, {
    fixedStopBps: 500,
    minNetRewardRiskRatio: 1.5,
    maxStopToTargetRatio: 1 / 1.5,
  });
  assert(decision.stopBps === 15, `expected 15bp planned stop, got ${decision.stopBps}`);
  assert(decision.stopBps < 200);
  assert(decision.warnings.includes("LEGACY_EMERGENCY_STOP_IGNORED_FOR_PLANNED_RISK"));
});

Deno.test("operator policy requires 20bp net target and caps the legacy RR floor at 0.5", () => {
  const decision = evaluateLobEntry(features(), costs, {
    minNetProfitBps: 0,
    minNetRewardRiskRatio: 1.5,
    maxStopToTargetRatio: 1 / 1.5,
  });
  assert(decision.targetReturnNetBps >= 20);
  assert(decision.minimumTargetNetProfitBps === 20);
  assert(decision.decision === "BUY", decision.reasons.join(","));
  assert(decision.netRewardRiskRatio >= 0.5);
});
