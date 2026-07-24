import {
  analyzePeriod,
  atr,
  buildTradePlan,
  buildUniverse,
  type CandleRow,
  computeDynamicOrderflow,
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
    m5: candles(144, 100, drift * 1.2, { volumeGrowth: 0.01 }),
    m15: candles(192, 100, drift, { volumeGrowth: 0.008 }),
    h4: candles(180, 100, drift * 0.65, { volumeGrowth: 0.003 }),
    day: candles(200, 100, drift * 0.35, { volumeGrowth: 0.001 }),
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
    turnover_24h_quote: 50_000_000_000,
    quote_currency: "KRW",
    min_actionable_turnover_24h: 1_000_000_000,
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

Deno.test("universe supports a separate Binance USDT liquidity profile", () => {
  const now = 1_800_000_000_000;
  const rows = buildUniverse(
    [{ market: "BTCUSDT", korean_name: "BTC", english_name: "BTC" }],
    [{
      market: "BTCUSDT",
      trade_price: 60_000,
      opening_price: 59_000,
      high_price: 61_000,
      low_price: 58_000,
      signed_change_rate: 0.0169,
      acc_trade_price_24h: 950_000,
      trade_timestamp: now,
    }],
    now,
    {
      quoteCurrency: "USDT",
      marketMatches: (market) => market.endsWith("USDT"),
      minTurnover24h: 500_000,
      minActionableTurnover24h: 1_000_000,
      liquidityLogFloor: 5.7,
    },
  );
  assert(rows.length === 1);
  assert(rows[0].eligible);
  assert(rows[0].quote_currency === "USDT");
  assert(rows[0].turnover_24h_quote === 950_000);
  assert(rows[0].min_actionable_turnover_24h === 1_000_000);
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
  const now = 1_800_000_000_000;
  return Array.from({ length: 31 }, (_, sample) => ({
    market: "KRW-TEST",
    timestamp: now - 60_000 + sample * 2_000,
    stream_type: "REALTIME",
    orderbook_units: Array.from({ length: 10 }, (_, i) => ({
      bid_price: 119.9 - i * 0.1,
      ask_price: 120.1 + i * 0.1,
      bid_size: (bullish ? 100 - i : 10) + sample * 0.01,
      ask_size: (bullish ? 10 : 100 - i) + sample * 0.008,
    })),
  }));
}

function trades(bullish = true): TradeRow[] {
  const now = 1_800_000_000_000;
  return Array.from({ length: 41 }, (_, i) => ({
    timestamp: now - i * 1_500,
    trade_price: 120,
    trade_volume: i % 4 === 0 ? 1 : 3,
    sequential_id: 9_000_000 + i,
    stream_type: "REALTIME",
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
  assert(bull.dynamic.sufficient);
  assert(bull.dynamic.status === "NEUTRAL", bull.dynamic.status);
});

function dynamicFrames(
  mode: "spoof" | "absorption" | "breakout",
): OrderbookSnapshot[] {
  const start = 1_800_100_000_000;
  return Array.from({ length: 31 }, (_, sample) => {
    const crossed = mode === "breakout" && sample >= 10;
    return {
      market: "KRW-TEST",
      timestamp: start + sample * 2_000,
      stream_type: "REALTIME",
      orderbook_units: Array.from({ length: 10 }, (_, index) => {
        const bidPrice = crossed ? 100.1 - index * 0.1 : 99.9 - index * 0.1;
        const askPrice = crossed ? 100.2 + index * 0.1 : 100.1 + index * 0.1;
        let bidSize = 10 + index * 0.05 + sample * 0.01;
        let askSize = 10 + index * 0.04 + sample * 0.008;
        if (mode === "spoof" && index === 0) {
          bidSize = sample < 6 ? 100 + sample * 0.01 : 5 + sample * 0.01;
        }
        if (mode === "absorption" && index === 0) {
          askSize = 100 + sample * 0.01;
        }
        if (mode === "breakout") {
          if (!crossed && index === 0) askSize = 100 - sample * 10;
          if (crossed && index === 0) bidSize = 80 + sample * 0.01;
        }
        return {
          bid_price: bidPrice,
          ask_price: askPrice,
          bid_size: bidSize,
          ask_size: askSize,
        };
      }),
    };
  });
}

function dynamicTrades(
  mode: "spoof" | "absorption" | "breakout",
): TradeRow[] {
  const start = 1_800_100_000_000;
  if (mode === "breakout") {
    return [
      ...Array.from({ length: 10 }, (_, index) => ({
        timestamp: start + index * 2_000 + 500,
        trade_timestamp: start + index * 2_000 + 500,
        trade_price: 100.1,
        trade_volume: 10,
        ask_bid: "BID",
        sequential_id: 10_000 + index,
        stream_type: "REALTIME",
      })),
      ...Array.from({ length: 21 }, (_, index) => ({
        timestamp: start + 20_000 + index * 2_000,
        trade_timestamp: start + 20_000 + index * 2_000,
        trade_price: 100.1,
        trade_volume: 2,
        ask_bid: "ASK",
        sequential_id: 11_000 + index,
        stream_type: "REALTIME",
      })),
    ];
  }
  return Array.from({ length: 31 }, (_, index) => ({
    timestamp: start + index * 2_000,
    trade_timestamp: start + index * 2_000,
    trade_price: 100.1,
    trade_volume: mode === "absorption" ? 20 : 1,
    ask_bid: "BID",
    sequential_id: 12_000 + index,
    stream_type: "REALTIME",
  }));
}

Deno.test("repeated REST-like snapshots do not satisfy dynamic data gate", () => {
  const snapshot = dynamicFrames("spoof")[0];
  const repeated = Array.from({ length: 16 }, (_, index) => ({
    ...snapshot,
    timestamp: Number(snapshot.timestamp) + index * 1_000,
  }));
  const result = computeDynamicOrderflow(repeated, dynamicTrades("spoof"), 0.1);
  assert(!result.sufficient);
  assert(result.distinct_book_updates === 1);
  assert(result.status === "INSUFFICIENT");
});

Deno.test("trades clustered in one phase fail the three-phase data gate", () => {
  const start = 1_800_100_000_000;
  const clusteredTrades: TradeRow[] = Array.from(
    { length: 25 },
    (_, index) => ({
      timestamp: start + index * 500,
      trade_timestamp: start + index * 500,
      trade_price: 100.1,
      trade_volume: 1,
      ask_bid: "BID",
      sequential_id: 50_000 + index,
      stream_type: "REALTIME",
    }),
  );
  const result = computeDynamicOrderflow(
    dynamicFrames("absorption"),
    clusteredTrades,
    0.1,
  );
  assert(result.observation_ms >= 45_000);
  assert(result.distinct_book_updates >= 25);
  assert(result.aligned_trade_count >= 20);
  assert(result.covered_phases < 3);
  assert(!result.phase_consistent);
  assert(!result.sufficient);
});

Deno.test("unexplained large bid-wall deletion is spoof-like risk", () => {
  const result = computeDynamicOrderflow(
    dynamicFrames("spoof"),
    dynamicTrades("spoof"),
    0.1,
  );
  assert(result.sufficient);
  assert(result.spoof_like_score >= 0.65, String(result.spoof_like_score));
  assert(result.status === "SPOOF_LIKE_RISK", result.status);
});

Deno.test("repeated ask refill against active buys is absorption risk", () => {
  const result = computeDynamicOrderflow(
    dynamicFrames("absorption"),
    dynamicTrades("absorption"),
    0.1,
  );
  assert(result.sufficient);
  assert(
    result.ask_absorption_score >= 0.65,
    String(result.ask_absorption_score),
  );
  assert(result.status === "ASK_ABSORPTION_RISK", result.status);
});

Deno.test("executed ask wall that flips to defended bid confirms breakout", () => {
  const result = computeDynamicOrderflow(
    dynamicFrames("breakout"),
    dynamicTrades("breakout"),
    0.1,
  );
  assert(result.sufficient);
  assert(result.breakout_score >= 0.65, String(result.breakout_score));
  assert(result.status === "BREAKOUT_CONFIRMED", result.status);
  close(Number(result.confirmed_support_price), 100.1);
});

Deno.test("token post-breakout sells do not receive full support-defense credit", () => {
  const weakDefense = dynamicTrades("breakout").map((trade, index) =>
    index >= 10 ? { ...trade, trade_volume: 0.01 } : trade
  );
  const result = computeDynamicOrderflow(
    dynamicFrames("breakout"),
    weakDefense,
    0.1,
  );
  assert(result.sufficient);
  assert(result.breakout_score < 0.65, String(result.breakout_score));
  assert(result.status !== "BREAKOUT_CONFIRMED", result.status);
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  period.timeframes.m15.resistance = null;
  period.timeframes.h4.resistance = null;
  period.timeframes.day.resistance = null;
  period.timeframes.day.recent_high = price * 2;
  const plan = buildTradePlan(period, micro, 0.1, risk);
  assert(plan.stop_price < plan.entry_execution_estimate);
  assert(plan.short_target > plan.entry_execution_estimate);
  if (plan.target_strategy === "SHORT_ONLY") {
    assert(plan.expected_exit_price === plan.short_target_execution_estimate);
    assert(plan.expected_exit_net_return_pct === plan.short_net_return_pct);
  } else {
    assert(plan.expected_exit_price > plan.short_target_execution_estimate);
    assert(plan.expected_exit_price < plan.medium_target_execution_estimate);
    assert(plan.expected_exit_net_return_pct === plan.blended_net_return_pct);
  }
  assert(plan.medium_target > plan.short_target);
  assert(plan.net_stop_pct > 0);
  assert(plan.recommended_investment_krw <= risk.capitalKrw);
});

Deno.test("explicit default tuning parameters preserve the default trade plan", () => {
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  const implicit = buildTradePlan(period, micro, 0.1, risk);
  const explicit = buildTradePlan(period, micro, 0.1, {
    ...risk,
    shortTargetAtrMult: 2.2,
    stopAtrMult: 1.15,
    mediumTargetAtr4hMult: 2.4,
    mediumTargetAtrDayMult: 1.3,
    scoreThreshold: 72,
  });
  assert(JSON.stringify(implicit) === JSON.stringify(explicit));
});

Deno.test("aligned timeframes receive a medium or long horizon", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  for (const metric of Object.values(period.timeframes)) metric.overheat_score = 0.2;
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
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
  assert(final.decision_label === "관찰·눌림 대기");
  assert(
    final.watch_entry_plan.expected_exit_price! >
      final.watch_entry_plan.zone_high!,
  );
  assert(final.watch_entry_plan.expected_net_return_pct! > 0);
  assert(final.watch_entry_plan.scenario.length === 4);
  assert(final.watch_entry_plan.entry_trigger.includes("15분봉"));
  assert(final.watch_entry_plan.exit_trigger.includes("분할매도"));
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.failed_gates.includes("market_event"));
  assert(final.decision !== "BUY");
  assert(!final.watch_entry_plan.available);
});

Deno.test("dynamic spoof-like risk blocks BUY and watch-entry price", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  period.timeframes.m15.resistance = null;
  period.timeframes.h4.resistance = null;
  period.timeframes.day.resistance = null;
  period.timeframes.day.recent_high = price * 2;
  period.timeframes.m15.rsi14 = 66;
  const micro = computeMicrostructure(
    dynamicFrames("spoof"),
    dynamicTrades("spoof"),
    1_800_100_015_000,
    0.1,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.failed_gates.includes("dynamic_safety"));
  assert(final.decision !== "BUY");
  assert(!final.trade_plan.actionable);
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  micro.latest_bids = Array.from({ length: 15 }, (_, index) => ({
    price: price - 0.01 - index * 0.01,
    size: 1_000_000 / price,
  }));
  micro.latest_asks = Array.from({ length: 15 }, (_, index) => ({
    price: price + 0.01 + index * 0.01,
    size: 1_000_000 / price,
  }));
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.01, risk);
  assert(final.trade_plan.short_target < period.timeframes.m15.resistance!);
  assert(final.failed_gates.includes("target_structure") || final.failed_gates.includes("reward_risk"));
  assert(final.decision !== "BUY");
});


Deno.test("insufficient dynamic data fails both sample and safety gates", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  period.timeframes.m15.rsi14 = 64;
  period.timeframes.m15.overheat_score = 0.2;
  period.timeframes.h4.overheat_score = 0.2;
  period.timeframes.day.overheat_score = 0.2;
  period.timeframes.m15.support = price - period.timeframes.m15.atr14! * 0.6;
  period.timeframes.m15.resistance = price + period.timeframes.m15.atr14! * 2.2;
  const snapshot = dynamicFrames("spoof")[0];
  const repeated = Array.from({ length: 16 }, (_, index) => ({
    ...snapshot,
    timestamp: Number(snapshot.timestamp) + index * 1_000,
  }));
  const micro = computeMicrostructure(
    repeated,
    dynamicTrades("spoof"),
    Number(repeated.at(-1)!.timestamp),
    0.1,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  micro.reference_price = price;
  micro.reference_timestamp = Number(repeated.at(-1)!.timestamp);
  micro.live_book_age_ms = 0;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.failed_gates.includes("micro_data"));
  assert(final.failed_gates.includes("dynamic_safety"));
  assert(final.decision !== "BUY");
});

Deno.test("trade plan uses the final live orderbook price instead of the earlier ticker", () => {
  const data = dataset(0.0008);
  const candlePrice = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(candlePrice * 0.97), data);
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
    0.01,
  );
  micro.reference_price = candlePrice;
  micro.best_bid = candlePrice - 0.01;
  micro.best_ask = candlePrice + 0.01;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  const plan = buildTradePlan(period, micro, 0.01, risk);
  assert(plan.reference_source === "LIVE_ORDERBOOK");
  close(plan.reference_price, candlePrice);
  assert(plan.entry_execution_estimate > candlePrice);
});

Deno.test("large daily surge fails the composite overheat gate", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  period.timeframes.day.return_12_pct = 120;
  period.timeframes.day.overheat_score = 0.8;
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
    0.1,
  );
  micro.best_bid = price - 0.1;
  micro.best_ask = price + 0.1;
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  micro.spread_bps = 2;
  const final = finalizeCandidate(period, micro, 0.1, risk);
  assert(final.failed_gates.includes("overheat"));
  assert(final.decision !== "BUY");
});


Deno.test("shallow visible orderbook depth blocks an otherwise strong BUY", () => {
  const data = dataset(0.0012);
  const price = timeframeMetrics(data.m5).close;
  const period = analyzePeriod(universeRow(price), data);
  const atr15 = period.timeframes.m15.atr14!;
  period.timeframes.m15.support = price - atr15 * 0.7;
  period.timeframes.m15.resistance = price + atr15 * 2.4;
  period.timeframes.m15.rsi14 = 64;
  for (const metric of Object.values(period.timeframes)) metric.overheat_score = 0.2;
  const micro = computeMicrostructure(
    bookSnapshots(true),
    trades(true),
    1_800_000_000_000,
    0.01,
  );
  micro.best_bid = price - 0.01;
  micro.best_ask = price + 0.01;
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  micro.latest_bids = [{ price: price - 0.01, size: 0.01 }];
  micro.latest_asks = [{ price: price + 0.01, size: 0.01 }];
  micro.spread_bps = 2;
  micro.micro_score = 88;
  const final = finalizeCandidate(period, micro, 0.01, {
    ...risk,
    minNetRR: 1.3,
    maxStopPct: 5,
  });
  assert(final.failed_gates.includes("depth"));
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
  micro.reference_price = price;
  micro.reference_timestamp = 1_800_000_000_000;
  micro.live_book_age_ms = 0;
  const plan = buildTradePlan(period, micro, 0.1, risk);
  const rawLoss =
    ((plan.entry_execution_estimate - plan.stop_execution_estimate) /
      plan.entry_execution_estimate) * 100;
  assert(plan.net_stop_pct > rawLoss);
});
