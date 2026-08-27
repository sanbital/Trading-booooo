import {
  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  p10PendingReservationExpired,
  p10PreOrderEntryDisposition,
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

Deno.test("pre-order anti-chase DB rejection is a routine policy block", () => {
  assertEquals(
    p10PreOrderEntryDisposition(
      'database 400: {"code":"P0001","message":"P10_ENTRY_BLOCKED:LONG_OVERBOUGHT_RSI:70.69"}',
    ),
    { kind: "POLICY_BLOCK", reason: "P10_ENTRY_BLOCKED:LONG_OVERBOUGHT_RSI:70.69" },
  );
});

Deno.test("all canonical P10 entry-block reasons classify without enumerating each guard", () => {
  assertEquals(
    p10PreOrderEntryDisposition(
      "P10_ENTRY_BLOCKED:SHORT_OPPOSING_MARKET_FORECAST:STRONG_BULL",
    ),
    {
      kind: "POLICY_BLOCK",
      reason: "P10_ENTRY_BLOCKED:SHORT_OPPOSING_MARKET_FORECAST:STRONG_BULL",
    },
  );
  assertEquals(
    p10PreOrderEntryDisposition("P10_ENTRY_BLOCKED:MARKET_OBSERVATION_UNAVAILABLE"),
    { kind: "POLICY_BLOCK", reason: "P10_ENTRY_BLOCKED:MARKET_OBSERVATION_UNAVAILABLE" },
  );
});

Deno.test("ordinary pre-order failure is not mislabeled as policy or reconciliation", () => {
  assertEquals(
    p10PreOrderEntryDisposition("database 500: connection unavailable"),
    { kind: "PREORDER_ERROR", reason: "database 500: connection unavailable" },
  );
});

Deno.test("post-submit lookup ambiguity is not a pre-order policy block", () => {
  assertEquals(
    p10PreOrderEntryDisposition("Order does not exist."),
    { kind: "PREORDER_ERROR", reason: "Order does not exist." },
  );
});

Deno.test("P10 pending reservation expiry uses the explicit boundary", () => {
  const expiry = Date.parse("2026-08-27T14:07:09.000Z");
  const base = {
    state: "ENTRY_PENDING",
    reservationExpiresAt: "2026-08-27T14:07:09.000Z",
  };
  assertEquals(p10PendingReservationExpired({ ...base, nowMs: expiry - 1 }), false);
  assertEquals(p10PendingReservationExpired({ ...base, nowMs: expiry }), true);
  assertEquals(p10PendingReservationExpired({ ...base, nowMs: expiry + 1 }), true);
});

Deno.test("P10 pending reservation expiry falls back to creation time for legacy rows", () => {
  const createdAt = "2026-08-27T14:04:09.000Z";
  assertEquals(
    p10PendingReservationExpired({
      state: "ENTRY_PENDING",
      reservationExpiresAt: null,
      createdAt,
      nowMs: Date.parse("2026-08-27T14:07:09.000Z"),
    }),
    true,
  );
  assertEquals(
    p10PendingReservationExpired({
      state: "OPEN",
      reservationExpiresAt: "2020-01-01T00:00:00.000Z",
      createdAt,
      nowMs: Date.parse("2026-08-27T14:07:09.000Z"),
    }),
    false,
  );
});

Deno.test("P10 pending reservation without any trustworthy clock stays fail-closed", () => {
  assertEquals(
    p10PendingReservationExpired({
      state: "ENTRY_PENDING",
      reservationExpiresAt: null,
      createdAt: null,
      nowMs: Date.now(),
    }),
    false,
  );
});
