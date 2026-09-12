import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { allocateNormalizedTradeFees, resolveFeeQuote } from "./fee-accounting.ts";

Deno.test("Upbit aggregate paid_fee survives when individual trades omit fee", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "KRW",
    baseAsset: "EUL",
    defaultFeePct: 0.05,
    order: {
      paid_fee: 10.99999999329,
      fee_asset: "KRW",
      executed_funds: 21999.99998658,
      trades: [{ fee: 0, fee_asset: "KRW", funds: 21999.99998658 }],
    },
  });
  assertEquals(resolved.source, "AGGREGATE_QUOTE");
  assertEquals(resolved.estimated, false);
  assertEquals(resolved.complete, true);
  assertAlmostEquals(resolved.feeQuote, 10.99999999329, 1e-12);
});

Deno.test("Upbit aggregate exit fee is allocated across fills without changing the total", () => {
  const totalFee = 11.001018941945;
  const allocated = allocateNormalizedTradeFees({
    quoteAsset: "KRW",
    baseAsset: "EUL",
    defaultFeePct: 0.05,
    aggregatePaidFee: totalFee,
    aggregateFeeAsset: "KRW",
    executedFunds: 22002.03788389,
    trades: [
      { fee: 0, fee_asset: "KRW", funds: 5000.99999874 },
      { fee: 0, fee_asset: "KRW", funds: 1260.97635081 },
      { fee: 0, fee_asset: "KRW", funds: 15740.06153434 },
    ],
  });
  const sum = allocated.reduce((value, row) => value + row.feeQuoteEstimate, 0);
  assertAlmostEquals(sum, totalFee, 1e-12);
  assertEquals(allocated.every((row) => row.feeAsset === "KRW"), true);
  assertEquals(allocated.every((row) => row.source === "AGGREGATE_QUOTE"), true);
});

Deno.test("confirmed KRW-EUL trade changes from false profit to actual net loss", () => {
  const entryFunds = 21999.99998658;
  const exitFunds = 22002.03788389;
  const entryFee = 10.99999999329;
  const exitFee = 11.001018941945;
  const net = exitFunds - entryFunds - entryFee - exitFee;
  assertAlmostEquals(net, -19.963121625235, 1e-9);
});

Deno.test("Binance quote-asset commissions remain exact", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "USDT",
    baseAsset: "BTC",
    defaultFeePct: 0.1,
    order: {
      trades: [{ fee: 0.04358617, fee_asset: "USDT", funds: 43.58617 }],
    },
  });
  assertEquals(resolved.source, "PER_FILL_QUOTE");
  assertAlmostEquals(resolved.feeQuote, 0.04358617, 1e-12);
});

Deno.test("Binance BNB commissions retain a conservative quote estimate", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "USDT",
    baseAsset: "XRP",
    defaultFeePct: 0.1,
    order: {
      trades: [{ fee: 0.00005827, fee_asset: "BNB", funds: 28.42 }],
    },
  });
  assertEquals(resolved.source, "ESTIMATED_THIRD_ASSET");
  assertEquals(resolved.estimated, true);
  assertAlmostEquals(resolved.feeQuote, 0.02842, 1e-12);
});


Deno.test("a genuine zero aggregate fee stays zero when fallback estimation is disabled", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "KRW",
    baseAsset: "EUL",
    defaultFeePct: 0.05,
    order: { paid_fee: 0, fee_asset: "KRW", executed_funds: 22000, trades: [] },
    estimateWhenMissing: false,
  });
  assertEquals(resolved.source, "MISSING");
  assertEquals(resolved.complete, false);
  assertEquals(resolved.feeQuote, 0);
});

Deno.test("Binance executed order without fill details gets a conservative fee estimate", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "USDT",
    baseAsset: "BTC",
    defaultFeePct: 0.1,
    order: { executed_funds: 43.58617, trades: [] },
    estimateWhenMissing: true,
  });
  assertEquals(resolved.source, "ESTIMATED_MISSING");
  assertEquals(resolved.estimated, true);
  assertEquals(resolved.complete, false);
  assertAlmostEquals(resolved.feeQuote, 0.04358617, 1e-12);
});

Deno.test("base-asset commission is not double-counted as quote fee", () => {
  const resolved = resolveFeeQuote({
    quoteAsset: "USDT",
    baseAsset: "BNB",
    defaultFeePct: 0.1,
    order: {
      trades: [{ fee: 0.0000525, fee_asset: "BNB", funds: 40.1338 }],
    },
  });
  assertEquals(resolved.source, "BASE_ASSET");
  assertEquals(resolved.feeQuote, 0);
});
