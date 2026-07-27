import { settleSpotMarketReads, validateSpotMarket } from "./spot-market.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("spot market validation binds each exchange to its canonical symbol format", () => {
  assert(validateSpotMarket("upbit", "KRW-ETH").ok);
  assert(validateSpotMarket("binance", "ETHUSDT").ok);
  assert(!validateSpotMarket("upbit", "ETHUSDT").ok);
  assert(!validateSpotMarket("binance", "KRW-ETH").ok);
  assert(!validateSpotMarket("upbit", "krw-eth").ok);
  assert(!validateSpotMarket("upbit", " KRW-ETH").ok);
  assert(!validateSpotMarket("upbit", null).ok);
});

Deno.test("one malformed market cannot reject healthy reads in the same monitor batch", async () => {
  const rows = [
    { id: "good-upbit", exchange: "upbit", market: "KRW-ETH" },
    { id: "bad-route", exchange: "upbit", market: "BTCUSDT" },
    { id: "good-binance", exchange: "binance", market: "SOLUSDT" },
  ];
  const called: string[] = [];
  const results = await settleSpotMarketReads(rows, async (exchange, market) => {
    called.push(`${exchange}:${market}`);
    return { current: 100 };
  });

  assert(results.length === 3);
  assert(results[0].ok);
  assert(!results[1].ok);
  assert(results[2].ok);
  assert(called.join(",") === "upbit:KRW-ETH,binance:SOLUSDT", called.join(","));
});

Deno.test("one quote failure is isolated while sibling quote results survive", async () => {
  const rows = [
    { id: "slow", exchange: "upbit", market: "KRW-XRP" },
    { id: "healthy", exchange: "upbit", market: "KRW-BTC" },
  ];
  const results = await settleSpotMarketReads(rows, async (_exchange, market) => {
    if (market === "KRW-XRP") throw new Error("quote timeout");
    return { current: 1 };
  });

  assert(!results[0].ok && results[0].error.includes("timeout"));
  assert(results[1].ok && results[1].value.current === 1);
});

Deno.test("autotrader monitor wires position quotes through the isolation helper", async () => {
  const source = await Deno.readTextFile(
    new URL("../market-autotrader/index.ts", import.meta.url),
  );

  assert(
    source.includes("const quoteResults = await settleSpotMarketReads("),
    "monitor must use isolated quote settlement",
  );
  assert(
    !source.includes("const quotes = await Promise.all(exchangePositions.map"),
    "all-or-nothing quote reads must not return",
  );
});

Deno.test("route constraints protect producer tables without blocking dirty-history deployment", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/202607270016_market_route_isolation_v651.sql",
      import.meta.url,
    ),
  );

  for (
    const table of [
      "scanner_candidates",
      "trading_positions",
      "trading_orders",
    ]
  ) {
    assert(sql.includes(`alter table public.${table}`), `${table} guard missing`);
  }

  const nonBlockingConstraints = sql.match(/\)\s+not valid;/gi) ?? [];
  assert(
    nonBlockingConstraints.length >= 3,
    "all route constraints must deploy as NOT VALID",
  );
});
