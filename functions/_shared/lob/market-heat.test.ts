import { rankMarketHeat } from "./market-heat.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("market heat ranks fresh flow acceleration above stale 24h turnover", () => {
  const base = 1_000_000;
  const rows = rankMarketHeat([
    [
      { market: "BIG", timestampMs: 0, price: 100, turnover24hQuote: 10_000_000_000, tradeCount: 1000 },
      { market: "HOT", timestampMs: 0, price: 100, turnover24hQuote: 1_000_000_000, tradeCount: 100 },
    ],
    [
      { market: "BIG", timestampMs: 1000, price: 100, turnover24hQuote: 10_000_000_000 + base, tradeCount: 1002 },
      { market: "HOT", timestampMs: 1000, price: 100, turnover24hQuote: 1_000_000_000 + base, tradeCount: 102 },
    ],
    [
      { market: "BIG", timestampMs: 2000, price: 100, turnover24hQuote: 10_000_000_000 + base * 2, tradeCount: 1004 },
      { market: "HOT", timestampMs: 2000, price: 100, turnover24hQuote: 1_000_000_000 + base * 21, tradeCount: 132 },
    ],
  ], {
    minimumTurnover24hQuote: 100_000_000,
    referenceRecentNotionalPerSecond: 5_000_000,
    referenceTradeCountPerSecond: 10,
  });
  assert(rows[0].market === "HOT", "accelerating tape must rank first");
  assert(rows[0].notionalAcceleration > rows[1].notionalAcceleration, "acceleration must be visible");
});
