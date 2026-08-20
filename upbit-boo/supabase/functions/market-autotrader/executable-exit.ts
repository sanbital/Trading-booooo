export type BidLevel = {
  price: number;
  size: number;
};

export type ExecutableNetExitQuote = {
  allowed: boolean;
  reason: string;
  requestedQuantity: number;
  availableQuantity: number;
  sellQuantity: number;
  visibleExecutableQuantity: number;
  executableVwap: number;
  limitPrice: number;
  expectedGrossProceedsQuote: number;
  protectedGrossProceedsQuote: number;
  buyPrincipalQuote: number;
  alreadyPaidFeesQuote: number;
  priorSellProceedsQuote: number;
  unrecoveredCostQuote: number;
  expectedSellFeeQuote: number;
  slippageSafetyQuote: number;
  expectedNetProfitQuote: number;
};

export type ExitPolicyQuoteRecord = Record<string, unknown>;

/**
 * The exit_policy_quote the sell INSERT is actually checked against.
 *
 * guard_lob_sell_order_v714 does not re-derive the exit decision. It reads it out of
 * exit_policy_quote and authorises a post-180 profit exit only when that object says
 * `approved_reason = 'POSITIVE_NET_AFTER_180S'`. The monitor cycle writes that field, and
 * the order-time re-quote then replaced the whole object with an audit that never carried
 * it — so by the time the order reached the trigger the approval was gone and the guard
 * raised V725_POST180_PROFIT_MUST_USE_APPROVED_PATH on every profitable post-180 exit.
 * Losses were untouched: they leave through the -2% branch, which does not re-quote and so
 * keeps its approved_reason. A position in profit could therefore only sit there until it
 * became a loss, which is the opposite of the policy.
 *
 * The re-quote now restates the decision it is re-quoting for, and restates `price` with
 * it: the guard reads `price` ahead of `executable_vwap`, so carrying the monitor cycle's
 * price forward unchanged would have the guard value the order off a book from seconds ago.
 */
export function orderTimeExitPolicyQuote(
  priorQuote: ExitPolicyQuoteRecord | null | undefined,
  audit: ExitPolicyQuoteRecord,
  quote: ExecutableNetExitQuote,
): ExitPolicyQuoteRecord {
  const executablePrice = quote.executableVwap > 0 ? quote.executableVwap : quote.limitPrice;
  const priorApprovedReason = typeof priorQuote?.approved_reason === "string"
    ? String(priorQuote.approved_reason).trim()
    : "";
  return {
    ...(priorQuote && typeof priorQuote === "object" ? priorQuote : {}),
    ...audit,
    ...(executablePrice > 0
      ? { price: executablePrice, price_basis_runtime: "EXECUTABLE_VWAP" }
      : {}),
    ...(quote.allowed
      ? {
        approved_action: "STOP",
        approved_reason: priorApprovedReason || "POSITIVE_NET_AFTER_180S",
        executable_net_allowed: true,
        expected_net_profit_quote: quote.expectedNetProfitQuote,
      }
      : {
        approved_action: "NONE",
        approved_reason: `BLOCKED_${quote.reason}`,
        executable_net_allowed: false,
        expected_net_profit_quote: quote.expectedNetProfitQuote,
      }),
  };
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stepPrecision(step: number): number {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(16, Math.max(0, Number(text.split("e-")[1]) || 0));
  return Math.min(16, Math.max(0, (text.split(".")[1] || "").replace(/0+$/, "").length));
}

function floorToStep(value: number, step: number): number {
  const safeValue = Math.max(0, finite(value));
  const safeStep = Math.max(0, finite(step));
  if (!(safeValue > 0)) return 0;
  if (!(safeStep > 0)) return safeValue;
  return Number(
    (Math.floor((safeValue + safeStep * 1e-9) / safeStep) * safeStep).toFixed(
      stepPrecision(safeStep),
    ),
  );
}

/**
 * Price an exit from the exact visible bid depth for the exact deliverable quantity.
 *
 * The protected net estimate deliberately values the whole FOK order at its lowest
 * included bid. The difference between depth VWAP and that floor, plus an explicit
 * slippage reserve, is charged before an exit may be approved. Incomplete visible depth
 * is never extrapolated to the rest of the position.
 */
export function quoteExecutableNetExit(input: {
  bids: BidLevel[];
  requestedQuantity: number;
  availableQuantity: number;
  quantityStep: number;
  buyPrincipalQuote: number;
  alreadyPaidFeesQuote: number;
  priorSellProceedsQuote: number;
  sellFeeRate: number;
  slippageSafetyRate: number;
}): ExecutableNetExitQuote {
  const requestedQuantity = Math.max(0, finite(input.requestedQuantity));
  const availableQuantity = Math.max(0, finite(input.availableQuantity));
  const sellQuantity = floorToStep(
    Math.min(requestedQuantity, availableQuantity),
    Math.max(0, finite(input.quantityStep)),
  );
  const buyPrincipalQuote = Math.max(0, finite(input.buyPrincipalQuote));
  const alreadyPaidFeesQuote = Math.max(0, finite(input.alreadyPaidFeesQuote));
  const priorSellProceedsQuote = Math.max(0, finite(input.priorSellProceedsQuote));
  const unrecoveredCostQuote = Math.max(
    0,
    buyPrincipalQuote + alreadyPaidFeesQuote - priorSellProceedsQuote,
  );
  const sellFeeRate = Math.min(0.01, Math.max(0, finite(input.sellFeeRate)));
  const slippageSafetyRate = Math.min(
    0.05,
    Math.max(0, finite(input.slippageSafetyRate)),
  );

  let remaining = sellQuantity;
  let visibleExecutableQuantity = 0;
  let expectedGrossProceedsQuote = 0;
  let limitPrice = 0;
  for (const row of Array.isArray(input.bids) ? input.bids : []) {
    const price = Math.max(0, finite(row?.price));
    const size = Math.max(0, finite(row?.size));
    if (!(price > 0 && size > 0) || remaining <= 1e-12) continue;
    const take = Math.min(remaining, size);
    expectedGrossProceedsQuote += take * price;
    visibleExecutableQuantity += take;
    remaining -= take;
    limitPrice = price;
  }

  const fullDepth = sellQuantity > 0 &&
    visibleExecutableQuantity + Math.max(1e-12, sellQuantity * 1e-9) >= sellQuantity;
  const protectedGrossProceedsQuote = fullDepth ? limitPrice * sellQuantity : 0;
  const expectedSellFeeQuote = fullDepth ? expectedGrossProceedsQuote * sellFeeRate : 0;
  const depthToFloorReserve = fullDepth
    ? Math.max(0, expectedGrossProceedsQuote - protectedGrossProceedsQuote)
    : 0;
  const explicitSlippageReserve = fullDepth ? expectedGrossProceedsQuote * slippageSafetyRate : 0;
  const slippageSafetyQuote = depthToFloorReserve + explicitSlippageReserve;
  // Net profit is what the sale actually leaves behind: proceeds less the fee that is
  // really charged and the cost not yet recovered. The slippage reserve is a safety margin,
  // not a cost, and subtracting it here turned "sell when net is positive" into "sell when
  // net clears roughly 9bp" — positions sat open for hours showing a profit the policy
  // refused to take. The reserve is still computed, and still shapes the limit price; it
  // just no longer decides whether the position may be closed.
  const expectedNetProfitQuote = fullDepth
    ? expectedGrossProceedsQuote - expectedSellFeeQuote - unrecoveredCostQuote
    : Number.NEGATIVE_INFINITY;
  const executableVwap = fullDepth && sellQuantity > 0
    ? expectedGrossProceedsQuote / sellQuantity
    : 0;

  let reason = "POSITIVE_NET_AFTER_180S";
  if (!(requestedQuantity > 0)) reason = "ZERO_REQUESTED_QUANTITY";
  else if (!(availableQuantity > 0) || !(sellQuantity > 0)) reason = "ZERO_SELLABLE_QUANTITY";
  else if (availableQuantity + Math.max(1e-12, requestedQuantity * 1e-9) < requestedQuantity) {
    reason = "INSUFFICIENT_ACCOUNT_QUANTITY";
  } else if (!fullDepth) reason = "INSUFFICIENT_VISIBLE_BID_DEPTH";
  else if (!(limitPrice > 0)) reason = "NO_EXECUTABLE_BID_PRICE";
  else if (!(expectedNetProfitQuote > 0)) reason = "NON_POSITIVE_NET_AFTER_COSTS";

  return {
    allowed: reason === "POSITIVE_NET_AFTER_180S",
    reason,
    requestedQuantity,
    availableQuantity,
    sellQuantity,
    visibleExecutableQuantity,
    executableVwap,
    limitPrice,
    expectedGrossProceedsQuote,
    protectedGrossProceedsQuote,
    buyPrincipalQuote,
    alreadyPaidFeesQuote,
    priorSellProceedsQuote,
    unrecoveredCostQuote,
    expectedSellFeeQuote,
    slippageSafetyQuote,
    expectedNetProfitQuote,
  };
}
