import { evaluateLobEntry } from "./entry.ts";
import { evaluateLobExit } from "./exit.ts";
import type { LobFeatureVector } from "./types.ts";

type TestFn = () => void | Promise<void>;
const test = (globalThis as any).Deno?.test
  ? (name: string, fn: TestFn) => (globalThis as any).Deno.test(name, fn)
  : (name: string, fn: TestFn) => Promise.resolve(fn()).then(() => console.log(`ok - ${name}`));

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const hot: LobFeatureVector = {
  samples: 80, observationMs: 15000, bookAgeMs: 100, spreadBps: 3,
  bookImbalance: 0.32, imbalanceStability: 0.84, tradePressureFast: 0.55,
  tradeCount: 160, buyNotional: 800000, sellNotional: 250000,
  averageTradeNotional: 6500, bookUpdateRate: 18, tradeArrivalRate: 12,
  aggressiveNotionalPerSecond: 70000, micropriceDeviationBps: 2.2,
  bidDepthQuote: 2000000, askDepthQuote: 900000, depthRatio: 2.2,
  spoofLikeScore: 0.05, askSpoofScore: 0.04, askRefillRatio: 0.05,
  askAbsorptionScore: 0.08, bidAbsorptionScore: 0.72,
  breakoutScore: 0.82, sweepReclaimScore: 0.65, ofiPersistence: 0.86,
  persistentBidWall: true, persistentAskWall: false, dynamicStatus: "BREAKOUT_CONFIRMED",
  dataQuality: 0.95, turnover24hQuote: 100000000, minActionableTurnover24h: 1000000,
  trendContext: -0.8,
  // v6.1 added four heat fields and v6.2 four path fields; the fixture was never updated,
  // so `deno task test` failed type-checking on this object and the deploy could not run.
  marketHeatScore: 82, recentNotionalPerSecond: 90000, notionalAcceleration: 0.7,
  tradeCountPerSecond: 12,
  pathEfficiency: 0.55, reversalRate: 0.35, noiseBandBps: 4, quoteFlickerRate: 20,
  fundingPremiumBps: 2.5, fundingAttention: 0.3, fundingEdge: 0.01,
};

const costs = {
  roundTripFeeBps: 5, entrySlippageBps: 0.5, targetExitSlippageBps: 0.5,
  stopExitSlippageBps: 1.5, spreadBps: 3,
};

test("bearish trend cannot veto a hot LOB BUY", () => {
  const good = evaluateLobEntry(hot, costs);
  assert(good.decision === "BUY", `hot LOB should buy: ${good.reasons.join(",")}`);
  assert(good.evLowerBoundBps > 0, "EV lower bound must be positive");
  assert(good.targetReturnNetBps > 0, "target net must be positive");
  assert(good.pattern != null, "a primary pattern is required");
  assert(good.features.trendContext < 0, "test must prove bearish trend is not a veto");
});

test("stale orderbook is discarded", () => {
  const stale = evaluateLobEntry({ ...hot, bookAgeMs: 10000 }, costs);
  assert(stale.decision === "AVOID", "stale book must be avoided");
});

test("fees and slippage can make a candidate non-actionable", () => {
  const expensive = evaluateLobEntry({ ...hot, spreadBps: 25 }, {
    roundTripFeeBps: 20, entrySlippageBps: 8, targetExitSlippageBps: 8,
    stopExitSlippageBps: 12, spreadBps: 25,
  }, { maxSpreadBps: 40, maxTargetBps: 30 });
  assert(expensive.decision !== "BUY", "negative net EV must not enter");
});

test("signal reversal exits before target or timeout", () => {
  const decision = evaluateLobExit({
    emergency: false, reconciliationFailed: false, currentPrice: 99, stopPrice: 95,
    targetPrice: 105, heldSeconds: 20, maxHoldingSeconds: 180, bookImbalance: -0.4,
    tradePressure: -0.5, micropriceDeviationBps: -2, spreadBps: 4, maxSpreadBps: 30,
    bidDepthRatio: 0.8, minBidDepthRatio: 0.3,
  });
  assert(decision.reason === "SIGNAL_REVERSAL", "signal reversal priority must fire");
});
