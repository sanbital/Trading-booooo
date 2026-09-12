import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBridgeOutcomeForecast,
  estimateFillProbability,
  normalizeBarrierProbabilities,
  validateOutcomeForecast,
} from "./outcome-forecaster.ts";

Deno.test("barrier probabilities are normalized", () => {
  const p = normalizeBarrierProbabilities(0.7, 0.2, 0.2);
  assertAlmostEquals(p.pTarget + p.pStop + p.pTimeout, 1, 1e-12);
});

Deno.test("bridge forecast creates a non-empty conservative ensemble", () => {
  const f = buildBridgeOutcomeForecast({
    conditionalTargetProbability: 0.72,
    resolveProbability: 0.9,
    timeoutReturnNet: -0.001,
    expectedHoldingMinutes: 12,
    expectedOrderType: "POST_ONLY",
    depthCoverageRatio: 1.5,
    spreadBps: 4,
    bookImbalance: 0.1,
    signalAgeMs: 3000,
    effectiveSamples: 200,
    calibrationReady: true,
    modelVersion: "test",
    calibrationVersion: "test-cal",
  });
  assertEquals(f.uncertaintyScenarios.length, 27);
  assertEquals(validateOutcomeForecast(f), []);
  assert(f.independentBlocks > 0);
});

Deno.test("market orders receive a higher fill prior than post-only", () => {
  const common = { depthCoverageRatio: 1.2, spreadBps: 4, bookImbalance: 0, signalAgeMs: 1000 };
  const market = estimateFillProbability({ ...common, expectedOrderType: "MARKET" });
  const post = estimateFillProbability({ ...common, expectedOrderType: "POST_ONLY" });
  assert(market > post);
});
