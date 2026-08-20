import { rankMarketHeat, type MarketHeatTicker } from "./market-heat.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function snapshot(
  timestampMs: number,
  stage: "early" | "previous" | "latest",
): MarketHeatTicker[] {
  return Array.from({ length: 11 }, (_, index) => {
    const rank = index + 1;
    const baseTurnover = 1_000_000 + rank * 10_000;
    const baseCount = 1_000 + rank * 10;
    const previousNotional = 1_000;
    const recentNotional = rank === 3 ? 100 : rank === 10 ? 0 : 1_200;
    const previousTrades = 10;
    const recentTrades = rank === 7 ? 1 : rank === 10 ? 0 : 12;

    const turnover24hQuote = stage === "early"
      ? baseTurnover
      : stage === "previous"
      ? baseTurnover + previousNotional
      : baseTurnover + previousNotional + recentNotional;
    const tradeCount = stage === "early"
      ? baseCount
      : stage === "previous"
      ? baseCount + previousTrades
      : baseCount + previousTrades + recentTrades;

    return {
      market: `M${rank}`,
      timestampMs,
      price: 100 + rank,
      turnover24hQuote,
      tradeCount,
      change24hPct: 21 - rank,
      range24hPct: 5,
    };
  });
}

Deno.test("strict 24h Top 10 is fully observed without weakening-flow prefilter", () => {
  const ranked = rankMarketHeat(
    [snapshot(1_000, "early"), snapshot(2_000, "previous"), snapshot(3_000, "latest")],
    {
      minimumTurnover24hQuote: 1,
      referenceRecentNotionalPerSecond: 1_000,
      referenceTradeCountPerSecond: 10,
    },
  );

  const observed = ranked.slice(0, 10).filter((row) => row.flowHealthy);
  assert(observed.length === 10, `expected all Top 10, got ${observed.length}`);
  assert(observed.every((row, index) => row.market === `M${index + 1}`), "Top 10 rank order changed");
  assert(!observed.some((row) => row.market === "M11"), "rank 11 was incorrectly backfilled");
  assert(
    observed.find((row) => row.market === "M3")?.flowExclusionReasons.includes("NOTIONAL_FLOW_DECLINING"),
    "notional decline diagnostic was lost",
  );
  assert(
    observed.find((row) => row.market === "M7")?.flowExclusionReasons.includes("TRADE_SPEED_DECLINING"),
    "trade-speed decline diagnostic was lost",
  );
  assert(
    observed.find((row) => row.market === "M10")?.flowExclusionReasons.includes("NO_RECENT_NOTIONAL_FLOW"),
    "zero-flow diagnostic was lost",
  );
});
