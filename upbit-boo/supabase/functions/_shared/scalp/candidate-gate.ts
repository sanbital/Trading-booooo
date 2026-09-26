// Trading-booooo v5.12 — cost-adjusted EV, win-probability and fill-probability gate.
// Pure functions only. Percentages are fractions (0.001 = 0.10%).

import {
  type ForecastScenario,
  type OutcomeForecast,
  validateOutcomeForecast,
} from "./outcome-forecaster.ts";

export interface BarrierSpec {
  targetPct: number;
  stopPct: number;
  maxHoldingMinutes: number;
}

export interface ExpectedCosts {
  entryFeeRate: number;
  targetExitFeeRate: number;
  stopExitFeeRate: number;
  entrySlippageRate: number;
  targetExitSlippageRate: number;
  stopExitSlippageRate: number;
  /** Only measured cash/resource cost. Zero is valid; pFill is gated separately. */
  unfilledMeasuredCostRate: number;
}

export interface GateConfig {
  /** Lower-tail quantile: 0.05 = one-sided 95% lower bound. */
  lowerQuantile: number;
  minEvBuffer: number;
  minWinProbabilityLowerBound: number;
  minFillProbabilityLowerBound: number;
  minEffectiveSamples: number;
  minIndependentBlocks: number;
  requireCalibrationReady: boolean;
}

export const DEFAULT_CANDIDATE_GATE: GateConfig = {
  lowerQuantile: 0.05,
  minEvBuffer: 0,
  minWinProbabilityLowerBound: 0.50,
  minFillProbabilityLowerBound: 0.30,
  minEffectiveSamples: 60,
  minIndependentBlocks: 3,
  requireCalibrationReady: true,
};

export const SHADOW_CANDIDATE_GATE: GateConfig = {
  ...DEFAULT_CANDIDATE_GATE,
  minEffectiveSamples: 0,
  minIndependentBlocks: 0,
  requireCalibrationReady: false,
};

export interface ScenarioEvaluation {
  targetReturnNet: number;
  stopReturnNet: number;
  timeoutReturnNet: number;
  evFilled: number;
  evAttempt: number;
  pNetPositive: number;
}

export interface CandidateEvaluation {
  accepted: boolean;
  rejectionReasons: string[];
  evFilled: number;
  evAttempt: number;
  evLowerBound: number;
  pWinPoint: number;
  pWinLowerBound: number;
  pFillLowerBound: number;
  capitalEfficiency: number;
  scenarioCount: number;
}

function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

export function quantile(values: number[], q: number): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return Number.NaN;
  const p = clamp(q) * (clean.length - 1);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  if (lo === hi) return clean[lo];
  return clean[lo] + (clean[hi] - clean[lo]) * (p - lo);
}

export function deriveNetPositiveProbability(
  pTarget: number,
  pStop: number,
  pTimeout: number,
  timeoutPositiveProbability: number,
  targetReturnNet: number,
  stopReturnNet: number,
): number {
  return clamp(
    pTarget * (targetReturnNet > 0 ? 1 : 0) +
      pStop * (stopReturnNet > 0 ? 1 : 0) +
      pTimeout * clamp(timeoutPositiveProbability),
  );
}

export function evaluateScenario(
  barrier: BarrierSpec,
  scenario: ForecastScenario,
  costs: ExpectedCosts,
): ScenarioEvaluation {
  const targetReturnNet = barrier.targetPct - costs.entryFeeRate - costs.targetExitFeeRate -
    costs.entrySlippageRate - costs.targetExitSlippageRate;
  const stopReturnNet = -barrier.stopPct - costs.entryFeeRate - costs.stopExitFeeRate -
    costs.entrySlippageRate - costs.stopExitSlippageRate;
  const timeoutReturnNet = scenario.timeoutReturnNet;
  const evFilled = scenario.pTarget * targetReturnNet + scenario.pStop * stopReturnNet +
    scenario.pTimeout * timeoutReturnNet;
  const evAttempt = scenario.pFill * evFilled -
    (1 - scenario.pFill) * Math.max(0, costs.unfilledMeasuredCostRate);
  const pNetPositive = deriveNetPositiveProbability(
    scenario.pTarget,
    scenario.pStop,
    scenario.pTimeout,
    scenario.timeoutPositiveProbability,
    targetReturnNet,
    stopReturnNet,
  );
  return { targetReturnNet, stopReturnNet, timeoutReturnNet, evFilled, evAttempt, pNetPositive };
}

export function evaluateCandidate(
  barrier: BarrierSpec,
  forecast: OutcomeForecast,
  costs: ExpectedCosts,
  config: GateConfig = DEFAULT_CANDIDATE_GATE,
): CandidateEvaluation {
  const reasons = validateOutcomeForecast(forecast);
  if (config.requireCalibrationReady && !forecast.calibrationReady) {
    reasons.push("CALIBRATION_NOT_READY");
  }
  if (forecast.effectiveSamples < config.minEffectiveSamples) {
    reasons.push("INSUFFICIENT_EFFECTIVE_SAMPLES");
  }
  if (forecast.independentBlocks < config.minIndependentBlocks) {
    reasons.push("INSUFFICIENT_INDEPENDENT_BLOCKS");
  }
  const scenarios = forecast.uncertaintyScenarios.map((s) => evaluateScenario(barrier, s, costs));
  const point = evaluateScenario(barrier, forecast.point, costs);
  const evLowerBound = quantile(scenarios.map((x) => x.evAttempt), config.lowerQuantile);
  const pWinLowerBound = quantile(scenarios.map((x) => x.pNetPositive), config.lowerQuantile);
  const pFillLowerBound = quantile(forecast.uncertaintyScenarios.map((x) => x.pFill), config.lowerQuantile);
  if (!Number.isFinite(evLowerBound) || evLowerBound <= config.minEvBuffer) {
    reasons.push("EV_LOWER_BOUND_NOT_POSITIVE");
  }
  if (!Number.isFinite(pWinLowerBound) || pWinLowerBound < config.minWinProbabilityLowerBound) {
    reasons.push("PWIN_LOWER_BOUND_BELOW_50_PERCENT");
  }
  if (!Number.isFinite(pFillLowerBound) || pFillLowerBound < config.minFillProbabilityLowerBound) {
    reasons.push("PFILL_LOWER_BOUND_TOO_LOW");
  }
  const holdingHours = Math.max(forecast.point.expectedHoldingMinutes / 60, 1 / 60);
  const uniqueReasons = [...new Set(reasons)];
  return {
    accepted: uniqueReasons.length === 0,
    rejectionReasons: uniqueReasons,
    evFilled: point.evFilled,
    evAttempt: point.evAttempt,
    evLowerBound,
    pWinPoint: point.pNetPositive,
    pWinLowerBound,
    pFillLowerBound,
    capitalEfficiency: evLowerBound / holdingHours,
    scenarioCount: scenarios.length,
  };
}
