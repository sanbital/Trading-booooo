// Scalp pWin calibration (v5.3).
//
// WHY
// ---
// `signal.ts` builds pWin from hand-chosen constants: a 0.52 base rate plus weights of
// 0.18 / 0.12 / 0.08 / 0.10 on imbalance, trade pressure, stability and breakout. None of
// those numbers came from data. The existing forward-learning loop does not help: its
// LearningParameters are scoreThreshold / minNetRR / shortTargetAtrMult / stopAtrMult —
// all TREND parameters — and its candidate query filters on `period_score` and `net_rr`,
// which SCALP never gates on. It promotes profiles that the scalp path does not read.
//
// So the scalp probability model has never been measured against a realized outcome.
// Until it is, "raise the win rate" is not a checkable statement.
//
// WHAT THIS DOES
// --------------
// Platt scaling on the model's own output:
//
//     p_calibrated = sigmoid(a * logit(p_raw) + b)
//
// a = 1, b = 0 is the identity, i.e. "the model is already calibrated". Fitting a and b
// on realized outcomes corrects the two failure modes that matter here:
//   - systematic overconfidence (a < 1 pulls extremes toward the base rate)
//   - a wrong base rate (b shifts everything)
//
// One feature and two parameters is deliberate. A richer model over the raw features
// would overfit badly at the sample counts this system will realistically produce.
//
// SHRINKAGE
// ---------
// The fit is blended toward the identity with weight n / (n + priorStrength), so early
// profiles barely move and the model earns influence as samples accumulate. Without this
// a 200-sample fit would swing the live probability model hard on noise.
//
// Pure functions only — no I/O.

export interface CalibrationSample {
  /** pWin the model predicted at order time. */
  predicted: number;
  /** 1 when the first target was reached, 0 when the stop resolved first. */
  outcome: 0 | 1;
}

export interface CalibrationModel {
  a: number;
  b: number;
  samples: number;
  /** Brier score on the data the model was scored against (lower is better). */
  brier: number;
  logLoss: number;
  /** Mean predicted probability vs mean realized rate — the headline miscalibration. */
  meanPredicted: number;
  meanRealized: number;
}

export const IDENTITY_CALIBRATION: CalibrationModel = {
  a: 1,
  b: 0,
  samples: 0,
  brier: Number.POSITIVE_INFINITY,
  logLoss: Number.POSITIVE_INFINITY,
  meanPredicted: 0,
  meanRealized: 0,
};

export interface CalibrationFitConfig {
  /** Sample count at which the fit carries half its weight against the identity. */
  priorStrength: number;
  /** Minimum samples before a profile may be promoted at all. */
  minSamples: number;
  /** Fraction of samples held out for scoring. */
  holdoutFraction: number;
  /** Required Brier improvement over the incumbent before promotion. */
  minBrierImprovement: number;
  iterations: number;
  learningRate: number;
  /** Hard bounds on the fitted slope, so one bad batch cannot invert the model. */
  minSlope: number;
  maxSlope: number;
  maxIntercept: number;
}

export const DEFAULT_CALIBRATION_FIT: CalibrationFitConfig = {
  // 300, not 100: at the sample counts this system produces, a fit must not be allowed to
  // swing the live probability model. n=300 is where the fit first carries half the weight.
  priorStrength: 300,
  minSamples: 200,
  holdoutFraction: 0.3,
  minBrierImprovement: 0.002,
  iterations: 400,
  learningRate: 0.08,
  minSlope: 0.25,
  maxSlope: 2.5,
  maxIntercept: 1.5,
};

const EPS = 1e-6;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function logit(p: number): number {
  const q = clamp(p, EPS, 1 - EPS);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function applyCalibration(pRaw: number, model: CalibrationModel): number {
  if (!Number.isFinite(pRaw)) return pRaw;
  const a = Number.isFinite(model.a) ? model.a : 1;
  const b = Number.isFinite(model.b) ? model.b : 0;
  return clamp(sigmoid(a * logit(pRaw) + b), EPS, 1 - EPS);
}

export function brierScore(samples: CalibrationSample[], model: CalibrationModel): number {
  if (!samples.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const s of samples) {
    const p = applyCalibration(s.predicted, model);
    total += (p - s.outcome) ** 2;
  }
  return total / samples.length;
}

export function logLoss(samples: CalibrationSample[], model: CalibrationModel): number {
  if (!samples.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const s of samples) {
    const p = clamp(applyCalibration(s.predicted, model), EPS, 1 - EPS);
    total += s.outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return total / samples.length;
}

/** Gradient descent on log loss for the two Platt parameters. */
function fitRaw(samples: CalibrationSample[], cfg: CalibrationFitConfig): { a: number; b: number } {
  let a = 1;
  let b = 0;
  if (!samples.length) return { a, b };
  const xs = samples.map((s) => logit(s.predicted));
  for (let iter = 0; iter < cfg.iterations; iter++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < samples.length; i++) {
      const err = sigmoid(a * xs[i] + b) - samples[i].outcome;
      ga += err * xs[i];
      gb += err;
    }
    a -= cfg.learningRate * ga / samples.length;
    b -= cfg.learningRate * gb / samples.length;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0 };
  }
  return { a, b };
}

/**
 * Fit a calibration on `samples`, shrunk toward the identity by sample count and clamped
 * to safe bounds. Scoring is left to the caller so it can use a holdout.
 */
export function fitCalibration(
  samples: CalibrationSample[],
  cfg: CalibrationFitConfig = DEFAULT_CALIBRATION_FIT,
): CalibrationModel {
  const clean = samples.filter((s) =>
    Number.isFinite(s.predicted) && s.predicted > 0 && s.predicted < 1 && (s.outcome === 0 || s.outcome === 1)
  );
  if (!clean.length) return { ...IDENTITY_CALIBRATION };

  const raw = fitRaw(clean, cfg);
  // Shrink toward identity: the fit earns influence as evidence accumulates.
  const w = clean.length / (clean.length + cfg.priorStrength);
  const a = clamp(1 + (raw.a - 1) * w, cfg.minSlope, cfg.maxSlope);
  const b = clamp(raw.b * w, -cfg.maxIntercept, cfg.maxIntercept);

  const meanPredicted = clean.reduce((t, s) => t + s.predicted, 0) / clean.length;
  const meanRealized = clean.reduce((t, s) => t + s.outcome, 0) / clean.length;
  const model: CalibrationModel = { a, b, samples: clean.length, brier: 0, logLoss: 0, meanPredicted, meanRealized };
  model.brier = brierScore(clean, model);
  model.logLoss = logLoss(clean, model);
  return model;
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  challenger: CalibrationModel;
  challengerHoldoutBrier: number;
  incumbentHoldoutBrier: number;
  trainSize: number;
  holdoutSize: number;
}

/**
 * Split chronologically (oldest -> train, newest -> holdout), fit on train, and promote
 * only if the challenger beats the incumbent on data it never saw. Chronological rather
 * than random, so a profile cannot be promoted on the strength of future information.
 */
export function evaluatePromotion(
  chronologicalSamples: CalibrationSample[],
  incumbent: CalibrationModel = IDENTITY_CALIBRATION,
  cfg: CalibrationFitConfig = DEFAULT_CALIBRATION_FIT,
): PromotionDecision {
  const clean = chronologicalSamples.filter((s) =>
    Number.isFinite(s.predicted) && s.predicted > 0 && s.predicted < 1 && (s.outcome === 0 || s.outcome === 1)
  );
  const base = {
    challenger: { ...IDENTITY_CALIBRATION },
    challengerHoldoutBrier: Number.POSITIVE_INFINITY,
    incumbentHoldoutBrier: Number.POSITIVE_INFINITY,
    trainSize: 0,
    holdoutSize: 0,
  };
  if (clean.length < cfg.minSamples) {
    return { promote: false, reason: `insufficient_samples:${clean.length}/${cfg.minSamples}`, ...base };
  }
  // Both outcomes must be present or the fit is degenerate.
  const wins = clean.reduce((t, s) => t + s.outcome, 0);
  if (wins === 0 || wins === clean.length) {
    return { promote: false, reason: "degenerate_outcomes", ...base };
  }

  const holdoutSize = Math.max(1, Math.floor(clean.length * cfg.holdoutFraction));
  const trainSize = clean.length - holdoutSize;
  if (trainSize < Math.floor(cfg.minSamples / 2)) {
    return { promote: false, reason: "insufficient_train_split", ...base };
  }
  const train = clean.slice(0, trainSize);
  const holdout = clean.slice(trainSize);

  const challenger = fitCalibration(train, cfg);
  const challengerHoldoutBrier = brierScore(holdout, challenger);
  const incumbentHoldoutBrier = brierScore(holdout, incumbent);
  const result = {
    challenger,
    challengerHoldoutBrier,
    incumbentHoldoutBrier,
    trainSize,
    holdoutSize: holdout.length,
  };
  if (!Number.isFinite(challengerHoldoutBrier)) {
    return { promote: false, reason: "challenger_unscorable", ...result };
  }
  if (challengerHoldoutBrier > incumbentHoldoutBrier - cfg.minBrierImprovement) {
    return { promote: false, reason: "no_material_improvement", ...result };
  }
  return { promote: true, reason: "promoted", ...result };
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  realizedRate: number;
}

/** Reliability diagram data — the honest picture of whether pWin means anything. */
export function reliabilityBins(samples: CalibrationSample[], binCount = 5): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const inBin = samples.filter((s) => s.predicted >= lower && (i === binCount - 1 ? s.predicted <= upper : s.predicted < upper));
    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanPredicted: inBin.length ? inBin.reduce((t, s) => t + s.predicted, 0) / inBin.length : 0,
      realizedRate: inBin.length ? inBin.reduce((t, s) => t + s.outcome, 0) / inBin.length : 0,
    });
  }
  return bins;
}

/**
 * Realized share of positions that reached EITHER barrier, i.e. the empirical counterpart
 * of geometry.ts's modelled `resolveProbability`. Once enough samples exist this replaces
 * the analytic approximation.
 */
export function realizedResolveRate(outcomes: Array<{ resolved: boolean }>): number | null {
  if (!outcomes.length) return null;
  return outcomes.filter((o) => o.resolved).length / outcomes.length;
}
