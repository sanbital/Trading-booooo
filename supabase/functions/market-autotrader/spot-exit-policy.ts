export const SPOT_SPLIT_EXIT_THRESHOLDS = {
  firstTakeProfitPct: 5,
  firstStopLossPct: -4,
  residualProfitFloorPct: 3,
  residualTrailingDrawdownPct: 1.5,
  firstTakeProfitFraction: 0.5,
  hardStopFraction: 1,
} as const;

export type SpotSplitExitInput = {
  residualStage: boolean;
  grossReturnPct: number;
  peakGrossReturnPct: number;
  residualNetReturnPct: number;
  safetyRequested?: boolean;
};

export type SpotSplitExitDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: string;
  residualProtectPct?: number;
};

/**
 * Canonical spot policy:
 * - hard stop: -4%, close 100%
 * - first take-profit: +5%, close 50%
 * - residual: protect at max(+3%, peak - 1.5 percentage points)
 */
export function spotSplitExitDecision(input: SpotSplitExitInput): SpotSplitExitDecision {
  const t = SPOT_SPLIT_EXIT_THRESHOLDS;
  if (input.residualStage) {
    const peakGrossReturnPct = Math.max(input.grossReturnPct, input.peakGrossReturnPct);
    const residualProtectPct = Math.max(
      t.residualProfitFloorPct,
      peakGrossReturnPct - t.residualTrailingDrawdownPct,
    );
    if (input.grossReturnPct <= residualProtectPct) {
      return {
        action: "STOP",
        fraction: 1,
        reason: "RESIDUAL_PROTECTED_TRAIL_EXIT",
        residualProtectPct,
      };
    }
    return {
      action: "NONE",
      fraction: 0,
      reason: "RESIDUAL_PROTECTED_TRAIL_ACTIVE",
      residualProtectPct,
    };
  }
  if (input.grossReturnPct >= t.firstTakeProfitPct) {
    return {
      action: "STOP",
      fraction: t.firstTakeProfitFraction,
      reason: "HALF_HOLD_TAKE_PROFIT_5",
    };
  }
  if (input.grossReturnPct <= t.firstStopLossPct) {
    return {
      action: "STOP",
      fraction: t.hardStopFraction,
      reason: "HALF_HOLD_STOP_LOSS_4",
    };
  }
  return {
    action: "NONE",
    fraction: 0,
    reason: input.safetyRequested
      ? "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT"
      : "HALF_HOLD_AWAITING_TP5_OR_SL4",
  };
}
