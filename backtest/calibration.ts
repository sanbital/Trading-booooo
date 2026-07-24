import type {
  CalibrationBucket,
  CalibrationProfile,
} from "../supabase/functions/market-scanner/calibration-profile.ts";
import { ENGINE_VERSION, type RiskConfig } from "../supabase/functions/market-scanner/engine.ts";
import type { SignalEvaluation } from "./simulate.ts";
import type { AccuracyMetrics, Metrics } from "./metrics.ts";

const BUCKETS = [
  [0, 59.999],
  [60, 69.999],
  [70, 77.999],
  [78, 84.999],
  [85, 100],
] as const;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

export function buildCalibrationProfile(args: {
  signals: SignalEvaluation[];
  parameters: Required<Pick<RiskConfig,
    | "scoreThreshold"
    | "shortTargetAtrMult"
    | "stopAtrMult"
    | "minNetRR"
    | "mediumTargetAtr4hMult"
    | "mediumTargetAtrDayMult"
  >>;
  markets: number;
  validationMetrics: Metrics;
  validationAccuracy: AccuracyMetrics;
  promoted: boolean;
}): CalibrationProfile {
  const entered = args.signals.filter((signal) => signal.entryStatus === "ENTERED");
  const globalHit = entered.length
    ? entered.filter((signal) => signal.outcome === "TARGET_FIRST").length / entered.length
    : 0.5;
  const waitSignals = args.signals.filter((signal) => signal.decision === "WAIT");
  const globalWaitEntry = waitSignals.length
    ? waitSignals.filter((signal) => signal.entryStatus === "ENTERED").length / waitSignals.length
    : 0.35;
  const ratios = entered.flatMap((signal) => {
    const rawPredicted = Number(signal.rawPredictedUpsidePct);
    const mfe = Number(signal.maxFavorableExcursionPct);
    return rawPredicted > 0 && Number.isFinite(mfe) ? [mfe / rawPredicted] : [];
  });
  const globalScale = clamp(median(ratios) || 0.78, 0.35, 1.25);
  const globalScaleLow = clamp(quantile(ratios, 0.25) || globalScale * 0.68, 0.2, 1.1);
  const globalScaleHigh = clamp(quantile(ratios, 0.75) || globalScale * 1.32, 0.45, 1.6);

  const buckets: CalibrationBucket[] = BUCKETS.map(([minScore, maxScore]) => {
    const all = args.signals.filter((signal) =>
      signal.score >= minScore && signal.score <= maxScore
    );
    const enteredBucket = all.filter((signal) => signal.entryStatus === "ENTERED");
    const waits = all.filter((signal) => signal.decision === "WAIT");
    const hits = enteredBucket.filter((signal) => signal.outcome === "TARGET_FIRST").length;
    const waitEntries = waits.filter((signal) => signal.entryStatus === "ENTERED").length;
    const bucketRatios = enteredBucket.flatMap((signal) => {
      const rawPredicted = Number(signal.rawPredictedUpsidePct);
      const mfe = Number(signal.maxFavorableExcursionPct);
      return rawPredicted > 0 && Number.isFinite(mfe) ? [mfe / rawPredicted] : [];
    });
    const priorN = 20;
    const hitRate = (hits + globalHit * priorN) / (enteredBucket.length + priorN);
    const waitEntryRate = (waitEntries + globalWaitEntry * priorN) /
      (waits.length + priorN);
    const observedScale = median(bucketRatios);
    const scaleWeight = bucketRatios.length / (bucketRatios.length + priorN);
    const returnScale = clamp(
      observedScale * scaleWeight + globalScale * (1 - scaleWeight),
      0.35,
      1.25,
    );
    const observedLow = quantile(bucketRatios, 0.25);
    const observedHigh = quantile(bucketRatios, 0.75);
    const returnScaleLow = clamp(
      (observedLow || returnScale * 0.68) * scaleWeight +
        globalScaleLow * (1 - scaleWeight),
      0.2,
      returnScale,
    );
    const returnScaleHigh = clamp(
      (observedHigh || returnScale * 1.32) * scaleWeight +
        globalScaleHigh * (1 - scaleWeight),
      returnScale,
      1.6,
    );
    return {
      minScore,
      maxScore,
      samples: enteredBucket.length,
      targetHitRate: clamp(hitRate, 0.08, 0.9),
      waitEntryRate: clamp(waitEntryRate, 0.05, 0.85),
      returnScale,
      returnScaleLow,
      returnScaleHigh,
      mfeMedianPct: median(enteredBucket.flatMap((signal) =>
        signal.maxFavorableExcursionPct == null ? [] : [signal.maxFavorableExcursionPct]
      )),
      maeMedianPct: median(enteredBucket.flatMap((signal) =>
        signal.maxAdverseExcursionPct == null ? [] : [signal.maxAdverseExcursionPct]
      )),
    };
  });

  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    source: "WALK_FORWARD",
    promoted: args.promoted,
    samples: entered.length,
    markets: args.markets,
    validation: {
      trades: args.validationMetrics.trades,
      expectancyPct: args.validationMetrics.expectancyPct,
      profitFactor: args.validationMetrics.profitFactor,
      forecastMaePct: args.validationMetrics.forecastMaePct,
      maxDrawdownPct: args.validationMetrics.maxDrawdownPct,
    },
    parameters: args.parameters,
    buckets,
  };
}

function n(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "0";
  return Number(value.toFixed(8)).toString();
}

export function profileToTypeScript(profile: CalibrationProfile): string {
  const bucketLines = profile.buckets.map((bucket) =>
    `    { minScore: ${n(bucket.minScore)}, maxScore: ${n(bucket.maxScore)}, samples: ${bucket.samples}, targetHitRate: ${n(bucket.targetHitRate)}, waitEntryRate: ${n(bucket.waitEntryRate)}, returnScale: ${n(bucket.returnScale)}, returnScaleLow: ${n(bucket.returnScaleLow)}, returnScaleHigh: ${n(bucket.returnScaleHigh)}, mfeMedianPct: ${n(bucket.mfeMedianPct)}, maeMedianPct: ${n(bucket.maeMedianPct)} },`
  ).join("\n");
  return `// AUTO-GENERATED by backtest/calibrate.ts. Do not hand-edit measured values.\n\nexport type CalibrationBucket = {\n  minScore: number;\n  maxScore: number;\n  samples: number;\n  targetHitRate: number;\n  waitEntryRate: number;\n  returnScale: number;\n  returnScaleLow: number;\n  returnScaleHigh: number;\n  mfeMedianPct: number;\n  maeMedianPct: number;\n};\n\nexport type CalibrationProfile = {\n  schemaVersion: 1;\n  engineVersion: string;\n  generatedAt: string;\n  source: \"DEFAULT_PRIOR\" | \"WALK_FORWARD\";\n  promoted: boolean;\n  samples: number;\n  markets: number;\n  validation: { trades: number; expectancyPct: number; profitFactor: number; forecastMaePct: number; maxDrawdownPct: number };\n  parameters: { scoreThreshold: number; shortTargetAtrMult: number; stopAtrMult: number; minNetRR: number; mediumTargetAtr4hMult: number; mediumTargetAtrDayMult: number };\n  buckets: CalibrationBucket[];\n};\n\nexport const ACTIVE_CALIBRATION_PROFILE: CalibrationProfile = {\n  schemaVersion: 1,\n  engineVersion: ${JSON.stringify(profile.engineVersion)},\n  generatedAt: ${JSON.stringify(profile.generatedAt)},\n  source: ${JSON.stringify(profile.source)},\n  promoted: ${profile.promoted},\n  samples: ${profile.samples},\n  markets: ${profile.markets},\n  validation: { trades: ${profile.validation.trades}, expectancyPct: ${n(profile.validation.expectancyPct)}, profitFactor: ${n(profile.validation.profitFactor)}, forecastMaePct: ${n(profile.validation.forecastMaePct)}, maxDrawdownPct: ${n(profile.validation.maxDrawdownPct)} },\n  parameters: { scoreThreshold: ${n(profile.parameters.scoreThreshold)}, shortTargetAtrMult: ${n(profile.parameters.shortTargetAtrMult)}, stopAtrMult: ${n(profile.parameters.stopAtrMult)}, minNetRR: ${n(profile.parameters.minNetRR)}, mediumTargetAtr4hMult: ${n(profile.parameters.mediumTargetAtr4hMult)}, mediumTargetAtrDayMult: ${n(profile.parameters.mediumTargetAtrDayMult)} },\n  buckets: [\n${bucketLines}\n  ],\n};\n\nexport function calibrationBucket(score: number): CalibrationBucket {\n  return ACTIVE_CALIBRATION_PROFILE.buckets.find((bucket) => score >= bucket.minScore && score <= bucket.maxScore) || ACTIVE_CALIBRATION_PROFILE.buckets.at(-1)!;\n}\n`;
}
