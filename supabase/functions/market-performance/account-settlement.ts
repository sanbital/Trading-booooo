// Trading-booooo v6.11.0 r6 — settling a trade against the real account.
//
// The ledger is authoritative for what the bot did; the account is authoritative for what
// is actually held. Where they disagree the difference left the account outside our own
// orders — a manual sell or a withdrawal — and the trade has to be settled at the last
// observed price instead of being carried forward as a live holding.
//
// Two ledger shapes reach here:
//
//   open row    the balance comparison happened just now, in `holding`
//   CLOSED row  the engine already reconciled it and wrote `manual_reconcile` metadata,
//               along with `realized_pnl_quote = 0` from `manualReconcileAccounting`.
//               That zero is precisely why manual sells never reached the exchange
//               totals, so it is recomputed here rather than trusted.

import { estimateManualExit, type Holding } from "../_shared/position-value.ts";

function finite(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export interface RecordedManualExit {
  missing_quantity?: unknown;
  estimated_value_quote?: unknown;
}

export interface SettlementInput {
  /** The position row is already CLOSED in the ledger. */
  closedByLedger: boolean;
  /** Balance comparison for an open row; null for a CLOSED row. */
  holding: Holding | null;
  /** `metadata.manual_reconcile` written by the engine when it closed the row. */
  recordedManualExit: RecordedManualExit | null;
  /** Ledger quantity, used when no balance comparison is available. */
  remainingQuantity: number;
  currentPrice: number;
  /** Per-side taker fee as a percentage, e.g. 0.1 for Binance. */
  feePctPerSide: number;
  entryFundsQuote: number;
  entryFeesQuote: number;
  exitFundsQuote: number;
  exitFeesQuote: number;
  /** Dust the engine deliberately retained on a CLOSED row. */
  residualValueQuote: number;
  /** `realized_pnl_quote` as recorded, or null when absent. */
  ledgerRealizedPnlQuote: unknown;
}

export interface Settlement {
  /** The account says this open row is finished, whatever the ledger still claims. */
  settledByAccount: boolean;
  isClosed: boolean;
  heldQuantity: number;
  currentValueQuote: number;
  manualExitQuantity: number;
  manualExitGrossQuote: number;
  manualExitFeeQuote: number;
  manualExitProceedsQuote: number;
  manualExitEstimated: boolean;
  totalFeesQuote: number;
  grossPnlQuote: number;
  netPnlQuote: number;
  investedCostQuote: number;
  returnPct: number;
  closeReasonHint: string | null;
}

export function settleTrade(input: SettlementInput): Settlement {
  const holding = input.closedByLedger ? null : input.holding;
  const currentPrice = Math.max(0, finite(input.currentPrice));
  const recorded = input.closedByLedger ? input.recordedManualExit : null;
  const manualExitQuantity = holding
    ? holding.missingQuantity
    : Math.max(0, finite(recorded?.missing_quantity));
  const manualExit = manualExitQuantity > 0
    ? estimateManualExit({
      missingQuantity: manualExitQuantity,
      markPrice: currentPrice,
      feePctPerSide: input.feePctPerSide,
      // The engine marked the value when the coin actually left. That beats re-marking
      // at whatever the price happens to be now.
      grossProceedsQuote: recorded ? Math.max(0, finite(recorded.estimated_value_quote)) : null,
    })
    : null;

  // An open row whose remaining value is a dollar or less — sold by hand, or worn down to
  // dust — is a settled trade, not a position.
  const settledByAccount = Boolean(holding?.isDust);
  const heldQuantity = holding
    ? holding.effectiveQuantity
    : Math.max(0, finite(input.remainingQuantity));
  const residualValueQuote = Math.max(0, finite(input.residualValueQuote));
  const currentValueQuote = input.closedByLedger ? residualValueQuote : heldQuantity * currentPrice;

  const entryFunds = Math.max(0, finite(input.entryFundsQuote));
  const entryFees = Math.max(0, finite(input.entryFeesQuote));
  const exitFunds = Math.max(0, finite(input.exitFundsQuote));
  const exitFees = Math.max(0, finite(input.exitFeesQuote));
  const manualGross = manualExit?.grossProceedsQuote ?? 0;
  const manualFee = manualExit?.feeQuote ?? 0;
  const manualNet = manualExit?.netProceedsQuote ?? 0;

  const totalFeesQuote = entryFees + exitFees + manualFee;
  const grossPnlQuote = exitFunds + manualGross + currentValueQuote - entryFunds;
  const calculatedNetPnl = exitFunds - exitFees + manualNet + currentValueQuote -
    entryFunds - entryFees;
  // `realized_pnl_quote` is trusted only when the engine actually measured the exit.
  const netPnlQuote = input.closedByLedger && manualExitQuantity <= 0
    ? finite(input.ledgerRealizedPnlQuote, calculatedNetPnl)
    : calculatedNetPnl;
  const investedCostQuote = entryFunds + entryFees;

  return {
    settledByAccount,
    isClosed: input.closedByLedger || settledByAccount,
    heldQuantity,
    currentValueQuote,
    manualExitQuantity,
    manualExitGrossQuote: manualGross,
    manualExitFeeQuote: manualFee,
    manualExitProceedsQuote: manualNet,
    manualExitEstimated: Boolean(manualExit),
    totalFeesQuote,
    grossPnlQuote,
    netPnlQuote,
    investedCostQuote,
    returnPct: investedCostQuote > 0 ? netPnlQuote / investedCostQuote * 100 : 0,
    closeReasonHint: settledByAccount
      ? (holding?.vanished ? "MANUAL_SELL_RECONCILED" : "DUST_BELOW_MIN_VALUE")
      : null,
  };
}
