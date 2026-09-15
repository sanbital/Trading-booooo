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

/**
 * Lift evidence-sized notional to an operator-required minimum only when every hard
 * ceiling can fund that minimum. This never overrides capital, slot, loss, depth,
 * exchange, or immediately available quote limits.
 */
export function enforceMinimumExecutableNotional(
  decision: SizingDecision,
  minimumNotional: number,
  availableQuote: number,
): number {
  const minimum = Math.max(0, finite(minimumNotional));
  const hardCeiling = Math.min(
    Math.max(0, finite(availableQuote)),
    Math.max(0, finite(decision.remainingExposureCap)),
    Math.max(0, finite(decision.slotCap)),
    Math.max(0, finite(decision.riskCap)),
    Math.max(0, finite(decision.depthCap)),
    Math.max(0, finite(decision.exchangeCap)),
  );
  const requested = Math.min(Math.max(0, finite(decision.notionalQuote)), hardCeiling);
  return requested < minimum && hardCeiling >= minimum ? minimum : requested;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, finite(value, low)));
}

/**
 * Reduce concurrency only when fixed slot division would make every order smaller than
 * the executable minimum. Total strategy exposure is unchanged; fewer slots simply make
 * the operator's minimum ticket possible with the capital that is actually available.
 */
export function capitalSupportedSlotCount(
  managedCapitalQuote: number,
  maxStrategyExposureFraction: number,
  configuredSlots: number,
  minimumNotional: number,
): number {
  const configured = Math.max(1, Math.floor(finite(configuredSlots, 1)));
  const exposureCap = Math.max(0, finite(managedCapitalQuote)) *
    clamp(maxStrategyExposureFraction, 0, 1);
  const minimum = Math.max(1e-8, finite(minimumNotional, 1e-8));
  const supported = Math.max(1, Math.floor(exposureCap / minimum));
  return Math.min(configured, supported);
}

export function calculateOrderNotional(input: SizingInput): SizingDecision {
  const managed = Math.max(0, finite(input.managedCapitalQuote));
  const totalExposureCap = managed * clamp(input.maxStrategyExposureFraction, 0, 1);
  const currentExposure = Math.max(0, finite(input.currentExposureQuote ?? 0));
  const remainingExposureCap = Math.max(0, totalExposureCap - currentExposure);
  const slots = Math.max(1, Math.floor(finite(input.desiredSlots, 1)));
  const slotCap = totalExposureCap / slots;
  const lossRate = Math.max(
    1e-8,
    finite(input.stopPct) + Math.max(0, finite(input.estimatedExitCostPct)),
  );
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
