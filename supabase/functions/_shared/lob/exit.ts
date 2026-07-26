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
}

export interface LobExitDecision {
  exit: boolean;
  reason: LobExitReason;
  priority: number;
}

/** Required deterministic priority from the development brief. */
export function evaluateLobExit(input: LobExitInput): LobExitDecision {
  if (input.emergency) return { exit: true, reason: "RISK_EMERGENCY", priority: 100 };
  if (input.reconciliationFailed) return { exit: true, reason: "RECONCILIATION_FAILURE", priority: 95 };
  if (input.currentPrice <= input.stopPrice) return { exit: true, reason: "STOP_HIT", priority: 90 };

  const invalidStatus = new Set(["SUPPORT_BREAKDOWN_RISK", "SPOOF_LIKE_RISK", "ASK_ABSORPTION_RISK"]);
  if (invalidStatus.has(String(input.dynamicStatus || "")) || input.spreadBps > input.maxSpreadBps ||
    input.bidDepthRatio < input.minBidDepthRatio) {
    return { exit: true, reason: "LOB_INVALIDATION", priority: 80 };
  }
  if (input.bookImbalance <= -0.20 && input.tradePressure <= -0.20 && input.micropriceDeviationBps < 0) {
    return { exit: true, reason: "SIGNAL_REVERSAL", priority: 70 };
  }
  if (input.currentPrice >= input.targetPrice) return { exit: true, reason: "TARGET_HIT", priority: 60 };
  if (input.heldSeconds >= input.maxHoldingSeconds) return { exit: true, reason: "TIMEOUT", priority: 50 };
  return { exit: false, reason: "HOLD", priority: 0 };
}
