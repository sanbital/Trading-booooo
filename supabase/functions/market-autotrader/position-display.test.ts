import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveDisplayPositions } from "./position-display.ts";

const NOW = Date.parse("2026-08-06T06:00:00Z");
const FRESH = "2026-08-06T05:58:00Z";

const snapshot = (
  exchange: string,
  balances: Record<string, number>,
  prices: Record<string, number>,
  capturedAt = FRESH,
) => ({
  exchange,
  captured_at: capturedAt,
  balances: Object.entries(balances).map(([currency, balance]) => ({ currency, balance })),
  prices,
});

Deno.test("a manually sold coin leaves the position table", () => {
  const result = resolveDisplayPositions(
    [
      {
        id: "bico",
        exchange: "binance",
        market: "BICOUSDT",
        base_asset: "BICO",
        state: "OPEN",
        remaining_quantity: 816.17509,
        average_entry_price: 0.02766,
        created_at: "2026-08-06T00:25:49Z",
      },
      {
        id: "zbt",
        exchange: "binance",
        market: "ZBTUSDT",
        base_asset: "ZBT",
        state: "OPEN",
        remaining_quantity: 533.2,
        average_entry_price: 0.131,
        created_at: "2026-08-06T05:32:55Z",
      },
    ],
    [snapshot("binance", { ZBT: 533.2, USDT: 400 }, { BICOUSDT: 0.0295, ZBTUSDT: 0.1305 })],
    NOW,
  );

  assertEquals(result.positions.map((row) => row.id), ["zbt"]);
  assertEquals(result.settled.length, 1);
  assertEquals(result.settled[0].reason, "MANUAL_SELL_RECONCILED");
  assertAlmostEquals(result.settled[0].missing_quantity, 816.17509, 1e-9);
  assertEquals(result.rule.balance_readable.binance, true);
});

Deno.test("a holding worth a dollar or less is not a position", () => {
  const result = resolveDisplayPositions(
    [
      {
        id: "dust",
        exchange: "binance",
        market: "HMSTRUSDT",
        base_asset: "HMSTR",
        state: "EXITING",
        remaining_quantity: 2500,
        average_entry_price: 0.0002009,
        created_at: "2026-08-06T00:10:02Z",
      },
    ],
    [snapshot("binance", { HMSTR: 2500 }, { HMSTRUSDT: 0.0001383 })],
    NOW,
  );

  assertEquals(result.positions.length, 0);
  assertEquals(result.settled[0].reason, "DUST_BELOW_MIN_VALUE");
  assertAlmostEquals(result.settled[0].value_quote, 0.345750, 1e-6);
});

Deno.test("a stale snapshot leaves every ledger row in place", () => {
  const rows = [{
    id: "bico",
    exchange: "binance",
    market: "BICOUSDT",
    base_asset: "BICO",
    state: "OPEN",
    remaining_quantity: 816.17509,
    average_entry_price: 0.02766,
    created_at: "2026-08-06T00:25:49Z",
  }];
  const result = resolveDisplayPositions(
    rows,
    [snapshot("binance", {}, { BICOUSDT: 0.0295 }, "2026-08-06T02:00:00Z")],
    NOW,
  );

  assertEquals(result.positions.length, 1);
  assertEquals(result.settled.length, 0);
  assertEquals(result.rule.balance_readable.binance, false);
});

Deno.test("a stale snapshot's price cannot declare a real holding worthless", () => {
  // The entry cleared the exchange minimum, so on its own cost basis it is never dust —
  // whatever a snapshot we already rejected as stale claims the price is now.
  const result = resolveDisplayPositions(
    [{
      id: "crashed-price",
      exchange: "binance",
      market: "HMSTRUSDT",
      base_asset: "HMSTR",
      state: "OPEN",
      remaining_quantity: 229243.53,
      average_entry_price: 0.0002009,
      created_at: "2026-08-06T00:10:02Z",
    }],
    [snapshot("binance", {}, { HMSTRUSDT: 0.0000000001 }, "2026-08-06T02:00:00Z")],
    NOW,
  );

  assertEquals(result.positions.length, 1);
  assertEquals(result.settled.length, 0);
});

Deno.test("a pending entry is judged by its reservation, never by the base balance", () => {
  const result = resolveDisplayPositions(
    [{
      id: "pending",
      exchange: "upbit",
      market: "KRW-ETH",
      base_asset: "ETH",
      state: "ENTRY_PENDING",
      remaining_quantity: 0,
      reserved_quote: 200000,
      created_at: "2026-08-06T05:59:00Z",
    }],
    [snapshot("upbit", { KRW: 500000 }, { "KRW-ETH": 4200000 })],
    NOW,
  );

  assertEquals(result.positions.length, 1);
  assertEquals(result.settled.length, 0);
});

Deno.test("one balance cannot keep two ledger rows on the same asset alive", () => {
  const result = resolveDisplayPositions(
    [
      {
        id: "older",
        exchange: "binance",
        market: "ETHUSDT",
        base_asset: "ETH",
        state: "OPEN",
        remaining_quantity: 0.02,
        average_entry_price: 2000,
        created_at: "2026-08-06T01:00:00Z",
      },
      {
        id: "newer",
        exchange: "binance",
        market: "ETHUSDT",
        base_asset: "ETH",
        state: "OPEN",
        remaining_quantity: 0.02,
        average_entry_price: 2000,
        created_at: "2026-08-06T02:00:00Z",
      },
    ],
    [snapshot("binance", { ETH: 0.02 }, { ETHUSDT: 2000 })],
    NOW,
  );

  assertEquals(result.positions.map((row) => row.id), ["older"]);
  assertEquals(result.settled.map((row) => row.id), ["newer"]);
});

Deno.test("upbit uses its own won-denominated floor", () => {
  const result = resolveDisplayPositions(
    [{
      id: "krw-dust",
      exchange: "upbit",
      market: "KRW-XRP",
      base_asset: "XRP",
      state: "OPEN",
      remaining_quantity: 0.4,
      average_entry_price: 3000,
      created_at: "2026-08-06T03:00:00Z",
    }],
    [snapshot("upbit", { XRP: 0.4 }, { "KRW-XRP": 3000 })],
    NOW,
  );

  // 0.4 × 3,000 = 1,200원, below the 1,400원 floor.
  assertEquals(result.positions.length, 0);
  assertEquals(result.settled[0].reason, "DUST_BELOW_MIN_VALUE");
});
