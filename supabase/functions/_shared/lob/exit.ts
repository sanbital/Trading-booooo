// Trading-booooo v7.0.8 — profit-only exit policy.
//
// Ordinary market noise, LOB invalidation, signal reversal and elapsed holding time are
// observations, not permission to realize a loss. A live position exits only when:
//   1) account safety requires it,
//   2) the configured hard stop is reached (the database pins this to -5%), or
//   3) price reaches the fee-aware net-positive target.
//
// The 180-second horizon remains useful for monitoring and learning, but it no longer
// liquidates a negative position. Once the position is net positive, TARGET_HIT closes it.

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
  /** v7.0.8: persisted at average entry * 0.95. */
  stopPrice: number;
  /** v7.0.8: persisted above round-trip fees, so a touch is net profitable. */
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

function hold(input: {
  reason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;
  streak?: number;
  severe?: boolean;
} = {}): LobExitDecision {
  return {
    exit: false,
    reason: "HOLD",
    priority: 0,
    nextSoftReason: input.reason ?? null,
    nextSoftSignalStreak: Math.max(0, Math.floor(Number(input.streak) || 0)),
    severeSoftSignal: Boolean(input.severe),
  };
}

/** Deterministic v7.0.8 priority: safety, -5% hard stop, positive-net target, hold. */
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

  // The persisted stop is exactly 5% below average entry. No shallower stop is allowed.
  if (
    Number.isFinite(input.stopPrice) && input.stopPrice > 0 &&
    input.currentPrice <= input.stopPrice
  ) {
    return hard("STOP_HIT", 90);
  }

  // The persisted target includes round-trip fees plus a positive buffer. Therefore a
  // target touch is the single ordinary permission to sell, regardless of holding time.
  if (
    Number.isFinite(input.targetPrice) && input.targetPrice > 0 &&
    input.currentPrice >= input.targetPrice
  ) {
    return hard("TARGET_HIT", 85);
  }

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
    const severe = input.spreadBps > input.maxSpreadBps * 2 ||
      input.bidDepthRatio < input.minBidDepthRatio * 0.25 ||
      (
        input.bookImbalance <= -0.65 &&
        input.tradePressure <= -0.65 &&
        input.micropriceDeviationBps < 0
      );

    // v7.0.8: retain the signal for diagnostics and entry suppression, but never turn it
    // into a loss-making sell while the position remains above the -5% hard stop.
    return hold({ reason: softReason, streak: nextStreak, severe });
  }

  // v7.0.8: TIMEOUT is deliberately deleted as an exit condition. At and after 180 seconds,
  // a negative/flat position stays open; the target check above closes it immediately once
  // the estimated net result becomes positive.
  return hold();
}
