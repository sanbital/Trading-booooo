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

Deno.test("omitting position side preserves the existing LONG settlement contract", () => {
  const implicit = settleBinanceFills(sagaFills);
  const explicit = settleBinanceFills(sagaFills, "LONG");

  assert(JSON.stringify(implicit) === JSON.stringify(explicit), "default settlement must stay LONG");
  assert(implicit.positionSide === "LONG", "the default direction must be LONG");
  assert(implicit.entrySide === "BUY", "LONG entry must remain BUY");
  assert(implicit.exitSide === "SELL", "LONG exit must remain SELL");
  assertAlmost(implicit.exitQuantity, implicit.soldQuantity);
  assertAlmost(implicit.exitFraction, implicit.soldFraction);
});

const shortFills = [
  {
    side: "SELL",
    quantity: 2,
    quote_amount: 200,
    base_asset: "TEST",
    fee_asset: "USDT",
    fee_quote_amount: 0.08,
  },
  {
    side: "BUY",
    quantity: 0.75,
    quote_amount: 69,
    base_asset: "TEST",
    fee_asset: "USDT",
    fee_quote_amount: 0.0276,
  },
  {
    side: "BUY",
    quantity: 1.25,
    quote_amount: 110,
    base_asset: "TEST",
    fee_asset: "USDT",
    fee_quote_amount: 0.044,
  },
];

Deno.test("SHORT settlement treats SELL as entry and BUY as exit", () => {
  const settlement = settleBinanceFills(shortFills, "SHORT");

  assert(settlement.positionSide === "SHORT", "direction must be propagated");
  assert(settlement.entrySide === "SELL", "SHORT entry must be SELL");
  assert(settlement.exitSide === "BUY", "SHORT exit must be BUY");
  assertAlmost(settlement.entryQuantity, 2);
  assertAlmost(settlement.entryFundsQuote, 200);
  assertAlmost(settlement.exitQuantity, 2);
  assertAlmost(settlement.exitFundsQuote, 179);
  assertAlmost(settlement.realizedCostQuote, 200);
  assertAlmost(settlement.totalFeesQuote, 0.1516);
  assertAlmost(settlement.realizedPnlQuote, 20.8484);
  assertAlmost(settlement.realizedReturnPct, 10.4242);
});

Deno.test("SHORT exit allocations preserve each BUY-to-close tranche", () => {
  const settlement = settleBinanceFills(shortFills, "SHORT");
  const first = allocateBinanceExit({
    settlement,
    quantity: 0.75,
    exitFundsQuote: 69,
    exitFeeQuote: 0.0276,
  });
  const second = allocateBinanceExit({
    settlement,
    quantity: 1.25,
    exitFundsQuote: 110,
    exitFeeQuote: 0.044,
  });

  assertAlmost(first.costQuote, 75);
  assertAlmost(first.pnlQuote, 5.9424);
  assertAlmost(second.costQuote, 125);
  assertAlmost(second.pnlQuote, 14.906);
  assertAlmost(first.pnlQuote + second.pnlQuote, settlement.realizedPnlQuote);
});

Deno.test("an open SHORT with only its SELL entry is retained as unsettled inventory", () => {
  const settlement = settleBinanceFills([shortFills[0]], "SHORT");

  assertAlmost(settlement.entryQuantity, 2);
  assertAlmost(settlement.exitQuantity, 0);
  assertAlmost(settlement.exitFraction, 0);
  assertAlmost(settlement.realizedCostQuote, 0);
  assertAlmost(settlement.realizedPnlQuote, 0);
});

Deno.test("performance rows select and propagate canonical position_side", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  assert(
    source.includes("state,position_side,close_reason"),
    "the positions query must select canonical position_side",
  );
  assert(
    source.includes("settleBinanceFills(sorted, positionSide)"),
    "the row builder must pass direction into fill settlement",
  );
  assert(
    source.includes('const entrySide = positionSide === "SHORT" ? "SELL" : "BUY"'),
    "SHORT SELL entries must be grouped separately from BUY exits",
  );
  assert(
    source.includes('const exitSide = positionSide === "SHORT" ? "BUY" : "SELL"'),
    "SHORT BUY-to-close fills must form realized exit rows",
  );
  assert(
    (source.match(/position_side: positionSide/g) || []).length >= 4,
    "open and realized rows for every venue must expose position_side",
  );
});
