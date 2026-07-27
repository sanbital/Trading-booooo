// Trading-booooo v6.9.0 — evidence-weighted LOB position sizing.
//
// Entry permission and order size are intentionally separated. An insufficient window is
// still allowed to produce learning trades, but it cannot consume a full slot until the
// book observation and online outcome evidence are mature.

import type { LobAdaptivePolicyDefinition } from "./adaptive-policy.ts";

export interface LobEvidenceSizingInput {
  dataQuality: number;
  dynamicStatus: string;
  featureSamples: number;
  marketSamples: number;
  patternSamples: number;
}

export interface LobEvidenceSizingDecision {
  fraction: number;
  qualityScore: number;
  featureScore: number;
  onlineScore: number;
  cappedBy: "NONE" | "INSUFFICIENT_STATUS" | "LOW_DATA_QUALITY";
  reason: string;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

export function lobEvidenceSizeFraction(
  input: LobEvidenceSizingInput,
  policy: LobAdaptivePolicyDefinition,
): LobEvidenceSizingDecision {
  const cfg = policy.evidenceSizing;
  const floor = clamp(cfg.unprovenFloorFraction, 0.10, 0.60);
  const qualityScore = clamp(finite(input.dataQuality) / cfg.dataQualityForFullSize, 0, 1);
  const featureScore = clamp(finite(input.featureSamples) / cfg.featureSamplesForFullSize, 0, 1);
  // Market evidence is preferred; broad pattern evidence can carry at most 75% of the
  // online score so one new symbol never becomes full-size solely because its pattern is old.
  const marketScore = clamp(finite(input.marketSamples) / cfg.marketSamplesForFullSize, 0, 1);
  const patternScore = clamp(finite(input.patternSamples) / cfg.patternSamplesForFullSize, 0, 1);
  const onlineScore = Math.max(marketScore, patternScore * 0.75);
  // Geometric aggregation makes one genuinely weak evidence dimension matter without
  // turning it into a hard veto. A 0 score still receives the operator-approved floor.
  const evidence = Math.cbrt(Math.max(0, qualityScore * featureScore * onlineScore));
  let fraction = clamp(floor + (1 - floor) * evidence, floor, 1);
  let cappedBy: LobEvidenceSizingDecision["cappedBy"] = "NONE";
  const status = String(input.dynamicStatus || "").toUpperCase();
  if (status === "INSUFFICIENT" || status.includes("INSUFFICIENT")) {
    fraction = Math.min(fraction, cfg.insufficientStatusCap);
    cappedBy = "INSUFFICIENT_STATUS";
  }
  if (finite(input.dataQuality) < 0.25) {
    fraction = Math.min(fraction, cfg.lowQualityCap);
    cappedBy = "LOW_DATA_QUALITY";
  }
  fraction = clamp(fraction, floor, 1);
  return {
    fraction,
    qualityScore,
    featureScore,
    onlineScore,
    cappedBy,
    reason: cappedBy === "NONE"
      ? `evidence ${(evidence * 100).toFixed(0)}%`
      : `${cappedBy.toLowerCase()}: evidence ${(evidence * 100).toFixed(0)}%`,
  };
}
