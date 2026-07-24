import type {
  CalibrationBucket,
  CalibrationProfile,
  CalibrationSegment,
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

export const RECENCY_HALF_LIFE_DAYS = 45;
const DAY_MS = 86_400_000;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

function weightAt(signalTime: number, newestTime: number): number {
  const ageDays = Math.max(0, newestTime - signalTime) / DAY_MS;
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

function weightedMean(rows: Array<{ value: number; weight: number }>): number {
  const valid = rows.filter((row) => Number.isFinite(row.value) && row.weight > 0);
  const total = valid.reduce((sum, row) => sum + row.weight, 0);
  return total ? valid.reduce((sum, row) => sum + row.value * row.weight, 0) / total : 0;
}

function weightedQuantile(
  rows: Array<{ value: number; weight: number }>,
  q: number,
): number {
  const sorted = rows.filter((row) => Number.isFinite(row.value) && row.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return 0;
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  const target = total * clamp(q, 0, 1);
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight;
    if (cumulative >= target) return row.value;
  }
  return sorted.at(-1)!.value;
}

function effectiveSampleSize(weights: number[]): number {
  const sum = weights.reduce((total, value) => total + value, 0);
  const squared = weights.reduce((total, value) => total + value * value, 0);
  return squared > 0 ? (sum * sum) / squared : 0;
}

function bucketFromSignals(args: {
  signals: SignalEvaluation[];
  minScore: number;
  maxScore: number;
  newestTime: number;
  prior: CalibrationBucket;
  priorStrength: number;
}): CalibrationBucket {
  const all = args.signals.filter((signal) =>
    signal.score >= args.minScore && signal.score <= args.maxScore
  );
  const entered = all.filter((signal) => signal.entryStatus === "ENTERED");
  const waits = all.filter((signal) => signal.decision === "WAIT");
  const enteredWeights = entered.map((signal) => weightAt(signal.signalTime, args.newestTime));
  const waitWeights = waits.map((signal) => weightAt(signal.signalTime, args.newestTime));
  const hitRows = entered.map((signal, index) => ({
    value: signal.outcome === "TARGET_FIRST" ? 1 : 0,
    weight: enteredWeights[index],
  }));
  const waitEntryRows = waits.map((signal, index) => ({
    value: signal.entryStatus === "ENTERED" ? 1 : 0,
    weight: waitWeights[index],
  }));
  const ratioRows = entered.flatMap((signal, index) => {
    const raw = Number(signal.rawPredictedUpsidePct);
    const mfe = Number(signal.maxFavorableExcursionPct);
    return raw > 0 && Number.isFinite(mfe)
      ? [{ value: mfe / raw, weight: enteredWeights[index] }]
      : [];
  });
  const enteredWeight = enteredWeights.reduce((sum, value) => sum + value, 0);
  const waitWeight = waitWeights.reduce((sum, value) => sum + value, 0);
  const ratioWeight = ratioRows.reduce((sum, row) => sum + row.weight, 0);
  const hitRate = (
    weightedMean(hitRows) * enteredWeight + args.prior.targetHitRate * args.priorStrength
  ) / Math.max(1e-9, enteredWeight + args.priorStrength);
  const waitEntryRate = (
    weightedMean(waitEntryRows) * waitWeight + args.prior.waitEntryRate * args.priorStrength
  ) / Math.max(1e-9, waitWeight + args.priorStrength);
  const observedScale = weightedQuantile(ratioRows, 0.5) || args.prior.returnScale;
  const scaleWeight = ratioWeight / (ratioWeight + args.priorStrength);
  const returnScale = clamp(
    observedScale * scaleWeight + args.prior.returnScale * (1 - scaleWeight),
    0.35,
    1.25,
  );
  const observedLow = weightedQuantile(ratioRows, 0.25) || args.prior.returnScaleLow;
  const observedHigh = weightedQuantile(ratioRows, 0.75) || args.prior.returnScaleHigh;
  const returnScaleLow = clamp(
    observedLow * scaleWeight + args.prior.returnScaleLow * (1 - scaleWeight),
    0.2,
    returnScale,
  );
  const returnScaleHigh = clamp(
    observedHigh * scaleWeight + args.prior.returnScaleHigh * (1 - scaleWeight),
    returnScale,
    1.6,
  );
  const mfeRows = entered.flatMap((signal, index) =>
    signal.maxFavorableExcursionPct == null
      ? []
      : [{ value: signal.maxFavorableExcursionPct, weight: enteredWeights[index] }]
  );
  const maeRows = entered.flatMap((signal, index) =>
    signal.maxAdverseExcursionPct == null
      ? []
      : [{ value: signal.maxAdverseExcursionPct, weight: enteredWeights[index] }]
  );
  return {
    minScore: args.minScore,
    maxScore: args.maxScore,
    samples: entered.length,
    effectiveSamples: effectiveSampleSize(enteredWeights),
    targetHitRate: clamp(hitRate, 0.08, 0.9),
    waitEntryRate: clamp(waitEntryRate, 0.05, 0.85),
    returnScale,
    returnScaleLow,
    returnScaleHigh,
    mfeMedianPct: weightedQuantile(mfeRows, 0.5),
    maeMedianPct: weightedQuantile(maeRows, 0.5),
  };
}

function buildBuckets(
  signals: SignalEvaluation[],
  newestTime: number,
  priors: CalibrationBucket[],
  priorStrength: number,
): CalibrationBucket[] {
  return BUCKETS.map(([minScore, maxScore], index) =>
    bucketFromSignals({
      signals,
      minScore,
      maxScore,
      newestTime,
      prior: priors[index],
      priorStrength,
    })
  );
}

function defaultPrior(minScore: number, maxScore: number): CalibrationBucket {
  const normalized = clamp((minScore + maxScore) / 2 / 100, 0, 1);
  const scale = clamp(0.5 + normalized * 0.52, 0.55, 0.98);
  return {
    minScore,
    maxScore,
    samples: 0,
    effectiveSamples: 0,
    targetHitRate: clamp(0.28 + normalized * 0.46, 0.32, 0.68),
    waitEntryRate: clamp(0.2 + normalized * 0.4, 0.25, 0.55),
    returnScale: scale,
    returnScaleLow: scale * 0.68,
    returnScaleHigh: Math.min(1.25, scale * 1.28),
    mfeMedianPct: 0,
    maeMedianPct: 0,
  };
}

function segment(
  key: string,
  kind: CalibrationSegment["kind"],
  signals: SignalEvaluation[],
  newestTime: number,
  globalBuckets: CalibrationBucket[],
): CalibrationSegment {
  const entered = signals.filter((signal) => signal.entryStatus === "ENTERED");
  return {
    key,
    kind,
    samples: entered.length,
    // Strong shrinkage toward global behavior prevents sparse market profiles
    // from overreacting to a few exceptional trades.
    buckets: buildBuckets(signals, newestTime, globalBuckets, 30),
  };
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
  rollingFoldsPassed?: number;
  rollingFoldsTotal?: number;
}): CalibrationProfile {
  const newestTime = Math.max(0, ...args.signals.map((signal) => signal.signalTime));
  const priors = BUCKETS.map(([minScore, maxScore]) => defaultPrior(minScore, maxScore));
  const buckets = buildBuckets(args.signals, newestTime, priors, 20);
  const segments: CalibrationSegment[] = [];
  const markets = [...new Set(args.signals.map((signal) => signal.market))];
  for (const market of markets) {
    const rows = args.signals.filter((signal) => signal.market === market);
    if (rows.filter((signal) => signal.entryStatus === "ENTERED").length >= 30) {
      segments.push(segment(`MARKET:${market}`, "MARKET", rows, newestTime, buckets));
    }
  }
  const horizons = [...new Set(args.signals.map((signal) => signal.horizonCode))];
  for (const horizon of horizons) {
    const rows = args.signals.filter((signal) => signal.horizonCode === horizon);
    if (rows.filter((signal) => signal.entryStatus === "ENTERED").length >= 30) {
      segments.push(segment(`HORIZON:${horizon}`, "HORIZON", rows, newestTime, buckets));
    }
  }
  const entered = args.signals.filter((signal) => signal.entryStatus === "ENTERED");
  return {
    schemaVersion: 2,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    source: "WALK_FORWARD",
    promoted: args.promoted,
    samples: entered.length,
    markets: args.markets,
    recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
    validation: {
      trades: args.validationMetrics.trades,
      expectancyPct: args.validationMetrics.expectancyPct,
      profitFactor: args.validationMetrics.profitFactor,
      forecastMaePct: args.validationMetrics.forecastMaePct,
      maxDrawdownPct: args.validationMetrics.maxDrawdownPct,
      rollingFoldsPassed: args.rollingFoldsPassed ?? 0,
      rollingFoldsTotal: args.rollingFoldsTotal ?? 0,
    },
    parameters: args.parameters,
    buckets,
    segments,
  };
}

function n(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "0";
  return Number(value.toFixed(8)).toString();
}

function bucketSource(bucket: CalibrationBucket): string {
  return `{ minScore: ${n(bucket.minScore)}, maxScore: ${n(bucket.maxScore)}, samples: ${bucket.samples}, effectiveSamples: ${n(bucket.effectiveSamples)}, targetHitRate: ${n(bucket.targetHitRate)}, waitEntryRate: ${n(bucket.waitEntryRate)}, returnScale: ${n(bucket.returnScale)}, returnScaleLow: ${n(bucket.returnScaleLow)}, returnScaleHigh: ${n(bucket.returnScaleHigh)}, mfeMedianPct: ${n(bucket.mfeMedianPct)}, maeMedianPct: ${n(bucket.maeMedianPct)} }`;
}

export function profileToTypeScript(profile: CalibrationProfile): string {
  const bucketLines = profile.buckets.map((bucket) => `    ${bucketSource(bucket)},`).join("\n");
  const segmentLines = profile.segments.map((row) => {
    const buckets = row.buckets.map((bucket) => `        ${bucketSource(bucket)},`).join("\n");
    return `    { key: ${JSON.stringify(row.key)}, kind: ${JSON.stringify(row.kind)}, samples: ${row.samples}, buckets: [\n${buckets}\n      ] },`;
  }).join("\n");
  return `// AUTO-GENERATED by backtest/calibrate.ts. Do not hand-edit measured values.\n\nexport type CalibrationBucket = { minScore: number; maxScore: number; samples: number; effectiveSamples: number; targetHitRate: number; waitEntryRate: number; returnScale: number; returnScaleLow: number; returnScaleHigh: number; mfeMedianPct: number; maeMedianPct: number };\nexport type CalibrationSegment = { key: string; kind: \"MARKET\" | \"HORIZON\"; samples: number; buckets: CalibrationBucket[] };\nexport type CalibrationProfile = { schemaVersion: 2; engineVersion: string; generatedAt: string; source: \"DEFAULT_PRIOR\" | \"WALK_FORWARD\"; promoted: boolean; samples: number; markets: number; recencyHalfLifeDays: number; validation: { trades: number; expectancyPct: number; profitFactor: number; forecastMaePct: number; maxDrawdownPct: number; rollingFoldsPassed: number; rollingFoldsTotal: number }; parameters: { scoreThreshold: number; shortTargetAtrMult: number; stopAtrMult: number; minNetRR: number; mediumTargetAtr4hMult: number; mediumTargetAtrDayMult: number }; buckets: CalibrationBucket[]; segments: CalibrationSegment[] };\n\nexport const ACTIVE_CALIBRATION_PROFILE: CalibrationProfile = {\n  schemaVersion: 2,\n  engineVersion: ${JSON.stringify(profile.engineVersion)},\n  generatedAt: ${JSON.stringify(profile.generatedAt)},\n  source: ${JSON.stringify(profile.source)},\n  promoted: ${profile.promoted},\n  samples: ${profile.samples},\n  markets: ${profile.markets},\n  recencyHalfLifeDays: ${n(profile.recencyHalfLifeDays)},\n  validation: { trades: ${profile.validation.trades}, expectancyPct: ${n(profile.validation.expectancyPct)}, profitFactor: ${n(profile.validation.profitFactor)}, forecastMaePct: ${n(profile.validation.forecastMaePct)}, maxDrawdownPct: ${n(profile.validation.maxDrawdownPct)}, rollingFoldsPassed: ${profile.validation.rollingFoldsPassed}, rollingFoldsTotal: ${profile.validation.rollingFoldsTotal} },\n  parameters: { scoreThreshold: ${n(profile.parameters.scoreThreshold)}, shortTargetAtrMult: ${n(profile.parameters.shortTargetAtrMult)}, stopAtrMult: ${n(profile.parameters.stopAtrMult)}, minNetRR: ${n(profile.parameters.minNetRR)}, mediumTargetAtr4hMult: ${n(profile.parameters.mediumTargetAtr4hMult)}, mediumTargetAtrDayMult: ${n(profile.parameters.mediumTargetAtrDayMult)} },\n  buckets: [\n${bucketLines}\n  ],\n  segments: [\n${segmentLines}\n  ],\n};\n\nfunction findBucket(buckets: CalibrationBucket[], score: number): CalibrationBucket { return buckets.find((bucket) => score >= bucket.minScore && score <= bucket.maxScore) || buckets.at(-1)!; }\nexport function calibrationBucket(score: number, market?: string, horizonCode?: string): CalibrationBucket {\n  const keys = [market ? \`MARKET:\${market}\` : null, horizonCode ? \`HORIZON:\${horizonCode}\` : null].filter((value): value is string => Boolean(value));\n  for (const key of keys) { const segment = ACTIVE_CALIBRATION_PROFILE.segments.find((row) => row.key === key); if (!segment || segment.samples < 30) continue; const bucket = findBucket(segment.buckets, score); if (bucket.samples >= 12 && bucket.effectiveSamples >= 8) return bucket; }\n  return findBucket(ACTIVE_CALIBRATION_PROFILE.buckets, score);\n}\n`;
}
