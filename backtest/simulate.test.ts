import {
  buyAndHoldPct,
  closedUpTo,
  type MarketHistory,
  netGainPct,
  resolveExit,
  simulateMarket,
  TF_MS,
  usableWindow,
} from "./simulate.ts";
import type { RiskConfig } from "../supabase/functions/market-scanner/engine.ts";

function equal(actual: unknown, expected: unknown, message = "") {
  if (actual !== expected) {
    throw new Error(`${message} expected=${expected} actual=${actual}`);
  }
}

function near(actual: number, expected: number, tolerance = 1e-9) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expected≈${expected} actual=${actual}`);
  }
}

function candle(openTime: number, price = 100) {
  return {
    openTime,
    open: price,
    high: price,
    low: price,
    close: price,
    quoteVolume: 1_000_000_000,
  };
}

function risk(): RiskConfig {
  return {
    capitalKrw: 500_000,
    quoteCurrency: "KRW",
    riskPct: 1,
    feePerSidePct: 0,
    minNetRR: 1.5,
    maxStopPct: 5,
    entrySlippageTicks: 0,
    exitSlippageTicks: 0,
  };
}

Deno.test("closedUpTo excludes the still-open higher-timeframe candle", () => {
  const bars = [candle(0), candle(TF_MS.h4)];
  equal(closedUpTo(bars, TF_MS.h4, TF_MS.h4).length, 1);
  equal(closedUpTo(bars, TF_MS.h4 * 2 - 1, TF_MS.h4).length, 1);
  equal(closedUpTo(bars, TF_MS.h4 * 2, TF_MS.h4).length, 2);
});

Deno.test("fee calculation charges both entry and exit", () => {
  const actual = netGainPct(100, 110, 0.1);
  const expected = ((110 * 0.999) / (100 * 1.001) - 1) * 100;
  near(actual, expected);
});

Deno.test("same-bar target and stop uses stop execution price", () => {
  const bars = [{
    ...candle(0, 100),
    high: 110,
    low: 90,
  }];
  const exit = resolveExit(
    bars,
    0,
    {
      targetTrigger: 108,
      targetExecution: 107,
      stopTrigger: 95,
      stopExecution: 94,
    },
    1,
    TF_MS.m15,
    0,
  );
  equal(exit?.exitReason, "STOP");
  equal(exit?.exitPrice, 94);
  equal(exit?.ambiguousSameBar, true);
});

Deno.test("a gap below the stop exits at the worse opening execution", () => {
  const bars = [{ ...candle(0, 90), low: 88 }];
  const exit = resolveExit(
    bars,
    0,
    {
      targetTrigger: 110,
      targetExecution: 109,
      stopTrigger: 95,
      stopExecution: 94,
    },
    1,
    TF_MS.m15,
    1,
  );
  equal(exit?.exitReason, "STOP");
  equal(exit?.exitPrice, 89);
});

Deno.test("maxHoldBars is exact rather than inclusive plus one", () => {
  const bars = Array.from({ length: 5 }, (_, i) => candle(i * TF_MS.m15, 100 + i));
  const exit = resolveExit(
    bars,
    0,
    {
      targetTrigger: 200,
      targetExecution: 199,
      stopTrigger: 50,
      stopExecution: 49,
    },
    2,
    TF_MS.m15 * 5,
    1,
  );
  equal(exit?.exitIdx, 1);
  equal(exit?.exitPrice, 100);
  equal(exit?.exitReason, "TIME");
});

Deno.test("buy-and-hold uses the same requested window", () => {
  const history: MarketHistory = {
    exchange: "upbit",
    market: "KRW-TEST",
    quoteCurrency: "KRW",
    tickSize: 1,
    m5: [],
    m15: [
      { ...candle(0, 100), close: 1_000 },
      { ...candle(TF_MS.m15, 100), close: 110 },
      { ...candle(TF_MS.m15 * 2, 110), close: 121 },
    ],
    h4: [],
    day: [],
  };
  near(
    buyAndHoldPct(history, risk(), {
      startMs: TF_MS.m15,
      endMs: TF_MS.m15 * 3,
    }),
    21,
  );
});

Deno.test("usable window waits for 120 completed daily candles", () => {
  const days = 122;
  const history: MarketHistory = {
    exchange: "upbit",
    market: "KRW-TEST",
    quoteCurrency: "KRW",
    tickSize: 1,
    m5: Array.from({ length: days * 288 }, (_, i) => candle(i * TF_MS.m5)),
    m15: Array.from({ length: days * 96 }, (_, i) => candle(i * TF_MS.m15)),
    h4: Array.from({ length: days * 6 }, (_, i) => candle(i * TF_MS.h4)),
    day: Array.from({ length: days }, (_, i) => candle(i * TF_MS.day)),
  };
  const window = usableWindow(history);
  equal(window?.startMs, 120 * TF_MS.day);
});

Deno.test("full market simulation runs both BUY and WAIT evaluators", () => {
  const days = 121;
  const drifting = (openTime: number, index: number) => {
    const price = 100 + index * 0.002 + Math.sin(index / 7) * 0.2;
    return {
      openTime,
      open: price,
      high: price * 1.003,
      low: price * 0.997,
      close: price * 1.0004,
      quoteVolume: 20_000_000,
    };
  };
  const history: MarketHistory = {
    exchange: "upbit",
    market: "KRW-TEST",
    quoteCurrency: "KRW",
    tickSize: 0.1,
    m5: Array.from(
      { length: days * 288 },
      (_, i) => drifting(i * TF_MS.m5, i),
    ),
    m15: Array.from(
      { length: days * 96 },
      (_, i) => drifting(i * TF_MS.m15, i * 3),
    ),
    h4: Array.from(
      { length: days * 6 },
      (_, i) => drifting(i * TF_MS.h4, i * 48),
    ),
    day: Array.from(
      { length: days },
      (_, i) => drifting(i * TF_MS.day, i * 288),
    ),
  };
  const result = simulateMarket(history, risk());
  equal(result.window?.startMs, 120 * TF_MS.day);
  if (!Array.isArray(result.buyTrades) || !Array.isArray(result.waitTrades)) {
    throw new Error("simulation result arrays are missing");
  }
});
