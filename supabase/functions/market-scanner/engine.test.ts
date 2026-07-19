import {
  analyzePeriod,
  atr,
  buildTradePlan,
  buildUniverse,
  type CandleRow,
  computeMicrostructure,
  ema,
  estimateHorizon,
  finalizeCandidate,
  macdHistogram,
  type MarketRow,
  median,
  type OrderbookSnapshot,
  type PeriodDataset,
  type RiskConfig,
  roundToTick,
  rsi,
  selectShortlist,
  type TickerRow,
  timeframeMetrics,
  type TradeRow,
  type UniverseRow,
} from "./engine.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number, tolerance = 1e-6) {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function candles(
  bars: number,
  start: number,
  driftPct: number,
  options: {
    volumeGrowth?: number;
    volatilityPct?: number;
    reverse?: boolean;
  } = {},
): CandleRow[] {
  const rows: CandleRow[] = [];
  let price = start;
  const volatility = options.volatilityPct ?? 0.004;
  for (let i = 0; i < bars; i++) {
    const wave = Math.sin(i * 0.71) * volatility;
    const open = price;
    price = Math.max(0.000001, price * (1 + driftPct + wave * 0.12));
    const high = Math.max(open, price) * (1 + volatility);
    const low = Math.min(open, price) * (1 - volatility);
    rows.push({
      candle_date_time_utc: new Date(1_700_000_000_000 + i * 60_000)
        .toISOString(),
      timestamp: 1_700_000_000_000 + i * 60_000,
      opening_price: open,
      high_price: high,
      low_price: low,
      trade_price: price,
      candle_acc_trade_price: 1_000_000 * (1 + i * (options.volumeGrowth ?? 0)),
      candle_acc_trade_volume: 10_000,
    });
  }
  return options.reverse === false ? rows : rows.reverse();
}

function dataset(drift: number): PeriodDataset {
  return {
    m5: candles(72, 100, drift * 1.2, { volumeGrowth: 0.01 }),
    m15: candles(96, 100, drift, { volumeGrowth: 0.008 }),
    h4: candles(90, 100, drift * 0.65, { volumeGrowth: 0.003 }),
    day: candles(60, 100, drift * 0.35, { volumeGrowth: 0.001 }),
  };
}

const risk: RiskConfig = {
  capitalKrw: 500_000,
  riskPct: 1,
  feePerSidePct: 0.05,
  minNetRR: 1.3,
  maxStopPct: 8,
  entrySlippageTicks: 0.25,
  exitSlippageTicks: 0.5,
};

function universeRow(currentPrice = 120): UniverseRow {
  return {
    market: "KRW-TEST",
    korean_name: "테스트",
    english_name: "Test",
    current_price: currentPrice,
    change_24h_pct: 5,
    turnover_24h_krw: 50_000_000_000,
    day_range_pct: 8,
    day_position: 0.7,
    freshness_seconds: 2,
    liquidity_score: 80,
    initial_score: 80,
    eligible: true,
    excluded_reason: null,
    caution_labels: [],
  };
}

Deno.test("median handles odd and even arrays", () => {
  close(median([3, 1, 2]), 2);
  close(median([4, 1, 3, 2]), 2.5);
});

Deno.test("EMA, RSI, ATR, and MACD return finite values", () => {
  const rows = candles(80, 100, 0.002, { reverse: false });
  const closes = rows.map((row) => Number(row.trade_price));
  const highs = rows.map((row) => Number(row.high_price));
  const lows = rows.map((row) => Number(row.low_price));
  assert(Number.isFinite(ema(closes, 21)));
  assert(Number(rsi(closes, 14)) > 50);
  assert(Number(atr(highs, lows, closes, 14)) > 0);
  assert(Number.isFinite(macdHistogram(closes)));
});

Deno.test("tick rounding supports up, down, and decimals", () => {
  close(roundToTick(56.76, 0.1, "down"), 56.7);
  close(roundToTick(56.71, 0.1, "up"), 56.8);
  close(roundToTick(1_234_567, 1000, "nearest"), 1_235_000);
});

Deno.test("universe scans every KRW ticker and excludes market alerts", () => {
  const now = 1_800_000_000_000;
  const markets: MarketRow[] = [
    {
      market: "KRW-A",
      korean_name: "에이",
      market_event: { warning: false, caution: {} },
    },
    {
      market: "KRW-B",
      korean_name: "비",
      market_event: { warning: true, caution: {} },
    },
    { market: "BTC-C", korean_name: "씨" },
  ];
  const tickers: TickerRow[] = [
    {
      market: "KRW-A",
      trade_price: 100,
      opening_price: 98,
      high_price: 103,
      low_price: 95,
      signed_change_rate: 0.02,
      acc_trade_price_24h: 10_000_000_000,
      trade_timestamp: now,
    },
    {
      market: "KRW-B",
      trade_price: 100,
      opening_price: 98,
      high_price: 103,
      low_price: 95,
      signed_change_rate: 0.02,
      acc_trade_price_24h: 10_000_000_000,
      trade_timestamp: now,
    },
  ];
  const rows = buildUniverse(markets, tickers, now);
  assert(rows.length === 2);
  assert(rows.find((row) => row.market === "KRW-A")?.eligible);
  assert(!rows.find((row) => row.market === "KRW-B")?.eligible);
  assert(
    rows.find((row) => row.market === "KRW-B")?.excluded_reason?.includes(
      "시장경보",
    ),
  );
});

Deno.test("universe rejects stale and illiquid pairs", () => {
  const now = 1_800_000_000_000;
  const markets: MarketRow[] = [{ market: "KRW-A" }, { market: "KRW-B" }];
  const tickers: TickerRow[] = [
    {
      market: "KRW-A",
      trade_price: 100,
      acc_trade_price_24h: 100_000_000,
      trade_timestamp: now,
    },
    {
      market: "KRW-B",
      trade_price: 100,
      acc_trade_price_24h: 10_000_000_000,
      trade_timestamp: now - 16 * 60_000,
    },
  ];
  const rows = buildUniverse(markets, tickers, now);
  assert(rows.every((row) => !row.eligible));
  assert(rows.some((row) => row.excluded_reason?.includes("5억원")));
  assert(rows.some((row) => row.excluded_reason?.includes("15분")));
});

Deno.test("shortlist contains only eligible markets and respects the limit", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    ...universeRow(100 + i),
    market: `KRW-T${i}`,
    initial_score: i,
    change_24h_pct: i % 20,
    turnover_24h_krw: (i + 1) * 1_000_000_000,
    eligible: i % 9 !== 0,
  }));
  const shortlist = selectShortlist(rows, 20);
  assert(shortlist.length === 20);
  assert(shortlist.every((row) => row.eligible));
});

Deno.test("timeframe metrics distinguish uptrend from downtrend", () => {
  const up = timeframeMetrics(candles(90, 100, 0.002));
  const down = timeframeMetrics(candles(90, 100, -0.002));
  assert(up.trend_signal > 0.4, `uptrend=${up.trend_signal}`);
  assert(down.trend_signal < -0.4, `downtrend=${down.trend_signal}`);
  assert(Number(up.rsi14) > Number(down.rsi14));
});

Deno.test("period analysis scores aligned uptrend above downtrend", () => {
  const upData = dataset(0.0012);
  const downData = dataset(-0.0012);
  const upPrice = timeframeMetrics(upData.m5).close;
  const downPrice = timeframeMetrics(downData.m5).close;
  const up = analyzePeriod(universeRow(upPrice), upData);
  const down = analyzePeriod(universeRow(downPrice), downData);
  assert(
    up.period_score > down.period_score + 20,
    `${up.period_score} vs ${down.period_score}`,
  );
  assert(up.data_completeness === 1);
  assert(up.preliminary_status === "CANDIDATE");
});

function bookSnapshots(bullish = true): OrderbookSnapshot[] {
  return Array.from({ length: 4 }, (_, sample) => ({
    market: "KRW-TEST",
    timestamp: 1_800_000_000_000 + sample * 500,
    orderbook_units: Array.from({ length: 10 }, (_, i) => ({
      bid_price: 119.9 - i * 0.1,
      ask_price: 120.1 + i * 0.1,
      bid_size: bullish ? 100 - i : 10,
      ask_size: bullish ? 10 : 100 - i,
    })),
  }));
}

function trades(bullish = true): TradeRow[] {
  const now = 1_800_000_000_000;
  return Array.from({ length: 40 }, (_, i) => ({
    timestamp: now - i * 1000,
    trade_price: 120,
    trade_volume: bullish ? (i % 4 === 0 ? 1 : 3) : (i % 4 === 0 ? 3 : 1),
    ask_bid: bullish
      ? (i % 4 === 0 ? "ASK" : "BID")
      : (i % 4 === 0 ? "BID" : "ASK"),
  }));
}

Deno.test("microstructure score reflects book and trade pressure", () => {
  const now = 1_800_000_000_000;
  const bull = computeMicrostructure(bookSnapshots(true), trades(true), now);
  const bear = computeMicrostructure(bookSnapshots(false), trades(false), now);
  assert(bull.book_imbalance > 0);
  assert(bull.trade_pressure > 0);
  assert(bull.micro_score > bear.micro_score + 20);
  assert(bull.spread_bps != null && bull.spread_bps > 0);
});

Deno.test("trade plan keeps stop below entry and targets above entry", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  period.timeframes.m15.resistance = null;
  period.timeframes.h4.resistance = null;
  period.timeframes.day.resistance = null;
  period.timeframes.day.recent_high = price * 2;
  const plan = buildTradePlan(period, micro, 0.1, risk);
  assert(plan.stop_price < plan.entry_execution_estimate);
  assert(plan.short_target > plan.entry_execution_estimate);
  assert(plan.medium_target > plan.short_target);
  assert(plan.net_stop_pct > 0);
  assert(plan.recommended_investment_krw <= risk.capitalKrw);
});

Deno.test("aligned timeframes receive a medium or long horizon", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const horizon = estimateHorizon(period, price * 0.95);
  assert(["MEDIUM", "LONG"].includes(horizon.code), horizon.code);
  assert(horizon.persistence_score > 50);
  assert(horizon.invalidation.length >= 3);
});

Deno.test("final candidate never marks a failed-gate setup actionable", () => {
  const data = dataset(-0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const micro = computeMicrostructure(
    bookSnapshots(false),
    trades(false),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.decision !== "BUY");
  assert(!final.trade_plan.actionable);
  assert(final.failed_gates.length > 0);
});

Deno.test("a strong WAIT setup receives a conditional watch-entry zone", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const atr15 = period.timeframes.m15.atr14!;
  period.timeframes.m15.rsi14 = 66;
  period.timeframes.m15.support = price - atr15 * 0.35;
  period.timeframes.m15.resistance = price + atr15 * 2.4;
  period.timeframes.h4.resistance = null;
  const micro = computeMicrostructure(
    bookSnapshots(false),
    trades(false),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.decision === "WAIT", final.decision);
  assert(final.failed_gates.includes("micro_pressure"));
  assert(final.watch_entry_plan.available, final.watch_entry_plan.note);
  assert(final.watch_entry_plan.zone_low! < price);
  assert(
    final.watch_entry_plan.zone_low! >
      final.watch_entry_plan.invalidation_price!,
  );
  assert(
    final.watch_entry_plan.max_price === final.watch_entry_plan.zone_high,
  );
  assert(final.watch_entry_plan.conditions.length >= 4);
});

Deno.test("market alert is a hard gate even with bullish candles", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const row = universeRow(price);
  row.caution_labels = ["WARNING"];
  const period = analyzePeriod(row, data);
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.failed_gates.includes("market_event"));
  assert(final.decision !== "BUY");
  assert(!final.watch_entry_plan.available);
});

Deno.test("a fully aligned, liquid, fee-aware setup can become BUY", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  // 가까운 미세 고점이 목표를 불필요하게 가로막지 않는 구조를 만든다.
  period.timeframes.m15.resistance = null;
  period.timeframes.h4.resistance = null;
  period.timeframes.day.resistance = null;
  period.timeframes.day.recent_high = price * 2;
  const atr15 = period.timeframes.m15.atr14!;
  period.timeframes.m15.support = price - atr15 * 0.7;
  period.timeframes.h4.support = price - atr15;
  period.timeframes.m15.rsi14 = 66;
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.01;
  micro.best_ask = price + 0.01;
  micro.spread_bps = 2;
  micro.micro_score = 88;
  const strictRisk = { ...risk, minNetRR: 1.5, maxStopPct: 5 };
  const final = finalizeCandidate(period, micro, 0.01, strictRisk);
  assert(
    final.trade_plan.net_rr >= strictRisk.minNetRR,
    `rr=${final.trade_plan.net_rr}`,
  );
  assert(final.score >= 72, `score=${final.score}`);
  assert(final.decision === "BUY", `failed=${final.failed_gates.join(",")}`);
  assert(final.trade_plan.actionable);
});

Deno.test("a nearby resistance is never overwritten by an artificial higher target", () => {
  const data = dataset(0.0008);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  period.timeframes.m15.resistance = price + 0.03;
  period.timeframes.h4.resistance = null;
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.01;
  micro.best_ask = price + 0.01;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.01, risk);
  assert(final.trade_plan.short_target < period.timeframes.m15.resistance!);
  assert(final.failed_gates.includes("target_structure"));
  assert(final.decision !== "BUY");
});

Deno.test("fee-aware loss exceeds raw price loss", () => {
  const data = dataset(0.0008);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  const plan = buildTradePlan(period, micro, 0.1, risk);
  const rawLoss =
    ((plan.entry_execution_estimate - plan.stop_execution_estimate) /
      plan.entry_execution_estimate) * 100;
  assert(plan.net_stop_pct > rawLoss);
});
