export const SPOT_SPLIT_EXIT_THRESHOLDS = {
  firstTakeProfitPct: 5,
  firstStopLossPct: -4,
  residualProfitFloorPct: 3,
  residualTrailingDrawdownPct: 1.5,
  firstTakeProfitFraction: 0.5,
  hardStopFraction: 1,
  staleRecoveryAfterSeconds: 180 * 60,
} as const;

export type SpotSplitExitInput = {
  residualStage: boolean;
  grossReturnPct: number;
  peakGrossReturnPct: number;
  residualNetReturnPct: number;
  heldSeconds: number;
  executableNetAllowed: boolean;
  expectedNetProfitQuote: number;
  /** True only when the engine has an earned above-entry protected stop and price hit it. */
  preT1ProfitProtectionHit?: boolean;
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
 * - if +5% was not reached within 180m, keep the -4% stop but close 100% at the
 *   first executable exit whose fees/slippage-adjusted net profit is strictly positive
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
  // Target and hard stop remain authoritative even after the 180m recovery clock starts.
  if (input.grossReturnPct >= t.firstTakeProfitPct) {
    return {
      action: "STOP",
      fraction: t.firstTakeProfitFraction,
      reason: "HALF_HOLD_TAKE_PROFIT_5",
    };
  }
  if (input.preT1ProfitProtectionHit === true) {
    return {
      action: "STOP",
      fraction: 1,
      reason: "PRE_T1_PROFIT_PROTECTION_EXIT",
    };
  }
  if (input.grossReturnPct <= t.firstStopLossPct) {
    return {
      action: "STOP",
      fraction: t.hardStopFraction,
      reason: "HALF_HOLD_STOP_LOSS_4",
    };
  }
  if (Number(input.heldSeconds) >= t.staleRecoveryAfterSeconds) {
    if (input.executableNetAllowed && Number(input.expectedNetProfitQuote) > 0) {
      return {
        action: "STOP",
        fraction: 1,
        reason: "STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
      };
    }
    return {
      action: "NONE",
      fraction: 0,
      reason: "STALE_RECOVERY_AWAITING_POSITIVE_NET_180M",
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
