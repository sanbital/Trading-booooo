// Scalp holding decision (v5.4) — live edge instead of a wall clock.
//
// WHAT THIS REPLACES
// ------------------
// v5.2.5 / v5.3 closed every scalp position at `max_holding_at`, a flat 30 minutes.
// That number never came from the profit logic — it was a safety timeout added when the
// pivot to scalping happened, under a fixed +0.60% / -0.30% barrier, on the assumption
// that "if it hasn't moved in 30 minutes the signal is dead".
//
// With per-symbol volatility-scaled barriers that assumption is simply false: the time a
// symbol needs to travel its own target varies by several multiples, and a flat clock
// force-sells positions whose thesis is still intact while holding others long past the
// point where it isn't. A time exit is also the worst kind of exit — it pays a full round
// trip for an outcome that is neither a win nor a loss.
//
// THE RULE NOW
// ------------
// A position is not sold because time passed. It is sold when the reason for entering it
// has stopped being true, priced against what it still costs to get out.
//
//     liveEdge = pWinNow * remainingUpside - (1 - pWinNow) * remainingDownside - exitCost
//
// Three things about that formula matter:
//
//   1) `remainingUpside` is measured from the CURRENT price to the target, not from the
//      entry. Half the move already made is not still available.
//   2) `exitCost` is ONE side only. The entry fee and entry slippage are sunk. Charging
//      the round trip again would liquidate positions that are still worth holding.
//   3) `pWinNow` decays. The orderbook reading that justified the entry has a half-life
//      measured in seconds to minutes; as it ages, the live book carries the weight and
//      the entry signal fades out of the estimate. Time therefore still matters — as a
//      confidence decay, not as a trigger.
//
// Absolute time survives only as a backstop against stuck ledgers and broken monitors,
// at a horizon the operator sets (default 6 hours, not 30 minutes).
//
// Pure functions only — no I/O.

export interface ScalpHoldConfig {
  /** Half-life, in minutes, of the entry signal's contribution to pWin. */
  alphaHalfLifeMinutes: number;
  /** Base rate the entry signal decays toward. */
  basePWin: number;
  /** Weight given to the live top-of-book imbalance once the entry signal has faded. */
  liveImbalanceWeight: number;
  /** One-side exit cost (fee + expected slippage) as a fraction. */
  exitCostFraction: number;
  /**
   * Edge required to keep holding once the position is past its expected resolution
   * time. Before that point the bar is simply "edge > 0".
   */
  minEdgeAfterExpected: number;
  /** Live imbalance at or below this is treated as an orderbook reversal. */
  reversalImbalance: number;
  /** Consecutive reversal observations required before acting on it. */
  reversalConfirmations: number;
  /** Absolute backstop. Not a trading rule — a stuck-ledger guard. */
  safetyTtlMinutes: number;
  pWinFloor: number;
  pWinCeil: number;
}

export const DEFAULT_SCALP_HOLD: ScalpHoldConfig = {
  alphaHalfLifeMinutes: 12,
  basePWin: 0.52,
  liveImbalanceWeight: 0.18,
  exitCostFraction: 0.0008,
  minEdgeAfterExpected: 0.0005,
  reversalImbalance: -0.25,
  reversalConfirmations: 2,
  safetyTtlMinutes: 360,
  pWinFloor: 0.05,
  pWinCeil: 0.95,
};

export const HOLD_BOUNDS: Record<string, { min: number; max: number }> = {
  alphaHalfLifeMinutes: { min: 1, max: 240 },
  liveImbalanceWeight: { min: 0, max: 0.4 },
  exitCostFraction: { min: 0, max: 0.01 },
  minEdgeAfterExpected: { min: 0, max: 0.01 },
  reversalImbalance: { min: -1, max: 0 },
  reversalConfirmations: { min: 1, max: 10 },
  safetyTtlMinutes: { min: 10, max: 10_080 },
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function resolveHoldConfig(overrides: Partial<ScalpHoldConfig> = {}): ScalpHoldConfig {
  const merged: ScalpHoldConfig = { ...DEFAULT_SCALP_HOLD, ...overrides };
  for (const key of Object.keys(HOLD_BOUNDS)) {
    const bound = HOLD_BOUNDS[key];
    const value = (merged as unknown as Record<string, number>)[key];
    (merged as unknown as Record<string, number>)[key] = Number.isFinite(value)
      ? clamp(value, bound.min, bound.max)
      : (DEFAULT_SCALP_HOLD as unknown as Record<string, number>)[key];
  }
  return merged;
}

/** Live-flow danger states that end a position immediately, regardless of edge. */
export const HOLD_RISK_STATUSES = new Set([
  "SPOOF_LIKE_RISK",
  "ASK_ABSORPTION_RISK",
  "SUPPORT_BREAKDOWN_RISK",
]);

export interface HoldInputs {
  entryPrice: number;
  currentPrice: number;
  targetPrice: number;
  stopPrice: number;
  /** pWin the model held at entry (already calibrated). */
  entryPWin: number;
  /** Top-of-book imbalance right now, -1..1. */
  liveImbalance: number;
  /** Consecutive prior observations of a reversed book. */
  reversalStreak: number;
  /** v5.7: barrier-implied baseline the entry edge was measured against. 0 = unknown. */
  neutralWinRate?: number;
  heldMinutes: number;
  /** Volatility-derived expected time to resolution, from geometry.ts. */
  expectedMinutes: number;
  /** Live orderflow status, when available. */
  dynamicStatus?: string;
  /** 4h trend signal, when available — a hard flip is a real exit reason. */
  h4TrendSignal?: number | null;
  strongDownVeto?: number;
  t1Completed?: boolean;
}

export interface HoldDecision {
  action: "HOLD" | "TIGHTEN" | "EXIT";
  reason: string;
  liveEdge: number;
  livePWin: number;
  remainingUpside: number;
  remainingDownside: number;
  pastExpected: boolean;
  reversalStreak: number;
}

/**
 * Decay the entry probability toward the base rate and re-weight it with the live book.
 * Mirrors refreshPWinAtOrderTime() in signal.ts, but on a minutes scale: a position that
 * has been open for a while is governed by what the book says now, not by the reading
 * that opened it.
 */
export function decayedPWin(
  entryPWin: number,
  liveImbalance: number,
  heldMinutes: number,
  cfg: ScalpHoldConfig = DEFAULT_SCALP_HOLD,
  neutralWinRate = 0,
): number {
  // v5.7: decay toward the BARRIER BASELINE. A stale signal leaves the geometry, not a
  // flat 0.52 that has nothing to do with where this position's target and stop sit.
  const anchor = neutralWinRate > 0 ? neutralWinRate : cfg.basePWin;
  const decay = Math.pow(0.5, Math.max(0, heldMinutes) / Math.max(0.01, cfg.alphaHalfLifeMinutes));
  const carried = (entryPWin - anchor) * decay;
  const live = clamp(liveImbalance, -0.40, 0.60) * cfg.liveImbalanceWeight * (1 - decay);
  return clamp(anchor + carried + live, cfg.pWinFloor, cfg.pWinCeil);
}

export function evaluateHold(
  input: HoldInputs,
  cfg: ScalpHoldConfig = DEFAULT_SCALP_HOLD,
): HoldDecision {
  const price = input.currentPrice;
  const reversed = input.liveImbalance <= cfg.reversalImbalance;
  const reversalStreak = reversed ? Math.max(0, input.reversalStreak) + 1 : 0;
  const livePWin = decayedPWin(input.entryPWin, input.liveImbalance, input.heldMinutes, cfg, input.neutralWinRate ?? 0);
  const pastExpected = input.expectedMinutes > 0 && input.heldMinutes >= input.expectedMinutes;

  // Upside still available FROM HERE, and risk still at stake from here.
  const remainingUpside = price > 0 ? Math.max(0, (input.targetPrice - price) / price) : 0;
  const remainingDownside = price > 0 ? Math.max(0, (price - input.stopPrice) / price) : 0;
  // Exit cost only. The entry leg is sunk.
  const liveEdge = livePWin * remainingUpside - (1 - livePWin) * remainingDownside - cfg.exitCostFraction;

  const base = { liveEdge, livePWin, remainingUpside, remainingDownside, pastExpected, reversalStreak };

  // --- hard exits: the entry thesis is not merely weaker, it is contradicted -----------
  if (input.dynamicStatus && HOLD_RISK_STATUSES.has(input.dynamicStatus)) {
    return { action: "EXIT", reason: `live_risk_${input.dynamicStatus.toLowerCase()}`, ...base };
  }
  if (
    input.h4TrendSignal != null && Number.isFinite(input.h4TrendSignal) &&
    input.h4TrendSignal <= (input.strongDownVeto ?? -0.65)
  ) {
    return { action: "EXIT", reason: "trend_flipped_strong_down", ...base };
  }
  if (reversalStreak >= cfg.reversalConfirmations) {
    return { action: "EXIT", reason: "orderbook_reversal_confirmed", ...base };
  }

  // --- economic exit ------------------------------------------------------------------
  // Before the expected resolution time the bar is simply "still positive". After it, the
  // position must justify continued occupancy of a slot.
  const requiredEdge = pastExpected ? cfg.minEdgeAfterExpected : 0;
  if (liveEdge < requiredEdge) {
    // In profit with a faded edge, tighten rather than dump — the trailing stop can still
    // capture more than an immediate market sell, and the runner is already protected at
    // breakeven once T1 is done.
    if (input.t1Completed && price > input.entryPrice) {
      return { action: "TIGHTEN", reason: pastExpected ? "edge_faded_past_expected" : "edge_faded", ...base };
    }
    return { action: "EXIT", reason: pastExpected ? "edge_below_hold_threshold" : "edge_negative", ...base };
  }

  return { action: "HOLD", reason: pastExpected ? "edge_intact_past_expected" : "edge_intact", ...base };
}

/**
 * The absolute backstop. This is deliberately NOT part of evaluateHold: it is not a
 * trading judgement, it is protection against a stuck ledger or a monitor that stopped
 * updating. Operator-configurable; default 6 hours.
 */
export function safetyTtlExceeded(heldMinutes: number, cfg: ScalpHoldConfig = DEFAULT_SCALP_HOLD): boolean {
  return heldMinutes >= cfg.safetyTtlMinutes;
}
