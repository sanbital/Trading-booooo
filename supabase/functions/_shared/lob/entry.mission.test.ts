import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateLobEntry } from "./entry.ts";
import { detectLobPatterns } from "./patterns.ts";
import type { LobCostEstimate, LobFeatureVector } from "./types.ts";

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    samples: 12,
    observationMs: 50000,
    bookAgeMs: 100,
    spreadBps: 3,
    bookImbalance: 0.35,
    imbalanceStability: 0.75,
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
    dynamicStatus: "READY",
    dataQuality: 0.70,
    turnover24hQuote: 50_000_000_000,
    minActionableTurnover24h: 1_000_000_000,
    trendContext: 0.002,
    marketHeatScore: 60,
    recentNotionalPerSecond: 13_750,
    notionalAcceleration: 0.30,
    tradeCountPerSecond: 10,
    pathEfficiency: 0.65,
    reversalRate: 0.20,
    noiseBandBps: 4,
    quoteFlickerRate: 5,
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
  latencyPenaltyBps: 0.5,
  forecastBiasPenaltyBps: 0,
};

Deno.test("a single breakout score cannot declare LONG against tape, microprice and book", () => {
  const bearish = features({
    breakoutScore: 0.99,
    tradePressureFast: -0.14,
    micropriceDeviationBps: -5.4,
    bookImbalance: -0.60,
    ofiPersistence: 0.22,
  });
  const breakout = detectLobPatterns(bearish).find((row) =>
    row.name === "QUEUE_DEPLETION_BREAKOUT"
  );
  assert(breakout);
  assertEquals(breakout.primary, false);
  const decision = evaluateLobEntry(bearish, costs);
  assert(decision.reasons.includes("NEGATIVE_TRADE_PRESSURE"));
  assert(decision.decision !== "BUY");
});

Deno.test("coherent breakout uses short-horizon target geometry", () => {
  const decision = evaluateLobEntry(features(), costs);
  assertEquals(decision.pattern, "QUEUE_DEPLETION_BREAKOUT");
  assert(decision.targetBps >= 12);
  assert(decision.targetBps <= 80);
  assertEquals(decision.stopBps, 500);
});

Deno.test("target and stop are unconditional resolved probabilities", () => {
  const decision = evaluateLobEntry(features(), costs);
  assertAlmostEquals(
    decision.pTarget + decision.pStop,
    1 - decision.pTimeout,
    1e-12,
  );
  assertAlmostEquals(
    decision.pTarget + decision.pStop + decision.pTimeout,
    1,
    1e-12,
  );
  assert(decision.pTarget < 1 - decision.pTimeout);
  assert(decision.pStop > 0);
});

Deno.test("busy tape does not create bullish probability when direction reverses", () => {
  const bullish = evaluateLobEntry(features(), costs);
  const bearish = evaluateLobEntry(
    features({
      marketHeatScore: 100,
      tradeArrivalRate: 30,
      bookUpdateRate: 40,
      aggressiveNotionalPerSecond: 50_000,
      tradePressureFast: -0.70,
      micropriceDeviationBps: -4,
      bookImbalance: -0.50,
      breakoutScore: 0.99,
      ofiPersistence: 0.90,
    }),
    costs,
  );
  assert(bearish.pTarget < bullish.pTarget);
  assert(bearish.decision !== "BUY");
});
