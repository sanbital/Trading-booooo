export const SPOT_SPLIT_EXIT_THRESHOLDS = {
  firstTakeProfitPct: 5,
  firstStopLossPct: -4,
  residualTakeProfitPct: 10,
  residualStopLossPct: -4,
} as const;

export type SpotSplitExitInput = {
  residualStage: boolean;
  grossReturnPct: number;
  residualNetReturnPct: number;
  safetyRequested?: boolean;
};

export type SpotSplitExitDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: string;
};

/** Canonical spot policy: first 50% at +5%/-4%, residual 100% at +10%/-4%. */
export function spotSplitExitDecision(input: SpotSplitExitInput): SpotSplitExitDecision {
  const t = SPOT_SPLIT_EXIT_THRESHOLDS;
  if (input.residualStage) {
    if (input.residualNetReturnPct >= t.residualTakeProfitPct) {
      return { action: "STOP", fraction: 1, reason: "RESIDUAL_TAKE_PROFIT_10" };
    }
    if (input.residualNetReturnPct <= t.residualStopLossPct) {
      return { action: "STOP", fraction: 1, reason: "RESIDUAL_STOP_LOSS_4" };
    }
    return { action: "NONE", fraction: 0, reason: "RESIDUAL_AWAITING_TP10_OR_SL4" };
  }
  if (input.grossReturnPct >= t.firstTakeProfitPct) {
    return { action: "STOP", fraction: 0.5, reason: "HALF_HOLD_TAKE_PROFIT_5" };
  }
  if (input.grossReturnPct <= t.firstStopLossPct) {
    return { action: "STOP", fraction: 0.5, reason: "HALF_HOLD_STOP_LOSS_4" };
  }
  return {
    action: "NONE",
    fraction: 0,
    reason: input.safetyRequested
      ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
      : "HALF_HOLD_AWAITING_TP5_OR_SL4",
  };
}
