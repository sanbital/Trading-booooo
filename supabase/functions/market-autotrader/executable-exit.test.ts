import { orderTimeExitPolicyQuote, quoteExecutableNetExit } from "./executable-exit.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("post-180 quote uses full visible depth and includes both fees plus slippage", () => {
  const quote = quoteExecutableNetExit({
    bids: [
      { price: 10.2, size: 4 },
      { price: 10.1, size: 6 },
    ],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(quote.allowed, quote.reason);
  assert(quote.sellQuantity === 10);
  assert(Math.abs(quote.expectedGrossProceedsQuote - 101.4) < 1e-9);
  assert(quote.limitPrice === 10.1);
  assert(quote.expectedSellFeeQuote > 0);
  assert(quote.slippageSafetyQuote > 0.4);
  assert(quote.expectedNetProfitQuote > 0);
});

Deno.test("incomplete bid depth never extrapolates the lowest visible bid", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 10.2, size: 4 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 20,
    alreadyPaidFeesQuote: 0.02,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(!quote.allowed);
  assert(quote.reason === "INSUFFICIENT_VISIBLE_BID_DEPTH");
  assert(quote.executableVwap === 0);
  assert(quote.expectedNetProfitQuote === Number.NEGATIVE_INFINITY);
});

Deno.test("a fee-positive price difference still holds when true net is non-positive", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 10.02, size: 10 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(!quote.allowed);
  assert(quote.reason === "NON_POSITIVE_NET_AFTER_COSTS");
  assert(quote.expectedNetProfitQuote <= 0);
});

Deno.test("account quantity must cover the full booked exit", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 12, size: 20 }],
    requestedQuantity: 10,
    availableQuantity: 9.9,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(!quote.allowed);
  assert(quote.reason === "INSUFFICIENT_ACCOUNT_QUANTITY");
});

Deno.test("prior proceeds reduce only the unrecovered cost", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 10, size: 5 }],
    requestedQuantity: 5,
    availableQuantity: 5,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.2,
    priorSellProceedsQuote: 55,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(quote.unrecoveredCostQuote === 45.2);
  assert(quote.allowed, quote.reason);
});

// The order-time re-quote overwrites the exit_policy_quote the monitor cycle wrote. The
// database guard reads its authority out of that object, so anything the re-quote drops is
// gone by the time the sell is checked.
Deno.test("the order-time quote carries the approval the sell guard reads", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 11, size: 6 }, { price: 10.5, size: 6 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(quote.allowed, quote.reason);
  const merged = orderTimeExitPolicyQuote(
    {
      revision: "7.3.5-APPROVAL-SURVIVES-REQUOTE",
      price: 9.1,
      approved_action: "STOP",
      approved_reason: "POSITIVE_NET_AFTER_180S",
      requested_reason: "lob:post-180",
      held_seconds: 1840,
    },
    { revision: "7.3.5-APPROVAL-SURVIVES-REQUOTE", executable_vwap: quote.executableVwap },
    quote,
  );
  assert(merged.approved_reason === "POSITIVE_NET_AFTER_180S", String(merged.approved_reason));
  assert(merged.approved_action === "STOP");
  // The guard reads `price` ahead of `executable_vwap`, so the stale monitor-cycle price
  // must not survive into the object the order is checked against.
  assert(merged.price === quote.executableVwap, String(merged.price));
  assert(merged.price_basis_runtime === "EXECUTABLE_VWAP");
  // Context the guard needs for other branches is preserved.
  assert(merged.requested_reason === "lob:post-180");
  assert(merged.held_seconds === 1840);
});

Deno.test("a blocked re-quote does not leave an approval behind", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 9, size: 10 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(!quote.allowed);
  const merged = orderTimeExitPolicyQuote(
    { approved_action: "STOP", approved_reason: "POSITIVE_NET_AFTER_180S" },
    { revision: "7.3.5-APPROVAL-SURVIVES-REQUOTE" },
    quote,
  );
  assert(merged.approved_action === "NONE");
  assert(
    merged.approved_reason === "BLOCKED_NON_POSITIVE_NET_AFTER_COSTS",
    String(merged.approved_reason),
  );
});

Deno.test("a quote with no executable price leaves the guard nothing to price against", () => {
  const quote = quoteExecutableNetExit({
    bids: [],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  const merged = orderTimeExitPolicyQuote({ price: 9.1 }, {}, quote);
  // Nothing was priced, so the stale price stays untouched rather than being replaced by a
  // zero the guard would read as missing economics. No order is submitted in this case.
  assert(merged.price === 9.1);
  assert(merged.approved_action === "NONE");
});

Deno.test("order-time quote preserves stale-recovery authority and explicit net fields", () => {
  const quote = quoteExecutableNetExit({
    bids: [{ price: 10.5, size: 10 }],
    requestedQuantity: 10,
    availableQuantity: 10,
    quantityStep: 0.1,
    buyPrincipalQuote: 100,
    alreadyPaidFeesQuote: 0.1,
    priorSellProceedsQuote: 0,
    sellFeeRate: 0.001,
    slippageSafetyRate: 0.0009,
  });
  assert(quote.allowed, quote.reason);
  const merged = orderTimeExitPolicyQuote(
    {
      approved_action: "STOP",
      approved_reason: "STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
      held_seconds: 10_900,
    },
    { revision: "7.6.5-RECOVERY180M" },
    quote,
  );
  assert(
    merged.approved_reason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M",
    String(merged.approved_reason),
  );
  assert(merged.approved_action === "STOP");
  assert(merged.executable_net_allowed === true);
  assert(Number(merged.expected_net_profit_quote) > 0);
});
