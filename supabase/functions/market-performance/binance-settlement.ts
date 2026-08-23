export type BinanceSettlementFill = {
  side?: unknown;
  quantity?: unknown;
  quote_amount?: unknown;
  fee_amount?: unknown;
  fee_asset?: unknown;
  fee_quote_amount?: unknown;
  base_asset?: unknown;
};

export type BinancePositionSide = "LONG" | "SHORT";

export type BinanceFillSettlement = {
  positionSide: BinancePositionSide;
  entrySide: "BUY" | "SELL";
  exitSide: "BUY" | "SELL";
  entryQuantity: number;
  entryFundsQuote: number;
  entryFeesQuote: number;
  exitQuantity: number;
  exitFraction: number;
  /** @deprecated Use exitQuantity. Kept for existing LONG callers. */
  soldQuantity: number;
  exitFundsQuote: number;
  exitFeesQuote: number;
  /** @deprecated Use exitFraction. Kept for existing LONG callers. */
  soldFraction: number;
  realizedCostQuote: number;
  totalFeesQuote: number;
  realizedPnlQuote: number;
  realizedReturnPct: number;
};

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonnegative(value: unknown): number {
  return Math.max(0, finite(value));
}

export function effectiveBinanceBuyQuantity(fill: BinanceSettlementFill): number {
  const quantity = nonnegative(fill.quantity);
  const feeIsBase = String(fill.fee_asset || "").toUpperCase() ===
    String(fill.base_asset || "").toUpperCase();
  return feeIsBase ? Math.max(0, quantity - nonnegative(fill.fee_amount)) : quantity;
}

export function binanceEntryFeeQuote(fill: BinanceSettlementFill): number {
  const feeIsBase = String(fill.fee_asset || "").toUpperCase() ===
    String(fill.base_asset || "").toUpperCase();
  return feeIsBase ? 0 : nonnegative(fill.fee_quote_amount);
}

function normalizePositionSide(positionSide: unknown): BinancePositionSide {
  return String(positionSide || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

export function settleBinanceFills(
  fills: BinanceSettlementFill[],
  requestedPositionSide: BinancePositionSide = "LONG",
): BinanceFillSettlement {
  const positionSide = normalizePositionSide(requestedPositionSide);
  const entrySide = positionSide === "SHORT" ? "SELL" : "BUY";
  const exitSide = positionSide === "SHORT" ? "BUY" : "SELL";
  const entryFills = fills.filter((fill) =>
    String(fill.side || "").toUpperCase() === entrySide
  );
  const exitFills = fills.filter((fill) =>
    String(fill.side || "").toUpperCase() === exitSide
  );
  // Spot BUY fees paid in the base asset reduce the received inventory. Futures SHORT
  // entries are SELL contracts, so their quantity is never reduced by a base-asset fee.
  const entryQuantity = entryFills.reduce(
    (sum, fill) =>
      sum + (positionSide === "LONG"
        ? effectiveBinanceBuyQuantity(fill)
        : nonnegative(fill.quantity)),
    0,
  );
  const entryFundsQuote = entryFills.reduce(
    (sum, fill) => sum + nonnegative(fill.quote_amount),
    0,
  );
  const entryFeesQuote = entryFills.reduce(
    (sum, fill) =>
      sum + (positionSide === "LONG"
        ? binanceEntryFeeQuote(fill)
        : nonnegative(fill.fee_quote_amount)),
    0,
  );
  const exitQuantity = exitFills.reduce(
    (sum, fill) => sum + nonnegative(fill.quantity),
    0,
  );
  const exitFundsQuote = exitFills.reduce(
    (sum, fill) => sum + nonnegative(fill.quote_amount),
    0,
  );
  const exitFeesQuote = exitFills.reduce(
    (sum, fill) => sum + nonnegative(fill.fee_quote_amount),
    0,
  );
  const exitFraction = entryQuantity > 0 ? Math.min(1, exitQuantity / entryQuantity) : 0;
  const realizedCostQuote = entryFundsQuote * exitFraction;
  const totalFeesQuote = entryFeesQuote * exitFraction + exitFeesQuote;
  const realizedPnlQuote = (positionSide === "SHORT"
    ? realizedCostQuote - exitFundsQuote
    : exitFundsQuote - realizedCostQuote) - totalFeesQuote;
  const realizedReturnPct = realizedCostQuote > 0 ? realizedPnlQuote / realizedCostQuote * 100 : 0;

  return {
    positionSide,
    entrySide,
    exitSide,
    entryQuantity,
    entryFundsQuote,
    entryFeesQuote,
    exitQuantity,
    exitFraction,
    soldQuantity: exitQuantity,
    exitFundsQuote,
    exitFeesQuote,
    soldFraction: exitFraction,
    realizedCostQuote,
    totalFeesQuote,
    realizedPnlQuote,
    realizedReturnPct,
  };
}

export function allocateBinanceExit(input: {
  settlement: BinanceFillSettlement;
  quantity: number;
  /** LONG exit proceeds; legacy alias for exitFundsQuote. */
  proceedsQuote?: number;
  /** LONG sell fee; legacy alias for exitFeeQuote. */
  sellFeeQuote?: number;
  /** Direction-neutral exit notional (proceeds for LONG, buyback cost for SHORT). */
  exitFundsQuote?: number;
  exitFeeQuote?: number;
}): {
  costQuote: number;
  entryFeeQuote: number;
  totalFeesQuote: number;
  pnlQuote: number;
  returnPct: number;
} {
  const quantity = nonnegative(input.quantity);
  const entryShare = input.settlement.entryQuantity > 0
    ? Math.min(1, quantity / input.settlement.entryQuantity)
    : 0;
  const costQuote = input.settlement.entryFundsQuote * entryShare;
  const entryFeeQuote = input.settlement.entryFeesQuote * entryShare;
  const exitFeeQuote = nonnegative(input.exitFeeQuote ?? input.sellFeeQuote);
  const exitFundsQuote = nonnegative(input.exitFundsQuote ?? input.proceedsQuote);
  const totalFeesQuote = entryFeeQuote + exitFeeQuote;
  const pnlQuote = (input.settlement.positionSide === "SHORT"
    ? costQuote - exitFundsQuote
    : exitFundsQuote - costQuote) - totalFeesQuote;

  return {
    costQuote,
    entryFeeQuote,
    totalFeesQuote,
    pnlQuote,
    returnPct: costQuote > 0 ? pnlQuote / costQuote * 100 : 0,
  };
}
