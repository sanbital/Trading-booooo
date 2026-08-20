// Scalp safety rails (Stage 1 — pure decision helpers).
//
// These are SEPARATE from and stricter-in-intent than the global LIVE_LIMITED caps.
// Because paper validation is being skipped, these rails must exist BEFORE the
// loosened scalp entry logic goes live. They gate every scalp entry and can halt
// trading for the day or entirely.
//
// User-chosen values (2026-07-25):
//   perOrderPctOfCapital = 1.00   (no extra cap beyond operator allocation)
//   dailyLossPctOfCapital = 0.20  (halt new entries once day's realized loss >= 20%)
//   maxConsecutiveLosses = unlimited (no unapproved streak cap)
//   killSwitch            = false (operator can flip to true to stop everything)
//
// Operator-selected hard backstops. The normal scalp stop remains much tighter;
// these limits guard against execution, data, or exit failures.

export interface ScalpSafetyConfig {
  perOrderPctOfCapital: number; // 1.00 = full operator-managed allocation
  dailyLossPctOfCapital: number; // fraction, 0.50 = 50%
  maxConsecutiveLosses: number; // integer
  killSwitch: boolean;
}

export const DEFAULT_SCALP_SAFETY: ScalpSafetyConfig = {
  perOrderPctOfCapital: 1.00,
  dailyLossPctOfCapital: 0.20,
  maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
  killSwitch: false,
};

export interface ScalpDayState {
  realizedPnlQuote: number; // today's realized P&L in quote currency (losses negative)
  consecutiveLosses: number; // current streak of losing closes
  dailySeedEquityQuote?: number; // first account equity snapshot after KST midnight
  markedOpenPnlQuote?: number; // current fee-net marked P&L for open positions
}

export interface EntryGateInput {
  capitalQuote: number; // capital the bot manages for this exchange, in quote
  requestedNotional: number; // planned order size in quote
  day: ScalpDayState;
}

export interface EntryGateResult {
  allow: boolean;
  cappedNotional: number; // requestedNotional bounded only by operator allocation
  haltReason: string | null; // set when trading should stop (not just this order)
}

/** No extra account-percentage cap: operator allocation is authoritative. */
export function scalpOrderCap(capitalQuote: number, cfg: ScalpSafetyConfig): number {
  return Math.max(0, capitalQuote * cfg.perOrderPctOfCapital);
}

/**
 * Decide whether a scalp entry may proceed. Order of checks:
 *   1) kill switch          -> halt everything
 *   2) daily loss limit hit  -> halt for the day
 *   3) optional consecutive-loss policy
 *   4) keep the order inside the operator-managed allocation
 */
export function evaluateEntryGate(input: EntryGateInput, cfg: ScalpSafetyConfig): EntryGateResult {
  if (cfg.killSwitch) {
    return { allow: false, cappedNotional: 0, haltReason: "kill_switch" };
  }
  const dailySeed = input.day.dailySeedEquityQuote && input.day.dailySeedEquityQuote > 0
    ? input.day.dailySeedEquityQuote
    : input.capitalQuote;
  const dailyEconomicPnl = input.day.realizedPnlQuote +
    (input.day.markedOpenPnlQuote ?? 0);
  const dailyLossLimit = -Math.abs(dailySeed * cfg.dailyLossPctOfCapital);
  if (dailyEconomicPnl <= dailyLossLimit) {
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
