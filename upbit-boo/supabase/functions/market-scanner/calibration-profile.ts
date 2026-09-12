// Trading-booooo v5.2.0 — active self-calibration profile.
//
// The weekly walk-forward workflow may replace this file only when a challenger
// passes rolling validation guards. HOLDOUT data is monitoring-only and never
// participates in parameter selection or promotion.

export type CalibrationBucket = {
  minScore: number;
  maxScore: number;
  samples: number;
  effectiveSamples: number;
  targetHitRate: number;
  waitEntryRate: number;
  returnScale: number;
  returnScaleLow: number;
  returnScaleHigh: number;
  mfeMedianPct: number;
  maeMedianPct: number;
};

export type CalibrationSegment = {
  key: string;
  kind: "MARKET" | "HORIZON";
  samples: number;
  buckets: CalibrationBucket[];
};

export type CalibrationProfile = {
  schemaVersion: 2;
  engineVersion: string;
  generatedAt: string;
  source: "DEFAULT_PRIOR" | "WALK_FORWARD";
  promoted: boolean;
  samples: number;
  markets: number;
  recencyHalfLifeDays: number;
  validation: {
    trades: number;
    expectancyPct: number;
    profitFactor: number;
    forecastMaePct: number;
    maxDrawdownPct: number;
    rollingFoldsPassed: number;
    rollingFoldsTotal: number;
  };
  parameters: {
    scoreThreshold: number;
    shortTargetAtrMult: number;
    stopAtrMult: number;
    minNetRR: number;
    mediumTargetAtr4hMult: number;
    mediumTargetAtrDayMult: number;
  };
  buckets: CalibrationBucket[];
  segments: CalibrationSegment[];
};

const DEFAULT_BUCKETS: CalibrationBucket[] = [
  { minScore: 0, maxScore: 59.999, samples: 0, effectiveSamples: 0, targetHitRate: 0.38, waitEntryRate: 0.28, returnScale: 0.62, returnScaleLow: 0.40, returnScaleHigh: 0.86, mfeMedianPct: 0, maeMedianPct: 0 },
  { minScore: 60, maxScore: 69.999, samples: 0, effectiveSamples: 0, targetHitRate: 0.46, waitEntryRate: 0.34, returnScale: 0.72, returnScaleLow: 0.48, returnScaleHigh: 0.98, mfeMedianPct: 0, maeMedianPct: 0 },
  { minScore: 70, maxScore: 77.999, samples: 0, effectiveSamples: 0, targetHitRate: 0.54, waitEntryRate: 0.41, returnScale: 0.82, returnScaleLow: 0.56, returnScaleHigh: 1.08, mfeMedianPct: 0, maeMedianPct: 0 },
  { minScore: 78, maxScore: 84.999, samples: 0, effectiveSamples: 0, targetHitRate: 0.61, waitEntryRate: 0.48, returnScale: 0.90, returnScaleLow: 0.62, returnScaleHigh: 1.16, mfeMedianPct: 0, maeMedianPct: 0 },
  { minScore: 85, maxScore: 100, samples: 0, effectiveSamples: 0, targetHitRate: 0.67, waitEntryRate: 0.54, returnScale: 0.96, returnScaleLow: 0.68, returnScaleHigh: 1.22, mfeMedianPct: 0, maeMedianPct: 0 },
];

export const ACTIVE_CALIBRATION_PROFILE: CalibrationProfile = {
  schemaVersion: 2,
  engineVersion: "5.2.0",
  generatedAt: "2026-07-24T00:00:00.000Z",
  source: "DEFAULT_PRIOR",
  promoted: false,
  samples: 0,
  markets: 0,
  recencyHalfLifeDays: 45,
  validation: {
    trades: 0,
    expectancyPct: 0,
    profitFactor: 0,
    forecastMaePct: 0,
    maxDrawdownPct: 0,
    rollingFoldsPassed: 0,
    rollingFoldsTotal: 0,
  },
  parameters: {
    scoreThreshold: 72,
    shortTargetAtrMult: 2.2,
    stopAtrMult: 1.15,
    minNetRR: 1.5,
    mediumTargetAtr4hMult: 2.4,
    mediumTargetAtrDayMult: 1.3,
  },
  buckets: DEFAULT_BUCKETS,
  segments: [],
};

function findBucket(buckets: CalibrationBucket[], score: number): CalibrationBucket {
  return buckets.find((bucket) => score >= bucket.minScore && score <= bucket.maxScore) ||
    buckets.at(-1)!;
}

/**
 * Resolve the most specific stable calibration available:
 * market → holding horizon → global score bucket.
 * Sparse segments are ignored so a few lucky trades cannot distort forecasts.
 */
export function calibrationBucket(
  score: number,
  market?: string,
  horizonCode?: string,
): CalibrationBucket {
  const candidates = [
    market ? `MARKET:${market}` : null,
    horizonCode ? `HORIZON:${horizonCode}` : null,
  ].filter((value): value is string => Boolean(value));
  for (const key of candidates) {
    const segment = ACTIVE_CALIBRATION_PROFILE.segments.find((row) => row.key === key);
    if (!segment || segment.samples < 30) continue;
    const bucket = findBucket(segment.buckets, score);
    if (bucket.samples >= 12 && bucket.effectiveSamples >= 8) return bucket;
  }
  return findBucket(ACTIVE_CALIBRATION_PROFILE.buckets, score);
}
