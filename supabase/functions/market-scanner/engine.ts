// Trading-booooo Market Scanner v2.6.0
// Pure analysis engine. Public market data only; no order or account operations.

import { ACTIVE_CALIBRATION_PROFILE, calibrationBucket } from "./calibration-profile.ts";

export const ENGINE_VERSION = "2.6.0";
export const CALIBRATED_PARAMETERS = ACTIVE_CALIBRATION_PROFILE.parameters;
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
  code?: string;
  timestamp?: number | string;
  stream_type?: string;
  orderbook_units: OrderbookUnit[];
};

export type TradeRow = {
  market?: string;
  code?: string;
  timestamp?: number | string;
  trade_timestamp?: number | string;
  trade_price: number | string;
  trade_volume: number | string;
  ask_bid: string;
  sequential_id?: number | string;
  stream_type?: string;
  best_ask_price?: number | string;
  best_ask_size?: number | string;
  best_bid_price?: number | string;
  best_bid_size?: number | string;
};

export type UniverseRow = {
  market: string;
  korean_name: string;
  english_name: string;
  current_price: number;
  change_24h_pct: number;
  turnover_24h_krw: number;
  turnover_24h_quote: number;
  quote_currency: "KRW" | "USDT";
  min_actionable_turnover_24h: number;
  day_range_pct: number;
  day_position: number;
  freshness_seconds: number;
  liquidity_score: number;
  initial_score: number;
  eligible: boolean;
  excluded_reason: string | null;
  caution_labels: string[];
};

export type TrendState =
  | "FULL_BULL"
  | "BULL_PULLBACK"
  | "RECOVERY"
  | "MIXED"
  | "BEAR";

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
  trend_state: TrendState;
  ema21_slope_pct: number | null;
  atr_normalized_return_12: number | null;
  overheat_score: number;
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
  reference_price: number | null;
  reference_timestamp: number | null;
  live_book_age_ms: number | null;
  latest_bids: Array<{ price: number; size: number }>;
  latest_asks: Array<{ price: number; size: number }>;
  spread_bps: number | null;
  book_imbalance: number;
  imbalance_stability: number;
  trade_pressure: number;
  trade_count: number;
  buy_notional: number;
  sell_notional: number;
  micro_score: number;
  dynamic: DynamicOrderflow;
};

export type DynamicOrderflowStatus =
  | "BREAKOUT_CONFIRMED"
  | "NEUTRAL"
  | "SPOOF_LIKE_RISK"
  | "ASK_ABSORPTION_RISK"
  | "SUPPORT_BREAKDOWN_RISK"
  | "INSUFFICIENT";

export type DynamicOrderflow = {
  status: DynamicOrderflowStatus;
  label: string;
  sufficient: boolean;
  observation_ms: number;
  distinct_book_updates: number;
  aligned_trade_count: number;
  covered_phases: number;
  phase_book_updates: number[];
  phase_trade_counts: number[];
  phase_consistent: boolean;
  data_quality: number;
  spoof_like_score: number;
  ask_absorption_score: number;
  breakout_score: number;
  persistent_bid_wall_price: number | null;
  persistent_ask_wall_price: number | null;
  confirmed_support_price: number | null;
  target_cap_price: number | null;
  evidence: string[];
  warnings: string[];
};

export type RiskConfig = {
  capitalKrw: number;
  quoteCurrency?: "KRW" | "USDT";
  riskPct: number;
  feePerSidePct: number;
  minNetRR: number;
  maxStopPct: number;
  entrySlippageTicks: number;
  exitSlippageTicks: number;
  // 연구용 튜닝 손잡이. 모두 선택값이며, 미지정 시 운영 기본값을 유지한다.
  // 백테스트(backtest/)에서 데이터로 그리드 서치하기 위한 파라미터.
  shortTargetAtrMult?: number; // 기본 2.2 (단기 목표 = 진입 + atr15 * mult)
  stopAtrMult?: number; // 기본 1.15 (손절 상한 = 진입 - atr15 * mult)
  mediumTargetAtr4hMult?: number; // 기본 2.4
  mediumTargetAtrDayMult?: number; // 기본 1.3
  scoreThreshold?: number; // 기본 72 (BUY 최종 점수컷)
};

export type TargetStrategy = "SHORT_ONLY" | "SCALE_OUT";

export type PriceForecast = {
  model_version: string;
  calibration_source: "DEFAULT_PRIOR" | "WALK_FORWARD";
  calibrated: boolean;
  calibration_samples: number;
  target_hit_probability_pct: number;
  wait_entry_probability_pct: number | null;
  raw_expected_upside_pct: number;
  expected_upside_pct: number;
  conservative_upside_pct: number;
  optimistic_upside_pct: number;
  expected_price: number;
  conservative_price: number;
  optimistic_price: number;
  expected_net_return_pct: number;
  confidence_band_pct: number;
  horizon_bars_15m: number;
  horizon_label: string;
  drivers: string[];
  caveats: string[];
};

export type TradePlan = {
  reference_price: number;
  reference_source: "LIVE_ORDERBOOK" | "HYPOTHETICAL_PULLBACK" | "TICKER_FALLBACK";
  entry_low: number;
  entry_high: number;
  entry_execution_estimate: number;
  structural_support: number | null;
  support_basis: string;
  structural_resistance: number | null;
  target_basis: string;
  structure_complete: boolean;
  stop_distance_atr: number | null;
  target_distance_atr: number | null;
  visible_ask_depth_quote: number;
  visible_bid_depth_quote: number;
  depth_coverage_ratio: number;
  estimated_entry_slippage_bps: number | null;
  short_target: number;
  short_target_execution_estimate: number;
  medium_target: number;
  medium_target_execution_estimate: number;
  target_strategy: TargetStrategy;
  target_strategy_label: string;
  first_target_allocation_pct: number;
  continuation_allocation_pct: number;
  expected_exit_price: number;
  expected_exit_net_return_pct: number;
  stop_price: number;
  stop_execution_estimate: number;
  short_net_return_pct: number;
  medium_net_return_pct: number;
  short_net_rr: number;
  medium_net_rr: number;
  blended_net_return_pct: number;
  blended_net_rr: number;
  net_stop_pct: number;
  net_rr: number;
  recommended_investment_krw: number;
  recommended_investment_quote: number;
  risk_budget_krw: number;
  estimated_loss_krw: number;
  tick_size: number;
  actionable: boolean;
};

export type WatchEntryPlan = {
  available: boolean;
  status: "CONDITIONAL" | "RECHECK_REQUIRED" | "UNAVAILABLE";
  zone_low: number | null;
  zone_high: number | null;
  max_price: number | null;
  invalidation_price: number | null;
  reference_target: number | null;
  expected_exit_price: number | null;
  expected_net_return_pct: number | null;
  stop_price: number | null;
  estimated_net_rr: number | null;
  discount_from_current_pct: number | null;
  label: string;
  entry_trigger: string;
  exit_trigger: string;
  scenario: string[];
  conditions: string[];
  note: string;
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
  turnover_24h_quote: number;
  quote_currency: "KRW" | "USDT";
  score: number;
  confidence: number;
  decision: "BUY" | "WAIT" | "AVOID";
  decision_label: string;
  trade_plan: TradePlan;
  watch_entry_plan: WatchEntryPlan;
  horizon: TrendHorizon;
  forecast: PriceForecast;
  gates: Gate[];
  failed_gates: string[];
  positives: string[];
  negatives: string[];
  warnings: string[];
  timeframes: PeriodAnalysis["timeframes"];
  microstructure: Microstructure;
  price_context: {
    ticker_price: number;
    live_reference_price: number | null;
    reference_source: TradePlan["reference_source"];
    reference_timestamp: number | null;
    live_book_age_ms: number | null;
    ticker_live_deviation_bps: number | null;
  };
};

export type UniverseConfig = {
  quoteCurrency?: "KRW" | "USDT";
  marketMatches?: (market: string) => boolean;
  minTurnover24h?: number;
  minActionableTurnover24h?: number;
  liquidityLogFloor?: number;
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
  config: UniverseConfig = {},
): UniverseRow[] {
  const quoteCurrency = config.quoteCurrency || "KRW";
  const marketMatches = config.marketMatches ||
    ((market: string) => market.startsWith("KRW-"));
  const minTurnover = config.minTurnover24h ?? MIN_KRW_TURNOVER_24H;
  const minActionableTurnover = config.minActionableTurnover24h ??
    MIN_ACTIONABLE_TURNOVER_24H;
  const liquidityLogFloor = config.liquidityLogFloor ?? 8.7;
  const tickerByMarket = new Map(
    tickers.map((row) => [String(row.market), row]),
  );
  const rows: UniverseRow[] = [];

  for (const market of markets) {
    if (!marketMatches(String(market.market))) continue;
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
      ((Math.log10(Math.max(turnover, 1)) - liquidityLogFloor) / 3.3) * 100,
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
    else if (turnover < minTurnover) {
      excludedReason = quoteCurrency === "KRW"
        ? "24시간 거래대금 5억원 미만"
        : `24시간 거래대금 ${minTurnover.toLocaleString("en-US")} USDT 미만`;
    }

    rows.push({
      market: market.market,
      korean_name: market.korean_name || market.market.replace("KRW-", ""),
      english_name: market.english_name || "",
      current_price: current,
      change_24h_pct: change,
      turnover_24h_krw: turnover,
      turnover_24h_quote: turnover,
      quote_currency: quoteCurrency,
      min_actionable_turnover_24h: minActionableTurnover,
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

function classifyTrendState(
  close: number,
  ema9Value: number | null,
  ema21Value: number | null,
  ema50Value: number | null,
  ema21SlopePct: number | null,
): TrendState {
  if (ema9Value == null || ema21Value == null || ema50Value == null) {
    return "MIXED";
  }
  const rising = Number(ema21SlopePct) > 0;
  if (close > ema9Value && ema9Value > ema21Value && ema21Value > ema50Value && rising) {
    return "FULL_BULL";
  }
  if (close >= ema21Value && ema9Value > ema21Value && ema21Value > ema50Value && rising) {
    return "BULL_PULLBACK";
  }
  if (close > ema9Value && ema9Value > ema21Value && rising) {
    return "RECOVERY";
  }
  if (close < ema9Value && ema9Value < ema21Value && ema21Value < ema50Value && !rising) {
    return "BEAR";
  }
  return "MIXED";
}

function trendStateLabel(state: TrendState): string {
  if (state === "FULL_BULL") return "완전 상승 정렬";
  if (state === "BULL_PULLBACK") return "상승 추세 내 눌림";
  if (state === "RECOVERY") return "단기 회복 중";
  if (state === "BEAR") return "완전 하락 정렬";
  return "혼조";
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
  const ema21SlopePct = ema21Value != null && slopeReference > 0
    ? pctChange(slopeReference, ema21Value)
    : null;
  const slope = ema21SlopePct != null ? tanh(ema21SlopePct / 1.2) : 0;
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
  const overextensionPct = ema21Value != null && ema21Value > 0
    ? pctChange(ema21Value, close)
    : null;
  const atrPctValue = atrValue != null && close > 0 ? (atrValue / close) * 100 : null;
  const atrNormalizedReturn12 = atrPctValue != null && atrPctValue > 0
    ? return12 / atrPctValue
    : null;
  const overheatScore = clamp(
    Math.max(0, (Number(rsiValue) - 68) / 18) * 0.3 +
      Math.max(0, (Number(overextensionPct) - 2) / 12) * 0.35 +
      Math.max(0, (Number(atrNormalizedReturn12) - 2) / 7) * 0.2 +
      Math.max(0, (volumeRatio - 2) / 8) * 0.15,
    0,
    1,
  );
  const trendState = classifyTrendState(
    close,
    ema9Value,
    ema21Value,
    ema50Value,
    ema21SlopePct,
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
    atr_pct: atrPctValue,
    macd_histogram: macdValue,
    return_3_pct: return3,
    return_12_pct: return12,
    volume_ratio: volumeRatio,
    trend_signal: trendSignal,
    momentum_signal: momentumSignal,
    trend_state: trendState,
    ema21_slope_pct: ema21SlopePct,
    atr_normalized_return_12: atrNormalizedReturn12,
    overheat_score: overheatScore,
    overextension_pct: overextensionPct,
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
  const requiredBars = { m5: 60, m15: 80, h4: 120, day: 120 };
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
  const maxOverheat = Math.max(
    timeframes.m15.overheat_score,
    timeframes.h4.overheat_score,
    timeframes.day.overheat_score,
  );
  if (maxOverheat > 0.58) {
    penalty += 8 + (maxOverheat - 0.58) * 18;
    warnings.push("RSI·EMA 이격·ATR 대비 상승폭을 합산한 과열 점수가 높습니다.");
  }
  if (timeframes.day.return_12_pct > 80) {
    penalty += Math.min(18, 8 + (timeframes.day.return_12_pct - 80) * 0.03);
    warnings.push("최근 일봉 누적 상승폭이 지나치게 커 추격 진입 위험이 큽니다.");
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

  if (["FULL_BULL", "BULL_PULLBACK"].includes(timeframes.m15.trend_state)) {
    positives.push(`15분 구조는 ${trendStateLabel(timeframes.m15.trend_state)}입니다.`);
  } else if (timeframes.m15.trend_state === "RECOVERY") {
    warnings.push("15분 구조는 상승 정렬 완성이 아니라 단기 회복 단계입니다.");
  } else if (timeframes.m15.trend_state === "BEAR") {
    negatives.push("15분 구조가 완전 하락 정렬입니다.");
  }
  if (["FULL_BULL", "BULL_PULLBACK"].includes(timeframes.h4.trend_state)) {
    positives.push(`4시간 구조는 ${trendStateLabel(timeframes.h4.trend_state)}입니다.`);
  } else if (timeframes.h4.trend_state === "RECOVERY") {
    warnings.push("4시간 구조는 장기 상승 정렬이 아니라 회복 단계입니다.");
  } else if (timeframes.h4.trend_state === "BEAR") {
    negatives.push("4시간 구조가 완전 하락 정렬입니다.");
  }
  if (["FULL_BULL", "BULL_PULLBACK"].includes(timeframes.day.trend_state)) {
    positives.push(`일봉 구조는 ${trendStateLabel(timeframes.day.trend_state)}입니다.`);
  } else if (timeframes.day.trend_state === "RECOVERY") {
    warnings.push("일봉은 중기 상승 확정이 아니라 회복 단계입니다.");
  } else if (timeframes.day.trend_state === "BEAR") {
    negatives.push("일봉 구조가 완전 하락 정렬입니다.");
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
    periodScore >= 65 &&
      ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(timeframes.m15.trend_state) &&
      ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(timeframes.h4.trend_state)
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

type BookFrame = {
  timestamp: number;
  units: Array<{
    bidPrice: number;
    bidSize: number;
    askPrice: number;
    askSize: number;
  }>;
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: number;
  bestAsk: number;
};

type WallStat = {
  price: number;
  maxSize: number;
  maxNotional: number;
  nearCount: number;
  minRank: number;
  firstIndex: number;
  lastIndex: number;
};

const DYNAMIC_MIN_OBSERVATION_MS = 45_000;
const DYNAMIC_MIN_BOOK_UPDATES = 25;
const DYNAMIC_MIN_TRADES = 20;
const DYNAMIC_PHASE_COUNT = 3;
const WALL_LEVELS = 3;
const TRACKED_LEVELS = 15;

function bookSignature(snapshot: OrderbookSnapshot): string {
  return (snapshot.orderbook_units || []).slice(0, TRACKED_LEVELS).map((unit) =>
    [
      number(unit.bid_price),
      number(unit.bid_size),
      number(unit.ask_price),
      number(unit.ask_size),
    ].join(":")
  ).join("|");
}

function distinctBookFrames(snapshots: OrderbookSnapshot[]): BookFrame[] {
  const ordered = (snapshots || []).map((snapshot, index) => ({
    snapshot,
    index,
    timestamp: number(snapshot.timestamp),
  })).filter((item) => item.timestamp > 0).sort((left, right) =>
    left.timestamp - right.timestamp || left.index - right.index
  );
  const frames: BookFrame[] = [];
  let previousSignature = "";
  for (const item of ordered) {
    const signature = bookSignature(item.snapshot);
    if (!signature || signature === previousSignature) continue;
    previousSignature = signature;
    const units = (item.snapshot.orderbook_units || []).slice(0, TRACKED_LEVELS)
      .map((unit) => ({
        bidPrice: number(unit.bid_price),
        bidSize: number(unit.bid_size),
        askPrice: number(unit.ask_price),
        askSize: number(unit.ask_size),
      })).filter((unit) =>
        unit.bidPrice > 0 && unit.askPrice > 0 && unit.bidSize >= 0 &&
        unit.askSize >= 0
      );
    if (!units.length) continue;
    frames.push({
      timestamp: item.timestamp,
      units,
      bids: new Map(units.map((unit) => [unit.bidPrice, unit.bidSize])),
      asks: new Map(units.map((unit) => [unit.askPrice, unit.askSize])),
      bestBid: units[0].bidPrice,
      bestAsk: units[0].askPrice,
    });
  }
  return frames;
}

function tradeTimestamp(trade: TradeRow): number {
  return number(trade.trade_timestamp || trade.timestamp);
}

function distinctTrades(trades: TradeRow[]): TradeRow[] {
  const seen = new Set<string>();
  return (trades || []).filter((trade) => {
    const timestamp = tradeTimestamp(trade);
    const price = number(trade.trade_price);
    const volume = number(trade.trade_volume);
    if (!(timestamp > 0 && price > 0 && volume > 0)) return false;
    const id = String(
      trade.sequential_id ||
        `${timestamp}:${price}:${volume}:${
          String(trade.ask_bid).toUpperCase()
        }`,
    );
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));
}

type IndexedTrade = { timestamp: number; volume: number };

function priceTradeKey(
  side: "BID" | "ASK",
  price: number,
  tick: number,
): string {
  return `${side}:${roundToTick(price, tick, "nearest")}`;
}

function indexTradesByPrice(
  trades: TradeRow[],
  tick: number,
): Map<string, IndexedTrade[]> {
  const index = new Map<string, IndexedTrade[]>();
  for (const trade of trades) {
    const side = String(trade.ask_bid).toUpperCase();
    if (side !== "BID" && side !== "ASK") continue;
    const key = priceTradeKey(
      side,
      number(trade.trade_price),
      tick,
    );
    const bucket = index.get(key) || [];
    bucket.push({
      timestamp: tradeTimestamp(trade),
      volume: number(trade.trade_volume),
    });
    index.set(key, bucket);
  }
  return index;
}

function volumeAtPrice(
  tradeIndex: Map<string, IndexedTrade[]>,
  side: "BID" | "ASK",
  price: number,
  from: number,
  to: number,
  tick: number,
): number {
  let volume = 0;
  const bucket = tradeIndex.get(priceTradeKey(side, price, tick)) || [];
  for (const trade of bucket) {
    if (trade.timestamp <= from || trade.timestamp > to) continue;
    volume += trade.volume;
  }
  return volume;
}

function wallStats(
  frames: BookFrame[],
  side: "bid" | "ask",
): { stats: WallStat[]; baselineNotional: number } {
  const stats = new Map<number, WallStat>();
  const notionals: number[] = [];
  frames.forEach((frame, frameIndex) => {
    frame.units.slice(0, 5).forEach((unit, rank) => {
      const price = side === "bid" ? unit.bidPrice : unit.askPrice;
      const size = side === "bid" ? unit.bidSize : unit.askSize;
      const notional = price * size;
      if (!(price > 0 && size >= 0 && notional >= 0)) return;
      notionals.push(notional);
      const current = stats.get(price) || {
        price,
        maxSize: 0,
        maxNotional: 0,
        nearCount: 0,
        minRank: rank,
        firstIndex: frameIndex,
        lastIndex: frameIndex,
      };
      current.maxSize = Math.max(current.maxSize, size);
      current.maxNotional = Math.max(current.maxNotional, notional);
      current.nearCount++;
      current.minRank = Math.min(current.minRank, rank);
      current.lastIndex = frameIndex;
      stats.set(price, current);
    });
  });
  return {
    stats: [...stats.values()],
    baselineNotional: Math.max(median(notionals), Number.EPSILON),
  };
}

function wallPersistence(stat: WallStat): number {
  return safeDiv(stat.nearCount, stat.lastIndex - stat.firstIndex + 1);
}

function wallDuration(stat: WallStat, frames: BookFrame[]): number {
  return Math.max(
    0,
    frames[stat.lastIndex].timestamp - frames[stat.firstIndex].timestamp,
  );
}

function dynamicLabel(status: DynamicOrderflowStatus): string {
  if (status === "BREAKOUT_CONFIRMED") return "돌파 후 지지 전환 확인";
  if (status === "SPOOF_LIKE_RISK") return "가짜 매수벽 취소 의심";
  if (status === "ASK_ABSORPTION_RISK") return "매도 흡수·재보충 위험";
  if (status === "SUPPORT_BREAKDOWN_RISK") return "매수 지지 붕괴 위험";
  if (status === "NEUTRAL") return "동적 특이 위험 없음";
  return "동적 표본 부족";
}

function displayPrice(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
}

export function computeDynamicOrderflow(
  snapshots: OrderbookSnapshot[],
  trades: TradeRow[],
  tickSize: number,
): DynamicOrderflow {
  const frames = distinctBookFrames(snapshots);
  const observedGaps: number[] = [];
  const firstUnits = frames[0]?.units || [];
  for (let index = 1; index < firstUnits.length; index++) {
    const bidGap = Math.abs(
      firstUnits[index - 1].bidPrice - firstUnits[index].bidPrice,
    );
    const askGap = Math.abs(
      firstUnits[index].askPrice - firstUnits[index - 1].askPrice,
    );
    if (bidGap > 0) observedGaps.push(bidGap);
    if (askGap > 0) observedGaps.push(askGap);
  }
  const tick = tickSize > Number.EPSILON
    ? tickSize
    : observedGaps.length
    ? Math.min(...observedGaps)
    : Number.EPSILON;
  const observationMs = frames.length >= 2
    ? frames.at(-1)!.timestamp - frames[0].timestamp
    : 0;
  const start = frames[0]?.timestamp || 0;
  const end = frames.at(-1)?.timestamp || 0;
  const alignedTrades = distinctTrades(trades).filter((trade) => {
    const streamType = String(trade.stream_type || "").toUpperCase();
    const timestamp = tradeTimestamp(trade);
    return streamType !== "SNAPSHOT" && timestamp >= start - 250 &&
      timestamp <= end + 250;
  });
  const phaseBookUpdates = Array.from({ length: DYNAMIC_PHASE_COUNT }, () => 0);
  const phaseTradeCounts = Array.from({ length: DYNAMIC_PHASE_COUNT }, () => 0);
  const phaseWidth = Math.max(1, observationMs / DYNAMIC_PHASE_COUNT);
  const phaseIndex = (timestamp: number) =>
    Math.min(
      DYNAMIC_PHASE_COUNT - 1,
      Math.max(0, Math.floor((timestamp - start) / phaseWidth)),
    );
  for (const frame of frames) phaseBookUpdates[phaseIndex(frame.timestamp)]++;
  for (const trade of alignedTrades) {
    phaseTradeCounts[phaseIndex(tradeTimestamp(trade))]++;
  }
  const coveredPhases =
    phaseBookUpdates.filter((books, index) =>
      books >= 3 && phaseTradeCounts[index] >= 2
    ).length;
  const phaseConsistent = coveredPhases === DYNAMIC_PHASE_COUNT;
  const tradeIndex = indexTradesByPrice(alignedTrades, tick);
  const dataQuality = clamp(
    Math.min(1, observationMs / 60_000) * 0.3 +
      Math.min(1, frames.length / 40) * 0.28 +
      Math.min(1, alignedTrades.length / 40) * 0.27 +
      (coveredPhases / DYNAMIC_PHASE_COUNT) * 0.15,
    0,
    1,
  );
  const sufficient = observationMs >= DYNAMIC_MIN_OBSERVATION_MS &&
    frames.length >= DYNAMIC_MIN_BOOK_UPDATES &&
    alignedTrades.length >= DYNAMIC_MIN_TRADES && phaseConsistent;
  const empty: DynamicOrderflow = {
    status: "INSUFFICIENT",
    label: dynamicLabel("INSUFFICIENT"),
    sufficient: false,
    observation_ms: observationMs,
    distinct_book_updates: frames.length,
    aligned_trade_count: alignedTrades.length,
    covered_phases: coveredPhases,
    phase_book_updates: phaseBookUpdates,
    phase_trade_counts: phaseTradeCounts,
    phase_consistent: phaseConsistent,
    data_quality: dataQuality,
    spoof_like_score: 0,
    ask_absorption_score: 0,
    breakout_score: 0,
    persistent_bid_wall_price: null,
    persistent_ask_wall_price: null,
    confirmed_support_price: null,
    target_cap_price: null,
    evidence: [],
    warnings: [
      `실시간 호가 ${DYNAMIC_MIN_BOOK_UPDATES}회·동시간대 체결 ${DYNAMIC_MIN_TRADES}건·관찰 ${
        DYNAMIC_MIN_OBSERVATION_MS / 1000
      }초와 초반·중반·확인 3개 구간의 분산 표본이 필요합니다.`,
    ],
  };
  if (frames.length < 2) return empty;

  const bidWalls = wallStats(frames, "bid");
  const askWalls = wallStats(frames, "ask");
  const bidCandidates = bidWalls.stats.filter((stat) =>
    stat.minRank < WALL_LEVELS &&
    stat.maxNotional >= bidWalls.baselineNotional * 2.8
  );
  const askCandidates = askWalls.stats.filter((stat) =>
    stat.minRank < WALL_LEVELS &&
    stat.maxNotional >= askWalls.baselineNotional * 2.8
  );

  let spoofScore = 0;
  let absorptionMax = 0;
  let absorptionEvents = 0;
  let breakdownScore = 0;

  for (let index = 0; index < frames.length - 1; index++) {
    const previous = frames[index];
    const current = frames[index + 1];
    const previousBidNotionals = previous.units.slice(0, WALL_LEVELS).map(
      (unit) => unit.bidPrice * unit.bidSize,
    );
    const previousAskNotionals = previous.units.slice(0, WALL_LEVELS).map(
      (unit) => unit.askPrice * unit.askSize,
    );
    const localBidBaseline = Math.max(
      median(
        previous.units.slice(0, 8).map((unit) => unit.bidPrice * unit.bidSize),
      ),
      Number.EPSILON,
    );
    const localAskBaseline = Math.max(
      median(
        previous.units.slice(0, 8).map((unit) => unit.askPrice * unit.askSize),
      ),
      Number.EPSILON,
    );

    const worstVisibleBid = current.bids.size
      ? Math.min(...current.bids.keys())
      : Number.NaN;
    previous.units.slice(0, WALL_LEVELS).forEach((unit, rank) => {
      const bidIsWall = previousBidNotionals[rank] >= localBidBaseline * 2.8;
      if (bidIsWall && unit.bidSize > 0) {
        const currentSize = current.bids.get(unit.bidPrice) || 0;
        const pushedOutside = currentSize === 0 &&
          Number.isFinite(worstVisibleBid) && worstVisibleBid > unit.bidPrice;
        if (!pushedOutside) {
          const activeSell = volumeAtPrice(
            tradeIndex,
            "ASK",
            unit.bidPrice,
            previous.timestamp,
            current.timestamp,
            tick,
          );
          const reduction = Math.max(0, unit.bidSize - currentSize);
          const unexplained = Math.max(0, reduction - activeSell);
          const unexplainedRatio = safeDiv(unexplained, unit.bidSize);
          const executionRatio = safeDiv(activeSell, unit.bidSize);
          if (unexplainedRatio >= 0.55 && executionRatio <= 0.2) {
            spoofScore = Math.max(
              spoofScore,
              clamp(unexplainedRatio * 0.8 + (1 - executionRatio) * 0.2, 0, 1),
            );
          }
          if (
            current.bestAsk <= unit.bidPrice && executionRatio >= 0.35 &&
            currentSize === 0
          ) {
            breakdownScore = Math.max(
              breakdownScore,
              clamp(executionRatio * 0.65 + 0.35, 0, 1),
            );
          }
        }
      }

      const askIsWall = previousAskNotionals[rank] >= localAskBaseline * 2.8;
      if (askIsWall && unit.askSize > 0) {
        const activeBuy = volumeAtPrice(
          tradeIndex,
          "BID",
          unit.askPrice,
          previous.timestamp,
          current.timestamp,
          tick,
        );
        if (activeBuy > 0) {
          const currentSize = current.asks.get(unit.askPrice) || 0;
          const expectedRemaining = Math.max(0, unit.askSize - activeBuy);
          const replenished = Math.max(0, currentSize - expectedRemaining);
          const buyRatio = safeDiv(activeBuy, unit.askSize);
          const refillRatio = safeDiv(replenished, activeBuy);
          if (buyRatio >= 0.12 && refillRatio >= 0.45) {
            absorptionEvents++;
            absorptionMax = Math.max(
              absorptionMax,
              clamp(buyRatio * 0.45 + refillRatio * 0.55, 0, 1),
            );
          }
        }
      }
    });
  }

  const absorptionScore = clamp(
    absorptionMax * 0.7 + Math.min(1, absorptionEvents / 3) * 0.3,
    0,
    1,
  );
  let breakoutScore = 0;
  let confirmedSupport: number | null = null;
  for (const wall of askCandidates) {
    const crossedIndex = frames.findIndex((frame, index) =>
      index > wall.firstIndex && frame.bestBid >= wall.price &&
      !frame.asks.has(wall.price)
    );
    if (crossedIndex < 0) continue;
    const activeBuy = volumeAtPrice(
      tradeIndex,
      "BID",
      wall.price,
      frames[wall.firstIndex].timestamp - 1,
      frames[crossedIndex].timestamp + 250,
      tick,
    );
    const postFrames = frames.slice(crossedIndex);
    const bidSupportFrames = postFrames.filter((frame) =>
      frame.bids.has(wall.price)
    );
    const supportRatio = safeDiv(bidSupportFrames.length, postFrames.length);
    const postSell = volumeAtPrice(
      tradeIndex,
      "ASK",
      wall.price,
      frames[crossedIndex].timestamp - 1,
      end + 250,
      tick,
    );
    const executionCoverage = safeDiv(activeBuy, wall.maxSize);
    // v2.3.2: 돌파 확정은 (1) 매도벽 실체결 소진, (2) 저항→지지 전환 유지,
    // (3) 전환 가격에서 후속 시장가 매도를 실제로 흡수한 세 단계가 모두 필요하다.
    // 단순 가중합만 쓰면 앞의 두 항만으로 0.65를 넘을 수 있으므로 최소조건도 건다.
    const absorbedSellRatio = clamp(safeDiv(postSell, wall.maxSize), 0, 1);
    const defenseCoverage = clamp(absorbedSellRatio / 0.25, 0, 1);
    const rawScore = clamp(
      Math.min(1, executionCoverage) * 0.45 + supportRatio * 0.3 +
        defenseCoverage * 0.25,
      0,
      1,
    );
    const sequenceConfirmed = executionCoverage >= 0.7 &&
      supportRatio >= 0.4 && absorbedSellRatio >= 0.08;
    const score = sequenceConfirmed ? rawScore : Math.min(rawScore, 0.64);
    if (sequenceConfirmed && score > breakoutScore) {
      breakoutScore = score;
      confirmedSupport = wall.price;
    }
  }

  const lastMid = (frames.at(-1)!.bestBid + frames.at(-1)!.bestAsk) / 2;
  const persistentBid =
    bidCandidates.filter((stat) =>
      stat.price < lastMid && wallPersistence(stat) >= 0.45 &&
      wallDuration(stat, frames) >= 3_000
    ).sort((left, right) => right.price - left.price)[0] || null;
  const persistentAsk =
    askCandidates.filter((stat) =>
      stat.price > lastMid && wallPersistence(stat) >= 0.45 &&
      wallDuration(stat, frames) >= 3_000
    ).sort((left, right) => left.price - right.price)[0] || null;

  let status: DynamicOrderflowStatus = "NEUTRAL";
  if (!sufficient) status = "INSUFFICIENT";
  else if (breakdownScore >= 0.65) status = "SUPPORT_BREAKDOWN_RISK";
  else if (spoofScore >= 0.65) status = "SPOOF_LIKE_RISK";
  else if (absorptionScore >= 0.65) status = "ASK_ABSORPTION_RISK";
  else if (breakoutScore >= 0.65) status = "BREAKOUT_CONFIRMED";

  const evidence = [
    `실시간 ${
      (observationMs / 1000).toFixed(1)
    }초 동안 서로 다른 호가 ${frames.length}회와 동시간대 체결 ${alignedTrades.length}건을 교차검증했습니다.`,
    `초반·중반·확인 구간 표본은 호가 ${phaseBookUpdates.join("/")}회, 체결 ${
      phaseTradeCounts.join("/")
    }건이며 ${coveredPhases}/3개 구간이 유효했습니다.`,
  ];
  const warnings: string[] = [];
  if (persistentBid) {
    evidence.push(
      `${
        displayPrice(persistentBid.price)
      } 가격대의 인접 매수벽이 관찰창에서 반복 유지됐습니다.`,
    );
  }
  if (persistentAsk) {
    evidence.push(
      `${
        displayPrice(persistentAsk.price)
      } 가격대의 인접 매도벽이 관찰창에서 반복 유지됐습니다.`,
    );
  }
  if (status === "BREAKOUT_CONFIRMED" && confirmedSupport) {
    evidence.push(
      `${
        displayPrice(confirmedSupport)
      } 가격대 매도벽의 실체결 소진과 이후 매수 지지 전환을 확인했습니다.`,
    );
  }
  if (spoofScore >= 0.65) {
    warnings.push(
      "대형 매수벽 감소분이 같은 가격의 매도 체결량으로 충분히 설명되지 않아 비체결성 취소가 의심됩니다.",
    );
  }
  if (absorptionScore >= 0.65) {
    warnings.push(
      "대형 매도벽에 매수 체결이 유입됐지만 잔량이 반복 보충돼 상단 매도 흡수 위험이 있습니다.",
    );
  }
  if (breakdownScore >= 0.65) {
    warnings.push(
      "대형 매수벽이 매도 체결로 소진된 뒤 가격이 해당 지지 아래로 전환됐습니다.",
    );
  }
  if (!sufficient) warnings.push(...empty.warnings);

  return {
    status,
    label: dynamicLabel(status),
    sufficient,
    observation_ms: observationMs,
    distinct_book_updates: frames.length,
    aligned_trade_count: alignedTrades.length,
    covered_phases: coveredPhases,
    phase_book_updates: phaseBookUpdates,
    phase_trade_counts: phaseTradeCounts,
    phase_consistent: phaseConsistent,
    data_quality: dataQuality,
    spoof_like_score: spoofScore,
    ask_absorption_score: absorptionScore,
    breakout_score: breakoutScore,
    persistent_bid_wall_price: persistentBid?.price || null,
    persistent_ask_wall_price: persistentAsk?.price || null,
    confirmed_support_price: confirmedSupport,
    target_cap_price: persistentAsk?.price || null,
    evidence: [...new Set(evidence)],
    warnings: [...new Set(warnings)],
  };
}

export function computeMicrostructure(
  snapshots: OrderbookSnapshot[],
  trades: TradeRow[],
  currentMs = Date.now(),
  tickSize = Number.EPSILON,
): Microstructure {
  const frames = distinctBookFrames(snapshots);
  const imbalances: number[] = [];
  const spreads: number[] = [];
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const frame of frames) {
    const units = frame.units;
    if (!units.length) continue;
    let bid = 0;
    let ask = 0;
    units.forEach((unit, index) => {
      const weight = 1 / Math.pow(index + 1, 0.72);
      bid += unit.bidPrice * unit.bidSize * weight;
      ask += unit.askPrice * unit.askSize * weight;
    });
    imbalances.push(safeDiv(bid - ask, bid + ask));
    const first = units[0];
    const bidPrice = first.bidPrice;
    const askPrice = first.askPrice;
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
  const recentTrades = distinctTrades(trades).filter((trade) => {
    const timestamp = tradeTimestamp(trade);
    return currentMs - timestamp <= 10 * 60 * 1000 &&
      timestamp <= currentMs + 60_000;
  });
  for (const trade of recentTrades) {
    const timestamp = tradeTimestamp(trade) || currentMs;
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
  const dynamic = computeDynamicOrderflow(snapshots, trades, tickSize);
  const dynamicAdjustment = dynamic.status === "BREAKOUT_CONFIRMED"
    ? 16
    : dynamic.status === "SPOOF_LIKE_RISK" ||
        dynamic.status === "ASK_ABSORPTION_RISK"
    ? -24
    : dynamic.status === "SUPPORT_BREAKDOWN_RISK"
    ? -32
    : dynamic.status === "INSUFFICIENT"
    ? -12
    : 0;
  const rawMicroScore = clamp(
    50 + pressure * 18 + (stability - 0.5) * 2 + dynamicAdjustment -
      spreadPenalty,
    0,
    100,
  );
  const microScore = dynamic.sufficient ? rawMicroScore : Math.min(42, rawMicroScore);
  const latestFrame = frames.at(-1) || null;
  const referencePrice = latestFrame
    ? (latestFrame.bestBid + latestFrame.bestAsk) / 2
    : null;
  const referenceTimestamp = latestFrame?.timestamp || null;
  const liveBookAgeMs = referenceTimestamp == null
    ? null
    : Math.max(0, currentMs - referenceTimestamp);

  return {
    samples: frames.length,
    best_bid: bestBid,
    best_ask: bestAsk,
    reference_price: referencePrice,
    reference_timestamp: referenceTimestamp,
    live_book_age_ms: liveBookAgeMs,
    latest_bids: latestFrame
      ? latestFrame.units.map((unit) => ({ price: unit.bidPrice, size: unit.bidSize }))
      : [],
    latest_asks: latestFrame
      ? latestFrame.units.map((unit) => ({ price: unit.askPrice, size: unit.askSize }))
      : [],
    spread_bps: spreadBps,
    book_imbalance: bookImbalance,
    imbalance_stability: stability,
    trade_pressure: pressure,
    trade_count: tradeCount,
    buy_notional: buyNotional,
    sell_notional: sellNotional,
    micro_score: microScore,
    dynamic,
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

function quotePriceText(value: number, quote: "KRW" | "USDT"): string {
  const digits = quote === "KRW"
    ? value >= 1000 ? 0 : value >= 1 ? 3 : 8
    : value >= 1000
    ? 2
    : value >= 1
    ? 4
    : 8;
  return `${value.toLocaleString("ko-KR", { maximumFractionDigits: digits })}${
    quote === "KRW" ? "원" : " USDT"
  }`;
}

function visibleDepthQuote(
  levels: Array<{ price: number; size: number }>,
): number {
  return levels.reduce((sum, level) =>
    sum + Math.max(0, level.price) * Math.max(0, level.size), 0);
}

function estimateBuySlippageBps(
  asks: Array<{ price: number; size: number }>,
  quoteNotional: number,
): number | null {
  if (!(quoteNotional > 0) || !asks.length) return null;
  const ordered = [...asks].filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  if (!ordered.length) return null;
  let remaining = quoteNotional;
  let baseFilled = 0;
  let quoteSpent = 0;
  for (const level of ordered) {
    const levelQuote = level.price * level.size;
    const takeQuote = Math.min(remaining, levelQuote);
    baseFilled += takeQuote / level.price;
    quoteSpent += takeQuote;
    remaining -= takeQuote;
    if (remaining <= 1e-9) break;
  }
  if (remaining > Math.max(0.01, quoteNotional * 0.001) || baseFilled <= 0) {
    return null;
  }
  const vwap = quoteSpent / baseFilled;
  return Math.max(0, (vwap / ordered[0].price - 1) * 10_000);
}

export function buildTradePlan(
  period: PeriodAnalysis,
  micro: Microstructure,
  tickSize: number,
  risk: RiskConfig,
  hypotheticalReference?: number,
): TradePlan {
  const tickerPrice = period.universe.current_price;
  const liveReference = micro.reference_price && micro.reference_price > 0
    ? micro.reference_price
    : null;
  const referencePrice = hypotheticalReference && hypotheticalReference > 0
    ? hypotheticalReference
    : liveReference || tickerPrice;
  const referenceSource: TradePlan["reference_source"] = hypotheticalReference
    ? "HYPOTHETICAL_PULLBACK"
    : liveReference
    ? "LIVE_ORDERBOOK"
    : "TICKER_FALLBACK";
  const tick = tickSize > 0
    ? tickSize
    : Math.max(referencePrice * 0.0001, Number.EPSILON);
  const atr15 = period.timeframes.m15.atr14 || referencePrice * 0.012;
  const atr4h = period.timeframes.h4.atr14 || atr15 * 3;
  const atrDay = period.timeframes.day.atr14 || atr4h * 2;
  const bestBid = micro.best_bid || referencePrice;
  const bestAsk = micro.best_ask || referencePrice;
  const entryHighRaw = hypotheticalReference
    ? referencePrice
    : Math.max(referencePrice, bestAsk);
  const entryHigh = roundToTick(entryHighRaw, tick, "up");
  const entryLow = roundToTick(
    hypotheticalReference
      ? Math.max(tick, referencePrice - atr15 * 0.18)
      : Math.max(bestBid, referencePrice - atr15 * 0.22),
    tick,
    "down",
  );
  const entryExecution = entryHigh + tick * risk.entrySlippageTicks;

  const safeDynamic = micro.dynamic.sufficient && [
    "NEUTRAL",
    "BREAKOUT_CONFIRMED",
  ].includes(micro.dynamic.status);
  const supportCandidates = [
    [period.timeframes.m15.ema21, "15분 EMA21"],
    [period.timeframes.m15.ema50, "15분 EMA50"],
    [period.timeframes.m15.support, "15분 최근 지지"],
    [period.timeframes.h4.ema9, "4시간 EMA9"],
    [period.timeframes.h4.support, "4시간 최근 지지"],
    [safeDynamic ? micro.dynamic.confirmed_support_price : null, "실시간 돌파 후 지지"],
    [safeDynamic ? micro.dynamic.persistent_bid_wall_price : null, "실시간 반복 매수벽"],
  ] as Array<[number | null, string]>;
  const supportFloorGap = Math.max(tick * 2, atr15 * 0.04);
  const validSupports = supportCandidates
    .filter((item): item is [number, string] =>
      item[0] != null && item[0] > 0 && item[0] < entryExecution - supportFloorGap
    )
    .sort((left, right) => right[0] - left[0]);
  const structuralSupport = validSupports[0]?.[0] || null;
  const supportBasis = validSupports[0]?.[1] || "구조적 지지 미확인";
  const stopAtrMult = risk.stopAtrMult ?? ACTIVE_CALIBRATION_PROFILE.parameters.stopAtrMult;
  const spreadPrice = bestAsk > bestBid ? bestAsk - bestBid : 0;
  // v2.6.0: stop buffer must survive normal noise, visible spread and tick granularity.
  const stopBuffer = Math.max(atr15 * 0.35, spreadPrice * 3, tick * 2);
  const fallbackStop = entryExecution - atr15 * stopAtrMult;
  const stopRaw = structuralSupport != null
    ? structuralSupport - stopBuffer
    : fallbackStop;
  const stopPrice = roundToTick(Math.max(tick, stopRaw), tick, "down");
  const stopExecution = Math.max(
    tick,
    stopPrice - tick * risk.exitSlippageTicks,
  );
  const stopDistanceAtr = atr15 > 0
    ? (entryExecution - stopExecution) / atr15
    : null;

  const targetCandidates = [
    [period.timeframes.m15.resistance, "15분 최근 저항"],
    [period.timeframes.h4.resistance, "4시간 최근 저항"],
    [period.timeframes.day.resistance, "일봉 최근 저항"],
    [period.timeframes.day.recent_high, "일봉 최근 고점"],
    [safeDynamic ? micro.dynamic.target_cap_price : null, "실시간 반복 매도벽"],
  ] as Array<[number | null, string]>;
  const validTargets = targetCandidates
    .filter((item): item is [number, string] =>
      item[0] != null && item[0] > entryExecution
    )
    .sort((left, right) => left[0] - right[0]);
  const structuralResistance = validTargets[0]?.[0] || null;
  const targetBasis = validTargets[0]?.[1] || "구조적 저항 미확인";
  const shortTargetAtrMult = risk.shortTargetAtrMult ??
    ACTIVE_CALIBRATION_PROFILE.parameters.shortTargetAtrMult;
  const atrShortCap = entryExecution + atr15 * shortTargetAtrMult;
  const targetBuffer = Math.max(tick * 2, atr15 * 0.04);
  const shortRaw = structuralResistance != null
    ? Math.min(structuralResistance - targetBuffer, atrShortCap)
    : atrShortCap;
  const shortTarget = roundToTick(shortRaw, tick, "down");
  const shortExecution = Math.max(tick, shortTarget - tick * risk.exitSlippageTicks);
  const targetDistanceAtr = atr15 > 0
    ? (shortExecution - entryExecution) / atr15
    : null;

  const mediumResistances = [
    period.timeframes.h4.resistance,
    period.timeframes.day.resistance,
    period.timeframes.day.recent_high,
  ].filter((value): value is number => value != null && value > shortTarget + tick * 3)
    .sort((a, b) => a - b);
  const nearestMediumResistance = mediumResistances[0] || null;
  const volatilityMediumTarget = entryExecution + Math.min(
    atr4h * (risk.mediumTargetAtr4hMult ??
      ACTIVE_CALIBRATION_PROFILE.parameters.mediumTargetAtr4hMult),
    atrDay * (risk.mediumTargetAtrDayMult ??
      ACTIVE_CALIBRATION_PROFILE.parameters.mediumTargetAtrDayMult),
  );
  const minimumMediumTarget = shortTarget + Math.max(atr15 * 0.8, tick * 3);
  const mediumRaw = nearestMediumResistance
    ? Math.min(nearestMediumResistance - targetBuffer, Math.max(volatilityMediumTarget, minimumMediumTarget))
    : Math.max(volatilityMediumTarget, minimumMediumTarget);
  const mediumTarget = roundToTick(mediumRaw, tick, "down");
  const mediumExecution = Math.max(
    tick,
    mediumTarget - tick * risk.exitSlippageTicks,
  );

  const shortGain = shortExecution > entryExecution
    ? netGainPct(entryExecution, shortExecution, risk.feePerSidePct)
    : 0;
  const mediumGain = mediumExecution > entryExecution
    ? netGainPct(entryExecution, mediumExecution, risk.feePerSidePct)
    : 0;
  const stopLoss = stopExecution < entryExecution
    ? netLossPct(entryExecution, stopExecution, risk.feePerSidePct)
    : 0;
  const shortRR = stopLoss > 0 && shortGain > 0 ? shortGain / stopLoss : 0;
  const mediumRR = stopLoss > 0 && mediumGain > 0 ? mediumGain / stopLoss : 0;

  // A nearby 15m resistance must not automatically invalidate a genuinely strong
  // 4h/day swing. The alternative is an explicit scale-out plan: realise 60% at
  // the first resistance and keep 40% for the higher-timeframe target.
  const strongSwingContext =
    ["FULL_BULL", "BULL_PULLBACK"].includes(period.timeframes.h4.trend_state) &&
    ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(
      period.timeframes.day.trend_state,
    ) &&
    period.timeframes.h4.trend_signal > 0.35 &&
    period.timeframes.day.trend_signal > 0.05 &&
    Math.max(
      period.timeframes.m15.overheat_score,
      period.timeframes.h4.overheat_score,
      period.timeframes.day.overheat_score,
    ) <= 0.48;
  const firstTargetAllocation = 0.6;
  const continuationAllocation = 1 - firstTargetAllocation;
  const blendedExit = shortExecution * firstTargetAllocation +
    mediumExecution * continuationAllocation;
  const blendedGain = blendedExit > entryExecution
    ? netGainPct(entryExecution, blendedExit, risk.feePerSidePct)
    : 0;
  const blendedRR = stopLoss > 0 && blendedGain > 0
    ? blendedGain / stopLoss
    : 0;
  const useScaleOut = strongSwingContext &&
    mediumExecution > shortExecution + Math.max(atr15 * 0.65, tick * 4) &&
    shortRR >= 0.65 && blendedRR > shortRR;
  const targetStrategy: TargetStrategy = useScaleOut
    ? "SCALE_OUT"
    : "SHORT_ONLY";
  const expectedExit = useScaleOut ? blendedExit : shortExecution;
  const expectedGain = useScaleOut ? blendedGain : shortGain;
  const rr = useScaleOut ? blendedRR : shortRR;
  const riskBudget = risk.capitalKrw * (risk.riskPct / 100);
  const investment = stopLoss > 0
    ? Math.min(risk.capitalKrw, riskBudget / (stopLoss / 100))
    : 0;
  const roundedInvestment = risk.quoteCurrency === "USDT"
    ? Math.max(0, Math.floor(investment * 100) / 100)
    : Math.max(0, Math.floor(investment / 1000) * 1000);
  const roundedRiskBudget = risk.quoteCurrency === "USDT"
    ? Number(riskBudget.toFixed(2))
    : Math.round(riskBudget);
  const estimatedLoss = risk.quoteCurrency === "USDT"
    ? Number((roundedInvestment * stopLoss / 100).toFixed(2))
    : Math.round(roundedInvestment * stopLoss / 100);
  const visibleAskDepth = visibleDepthQuote(micro.latest_asks || []);
  const visibleBidDepth = visibleDepthQuote(micro.latest_bids || []);
  const depthNotional = Math.max(roundedInvestment, risk.capitalKrw * 0.1);
  const depthCoverage = depthNotional > 0
    ? Math.min(visibleAskDepth, visibleBidDepth) / depthNotional
    : 0;
  const estimatedEntrySlippageBps = estimateBuySlippageBps(
    micro.latest_asks || [],
    depthNotional,
  );

  return {
    reference_price: referencePrice,
    reference_source: referenceSource,
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_execution_estimate: entryExecution,
    structural_support: structuralSupport,
    support_basis: supportBasis,
    structural_resistance: structuralResistance,
    target_basis: targetBasis,
    structure_complete: structuralSupport != null && structuralResistance != null,
    stop_distance_atr: stopDistanceAtr,
    target_distance_atr: targetDistanceAtr,
    visible_ask_depth_quote: visibleAskDepth,
    visible_bid_depth_quote: visibleBidDepth,
    depth_coverage_ratio: depthCoverage,
    estimated_entry_slippage_bps: estimatedEntrySlippageBps,
    short_target: shortTarget,
    short_target_execution_estimate: shortExecution,
    medium_target: mediumTarget,
    medium_target_execution_estimate: mediumExecution,
    target_strategy: targetStrategy,
    target_strategy_label: targetStrategy === "SCALE_OUT"
      ? "1차 60% 청산 후 2차 40% 추세추종"
      : "단기 목표 일괄청산",
    first_target_allocation_pct: targetStrategy === "SCALE_OUT" ? 60 : 100,
    continuation_allocation_pct: targetStrategy === "SCALE_OUT" ? 40 : 0,
    expected_exit_price: expectedExit,
    expected_exit_net_return_pct: expectedGain,
    stop_price: stopPrice,
    stop_execution_estimate: stopExecution,
    short_net_return_pct: shortGain,
    medium_net_return_pct: mediumGain,
    short_net_rr: shortRR,
    medium_net_rr: mediumRR,
    blended_net_return_pct: blendedGain,
    blended_net_rr: blendedRR,
    net_stop_pct: stopLoss,
    net_rr: rr,
    recommended_investment_krw: roundedInvestment,
    recommended_investment_quote: roundedInvestment,
    risk_budget_krw: roundedRiskBudget,
    estimated_loss_krw: estimatedLoss,
    tick_size: tick,
    actionable: false,
  };
}

function unavailableWatchEntry(note: string): WatchEntryPlan {
  return {
    available: false,
    status: "UNAVAILABLE",
    zone_low: null,
    zone_high: null,
    max_price: null,
    invalidation_price: null,
    reference_target: null,
    expected_exit_price: null,
    expected_net_return_pct: null,
    stop_price: null,
    estimated_net_rr: null,
    discount_from_current_pct: null,
    label: "대기 매수가 미제시",
    entry_trigger: "안전조건이 회복된 뒤 다시 계산해야 합니다.",
    exit_trigger: "진입 시나리오가 없어 예상 매도 시점도 제시하지 않습니다.",
    scenario: [],
    conditions: [],
    note,
  };
}

export function buildWatchEntryPlan(
  period: PeriodAnalysis,
  micro: Microstructure,
  _tradePlan: TradePlan,
  tickSize: number,
  risk: RiskConfig,
  score: number,
  checks: Gate[],
  decision: FinalCandidate["decision"],
): WatchEntryPlan {
  if (decision !== "WAIT") {
    return unavailableWatchEntry(
      decision === "BUY"
        ? "현재 매수 후보는 실행용 매수 구간을 사용합니다."
        : "매수 제외 종목에는 대기 매수가를 제시하지 않습니다.",
    );
  }

  const hardFailureKeys = new Set([
    "data",
    "market_event",
    "trend_15m",
    "trend_4h",
    "trend_context",
  ]);
  const explicitDynamicRisk = [
    "SPOOF_LIKE_RISK",
    "ASK_ABSORPTION_RISK",
    "SUPPORT_BREAKDOWN_RISK",
  ].includes(micro.dynamic.status);
  const hardFailures = checks.filter((item) =>
    !item.passed && hardFailureKeys.has(item.key)
  );
  if (hardFailures.length || explicitDynamicRisk) {
    return unavailableWatchEntry(
      explicitDynamicRisk
        ? `현재 동적 호가에서 ${micro.dynamic.label}가 탐지돼 가격 할인만으로는 대기 매수를 만들 수 없습니다.`
        : `가격만 낮아져도 해결되지 않는 조건이 남아 있습니다: ${hardFailures.map((item) => item.label).join(", ")}`,
    );
  }
  if (score < 52) {
    return unavailableWatchEntry(
      "종합점수가 52점 미만이라 가격 조정만으로는 관찰 매수 후보가 되기 어렵습니다.",
    );
  }

  const current = micro.reference_price || period.universe.current_price;
  const tick = tickSize > 0
    ? tickSize
    : Math.max(current * 0.0001, Number.EPSILON);
  const atr15 = period.timeframes.m15.atr14 || current * 0.012;
  const tf = period.timeframes;
  const anchors = [
    tf.m15.ema21,
    tf.m15.ema50,
    tf.m15.support,
    tf.h4.ema9,
    tf.h4.support,
    micro.dynamic.sufficient ? micro.dynamic.confirmed_support_price : null,
    micro.dynamic.sufficient ? micro.dynamic.persistent_bid_wall_price : null,
  ].filter((value): value is number => value != null && value > 0 && value < current);
  if (!anchors.length) {
    return unavailableWatchEntry(
      "현재가 아래에서 사용할 수 있는 15분·4시간·실시간 지지 가격대가 없습니다.",
    );
  }

  const center = Math.max(...anchors);
  let zoneLow = roundToTick(Math.max(tick, center - atr15 * 0.22), tick, "up");
  let zoneHigh = roundToTick(Math.min(current - tick, center + atr15 * 0.12), tick, "down");
  if (zoneHigh < zoneLow) {
    const fallback = roundToTick(center, tick, "nearest");
    if (fallback >= current || fallback <= tick) {
      return unavailableWatchEntry(
        "지지 가격대가 현재가와 너무 가까워 안전한 대기 구간을 만들 수 없습니다.",
      );
    }
    zoneLow = fallback;
    zoneHigh = fallback;
  }

  // 핵심 수정: 현재가용 목표·손절을 재사용하지 않고, 눌림 진입가를 기준으로
  // 과거 지지·저항과 최신 호가벽을 다시 결합해 별도 계획을 계산한다.
  const hypotheticalPlan = buildTradePlan(
    period,
    micro,
    tick,
    risk,
    zoneHigh,
  );
  if (
    !hypotheticalPlan.structure_complete ||
    hypotheticalPlan.short_target_execution_estimate <= hypotheticalPlan.entry_execution_estimate ||
    hypotheticalPlan.stop_execution_estimate >= hypotheticalPlan.entry_execution_estimate ||
    hypotheticalPlan.net_rr < risk.minNetRR ||
    hypotheticalPlan.net_stop_pct > risk.maxStopPct
  ) {
    return unavailableWatchEntry(
      `눌림 가격에서 지지·저항을 다시 계산해도 비용 포함 손익비 ${risk.minNetRR} 또는 최대 손절폭 ${risk.maxStopPct}% 조건을 충족하지 못합니다.`,
    );
  }

  const quote = risk.quoteCurrency || period.universe.quote_currency || "KRW";
  const entryZoneText = `${quotePriceText(zoneLow, quote)}~${quotePriceText(zoneHigh, quote)}`;
  const exitText = quotePriceText(hypotheticalPlan.expected_exit_price, quote);
  const stopText = quotePriceText(hypotheticalPlan.stop_price, quote);
  const ema21Text = tf.m15.ema21
    ? quotePriceText(roundToTick(tf.m15.ema21, tick, "nearest"), quote)
    : "15분 EMA21";
  const transientFailures = checks.filter((item) => !item.passed)
    .filter((item) => !hardFailureKeys.has(item.key));
  const requiresRecheck = transientFailures.length > 0 || !micro.dynamic.sufficient;
  const entryTrigger =
    `${entryZoneText} 도달 후 15분봉이 ${ema21Text} 위로 회복하고, 최신 호가·체결 강제조건을 다시 통과할 때만 진입 검토`;
  const exitTrigger =
    `진입 후 ${exitText} 부근 지정가 분할매도, 도달 전 ${stopText} 이탈 또는 15분 추세 하락 전환 시 조기 종료`;

  return {
    available: true,
    status: requiresRecheck ? "RECHECK_REQUIRED" : "CONDITIONAL",
    zone_low: zoneLow,
    zone_high: zoneHigh,
    max_price: zoneHigh,
    invalidation_price: hypotheticalPlan.stop_price,
    reference_target: hypotheticalPlan.short_target,
    expected_exit_price: hypotheticalPlan.expected_exit_price,
    expected_net_return_pct: hypotheticalPlan.expected_exit_net_return_pct,
    stop_price: hypotheticalPlan.stop_price,
    estimated_net_rr: hypotheticalPlan.net_rr,
    discount_from_current_pct: Math.max(0, ((current - zoneHigh) / current) * 100),
    label: requiresRecheck ? "눌림 도달 후 재스캔 필수" : "눌림 도달 후 조건부 진입",
    entry_trigger: entryTrigger,
    exit_trigger: exitTrigger,
    scenario: [
      `대기: 현재가에서 추격하지 않고 ${entryZoneText}까지 눌림을 기다립니다.`,
      `진입: ${entryTrigger}.`,
      `매도: ${exitTrigger}.`,
      `무효화: 진입 전후 ${stopText} 이탈 시 이 시나리오를 폐기합니다.`,
    ],
    conditions: [
      `가격 도달 후 15분봉 종가가 ${ema21Text} 위로 회복·유지`,
      "동적 호가 표본 45초·호가 25회·체결 20건·3/3구간 재충족",
      "동적 판정이 특이 위험 없음 또는 돌파 후 지지 전환 확인",
      "체결 압력 -0.20 초과, 정적 호가 불균형 -0.40 초과",
      `재계산된 비용 포함 손익비 ${risk.minNetRR} 이상 유지`,
      ...transientFailures.map((item) => `${item.label} 재통과: ${item.detail}`),
      `${stopText} 이탈 시 대기 계획 취소`,
    ],
    note:
      "이 가격대는 자동 주문 지시가 아닙니다. 가격 도달 후 15분봉 마감과 최신 호가·체결로 목표·손절·손익비를 다시 계산해야 합니다.",
  };
}

export function estimateHorizon(
  period: PeriodAnalysis,
  stopPrice: number,
): TrendHorizon {
  const quote = period.universe.quote_currency || "KRW";
  const tf = period.timeframes;
  let code: TrendHorizon["code"] = "INTRADAY";
  let label = "장중 단기 관찰 후보";
  let window = "1~12시간";
  const longDataReady = tf.day.bars >= 200 && tf.h4.bars >= 150;
  const lowOverheat = Math.max(
    tf.m15.overheat_score,
    tf.h4.overheat_score,
    tf.day.overheat_score,
  ) <= 0.45;
  if (
    longDataReady && lowOverheat &&
    tf.day.trend_state === "FULL_BULL" &&
    ["FULL_BULL", "BULL_PULLBACK"].includes(tf.h4.trend_state) &&
    ["FULL_BULL", "BULL_PULLBACK"].includes(tf.m15.trend_state)
  ) {
    code = "LONG";
    label = "중기 추세 관찰 후보";
    window = "5~20일";
  } else if (
    lowOverheat &&
    ["FULL_BULL", "BULL_PULLBACK"].includes(tf.h4.trend_state) &&
    tf.day.trend_state !== "BEAR" &&
    ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(tf.m15.trend_state)
  ) {
    code = "MEDIUM";
    label = "단기·중기 관찰 후보";
    window = "2~10일";
  } else if (
    ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(tf.m15.trend_state) &&
    tf.h4.trend_state !== "BEAR"
  ) {
    code = "SHORT";
    label = "단기 관찰 후보";
    window = "6~48시간";
  }
  const alignment = [tf.m5, tf.m15, tf.h4, tf.day]
    .map((metric) => metric.trend_state === "FULL_BULL"
      ? 1
      : metric.trend_state === "BULL_PULLBACK"
      ? 0.8
      : metric.trend_state === "RECOVERY"
      ? 0.55
      : metric.trend_state === "MIXED"
      ? 0.3
      : 0)
    .reduce((sum, value) => sum + value, 0) / 4;
  const persistence = clamp(
    28 + alignment * 42 + Math.max(0, period.momentum_signal) * 8 -
      Math.max(tf.m15.overheat_score, tf.h4.overheat_score, tf.day.overheat_score) * 18,
    18,
    longDataReady ? 82 : 74,
  );
  const estimate =
    `${label}로 분류되며 ${window} 범위만 보수적으로 관찰합니다. 장기 보유 분류는 일봉 200개 이상과 4시간봉 150개 이상이 확보되고 과열이 낮을 때만 허용합니다.`;
  const invalidation = [
    `${quotePriceText(stopPrice, quote)} 이탈`,
    tf.m15.ema21
      ? `15분봉 종가가 EMA21(${quotePriceText(tf.m15.ema21, quote)}) 아래에서 연속 마감`
      : "15분 추세가 하락 정렬로 전환",
    "4시간 구조가 혼조·하락으로 전환하거나 거래대금이 급감",
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

export function estimatePriceForecast(
  period: PeriodAnalysis,
  micro: Microstructure,
  plan: TradePlan,
  watch: WatchEntryPlan,
  horizon: TrendHorizon,
  score: number,
  decision: FinalCandidate["decision"],
): PriceForecast {
  const bucket = calibrationBucket(score);
  const calibrated = ACTIVE_CALIBRATION_PROFILE.promoted &&
    ACTIVE_CALIBRATION_PROFILE.source === "WALK_FORWARD" && bucket.samples >= 20;
  const entry = decision === "WAIT" && watch.available
    ? Number(watch.zone_high)
    : plan.entry_execution_estimate;
  const shortExit = decision === "WAIT" && watch.available
    ? Number(watch.expected_exit_price || watch.reference_target)
    : plan.short_target_execution_estimate;
  const mediumExit = decision === "WAIT" && watch.available
    ? shortExit
    : plan.medium_target_execution_estimate;
  const expectedPlanExit = decision === "WAIT" && watch.available
    ? shortExit
    : plan.expected_exit_price;
  const gross = (exit: number) =>
    entry > 0 && exit > entry ? (exit / entry - 1) * 100 : 0;
  const shortGross = gross(shortExit);
  const mediumGross = gross(mediumExit);
  const planGross = gross(expectedPlanExit);
  const tf = period.timeframes;
  const trendQuality = clamp(
    0.5 + period.trend_signal * 0.28 + period.momentum_signal * 0.16,
    0.2,
    0.9,
  );
  const microQuality = micro.dynamic.sufficient
    ? clamp(0.55 + micro.dynamic.data_quality * 0.35 + micro.trade_pressure * 0.1, 0.35, 0.95)
    : 0.42;
  const overheat = Math.max(
    tf.m15.overheat_score,
    tf.h4.overheat_score,
    tf.day.overheat_score,
  );
  const decisionPenalty = decision === "BUY" ? 0 : decision === "WAIT" ? 0.07 : 0.18;
  const measuredBase = bucket.targetHitRate;
  const probability = clamp(
    measuredBase + (trendQuality - 0.5) * 0.22 +
      (microQuality - 0.5) * 0.14 - overheat * 0.18 - decisionPenalty,
    0.12,
    0.82,
  );
  const rawExpected = clamp(
    planGross * 0.72 + shortGross * 0.18 + mediumGross * 0.10 +
      Math.max(0, Number(tf.h4.atr_pct || 0)) * Math.max(0, period.trend_signal) * 0.35,
    0,
    Math.max(shortGross, mediumGross),
  );
  const calibrationScale = clamp(bucket.returnScale, 0.35, 1.25);
  const calibrationScaleLow = clamp(bucket.returnScaleLow, 0.2, calibrationScale);
  const calibrationScaleHigh = clamp(bucket.returnScaleHigh, calibrationScale, 1.6);
  const qualityShrink = clamp(0.62 + trendQuality * 0.22 + microQuality * 0.16 - overheat * 0.18, 0.4, 1);
  const forecastCap = Math.max(shortGross, mediumGross);
  const expectedUpside = clamp(
    rawExpected * calibrationScale * qualityShrink,
    0,
    forecastCap,
  );
  const conservativeUpside = clamp(
    rawExpected * calibrationScaleLow * qualityShrink * 0.95,
    0,
    expectedUpside,
  );
  const optimisticUpside = clamp(
    rawExpected * calibrationScaleHigh * qualityShrink * 1.05,
    expectedUpside,
    forecastCap,
  );
  const expectedPrice = entry * (1 + expectedUpside / 100);
  const conservativePrice = entry * (1 + conservativeUpside / 100);
  const optimisticPrice = entry * (1 + optimisticUpside / 100);
  const expectedPlanNet = decision === "WAIT" && watch.available
    ? Number(watch.expected_net_return_pct || 0)
    : Number(plan.expected_exit_net_return_pct || 0);
  const estimatedRoundTripCostPct = Math.max(0, planGross - expectedPlanNet);
  const expectedNetReturn = Math.max(0, expectedUpside - estimatedRoundTripCostPct);
  const horizonBars = horizon.code === "INTRADAY"
    ? 48
    : horizon.code === "SHORT"
    ? 192
    : horizon.code === "MEDIUM"
    ? 960
    : 1920;
  const drivers: string[] = [
    `기간 추세 ${(period.trend_signal * 100).toFixed(0)} / 모멘텀 ${(period.momentum_signal * 100).toFixed(0)}`,
    `목표 전략: ${plan.target_strategy_label}`,
    `과열 점수 ${overheat.toFixed(2)} / 동적 데이터 품질 ${micro.dynamic.data_quality.toFixed(2)}`,
  ];
  if (bucket.samples > 0) {
    drivers.push(`동일 점수구간 백테스트 ${bucket.samples}건의 MFE·목표도달률 반영`);
  }
  const caveats = [
    calibrated
      ? "워크포워드 검증을 통과한 점수구간 보정값입니다."
      : "아직 충분한 워크포워드 표본이 없어 보수적 사전값을 사용합니다.",
    "예상 상승률은 목표가 보장이 아니라 해당 관찰기간의 최대 유리 변동(MFE) 추정치입니다.",
    "뉴스·상장 이슈·유동성 공백과 과거에 없던 시장 국면은 반영하지 못합니다.",
  ];
  return {
    model_version: `${ENGINE_VERSION}-forecast.1`,
    calibration_source: ACTIVE_CALIBRATION_PROFILE.source,
    calibrated,
    calibration_samples: bucket.samples,
    target_hit_probability_pct: probability * 100,
    wait_entry_probability_pct: decision === "WAIT"
      ? clamp(bucket.waitEntryRate + (trendQuality - 0.5) * 0.12 - overheat * 0.1, 0.08, 0.75) * 100
      : null,
    raw_expected_upside_pct: rawExpected,
    expected_upside_pct: expectedUpside,
    conservative_upside_pct: conservativeUpside,
    optimistic_upside_pct: optimisticUpside,
    expected_price: expectedPrice,
    conservative_price: conservativePrice,
    optimistic_price: optimisticPrice,
    expected_net_return_pct: expectedNetReturn,
    confidence_band_pct: Math.max(0, (optimisticUpside - conservativeUpside) / 2),
    horizon_bars_15m: horizonBars,
    horizon_label: horizon.expected_window,
    drivers,
    caveats,
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
  // 과거 추세와 현재 실행 가능성을 거의 독립적인 축으로 유지한다.
  // 현재 호가 표본이 부족하면 미세구조 점수가 높은 척하지 못하도록 이미 42점으로 제한된다.
  const score = clamp(
    period.period_score * 0.65 + micro.micro_score * 0.35,
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
      period.universe.turnover_24h_quote >=
        period.universe.min_actionable_turnover_24h,
      period.universe.quote_currency === "KRW"
        ? "24시간 거래대금 10억원 이상이어야 합니다."
        : `24시간 거래대금 ${
          period.universe.min_actionable_turnover_24h.toLocaleString("en-US")
        } USDT 이상이어야 합니다.`,
    ),
    gate(
      "freshness",
      "체결 최신성",
      period.universe.freshness_seconds <= 300,
      "최근 체결이 5분 이내여야 합니다.",
    ),
    gate(
      "live_price",
      "실시간 기준가격",
      plan.reference_source === "LIVE_ORDERBOOK" &&
        micro.live_book_age_ms != null && micro.live_book_age_ms <= 10_000,
      `진입·손절·목표 계산은 10초 이내 최신 호가 중간가를 사용해야 합니다. 현재 출처: ${plan.reference_source}, 호가 나이 ${micro.live_book_age_ms == null ? "N/A" : (micro.live_book_age_ms / 1000).toFixed(1) + "초"}`,
    ),
    gate(
      "trend_15m",
      "15분 추세",
      ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(tf.m15.trend_state) &&
        tf.m15.trend_signal > 0.12,
      `15분 구조가 상승·눌림·회복 중 하나여야 합니다. 현재: ${trendStateLabel(tf.m15.trend_state)}`,
    ),
    gate(
      "trend_4h",
      "4시간 추세",
      ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(tf.h4.trend_state) &&
        tf.h4.trend_signal > 0.12,
      `4시간 구조가 상승·눌림·회복 중 하나여야 합니다. 현재: ${trendStateLabel(tf.h4.trend_state)}`,
    ),
    gate(
      "trend_context",
      "중기 추세 맥락",
      tf.day.trend_state !== "BEAR" &&
        (tf.day.trend_state !== "MIXED" || tf.h4.trend_state === "FULL_BULL"),
      `일봉이 완전 하락 정렬이 아니고, 일봉 혼조라면 4시간 완전 상승 정렬이 필요합니다. 현재 일봉: ${trendStateLabel(tf.day.trend_state)}`,
    ),
    gate(
      "overheat",
      "과열 제한",
      Math.max(tf.m15.overheat_score, tf.h4.overheat_score, tf.day.overheat_score) <= 0.58 &&
        period.universe.change_24h_pct <= 20 && tf.day.return_12_pct <= 80,
      `RSI·EMA 이격·ATR 대비 상승폭·누적 급등을 합산한 과열 점수가 0.58 이하여야 합니다. 현재 최대 ${Math.max(tf.m15.overheat_score, tf.h4.overheat_score, tf.day.overheat_score).toFixed(2)}`,
    ),
    gate(
      "micro_data",
      "동적 호가·체결 표본",
      micro.dynamic.sufficient,
      `실시간 관찰 45초·서로 다른 호가 25회·동시간대 체결 20건과 3개 구간의 분산 표본이 필요합니다. 현재 ${
        (micro.dynamic.observation_ms / 1000).toFixed(1)
      }초·${micro.dynamic.distinct_book_updates}회·${micro.dynamic.aligned_trade_count}건·${micro.dynamic.covered_phases}/3구간입니다.`,
    ),
    gate(
      "spread",
      "스프레드",
      micro.spread_bps != null && micro.spread_bps <= 35,
      "평균 스프레드가 35bp 이하여야 합니다.",
    ),
    gate(
      "depth",
      "호가 깊이·예상 슬리피지",
      plan.depth_coverage_ratio >= 1.5 &&
        plan.estimated_entry_slippage_bps != null &&
        plan.estimated_entry_slippage_bps <= 20,
      `상위 호가의 양방향 깊이가 예상 투입금의 1.5배 이상이고 매수 예상 슬리피지가 20bp 이하여야 합니다. 현재 커버리지 ${plan.depth_coverage_ratio.toFixed(2)}배, 슬리피지 ${plan.estimated_entry_slippage_bps == null ? "N/A" : plan.estimated_entry_slippage_bps.toFixed(1) + "bp"}`,
    ),
    gate(
      "micro_pressure",
      "초단기 수급",
      micro.trade_pressure > -0.20 && micro.book_imbalance > -0.40,
      "최근 체결 압력은 -0.20 초과, 정적 호가 불균형은 -0.40 초과여야 합니다.",
    ),
    gate(
      "dynamic_safety",
      "동적 호가 안전성",
      micro.dynamic.sufficient && [
        "NEUTRAL",
        "BREAKOUT_CONFIRMED",
      ].includes(micro.dynamic.status),
      `스푸핑성 취소·매도 재보충/흡수·지지 붕괴 패턴이 없어야 합니다. 현재: ${micro.dynamic.label}`,
    ),
    gate(
      "stop",
      "손절폭",
      plan.structure_complete && plan.net_stop_pct >= 0.25 &&
        plan.net_stop_pct <= risk.maxStopPct &&
        Number(plan.stop_distance_atr) <= (risk.stopAtrMult ?? 1.15) + 0.25,
      `과거·현재 지지와 저항이 모두 확인되고 비용 포함 손절폭이 0.25~${risk.maxStopPct}%여야 합니다. 지지: ${plan.support_basis}, 저항: ${plan.target_basis}`,
    ),
    gate(
      "target_structure",
      "목표가 구조",
      plan.structure_complete &&
        plan.short_target_execution_estimate > plan.entry_execution_estimate,
      `단기 목표는 실제 저항에서 도출되고 진입 실행가보다 높아야 합니다. 현재: ${plan.target_basis}`,
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
      score >= (risk.scoreThreshold ?? ACTIVE_CALIBRATION_PROFILE.parameters.scoreThreshold),
      `최종 점수가 ${risk.scoreThreshold ?? ACTIVE_CALIBRATION_PROFILE.parameters.scoreThreshold}점 이상이어야 합니다.`,
    ),
  ];
  const failed = checks.filter((check) => !check.passed);
  const decision: FinalCandidate["decision"] = failed.length === 0
    ? "BUY"
    : score < 42 || tf.h4.trend_signal < -0.5
    ? "AVOID"
    : "WAIT";
  plan.actionable = decision === "BUY";
  const watchEntryPlan = buildWatchEntryPlan(
    period,
    micro,
    plan,
    tickSize,
    risk,
    score,
    checks,
    decision,
  );
  const horizon = estimateHorizon(period, plan.stop_price);
  const forecast = estimatePriceForecast(
    period,
    micro,
    plan,
    watchEntryPlan,
    horizon,
    score,
    decision,
  );
  const positives = [...period.positives];
  const negatives = [...period.negatives];
  const warnings = [...period.warnings];
  if (micro.book_imbalance < -0.12) {
    negatives.push(
      "정적 호가 기준으로 현재가 인접 매도 잔량이 상대적으로 우세합니다.",
    );
  }
  if (micro.dynamic.sufficient && micro.trade_pressure >= 0.2) {
    positives.push("최근 체결대금은 약한 수준 이상으로 매수 우위입니다.");
  }
  if (micro.trade_pressure <= -0.2) {
    negatives.push("최근 체결대금은 매도 주도가 우세합니다.");
  }
  if (micro.dynamic.status === "BREAKOUT_CONFIRMED") {
    positives.push(
      ...micro.dynamic.evidence.filter((item) => item.includes("지지 전환")),
    );
  } else if (micro.dynamic.sufficient && micro.dynamic.status === "NEUTRAL") {
    positives.push(
      "실시간 체결-호가 교차검증에서 스푸핑성 취소·매도 재보충·지지 붕괴 신호가 검출되지 않았습니다.",
    );
  }
  negatives.push(...micro.dynamic.warnings);
  warnings.push(...micro.dynamic.warnings);
  for (const failedGate of failed) {
    warnings.push(`${failedGate.label}: ${failedGate.detail}`);
  }
  if (decision !== "BUY") {
    warnings.push(
      "강제 조건 미통과로 현재가 매수 추천이 아닌 관찰 후보입니다.",
    );
  }
  const liveDeviationBps = micro.reference_price && period.universe.current_price > 0
    ? Math.abs(micro.reference_price - period.universe.current_price) /
      period.universe.current_price * 10_000
    : null;
  if (liveDeviationBps != null && liveDeviationBps > 25) {
    warnings.push(
      `초기 24시간 티커 가격과 최종 실시간 호가 기준가격이 ${liveDeviationBps.toFixed(1)}bp 차이납니다. 진입 계산에는 실시간 호가를 사용했습니다.`,
    );
  }

  const confidence = clamp(
    25 + period.data_completeness * 22 + micro.dynamic.data_quality * 24 +
      micro.imbalance_stability * 5 + (plan.structure_complete ? 10 : 0) +
      (plan.reference_source === "LIVE_ORDERBOOK" ? 6 : 0) +
      Math.min(8, plan.depth_coverage_ratio * 2) - failed.length * 2.5,
    20,
    88,
  );

  return {
    market: period.universe.market,
    korean_name: period.universe.korean_name,
    english_name: period.universe.english_name,
    current_price: plan.reference_price,
    change_24h_pct: period.universe.change_24h_pct,
    turnover_24h_krw: period.universe.turnover_24h_krw,
    turnover_24h_quote: period.universe.turnover_24h_quote,
    quote_currency: period.universe.quote_currency,
    score,
    confidence,
    decision,
    decision_label: decision === "BUY"
      ? "현재 매수 후보"
      : decision === "WAIT" && watchEntryPlan.available
      ? "관찰·눌림 대기"
      : decision === "WAIT"
      ? "관찰·조건 회복 대기"
      : "매수 제외",
    trade_plan: plan,
    watch_entry_plan: watchEntryPlan,
    horizon,
    forecast,
    gates: checks,
    failed_gates: failed.map((item) => item.key),
    positives: [...new Set(positives)],
    negatives: [...new Set(negatives)],
    warnings: [...new Set(warnings)],
    timeframes: period.timeframes,
    microstructure: micro,
    price_context: {
      ticker_price: period.universe.current_price,
      live_reference_price: micro.reference_price,
      reference_source: plan.reference_source,
      reference_timestamp: micro.reference_timestamp,
      live_book_age_ms: micro.live_book_age_ms,
      ticker_live_deviation_bps: liveDeviationBps,
    },
  };
}
