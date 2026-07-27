// Trading-booooo v5.12 — total-exposure-invariant slot sizing.
// Pure arithmetic only. Live price/quantity conversion should continue to use exchange
// tick/step flooring; database monetary values remain NUMERIC.

export interface SizingInput {
  managedCapitalQuote: number;
  maxStrategyExposureFraction: number;
  desiredSlots: number;
  perTradeLossBudgetQuote: number;
  stopPct: number;
  estimatedExitCostPct: number;
  depthLimitedNotional: number;
  exchangeLimitedNotional: number;
  sizeFraction: number;
  currentExposureQuote?: number;
}

export interface SizingDecision {
  notionalQuote: number;
  totalExposureCap: number;
  remainingExposureCap: number;
  slotCap: number;
  riskCap: number;
  depthCap: number;
  exchangeCap: number;
  sizeFraction: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, finite(value, low)));
}

export function calculateOrderNotional(input: SizingInput): SizingDecision {
  const managed = Math.max(0, finite(input.managedCapitalQuote));
  const totalExposureCap = managed * clamp(input.maxStrategyExposureFraction, 0, 1);
  const currentExposure = Math.max(0, finite(input.currentExposureQuote ?? 0));
  const remainingExposureCap = Math.max(0, totalExposureCap - currentExposure);
  const slots = Math.max(1, Math.floor(finite(input.desiredSlots, 1)));
  const slotCap = totalExposureCap / slots;
  const lossRate = Math.max(1e-8, finite(input.stopPct) + Math.max(0, finite(input.estimatedExitCostPct)));
  const riskCap = Math.max(0, finite(input.perTradeLossBudgetQuote)) / lossRate;
  const depthCap = Math.max(0, finite(input.depthLimitedNotional));
  const exchangeCap = Math.max(0, finite(input.exchangeLimitedNotional));
  const normalNotional = Math.min(
    remainingExposureCap,
    slotCap,
    riskCap,
    depthCap,
    exchangeCap,
  );
  const sizeFraction = clamp(input.sizeFraction, 0, 1);
  return {
    notionalQuote: Math.max(0, normalNotional * sizeFraction),
    totalExposureCap,
    remainingExposureCap,
    slotCap,
    riskCap,
    depthCap,
    exchangeCap,
    sizeFraction,
  };
}
