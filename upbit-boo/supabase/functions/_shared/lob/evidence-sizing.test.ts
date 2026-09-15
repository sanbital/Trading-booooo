import { DEFAULT_LOB_ADAPTIVE_POLICY } from "./adaptive-policy.ts";
import { lobEvidenceSizeFraction } from "./evidence-sizing.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("mature high-quality evidence reaches a full slot", () => {
  const out = lobEvidenceSizeFraction({
    dataQuality: 0.90,
    dynamicStatus: "BREAKOUT_CONFIRMED",
    featureSamples: 100,
    marketSamples: 100,
    patternSamples: 200,
  }, DEFAULT_LOB_ADAPTIVE_POLICY);
  assert(out.fraction === 1, JSON.stringify(out));
});

Deno.test("insufficient LOB evidence still trades but cannot use a full slot", () => {
  const out = lobEvidenceSizeFraction({
    dataQuality: 0.70,
    dynamicStatus: "INSUFFICIENT",
    featureSamples: 20,
    marketSamples: 2,
    patternSamples: 40,
  }, DEFAULT_LOB_ADAPTIVE_POLICY);
  assert(out.fraction >= 0.35);
  assert(out.fraction <= DEFAULT_LOB_ADAPTIVE_POLICY.evidenceSizing.insufficientStatusCap);
  assert(out.cappedBy === "INSUFFICIENT_STATUS");
});

Deno.test("very low data quality is capped at the low-quality exploration size", () => {
  const out = lobEvidenceSizeFraction({
    dataQuality: 0.10,
    dynamicStatus: "NEUTRAL",
    featureSamples: 500,
    marketSamples: 500,
    patternSamples: 500,
  }, DEFAULT_LOB_ADAPTIVE_POLICY);
  assert(out.fraction <= DEFAULT_LOB_ADAPTIVE_POLICY.evidenceSizing.lowQualityCap);
  assert(out.cappedBy === "LOW_DATA_QUALITY");
});
