// Trading-booooo v6.10.0 — exact exposure and marked-PnL helpers.
//
// Every capital decision must see both filled inventory and unfilled reservations. Every
// loss rail must see the economic value of an open position after already-paid fees and the
// estimated cost of liquidating the remaining quantity. These helpers are pure so the
// accounting assumptions are executable tests rather than comments in the orchestrator.

export interface ExposureLedgerRow {
  state?: string | null;
  initialQuantity?: number | null;
  remainingQuantity?: number | null;
  reservedQuote?: number | null;
  reservedQuantity?: number | null;
  averageEntryPrice?: number | null;
  plannedEntryPrice?: number | null;
  currentPrice?: number | null;
  /** Backward-compatible alias used by the live monitor call sites. */
  markPrice?: number | null;
  realizedCostQuote?: number | null;
  realizedProceedsQuote?: number | null;
  paidFeesQuote?: number | null;
  residualValueQuote?: number | null;
  estimatedExitCostPct?: number | null;
}

export interface ExposureLedgerResult {
  filledExposureQuote: number;
  reservedExposureQuote: number;
  totalExposureQuote: number;
  liquidationValueQuote: number;
  estimatedExitCostQuote: number;
  /** Full economic entry basis used for mark-to-market PnL. */
  markedCostBasisQuote: number;
  markedNetPnlQuote: number;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function calculateExposureLedger(row: ExposureLedgerRow): ExposureLedgerResult {
  const initial = Math.max(0, finite(row.initialQuantity, finite(row.remainingQuantity)));
  const remaining = Math.max(0, finite(row.remainingQuantity));
  const entry = Math.max(0, finite(row.averageEntryPrice, finite(row.plannedEntryPrice)));
  // Some live monitor paths historically called this field markPrice while reservation
  // paths used currentPrice. Accept both explicitly so a live mark can never silently
  // fall back to the entry price.
  const current = Math.max(0, finite(row.currentPrice, finite(row.markPrice, entry)));
  const reservedQuote = Math.max(0, finite(row.reservedQuote));
  const reservedQuantity = Math.max(0, finite(row.reservedQuantity));
  const reservationMark = reservedQuantity > 0 && current > 0 ? reservedQuantity * current : 0;
  // Reservations are a quote ceiling, not an additional position. Use the more conservative
  // of the persisted quote reservation and the marked requested quantity.
  const reservedExposureQuote = Math.max(reservedQuote, reservationMark);
  const filledEntryValue = remaining * entry;
  const filledCurrentValue = remaining * current;
  // A winning position must not create fake free capacity. Exposure is the larger of entry
  // cost and current mark, matching the fixed-allocation semantics used by managed capital.
  const filledExposureQuote = Math.max(filledEntryValue, filledCurrentValue);
  const exitCostPct = Math.max(0, finite(row.estimatedExitCostPct));
  const estimatedExitCostQuote = filledCurrentValue * exitCostPct;
  const liquidationValueQuote = filledCurrentValue + Math.max(0, finite(row.residualValueQuote));
  const persistedCostBasis = Math.max(0, finite(row.realizedCostQuote));
  // Futures OPEN rows intentionally do not book realized_cost_quote until reconciliation.
  // Their economic basis still exists: it is the filled contract quantity at average entry.
  // Spot rows already persist realized_cost_quote, so that canonical value continues to win.
  const markedCostBasisQuote = persistedCostBasis > 0 ? persistedCostBasis : initial * entry;
  const markedNetPnlQuote = Math.max(0, finite(row.realizedProceedsQuote)) +
    liquidationValueQuote -
    markedCostBasisQuote -
    Math.max(0, finite(row.paidFeesQuote)) -
    estimatedExitCostQuote;

  return {
    filledExposureQuote,
    reservedExposureQuote,
    totalExposureQuote: filledExposureQuote + reservedExposureQuote,
    liquidationValueQuote,
    estimatedExitCostQuote,
    markedCostBasisQuote,
    markedNetPnlQuote,
  };
}

export function reservationAfterFill(
  reservedQuote: number,
  reservedQuantity: number,
  filledFundsQuote: number,
  filledQuantity: number,
): { reservedQuote: number; reservedQuantity: number } {
  return {
    reservedQuote: Math.max(0, finite(reservedQuote) - Math.max(0, finite(filledFundsQuote))),
    reservedQuantity: Math.max(0, finite(reservedQuantity) - Math.max(0, finite(filledQuantity))),
  };
}
