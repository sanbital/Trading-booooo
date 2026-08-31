export const V10_LANES_REVISION = "V10-LANES-3.0.0" as const;
export const V10_LANES_SPEC_SHA256 =
  "9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f" as const;

export const BAR_MS = 15 * 60 * 1000;
export const SMA_BARS = 80; // 20 hours on 15-minute bars
export const ATR_BARS = 56; // 14 hours on 15-minute bars
export const ATR_BASE_BARS = 2880; // 30 days on 15-minute bars
export const QV24_BARS = 96;
export const RET24_BARS = 96;
export const BTC72_BARS = 288;
export const BTC30D_BARS = 2880;
export const REQUIRED_BARS = ATR_BASE_BARS + ATR_BARS;
export const ROUND_TRIP_COST_BPS = 21;
export const MIN_QUOTE_VOLUME_24H = 50_000_000;
export const MAX_CONCURRENT_TOTAL = 10;
export const NOTIONAL_USDT_PER_POSITION = 8;
export const MAX_AGGREGATE_NOTIONAL_USDT = 80;
export const LEVERAGE = 3;

export const V10_LANES_UNIVERSE = [
  "ETHUSDT",
  "XRPUSDT",
  "SOLUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "BCHUSDT",
  "DOTUSDT",
  "TRXUSDT",
  "NEARUSDT",
  "ETCUSDT",
  "XLMUSDT",
  "ATOMUSDT",
  "UNIUSDT",
] as const;

export type V10Lane = "BULL" | "RANGE" | "BEAR" | "CASH";
export type V10TradableLane = Exclude<V10Lane, "CASH">;
export type V10Side = "LONG";

export interface LaneBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
}

export interface LaneFeatures {
  symbol: string;
  signalBarAt: number;
  btc72: number;
  btc30d: number;
  atr: number;
  atrBaseline: number;
  atrRatio: number;
  bbPos: number;
  bbPos1hAgo: number;
  assetRet24h: number;
  quoteVolume24h: number;
  continuityOk: boolean;
  dataFresh: boolean;
}

export interface LaneDecision {
  lane: V10Lane;
  eligible: boolean;
  side: V10Side | null;
  fingerprint: string | null;
  holdHours: number | null;
  cooldownHours: number | null;
  reason: string;
  features: LaneFeatures;
}

export interface ActiveLanePosition {
  symbol: string;
  exitBarAt: number;
}

export interface LaneConfig {
  lane: V10TradableLane;
  fingerprint: string;
  holdHours: number;
  cooldownHours: number;
}

export const LANE_CONFIG: Record<V10TradableLane, LaneConfig> = {
  BULL: {
    lane: "BULL",
    fingerprint: "BULL_V10_LANES_3_0_0",
    holdHours: 12,
    cooldownHours: 12,
  },
  RANGE: {
    lane: "RANGE",
    fingerprint: "RANGE_V10_LANES_3_0_0",
    holdHours: 6,
    cooldownHours: 6,
  },
  BEAR: {
    lane: "BEAR",
    fingerprint: "BEAR_V10_LANES_3_0_0",
    holdHours: 24,
    cooldownHours: 24,
  },
};

export class LaneDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneDataError";
  }
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function requireFinite(name: string, value: number): void {
  if (!finite(value)) throw new LaneDataError(`${name}_NOT_FINITE`);
}

function assertBar(bar: LaneBar, index: number): void {
  if (!Number.isInteger(bar.openTime) || bar.openTime < 0) {
    throw new LaneDataError(`INVALID_OPEN_TIME_${index}`);
  }
  for (const [name, value] of Object.entries({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    quoteVolume: bar.quoteVolume,
  })) {
    if (!finite(value)) throw new LaneDataError(`INVALID_${name.toUpperCase()}_${index}`);
  }
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) {
    throw new LaneDataError(`NON_POSITIVE_PRICE_${index}`);
  }
  if (bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high)) {
    throw new LaneDataError(`INVALID_OHLC_${index}`);
  }
  if (bar.quoteVolume < 0) throw new LaneDataError(`NEGATIVE_QUOTE_VOLUME_${index}`);
}

function assertContinuous(bars: readonly LaneBar[], start: number, end: number): void {
  if (start < 0 || end >= bars.length || start > end) {
    throw new LaneDataError("CONTINUITY_RANGE_INVALID");
  }
  for (let index = start; index <= end; index += 1) {
    assertBar(bars[index], index);
    if (index > start && bars[index].openTime - bars[index - 1].openTime !== BAR_MS) {
      throw new LaneDataError(`BAR_GAP_${bars[index - 1].openTime}_${bars[index].openTime}`);
    }
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new LaneDataError("EMPTY_MEAN");
  let total = 0;
  for (const value of values) {
    requireFinite("MEAN_VALUE", value);
    total += value;
  }
  return total / values.length;
}

function sampleStd(values: readonly number[], average: number): number {
  if (values.length < 2) throw new LaneDataError("STD_SAMPLE_TOO_SMALL");
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / (values.length - 1));
}

function bbPositionAt(bars: readonly LaneBar[], index: number): number {
  const start = index - SMA_BARS + 1;
  if (start < 0) throw new LaneDataError("INSUFFICIENT_BB_HISTORY");
  const closes = bars.slice(start, index + 1).map((bar) => bar.close);
  const average = mean(closes);
  const standardDeviation = sampleStd(closes, average);
  if (!(standardDeviation > 0)) throw new LaneDataError("ZERO_BB_STDDEV");
  return (bars[index].close - average) / (2 * standardDeviation);
}

function buildAtrSeries(bars: readonly LaneBar[]): number[] {
  const trueRanges = new Array<number>(bars.length).fill(Number.NaN);
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    trueRanges[index] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  }

  const atr = new Array<number>(bars.length).fill(Number.NaN);
  let rolling = 0;
  let finiteCount = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const incoming = trueRanges[index];
    if (finite(incoming)) {
      rolling += incoming;
      finiteCount += 1;
    }
    const outgoingIndex = index - ATR_BARS;
    if (outgoingIndex >= 0 && finite(trueRanges[outgoingIndex])) {
      rolling -= trueRanges[outgoingIndex];
      finiteCount -= 1;
    }
    if (finiteCount === ATR_BARS) atr[index] = rolling / ATR_BARS;
  }
  return atr;
}

export function computeBtcContext(btcBars: readonly LaneBar[]): {
  signalBarAt: number;
  btc72: number;
  btc30d: number;
} {
  if (btcBars.length < BTC30D_BARS + 1) throw new LaneDataError("INSUFFICIENT_BTC_HISTORY");
  const index = btcBars.length - 1;
  assertContinuous(btcBars, index - BTC30D_BARS, index);
  const current = btcBars[index];
  const close72 = btcBars[index - BTC72_BARS].close;
  const close30d = btcBars[index - BTC30D_BARS].close;
  const btc72 = current.close / close72 - 1;
  const btc30d = current.close / close30d - 1;
  requireFinite("BTC72", btc72);
  requireFinite("BTC30D", btc30d);
  return { signalBarAt: current.openTime, btc72, btc30d };
}

export function computeLaneFeatures(
  symbol: string,
  assetBars: readonly LaneBar[],
  btcBars: readonly LaneBar[],
  dataFresh = true,
): LaneFeatures {
  if (assetBars.length < REQUIRED_BARS) throw new LaneDataError("INSUFFICIENT_ASSET_HISTORY");
  const index = assetBars.length - 1;
  const requiredStart = index - (ATR_BASE_BARS + ATR_BARS - 1);
  assertContinuous(assetBars, requiredStart, index);

  const btc = computeBtcContext(btcBars);
  if (btc.signalBarAt !== assetBars[index].openTime) {
    throw new LaneDataError("BTC_ASSET_TIMESTAMP_MISMATCH");
  }

  const atrSeries = buildAtrSeries(assetBars);
  const atr = atrSeries[index];
  requireFinite("ATR", atr);
  const baselineStart = index - ATR_BASE_BARS;
  const baselineValues = atrSeries.slice(baselineStart, index);
  if (baselineValues.length !== ATR_BASE_BARS || baselineValues.some((value) => !finite(value))) {
    throw new LaneDataError("ATR_BASELINE_INCOMPLETE");
  }
  const atrBaseline = mean(baselineValues);
  if (!(atrBaseline > 0)) throw new LaneDataError("ATR_BASELINE_NON_POSITIVE");
  const atrRatio = atr / atrBaseline;

  const bbPos = bbPositionAt(assetBars, index);
  const bbPos1hAgo = bbPositionAt(assetBars, index - 4);
  const assetRet24h = assetBars[index].close / assetBars[index - RET24_BARS].close - 1;
  let quoteVolume24h = 0;
  for (let offset = 0; offset < QV24_BARS; offset += 1) {
    quoteVolume24h += assetBars[index - offset].quoteVolume;
  }

  for (const [name, value] of Object.entries({
    atr,
    atrBaseline,
    atrRatio,
    bbPos,
    bbPos1hAgo,
    assetRet24h,
    quoteVolume24h,
  })) requireFinite(name, value);

  return {
    symbol,
    signalBarAt: assetBars[index].openTime,
    btc72: btc.btc72,
    btc30d: btc.btc30d,
    atr,
    atrBaseline,
    atrRatio,
    bbPos,
    bbPos1hAgo,
    assetRet24h,
    quoteVolume24h,
    continuityOk: true,
    dataFresh,
  };
}

export function routeLane(input: Pick<LaneFeatures, "btc72" | "continuityOk" | "dataFresh">): V10Lane {
  if (!input.continuityOk || !input.dataFresh || !finite(input.btc72)) return "CASH";
  if (input.btc72 < -0.05) return "BEAR";
  if (input.btc72 <= 0.04) return "RANGE";
  if (input.btc72 > 0.05) return "BULL";
  return "CASH"; // +4% to +5% structural buffer
}

function rejected(features: LaneFeatures, lane: V10Lane, reason: string): LaneDecision {
  if (lane === "CASH") {
    return { lane, eligible: false, side: null, fingerprint: null, holdHours: null, cooldownHours: null, reason, features };
  }
  const config = LANE_CONFIG[lane];
  return {
    lane,
    eligible: false,
    side: "LONG",
    fingerprint: config.fingerprint,
    holdHours: config.holdHours,
    cooldownHours: config.cooldownHours,
    reason,
    features,
  };
}

export function evaluateLane(features: LaneFeatures): LaneDecision {
  const lane = routeLane(features);
  if (lane === "CASH") return rejected(features, lane, "STRUCTURAL_CASH_OR_DATA_FAIL_CLOSED");
  if (features.quoteVolume24h < MIN_QUOTE_VOLUME_24H) return rejected(features, lane, "LIQUIDITY_BELOW_50M");

  if (lane === "BULL") {
    if (features.atrRatio < 1.65) return rejected(features, lane, "BULL_ATR_RATIO");
    if (features.bbPos > -0.20) return rejected(features, lane, "BULL_BB_POSITION");
    if (features.assetRet24h < -0.02) return rejected(features, lane, "BULL_ASSET_24H_RETURN");
  } else if (lane === "RANGE") {
    if (features.atrRatio < 1.65) return rejected(features, lane, "RANGE_ATR_RATIO");
    if (features.bbPos > -1.05) return rejected(features, lane, "RANGE_BB_POSITION");
  } else {
    if (features.btc30d < -0.20 || features.btc30d > -0.10) return rejected(features, lane, "BEAR_BTC_30D_WINDOW");
    if (features.atrRatio < 1.60) return rejected(features, lane, "BEAR_ATR_RATIO");
    if (features.bbPos > -0.90) return rejected(features, lane, "BEAR_BB_POSITION");
    if (features.bbPos1hAgo <= -0.90) return rejected(features, lane, "BEAR_NOT_FRESH_DOWNSIDE_BREAK");
  }

  const config = LANE_CONFIG[lane];
  return {
    lane,
    eligible: true,
    side: "LONG",
    fingerprint: config.fingerprint,
    holdHours: config.holdHours,
    cooldownHours: config.cooldownHours,
    reason: `${lane}_ELIGIBLE`,
    features,
  };
}

export function expectedEntryBarAt(signalBarAt: number): number {
  return signalBarAt + BAR_MS;
}

export function expectedExitBarAt(signalBarAt: number, holdHours: number): number {
  return signalBarAt + holdHours * 60 * 60 * 1000;
}

export function netReturnBps(entryPrice: number, exitPrice: number): number {
  if (!(entryPrice > 0) || !(exitPrice > 0)) throw new LaneDataError("INVALID_EXECUTION_PRICE");
  return (exitPrice / entryPrice - 1) * 10_000 - ROUND_TRIP_COST_BPS;
}

export function admitLaneCandidates(
  candidates: readonly LaneDecision[],
  active: readonly ActiveLanePosition[],
  signalBarAt: number,
  maxConcurrent = MAX_CONCURRENT_TOTAL,
): LaneDecision[] {
  const activeNow = active.filter((position) => position.exitBarAt > signalBarAt);
  const occupiedSymbols = new Set(activeNow.map((position) => position.symbol));
  let slots = Math.max(0, maxConcurrent - activeNow.length);
  const admitted: LaneDecision[] = [];
  const sorted = candidates.filter((candidate) => candidate.eligible)
    .slice()
    .sort((left, right) => left.features.symbol.localeCompare(right.features.symbol));
  for (const candidate of sorted) {
    if (slots <= 0) break;
    if (occupiedSymbols.has(candidate.features.symbol)) continue;
    admitted.push(candidate);
    occupiedSymbols.add(candidate.features.symbol);
    slots -= 1;
  }
  return admitted;
}
