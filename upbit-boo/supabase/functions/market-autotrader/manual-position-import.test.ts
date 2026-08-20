import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { manualFillInventory, resolveManualPositions } from "./manual-position-import.ts";

const NOW = Date.parse("2026-08-08T09:00:00Z");

const snapshot = (
  exchange: string,
  balances: Array<Record<string, unknown>>,
  prices: Record<string, number>,
) => ({
  exchange,
  captured_at: "2026-08-08T08:59:30Z",
  balances,
  prices,
});

Deno.test("manual balance is imported after bot and residual quantities are removed", () => {
  const result = resolveManualPositions({
    trackedPositions: [{
      id: "bot-eth",
      exchange: "binance",
      market: "ETHUSDT",
      base_asset: "ETH",
      state: "OPEN",
      is_paper: false,
      remaining_quantity: 0.5,
    }],
    residualInventory: [{
      exchange: "binance",
      market: "ETHUSDT",
      asset: "ETH",
      remaining_quantity: 0.1,
    }],
    snapshots: [snapshot(
      "binance",
      [
        { asset: "USDT", free: 100, locked: 0 },
        { asset: "ETH", free: 1.5, locked: 0 },
        { asset: "BNB", free: 0.002, locked: 0 },
      ],
      { ETHUSDT: 2000, BNBUSDT: 300 },
    )],
    manualFills: [{
      exchange: "binance",
      market: "ETHUSDT",
      source: "MANUAL",
      position_id: null,
      side: "BUY",
      price: 1800,
      quantity: 1,
      quote_amount: 1800,
      base_asset: "ETH",
      fee_asset: "ETH",
      fee_amount: 0.001,
      fee_quote_amount: 1.8,
      executed_at: "2026-08-08T08:00:00Z",
      exchange_trade_id: 10,
    }],
    nowMs: NOW,
  });

  assertEquals(result.positions.length, 1);
  const manual = result.positions[0];
  assertEquals(manual.id, "manual:binance:ETHUSDT");
  assertEquals(manual.state, "MANUAL");
  assertEquals(manual.is_manual, true);
  assertAlmostEquals(manual.remaining_quantity, 0.9, 1e-12);
  assertAlmostEquals(manual.average_entry_price, 1800 / 0.999, 1e-9);
  assertEquals(manual.metadata.exclude_from_learning, true);
  assertEquals(manual.metadata.auto_exit_enabled, false);
  assertEquals(manual.metadata.manual_import.cost_basis_source, "MANUAL_FILL_LEDGER");
});

Deno.test("upbit manual balance uses the exchange account average", () => {
  const result = resolveManualPositions({
    trackedPositions: [],
    snapshots: [snapshot(
      "upbit",
      [
        { currency: "KRW", balance: 500000, locked: 0, avg_buy_price: 1 },
        { currency: "XRP", balance: 100, locked: 0, avg_buy_price: 3000 },
      ],
      { "KRW-XRP": 3100 },
    )],
    nowMs: NOW,
  });

  assertEquals(result.positions.length, 1);
  assertEquals(result.positions[0].market, "KRW-XRP");
  assertEquals(result.positions[0].average_entry_price, 3000);
  assertEquals(
    result.positions[0].metadata.manual_import.cost_basis_source,
    "EXCHANGE_ACCOUNT_AVERAGE",
  );
});

Deno.test("unassigned account balance remains visible even before fill sync", () => {
  const result = resolveManualPositions({
    trackedPositions: [],
    snapshots: [snapshot(
      "binance",
      [{ asset: "USDT", free: 100 }, { asset: "BICO", free: 100 }],
      { BICOUSDT: 0.03 },
    )],
    manualFills: [],
    nowMs: NOW,
  });

  assertEquals(result.positions.length, 1);
  assertEquals(result.positions[0].average_entry_price, null);
  assertEquals(
    result.positions[0].metadata.manual_import.cost_basis_source,
    "UNASSIGNED_ACCOUNT_BALANCE",
  );
});

Deno.test("sub-dollar and unpriced manual balances are not displayed", () => {
  const result = resolveManualPositions({
    trackedPositions: [],
    snapshots: [
      snapshot(
        "binance",
        [
          { asset: "USDT", free: 100 },
          { asset: "DUST", free: 9.99 },
          { asset: "ONE", free: 10 },
        ],
        { DUSTUSDT: 0.1, ONEUSDT: 0.1 },
      ),
      snapshot(
        "upbit",
        [
          { currency: "KRW", balance: 100000 },
          { currency: "APENFT", balance: 135423.99244068 },
        ],
        {},
      ),
    ],
    nowMs: NOW,
  });

  assertEquals(result.positions.map((row) => row.id), ["manual:binance:ONEUSDT"]);
  assertEquals(result.positions[0].metadata.manual_import.value_quote, 1);
});

Deno.test("a pending bot entry is never misclassified as a manual buy", () => {
  const result = resolveManualPositions({
    trackedPositions: [{
      exchange: "binance",
      market: "ETHUSDT",
      base_asset: "ETH",
      state: "ENTRY_PENDING",
      is_paper: false,
      remaining_quantity: 0,
      reserved_quote: 100,
    }],
    snapshots: [snapshot(
      "binance",
      [{ asset: "USDT", free: 100 }, { asset: "ETH", free: 0.02 }],
      { ETHUSDT: 3000 },
    )],
    nowMs: NOW,
  });

  assertEquals(result.positions.length, 0);
});

Deno.test("manual sells reduce the remaining manual cost basis", () => {
  const inventory = manualFillInventory([
    {
      exchange: "binance",
      market: "ETHUSDT",
      source: "MANUAL",
      position_id: null,
      side: "BUY",
      quantity: 1,
      quote_amount: 2000,
      base_asset: "ETH",
      fee_asset: "USDT",
      fee_amount: 0,
      fee_quote_amount: 2,
      executed_at: "2026-08-08T07:00:00Z",
      exchange_trade_id: 1,
    },
    {
      exchange: "binance",
      market: "ETHUSDT",
      source: "MANUAL",
      position_id: null,
      side: "SELL",
      quantity: 0.4,
      quote_amount: 900,
      base_asset: "ETH",
      fee_asset: "USDT",
      fee_amount: 0,
      fee_quote_amount: 0.9,
      executed_at: "2026-08-08T08:00:00Z",
      exchange_trade_id: 2,
    },
  ]).get("binance:ETHUSDT");

  assertAlmostEquals(inventory?.quantity ?? 0, 0.6, 1e-12);
  assertAlmostEquals(inventory?.costQuote ?? 0, 1201.2, 1e-9);
});
