// Scalp safety rails (Stage 1 — pure decision helpers).
//
// These are SEPARATE from and stricter-in-intent than the global LIVE_LIMITED caps.
// Because paper validation is being skipped, these rails must exist BEFORE the
// loosened scalp entry logic goes live. They gate every scalp entry and can halt
// trading for the day or entirely.
//
// User-chosen values (2026-07-25):
//   perOrderPctOfCapital = 0.10   (1 order <= 10% of capital)
//   dailyLossPctOfCapital = 0.20  (halt new entries once day's realized loss >= 20%)
//   maxConsecutiveLosses = 4      (halt after 4 losses in a row)
//   killSwitch            = false (operator can flip to true to stop everything)
//
// Operator-selected hard backstops. The normal scalp stop remains much tighter;
// these limits guard against execution, data, or exit failures.

export interface ScalpSafetyConfig {
  perOrderPctOfCapital: number;   // fraction, 0.10 = 10%
  dailyLossPctOfCapital: number;  // fraction, 0.50 = 50%
  maxConsecutiveLosses: number;   // integer
  killSwitch: boolean;
}

export const DEFAULT_SCALP_SAFETY: ScalpSafetyConfig = {
  perOrderPctOfCapital: 0.10,
  dailyLossPctOfCapital: 0.20,
  maxConsecutiveLosses: 4,
  killSwitch: false,
};

export interface ScalpDayState {
  realizedPnlQuote: number;   // today's realized P&L in quote currency (losses negative)
  consecutiveLosses: number;  // current streak of losing closes
}

export interface EntryGateInput {
  capitalQuote: number;       // capital the bot manages for this exchange, in quote
  requestedNotional: number;  // planned order size in quote
  day: ScalpDayState;
}

export interface EntryGateResult {
  allow: boolean;
  cappedNotional: number;     // requestedNotional clamped to the per-order cap
  haltReason: string | null;  // set when trading should stop (not just this order)
}

/** Hard cap for a single scalp order, independent of the global gateway cap. */
export function scalpOrderCap(capitalQuote: number, cfg: ScalpSafetyConfig): number {
  return Math.max(0, capitalQuote * cfg.perOrderPctOfCapital);
}

/**
 * Decide whether a scalp entry may proceed. Order of checks:
 *   1) kill switch          -> halt everything
 *   2) daily loss limit hit  -> halt for the day
 *   3) consecutive losses    -> halt for the day
 *   4) clamp order to per-order cap
 */
export function evaluateEntryGate(input: EntryGateInput, cfg: ScalpSafetyConfig): EntryGateResult {
  if (cfg.killSwitch) {
    return { allow: false, cappedNotional: 0, haltReason: "kill_switch" };
  }
  const dailyLossLimit = -Math.abs(input.capitalQuote * cfg.dailyLossPctOfCapital);
  if (input.day.realizedPnlQuote <= dailyLossLimit) {
    return { allow: false, cappedNotional: 0, haltReason: "daily_loss_limit" };
  }
  if (input.day.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    return { allow: false, cappedNotional: 0, haltReason: "consecutive_losses" };
  }
  const cap = scalpOrderCap(input.capitalQuote, cfg);
  const cappedNotional = Math.min(input.requestedNotional, cap);
  return { allow: cappedNotional > 0, cappedNotional, haltReason: null };
}

/** Update the day state after a close. Call once per realized exit. */
export function applyClose(day: ScalpDayState, realizedPnlQuote: number): ScalpDayState {
  return {
    realizedPnlQuote: day.realizedPnlQuote + realizedPnlQuote,
    consecutiveLosses: realizedPnlQuote < 0 ? day.consecutiveLosses + 1 : 0,
  };
}
