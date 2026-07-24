import { buildCalibrationProfile, profileToTypeScript } from "./calibration.ts";
import { computeAccuracyMetrics, computeMetrics } from "./metrics.ts";
import type { SignalEvaluation, Trade } from "./simulate.ts";

function signal(score: number, hit: boolean): SignalEvaluation {
  return {
    market: "KRW-TEST",
    exchange: "upbit",
    signalTime: score,
    decision: "BUY",
    score,
    confidence: 70,
    horizonCode: "SHORT",
    targetStrategy: "SHORT_ONLY",
    entryStatus: "ENTERED",
    entryTime: 1,
    entryPrice: 100,
    exitTime: 2,
    exitPrice: hit ? 103 : 98,
    outcome: hit ? "TARGET_FIRST" : "STOP_FIRST",
    exitReason: hit ? "TARGET" : "STOP",
    rawPredictedUpsidePct: 4,
    predictedUpsidePct: 3,
    predictedHitProbabilityPct: 60,
    realizedNetPct: hit ? 3 : -2,
    maxFavorableExcursionPct: hit ? 4 : 1,
    maxAdverseExcursionPct: hit ? 1 : 3,
    forecastErrorPct: hit ? 1 : -2,
    brierScore: hit ? 0.16 : 0.36,
    directionCorrect: hit,
    ambiguousSameBar: false,
    failedGates: [],
  };
}

function trade(hit: boolean): Trade {
  return {
    market: "KRW-TEST",
    signalType: "BUY",
    signalTime: 0,
    entryTime: 1,
    exitTime: 2,
    entryPrice: 100,
    exitPrice: hit ? 103 : 98,
    target: 103,
    secondTarget: null,
    stop: 98,
    targetStrategy: "SHORT_ONLY",
    barsHeld: 2,
    assetNetPct: hit ? 3 : -2,
    netPct: hit ? 1.5 : -1,
    allocationPct: 50,
    exitReason: hit ? "TARGET" : "STOP",
    score: 80,
    plannedRR: 1.5,
    rawPredictedUpsidePct: 4,
    predictedUpsidePct: 3,
    predictedHitProbabilityPct: 60,
    maxFavorableExcursionPct: hit ? 4 : 1,
    maxAdverseExcursionPct: hit ? 1 : 3,
    forecastErrorPct: hit ? 1 : -2,
    ambiguousSameBar: false,
  };
}

Deno.test("calibration builds smoothed score buckets and serializable runtime profile", () => {
  const signals = [
    ...Array.from({ length: 24 }, (_, i) => signal(80 + i % 4, i < 16)),
    ...Array.from({ length: 12 }, (_, i) => signal(72 + i % 3, i < 5)),
  ];
  const trades = [trade(true), trade(true), trade(false)];
  const profile = buildCalibrationProfile({
    signals,
    parameters: {
      scoreThreshold: 72,
      shortTargetAtrMult: 2.2,
      stopAtrMult: 1.15,
      minNetRR: 1.5,
      mediumTargetAtr4hMult: 2.4,
      mediumTargetAtrDayMult: 1.3,
    },
    markets: 4,
    validationMetrics: computeMetrics(trades),
    validationAccuracy: computeAccuracyMetrics(signals),
    promoted: true,
  });
  const bucket = profile.buckets.find((row) => row.minScore === 78)!;
  if (bucket.samples !== 24) throw new Error(`unexpected samples ${bucket.samples}`);
  if (!(bucket.targetHitRate > 0.5 && bucket.targetHitRate < 0.8)) {
    throw new Error(`unexpected smoothed hit rate ${bucket.targetHitRate}`);
  }
  if (!(bucket.returnScale >= 0.35 && bucket.returnScale <= 1.25)) {
    throw new Error(`return scale out of bounds ${bucket.returnScale}`);
  }
  if (!(bucket.returnScaleLow <= bucket.returnScale && bucket.returnScaleHigh >= bucket.returnScale)) {
    throw new Error("forecast interval scales are not ordered");
  }
  const source = profileToTypeScript(profile);
  if (!source.includes("ACTIVE_CALIBRATION_PROFILE") || !source.includes("promoted: true") || !source.includes("returnScaleLow")) {
    throw new Error("serialized profile is incomplete");
  }
});

Deno.test("calibration creates stable market and horizon segments with recency weighting", () => {
  const now = Date.UTC(2026, 6, 24);
  const signals = Array.from({ length: 48 }, (_, index) => ({
    ...signal(80 + index % 4, index >= 12),
    market: "KRW-SEGMENT",
    signalTime: now - (47 - index) * 86_400_000,
    horizonCode: "SHORT" as const,
  }));
  const trades = [trade(true), trade(true), trade(false)];
  const profile = buildCalibrationProfile({
    signals,
    parameters: {
      scoreThreshold: 72,
      shortTargetAtrMult: 2.2,
      stopAtrMult: 1.15,
      minNetRR: 1.5,
      mediumTargetAtr4hMult: 2.4,
      mediumTargetAtrDayMult: 1.3,
    },
    markets: 1,
    validationMetrics: computeMetrics(trades),
    validationAccuracy: computeAccuracyMetrics(signals),
    promoted: true,
    rollingFoldsPassed: 3,
    rollingFoldsTotal: 3,
  });
  if (profile.schemaVersion !== 2) throw new Error("schema must be v2");
  if (profile.validation.rollingFoldsPassed !== 3) throw new Error("rolling fold evidence missing");
  if (!profile.segments.some((row) => row.key === "MARKET:KRW-SEGMENT")) {
    throw new Error("market segment missing");
  }
  if (!profile.segments.some((row) => row.key === "HORIZON:SHORT")) {
    throw new Error("horizon segment missing");
  }
  const bucket = profile.buckets.find((row) => row.minScore === 78)!;
  if (!(bucket.effectiveSamples > 0 && bucket.effectiveSamples <= bucket.samples)) {
    throw new Error("invalid effective sample size");
  }
});
