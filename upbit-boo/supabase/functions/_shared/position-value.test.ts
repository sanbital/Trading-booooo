import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  baseAssetOf,
  createBalanceAllocator,
  dustQuoteFor,
  estimateManualExit,
  resolveHolding,
  snapshotBalanceMap,
  snapshotIsUsable,
} from "./position-value.ts";

Deno.test("the dust floor is one dollar in each quote currency", () => {
  assertEquals(dustQuoteFor("binance"), 1);
  assertEquals(dustQuoteFor("upbit"), 1400);
});

Deno.test("base asset is read from the market when the ledger column is empty", () => {
  assertEquals(baseAssetOf("binance", "BICOUSDT"), "BICO");
  assertEquals(baseAssetOf("upbit", "KRW-ETH"), "ETH");
  assertEquals(baseAssetOf("binance", "BICOUSDT", "bico"), "BICO");
});

Deno.test("snapshot balances sum free and locked so a resting bot order is still ours", () => {
  const map = snapshotBalanceMap([
    { currency: "BICO", balance: 0, locked: 0 },
    { asset: "ETH", free: 0.5, locked: 0.25 },
  ]);
  assertEquals(map.get("BICO"), 0);
  assertAlmostEquals(map.get("ETH") ?? 0, 0.75, 1e-12);
});

Deno.test("a stale or empty snapshot can never declare a holding gone", () => {
  const now = Date.parse("2026-08-06T00:00:00Z");
  const fresh = {
    captured_at: "2026-08-05T23:58:00Z",
    balances: [{ currency: "ETH", balance: 1 }],
  };
  assertEquals(snapshotIsUsable(fresh, now), true);
  assertEquals(
    snapshotIsUsable({ captured_at: "2026-08-05T20:00:00Z", balances: [{ currency: "ETH" }] }, now),
    false,
  );
  assertEquals(snapshotIsUsable({ captured_at: "2026-08-05T23:58:00Z", balances: [] }, now), false);
  assertEquals(snapshotIsUsable(null, now), false);
});

Deno.test("a manually sold position resolves to nothing and is flagged as vanished", () => {
  const holding = resolveHolding({
    ledgerQuantity: 816.17509,
    exchangeQuantity: 0,
    price: 0.0295,
    dustQuote: 1,
  });
  assertEquals(holding.effectiveQuantity, 0);
  assertAlmostEquals(holding.missingQuantity, 816.17509, 1e-9);
  assertEquals(holding.isDust, true);
  assertEquals(holding.vanished, true);
});

Deno.test("a holding worth a dollar or less is dust even when the balance agrees", () => {
  const holding = resolveHolding({
    ledgerQuantity: 20,
    exchangeQuantity: 20,
    price: 0.04,
    dustQuote: 1,
  });
  assertAlmostEquals(holding.effectiveValueQuote, 0.8, 1e-12);
  assertEquals(holding.isDust, true);
  assertEquals(holding.vanished, false);
});

Deno.test("a live position above the floor is untouched", () => {
  const holding = resolveHolding({
    ledgerQuantity: 533.2,
    exchangeQuantity: 533.2,
    price: 0.1305,
    dustQuote: 1,
  });
  assertAlmostEquals(holding.effectiveQuantity, 533.2, 1e-12);
  assertEquals(holding.isDust, false);
  assertEquals(holding.vanished, false);
});

Deno.test("an unreadable balance leaves the ledger quantity in place", () => {
  const holding = resolveHolding({
    ledgerQuantity: 100,
    exchangeQuantity: null,
    price: 2,
    dustQuote: 1,
  });
  assertEquals(holding.effectiveQuantity, 100);
  assertEquals(holding.balanceKnown, false);
  assertEquals(holding.vanished, false);
});

Deno.test("an unpriced position is never declared worthless", () => {
  const holding = resolveHolding({
    ledgerQuantity: 100,
    exchangeQuantity: 100,
    price: 0,
    dustQuote: 1,
  });
  assertEquals(holding.isDust, false);
});

Deno.test("one balance cannot be claimed twice by two positions on the same asset", () => {
  const allocate = createBalanceAllocator(snapshotBalanceMap([{ currency: "ETH", balance: 1.2 }]));
  assertAlmostEquals(allocate("ETH", 1), 1, 1e-12);
  assertAlmostEquals(allocate("ETH", 1), 0.2, 1e-12);
  assertEquals(allocate("ETH", 1), 0);
  assertEquals(allocate("BICO", 5), 0);
});

Deno.test("manual exit proceeds are marked at price less one taker fee", () => {
  const estimate = estimateManualExit({
    missingQuantity: 816.17509,
    markPrice: 0.0295,
    feePctPerSide: 0.1,
  });
  assertAlmostEquals(estimate.grossProceedsQuote, 24.07716, 1e-5);
  assertAlmostEquals(estimate.feeQuote, 0.02407716, 1e-8);
  assertAlmostEquals(estimate.netProceedsQuote, 24.05308, 1e-5);
});
