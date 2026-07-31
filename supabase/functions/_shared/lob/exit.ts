// Trading-booooo v7.1.1 — LOB exit policy: profit opportunity or -5% hard stop.
// The 180-second horizon is informational only and never forces a losing exit.

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
  if (Number.isFinite(input.stopPrice) && input.stopPrice > 0 && input.currentPrice <= input.stopPrice) {
    return hard("STOP_HIT", 90);
  }
  if (Number.isFinite(input.targetPrice) && input.targetPrice > 0 && input.currentPrice >= input.targetPrice) {
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
    const confirmations = Math.max(1, Math.floor(Number(input.softExitConfirmations) || 2));
    const graceSeconds = Math.max(0, Number(input.softExitGraceSeconds) || 15);
    const severe = input.spreadBps > input.maxSpreadBps * 2 ||
      input.bidDepthRatio < input.minBidDepthRatio * 0.25 ||
      (input.bookImbalance <= -0.65 && input.tradePressure <= -0.65 && input.micropriceDeviationBps < 0);
    if (severe || (input.heldSeconds >= graceSeconds && nextStreak >= confirmations)) {
      return hard(softReason, severe ? 82 : 78);
    }
    return hold({ reason: softReason, streak: nextStreak, severe });
  }

  // Deliberately no TIMEOUT branch. Continue holding after 180 seconds until a fee-net
  // profitable exit is available or the configured -5% hard stop is reached.
  return hold();
}
