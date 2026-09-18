import {
  DEFAULT_LOB_ADAPTIVE_POLICY,
  normalizeLobAdaptivePolicy,
  proposeLobAdaptivePolicy,
} from "./adaptive-policy.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("adaptive policy clamps every self-tuned parameter inside reviewed bounds", () => {
  const policy = normalizeLobAdaptivePolicy({
    schemaVersion: 1,
    family: "EV_DEBIASED",
    evidenceSizing: {
      unprovenFloorFraction: 0,
      insufficientStatusCap: 9,
      lowQualityCap: -2,
      dataQualityForFullSize: 5,
      featureSamplesForFullSize: 1,
      marketSamplesForFullSize: 99999,
      patternSamplesForFullSize: 1,
    },
    latency: { assumedP95Ms: 99999, unmeasuredFloorBps: 99, penaltyMultiplier: 9 },
    evBias: { penaltyMultiplier: 9, maxPenaltyBps: 999 },
  });
  assert(policy.evidenceSizing.unprovenFloorFraction === 0.10);
  assert(policy.evidenceSizing.insufficientStatusCap === 0.75);
  assert(policy.evidenceSizing.lowQualityCap === 0.15);
  assert(policy.evidenceSizing.dataQualityForFullSize === 0.95);
  assert(policy.latency.assumedP95Ms === 5000);
  assert(policy.latency.unmeasuredFloorBps === 5);
  assert(policy.evBias.maxPenaltyBps === 50);
});

Deno.test("diagnostics select bounded policy families rather than source-code mutation", () => {
  assert(proposeLobAdaptivePolicy({
    latencyMeasured: false,
    latencySloBreached: false,
    evBiasPenaltyBps: 0,
    insufficientDataShare: 0,
  }).family === "LATENCY_GUARDED");
  assert(proposeLobAdaptivePolicy({
    latencyMeasured: true,
    latencySloBreached: false,
    evBiasPenaltyBps: 5,
    insufficientDataShare: 0,
  }).family === "EV_DEBIASED");
  assert(proposeLobAdaptivePolicy({
    latencyMeasured: true,
    latencySloBreached: false,
    evBiasPenaltyBps: 0,
    insufficientDataShare: 0.5,
  }).family === "QUALITY_WEIGHTED");
  assert(proposeLobAdaptivePolicy({
    latencyMeasured: true,
    latencySloBreached: false,
    evBiasPenaltyBps: 0,
    insufficientDataShare: 0,
  }).family === DEFAULT_LOB_ADAPTIVE_POLICY.family);
});
