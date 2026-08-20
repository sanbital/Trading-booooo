import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateLobEntry } from "./entry.ts";
import { MINUTE_ENTRY_GATE_VERSION } from "./minute-entry-gate.ts";
import type { LobCostEstimate, LobFeatureVector } from "./types.ts";

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    universeMode: "TOP10_24H_GAINERS_LOB_ONLY",
    gainerRank: 1,
    change24hPct: 12,
    samples: 40,
    observationMs: 50_000,
    bookAgeMs: 100,
    spreadBps: 3,
    bookImbalance: 0.35,
    imbalanceStability: 0.80,
    tradePressureFast: 0.55,
    tradeCount: 80,
    buyNotional: 80_000,
    sellNotional: 30_000,
    averageTradeNotional: 1_375,
    bookUpdateRate: 20,
    tradeArrivalRate: 12,
    aggressiveNotionalPerSecond: 13_750,
    micropriceDeviationBps: 3,
    bidDepthQuote: 500_000,
    askDepthQuote: 350_000,
    depthRatio: 1.4,
    spoofLikeScore: 0.05,
    askSpoofScore: 0.05,
    askAbsorptionScore: 0.10,
    askRefillRatio: 0.10,
    bidAbsorptionScore: 0.20,
    breakoutScore: 0.85,
    sweepReclaimScore: 0.20,
    ofiPersistence: 0.75,
    persistentBidWall: true,
    persistentAskWall: false,
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.80,
    turnover24hQuote: 50_000_000,
    minActionableTurnover24h: 100_000,
    trendContext: 0,
    marketHeatScore: 60,
    recentNotionalPerSecond: 13_750,
    notionalAcceleration: 0.30,
    tradeCountPerSecond: 10,
    notionalTrend: 0.10,
    tradeSpeedTrend: 0.10,
    tradeArrivalTrend: 0.10,
    pathEfficiency: 0.65,
    reversalRate: 0.20,
    noiseBandBps: 4,
    quoteFlickerRate: 5,
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    m1GateVersion: MINUTE_ENTRY_GATE_VERSION,
    m1DataAvailable: true,
    m1PreviousBullish: true,
    m1StochK: 82,
    m1StochD: 75,
    m1CompletedBars: 59,
    m1BandWidthExpansionRatio: 1.05,
    m1UpperBandSlopePct: 0.20,
    m1RecentAdvanceAtr: 1.20,
    m1SqueezeRelease: true,
    m1PreBreakout: true,
    m1CorePassed: true,
    ...overrides,
  };
}

const costs: LobCostEstimate = {
  roundTripFeeBps: 10,
  entrySlippageBps: 1,
  targetExitSlippageBps: 1,
  stopExitSlippageBps: 2,
  spreadBps: 3,
  latencyPenaltyBps: 0.5,
  forecastBiasPenaltyBps: 0,
};

function evaluate(overrides: Partial<LobFeatureVector> = {}) {
  return evaluateLobEntry(features(overrides), costs, { requireMinuteEntryGate: true });
}

Deno.test("valid M1 pre-breakout remains buyable", () => {
  const decision = evaluate();
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
});

Deno.test("contracting Bollinger width cannot masquerade as pre-breakout", () => {
  const decision = evaluate({
    m1BandWidthExpansionRatio: 0.99,
    m1SqueezeRelease: false,
  });
  assert(decision.reasons.includes("M1_BAND_WIDTH_NOT_EXPANDING"));
  assert(decision.decision !== "BUY");
});

Deno.test("measured late-extension chase cluster is rejected", () => {
  const decision = evaluate({
    change24hPct: 23.5,
    m1StochK: 94.82,
    m1RecentAdvanceAtr: 1.938,
    m1UpperBandSlopePct: 0.118,
  });
  assert(decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
  assert(decision.decision !== "BUY");
});

Deno.test("large 24h gain alone is not rejected when the 1m move is not late", () => {
  const decision = evaluate({
    change24hPct: 39.05,
    m1StochK: 91.52,
    m1RecentAdvanceAtr: 1.258,
    m1UpperBandSlopePct: 0.408,
    m1BandWidthExpansionRatio: 1.065,
    m1SqueezeRelease: true,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
});

Deno.test("high stochastic and advance remain allowed when upper-band slope is shallow", () => {
  const decision = evaluate({
    change24hPct: 18.99,
    m1StochK: 96.51,
    m1RecentAdvanceAtr: 1.963,
    m1UpperBandSlopePct: 0.038,
    m1BandWidthExpansionRatio: 1.018,
    m1SqueezeRelease: false,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("M1_LATE_EXTENSION_CHASE"));
});

Deno.test("PROM-like extreme drawdown and range are rejected", () => {
  const decision = evaluate({
    change24hPct: -20.9,
    dayRangePct: 32.4,
    m1RecentAdvanceAtr: 0.8,
    m1VolumeRatio: 1.0,
  });
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.reasons.includes("EXTREME_24H_DRAWDOWN"));
  assert(decision.decision !== "BUY");
});

Deno.test("COTI-like event range is rejected without banning normal high gainers", () => {
  const decision = evaluate({
    change24hPct: 40.9,
    dayRangePct: 62.9,
    m1RecentAdvanceAtr: 1.2,
    m1VolumeRatio: 1.1,
    m1BandWidthExpansionRatio: 1.05,
    m1SqueezeRelease: true,
  });
  assert(decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(decision.decision !== "BUY");
});

Deno.test("normal high gainer with controlled range remains buyable", () => {
  const decision = evaluate({
    change24hPct: 18.99,
    dayRangePct: 12,
    m1StochK: 91,
    m1RecentAdvanceAtr: 1.2,
    m1VolumeRatio: 1.05,
    m1UpperBandSlopePct: 0.08,
    m1BandWidthExpansionRatio: 1.05,
    m1SqueezeRelease: true,
  });
  assertEquals(decision.decision, "BUY", decision.reasons.join(","));
  assert(!decision.reasons.includes("EXTREME_24H_RANGE"));
  assert(!decision.reasons.includes("M1_MOMENTUM_CHASE_VOLUME_FADE"));
});

Deno.test("volume fade after an ATR chase is rejected", () => {
  const decision = evaluate({
    change24hPct: 12,
    dayRangePct: 14,
    m1RecentAdvanceAtr: 1.6,
    m1VolumeRatio: 0.6,
  });
  assert(decision.reasons.includes("M1_MOMENTUM_CHASE_VOLUME_FADE"));
  assert(decision.decision !== "BUY");
});
