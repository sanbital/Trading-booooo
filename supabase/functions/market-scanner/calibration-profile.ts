// Trading-booooo v2.6.0 — generated/active calibration profile.
//
// The weekly walk-forward workflow may replace this file only when the candidate
// profile passes minimum sample, positive expectancy, Profit Factor and forecast
// error guardrails on the validation window. HOLDOUT results are reported but are
// never used to choose the profile.

export type CalibrationBucket = {
  minScore: number;
  maxScore: number;
  samples: number;
  targetHitRate: number;
  waitEntryRate: number;
  returnScale: number;
  returnScaleLow: number;
  returnScaleHigh: number;
  mfeMedianPct: number;
  maeMedianPct: number;
};

export type CalibrationProfile = {
  schemaVersion: 1;
  engineVersion: string;
  generatedAt: string;
  source: "DEFAULT_PRIOR" | "WALK_FORWARD";
  promoted: boolean;
  samples: number;
  markets: number;
  validation: {
    trades: number;
    expectancyPct: number;
    profitFactor: number;
    forecastMaePct: number;
    maxDrawdownPct: number;
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
};

// Conservative Bayesian priors. These are deliberately broad and are not
// presented as measured probabilities until a promoted walk-forward profile exists.
export const ACTIVE_CALIBRATION_PROFILE: CalibrationProfile = {
  schemaVersion: 1,
  engineVersion: "2.6.0",
  generatedAt: "2026-07-24T00:00:00.000Z",
  source: "DEFAULT_PRIOR",
  promoted: false,
  samples: 0,
  markets: 0,
  validation: {
    trades: 0,
    expectancyPct: 0,
    profitFactor: 0,
    forecastMaePct: 0,
    maxDrawdownPct: 0,
  },
  parameters: {
    scoreThreshold: 72,
    shortTargetAtrMult: 2.2,
    stopAtrMult: 1.15,
    minNetRR: 1.5,
    mediumTargetAtr4hMult: 2.4,
    mediumTargetAtrDayMult: 1.3,
  },
  buckets: [
    { minScore: 0, maxScore: 59.999, samples: 0, targetHitRate: 0.38, waitEntryRate: 0.28, returnScale: 0.62, returnScaleLow: 0.40, returnScaleHigh: 0.86, mfeMedianPct: 0, maeMedianPct: 0 },
    { minScore: 60, maxScore: 69.999, samples: 0, targetHitRate: 0.46, waitEntryRate: 0.34, returnScale: 0.72, returnScaleLow: 0.48, returnScaleHigh: 0.98, mfeMedianPct: 0, maeMedianPct: 0 },
    { minScore: 70, maxScore: 77.999, samples: 0, targetHitRate: 0.54, waitEntryRate: 0.41, returnScale: 0.82, returnScaleLow: 0.56, returnScaleHigh: 1.08, mfeMedianPct: 0, maeMedianPct: 0 },
    { minScore: 78, maxScore: 84.999, samples: 0, targetHitRate: 0.61, waitEntryRate: 0.48, returnScale: 0.90, returnScaleLow: 0.62, returnScaleHigh: 1.16, mfeMedianPct: 0, maeMedianPct: 0 },
    { minScore: 85, maxScore: 100, samples: 0, targetHitRate: 0.67, waitEntryRate: 0.54, returnScale: 0.96, returnScaleLow: 0.68, returnScaleHigh: 1.22, mfeMedianPct: 0, maeMedianPct: 0 },
  ],
};

export function calibrationBucket(score: number): CalibrationBucket {
  return ACTIVE_CALIBRATION_PROFILE.buckets.find((bucket) =>
    score >= bucket.minScore && score <= bucket.maxScore
  ) || ACTIVE_CALIBRATION_PROFILE.buckets.at(-1)!;
}
