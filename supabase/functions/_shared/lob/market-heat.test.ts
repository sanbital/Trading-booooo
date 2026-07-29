import { rankMarketHeat } from "./market-heat.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("markets rank strictly by 24h gain while weakening flow is marked for exclusion", () => {
  const base = 1_000_000;
  const rows = rankMarketHeat([
    [
      {
        market: "GAINER",
        timestampMs: 0,
        price: 100,
        turnover24hQuote: 10_000_000_000,
        tradeCount: 1000,
        change24hPct: 30,
      },
      {
        market: "FLOW",
        timestampMs: 0,
        price: 100,
        turnover24hQuote: 1_000_000_000,
        tradeCount: 100,
        change24hPct: 10,
      },
    ],
    [
      {
        market: "GAINER",
        timestampMs: 1000,
        price: 100,
        turnover24hQuote: 10_000_000_000 + base * 10,
        tradeCount: 1010,
        change24hPct: 30,
      },
      {
        market: "FLOW",
        timestampMs: 1000,
        price: 100,
        turnover24hQuote: 1_000_000_000 + base,
        tradeCount: 102,
        change24hPct: 10,
      },
    ],
    [
      {
        market: "GAINER",
        timestampMs: 2000,
        price: 100,
        turnover24hQuote: 10_000_000_000 + base * 11,
        tradeCount: 1011,
        change24hPct: 30,
      },
      {
        market: "FLOW",
        timestampMs: 2000,
        price: 100,
        turnover24hQuote: 1_000_000_000 + base * 21,
        tradeCount: 132,
        change24hPct: 10,
      },
    ],
  ], {
    minimumTurnover24hQuote: 100_000_000,
    referenceRecentNotionalPerSecond: 5_000_000,
    referenceTradeCountPerSecond: 10,
  });
  assert(rows[0].market === "GAINER", "24h percentage gain must own the rank");
  assert(!rows[0].flowHealthy, "declining notional and trade speed must exclude the leader");
  assert(rows[1].flowHealthy, "rank two remains eligible when its live flow accelerates");
});
