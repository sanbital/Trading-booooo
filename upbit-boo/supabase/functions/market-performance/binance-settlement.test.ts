import { allocateBinanceExit, settleBinanceFills } from "./binance-settlement.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertAlmost(actual: number, expected: number, tolerance = 1e-9): void {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

const sagaFills = [
  {
    side: "BUY",
    quantity: 2688.1,
    quote_amount: 44.998794,
    base_asset: "SAGA",
    fee_asset: "BNB",
    fee_quote_amount: 0.033739661178790646,
  },
  {
    side: "SELL",
    quantity: 1344,
    quote_amount: 23.6544,
    base_asset: "SAGA",
    fee_asset: "BNB",
    fee_quote_amount: 0.017735902567961807,
  },
  {
    side: "SELL",
    quantity: 1344.1,
    quote_amount: 24.86585,
    base_asset: "SAGA",
    fee_asset: "BNB",
    fee_quote_amount: 0.018649870581305895,
  },
];

Deno.test("SAGA closed settlement uses the complete buy cost exactly once", () => {
  const settlement = settleBinanceFills(sagaFills);

  assertAlmost(settlement.entryFundsQuote, 44.998794);
  assertAlmost(settlement.realizedCostQuote, 44.998794);
  assertAlmost(settlement.exitFundsQuote, 48.52025);
  assert(
    settlement.realizedPnlQuote > 3 && settlement.realizedPnlQuote < 4,
    "the actual SAGA profit must be realistic, not +25.99 USDT",
  );
  assert(
    settlement.realizedReturnPct > 7 && settlement.realizedReturnPct < 9,
    "the actual SAGA return must be single-digit, not +120%",
  );
});

Deno.test("each SAGA exit receives its proportional share of the original cost", () => {
  const settlement = settleBinanceFills(sagaFills);
  const first = allocateBinanceExit({
    settlement,
    quantity: 1344,
    proceedsQuote: 23.6544,
    sellFeeQuote: 0.017735902567961807,
  });
  const second = allocateBinanceExit({
    settlement,
    quantity: 1344.1,
    proceedsQuote: 24.86585,
    sellFeeQuote: 0.018649870581305895,
  });

  assert(
    first.costQuote > 22 && first.costQuote < 23,
    "the first exit cost must be half the 45 USDT entry, not 11.25 USDT",
  );
  assert(
    second.costQuote > 22 && second.costQuote < 23,
    "the second exit cost must be half the 45 USDT entry, not 11.25 USDT",
  );
  assertAlmost(first.costQuote + second.costQuote, settlement.realizedCostQuote, 1e-8);
  assertAlmost(first.pnlQuote + second.pnlQuote, settlement.realizedPnlQuote, 1e-8);
});
