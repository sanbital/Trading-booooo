import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Regression tests for the 2026-07-26 production incident.
 *
 * Binance spot deducts the BUY commission from the base asset when BNB fee payment is off.
 * The ledger booked the GROSS matched quantity, so it permanently expected ~0.1% more coin
 * than the account held; the reconciliation read that as a user sale and halted the entire
 * system. Observed: binance:AVAXUSDT shortfall 0.2528 USDT vs a computed commission of
 * 0.2526 USDT.
 *
 * The two functions under test live inside market-autotrader/index.ts, which cannot be
 * imported without a live environment, so the logic is mirrored here exactly. Keep these
 * in sync with baseAssetFee() and the feeDustTolerance block.
 */

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function baseAssetFee(order: any, fill: any, baseAssetSymbol: string): number {
  const symbol = String(baseAssetSymbol || "").toUpperCase();
  if (!symbol) return 0;
  const trades = Array.isArray(order?.trades) ? order.trades : Array.isArray(fill?.trades) ? fill.trades : [];
  if (trades.length) {
    return trades.reduce(
      (total: number, trade: any) =>
        String(trade?.fee_asset || "").toUpperCase() === symbol ? total + Math.max(0, finite(trade?.fee)) : total,
      0,
    );
  }
  const aggregateAsset = String(fill?.feeAsset || order?.fee_asset || "").toUpperCase();
  return aggregateAsset === symbol ? Math.max(0, finite(fill?.paidFee, order?.paid_fee)) : 0;
}

function feeDustTolerance(expected: number, quantityStep: number, feePct: number): number {
  return Math.max(quantityStep * 2, expected * feePct / 100 * 3);
}

Deno.test("the AVAXUSDT incident is reproduced and corrected", () => {
  // Figures as displayed on the dashboard at the time of the halt.
  const notional = 261.4076;
  const price = 6.781;
  const accountQuantity = 38.51275; // what Binance actually held
  const reportedShortfallQuote = 0.2528; // what the reconciliation flagged

  const gross = notional / price; // 38.55001 — what the ledger booked
  const commission = gross * 0.001; // Binance 0.1%, charged in AVAX
  const order = { trades: [{ fee: commission, fee_asset: "AVAX" }] };

  const fee = baseAssetFee(order, {}, "AVAX");
  // Booking net reproduces the balance the account actually showed. The small residual is
  // the dashboard's rounded entry price against the true fill VWAP.
  assertAlmostEquals(gross - fee, accountQuantity, 0.005);
  // And the commission explains the flagged shortfall to within that same rounding.
  const shortfallQuote = (gross - accountQuantity) * price;
  assertAlmostEquals(shortfallQuote, reportedShortfallQuote, 0.001);
  assert(Math.abs(fee * price - reportedShortfallQuote) / reportedShortfallQuote < 0.05);
});

Deno.test("quote-denominated fees never reduce the base quantity", () => {
  // Upbit charges in KRW on both sides, which is why the mismatch was Binance-only.
  const order = { trades: [{ fee: 326, fee_asset: "KRW" }] };
  assertEquals(baseAssetFee(order, {}, "ETH"), 0);
});

Deno.test("BNB-denominated fees never reduce the base quantity", () => {
  // Enabling BNB fee payment sidesteps the whole problem at the exchange.
  const order = { trades: [{ fee: 0.004, fee_asset: "BNB" }] };
  assertEquals(baseAssetFee(order, {}, "AVAX"), 0);
});

Deno.test("mixed fee assets across fills are summed only for the base asset", () => {
  const order = {
    trades: [
      { fee: 0.01, fee_asset: "AVAX" },
      { fee: 0.002, fee_asset: "BNB" },
      { fee: 0.03, fee_asset: "AVAX" },
    ],
  };
  assertAlmostEquals(baseAssetFee(order, {}, "AVAX"), 0.04, 1e-12);
});

Deno.test("aggregate fee fields are used when per-fill data is absent", () => {
  assertAlmostEquals(baseAssetFee(null, { feeAsset: "AVAX", paidFee: 0.0372 }, "AVAX"), 0.0372, 1e-12);
  assertEquals(baseAssetFee(null, { feeAsset: "USDT", paidFee: 0.26 }, "AVAX"), 0);
  // "MIXED" is not a base asset and must not be silently subtracted.
  assertEquals(baseAssetFee(null, { feeAsset: "MIXED", paidFee: 0.26 }, "AVAX"), 0);
});

Deno.test("a missing base asset symbol subtracts nothing", () => {
  assertEquals(baseAssetFee({ trades: [{ fee: 1, fee_asset: "AVAX" }] }, {}, ""), 0);
});

Deno.test("the v5.2.5 tolerance could not absorb a commission-sized shortfall", () => {
  const expected = 38.55001;
  const actual = 38.51275;
  // Old rule: anything below expected * 0.999999 counted as missing.
  assert(actual < expected * 0.999999, "old tolerance flagged this as a manual sale");
  // New rule: three times the fee rate covers it comfortably.
  const shortfall = expected - actual;
  assert(shortfall <= feeDustTolerance(expected, 0.00001, 0.1));
});

Deno.test("a genuine sale is still far outside the fee tolerance", () => {
  const expected = 38.55001;
  const tolerance = feeDustTolerance(expected, 0.00001, 0.1);
  // Half the position gone is not fee dust.
  assert(expected * 0.5 > tolerance);
  // Even a 1% reduction exceeds the 0.3% band.
  assert(expected * 0.01 > tolerance);
});

Deno.test("step-size dust is covered on illiquid symbols", () => {
  // A coarse step size dominates the tolerance when the fee term is tiny.
  const tolerance = feeDustTolerance(0.5, 0.001, 0.05);
  assertAlmostEquals(tolerance, 0.002, 1e-12);
});
