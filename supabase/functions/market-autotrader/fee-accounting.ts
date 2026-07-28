export type FeeResolutionSource =
  | "PER_FILL_QUOTE"
  | "AGGREGATE_QUOTE"
  | "BASE_ASSET"
  | "ESTIMATED_THIRD_ASSET"
  | "ESTIMATED_MISSING"
  | "MIXED"
  | "MISSING";

type JsonRecord = Record<string, any>;

export type FeeResolution = {
  feeQuote: number;
  source: FeeResolutionSource;
  aggregatePaidFee: number;
  aggregateFeeAsset: string | null;
  positiveTradeFeeCount: number;
  estimated: boolean;
  complete: boolean;
};

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function upper(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function normalizedTrades(
  order: JsonRecord | null | undefined,
  fill: JsonRecord | null | undefined,
): JsonRecord[] {
  return Array.isArray(order?.trades)
    ? order.trades
    : Array.isArray(fill?.trades)
    ? fill.trades
    : [];
}

/**
 * Resolves an order fee into quote currency without discarding an authoritative
 * order-level fee merely because per-fill fee fields are absent.
 *
 * - Quote-asset per-fill fees are exact.
 * - Aggregate quote-asset paid_fee is exact and is the Upbit fallback.
 * - Base-asset fees are accounted through net quantity/residual accounting, not twice here.
 * - Third-asset fees retain a conservative quote estimate from matched funds.
 */
export function resolveFeeQuote(input: {
  quoteAsset: string;
  baseAsset: string;
  defaultFeePct: number;
  order?: JsonRecord | null;
  fill?: JsonRecord | null;
  estimateWhenMissing?: boolean;
}): FeeResolution {
  const quote = upper(input.quoteAsset);
  const base = upper(input.baseAsset);
  const ratePct = Math.max(0, finite(input.defaultFeePct));
  const trades = normalizedTrades(input.order, input.fill);
  const aggregateFeeAsset = upper(input.fill?.feeAsset || input.order?.fee_asset) || null;
  const aggregatePaidFee = Math.max(
    0,
    finite(input.fill?.paidFee, finite(input.order?.paid_fee)),
  );

  let feeQuote = 0;
  let positiveTradeFeeCount = 0;
  let sawQuote = false;
  let sawBase = false;
  let sawThird = false;

  for (const trade of trades) {
    const fee = Math.max(0, finite(trade?.fee));
    if (!(fee > 0)) continue;
    positiveTradeFeeCount += 1;
    const asset = upper(trade?.fee_asset);
    if (asset === quote) {
      feeQuote += fee;
      sawQuote = true;
    } else if (asset === base) {
      sawBase = true;
    } else {
      const suppliedQuoteEstimate = Math.max(0, finite(trade?.fee_quote_estimate));
      feeQuote += suppliedQuoteEstimate > 0
        ? suppliedQuoteEstimate
        : Math.max(0, finite(trade?.funds)) * ratePct / 100;
      sawThird = true;
    }
  }

  if (positiveTradeFeeCount > 0) {
    const kinds = Number(sawQuote) + Number(sawBase) + Number(sawThird);
    const source: FeeResolutionSource = kinds > 1
      ? "MIXED"
      : sawThird
      ? "ESTIMATED_THIRD_ASSET"
      : sawBase
      ? "BASE_ASSET"
      : "PER_FILL_QUOTE";
    return {
      feeQuote,
      source,
      aggregatePaidFee,
      aggregateFeeAsset,
      positiveTradeFeeCount,
      estimated: sawThird,
      complete: true,
    };
  }

  // Upbit's order response has exact paid_fee, while the individual trade rows omit fee.
  // The old code returned the zero per-fill sum and never reached this aggregate value.
  if (aggregatePaidFee > 0) {
    if (aggregateFeeAsset === quote) {
      return {
        feeQuote: aggregatePaidFee,
        source: "AGGREGATE_QUOTE",
        aggregatePaidFee,
        aggregateFeeAsset,
        positiveTradeFeeCount,
        estimated: false,
        complete: true,
      };
    }
    if (aggregateFeeAsset === base) {
      return {
        feeQuote: 0,
        source: "BASE_ASSET",
        aggregatePaidFee,
        aggregateFeeAsset,
        positiveTradeFeeCount,
        estimated: false,
        complete: true,
      };
    }
    const executedFunds = Math.max(
      0,
      finite(input.fill?.executedFunds, finite(input.order?.executed_funds)),
    );
    return {
      feeQuote: executedFunds * ratePct / 100,
      source: "ESTIMATED_THIRD_ASSET",
      aggregatePaidFee,
      aggregateFeeAsset,
      positiveTradeFeeCount,
      estimated: true,
      complete: true,
    };
  }

  const executedFunds = Math.max(
    0,
    finite(input.fill?.executedFunds, finite(input.order?.executed_funds)),
  );
  if (input.estimateWhenMissing === true && executedFunds > 0 && ratePct > 0) {
    return {
      feeQuote: executedFunds * ratePct / 100,
      source: "ESTIMATED_MISSING",
      aggregatePaidFee,
      aggregateFeeAsset,
      positiveTradeFeeCount,
      estimated: true,
      complete: false,
    };
  }

  return {
    feeQuote: 0,
    source: "MISSING",
    aggregatePaidFee,
    aggregateFeeAsset,
    positiveTradeFeeCount,
    estimated: false,
    complete: false,
  };
}

/**
 * Produces auditable per-fill fee rows. When a venue supplies only an exact aggregate
 * quote fee, it is allocated by matched funds. The last fill receives the numerical
 * remainder so the per-fill sum equals the exchange aggregate exactly.
 */
export function allocateNormalizedTradeFees(input: {
  quoteAsset: string;
  baseAsset: string;
  defaultFeePct: number;
  aggregatePaidFee?: number;
  aggregateFeeAsset?: string | null;
  executedFunds?: number;
  trades: JsonRecord[];
}): Array<{
  feeAmount: number;
  feeAsset: string | null;
  feeQuoteEstimate: number;
  source: FeeResolutionSource;
}> {
  const quote = upper(input.quoteAsset);
  const base = upper(input.baseAsset);
  const trades = Array.isArray(input.trades) ? input.trades : [];
  const totalFunds = trades.reduce(
    (sum, trade) => sum + Math.max(0, finite(trade?.funds)),
    0,
  );
  const resolution = resolveFeeQuote({
    quoteAsset: quote,
    baseAsset: base,
    defaultFeePct: input.defaultFeePct,
    order: {
      trades,
      paid_fee: input.aggregatePaidFee,
      fee_asset: input.aggregateFeeAsset,
      executed_funds: input.executedFunds ?? totalFunds,
    },
  });
  const allocateAggregateQuote =
    resolution.source === "AGGREGATE_QUOTE" &&
    resolution.positiveTradeFeeCount === 0 &&
    resolution.feeQuote > 0 &&
    trades.length > 0;
  let allocated = 0;

  return trades.map((trade, index) => {
    const funds = Math.max(0, finite(trade?.funds));
    if (allocateAggregateQuote) {
      const feeAmount = index === trades.length - 1
        ? Math.max(0, resolution.feeQuote - allocated)
        : totalFunds > 0
        ? resolution.feeQuote * funds / totalFunds
        : resolution.feeQuote / trades.length;
      allocated += feeAmount;
      return {
        feeAmount,
        feeAsset: quote,
        feeQuoteEstimate: feeAmount,
        source: "AGGREGATE_QUOTE",
      };
    }

    const feeAmount = Math.max(0, finite(trade?.fee));
    const feeAsset = upper(trade?.fee_asset) || null;
    if (feeAsset === quote) {
      return { feeAmount, feeAsset, feeQuoteEstimate: feeAmount, source: "PER_FILL_QUOTE" };
    }
    if (feeAsset === base) {
      return { feeAmount, feeAsset, feeQuoteEstimate: 0, source: "BASE_ASSET" };
    }
    if (feeAmount > 0) {
      return {
        feeAmount,
        feeAsset,
        feeQuoteEstimate: Math.max(0, finite(trade?.fee_quote_estimate)) ||
          funds * Math.max(0, finite(input.defaultFeePct)) / 100,
        source: "ESTIMATED_THIRD_ASSET",
      };
    }
    return { feeAmount: 0, feeAsset, feeQuoteEstimate: 0, source: "MISSING" };
  });
}
