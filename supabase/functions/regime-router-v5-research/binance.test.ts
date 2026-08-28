import {
  assertExpectedClosedBarCoverage,
  BINANCE_REQUEST_MIN_INTERVAL_MS,
  fetchClosed15mBars,
  fetchClosed5mBars,
  firstRequiredKlineOpen,
  listActivePerpetualMarkets,
} from "./binance.ts";
import { type Bar, BAR_MS, FIVE_MINUTE_MS } from "./types.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function kline(time: number, intervalMs: number): unknown[] {
  return [
    time,
    "100",
    "102",
    "99",
    "101",
    "10",
    time + intervalMs - 1,
    "1005",
    12,
    "5",
    "500",
    "0",
  ];
}

function bar(time: number): Bar {
  return { time, open: 100, high: 102, low: 99, close: 101, volume: 10, quoteVolume: 1_005 };
}

Deno.test("full USDⓈ-M universe keeps non-USDT active perpetual metadata", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const markets = await listActivePerpetualMarkets({
    fetchFn: async () => {
      attempts++;
      if (attempts === 1) return jsonResponse({ code: -1003 }, 429, { "retry-after": "0" });
      return jsonResponse({
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            contractType: "PERPETUAL",
            quoteAsset: "USDT",
            marginAsset: "USDT",
            onboardDate: 1,
          },
          {
            symbol: "BTCUSDC",
            status: "TRADING",
            contractType: "PERPETUAL",
            quoteAsset: "USDC",
            marginAsset: "USDC",
            onboardDate: 2,
          },
          {
            symbol: "ETHUSDT_260925",
            status: "TRADING",
            contractType: "CURRENT_QUARTER",
            quoteAsset: "USDT",
            marginAsset: "USDT",
          },
          {
            symbol: "OLDUSDT",
            status: "SETTLING",
            contractType: "PERPETUAL",
            quoteAsset: "USDT",
            marginAsset: "USDT",
          },
        ],
      });
    },
    sleepFn: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert(attempts === 2, `expected retry, got ${attempts} attempts`);
  assert(sleeps.length === 1);
  assert(markets.length === 2);
  assert(markets[0].symbol === "BTCUSDC");
  assert(markets[0].quoteAsset === "USDC" && markets[0].marginAsset === "USDC");
  assert(markets[1].symbol === "BTCUSDT");
});

Deno.test("15m fetch pages the complete 120-day closed-bar window", async () => {
  const totalBars = 120 * 24 * 4;
  const asOfTime = totalBars * BAR_MS;
  let requests = 0;
  const bars = await fetchClosed15mBars("BTCUSDT", {
    startTime: 0,
    endTime: asOfTime - BAR_MS,
    asOfTime,
    pageLimit: 1_000,
    fetchFn: async (input) => {
      requests++;
      const url = new URL(String(input));
      assert(url.pathname === "/fapi/v1/klines");
      assert(url.searchParams.get("interval") === "15m");
      const start = Number(url.searchParams.get("startTime"));
      const end = Number(url.searchParams.get("endTime"));
      const limit = Number(url.searchParams.get("limit"));
      const page: unknown[] = [];
      for (let time = start; time <= end && page.length < limit; time += BAR_MS) {
        page.push(kline(time, BAR_MS));
      }
      return jsonResponse(page);
    },
  });

  assert(bars.length === totalBars, `expected ${totalBars} bars, got ${bars.length}`);
  assert(requests === 12, `expected 12 pages, got ${requests}`);
  assert(bars[0].time === 0);
  assert(bars.at(-1)?.time === asOfTime - BAR_MS);
});

Deno.test("15m helper refuses a window shorter than 120 days", async () => {
  let called = false;
  let failed = false;
  try {
    await fetchClosed15mBars("BTCUSDT", {
      startTime: 0,
      endTime: 119 * 86_400_000 - BAR_MS,
      asOfTime: 120 * 86_400_000,
      fetchFn: async () => {
        called = true;
        return jsonResponse([]);
      },
    });
  } catch (error) {
    failed = String(error).includes("at least 120 days");
  }
  assert(failed, "short lookback must fail");
  assert(!called, "short lookback must fail before making a request");
});

Deno.test("in-window listing starts at the first complete aligned 15m bucket", async () => {
  const totalBars = 120 * 24 * 4;
  const asOfTime = totalBars * BAR_MS;
  const endTime = asOfTime - BAR_MS;
  const containingOpen = endTime - 3 * BAR_MS;
  const onboardDate = containingOpen + 1;
  const requiredStart = containingOpen + BAR_MS;
  assert(firstRequiredKlineOpen(0, BAR_MS, onboardDate) === requiredStart);

  const bars = await fetchClosed15mBars({
    symbol: "NEWUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate,
  }, {
    startTime: 0,
    endTime,
    asOfTime,
    fetchFn: async () =>
      jsonResponse([
        kline(containingOpen, BAR_MS),
        kline(requiredStart, BAR_MS),
        kline(requiredStart + BAR_MS, BAR_MS),
        kline(requiredStart + 2 * BAR_MS, BAR_MS),
      ]),
  });

  assert(bars.length === 3);
  assert(bars[0].time === requiredStart, "partial onboard bucket must not enter V5 history");
  assert(bars.at(-1)?.time === endTime);
});

Deno.test("coverage guard rejects truncated prefixes, tails, and internal gaps", () => {
  const expected = [0, BAR_MS, 2 * BAR_MS, 3 * BAR_MS].map(bar);
  assertExpectedClosedBarCoverage(expected, BAR_MS, 0, 3 * BAR_MS, null, "FULLUSDT");
  for (
    const [label, bars] of [
      ["prefix", expected.slice(1)],
      ["tail", expected.slice(0, -1)],
      ["gap", [expected[0], expected[1], expected[3]]],
    ] as const
  ) {
    let failed = false;
    try {
      assertExpectedClosedBarCoverage(bars, BAR_MS, 0, 3 * BAR_MS, null, label);
    } catch (error) {
      failed = String(error).includes("incomplete 15m coverage");
    }
    assert(failed, `${label} truncation must fail closed`);
  }
});

Deno.test("5m helper calls actual 5m klines and excludes an in-progress bar", async () => {
  const asOfTime = 10 * FIVE_MINUTE_MS;
  const bars = await fetchClosed5mBars("BTCUSDC", {
    startTime: 8 * FIVE_MINUTE_MS,
    endTime: 10 * FIVE_MINUTE_MS,
    asOfTime,
    fetchFn: async (input) => {
      const url = new URL(String(input));
      assert(url.searchParams.get("interval") === "5m");
      return jsonResponse([
        kline(8 * FIVE_MINUTE_MS, FIVE_MINUTE_MS),
        kline(9 * FIVE_MINUTE_MS, FIVE_MINUTE_MS),
        kline(10 * FIVE_MINUTE_MS, FIVE_MINUTE_MS),
      ]);
    },
  });
  assert(bars.length === 2);
  assert(bars.at(-1)?.time === 9 * FIVE_MINUTE_MS);
});

Deno.test("5m helper rejects a missing causal tail child", async () => {
  let failed = false;
  try {
    await fetchClosed5mBars("BTCUSDT", {
      startTime: 0,
      endTime: 2 * FIVE_MINUTE_MS,
      asOfTime: 3 * FIVE_MINUTE_MS,
      fetchFn: async () =>
        jsonResponse([
          kline(0, FIVE_MINUTE_MS),
          kline(FIVE_MINUTE_MS, FIVE_MINUTE_MS),
        ]),
    });
  } catch (error) {
    failed = String(error).includes("incomplete 5m coverage");
  }
  assert(failed, "a missing final completed 5m child must fail closed");
});

Deno.test("injected fetch defaults to zero pacing and does not serialize concurrent responses", async () => {
  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    starts++;
    await gate;
    const url = new URL(String(input));
    const interval = url.searchParams.get("interval");
    const intervalMs = interval === "15m" ? BAR_MS : FIVE_MINUTE_MS;
    const time = interval === "15m"
      ? 120 * 86_400_000 - BAR_MS
      : Number(url.searchParams.get("startTime"));
    return jsonResponse([kline(time, intervalMs)]);
  };
  const asOf15m = 120 * 86_400_000;
  const pending = Promise.all([
    fetchClosed15mBars({
      symbol: "BTCUSDT",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      onboardDate: asOf15m - BAR_MS,
    }, {
      startTime: 0,
      endTime: asOf15m - BAR_MS,
      asOfTime: asOf15m,
      fetchFn,
    }),
    fetchClosed5mBars("BTCUSDT", {
      startTime: 0,
      endTime: 0,
      asOfTime: FIVE_MINUTE_MS,
      fetchFn,
    }),
  ]);
  await Promise.resolve();
  await Promise.resolve();
  assert(starts === 2, `injected requests should both start immediately, got ${starts}`);
  release();
  await pending;
});

Deno.test("15m, 5m and retry starts share one isolate-wide pacer", async () => {
  assert(BINANCE_REQUEST_MIN_INTERVAL_MS === 175);
  const paceMs = 12;
  const starts: number[] = [];
  let fiveMinuteAttempts = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    starts.push(performance.now());
    const url = new URL(String(input));
    const interval = url.searchParams.get("interval");
    if (interval === "5m" && ++fiveMinuteAttempts === 1) {
      return jsonResponse({ code: -1003 }, 429, { "retry-after": "0" });
    }
    const intervalMs = interval === "15m" ? BAR_MS : FIVE_MINUTE_MS;
    const time = interval === "15m"
      ? 120 * 86_400_000 - BAR_MS
      : Number(url.searchParams.get("startTime"));
    return jsonResponse([kline(time, intervalMs)]);
  };
  const common = {
    fetchFn,
    requestPaceMs: paceMs,
    initialRetryDelayMs: 1,
    sleepFn: async () => {},
  };
  const asOf15m = 120 * 86_400_000;
  await Promise.all([
    fetchClosed15mBars({
      symbol: "BTCUSDT",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      onboardDate: asOf15m - BAR_MS,
    }, {
      ...common,
      startTime: 0,
      endTime: asOf15m - BAR_MS,
      asOfTime: asOf15m,
    }),
    fetchClosed5mBars("BTCUSDT", {
      ...common,
      startTime: 0,
      endTime: 0,
      asOfTime: FIVE_MINUTE_MS,
    }),
  ]);

  assert(starts.length === 3, `expected two calls plus one retry, got ${starts.length}`);
  for (let index = 1; index < starts.length; index++) {
    const interval = starts[index] - starts[index - 1];
    assert(interval >= paceMs, `request starts only ${interval}ms apart`);
  }
});
