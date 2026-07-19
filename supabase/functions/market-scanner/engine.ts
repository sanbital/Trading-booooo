// Trading-booooo Market Scanner v2.0.1
// Pure analysis engine. Public market data only; no order or account operations.

export const ENGINE_VERSION = "2.0.1";
export const MIN_KRW_TURNOVER_24H = 500_000_000;
export const MIN_ACTIONABLE_TURNOVER_24H = 1_000_000_000;

export type MarketEvent = {
  warning?: boolean;
  caution?: Record<string, boolean> | boolean;
};

export type MarketRow = {
  market: string;
  korean_name?: string;
  english_name?: string;
  market_event?: MarketEvent;
  market_warning?: string;
};

export type TickerRow = {
  market: string;
  trade_price: number | string;
  opening_price?: number | string;
  high_price?: number | string;
  low_price?: number | string;
  signed_change_rate?: number | string;
  acc_trade_price_24h?: number | string;
  trade_timestamp?: number | string;
  timestamp?: number | string;
};

export type CandleRow = {
  candle_date_time_utc?: string;
  timestamp?: number | string;
  opening_price: number | string;
  high_price: number | string;
  low_price: number | string;
  trade_price: number | string;
  candle_acc_trade_volume?: number | string;
  candle_acc_trade_price?: number | string;
};

export type OrderbookUnit = {
  bid_price: number | string;
  bid_size: number | string;
  ask_price: number | string;
  ask_size: number | string;
};

export type OrderbookSnapshot = {
  market?: string;
  timestamp?: number | string;
  orderbook_units: OrderbookUnit[];
};

export type TradeRow = {
  timestamp?: number | string;
  trade_price: number | string;
  trade_volume: number | string;
  ask_bid: string;
};

export type UniverseRow = {
  market: string;
  korean_name: string;
  english_name: string;
  current_price: number;
  change_24h_pct: number;
  turnover_24h_krw: number;
  day_range_pct: number;
  day_position: number;
  freshness_seconds: number;
  liquidity_score: number;
  initial_score: number;
  eligible: boolean;
  excluded_reason: string | null;
  caution_labels: string[];
};

export type TimeframeMetrics = {
  bars: number;
  close: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  atr_pct: number | null;
  macd_histogram: number | null;
  return_3_pct: number;
  return_12_pct: number;
  volume_ratio: number;
  trend_signal: number;
  momentum_signal: number;
  overextension_pct: number | null;
  recent_high: number;
  recent_low: number;
  support: number | null;
  resistance: number | null;
};

export type PeriodDataset = {
  m5: CandleRow[];
  m15: CandleRow[];
  h4: CandleRow[];
  day: CandleRow[];
};

export type PeriodAnalysis = {
  universe: UniverseRow;
  timeframes: Record<"m5" | "m15" | "h4" | "day", TimeframeMetrics>;
  period_score: number;
  trend_signal: number;
  momentum_signal: number;
  data_completeness: number;
  preliminary_status: "CANDIDATE" | "WAIT" | "AVOID";
  positives: string[];
  negatives: string[];
  warnings: string[];
};

export type Microstructure = {
  samples: number;
  best_bid: number | null;
  best_ask: number | null;
  spread_bps: number | null;
  book_imbalance: number;
  imbalance_stability: number;
  trade_pressure: number;
  trade_count: number;
  buy_notional: number;
  sell_notional: number;
  micro_score: number;
};

export type RiskConfig = {
  capitalKrw: number;
  riskPct: number;
  feePerSidePct: number;
  minNetRR: number;
  maxStopPct: number;
  entrySlippageTicks: number;
  exitSlippageTicks: number;
};

export type TradePlan = {
  entry_low: number;
  entry_high: number;
  entry_execution_estimate: number;
  short_target: number;
  short_target_execution_estimate: number;
  medium_target: number;
  stop_price: number;
  stop_execution_estimate: number;
  short_net_return_pct: number;
  medium_net_return_pct: number;
  net_stop_pct: number;
  net_rr: number;
  recommended_investment_krw: number;
  risk_budget_krw: number;
  estimated_loss_krw: number;
  tick_size: number;
  actionable: boolean;
};

export type TrendHorizon = {
  code: "INTRADAY" | "SHORT" | "MEDIUM" | "LONG";
  label: string;
  expected_window: string;
  persistence_score: number;
  estimate: string;
  invalidation: string[];
};

export type Gate = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type FinalCandidate = {
  rank?: number;
  market: string;
  korean_name: string;
  english_name: string;
  current_price: number;
  change_24h_pct: number;
  turnover_24h_krw: number;
  score: number;
  confidence: number;
  decision: "BUY" | "WAIT" | "AVOID";
  decision_label: string;
  trade_plan: TradePlan;
  horizon: TrendHorizon;
  gates: Gate[];
  failed_gates: string[];
  positives: string[];
  negatives: string[];
  warnings: string[];
  timeframes: PeriodAnalysis["timeframes"];
  microstructure: Microstructure;
};

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

export function safeDiv(a: number, b: number, fallback = 0): number {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : fallback;
}

export function median(values: number[]): number {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[middle]
    : (clean[middle - 1] + clean[middle]) / 2;
}

export function mean(values: number[]): number {
  const clean = values.filter(Number.isFinite);
  return clean.length
    ? clean.reduce((sum, value) => sum + value, 0) / clean.length
    : 0;
}

export function pctChange(first: number, last: number): number {
  return first > 0 && Number.isFinite(last)
    ? ((last - first) / first) * 100
    : 0;
}

export function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i++) {
    output.push(values[i] * alpha + output[i - 1] * (1 - alpha));
  }
  return output;
}

export function ema(values: number[], period: number): number | null {
  return values.length >= period ? emaSeries(values, period).at(-1)! : null;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (
    closes.length <= period || highs.length !== closes.length ||
    lows.length !== closes.length
  ) return null;
  const ranges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    ranges.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  let value = mean(ranges.slice(0, period));
  for (let i = period; i < ranges.length; i++) {
    value = (value * (period - 1) + ranges[i]) / period;
  }
  return value;
}

export function macdHistogram(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): number | null {
  if (values.length < slow + signal) return null;
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const macdSeries = values.map((_, index) =>
    fastSeries[index] - slowSeries[index]
  );
  const signalSeries = emaSeries(macdSeries, signal);
  return macdSeries.at(-1)! - signalSeries.at(-1)!;
}

function tanh(value: number): number {
  if (Math.tanh) return Math.tanh(value);
  const positive = Math.exp(value);
  const negative = Math.exp(-value);
  return (positive - negative) / (positive + negative);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cautionLabels(event?: MarketEvent): string[] {
  if (!event) return [];
  const labels: string[] = [];
  if (event.warning) labels.push("WARNING");
  if (typeof event.caution === "boolean") {
    if (event.caution) labels.push("CAUTION");
  } else if (event.caution) {
    for (const [key, active] of Object.entries(event.caution)) {
      if (active) labels.push(key);
    }
  }
  return labels;
}

export function buildUniverse(
  markets: MarketRow[],
  tickers: TickerRow[],
  nowMs = Date.now(),
): UniverseRow[] {
  const tickerByMarket = new Map(
    tickers.map((row) => [String(row.market), row]),
  );
  const rows: UniverseRow[] = [];

  for (const market of markets) {
    if (!String(market.market).startsWith("KRW-")) continue;
    const ticker = tickerByMarket.get(market.market);
    if (!ticker) continue;

    const current = number(ticker.trade_price);
    const opening = number(ticker.opening_price, current);
    const high = number(ticker.high_price, current);
    const low = number(ticker.low_price, current);
    const change = number(ticker.signed_change_rate) * 100;
    const turnover = number(ticker.acc_trade_price_24h);
    const tradeTimestamp = number(
      ticker.trade_timestamp || ticker.timestamp,
      nowMs,
    );
    const freshness = Math.max(0, (nowMs - tradeTimestamp) / 1000);
    const rangePct = opening > 0 ? ((high - low) / opening) * 100 : 0;
    const position = high > low
      ? clamp((current - low) / (high - low), 0, 1)
      : 0.5;
    const cautions = cautionLabels(market.market_event);
    if (market.market_warning && market.market_warning !== "NONE") {
      cautions.push(market.market_warning);
    }

    const liquidityScore = clamp(
      ((Math.log10(Math.max(turnover, 1)) - 8.7) / 3.3) * 100,
      0,
      100,
    );
    let momentumScore: number;
    if (change < 0) momentumScore = clamp(48 + change * 2.5, 0, 48);
    else if (change <= 12) momentumScore = 52 + change * 3.2;
    else if (change <= 20) momentumScore = 90 - (change - 12) * 3.5;
    else momentumScore = clamp(62 - (change - 20) * 2.5, 0, 62);
    const positionScore = clamp(100 - Math.abs(position - 0.7) * 145, 10, 100);
    const volatilityScore = rangePct < 1
      ? 30 + rangePct * 30
      : rangePct <= 12
      ? 70 + Math.min(rangePct, 6) * 5
      : clamp(100 - (rangePct - 12) * 4, 20, 100);
    const initialScore = clamp(
      liquidityScore * 0.42 + momentumScore * 0.28 + positionScore * 0.2 +
        volatilityScore * 0.1,
      0,
      100,
    );

    let excludedReason: string | null = null;
    if (cautions.length) excludedReason = `시장경보(${cautions.join(", ")})`;
    else if (!(current > 0)) excludedReason = "유효한 현재가 없음";
    else if (freshness > 15 * 60) excludedReason = "최근 체결이 15분 이상 없음";
    else if (turnover < MIN_KRW_TURNOVER_24H) {
      excludedReason = "24시간 거래대금 5억원 미만";
    }

    rows.push({
      market: market.market,
      korean_name: market.korean_name || market.market.replace("KRW-", ""),
      english_name: market.english_name || "",
      current_price: current,
      change_24h_pct: change,
      turnover_24h_krw: turnover,
      day_range_pct: rangePct,
      day_position: position,
      freshness_seconds: freshness,
      liquidity_score: liquidityScore,
      initial_score: initialScore,
      eligible: !excludedReason,
      excluded_reason: excludedReason,
      caution_labels: [...new Set(cautions)],
    });
  }

  return rows.sort((a, b) => b.initial_score - a.initial_score);
}

export function selectShortlist(
  universe: UniverseRow[],
  limit = 30,
): UniverseRow[] {
  const eligible = universe.filter((row) => row.eligible);
  const byInitial = [...eligible].sort((a, b) =>
    b.initial_score - a.initial_score
  ).slice(0, Math.ceil(limit * 0.65));
  const byLiquidity = [...eligible].sort((a, b) =>
    b.turnover_24h_krw - a.turnover_24h_krw
  ).slice(0, Math.ceil(limit * 0.25));
  const byMomentum = [...eligible]
    .filter((row) => row.change_24h_pct >= 0 && row.change_24h_pct <= 18)
    .sort((a, b) => b.change_24h_pct - a.change_24h_pct)
    .slice(0, Math.ceil(limit * 0.25));

  const unique = new Map<string, UniverseRow>();
  for (const row of [...byInitial, ...byLiquidity, ...byMomentum]) {
    unique.set(row.market, row);
  }
  // 세 묶음이 많이 겹치더라도 정밀분석 목표 개수를 채운다.
  for (
    const row of [...eligible].sort((a, b) => b.initial_score - a.initial_score)
  ) unique.set(row.market, row);
  return [...unique.values()].sort((a, b) => b.initial_score - a.initial_score)
    .slice(0, limit);
}

function chronological(raw: CandleRow[]): CandleRow[] {
  return [...(raw || [])]
    .filter((row) => number(row.trade_price) > 0)
    .sort((a, b) => {
      const left = number(a.timestamp) ||
        Date.parse(String(a.candle_date_time_utc || ""));
      const right = number(b.timestamp) ||
        Date.parse(String(b.candle_date_time_utc || ""));
      return left - right;
    });
}

function nearestResistance(highs: number[], current: number): number | null {
  const candidates = highs.slice(0, -2).filter((value) =>
    value > current * 1.0015
  ).sort((a, b) => a - b);
  return candidates[0] || null;
}

export function timeframeMetrics(raw: CandleRow[]): TimeframeMetrics {
  const rows = chronological(raw);
  const closes = rows.map((row) => number(row.trade_price));
  const highs = rows.map((row) => number(row.high_price));
  const lows = rows.map((row) => number(row.low_price));
  const volumes = rows.map((row) =>
    number(row.candle_acc_trade_price || row.candle_acc_trade_volume)
  );
  const close = closes.at(-1) || 0;
  const ema9Value = ema(closes, 9);
  const ema21Value = ema(closes, 21);
  const ema50Value = ema(closes, 50);
  const rsiValue = rsi(closes, 14);
  const atrValue = atr(highs, lows, closes, 14);
  const macdValue = macdHistogram(closes);
  const return3 = closes.length >= 4 ? pctChange(closes.at(-4)!, close) : 0;
  const return12 = closes.length >= 13 ? pctChange(closes.at(-13)!, close) : 0;
  const volumeBase = median(volumes.slice(-21, -1));
  const volumeRatio = safeDiv(volumes.at(-1) || 0, volumeBase, 1);
  const slopeReference = closes.length >= 6
    ? emaSeries(closes, 21).at(-6)!
    : ema21Value || close;

  const aboveFast = ema9Value != null ? Math.sign(close - ema9Value) : 0;
  const fastAboveSlow = ema9Value != null && ema21Value != null
    ? Math.sign(ema9Value - ema21Value)
    : 0;
  const slowAboveBase = ema21Value != null && ema50Value != null
    ? Math.sign(ema21Value - ema50Value)
    : 0;
  const slope = ema21Value != null && slopeReference > 0
    ? tanh(pctChange(slopeReference, ema21Value) / 1.2)
    : 0;
  const trendSignal = clamp(
    aboveFast * 0.25 + fastAboveSlow * 0.35 + slowAboveBase * 0.25 +
      slope * 0.15,
    -1,
    1,
  );

  const rsiSignal = rsiValue == null ? 0 : clamp((rsiValue - 50) / 25, -1, 1);
  const macdSignal = macdValue == null || !atrValue
    ? 0
    : tanh(macdValue / Math.max(atrValue * 0.18, Number.EPSILON));
  const returnSignal = tanh(return12 / 4);
  const momentumSignal = clamp(
    rsiSignal * 0.4 + macdSignal * 0.35 + returnSignal * 0.25,
    -1,
    1,
  );

  const recentHighs = highs.slice(-40);
  const recentLows = lows.slice(-20);
  const recentHigh = recentHighs.length ? Math.max(...recentHighs) : close;
  const recentLow = recentLows.length ? Math.min(...recentLows) : close;
  const supportCandidates = [
    ema21Value,
    recentLows.length >= 6 ? Math.min(...recentLows.slice(-6)) : null,
    recentLows.length ? recentLow : null,
  ].filter((value): value is number =>
    value != null && value > 0 && value < close
  );

  return {
    bars: rows.length,
    close,
    ema9: ema9Value,
    ema21: ema21Value,
    ema50: ema50Value,
    rsi14: rsiValue,
    atr14: atrValue,
    atr_pct: atrValue != null && close > 0 ? (atrValue / close) * 100 : null,
    macd_histogram: macdValue,
    return_3_pct: return3,
    return_12_pct: return12,
    volume_ratio: volumeRatio,
    trend_signal: trendSignal,
    momentum_signal: momentumSignal,
    overextension_pct: ema21Value != null && ema21Value > 0
      ? pctChange(ema21Value, close)
      : null,
    recent_high: recentHigh,
    recent_low: recentLow,
    support: supportCandidates.length ? Math.max(...supportCandidates) : null,
    resistance: nearestResistance(recentHighs, close),
  };
}

export function analyzePeriod(
  universe: UniverseRow,
  dataset: PeriodDataset,
): PeriodAnalysis {
  const timeframes = {
    m5: timeframeMetrics(dataset.m5),
    m15: timeframeMetrics(dataset.m15),
    h4: timeframeMetrics(dataset.h4),
    day: timeframeMetrics(dataset.day),
  };
  const requiredBars = { m5: 50, m15: 60, h4: 50, day: 50 };
  const completeKeys =
    (Object.keys(requiredBars) as Array<keyof typeof requiredBars>)
      .filter((key) => timeframes[key].bars >= requiredBars[key]);
  const completeness = completeKeys.length / 4;
  const weights = { m5: 0.15, m15: 0.3, h4: 0.35, day: 0.2 };
  const trend = (Object.keys(weights) as Array<keyof typeof weights>)
    .reduce((sum, key) => sum + timeframes[key].trend_signal * weights[key], 0);
  const momentum = (Object.keys(weights) as Array<keyof typeof weights>)
    .reduce(
      (sum, key) => sum + timeframes[key].momentum_signal * weights[key],
      0,
    );
  const volumeSignal = clamp(
    tanh((timeframes.m5.volume_ratio - 1) / 1.2) * 0.4 +
      tanh((timeframes.m15.volume_ratio - 1) / 1.2) * 0.6,
    -1,
    1,
  );

  let penalty = 0;
  const warnings: string[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];
  if (completeness < 1) {
    penalty += (1 - completeness) * 22;
    warnings.push(
      `기간 데이터 완성도가 ${(completeness * 100).toFixed(0)}%입니다.`,
    );
  }
  if (universe.change_24h_pct > 20) {
    penalty += Math.min(18, (universe.change_24h_pct - 20) * 0.8 + 8);
    warnings.push(
      `24시간 ${
        universe.change_24h_pct.toFixed(1)
      }% 상승으로 추격 매수 위험이 큽니다.`,
    );
  }
  if (Number(timeframes.m15.rsi14) > 78 || Number(timeframes.h4.rsi14) > 76) {
    penalty += 10;
    warnings.push("15분 또는 4시간 RSI가 과열권입니다.");
  }
  if (
    Number(timeframes.m15.overextension_pct) > 5 ||
    Number(timeframes.h4.overextension_pct) > 12
  ) {
    penalty += 10;
    warnings.push("가격이 핵심 EMA에서 과도하게 이격돼 있습니다.");
  }
  if (universe.day_range_pct > 30) {
    penalty += 7;
    warnings.push("당일 변동폭이 30%를 넘어 손절 미끄러짐 위험이 큽니다.");
  }

  const periodScore = clamp(
    50 + trend * 28 + momentum * 13 + volumeSignal * 6 +
      (universe.liquidity_score - 50) * 0.1 - penalty,
    0,
    100,
  );

  if (timeframes.m15.trend_signal > 0.35) {
    positives.push("15분 추세가 상승 정렬입니다.");
  } else if (timeframes.m15.trend_signal < -0.25) {
    negatives.push("15분 추세가 하락 정렬입니다.");
  }
  if (timeframes.h4.trend_signal > 0.35) {
    positives.push("4시간 추세가 상승 방향으로 유지됩니다.");
  } else if (timeframes.h4.trend_signal < -0.2) {
    negatives.push("4시간 추세가 약세입니다.");
  }
  if (timeframes.day.trend_signal > 0.3) {
    positives.push("일봉 추세가 중기 상승을 지지합니다.");
  } else if (timeframes.day.trend_signal < -0.2) {
    negatives.push("일봉 구조가 아직 하락 방향입니다.");
  }
  if (timeframes.m15.volume_ratio >= 1.3) {
    positives.push(
      `15분 거래대금이 최근 중앙값의 ${
        timeframes.m15.volume_ratio.toFixed(2)
      }배입니다.`,
    );
  }
  if (timeframes.m15.volume_ratio < 0.55) {
    negatives.push("15분 거래대금이 평소보다 크게 줄었습니다.");
  }
  if (trend > 0.25 && momentum < -0.2) {
    warnings.push("상승 추세와 단기 모멘텀이 엇갈려 눌림 확인이 필요합니다.");
  }

  const preliminaryStatus: PeriodAnalysis["preliminary_status"] =
    periodScore >= 65 && timeframes.m15.trend_signal > 0 &&
      timeframes.h4.trend_signal >= -0.05
      ? "CANDIDATE"
      : periodScore < 40 || timeframes.h4.trend_signal < -0.55
      ? "AVOID"
      : "WAIT";

  return {
    universe,
    timeframes,
    period_score: periodScore,
    trend_signal: trend,
    momentum_signal: momentum,
    data_completeness: completeness,
    preliminary_status: preliminaryStatus,
    positives,
    negatives,
    warnings,
  };
}

export function computeMicrostructure(
  snapshots: OrderbookSnapshot[],
  trades: TradeRow[],
  currentMs = Date.now(),
): Microstructure {
  const imbalances: number[] = [];
  const spreads: number[] = [];
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const snapshot of snapshots || []) {
    const units = (snapshot.orderbook_units || []).slice(0, 15);
    if (!units.length) continue;
    let bid = 0;
    let ask = 0;
    units.forEach((unit, index) => {
      const weight = 1 / Math.pow(index + 1, 0.72);
      bid += number(unit.bid_price) * number(unit.bid_size) * weight;
      ask += number(unit.ask_price) * number(unit.ask_size) * weight;
    });
    imbalances.push(safeDiv(bid - ask, bid + ask));
    const first = units[0];
    const bidPrice = number(first.bid_price);
    const askPrice = number(first.ask_price);
    if (bidPrice > 0 && askPrice >= bidPrice) {
      bestBid = bidPrice;
      bestAsk = askPrice;
      spreads.push(
        safeDiv(askPrice - bidPrice, (askPrice + bidPrice) / 2) * 10_000,
      );
    }
  }

  let buyNotional = 0;
  let sellNotional = 0;
  let tradeCount = 0;
  for (const trade of trades || []) {
    const timestamp = number(trade.timestamp, currentMs);
    if (
      currentMs - timestamp > 10 * 60 * 1000 || timestamp > currentMs + 60_000
    ) continue;
    const notional = number(trade.trade_price) * number(trade.trade_volume);
    if (!(notional > 0)) continue;
    tradeCount++;
    if (String(trade.ask_bid).toUpperCase() === "BID") buyNotional += notional;
    else sellNotional += notional;
  }
  const bookImbalance = mean(imbalances);
  const imbalanceDeviation = mean(
    imbalances.map((value) => Math.abs(value - bookImbalance)),
  );
  const stability = clamp(1 - imbalanceDeviation * 2.5, 0, 1);
  const pressure = safeDiv(
    buyNotional - sellNotional,
    buyNotional + sellNotional,
  );
  const spreadBps = spreads.length ? mean(spreads) : null;
  const spreadPenalty = spreadBps == null
    ? 12
    : Math.max(0, spreadBps - 8) * 0.7;
  const microScore = clamp(
    50 + bookImbalance * 23 + pressure * 24 + (stability - 0.5) * 6 -
      spreadPenalty,
    0,
    100,
  );

  return {
    samples: imbalances.length,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps,
    book_imbalance: bookImbalance,
    imbalance_stability: stability,
    trade_pressure: pressure,
    trade_count: tradeCount,
    buy_notional: buyNotional,
    sell_notional: sellNotional,
    micro_score: microScore,
  };
}

function decimalsForTick(tick: number): number {
  if (tick >= 1) return 0;
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 1));
}

export function roundToTick(
  value: number,
  tick: number,
  mode: "nearest" | "up" | "down" = "nearest",
): number {
  if (!(tick > 0) || !Number.isFinite(value)) return value;
  const scaled = value / tick;
  const rounded = mode === "up"
    ? Math.ceil(scaled)
    : mode === "down"
    ? Math.floor(scaled)
    : Math.round(scaled);
  return Number((rounded * tick).toFixed(decimalsForTick(tick)));
}

function netGainPct(entry: number, exit: number, feePct: number): number {
  const fee = feePct / 100;
  return ((exit * (1 - fee)) / (entry * (1 + fee)) - 1) * 100;
}

function netLossPct(entry: number, exit: number, feePct: number): number {
  return Math.max(0, -netGainPct(entry, exit, feePct));
}

export function buildTradePlan(
  period: PeriodAnalysis,
  micro: Microstructure,
  tickSize: number,
  risk: RiskConfig,
): TradePlan {
  const price = period.universe.current_price;
  const tick = tickSize > 0
    ? tickSize
    : Math.max(price * 0.0001, Number.EPSILON);
  const atr15 = period.timeframes.m15.atr14 || price * 0.012;
  const atr4h = period.timeframes.h4.atr14 || atr15 * 3;
  const atrDay = period.timeframes.day.atr14 || atr4h * 2;
  const bestBid = micro.best_bid || price;
  const bestAsk = micro.best_ask || price;
  const entryLow = roundToTick(
    Math.max(bestBid, price - atr15 * 0.28),
    tick,
    "down",
  );
  const entryHigh = roundToTick(Math.max(price, bestAsk), tick, "up");
  const entryExecution = Math.max(entryHigh, bestAsk) +
    tick * risk.entrySlippageTicks;

  const supports = [period.timeframes.m15.support, period.timeframes.h4.support]
    .filter((value): value is number =>
      value != null && value > 0 && value < entryExecution
    );
  const nearestSupport = supports.length
    ? Math.max(...supports)
    : entryExecution - atr15;
  const stopRaw = Math.min(
    nearestSupport - Math.max(atr15 * 0.18, tick * 2),
    entryExecution - atr15 * 1.15,
  );
  const stopPrice = roundToTick(Math.max(tick, stopRaw), tick, "down");
  const stopExecution = Math.max(
    tick,
    stopPrice - tick * risk.exitSlippageTicks,
  );

  const shortResistances = [
    period.timeframes.m15.resistance,
    period.timeframes.h4.resistance,
  ]
    .filter((value): value is number =>
      value != null && value > entryExecution
    );
  const nearestShortResistance = shortResistances.length
    ? Math.min(...shortResistances)
    : null;
  // 왕복 수수료와 출구 슬리피지를 반영해도 1.5 수준의 순손익비가
  // 구조적으로 가능하도록 기본 변동성 목표를 2.2 ATR로 둔다.
  const atrShortTarget = entryExecution + atr15 * 2.2;
  const shortRaw = nearestShortResistance
    ? Math.min(nearestShortResistance - tick * 2, atrShortTarget)
    : atrShortTarget;
  // 가까운 저항이 너무 낮다면 목표가를 저항 위로 억지로 밀지 않는다.
  // 이 경우 아래 target_structure / reward_risk 게이트가 진입을 차단한다.
  const shortTarget = roundToTick(shortRaw, tick, "down");
  const shortExecution = shortTarget - tick * risk.exitSlippageTicks;

  const mediumResistances = [
    period.timeframes.h4.resistance,
    period.timeframes.day.resistance,
    period.timeframes.day.recent_high,
  ].filter((value): value is number =>
    value != null && value > shortTarget * 1.002
  );
  const nearestMediumResistance = mediumResistances.length
    ? Math.min(...mediumResistances)
    : null;
  const volatilityMediumTarget = entryExecution +
    Math.min(atr4h * 2.4, atrDay * 1.3);
  const minimumMediumTarget = shortTarget + Math.max(atr15 * 0.8, tick * 3);
  const mediumRaw = nearestMediumResistance
    ? Math.min(
      nearestMediumResistance - tick * 2,
      Math.max(volatilityMediumTarget, minimumMediumTarget),
    )
    : Math.max(volatilityMediumTarget, minimumMediumTarget);
  const mediumTarget = roundToTick(mediumRaw, tick, "down");

  const shortGain = netGainPct(
    entryExecution,
    shortExecution,
    risk.feePerSidePct,
  );
  const mediumGain = netGainPct(
    entryExecution,
    mediumTarget - tick * risk.exitSlippageTicks,
    risk.feePerSidePct,
  );
  const stopLoss = netLossPct(
    entryExecution,
    stopExecution,
    risk.feePerSidePct,
  );
  const rr = stopLoss > 0 ? shortGain / stopLoss : 0;
  const riskBudget = risk.capitalKrw * (risk.riskPct / 100);
  const investment = stopLoss > 0
    ? Math.min(risk.capitalKrw, riskBudget / (stopLoss / 100))
    : 0;
  const roundedInvestment = Math.max(0, Math.floor(investment / 1000) * 1000);

  return {
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_execution_estimate: entryExecution,
    short_target: shortTarget,
    short_target_execution_estimate: shortExecution,
    medium_target: mediumTarget,
    stop_price: stopPrice,
    stop_execution_estimate: stopExecution,
    short_net_return_pct: shortGain,
    medium_net_return_pct: mediumGain,
    net_stop_pct: stopLoss,
    net_rr: rr,
    recommended_investment_krw: roundedInvestment,
    risk_budget_krw: Math.round(riskBudget),
    estimated_loss_krw: Math.round(roundedInvestment * stopLoss / 100),
    tick_size: tick,
    actionable: false,
  };
}

export function estimateHorizon(
  period: PeriodAnalysis,
  stopPrice: number,
): TrendHorizon {
  const tf = period.timeframes;
  let code: TrendHorizon["code"] = "INTRADAY";
  let label = "장중 단기 보유 후보";
  let window = "1~12시간";
  if (
    tf.day.trend_signal > 0.45 && tf.h4.trend_signal > 0.45 &&
    tf.m15.trend_signal > 0.1
  ) {
    code = "LONG";
    label = "중장기 추세 보유 후보";
    window = "2~6주";
  } else if (
    tf.h4.trend_signal > 0.4 && tf.day.trend_signal >= -0.05 &&
    tf.m15.trend_signal > 0.2
  ) {
    code = "MEDIUM";
    label = "중기 보유 후보";
    window = "2~10일";
  } else if (tf.m15.trend_signal > 0.3 && tf.h4.trend_signal >= -0.05) {
    code = "SHORT";
    label = "단기 보유 후보";
    window = "6~48시간";
  }
  const alignment = clamp(
    (tf.m5.trend_signal + tf.m15.trend_signal + tf.h4.trend_signal +
      tf.day.trend_signal + 4) / 8,
    0,
    1,
  );
  const persistence = clamp(
    35 + alignment * 50 + Math.max(0, period.momentum_signal) * 10,
    20,
    88,
  );
  const estimate =
    `${label}로 분류되며, 현재 정렬이 유지된다는 조건에서 ${window} 범위를 우선 관찰합니다. 시간 예측은 확정값이 아니라 EMA·거래대금·변동성 기반 조건부 추정입니다.`;
  const invalidation = [
    `${stopPrice.toLocaleString("ko-KR")}원 이탈`,
    tf.m15.ema21
      ? `15분봉 종가가 EMA21(${
        tf.m15.ema21.toLocaleString("ko-KR", { maximumFractionDigits: 8 })
      }원) 아래에서 연속 마감`
      : "15분 추세가 하락 정렬로 전환",
    "거래대금 감소와 함께 4시간 EMA9가 EMA21 아래로 전환",
  ];
  return {
    code,
    label,
    expected_window: window,
    persistence_score: persistence,
    estimate,
    invalidation,
  };
}

function gate(
  key: string,
  label: string,
  passed: boolean,
  detail: string,
): Gate {
  return { key, label, passed, detail };
}

export function finalizeCandidate(
  period: PeriodAnalysis,
  micro: Microstructure,
  tickSize: number,
  risk: RiskConfig,
): FinalCandidate {
  const plan = buildTradePlan(period, micro, tickSize, risk);
  const score = clamp(
    period.period_score * 0.82 + micro.micro_score * 0.18,
    0,
    100,
  );
  const tf = period.timeframes;
  const checks: Gate[] = [
    gate(
      "data",
      "기간 데이터",
      period.data_completeness === 1,
      "5분·15분·4시간·일봉 최소 표본을 모두 확보해야 합니다.",
    ),
    gate(
      "market_event",
      "시장경보",
      period.universe.caution_labels.length === 0,
      "유의·주의·경고 종목은 추천하지 않습니다.",
    ),
    gate(
      "liquidity",
      "거래대금",
      period.universe.turnover_24h_krw >= MIN_ACTIONABLE_TURNOVER_24H,
      "24시간 거래대금 10억원 이상이어야 합니다.",
    ),
    gate(
      "freshness",
      "체결 최신성",
      period.universe.freshness_seconds <= 300,
      "최근 체결이 5분 이내여야 합니다.",
    ),
    gate(
      "trend_15m",
      "15분 추세",
      tf.m15.trend_signal > 0.12,
      "15분 추세가 상승 방향이어야 합니다.",
    ),
    gate(
      "trend_4h",
      "4시간 추세",
      tf.h4.trend_signal >= -0.05,
      "4시간 추세가 뚜렷한 하락이면 제외합니다.",
    ),
    gate(
      "overheat",
      "과열 제한",
      Number(tf.m15.rsi14) <= 78 && period.universe.change_24h_pct <= 25,
      "RSI 및 당일 급등 추격 기준을 통과해야 합니다.",
    ),
    gate(
      "micro_data",
      "호가·체결 표본",
      micro.samples >= 3 && micro.trade_count >= 8,
      "호가 3회와 최근 체결 8건 이상이 필요합니다.",
    ),
    gate(
      "spread",
      "스프레드",
      micro.spread_bps != null && micro.spread_bps <= 35,
      "평균 스프레드가 35bp 이하여야 합니다.",
    ),
    gate(
      "micro_pressure",
      "초단기 수급",
      micro.trade_pressure > -0.45 && micro.book_imbalance > -0.5,
      "매도 체결과 매도호가가 동시에 과도하게 우세하면 제외합니다.",
    ),
    gate(
      "stop",
      "손절폭",
      plan.net_stop_pct >= 0.25 && plan.net_stop_pct <= risk.maxStopPct,
      `비용 포함 손절폭이 0.25~${risk.maxStopPct}%여야 합니다.`,
    ),
    gate(
      "target_structure",
      "목표가 구조",
      plan.short_target_execution_estimate > plan.entry_execution_estimate &&
        plan.medium_target > plan.short_target,
      "단기 목표는 진입 실행가보다 높고 중기 목표는 단기 목표보다 높아야 합니다.",
    ),
    gate(
      "reward_risk",
      "손익비",
      plan.short_net_return_pct > 0 && plan.net_rr >= risk.minNetRR,
      `단기 목표 기준 비용 포함 손익비 ${risk.minNetRR} 이상이어야 합니다.`,
    ),
    gate(
      "score",
      "종합점수",
      score >= 72,
      "최종 점수가 72점 이상이어야 합니다.",
    ),
  ];
  const failed = checks.filter((check) => !check.passed);
  const decision: FinalCandidate["decision"] = failed.length === 0
    ? "BUY"
    : score < 42 || tf.h4.trend_signal < -0.5
    ? "AVOID"
    : "WAIT";
  plan.actionable = decision === "BUY";
  const horizon = estimateHorizon(period, plan.stop_price);
  const positives = [...period.positives];
  const negatives = [...period.negatives];
  const warnings = [...period.warnings];
  if (micro.book_imbalance > 0.12) {
    positives.push("현재가 인접 매수호가 잔량이 상대적으로 우세합니다.");
  }
  if (micro.book_imbalance < -0.12) {
    negatives.push("현재가 인접 매도호가 잔량이 상대적으로 우세합니다.");
  }
  if (micro.trade_pressure > 0.12) {
    positives.push("최근 체결대금은 매수 주도가 우세합니다.");
  }
  if (micro.trade_pressure < -0.12) {
    negatives.push("최근 체결대금은 매도 주도가 우세합니다.");
  }
  for (const failedGate of failed) {
    warnings.push(`${failedGate.label}: ${failedGate.detail}`);
  }
  if (decision !== "BUY") {
    warnings.push(
      "강제 조건 미통과로 현재가 매수 추천이 아닌 관찰 후보입니다.",
    );
  }

  const confidence = clamp(
    38 + Math.abs(score - 50) * 0.55 + period.data_completeness * 12 +
      micro.imbalance_stability * 6 - failed.length * 3,
    25,
    84,
  );

  return {
    market: period.universe.market,
    korean_name: period.universe.korean_name,
    english_name: period.universe.english_name,
    current_price: period.universe.current_price,
    change_24h_pct: period.universe.change_24h_pct,
    turnover_24h_krw: period.universe.turnover_24h_krw,
    score,
    confidence,
    decision,
    decision_label: decision === "BUY"
      ? "현재 매수 후보"
      : decision === "WAIT"
      ? "관찰·눌림 대기"
      : "매수 제외",
    trade_plan: plan,
    horizon,
    gates: checks,
    failed_gates: failed.map((item) => item.key),
    positives: [...new Set(positives)],
    negatives: [...new Set(negatives)],
    warnings: [...new Set(warnings)],
    timeframes: period.timeframes,
    microstructure: micro,
  };
}
