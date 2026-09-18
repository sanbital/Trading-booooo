import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveLobUncertaintyHaircut } from "./uncertainty.ts";
import type { LobFeatureVector } from "./types.ts";

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    samples: 30,
    observationMs: 30_000,
    bookAgeMs: 100,
    spreadBps: 3,
    bookImbalance: 0.5,
    imbalanceStability: 0.8,
    tradePressureFast: 0.7,
    tradeCount: 100,
    buyNotional: 100_000,
    sellNotional: 40_000,
    averageTradeNotional: 1_000,
    bookUpdateRate: 8,
    tradeArrivalRate: 8,
    aggressiveNotionalPerSecond: 10_000,
    micropriceDeviationBps: 2,
    bidDepthQuote: 500_000,
    askDepthQuote: 300_000,
    depthRatio: 1.6,
    spoofLikeScore: 0,
    askSpoofScore: 0,
    askRefillRatio: 0,
    askAbsorptionScore: 0,
    bidAbsorptionScore: 0,
    breakoutScore: 0.8,
    sweepReclaimScore: 0,
    ofiPersistence: 0.8,
    persistentBidWall: true,
    persistentAskWall: false,
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.65,
    turnover24hQuote: 10_000_000_000,
    minActionableTurnover24h: 1_000_000_000,
    trendContext: 0,
    marketHeatScore: 80,
    recentNotionalPerSecond: 10_000,
    notionalAcceleration: 0.2,
    tradeCountPerSecond: 8,
    pathEfficiency: 0.7,
    reversalRate: 0.2,
    noiseBandBps: 3,
    quoteFlickerRate: 2,
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
    ...overrides,
  };
}

Deno.test("strong corroborated evidence earns a small uncertainty haircut", () => {
  const result = resolveLobUncertaintyHaircut(features(), 0.25);
  assertEquals(result.tier, "STRONG");
  assertEquals(result.positiveDirectionVotes, 3);
  assertAlmostEquals(result.haircut, 0.0625, 1e-12);
});

Deno.test("insufficient observations keep the full base haircut", () => {
  const result = resolveLobUncertaintyHaircut(features({
    dynamicStatus: "INSUFFICIENT",
    dataQuality: 0.35,
  }), 0.25);
  assertEquals(result.tier, "BASE");
  assertAlmostEquals(result.haircut, 0.25, 1e-12);
});

Deno.test("a sub-30-second window cannot earn an uncertainty discount", () => {
  const result = resolveLobUncertaintyHaircut(features({
    observationMs: 29_999,
  }), 0.25);
  assertEquals(result.tier, "BASE");
  assertAlmostEquals(result.haircut, 0.25, 1e-12);
});

Deno.test("wide spread cannot earn an uncertainty discount", () => {
  const result = resolveLobUncertaintyHaircut(features({ spreadBps: 20 }), 0.25);
  assertEquals(result.tier, "BASE");
  assertAlmostEquals(result.haircut, 0.25, 1e-12);
});

Deno.test("direction conflict cannot earn an uncertainty discount", () => {
  const result = resolveLobUncertaintyHaircut(features({
    tradePressureFast: -0.4,
    micropriceDeviationBps: -2,
  }), 0.25);
  assertEquals(result.tier, "BASE");
  assertEquals(result.positiveDirectionVotes, 1);
});
