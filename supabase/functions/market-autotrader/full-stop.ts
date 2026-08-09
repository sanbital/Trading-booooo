export const FULL_STOP_NET_RETURN_PCT = -4;
export const FULL_STOP_REASON = "FULL_STOP_LOSS_4";

export type FullStopDecision = {
  action: "NONE" | "STOP";
  fraction: 0 | 1;
  reason: "ABOVE_FULL_STOP_4" | typeof FULL_STOP_REASON;
  netReturnPct: number;
};

export function fullStopLossDecision(input: {
  entryPrice: number;
  executableExitPrice: number;
  sellFeeRate: number;
}): FullStopDecision {
  const entryPrice = Number(input.entryPrice);
  const executableExitPrice = Number(input.executableExitPrice);
  const sellFeeRate = Math.min(0.01, Math.max(0, Number(input.sellFeeRate) || 0));

  if (!(entryPrice > 0) || !(executableExitPrice > 0)) {
    return {
      action: "NONE",
      fraction: 0,
      reason: "ABOVE_FULL_STOP_4",
      netReturnPct: 0,
    };
  }

  const netReturnPct = (executableExitPrice * (1 - sellFeeRate) / entryPrice - 1) * 100;
  if (netReturnPct <= FULL_STOP_NET_RETURN_PCT) {
    return {
      action: "STOP",
      fraction: 1,
      reason: FULL_STOP_REASON,
      netReturnPct,
    };
  }

  return {
    action: "NONE",
    fraction: 0,
    reason: "ABOVE_FULL_STOP_4",
    netReturnPct,
  };
}
