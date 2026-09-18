export type BinanceSettlementFill = {
  side?: unknown;
  quantity?: unknown;
  quote_amount?: unknown;
  fee_amount?: unknown;
  fee_asset?: unknown;
  fee_quote_amount?: unknown;
  base_asset?: unknown;
};

export type BinanceFillSettlement = {
  entryQuantity: number;
  entryFundsQuote: number;
  entryFeesQuote: number;
  soldQuantity: number;
  exitFundsQuote: number;
  exitFeesQuote: number;
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

export function settleBinanceFills(fills: BinanceSettlementFill[]): BinanceFillSettlement {
  const buys = fills.filter((fill) => String(fill.side || "").toUpperCase() === "BUY");
  const sells = fills.filter((fill) => String(fill.side || "").toUpperCase() === "SELL");
  const entryQuantity = buys.reduce((sum, fill) => sum + effectiveBinanceBuyQuantity(fill), 0);
  const entryFundsQuote = buys.reduce((sum, fill) => sum + nonnegative(fill.quote_amount), 0);
  const entryFeesQuote = buys.reduce((sum, fill) => sum + binanceEntryFeeQuote(fill), 0);
  const soldQuantity = sells.reduce((sum, fill) => sum + nonnegative(fill.quantity), 0);
  const exitFundsQuote = sells.reduce((sum, fill) => sum + nonnegative(fill.quote_amount), 0);
  const exitFeesQuote = sells.reduce((sum, fill) => sum + nonnegative(fill.fee_quote_amount), 0);
  const soldFraction = entryQuantity > 0 ? Math.min(1, soldQuantity / entryQuantity) : 0;
  const realizedCostQuote = entryFundsQuote * soldFraction;
  const totalFeesQuote = entryFeesQuote * soldFraction + exitFeesQuote;
  const realizedPnlQuote = exitFundsQuote - realizedCostQuote - totalFeesQuote;
  const realizedReturnPct = realizedCostQuote > 0 ? realizedPnlQuote / realizedCostQuote * 100 : 0;

  return {
    entryQuantity,
    entryFundsQuote,
    entryFeesQuote,
    soldQuantity,
    exitFundsQuote,
    exitFeesQuote,
    soldFraction,
    realizedCostQuote,
    totalFeesQuote,
    realizedPnlQuote,
    realizedReturnPct,
  };
}

export function allocateBinanceExit(input: {
  settlement: BinanceFillSettlement;
  quantity: number;
  proceedsQuote: number;
  sellFeeQuote: number;
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
  const sellFeeQuote = nonnegative(input.sellFeeQuote);
  const totalFeesQuote = entryFeeQuote + sellFeeQuote;
  const pnlQuote = nonnegative(input.proceedsQuote) - costQuote - totalFeesQuote;

  return {
    costQuote,
    entryFeeQuote,
    totalFeesQuote,
    pnlQuote,
    returnPct: costQuote > 0 ? pnlQuote / costQuote * 100 : 0,
  };
}
