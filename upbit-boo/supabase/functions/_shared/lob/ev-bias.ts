// Trading-booooo v6.9.0 — realized-vs-predicted EV residual calibration.
//
// Positive predicted EV is not evidence that the model is calibrated. This module measures
// the residual (realized net bps - entry-time EV lower bound) on accounting-verified live
// closes and charges only statistically confirmed optimism back to future entries.

export interface EvBiasSample {
  predictedEvBps: number;
  realizedNetBps: number;
}

export interface EvBiasConfig {
  minSamples: number;
  priorStrength: number;
  zScore: number;
  trimFraction: number;
  maxPenaltyBps: number;
}

export const DEFAULT_EV_BIAS_CONFIG: EvBiasConfig = {
  minSamples: 40,
  priorStrength: 80,
  zScore: 1.281551565545, // one-sided 90%
  trimFraction: 0.05,
  maxPenaltyBps: 30,
};

export interface EvBiasEstimate {
  samples: number;
  meanResidualBps: number;
  standardErrorBps: number;
  upperBoundBps: number;
  penaltyBps: number;
  confirmedOptimism: boolean;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function trimmed(values: number[], fraction: number): number[] {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length < 5) return clean;
  const cut = Math.floor(clean.length * clamp(fraction, 0, 0.20));
  return clean.slice(cut, Math.max(cut + 1, clean.length - cut));
}

export function estimateEvBias(
  samples: EvBiasSample[],
  overrides: Partial<EvBiasConfig> = {},
): EvBiasEstimate {
  const cfg = { ...DEFAULT_EV_BIAS_CONFIG, ...overrides };
  const residuals = trimmed(
    (samples || [])
      .filter((sample) => Number.isFinite(sample.predictedEvBps) && Number.isFinite(sample.realizedNetBps))
      .map((sample) => sample.realizedNetBps - sample.predictedEvBps),
    cfg.trimFraction,
  );
  const n = residuals.length;
  if (!n) {
    return {
      samples: 0,
      meanResidualBps: 0,
      standardErrorBps: 0,
      upperBoundBps: 0,
      penaltyBps: 0,
      confirmedOptimism: false,
    };
  }
  const mean = residuals.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1
    ? residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 0;
  const standardError = Math.sqrt(Math.max(0, variance) / Math.max(1, n));
  const upperBound = mean + Math.abs(cfg.zScore) * standardError;
  const confirmedOptimism = n >= cfg.minSamples && upperBound < 0;
  const weight = n / (n + Math.max(1, cfg.priorStrength));
  const penalty = confirmedOptimism
    ? clamp(-mean * weight, 0, cfg.maxPenaltyBps)
    : 0;
  return {
    samples: n,
    meanResidualBps: mean,
    standardErrorBps: standardError,
    upperBoundBps: upperBound,
    penaltyBps: penalty,
    confirmedOptimism,
  };
}

export function boundedEvBiasPenalty(
  measuredPenaltyBps: unknown,
  multiplier: unknown,
  maxPenaltyBps: unknown,
): number {
  const cap = clamp(finite(maxPenaltyBps, 30), 5, 50);
  return clamp(
    Math.max(0, finite(measuredPenaltyBps)) * clamp(finite(multiplier, 1), 0.75, 1.5),
    0,
    cap,
  );
}
