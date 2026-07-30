import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateLobEntry } from "./entry.ts";
import { detectLobPatterns } from "./patterns.ts";
import type { LobCostEstimate, LobFeatureVector } from "./types.ts";

function momentumFeatures(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    universeMode: "TOP10_24H_GAINERS_LOB_ONLY",
    gainerRank: 2,
    samples: 45,
    observationMs: 30000,
    bookAgeMs: 80,
    spreadBps: 1.2,
    bookImbalance: 0.12,
    imbalanceStability: 0.80,
    tradePressureFast: 0.68,
    tradeCount: 80,
    buyNotional: 90000,
    sellNotional: 18000,
    averageTradeNotional: 1350,
    bookUpdateRate: 15,
    tradeArrivalRate: 8,
    aggressiveNotionalPerSecond: 9000,
    micropriceDeviationBps: 2.4,
    bidDepthQuote: 800000,
    askDepthQuote: 500000,
    depthRatio: 1.6,
    spoofLikeScore: 0,
    askSpoofScore: 0,
    askAbsorptionScore: 0.08,
    askRefillRatio: 0.05,
    bidAbsorptionScore: 0.20,
    breakoutScore: 0.55,
    sweepReclaimScore: 0.30,
    ofiPersistence: 0.72,
    persistentBidWall: true,
    persistentAskWall: false,
    dynamicStatus: "BREAKOUT_CONFIRMED",
    dataQuality: 0.65,
    turnover24hQuote: 120000000,
    minActionableTurnover24h: 100000,
    // heatPeriod convention: 0.03 = +12% over 24h.
    trendContext: 0.03,
    marketHeatScore: 78,
    recentNotionalPerSecond: 200000,
    notionalAcceleration: 0.55,
    tradeCountPerSecond: 18,
    notionalTrend: 0.45,
    tradeSpeedTrend: 0.35,
    tradeArrivalTrend: 0.25,
    pathEfficiency: 0.82,
    reversalRate: 0.12,
    noiseBandBps: 5,
    quoteFlickerRate: 4,
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    ...overrides,
  };
}

const binanceCosts: LobCostEstimate = {
  roundTripFeeBps: 20,
  entrySlippageBps: 1,
  targetExitSlippageBps: 1,
  stopExitSlippageBps: 2,
  spreadBps: 1.2,
  latencyPenaltyBps: 0.5,
  forecastBiasPenaltyBps: 0,
};

Deno.test("Top-10 eligibility still requires a live continuation pulse", () => {
  const live = detectLobPatterns(momentumFeatures()).find((row) =>
    row.name === "MOMENTUM_CONTINUATION"
  );
  assert(live?.primary);

  const stale = detectLobPatterns(momentumFeatures({ tradeArrivalTrend: -0.4 })).find((row) =>
    row.name === "MOMENTUM_CONTINUATION"
  );
  assertEquals(stale?.primary, false);

  const selling = detectLobPatterns(momentumFeatures({ tradePressureFast: -0.2 })).find((row) =>
    row.name === "MOMENTUM_CONTINUATION"
  );
  assertEquals(selling?.primary, false);
});

Deno.test("momentum geometry is fee-meaningful and short-lived", () => {
  const decision = evaluateLobEntry(momentumFeatures(), binanceCosts);
  assertEquals(decision.pattern, "MOMENTUM_CONTINUATION");
  assert(decision.targetBps >= 60 && decision.targetBps <= 140);
  assert(decision.stopBps < decision.targetBps);
  assertEquals(decision.maxHoldingSeconds, 90);
  assert(decision.targetReturnNetBps > 20);
  assert(decision.conditionalEvNetBps > 0);
  assert(decision.conditionalEvLowerBoundBps > 0);
  assertEquals(decision.decision, "BUY");
});

Deno.test("large stale gainer does not inherit momentum target", () => {
  const decision = evaluateLobEntry(
    momentumFeatures({ trendContext: 0.075, tradeArrivalTrend: -0.4, tradePressureFast: 0.05 }),
    binanceCosts,
  );
  assert(decision.pattern !== "MOMENTUM_CONTINUATION");
  assert(decision.maxHoldingSeconds !== 90 || decision.decision !== "BUY");
});
