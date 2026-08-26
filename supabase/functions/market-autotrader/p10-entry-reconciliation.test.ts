import {
  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  summarizeP10LinkedEntryFills,
  untrackedFuturesExposures,
} from "./p10-entry-reconciliation.ts";
import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("FILLED quantity with delayed price detail remains reconciling", () => {
  assertEquals(
    p10EntryOrderDisposition({ status: "FILLED", executedVolume: 2016, averagePrice: 0 }),
    "RECONCILE",
  );
});

Deno.test("only explicit terminal zero-fill evidence is not filled", () => {
  assertEquals(
    p10EntryOrderDisposition({ status: "CANCELED", executedVolume: 0, averagePrice: 0 }),
    "NOT_FILLED",
  );
  assertEquals(
    p10EntryOrderDisposition({ status: "UNKNOWN", executedVolume: 0, averagePrice: 0 }),
    "RECONCILE",
  );
  assertEquals(
    p10EntryOrderDisposition({ status: "FILLED", executedVolume: 0, averagePrice: 0 }),
    "RECONCILE",
  );
  assertEquals(
    p10EntryOrderDisposition({ status: "EXCHANGE_CANCELLED", executedVolume: 0, averagePrice: 0 }),
    "NOT_FILLED",
  );
});

Deno.test("positive execution with price applies regardless of terminal spelling", () => {
  assertEquals(
    p10EntryOrderDisposition({
      status: "PARTIALLY_FILLED_CANCELED",
      executedVolume: 4,
      averagePrice: 10,
    }),
    "APPLY",
  );
});

Deno.test("Binance -2013 is reconciliation, not rejection", () => {
  assertEquals(
    p10EntryFailureDisposition({ status: 400, code: -2013, message: "Order does not exist." }),
    "RECONCILE",
  );
  assertEquals(
    p10EntryFailureDisposition({ status: 400, code: -2019, message: "Margin is insufficient." }),
    "REJECTED",
  );
});

Deno.test("linked XPL fills rebuild exact quantity, VWAP and fee", () => {
  const summary = summarizeP10LinkedEntryFills([
    {
      side: "SELL",
      price: 0.08937,
      quantity: 370,
      quote_amount: 33.0669,
      fee_quote_amount: 0.01653345,
      fee_asset: "USDT",
      executed_at: "2026-08-25T21:08:38.544Z",
    },
    {
      side: "SELL",
      price: 0.08937,
      quantity: 1169,
      quote_amount: 104.47353,
      fee_quote_amount: 0.05223676,
      fee_asset: "USDT",
      executed_at: "2026-08-25T21:08:38.544Z",
    },
    {
      side: "SELL",
      price: 0.08938,
      quantity: 477,
      quote_amount: 42.63466,
      fee_quote_amount: 0.02131732,
      fee_asset: "USDT",
      executed_at: "2026-08-25T21:08:38.544Z",
    },
  ], "SELL");
  assertEquals(summary.valid, true);
  assertEquals(summary.executedVolume, 2016);
  assertAlmostEquals(summary.executedFunds, 180.17509, 1e-12);
  assertAlmostEquals(summary.averagePrice, 180.17509 / 2016, 1e-15);
  assertAlmostEquals(summary.paidFeeQuote, 0.09008753, 1e-12);
  assertEquals(summary.feeAsset, "USDT");
  assertEquals(summary.feeQuoteComplete, true);
});

Deno.test("null quote falls back to price times quantity without inventing third-asset fees", () => {
  const summary = summarizeP10LinkedEntryFills([{
    side: "SELL",
    price: 10,
    quantity: 2,
    quote_amount: null,
    fee_quote_amount: null,
    fee_amount: 0.01,
    fee_asset: "BNB",
  }], "SELL");
  assertEquals(summary.valid, true);
  assertEquals(summary.executedFunds, 20);
  assertEquals(summary.paidFeeQuote, 0);
  assertEquals(summary.feeQuoteComplete, false);
});

Deno.test("zero third-asset fee conversion remains incomplete and retryable", () => {
  const summary = summarizeP10LinkedEntryFills([{
    side: "SELL",
    price: 10,
    quantity: 2,
    quote_amount: 20,
    fee_quote_amount: 0,
    fee_amount: 0.01,
    fee_asset: "BNB",
  }], "SELL");
  assertEquals(summary.valid, true);
  assertEquals(summary.paidFeeQuote, 0);
  assertEquals(summary.feeQuoteComplete, false);
});

Deno.test("exchange exposure without an active directional row is reported", () => {
  assertEquals(
    untrackedFuturesExposures(
      [
        { market: "ETHFIUSDT", side: "SHORT", quantity: 326 },
        { market: "XPLUSDT", side: "SHORT", quantity: 2016 },
      ],
      [{ market: "ETHFIUSDT", side: "SHORT", quantity: 326 }],
    ),
    [{ market: "XPLUSDT", side: "SHORT", quantity: 2016 }],
  );
});

Deno.test("exchange quantity above the tracked directional quantity is reported", () => {
  assertEquals(
    untrackedFuturesExposures(
      [{ market: "XPLUSDT", side: "SHORT", quantity: 2016 }],
      [{ market: "XPLUSDT", side: "SHORT", quantity: 2000 }],
    ),
    [{
      market: "XPLUSDT",
      side: "SHORT",
      quantity: 2016,
      tracked_quantity: 2000,
      unmatched_quantity: 16,
    }],
  );
});
