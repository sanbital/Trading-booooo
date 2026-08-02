// One-minute pre-breakout confirmation for LOB_SCALP.
// The completed candle must still be small: this gate deliberately enters before the
// expansion candle, never after it. Stochastic is raw %K 14, %K smoothing 3, %D 3.
export const MINUTE_ENTRY_GATE_VERSION = "M1-BB-PREBREAKOUT-STOCH-14-3-3-V2";
export const MINUTE_STOCH_LENGTH = 14;
export const MINUTE_STOCH_K_SMOOTHING = 3;
export const MINUTE_STOCH_D_SMOOTHING = 3;
export const MINUTE_BB_LENGTH = 20;
export const MINUTE_BB_STDDEV = 2;
export const MINUTE_ATR_LENGTH = 14;
const MINUTE_GATE_MIN_COMPLETED_BARS = 30;
const COMPLETION_GRACE_MS = 1_000;

export type MinuteCandle = {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type MinuteEntryGate = {
  version: string;
  passed: boolean;
  dataAvailable: boolean;
  previousBullish: boolean | null;
  stochK: number | null;
  stochD: number | null;
  completedBars: number;
  completedCandleOpenTime: string | null;
  completedCandleCloseTime: string | null;
  bandPosition: number | null;
  bandWidth: number | null;
  bandWidthExpansionRatio: number | null;
  upperBandSlopePct: number | null;
  bodyAtrRatio: number | null;
  rangeAtrRatio: number | null;
  recentAdvanceAtr: number | null;
  volumeRatio: number | null;
  squeezeRelease: boolean;
  preBreakout: boolean;
  bearishUpperBandReentry: boolean;
  upperBandReclaimed: boolean;
  previousAtUpperBand: boolean;
  latestClose: number | null;
  upperBand: number | null;
  reasons: string[];
  error: string | null;
};

type BollingerPoint = {
  middle: number;
  upper: number;
  lower: number;
  width: number;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function bollinger(candles: MinuteCandle[], index: number): BollingerPoint | null {
  if (index < MINUTE_BB_LENGTH - 1) return null;
  const closes = candles.slice(index - MINUTE_BB_LENGTH + 1, index + 1).map((row) => row.close);
  const middle = average(closes);
  if (!(middle && middle > 0)) return null;
  const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / closes.length;
  const deviation = Math.sqrt(Math.max(0, variance));
  const upper = middle + MINUTE_BB_STDDEV * deviation;
  const lower = middle - MINUTE_BB_STDDEV * deviation;
  return { middle, upper, lower, width: (upper - lower) / middle };
}

function atr(candles: MinuteCandle[], index: number): number | null {
  if (index < MINUTE_ATR_LENGTH) return null;
  const ranges: number[] = [];
  for (let cursor = index - MINUTE_ATR_LENGTH + 1; cursor <= index; cursor++) {
    const row = candles[cursor];
    const previousClose = candles[cursor - 1].close;
    ranges.push(
      Math.max(
        row.high - row.low,
        Math.abs(row.high - previousClose),
        Math.abs(row.low - previousClose),
      ),
    );
  }
  return average(ranges);
}

function stochastic(
  candles: MinuteCandle[],
): { k: number | null; d: number | null; previousK: number | null } {
  const rawK: number[] = [];
  for (let index = MINUTE_STOCH_LENGTH - 1; index < candles.length; index++) {
    const window = candles.slice(index - MINUTE_STOCH_LENGTH + 1, index + 1);
    const highest = Math.max(...window.map((candle) => candle.high));
    const lowest = Math.min(...window.map((candle) => candle.low));
    const range = highest - lowest;
    rawK.push(range > 0 ? (candles[index].close - lowest) / range * 100 : 50);
  }
  const smoothedK: number[] = [];
  for (let index = MINUTE_STOCH_K_SMOOTHING - 1; index < rawK.length; index++) {
    const value = average(rawK.slice(index - MINUTE_STOCH_K_SMOOTHING + 1, index + 1));
    if (value != null) smoothedK.push(value);
  }
  return {
    k: smoothedK.at(-1) ?? null,
    previousK: smoothedK.at(-2) ?? null,
    d: average(smoothedK.slice(-MINUTE_STOCH_D_SMOOTHING)),
  };
}

function emptyGate(error: unknown = null, available = false): MinuteEntryGate {
  return {
    version: MINUTE_ENTRY_GATE_VERSION,
    passed: false,
    dataAvailable: available,
    previousBullish: null,
    stochK: null,
    stochD: null,
    completedBars: 0,
    completedCandleOpenTime: null,
    completedCandleCloseTime: null,
    bandPosition: null,
    bandWidth: null,
    bandWidthExpansionRatio: null,
    upperBandSlopePct: null,
    bodyAtrRatio: null,
    rangeAtrRatio: null,
    recentAdvanceAtr: null,
    volumeRatio: null,
    squeezeRelease: false,
    preBreakout: false,
    bearishUpperBandReentry: false,
    upperBandReclaimed: false,
    previousAtUpperBand: false,
    latestClose: null,
    upperBand: null,
    reasons: [available ? "M1_CANDLE_DATA_INSUFFICIENT" : "M1_CANDLE_DATA_UNAVAILABLE"],
    error: error == null ? null : String(error).slice(0, 300),
  };
}

export function unavailableMinuteEntryGate(error: unknown = null): MinuteEntryGate {
  return emptyGate(error, false);
}

export function evaluateMinuteEntryGate(
  candles: MinuteCandle[],
  nowMs = Date.now(),
): MinuteEntryGate {
  const unique = new Map<number, MinuteCandle>();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const openTimeMs = finite(candle?.openTimeMs);
    const closeTimeMs = finite(candle?.closeTimeMs);
    const open = finite(candle?.open);
    const high = finite(candle?.high);
    const low = finite(candle?.low);
    const close = finite(candle?.close);
    const volume = finite(candle?.volume);
    if (
      openTimeMs == null || closeTimeMs == null || open == null || high == null || low == null ||
      close == null || volume == null || !(closeTimeMs > openTimeMs) ||
      !(open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0) ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)
    ) continue;
    if (closeTimeMs > nowMs - COMPLETION_GRACE_MS) continue;
    unique.set(openTimeMs, { openTimeMs, closeTimeMs, open, high, low, close, volume });
  }
  const completed = [...unique.values()].sort((left, right) => left.openTimeMs - right.openTimeMs);
  const last = completed.at(-1) ?? null;
  if (completed.length < MINUTE_GATE_MIN_COMPLETED_BARS || !last) {
    const result = emptyGate(null, true);
    return {
      ...result,
      previousBullish: last ? last.close > last.open : null,
      completedBars: completed.length,
      completedCandleOpenTime: last ? new Date(last.openTimeMs).toISOString() : null,
      completedCandleCloseTime: last ? new Date(last.closeTimeMs).toISOString() : null,
      latestClose: last?.close ?? null,
    };
  }

  const index = completed.length - 1;
  const previous = completed[index - 1];
  const currentBb = bollinger(completed, index);
  const previousBb = bollinger(completed, index - 1);
  const currentAtr = atr(completed, index);
  const stoch = stochastic(completed);
  if (
    !currentBb || !previousBb || !(currentAtr && currentAtr > 0) || stoch.k == null ||
    stoch.d == null
  ) {
    const result = emptyGate(null, true);
    return {
      ...result,
      previousBullish: last.close > last.open,
      completedBars: completed.length,
      completedCandleOpenTime: new Date(last.openTimeMs).toISOString(),
      completedCandleCloseTime: new Date(last.closeTimeMs).toISOString(),
      latestClose: last.close,
    };
  }

  const widths: number[] = [];
  for (let cursor = MINUTE_BB_LENGTH - 1; cursor <= index; cursor++) {
    const point = bollinger(completed, cursor);
    if (point) widths.push(point.width);
  }
  const recentWidths = widths.slice(-6);
  const referenceWidths = widths.slice(-20);
  const recentMinimum = recentWidths.length ? Math.min(...recentWidths) : currentBb.width;
  const referenceMedian = median(referenceWidths) ?? currentBb.width;
  const bandWidthExpansionRatio = previousBb.width > 0 ? currentBb.width / previousBb.width : 1;
  const squeezeRelease = recentMinimum <= referenceMedian * 0.88 &&
    currentBb.width >= recentMinimum * 1.035 && bandWidthExpansionRatio >= 1.008;
  const bandPosition = currentBb.upper > currentBb.lower
    ? (last.close - currentBb.lower) / (currentBb.upper - currentBb.lower)
    : 0.5;
  const priorBandPosition = previousBb.upper > previousBb.lower
    ? (previous.close - previousBb.lower) / (previousBb.upper - previousBb.lower)
    : 0.5;
  const upperBandSlopePct = previousBb.upper > 0
    ? (currentBb.upper / previousBb.upper - 1) * 100
    : 0;
  const bodyAtrRatio = Math.abs(last.close - last.open) / currentAtr;
  const rangeAtrRatio = (last.high - last.low) / currentAtr;
  const anchor = completed[Math.max(0, index - 3)].close;
  const recentAdvanceAtr = (last.close - anchor) / currentAtr;
  const priorVolumes = completed.slice(Math.max(0, index - 20), index).map((row) => row.volume)
    .filter((value) => value > 0);
  const volumeBase = median(priorVolumes) ?? 0;
  const volumeRatio = volumeBase > 0 ? last.volume / volumeBase : 0;
  const previousBullish = last.close > last.open;
  const previousAtUpperBand = bandPosition >= 0.90 || last.high >= currentBb.upper * 0.998 ||
    priorBandPosition >= 0.92 || previous.high >= previousBb.upper * 0.998;
  const bearishUpperBandReentry = previousAtUpperBand && last.close < last.open &&
    last.close < currentBb.upper && last.close > currentBb.middle;
  const upperBandReclaimed = last.close >= currentBb.upper * 0.995 && last.close >= last.open;
  const recentLargeBullish = completed.slice(-3).some((row, offset) => {
    const rowIndex = index - 2 + offset;
    const rowAtr = atr(completed, rowIndex);
    return Boolean(rowAtr && row.close > row.open && (row.close - row.open) / rowAtr >= 0.90);
  });

  const reasons: string[] = [];
  if (!previousBullish) reasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
  if (!(stoch.k > stoch.d)) reasons.push("M1_STOCH_K_NOT_ABOVE_D");
  if (stoch.previousK != null && stoch.k < stoch.previousK - 2) reasons.push("M1_STOCH_K_FADING");
  if (!squeezeRelease) reasons.push("M1_BB_SQUEEZE_NOT_RELEASING");
  if (!(bandPosition >= 0.78 && bandPosition <= 1.08)) reasons.push("M1_NOT_NEAR_UPPER_BAND");
  if (!(upperBandSlopePct > 0)) reasons.push("M1_UPPER_BAND_NOT_RISING");
  if (
    !(bodyAtrRatio >= 0.05 && bodyAtrRatio <= 0.75) || rangeAtrRatio > 1.20 || recentLargeBullish
  ) {
    reasons.push("M1_CANDLE_ALREADY_EXTENDED");
  }
  if (recentAdvanceAtr > 1.25) reasons.push("M1_RECENT_MOVE_ALREADY_EXTENDED");
  if (!(volumeRatio >= 1.05)) reasons.push("M1_VOLUME_NOT_EXPANDING");

  const preBreakout = reasons.length === 0;
  return {
    version: MINUTE_ENTRY_GATE_VERSION,
    passed: preBreakout,
    dataAvailable: true,
    previousBullish,
    stochK: stoch.k,
    stochD: stoch.d,
    completedBars: completed.length,
    completedCandleOpenTime: new Date(last.openTimeMs).toISOString(),
    completedCandleCloseTime: new Date(last.closeTimeMs).toISOString(),
    bandPosition,
    bandWidth: currentBb.width,
    bandWidthExpansionRatio,
    upperBandSlopePct,
    bodyAtrRatio,
    rangeAtrRatio,
    recentAdvanceAtr,
    volumeRatio,
    squeezeRelease,
    preBreakout,
    bearishUpperBandReentry,
    upperBandReclaimed,
    previousAtUpperBand,
    latestClose: last.close,
    upperBand: currentBb.upper,
    reasons: [...new Set(reasons)],
    error: null,
  };
}
