import { quoteExecutableNetExit } from "./executable-exit.ts";

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
