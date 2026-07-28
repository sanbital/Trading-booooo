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
  samples: 80,
  observationMs: 15000,
  bookAgeMs: 100,
  spreadBps: 3,
  bookImbalance: 0.32,
  imbalanceStability: 0.84,
  tradePressureFast: 0.55,
  tradeCount: 160,
  buyNotional: 800000,
  sellNotional: 250000,
  averageTradeNotional: 6500,
  bookUpdateRate: 18,
  tradeArrivalRate: 12,
  aggressiveNotionalPerSecond: 70000,
  micropriceDeviationBps: 2.2,
  bidDepthQuote: 2000000,
  askDepthQuote: 900000,
  depthRatio: 2.2,
  spoofLikeScore: 0.05,
  askSpoofScore: 0.04,
  askRefillRatio: 0.05,
  askAbsorptionScore: 0.08,
  bidAbsorptionScore: 0.72,
  breakoutScore: 0.82,
  sweepReclaimScore: 0.65,
  ofiPersistence: 0.86,
  persistentBidWall: true,
  persistentAskWall: false,
  dynamicStatus: "BREAKOUT_CONFIRMED",
  dataQuality: 0.95,
  turnover24hQuote: 100000000,
  minActionableTurnover24h: 1000000,
  trendContext: -0.8,
  // v6.1 added four heat fields and v6.2 four path fields; the fixture was never updated,
  // so `deno task test` failed type-checking on this object and the deploy could not run.
  marketHeatScore: 82,
  recentNotionalPerSecond: 90000,
  notionalAcceleration: 0.7,
  tradeCountPerSecond: 12,
  pathEfficiency: 0.55,
  reversalRate: 0.35,
  noiseBandBps: 4,
  quoteFlickerRate: 20,
  fundingPremiumBps: 2.5,
  fundingAttention: 0.3,
  fundingEdge: 0.01,
};

const costs = {
  roundTripFeeBps: 5,
  entrySlippageBps: 0.5,
  targetExitSlippageBps: 0.5,
  stopExitSlippageBps: 1.5,
  spreadBps: 3,
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
    roundTripFeeBps: 20,
    entrySlippageBps: 8,
    targetExitSlippageBps: 8,
    stopExitSlippageBps: 12,
    spreadBps: 25,
  }, { maxSpreadBps: 40, maxTargetBps: 30 });
  assert(expensive.decision !== "BUY", "negative net EV must not enter");
});

test("confirmed live forecast optimism is charged directly to entry EV", () => {
  const uncorrected = evaluateLobEntry(hot, costs);
  const corrected = evaluateLobEntry(hot, { ...costs, forecastBiasPenaltyBps: 5 });
  assert(
    Math.abs((uncorrected.evNetBps - corrected.evNetBps) - 5) < 1e-9,
    "EV bias penalty must lower mean EV by the measured amount",
  );
  assert(
    Math.abs((uncorrected.evLowerBoundBps - corrected.evLowerBoundBps) - 5) < 1e-9,
    "EV bias penalty must also lower the conservative bound",
  );
  assert(corrected.forecastBiasPenaltyBps === 5, "audit must retain the applied penalty");
});

test("a learned wider stop is repriced through EV instead of bypassing it", () => {
  const learned = evaluateLobEntry(hot, costs, { learnedStopFloorBps: 80 });
  assert(learned.stopBps >= 80, "winner MAE floor must reach the executable stop");
  if (learned.decision === "BUY") {
    assert(learned.evLowerBoundBps > 0, "wider stop must still clear positive net EV");
  } else {
    assert(
      learned.reasons.includes("NET_EV_NOT_POSITIVE"),
      "a wider stop that no longer pays must be rejected by EV",
    );
  }
});

test("signal reversal exits before target or timeout", () => {
  const decision = evaluateLobExit({
    emergency: false,
    reconciliationFailed: false,
    currentPrice: 99,
    stopPrice: 95,
    targetPrice: 105,
    heldSeconds: 20,
    maxHoldingSeconds: 180,
    bookImbalance: -0.4,
    tradePressure: -0.5,
    micropriceDeviationBps: -2,
    spreadBps: 4,
    maxSpreadBps: 30,
    bidDepthRatio: 0.8,
    minBidDepthRatio: 0.3,
  });
  assert(decision.reason === "SIGNAL_REVERSAL", "signal reversal priority must fire");
});

test("maker-fill sell pressure needs settlement and repeated soft confirmation", () => {
  const first = evaluateLobExit({
    emergency: false,
    reconciliationFailed: false,
    currentPrice: 99,
    stopPrice: 95,
    targetPrice: 105,
    heldSeconds: 2,
    maxHoldingSeconds: 180,
    bookImbalance: -0.4,
    tradePressure: -0.5,
    micropriceDeviationBps: -2,
    spreadBps: 4,
    maxSpreadBps: 30,
    bidDepthRatio: 0.8,
    minBidDepthRatio: 0.3,
    softExitGraceSeconds: 6,
    softExitConfirmations: 2,
  });
  assert(!first.exit, "one post-fill sell observation must not churn the position");
  const confirmed = evaluateLobExit({
    emergency: false,
    reconciliationFailed: false,
    currentPrice: 99,
    stopPrice: 95,
    targetPrice: 105,
    heldSeconds: 8,
    maxHoldingSeconds: 180,
    bookImbalance: -0.4,
    tradePressure: -0.5,
    micropriceDeviationBps: -2,
    spreadBps: 4,
    maxSpreadBps: 30,
    bidDepthRatio: 0.8,
    minBidDepthRatio: 0.3,
    previousSoftReason: first.nextSoftReason,
    softSignalStreak: first.nextSoftSignalStreak,
    softExitGraceSeconds: 6,
    softExitConfirmations: 2,
  });
  assert(confirmed.exit && confirmed.reason === "SIGNAL_REVERSAL", "persistent reversal must exit");
});

test("target hit outranks a simultaneous soft invalidation", () => {
  const target = evaluateLobExit({
    emergency: false,
    reconciliationFailed: false,
    currentPrice: 106,
    stopPrice: 95,
    targetPrice: 105,
    heldSeconds: 20,
    maxHoldingSeconds: 180,
    bookImbalance: -0.8,
    tradePressure: -0.8,
    micropriceDeviationBps: -4,
    spreadBps: 80,
    maxSpreadBps: 30,
    bidDepthRatio: 0.01,
    minBidDepthRatio: 0.3,
  });
  assert(target.reason === "TARGET_HIT", "a realized target must not be labelled as a stop");
});
