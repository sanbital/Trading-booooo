export type P10EntryOrderDisposition = "APPLY" | "RECONCILE" | "NOT_FILLED";

export type P10EntryOrderEvidence = {
  status: unknown;
  executedVolume: unknown;
  averagePrice: unknown;
};

const finite = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Entry evidence is monotonic: once any execution is known, missing price detail or a
 * later lookup error can only require reconciliation. It can never prove "not filled".
 */
export function p10EntryOrderDisposition(
  evidence: P10EntryOrderEvidence,
): P10EntryOrderDisposition {
  const status = String(evidence.status || "UNKNOWN").toUpperCase();
  const executedVolume = Math.max(0, finite(evidence.executedVolume));
  const averagePrice = Math.max(0, finite(evidence.averagePrice));

  if (executedVolume > 0 && averagePrice > 0) return "APPLY";
  if (executedVolume > 0) return "RECONCILE";

  if (
    [
      "CANCELED",
      "CANCELLED",
      "EXCHANGE_CANCELLED",
      "REJECTED",
      "EXPIRED",
      "PARTIALLY_FILLED_CANCELED",
      "EXCHANGE_PARTIAL_CANCELLED",
    ]
      .includes(status)
  ) {
    return "NOT_FILLED";
  }
  return "RECONCILE";
}

export type P10EntryFailureEvidence = {
  status: unknown;
  code?: unknown;
  message: unknown;
};

/** A post-submit lookup failure is not evidence that the order was rejected. */
export function p10EntryFailureDisposition(
  evidence: P10EntryFailureEvidence,
): "REJECTED" | "RECONCILE" {
  const status = finite(evidence.status);
  const numericCode = finite(evidence.code, Number.NaN);
  const message = String(evidence.message || "");
  const ambiguous = [-2013, -1006, -1007].includes(numericCode) ||
    [408, 409, 425, 429].includes(status) ||
    status >= 500 ||
    /order does not exist|no such order|unknown order|lookup|query|timeout|timed out|fetch failed|network|socket|abort|temporar|unavailable|execution status unknown/i
      .test(message);
  if (ambiguous || !(status >= 400 && status < 500)) return "RECONCILE";
  return "REJECTED";
}

export type P10LinkedFill = {
  side: unknown;
  price: unknown;
  quantity: unknown;
  quote_amount?: unknown;
  fee_quote_amount?: unknown;
  fee_amount?: unknown;
  fee_asset?: unknown;
  executed_at?: unknown;
  exchange_trade_id?: unknown;
};

export type P10LinkedFillSummary = {
  valid: boolean;
  reason: string | null;
  count: number;
  executedVolume: number;
  executedFunds: number;
  averagePrice: number;
  paidFeeQuote: number;
  feeAsset: string | null;
  feeQuoteComplete: boolean;
  executedAt: string | null;
};

/** Build the exact entry fill used by late recovery from the durable exchange ledger. */
export function summarizeP10LinkedEntryFills(
  rows: readonly P10LinkedFill[],
  expectedSide: "BUY" | "SELL",
): P10LinkedFillSummary {
  let executedVolume = 0;
  let executedFunds = 0;
  let paidFeeQuote = 0;
  let feeQuoteComplete = true;
  let executedAt: string | null = null;
  const feeAssets = new Set<string>();

  for (const row of rows) {
    const side = String(row.side || "").toUpperCase();
    const quantity = finite(row.quantity);
    const price = finite(row.price);
    const quote = row.quote_amount == null ? quantity * price : finite(row.quote_amount);
    const feeAsset = String(row.fee_asset || "").toUpperCase();
    const rawFeeAmount = Math.max(0, finite(row.fee_amount));
    const feeIsQuoteAsset = ["USDT", "USDC", "BUSD", "FDUSD"].includes(feeAsset);
    const quoteFeePresent = row.fee_quote_amount != null &&
      Number.isFinite(Number(row.fee_quote_amount)) &&
      (Number(row.fee_quote_amount) > 0 || rawFeeAmount === 0);
    const fee = quoteFeePresent
      ? Math.max(0, Number(row.fee_quote_amount))
      : feeIsQuoteAsset
      ? rawFeeAmount
      : 0;
    if (!quoteFeePresent && rawFeeAmount > 0 && !feeIsQuoteAsset) {
      feeQuoteComplete = false;
    }
    if (side !== expectedSide || !(quantity > 0 && price > 0 && quote > 0) || fee < 0) {
      return {
        valid: false,
        reason: "linked fill has invalid entry direction or economics",
        count: rows.length,
        executedVolume: 0,
        executedFunds: 0,
        averagePrice: 0,
        paidFeeQuote: 0,
        feeAsset: null,
        feeQuoteComplete: false,
        executedAt: null,
      };
    }
    executedVolume += quantity;
    executedFunds += quote;
    paidFeeQuote += fee;
    if (row.fee_asset) feeAssets.add(String(row.fee_asset).toUpperCase());
    if (row.executed_at) {
      const timestamp = String(row.executed_at);
      if (!executedAt || Date.parse(timestamp) < Date.parse(executedAt)) executedAt = timestamp;
    }
  }

  const averagePrice = executedVolume > 0 ? executedFunds / executedVolume : 0;
  return {
    valid: rows.length > 0 && executedVolume > 0 && executedFunds > 0 && averagePrice > 0,
    reason: rows.length ? null : "no linked entry fills",
    count: rows.length,
    executedVolume,
    executedFunds,
    averagePrice,
    paidFeeQuote,
    feeAsset: feeAssets.size === 1 ? [...feeAssets][0] : feeAssets.size ? "MIXED" : null,
    feeQuoteComplete,
    executedAt,
  };
}

export type FuturesExposure = { market: unknown; side: unknown; quantity: unknown };

export function untrackedFuturesExposures(
  exchangePositions: readonly FuturesExposure[],
  trackedPositions: readonly FuturesExposure[],
): Array<{
  market: string;
  side: string;
  quantity: number;
  tracked_quantity?: number;
  unmatched_quantity?: number;
}> {
  const tracked = new Map<string, number>();
  for (const row of trackedPositions) {
    const key = `${String(row.market || "").toUpperCase()}:${String(row.side || "").toUpperCase()}`;
    const quantity = Math.max(0, finite(row.quantity));
    if (quantity > 0) tracked.set(key, (tracked.get(key) || 0) + quantity);
  }
  return exchangePositions
    .map((row) => ({
      market: String(row.market || "").toUpperCase(),
      side: String(row.side || "").toUpperCase(),
      quantity: Math.max(0, finite(row.quantity)),
    }))
    .flatMap((row) => {
      if (!row.market || !(row.quantity > 0)) return [];
      const trackedQuantity = tracked.get(`${row.market}:${row.side}`) || 0;
      const unmatchedQuantity = Math.max(0, row.quantity - trackedQuantity);
      if (!(unmatchedQuantity > 1e-12)) return [];
      return [{
        ...row,
        ...(trackedQuantity > 0
          ? { tracked_quantity: trackedQuantity, unmatched_quantity: unmatchedQuantity }
          : {}),
      }];
    });
}
