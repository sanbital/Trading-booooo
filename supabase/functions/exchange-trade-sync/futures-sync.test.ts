import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { combineSyncCounters, futuresMarketUniverse } from "./futures-sync.ts";

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
