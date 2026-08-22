// Trading-booooo — separating money the strategy made from money that was moved in or out.
//
// Raw account equity answers "how much is in the account", never "how did the strategy do".
// Over one recent 24h window the venues moved 120 → 72 USDT, 67 → 619 USDT and
// 509,286 → 11,490 KRW; none of those deltas were trading results, and reporting them as a
// return produced numbers the operator could not reconcile against the exchange.
//
//   equity change   = trading PnL + capital flow
//   trading PnL     = realized + unrealized, measured on positions
//   capital flow    = deposits, withdrawals and internal venue transfers
//
// The spot/KRW lanes detect flow on the free quote balance, which the engine has always
// done. A cross-margin futures wallet cannot use that test — its available balance floats
// with every mark — so the futures lane compares the equity delta against the PnL the bot
// itself booked over the same interval. Both are record-only: a detected flow is a fact to
// report, never a reason to halt trading.

export type CapitalFlowType = "EXTERNAL_INCREASE" | "EXTERNAL_DECREASE";

export interface EquityCapitalFlowInput {
  previousEquityQuote: number;
  currentEquityQuote: number;
  /**
   * PnL the bot booked between the two observations: realized exits plus the change in
   * pure unrealized PnL on positions still open. Anything the equity did beyond this is,
   * by definition, not something the strategy did.
   */
  botPnlQuote: number;
  /** Deltas smaller than this are fees, funding and mark noise, not a transfer. */
  thresholdQuote: number;
}

export interface EquityCapitalFlow {
  detected: boolean;
  equityChangeQuote: number;
  expectedEquityQuote: number;
  externalDeltaQuote: number;
  flowType: CapitalFlowType | null;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function detectEquityCapitalFlow(input: EquityCapitalFlowInput): EquityCapitalFlow {
  const previous = finite(input.previousEquityQuote);
  const current = finite(input.currentEquityQuote);
  const botPnl = finite(input.botPnlQuote);
  const threshold = Math.max(0, finite(input.thresholdQuote));
  const expected = previous + botPnl;
  const externalDelta = current - expected;
  const detected = Math.abs(externalDelta) >= threshold && threshold > 0;
  return {
    detected,
    equityChangeQuote: current - previous,
    expectedEquityQuote: expected,
    externalDeltaQuote: externalDelta,
    flowType: !detected ? null : externalDelta > 0 ? "EXTERNAL_INCREASE" : "EXTERNAL_DECREASE",
  };
}

export interface TradingReturnInput {
  startEquityQuote: number;
  currentEquityQuote: number;
  /** Net deposits minus withdrawals recorded over the same window. */
  netCapitalFlowQuote: number;
}

export interface TradingReturn {
  startEquityQuote: number;
  currentEquityQuote: number;
  equityChangeQuote: number;
  netCapitalFlowQuote: number;
  /** Equity change with capital movement removed: what the strategy actually produced. */
  tradingPnlQuote: number;
  /** Trading PnL over the capital that was actually at work, or null when undefined. */
  tradingReturnPct: number | null;
  /** Raw equity change over start equity. Kept for continuity; it is not a return. */
  equityChangePct: number | null;
}

/**
 * A deposit must never read as profit.
 *
 * The denominator is the starting equity plus the capital that was added during the window,
 * so money that only worked for part of the window is not credited with a full-window
 * return, and a withdrawal does not inflate the percentage of what is left.
 */
export function tradingReturn(input: TradingReturnInput): TradingReturn {
  const start = finite(input.startEquityQuote);
  const current = finite(input.currentEquityQuote);
  const flow = finite(input.netCapitalFlowQuote);
  const equityChange = current - start;
  const tradingPnl = equityChange - flow;
  const base = start + Math.max(0, flow);
  return {
    startEquityQuote: start,
    currentEquityQuote: current,
    equityChangeQuote: equityChange,
    netCapitalFlowQuote: flow,
    tradingPnlQuote: tradingPnl,
    tradingReturnPct: base > 0 ? tradingPnl / base * 100 : null,
    equityChangePct: start > 0 ? equityChange / start * 100 : null,
  };
}

/** Sum of `trading_cash_flows` rows, signed so a withdrawal reduces the total. */
export function netCapitalFlowQuote(
  rows: readonly { flow_type?: unknown; amount_quote?: unknown }[],
): number {
  return rows.reduce((sum, row) => {
    const amount = Math.abs(finite(row.amount_quote));
    return sum +
      (String(row.flow_type || "").toUpperCase() === "EXTERNAL_DECREASE" ? -amount : amount);
  }, 0);
}
