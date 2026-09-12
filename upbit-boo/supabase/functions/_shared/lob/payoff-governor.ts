// Trading-booooo v6.10.0 r8 — verified payoff governor with admission continuity.
//
// The verified trade history showed that faster turnover alone did not create positive EV:
// Binance turnover improved while win rate stayed at 16%, and Upbit win rate improved while
// profit factor and notional-weighted return deteriorated. This module keeps turnover in the
// objective, but refuses to count fee-burning cycles as useful capital rotation.

export interface RealizedPayoffSummary {
  samples: number;
  profitableTrades: number;
  losingTrades: number;
  profitableRate: number | null;
  meanNetBps: number | null;
  meanWinBps: number | null;
  meanLossBps: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  standardDeviationBps: number | null;
  meanLowerBoundBps: number | null;
}

export interface PayoffDeploymentInput {
  samples: number;
  observedMultiplier: number;
  profitableRate: number | null;
  meanNetBps: number | null;
  profitFactor?: number | null;
  payoffRatio?: number | null;
  meanLowerBoundBps?: number | null;
  medianHoldSeconds?: number | null;
  gateStartSamples?: number;
  gateFullSamples?: number;
}

export interface PayoffDeploymentDecision {
  gateWeight: number;
  gateMultiplier: number;
  rankingQuality: number;
  performanceTarget: number;
  profitFactorScore: number;
  payoffScore: number;
  meanNetScore: number;
  lowerBoundScore: number;
  turnoverScore: number;
  reason: string;
}

export interface EntryPayoffInput {
  targetBps: number;
  stopBps: number;
  targetReturnNetBps: number;
  stopReturnNetBps: number;
  minNetProfitBps: number;
  maxStopToTargetRatio: number;
  minNetRewardRiskRatio: number;
}

export interface EntryPayoffDecision {
  allowed: boolean;
  stopToTargetRatio: number;
  netRewardRiskRatio: number;
  reasons: string[];
  warnings: string[];
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleStdDev(values: number[], average: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function safeRatio(numerator: number, denominator: number, cap = 10): number | null {
  if (denominator > 0) return clamp(numerator / denominator, 0, cap);
  return numerator > 0 ? cap : null;
}

export function summarizeRealizedPayoff(
  values: number[],
  zScore = 1.281551565545,
): RealizedPayoffSummary {
  const clean = (values || []).map(Number).filter(Number.isFinite);
  if (!clean.length) {
    return {
      samples: 0,
      profitableTrades: 0,
      losingTrades: 0,
      profitableRate: null,
      meanNetBps: null,
      meanWinBps: null,
      meanLossBps: null,
      payoffRatio: null,
      profitFactor: null,
      standardDeviationBps: null,
      meanLowerBoundBps: null,
    };
  }

  const wins = clean.filter((value) => value > 0);
  const losses = clean.filter((value) => value < 0);
  const average = mean(clean);
  const meanWin = wins.length ? mean(wins) : 0;
  const meanLoss = losses.length ? Math.abs(mean(losses)) : 0;
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const standardDeviation = sampleStdDev(clean, average);
  const standardError = standardDeviation / Math.sqrt(clean.length);

  return {
    samples: clean.length,
    profitableTrades: wins.length,
    losingTrades: losses.length,
    profitableRate: wins.length / clean.length,
    meanNetBps: average,
    meanWinBps: wins.length ? meanWin : null,
    meanLossBps: losses.length ? meanLoss : null,
    payoffRatio: safeRatio(meanWin, meanLoss),
    profitFactor: safeRatio(grossProfit, grossLoss),
    standardDeviationBps: standardDeviation,
    meanLowerBoundBps: average - Math.abs(finite(zScore, 1.281551565545)) * standardError,
  };
}

/**
 * Turns verified realized payoff evidence into two separate controls.
 *
 * - gateMultiplier may lift the bounded signal edge used by the hard EV gate.
 * - rankingQuality determines which candidate receives scarce slot-seconds.
 *
 * Adverse evidence remains ranking- and sizing-only. Allowing it to reduce the hard gate
 * makes the system "improve" its measured win rate by deleting future observations, which
 * both collapses turnover and prevents the evidence from ever recovering.
 */
export function payoffAwareDeployment(
  input: PayoffDeploymentInput,
): PayoffDeploymentDecision {
  const samples = Math.max(0, Math.floor(finite(input.samples)));
  const start = Math.max(1, Math.floor(finite(input.gateStartSamples, 20)));
  const full = Math.max(start + 1, Math.floor(finite(input.gateFullSamples, 120)));
  const gateWeight = clamp((samples - start) / (full - start), 0, 1);

  const observedMultiplier = clamp(finite(input.observedMultiplier, 1), 0.30, 1.35);
  const profitFactor = input.profitFactor == null ? 1 : Math.max(0, finite(input.profitFactor));
  const payoffRatio = input.payoffRatio == null ? 1 : Math.max(0, finite(input.payoffRatio));
  const meanNetBps = input.meanNetBps == null ? 0 : finite(input.meanNetBps);
  const lowerBound = input.meanLowerBoundBps == null ? 0 : finite(input.meanLowerBoundBps);

  const profitFactorScore = clamp(Math.sqrt(Math.max(0.01, profitFactor)), 0.55, 1.25);
  const payoffScore = clamp(Math.sqrt(Math.max(0.01, payoffRatio)), 0.65, 1.20);
  const meanNetScore = clamp(1 + meanNetBps / 40, 0.55, 1.25);
  const lowerBoundScore = lowerBound < 0
    ? clamp(1 + lowerBound / 60, 0.55, 1)
    : clamp(1 + lowerBound / 100, 1, 1.10);

  const performanceTarget = clamp(
    observedMultiplier * profitFactorScore * payoffScore * meanNetScore * lowerBoundScore,
    0.55,
    1.30,
  );
  // Only the probability calibration may alter the entry probability. Profit factor,
  // payoff and holding time remain ranking/sizing evidence; multiplying all of them into
  // pTarget would double-count the same realized outcomes and can overstate the hard gate.
  const positiveGateTarget = Math.max(1, observedMultiplier);
  const gateMultiplier = 1 + (positiveGateTarget - 1) * gateWeight;

  const profitableRate = input.profitableRate == null
    ? null
    : clamp(finite(input.profitableRate), 0, 1);
  const winScore = profitableRate == null ? 1 : clamp(0.5 + profitableRate, 0.5, 1.5);
  const hold = input.medianHoldSeconds == null ? 0 : Math.max(0, finite(input.medianHoldSeconds));
  const turnoverScore = hold > 0 ? clamp(Math.sqrt(180 / hold), 0.75, 1.35) : 1;

  const rankingQuality = clamp(
    performanceTarget * winScore * turnoverScore,
    0.10,
    2,
  );

  return {
    gateWeight,
    gateMultiplier,
    rankingQuality,
    performanceTarget,
    profitFactorScore,
    payoffScore,
    meanNetScore,
    lowerBoundScore,
    turnoverScore,
    reason:
      `verified payoff n=${samples}, gateWeight=${gateWeight.toFixed(2)}, ` +
      `target=${performanceTarget.toFixed(2)}, turnover=${turnoverScore.toFixed(2)}`,
  };
}

/**
 * Separates the one economic veto from payoff-shape diagnostics.
 *
 * This does not tighten a stop inside market noise. The stop remains noise-aware; when that
 * required stop makes the geometry asymmetric, the expected-value calculation still prices
 * the full loss branch. A fixed reward/risk ratio must not independently delete a trade that
 * remains positive-EV at its estimated win rate.
 */
export function evaluateEntryPayoff(input: EntryPayoffInput): EntryPayoffDecision {
  const targetBps = Math.max(0, finite(input.targetBps));
  const stopBps = Math.max(0, finite(input.stopBps));
  const targetNet = finite(input.targetReturnNetBps);
  const stopNetLoss = Math.abs(Math.min(0, finite(input.stopReturnNetBps)));
  const maxStopToTargetRatio = clamp(finite(input.maxStopToTargetRatio, 1.35), 0.75, 5);
  const minNetRewardRiskRatio = clamp(finite(input.minNetRewardRiskRatio, 0.80), 0.10, 5);
  const minNetProfitBps = Math.max(0, finite(input.minNetProfitBps, 2));

  const stopToTargetRatio = targetBps > 0 ? stopBps / targetBps : Number.POSITIVE_INFINITY;
  const netRewardRiskRatio = stopNetLoss > 0
    ? Math.max(0, targetNet) / stopNetLoss
    : Number.POSITIVE_INFINITY;

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!(targetNet >= minNetProfitBps)) reasons.push("TARGET_NET_CUSHION_TOO_SMALL");
  if (!(stopToTargetRatio <= maxStopToTargetRatio)) warnings.push("STOP_TARGET_ASYMMETRY");
  if (!(netRewardRiskRatio >= minNetRewardRiskRatio)) warnings.push("NET_PAYOFF_TOO_WEAK");

  return {
    allowed: reasons.length === 0,
    stopToTargetRatio,
    netRewardRiskRatio,
    reasons,
    warnings,
  };
}
