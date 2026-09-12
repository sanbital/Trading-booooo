import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildBridgeOutcomeForecast } from "./outcome-forecaster.ts";
import {
  deriveNetPositiveProbability,
  evaluateCandidate,
  SHADOW_CANDIDATE_GATE,
} from "./candidate-gate.ts";

const costs = {
  entryFeeRate: 0.0002,
  targetExitFeeRate: 0.0002,
  stopExitFeeRate: 0.0002,
  entrySlippageRate: 0.0001,
  targetExitSlippageRate: 0.0001,
  stopExitSlippageRate: 0.0002,
  unfilledMeasuredCostRate: 0,
};

Deno.test("pNetPositive is derived from consistent outcome probabilities", () => {
  assertAlmostEquals(deriveNetPositiveProbability(0.6, 0.3, 0.1, 0.4, 0.001, -0.001), 0.64, 1e-12);
});

Deno.test("strong forecast passes all conservative lower bounds", () => {
  const forecast = buildBridgeOutcomeForecast({
    conditionalTargetProbability: 0.9,
    resolveProbability: 0.98,
    timeoutReturnNet: -0.0006,
    expectedHoldingMinutes: 10,
    expectedOrderType: "MARKET",
    depthCoverageRatio: 2,
    spreadBps: 1,
    bookImbalance: 0,
    signalAgeMs: 100,
    effectiveSamples: 1000,
    calibrationReady: true,
    modelVersion: "test",
    calibrationVersion: "test",
  });
  const result = evaluateCandidate(
    { targetPct: 0.008, stopPct: 0.003, maxHoldingMinutes: 10 },
    forecast,
    costs,
    { ...SHADOW_CANDIDATE_GATE, minEvBuffer: 0.0001 },
  );
  assert(result.accepted, result.rejectionReasons.join(","));
  assert(result.evLowerBound > 0);
  assert(result.pWinLowerBound >= 0.5);
});

Deno.test("low fill candidate is rejected even when unfilled cash cost is zero", () => {
  const forecast = buildBridgeOutcomeForecast({
    conditionalTargetProbability: 0.9,
    resolveProbability: 1,
    timeoutReturnNet: -0.001,
    expectedHoldingMinutes: 10,
    expectedOrderType: "POST_ONLY",
    depthCoverageRatio: 0.1,
    spreadBps: 30,
    bookImbalance: 1,
    signalAgeMs: 60000,
    effectiveSamples: 1000,
    calibrationReady: true,
    modelVersion: "test",
    calibrationVersion: "test",
  });
  const result = evaluateCandidate(
    { targetPct: 0.02, stopPct: 0.003, maxHoldingMinutes: 10 },
    forecast,
    costs,
    SHADOW_CANDIDATE_GATE,
  );
  assertEquals(result.accepted, false);
  assert(result.rejectionReasons.includes("PFILL_LOWER_BOUND_TOO_LOW"));
});
