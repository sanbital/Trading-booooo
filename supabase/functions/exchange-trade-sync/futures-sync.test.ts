import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  combineSyncCounters,
  exactFuturesOrderHistory,
  futuresMarketUniverse,
  futuresOrderDiagnosticRequest,
} from "./futures-sync.ts";

const syncSource = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("exchange-only futures exposure is always in the sync universe", () => {
  assertEquals(
    futuresMarketUniverse({
      portfolioPositions: [{ market: "MAGMAUSDT", quantity: 1029 }],
      orders: [{ market: "BTCUSDT" }],
      positions: [],
      syncStates: [{ market: "ETHUSDT" }],
    }),
    ["MAGMAUSDT", "BTCUSDT", "ETHUSDT"],
  );
});

Deno.test("zero-sized exchange positions do not invent sync markets", () => {
  assertEquals(
    futuresMarketUniverse({
      portfolioPositions: [
        { symbol: "ZEROUSDT", positionAmt: "0" },
        { symbol: "SHORTUSDT", positionAmt: "-2.5" },
      ],
      orders: [],
      positions: [],
      syncStates: [],
    }),
    ["SHORTUSDT"],
  );
});

Deno.test("top-level metrics include futures evidence", () => {
  assertEquals(
    combineSyncCounters(
      { markets: 2, succeeded: 2, seen: 0, upserted: 0, automated: 0, manual: 0, unmatched: 0 },
      { markets: 3, succeeded: 3, seen: 60, upserted: 60, automated: 4, manual: 56, unmatched: 56 },
    ),
    { markets: 5, succeeded: 5, seen: 60, upserted: 60, automated: 4, manual: 56, unmatched: 56 },
  );
});

Deno.test("futures-only ingestion refreshes the futures scorecard contract", () => {
  assertEquals(syncSource.includes("if (futuresSync.upserted > 0)"), true);
  assertEquals(syncSource.includes('p_exchange: "binance_futures"'), true);
  assertEquals(syncSource.includes("spot_sync:"), true);
  assertEquals(syncSource.includes("totals,"), true);
});

Deno.test("read-only order diagnostic accepts only a strict USDT market and numeric order id", () => {
  assertEquals(
    futuresOrderDiagnosticRequest({ market: "magmausdt", order_id: "1444776244" }),
    { ok: true, value: { market: "MAGMAUSDT", orderId: "1444776244" } },
  );
  assertEquals(
    futuresOrderDiagnosticRequest({ market: "MAGMAUSDT;DROP", order_id: "1444776244" }),
    { ok: false, error: "INVALID_FUTURES_MARKET" },
  );
  assertEquals(
    futuresOrderDiagnosticRequest({ market: "MAGMAUSDT", order_id: "all" }),
    { ok: false, error: "INVALID_FUTURES_ORDER_ID" },
  );
});

Deno.test("order diagnostic returns only the exact order and a fixed safe field set", () => {
  assertEquals(
    exactFuturesOrderHistory([
      { orderId: 1, clientOrderId: "other", apiKey: "must-not-leak" },
      {
        symbol: "MAGMAUSDT",
        orderId: 1444776244,
        clientOrderId: "origin-proof",
        side: "BUY",
        status: "FILLED",
        executedQty: "1029",
        secret: "must-not-leak",
      },
    ], "1444776244"),
    [{
      symbol: "MAGMAUSDT",
      orderId: 1444776244,
      clientOrderId: "origin-proof",
      side: "BUY",
      positionSide: null,
      type: null,
      origType: null,
      status: "FILLED",
      timeInForce: null,
      price: null,
      avgPrice: null,
      origQty: null,
      executedQty: "1029",
      cumQuote: null,
      reduceOnly: null,
      closePosition: null,
      time: null,
      updateTime: null,
    }],
  );
});
