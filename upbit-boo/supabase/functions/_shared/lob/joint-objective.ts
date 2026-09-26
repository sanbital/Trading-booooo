// Trading-booooo v6.10.0 — joint wealth-growth objective.
//
// No single score may hide a collapse in win rate, cost-net return or capital turnover.
// Promotion is a Pareto contract; the account-growth metric is reported separately from
// active-capital efficiency so idle capital cannot disappear from the objective.

export interface JointObjectiveInput {
  startEquityQuote: number;
  endEquityQuote: number;
  averageManagedCapitalQuote: number;
  observationSeconds: number;
  trades: Array<{
    netReturnFraction: number;
    notionalQuote: number;
    heldSeconds: number;
    profitable: boolean;
  }>;
}

export interface JointObjectiveMetrics {
  accountLogGrowth: number;
  accountLogGrowthPerHour: number;
  activeCapitalLogEfficiency: number;
  capitalUtilization: number;
  capitalTurnsPerHour: number;
  winRate: number;
  geometricMeanReturn: number;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

export function calculateJointObjective(input: JointObjectiveInput): JointObjectiveMetrics {
  const start = Math.max(0, finite(input.startEquityQuote));
  const end = Math.max(0, finite(input.endEquityQuote));
  const managed = Math.max(0, finite(input.averageManagedCapitalQuote));
  const observationSeconds = Math.max(0, finite(input.observationSeconds));
  const accountLogGrowth = start > 0 && end > 0 ? Math.log(end / start) : 0;
  const observationHours = observationSeconds / 3600;
  const accountCapitalHours = managed * observationHours;
  const trades = Array.isArray(input.trades) ? input.trades : [];
  let activeCapitalSeconds = 0;
  let activeWeightedLogReturn = 0;
  let turnoverNotional = 0;
  let wins = 0;
  const logs: number[] = [];
  for (const trade of trades) {
    const notional = Math.max(0, finite(trade.notionalQuote));
    const held = Math.max(0, finite(trade.heldSeconds));
    const logReturn = Math.log1p(clamp(finite(trade.netReturnFraction), -0.999999, 100));
    activeCapitalSeconds += notional * held;
    activeWeightedLogReturn += notional * logReturn;
    turnoverNotional += notional;
    logs.push(logReturn);
    if (trade.profitable) wins++;
  }
  return {
    accountLogGrowth,
    accountLogGrowthPerHour: observationHours > 0 ? accountLogGrowth / observationHours : 0,
    activeCapitalLogEfficiency: activeCapitalSeconds > 0
      ? activeWeightedLogReturn / (activeCapitalSeconds / 3600)
      : 0,
    capitalUtilization: accountCapitalHours > 0
      ? (activeCapitalSeconds / 3600) / accountCapitalHours
      : 0,
    capitalTurnsPerHour: activeCapitalSeconds > 0
      ? turnoverNotional / (activeCapitalSeconds / 3600)
      : 0,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    geometricMeanReturn: logs.length > 0
      ? Math.expm1(logs.reduce((sum, value) => sum + value, 0) / logs.length)
      : 0,
  };
}

export function jointParetoDominates(input: {
  baseline: Pick<JointObjectiveMetrics, "accountLogGrowthPerHour" | "winRate" | "capitalTurnsPerHour">;
  candidate: Pick<JointObjectiveMetrics, "accountLogGrowthPerHour" | "winRate" | "capitalTurnsPerHour">;
  tolerance?: number;
}): boolean {
  const tolerance = Math.max(0, finite(input.tolerance, 0));
  const nonWorse = input.candidate.accountLogGrowthPerHour + tolerance >= input.baseline.accountLogGrowthPerHour &&
    input.candidate.winRate + tolerance >= input.baseline.winRate &&
    input.candidate.capitalTurnsPerHour + tolerance >= input.baseline.capitalTurnsPerHour;
  const strictlyBetter = input.candidate.accountLogGrowthPerHour > input.baseline.accountLogGrowthPerHour ||
    input.candidate.winRate > input.baseline.winRate ||
    input.candidate.capitalTurnsPerHour > input.baseline.capitalTurnsPerHour;
  return nonWorse && strictlyBetter;
}
