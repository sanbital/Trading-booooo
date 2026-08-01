// Trading-booooo v7.2.4 — persistent order-book trailing exits for LOB positions.
// Planned stops remain immediate. Before 180 seconds, reaching the stored target arms
// a persistent trailing take-profit instead of forcing an immediate fixed-price exit.
// The canonical post-180 executable-net and -2% hard-stop policy remains in the monitor.

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

// The monitor already persists nextSoftSignalStreak on every pass. Negative values below
// this base are reserved for the armed target-trail peak, so the trail survives stateless
// edge-function invocations without a schema change or a second exit code path.
const TARGET_TRAIL_STATE_BASE = 1_000_000;
const TARGET_TRAIL_MIN_BPS = 8;
const TARGET_TRAIL_MAX_BPS = 24;
const TARGET_TRAIL_POLICY_SECONDS = 180;

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

function encodeTargetTrailPeakBps(peakBps: number): number {
  return -(TARGET_TRAIL_STATE_BASE + Math.max(0, Math.round(peakBps)));
}

function decodeTargetTrailPeakBps(value: number | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric > -TARGET_TRAIL_STATE_BASE) return null;
  return Math.max(0, -Math.round(numeric) - TARGET_TRAIL_STATE_BASE);
}

function holdTargetTrail(peakBps: number): LobExitDecision {
  return {
    exit: false,
    reason: "HOLD",
    priority: 0,
    nextSoftReason: null,
    nextSoftSignalStreak: encodeTargetTrailPeakBps(peakBps),
    severeSoftSignal: false,
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

  // The scanner's planned stop no longer terminates a position on touch. It was firing
  // within seconds of entry — a 29s exit at -38bp is the shape of it — which is the
  // opposite of the policy: before 180 seconds only a confirmed book breakdown may sell,
  // and the sole price-based floor is the -2% emergency stop. That floor needs the exact
  // cost basis and fee schedule, so the monitor owns it; this function no longer has a
  // price-triggered stop of its own. stopPrice is retained on the input for callers that
  // still report it.

  const validTarget = Number.isFinite(input.targetPrice) && input.targetPrice > 0
    ? input.targetPrice
    : 0;
  const storedTrailPeakBps = decodeTargetTrailPeakBps(input.softSignalStreak);
  const targetReached = validTarget > 0 && input.currentPrice >= validTarget;
  const targetTrailArmed = input.heldSeconds < TARGET_TRAIL_POLICY_SECONDS &&
    validTarget > 0 &&
    (targetReached || storedTrailPeakBps !== null);

  if (targetTrailArmed) {
    const currentPeakBps = Math.max(0, (input.currentPrice / validTarget - 1) * 10_000);
    const peakBps = Math.max(storedTrailPeakBps ?? 0, currentPeakBps);
    const peakPrice = validTarget * (1 + peakBps / 10_000);
    const safeSpreadBps = Number.isFinite(input.spreadBps)
      ? Math.max(0, input.spreadBps)
      : TARGET_TRAIL_MIN_BPS;
    const trailDistanceBps = Math.min(
      TARGET_TRAIL_MAX_BPS,
      Math.max(TARGET_TRAIL_MIN_BPS, safeSpreadBps * 0.75),
    );
    // Never move the protective trail below the original economically viable target.
    const trailStopPrice = Math.max(
      validTarget,
      peakPrice * (1 - trailDistanceBps / 10_000),
    );
    // A target exit is executed as a protected limit at or above the stored target, so it
    // can only fill while the book still trades there. Emitting it after the target floor
    // is already lost produced an order with no bids to match: over 72h every one of those
    // exits was blocked and the position ran on to a loss (TARGET_NET_GUARD_BREACH, 20 for
    // 20). So the trail fires while price is still at or above the target, and a book that
    // gaps straight through the floor disarms the trail and returns to ordinary
    // evaluation — where the planned stop and the soft signals can still act — instead of
    // requesting a sell that cannot execute.
    if (input.currentPrice < validTarget) {
      return hold();
    }
    if (input.currentPrice <= trailStopPrice) {
      return hard("TARGET_HIT", 85);
    }

    return holdTargetTrail(peakBps);
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
      (input.bookImbalance <= -0.65 && input.tradePressure <= -0.65 &&
        input.micropriceDeviationBps < 0);
    // Never convert a transient or even severe soft signal directly into a sell here.
    // Continuous elapsed time is enforced by market-autotrader before 180 seconds.
    return hold({ reason: softReason, streak: nextStreak, severe });
  }

  return hold();
}
