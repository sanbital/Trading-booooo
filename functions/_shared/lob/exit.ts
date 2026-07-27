export type LobExitReason =
  | "RISK_EMERGENCY"
  | "RECONCILIATION_FAILURE"
  | "STOP_HIT"
  | "LOB_INVALIDATION"
  | "SIGNAL_REVERSAL"
  | "TARGET_HIT"
  | "TIMEOUT"
  | "HOLD";

export interface LobExitInput {
  emergency: boolean;
  reconciliationFailed: boolean;
  currentPrice: number;
  stopPrice: number;
  targetPrice: number;
  heldSeconds: number;
  maxHoldingSeconds: number;
  bookImbalance: number;
  tradePressure: number;
  micropriceDeviationBps: number;
  spreadBps: number;
  maxSpreadBps: number;
  bidDepthRatio: number;
  minBidDepthRatio: number;
  dynamicStatus?: string;
  previousSoftReason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  softSignalStreak?: number;
  softExitConfirmations?: number;
  softExitGraceSeconds?: number;
}

export interface LobExitDecision {
  exit: boolean;
  reason: LobExitReason;
  priority: number;
  nextSoftReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  nextSoftSignalStreak: number;
  severeSoftSignal: boolean;
}

/** Required deterministic priority from the development brief. */
export function evaluateLobExit(input: LobExitInput): LobExitDecision {
  const hard = (reason: LobExitReason, priority: number): LobExitDecision => ({
    exit: true,
    reason,
    priority,
    nextSoftReason: null,
    nextSoftSignalStreak: 0,
    severeSoftSignal: false,
  });
  if (input.emergency) return hard("RISK_EMERGENCY", 100);
  if (input.reconciliationFailed) return hard("RECONCILIATION_FAILURE", 95);
  if (input.currentPrice <= input.stopPrice) return hard("STOP_HIT", 90);
  // A touched target is a win even if the same quote also shows a temporary spread or
  // depth shock. Soft invalidation must not relabel it as a stop.
  if (input.currentPrice >= input.targetPrice) return hard("TARGET_HIT", 85);

  const invalidStatus = new Set([
    "SUPPORT_BREAKDOWN_RISK",
    "SPOOF_LIKE_RISK",
    "ASK_ABSORPTION_RISK",
  ]);
  const invalidated = invalidStatus.has(String(input.dynamicStatus || "")) ||
    input.spreadBps > input.maxSpreadBps ||
    input.bidDepthRatio < input.minBidDepthRatio;
  const reversed = input.bookImbalance <= -0.20 &&
    input.tradePressure <= -0.20 &&
    input.micropriceDeviationBps < 0;
  const softReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null = invalidated
    ? "LOB_INVALIDATION"
    : reversed
    ? "SIGNAL_REVERSAL"
    : null;
  if (softReason) {
    const nextStreak = input.previousSoftReason === softReason
      ? Math.max(0, Math.floor(Number(input.softSignalStreak) || 0)) + 1
      : 1;
    const required = Math.max(1, Math.floor(Number(input.softExitConfirmations) || 1));
    const grace = Math.max(0, Number(input.softExitGraceSeconds) || 0);
    // Only truly catastrophic live readings bypass settlement confirmation. A maker fill
    // is itself caused by an aggressive sell, so ordinary one-cycle sell pressure is not
    // independent evidence that the trade thesis failed.
    const severe = input.spreadBps > input.maxSpreadBps * 2 ||
      input.bidDepthRatio < input.minBidDepthRatio * 0.25 ||
      (
        input.bookImbalance <= -0.65 &&
        input.tradePressure <= -0.65 &&
        input.micropriceDeviationBps < 0
      );
    const confirmed = severe ||
      (input.heldSeconds >= grace && nextStreak >= required);
    return {
      exit: confirmed,
      reason: confirmed ? softReason : "HOLD",
      priority: confirmed ? (softReason === "LOB_INVALIDATION" ? 80 : 70) : 0,
      nextSoftReason: softReason,
      nextSoftSignalStreak: nextStreak,
      severeSoftSignal: severe,
    };
  }
  if (input.heldSeconds >= input.maxHoldingSeconds) return hard("TIMEOUT", 50);
  return {
    exit: false,
    reason: "HOLD",
    priority: 0,
    nextSoftReason: null,
    nextSoftSignalStreak: 0,
    severeSoftSignal: false,
  };
}
