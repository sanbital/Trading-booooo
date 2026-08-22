// Trading-booooo — one source of truth for what "PnL on an open position" means.
//
// Three different quantities were all being called PnL, and two of them were being written
// into the same column:
//
//   pure unrealized  side-aware (mark − entry) × REMAINING quantity. Nothing that has
//                    already been sold belongs in it.
//   realized-so-far  the partial take-profit money already booked on a still-open row.
//   lifecycle        the sum of the two: everything this open position has earned since
//                    entry, which is what `markedOpenPnlQuote` reports to the SCAN circuit.
//
// `trading_account_snapshots.bot_unrealized_pnl_quote` must be the first of those. It was
// being filled from `calculateExposureLedger().markedNetPnlQuote`, which is the third —
// and because the mark price never actually reached that call (the monitor only collected
// quotes for non-P10 markets) it degenerated into the second, reporting realized partial
// profit as if it were the mark-to-market value of the remaining contracts.
//
// These helpers are pure so the distinction is enforced by tests instead of by comment.

export type PositionSide = "LONG" | "SHORT";

export interface OpenPositionPnlRow {
  positionSide?: string | null;
  remainingQuantity?: number | null;
  averageEntryPrice?: number | null;
  plannedEntryPrice?: number | null;
  markPrice?: number | null;
  /** Money already booked by earlier partial exits on this same still-open row. */
  realizedPnlQuote?: number | null;
  /** Per-side taker cost as a fraction, e.g. 0.0005 for 0.05%. */
  estimatedExitCostPct?: number | null;
}

export interface OpenPositionPnl {
  side: PositionSide;
  entryPrice: number;
  markPrice: number;
  remainingQuantity: number;
  /** Contract value still exposed, marked. */
  openNotionalQuote: number;
  /** (mark − entry) × remaining, sign-corrected for SHORT. Nothing else. */
  pureUnrealizedPnlQuote: number;
  realizedPnlQuote: number;
  /** pureUnrealized + realized. Never write this into bot_unrealized_pnl_quote. */
  lifecyclePnlQuote: number;
  /** Fee cost of liquidating the remaining quantity at the mark. */
  estimatedExitCostQuote: number;
  /** pureUnrealized less the estimated cost of closing the remainder. */
  netUnrealizedPnlQuote: number;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolvePositionSide(value: unknown): PositionSide {
  return String(value || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

/**
 * First usable mark in preference order, falling back to the entry price.
 *
 * A missing quote must degrade to "flat", never to a stale or zero mark: entry is the only
 * fallback that reports no invented profit. The caller supplies the candidates in the order
 * it trusts them — the monitor's own fresh quote first, then the venue portfolio's price
 * table, which is what `managedPortfolio` and the SCAN diagnostics already read.
 */
export function resolveMarkPrice(candidates: readonly unknown[], entryPrice: unknown): number {
  for (const candidate of candidates) {
    const price = finite(candidate);
    if (price > 0) return price;
  }
  return Math.max(0, finite(entryPrice));
}

export function openPositionPnl(row: OpenPositionPnlRow): OpenPositionPnl {
  const side = resolvePositionSide(row.positionSide);
  const remaining = Math.max(0, finite(row.remainingQuantity));
  const entry = Math.max(0, finite(row.averageEntryPrice, finite(row.plannedEntryPrice)));
  const mark = resolveMarkPrice([row.markPrice], entry);
  const direction = side === "SHORT" ? -1 : 1;
  const pureUnrealized = (mark - entry) * remaining * direction;
  const openNotional = remaining * mark;
  const exitCost = openNotional * Math.max(0, finite(row.estimatedExitCostPct));
  const realized = finite(row.realizedPnlQuote);
  return {
    side,
    entryPrice: entry,
    markPrice: mark,
    remainingQuantity: remaining,
    openNotionalQuote: openNotional,
    pureUnrealizedPnlQuote: pureUnrealized,
    realizedPnlQuote: realized,
    lifecyclePnlQuote: pureUnrealized + realized,
    estimatedExitCostQuote: exitCost,
    netUnrealizedPnlQuote: pureUnrealized - exitCost,
  };
}

export interface OpenPositionPnlTotals {
  pureUnrealizedPnlQuote: number;
  realizedPnlQuote: number;
  lifecyclePnlQuote: number;
  netUnrealizedPnlQuote: number;
  openNotionalQuote: number;
  positions: number;
}

export function sumOpenPositionPnl(rows: readonly OpenPositionPnlRow[]): OpenPositionPnlTotals {
  const totals: OpenPositionPnlTotals = {
    pureUnrealizedPnlQuote: 0,
    realizedPnlQuote: 0,
    lifecyclePnlQuote: 0,
    netUnrealizedPnlQuote: 0,
    openNotionalQuote: 0,
    positions: 0,
  };
  for (const row of rows) {
    const pnl = openPositionPnl(row);
    totals.pureUnrealizedPnlQuote += pnl.pureUnrealizedPnlQuote;
    totals.realizedPnlQuote += pnl.realizedPnlQuote;
    totals.lifecyclePnlQuote += pnl.lifecyclePnlQuote;
    totals.netUnrealizedPnlQuote += pnl.netUnrealizedPnlQuote;
    totals.openNotionalQuote += pnl.openNotionalQuote;
    totals.positions += 1;
  }
  return totals;
}
