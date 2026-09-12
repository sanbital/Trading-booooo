import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveHolding } from "../_shared/position-value.ts";
import { settleTrade } from "./account-settlement.ts";

const binanceHolding = (ledger: number, exchange: number | null, price: number) =>
  resolveHolding({
    ledgerQuantity: ledger,
    exchangeQuantity: exchange,
    price,
    dustQuote: 1,
  });

Deno.test("a manually sold open position is settled instead of shown as a holding", () => {
  // binance:BICO — the ledger still carried 816.17509 after the operator sold it by hand.
  const settlement = settleTrade({
    closedByLedger: false,
    holding: binanceHolding(816.17509, 0, 0.0295),
    recordedManualExit: null,
    remainingQuantity: 816.17509,
    currentPrice: 0.0295,
    feePctPerSide: 0.1,
    entryFundsQuote: 22.5754,
    entryFeesQuote: 0.0226,
    exitFundsQuote: 0,
    exitFeesQuote: 0,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, true);
  assertEquals(settlement.isClosed, true);
  assertEquals(settlement.heldQuantity, 0);
  assertEquals(settlement.currentValueQuote, 0);
  assertEquals(settlement.closeReasonHint, "MANUAL_SELL_RECONCILED");
  assertAlmostEquals(settlement.manualExitProceedsQuote, 24.05308, 1e-4);
  // The manual sell now carries a real result instead of the engine's hard-coded zero.
  assertAlmostEquals(settlement.netPnlQuote, 24.05308 - 22.5754 - 0.0226, 1e-4);
  assertEquals(settlement.netPnlQuote > 0, true);
});

Deno.test("a live position above the dollar floor keeps its open economics", () => {
  const settlement = settleTrade({
    closedByLedger: false,
    holding: binanceHolding(533.2, 533.2, 0.1305),
    recordedManualExit: null,
    remainingQuantity: 533.2,
    currentPrice: 0.1305,
    feePctPerSide: 0.1,
    entryFundsQuote: 69.9,
    entryFeesQuote: 0.0699,
    exitFundsQuote: 0,
    exitFeesQuote: 0,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, false);
  assertEquals(settlement.isClosed, false);
  assertEquals(settlement.manualExitQuantity, 0);
  assertEquals(settlement.manualExitEstimated, false);
  assertAlmostEquals(settlement.currentValueQuote, 69.5826, 1e-4);
});

Deno.test("a holding worth a dollar or less is settled even when the balance agrees", () => {
  const settlement = settleTrade({
    closedByLedger: false,
    holding: binanceHolding(20, 20, 0.04),
    recordedManualExit: null,
    remainingQuantity: 20,
    currentPrice: 0.04,
    feePctPerSide: 0.1,
    entryFundsQuote: 90,
    entryFeesQuote: 0.09,
    exitFundsQuote: 88,
    exitFeesQuote: 0.088,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, true);
  assertEquals(settlement.closeReasonHint, "DUST_BELOW_MIN_VALUE");
  // The sub-dollar remainder keeps its market value rather than being written off.
  assertAlmostEquals(settlement.currentValueQuote, 0.8, 1e-12);
  assertAlmostEquals(settlement.netPnlQuote, 88 - 0.088 + 0.8 - 90 - 0.09, 1e-9);
});

Deno.test("a partial manual sell books the missing half and stays open", () => {
  const settlement = settleTrade({
    closedByLedger: false,
    holding: binanceHolding(100, 50, 2),
    recordedManualExit: null,
    remainingQuantity: 100,
    currentPrice: 2,
    feePctPerSide: 0.1,
    entryFundsQuote: 190,
    entryFeesQuote: 0.19,
    exitFundsQuote: 0,
    exitFeesQuote: 0,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, false);
  assertEquals(settlement.isClosed, false);
  assertEquals(settlement.manualExitQuantity, 50);
  assertAlmostEquals(settlement.manualExitProceedsQuote, 100 - 0.1, 1e-9);
  assertAlmostEquals(settlement.currentValueQuote, 100, 1e-9);
  assertAlmostEquals(settlement.netPnlQuote, 99.9 + 100 - 190 - 0.19, 1e-9);
});

Deno.test("a closed manual reconcile is recomputed instead of trusting its zero PnL", () => {
  // `manualReconcileAccounting` writes realized_pnl_quote = 0, which used to erase the
  // operator's own sell from every cumulative total.
  const settlement = settleTrade({
    closedByLedger: true,
    holding: null,
    recordedManualExit: { missing_quantity: 816.17509, estimated_value_quote: 24.07716 },
    remainingQuantity: 0,
    currentPrice: 0.0295,
    feePctPerSide: 0.1,
    entryFundsQuote: 22.5754,
    entryFeesQuote: 0.0226,
    exitFundsQuote: 0,
    exitFeesQuote: 0,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: 0,
  });

  assertEquals(settlement.manualExitEstimated, true);
  // Value marked at detection time wins over a re-mark at today's price.
  assertAlmostEquals(settlement.manualExitGrossQuote, 24.07716, 1e-9);
  assertAlmostEquals(settlement.netPnlQuote, 24.05308 - 22.5754 - 0.0226, 1e-4);
});

Deno.test("an ordinary closed trade still reports the engine's measured result", () => {
  const settlement = settleTrade({
    closedByLedger: true,
    holding: null,
    recordedManualExit: null,
    remainingQuantity: 0,
    currentPrice: 0.03,
    feePctPerSide: 0.1,
    entryFundsQuote: 100,
    entryFeesQuote: 0.1,
    exitFundsQuote: 103,
    exitFeesQuote: 0.103,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: 2.75,
  });

  assertEquals(settlement.manualExitEstimated, false);
  assertAlmostEquals(settlement.netPnlQuote, 2.75, 1e-12);
});

Deno.test("an unreadable balance leaves an open position exactly as the ledger has it", () => {
  const settlement = settleTrade({
    closedByLedger: false,
    holding: binanceHolding(816.17509, null, 0.0295),
    recordedManualExit: null,
    remainingQuantity: 816.17509,
    currentPrice: 0.0295,
    feePctPerSide: 0.1,
    entryFundsQuote: 22.5754,
    entryFeesQuote: 0.0226,
    exitFundsQuote: 0,
    exitFeesQuote: 0,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, false);
  assertEquals(settlement.manualExitQuantity, 0);
  assertAlmostEquals(settlement.heldQuantity, 816.17509, 1e-9);
});

Deno.test("upbit settles against its own won-denominated floor", () => {
  const holding = resolveHolding({
    ledgerQuantity: 10,
    exchangeQuantity: 10,
    price: 120,
    dustQuote: 1400,
  });
  const settlement = settleTrade({
    closedByLedger: false,
    holding,
    recordedManualExit: null,
    remainingQuantity: 10,
    currentPrice: 120,
    feePctPerSide: 0.05,
    entryFundsQuote: 40000,
    entryFeesQuote: 20,
    exitFundsQuote: 38000,
    exitFeesQuote: 19,
    residualValueQuote: 0,
    ledgerRealizedPnlQuote: null,
  });

  assertEquals(settlement.settledByAccount, true);
  assertEquals(settlement.closeReasonHint, "DUST_BELOW_MIN_VALUE");
});
