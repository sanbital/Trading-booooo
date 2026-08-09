export const HALF_HOLD_EXIT_THRESHOLDS = {
  firstTakeProfitPct: 5,
  firstStopLossPct: -4,
  residualTakeProfitPct: 10,
  residualStopLossPct: -4,
} as const;

export type HalfHoldRecoveryExitInput = {
  residualStage: boolean;
  recoveryMode: boolean;
  grossReturnPct: number;
  residualNetReturnPct: number;
  executableNetAllowed: boolean;
  expectedNetProfitQuote: number;
  safetyRequested?: boolean;
};

export type HalfHoldRecoveryExitDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: string;
};

/**
 * Canonical split-exit policy.
 *
 * Normal winner:
 *   +5% -> sell the first 50%; residual exits at +10% or -4%.
 *
 * Failed first leg / recovery mode:
 *   -4% -> sell the first 50%; the residual no longer uses the +10/-4
 *   percentage thresholds. It exits only when selling the entire remainder is
 *   executable at strictly positive TOTAL position net PnL after fees and the
 *   configured slippage safety allowance.
 *
 * Emergency liquidation remains outside this helper and is not weakened here.
 */
export function halfHoldRecoveryExitDecision(
  input: HalfHoldRecoveryExitInput,
): HalfHoldRecoveryExitDecision {
  const thresholds = HALF_HOLD_EXIT_THRESHOLDS;

  if (input.residualStage) {
    if (input.recoveryMode) {
      if (input.executableNetAllowed && input.expectedNetProfitQuote > 0) {
        return {
          action: "STOP",
          fraction: 1,
          reason: "RECOVERY_NET_POSITIVE_EXIT",
        };
      }
      return {
        action: "NONE",
        fraction: 0,
        reason: "RECOVERY_AWAITING_NET_POSITIVE",
      };
    }

    if (input.residualNetReturnPct >= thresholds.residualTakeProfitPct) {
      return {
        action: "STOP",
        fraction: 1,
        reason: "RESIDUAL_TAKE_PROFIT_10",
      };
    }
    if (input.residualNetReturnPct <= thresholds.residualStopLossPct) {
      return {
        action: "STOP",
        fraction: 1,
        reason: "RESIDUAL_STOP_LOSS_4",
      };
    }
    return {
      action: "NONE",
      fraction: 0,
      reason: "RESIDUAL_AWAITING_TP10_OR_SL4",
    };
  }

  if (input.grossReturnPct >= thresholds.firstTakeProfitPct) {
    return {
      action: "STOP",
      fraction: 0.5,
      reason: "HALF_HOLD_TAKE_PROFIT_5",
    };
  }
  if (input.grossReturnPct <= thresholds.firstStopLossPct) {
    return {
      action: "STOP",
      fraction: 0.5,
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
