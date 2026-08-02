import { assessLobEntryRisk } from "./entry.ts";
import type { LobFeatureVector } from "./types.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function features(overrides: Partial<LobFeatureVector> = {}): LobFeatureVector {
  return {
    dynamicStatus: "NEUTRAL",
    dataQuality: 0.8,
    tradePressureFast: 0.22,
    micropriceDeviationBps: 0.8,
    bookImbalance: 0.15,
    ofiPersistence: 0.55,
    spoofLikeScore: 0,
    askSpoofScore: 0,
    buyNotional: 120,
    sellNotional: 100,
    notionalAcceleration: 0,
    tradeSpeedTrend: 0,
    notionalTrend: 0,
    depthRatio: 1.05,
    tradeArrivalRate: 1,
    ...overrides,
  } as LobFeatureVector;
}

Deno.test("flat notional acceleration can pass with composite live pressure", () => {
  const result = assessLobEntryRisk(features());
  assert(!result.reasons.includes("BUY_FLOW_NOT_ACCELERATING"));
  assert(!result.reasons.includes("BUY_PRESSURE_NOT_CONFIRMED"));
  assert(result.warnings.includes("BUY_FLOW_NOT_ACCELERATING_OPTIONAL_VOTE"));
  assert(result.positiveVotes >= 5);
});

Deno.test("acceleration alone cannot authorize an entry", () => {
  const result = assessLobEntryRisk(features({
    tradePressureFast: -0.2,
    buyNotional: 80,
    sellNotional: 120,
    notionalAcceleration: 1,
    micropriceDeviationBps: -1,
    bookImbalance: -0.2,
    ofiPersistence: 0.1,
    depthRatio: 0.4,
    tradeSpeedTrend: -0.3,
  }));
  assert(result.reasons.includes("BUY_PRESSURE_NOT_CONFIRMED"));
  assert(result.reasons.includes("SELL_PRESSURE_DOMINANT"));
});

Deno.test("no live tape remains a hard rejection", () => {
  const result = assessLobEntryRisk(features({ tradeArrivalRate: 0 }));
  assert(result.reasons.includes("NO_LIVE_BUY_TAPE"));
});
