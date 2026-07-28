// Trading-booooo v6.10.0 — exact exposure and marked-PnL helpers.
//
// Every capital decision must see both filled inventory and unfilled reservations. Every
// loss rail must see the economic value of an open position after already-paid fees and the
// estimated cost of liquidating the remaining quantity. These helpers are pure so the
// accounting assumptions are executable tests rather than comments in the orchestrator.

export interface ExposureLedgerRow {
  state?: string | null;
  remainingQuantity?: number | null;
  reservedQuote?: number | null;
  reservedQuantity?: number | null;
  averageEntryPrice?: number | null;
  plannedEntryPrice?: number | null;
  currentPrice?: number | null;
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
  markedNetPnlQuote: number;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function calculateExposureLedger(row: ExposureLedgerRow): ExposureLedgerResult {
  const remaining = Math.max(0, finite(row.remainingQuantity));
  const entry = Math.max(0, finite(row.averageEntryPrice, finite(row.plannedEntryPrice)));
  const current = Math.max(0, finite(row.currentPrice, entry));
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
  const markedNetPnlQuote = Math.max(0, finite(row.realizedProceedsQuote)) +
    liquidationValueQuote -
    Math.max(0, finite(row.realizedCostQuote)) -
    Math.max(0, finite(row.paidFeesQuote)) -
    estimatedExitCostQuote;

  return {
    filledExposureQuote,
    reservedExposureQuote,
    totalExposureQuote: filledExposureQuote + reservedExposureQuote,
    liquidationValueQuote,
    estimatedExitCostQuote,
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
