import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCalibration,
  brierScore,
  DEFAULT_CALIBRATION_FIT,
  evaluatePromotion,
  fitCalibration,
  IDENTITY_CALIBRATION,
  logit,
  realizedResolveRate,
  reliabilityBins,
  sigmoid,
  type CalibrationSample,
} from "./calibration.ts";

/** Samples whose realized rate is `trueRate` regardless of what the model predicted. */
function overconfident(n: number, predicted: number, trueRate: number): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < n; i++) {
    // Deterministic interleave so the split is representative and the test is stable.
    out.push({ predicted, outcome: (i % 100) < Math.round(trueRate * 100) ? 1 : 0 });
  }
  return out;
}

Deno.test("logit and sigmoid round-trip", () => {
  for (const p of [0.05, 0.3, 0.5, 0.72, 0.95]) {
    assertAlmostEquals(sigmoid(logit(p)), p, 1e-9);
  }
});

Deno.test("identity calibration leaves the probability untouched", () => {
  for (const p of [0.31, 0.5, 0.68, 0.84]) {
    assertAlmostEquals(applyCalibration(p, IDENTITY_CALIBRATION), p, 1e-6);
  }
});

Deno.test("fit pulls an overconfident model toward the realized rate", () => {
  // The model always says 0.70; reality is 0.45.
  const samples = overconfident(1200, 0.70, 0.45);
  const model = fitCalibration(samples);
  const corrected = applyCalibration(0.70, model);
  assert(corrected < 0.70, `corrected ${corrected}`);
  assert(corrected > 0.40, `corrected ${corrected}`);
  assert(brierScore(samples, model) < brierScore(samples, IDENTITY_CALIBRATION));
});

Deno.test("shrinkage grows with evidence and is bounded when evidence is thin", () => {
  const moved = (n: number) =>
    Math.abs(applyCalibration(0.70, fitCalibration(overconfident(n, 0.70, 0.45))) - 0.70);
  const few = moved(40);
  const some = moved(400);
  const many = moved(4000);
  assert(few < some && some < many, `${few} ${some} ${many}`);
  // A thin sample must never move the live probability far, and in any case cannot be
  // promoted: evaluatePromotion enforces minSamples before a profile goes live.
  assert(few < 0.12, `few ${few}`);
});

Deno.test("promotion is refused below the minimum sample count", () => {
  const d = evaluatePromotion(overconfident(50, 0.7, 0.45));
  assertEquals(d.promote, false);
  assert(d.reason.startsWith("insufficient_samples"));
});

Deno.test("promotion is refused when every outcome is identical", () => {
  const d = evaluatePromotion(overconfident(500, 0.7, 1.0));
  assertEquals(d.promote, false);
  assertEquals(d.reason, "degenerate_outcomes");
});

Deno.test("promotion is refused when the challenger does not beat the incumbent", () => {
  // Already well calibrated: nothing to gain.
  const samples = overconfident(1000, 0.50, 0.50);
  const d = evaluatePromotion(samples, IDENTITY_CALIBRATION);
  assertEquals(d.promote, false);
  assertEquals(d.reason, "no_material_improvement");
});

Deno.test("promotion succeeds on a genuinely miscalibrated model", () => {
  const samples = overconfident(1500, 0.75, 0.40);
  const d = evaluatePromotion(samples, IDENTITY_CALIBRATION);
  assertEquals(d.promote, true);
  assert(d.challengerHoldoutBrier < d.incumbentHoldoutBrier);
  assert(d.holdoutSize > 0 && d.trainSize > 0);
});

Deno.test("holdout is chronological, never random", () => {
  // Newest samples must be the holdout, so a profile cannot be promoted using
  // information that postdates the data it was fitted on.
  const samples: CalibrationSample[] = [
    ...overconfident(700, 0.75, 0.40),
    ...overconfident(300, 0.75, 0.95),
  ];
  const d = evaluatePromotion(samples, IDENTITY_CALIBRATION);
  assertEquals(d.trainSize, 700);
  assertEquals(d.holdoutSize, 300);
});

Deno.test("fitted slope and intercept stay inside safe bounds", () => {
  const extreme = fitCalibration(overconfident(20_000, 0.99, 0.01));
  assert(extreme.a >= DEFAULT_CALIBRATION_FIT.minSlope);
  assert(extreme.a <= DEFAULT_CALIBRATION_FIT.maxSlope);
  assert(Math.abs(extreme.b) <= DEFAULT_CALIBRATION_FIT.maxIntercept);
});

Deno.test("reliability bins report predicted versus realized per bucket", () => {
  const bins = reliabilityBins([
    ...overconfident(100, 0.25, 0.20),
    ...overconfident(100, 0.85, 0.50),
  ], 5);
  const low = bins.find((b) => b.lower === 0.2)!;
  const high = bins.find((b) => b.lower === 0.8)!;
  assertEquals(low.count, 100);
  assertEquals(high.count, 100);
  assertAlmostEquals(high.realizedRate, 0.5, 0.02);
});

Deno.test("realized resolve rate counts barrier resolutions only", () => {
  assertEquals(realizedResolveRate([{ resolved: true }, { resolved: false }, { resolved: true }, { resolved: true }]), 0.75);
  assertEquals(realizedResolveRate([]), null);
});
