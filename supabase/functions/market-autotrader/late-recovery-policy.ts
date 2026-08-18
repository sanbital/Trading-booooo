// Trading-booooo — isolated late-recovery exit policy.
//
// This module is deliberately side-effect free. Existing STOP / profit-protection / split
// policies remain authoritative; callers may consult this only after those owners return
// NONE. The post-180 trough is persisted by the caller and must never reset on reclaim.

export const LATE_RECOVERY_THRESHOLDS = {
  troughTrackingStartSeconds: 180,
  startSeconds: 460,
  drawdownRecoveryRatio: 0.33,
} as const;

export type LateRecoveryReason =
  | "LATE_RECOVERY_NET_POSITIVE_EXIT"
  | "LATE_RECOVERY_DRAWDOWN_33_EXIT"
  | "LATE_RECOVERY_EXISTING_DECISION_PRESERVED"
  | "LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED"
  | "LATE_RECOVERY_INACTIVE"
  | "LATE_RECOVERY_AWAITING_RECOVERY";

export type LateRecoveryDecision = {
  action: "STOP" | "NONE";
  fraction: number;
  reason: LateRecoveryReason;
  recoveryRatio: number | null;
};

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function updatePost180RunningTrough(
  previousTroughPrice: unknown,
  observedPrice: unknown,
): number {
  const previous = finite(previousTroughPrice);
  const observed = finite(observedPrice);
  if (!(observed > 0)) return previous > 0 ? previous : 0;
  if (!(previous > 0)) return observed;
  return Math.min(previous, observed);
}

export function lateRecoveryDecision(input: {
  heldSeconds: number;
  absoluteMaxHoldingSeconds: number;
  residualStage: boolean;
  existingAction: string;
  entryPrice: number;
  runningTroughPrice: number;
  executablePrice: number;
  executableDepthSufficient: boolean;
  executableNetAllowed: boolean;
  expectedNetProfitQuote: number;
}): LateRecoveryDecision {
  const none = (reason: LateRecoveryReason, recoveryRatio: number | null = null) => ({
    action: "NONE" as const,
    fraction: 0,
    reason,
    recoveryRatio,
  });

  if (String(input.existingAction || "NONE") !== "NONE") {
    return none("LATE_RECOVERY_EXISTING_DECISION_PRESERVED");
  }
  if (input.residualStage) return none("LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED");

  const heldSeconds = Math.max(0, finite(input.heldSeconds));
  const absoluteMaxHoldingSeconds = Math.max(1, finite(input.absoluteMaxHoldingSeconds, 600));
  if (
    heldSeconds < LATE_RECOVERY_THRESHOLDS.startSeconds ||
    heldSeconds >= absoluteMaxHoldingSeconds
  ) {
    return none("LATE_RECOVERY_INACTIVE");
  }

  const expectedNetProfitQuote = finite(input.expectedNetProfitQuote, Number.NEGATIVE_INFINITY);
  if (input.executableDepthSufficient && expectedNetProfitQuote >= 0) {
    return {
      action: "STOP",
      fraction: 1,
      reason: "LATE_RECOVERY_NET_POSITIVE_EXIT",
      recoveryRatio: null,
    };
  }

  const entryPrice = finite(input.entryPrice);
  const troughPrice = finite(input.runningTroughPrice);
  const executablePrice = finite(input.executablePrice);
  const drawdown = entryPrice - troughPrice;
  if (
    !input.executableDepthSufficient || !(entryPrice > 0) || !(troughPrice > 0) ||
    !(executablePrice > 0) || !(drawdown > 0)
  ) {
    return none("LATE_RECOVERY_AWAITING_RECOVERY");
  }

  const recoveryRatio = (executablePrice - troughPrice) / drawdown;
  if (
    expectedNetProfitQuote < 0 &&
    recoveryRatio >= LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio
  ) {
    return {
      action: "STOP",
      fraction: 1,
      reason: "LATE_RECOVERY_DRAWDOWN_33_EXIT",
      recoveryRatio,
    };
  }
  return none("LATE_RECOVERY_AWAITING_RECOVERY", recoveryRatio);
}
