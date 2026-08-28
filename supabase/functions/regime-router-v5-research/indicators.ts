import type { Bar, PreparedBar } from "./types.ts";

export const FIFTEEN_MINUTE_BARS_7D = 7 * 24 * 4;
export const PERCENTILE_SAMPLE_STRIDE = 4;

const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const STOCH_PERIOD = 14;
const ADX_PERIOD = 14;
const BB_PERIOD = 20;
const VWAP_PERIOD = 96;
const VOLUME_PERIOD = 20;

function lowerBound(values: readonly number[], needle: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < needle) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(values: readonly number[], needle: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= needle) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Causal rolling percentile rank. The value at i is ranked only against values
 * sampled from [i - window + 1, i]. The default 7d window retains one completed
 * observation per hour for full-universe throughput, while every current 15m
 * value is still ranked. Ties use their mid-rank, so a flat series is 0.5.
 */
export function rollingPercentileRanks(
  values: readonly number[],
  window = FIFTEEN_MINUTE_BARS_7D,
  sampleStride = window >= 96 ? PERCENTILE_SAMPLE_STRIDE : 1,
): number[] {
  if (!Number.isInteger(window) || window < 1) throw new Error("window must be a positive integer");
  if (!Number.isInteger(sampleStride) || sampleStride < 1) {
    throw new Error("sampleStride must be a positive integer");
  }
  const sorted: number[] = [];
  const result = new Array<number>(values.length).fill(Number.NaN);

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (i % sampleStride === 0 && Number.isFinite(value)) {
      sorted.splice(upperBound(sorted, value), 0, value);
    }

    const expiredIndex = i - window;
    if (expiredIndex >= 0 && expiredIndex % sampleStride === 0) {
      const expired = values[expiredIndex];
      if (Number.isFinite(expired)) {
        const at = lowerBound(sorted, expired);
        if (at < sorted.length && sorted[at] === expired) sorted.splice(at, 1);
      }
    }

    if (Number.isFinite(value) && sorted.length > 0) {
      const below = lowerBound(sorted, value);
      const atOrBelow = upperBound(sorted, value);
      result[i] = (below + atOrBelow) / (2 * sorted.length);
    }
  }
  return result;
}

export function emaSeries(values: readonly number[], period: number): number[] {
  if (!Number.isInteger(period) || period < 1) throw new Error("period must be a positive integer");
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const out = new Array<number>(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

function wilderAverage(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const value = Number.isFinite(values[i]) ? values[i] : 0;
    if (i < period) {
      seedSum += value;
      out[i] = seedSum / (i + 1);
    } else {
      out[i] = (out[i - 1] * (period - 1) + value) / period;
    }
  }
  return out;
}

export function rsiSeries(closes: readonly number[], period = RSI_PERIOD): number[] {
  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gains[i] = Math.max(0, delta);
    losses[i] = Math.max(0, -delta);
  }
  const averageGain = wilderAverage(gains, period);
  const averageLoss = wilderAverage(losses, period);
  return closes.map((_, i) => {
    if (averageGain[i] === 0 && averageLoss[i] === 0) return 50;
    if (averageLoss[i] === 0) return 100;
    const relativeStrength = averageGain[i] / averageLoss[i];
    return 100 - 100 / (1 + relativeStrength);
  });
}

function assertOrderedBars(bars: readonly Bar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (
      !Number.isFinite(bar.time) || !Number.isFinite(bar.open) || !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) || !Number.isFinite(bar.close) || !Number.isFinite(bar.volume) ||
      !Number.isFinite(bar.quoteVolume) || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 ||
      bar.close <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw new Error(`invalid bar at index ${i}`);
    }
    if (i > 0 && bar.time <= bars[i - 1].time) {
      throw new Error("bars must be strictly time ordered");
    }
  }
}

function previousExtreme(
  values: readonly number[],
  index: number,
  period: number,
  direction: "MAX" | "MIN",
): number {
  const start = Math.max(0, index - period);
  if (start >= index) return Number.NaN;
  let extreme = direction === "MAX" ? -Infinity : Infinity;
  for (let i = start; i < index; i++) {
    extreme = direction === "MAX" ? Math.max(extreme, values[i]) : Math.min(extreme, values[i]);
  }
  return extreme;
}

function returnOver(closes: readonly number[], index: number, bars: number): number {
  if (index < bars || closes[index - bars] <= 0) return Number.NaN;
  return closes[index] / closes[index - bars] - 1;
}

/**
 * Prepares completed 15-minute bars. Callers must not pass an in-progress bar.
 * Every field at index i is a function of bars[0..i]; previous breakout levels
 * deliberately exclude bars[i].
 */
export function prepareBars(bars: readonly Bar[]): PreparedBar[] {
  assertOrderedBars(bars);
  if (bars.length === 0) return [];

  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const rsi = rsiSeries(closes);

  const trueRanges = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[i - 1].close),
      Math.abs(bar.low - bars[i - 1].close),
    );
  });
  const atr = wilderAverage(trueRanges, ATR_PERIOD);
  const atrPct = atr.map((value, i) => closes[i] > 0 ? value / closes[i] : Number.NaN);

  const plusMovement = new Array<number>(bars.length).fill(0);
  const minusMovement = new Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    if (up > down && up > 0) plusMovement[i] = up;
    if (down > up && down > 0) minusMovement[i] = down;
  }
  const smoothedPlus = wilderAverage(plusMovement, ADX_PERIOD);
  const smoothedMinus = wilderAverage(minusMovement, ADX_PERIOD);
  const dx = bars.map((_, i) => {
    if (!(atr[i] > 0)) return 0;
    const plusDi = 100 * smoothedPlus[i] / atr[i];
    const minusDi = 100 * smoothedMinus[i] / atr[i];
    return plusDi + minusDi > 0 ? 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi) : 0;
  });
  const adx = wilderAverage(dx, ADX_PERIOD);

  const stochK = new Array<number>(bars.length).fill(Number.NaN);
  const stochD = new Array<number>(bars.length).fill(Number.NaN);
  const bbMid = new Array<number>(bars.length).fill(Number.NaN);
  const bbUpper = new Array<number>(bars.length).fill(Number.NaN);
  const bbLower = new Array<number>(bars.length).fill(Number.NaN);
  const bbWidth = new Array<number>(bars.length).fill(Number.NaN);

  let closeSum = 0;
  let closeSquareSum = 0;
  for (let i = 0; i < bars.length; i++) {
    const stochStart = Math.max(0, i - STOCH_PERIOD + 1);
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = stochStart; j <= i; j++) {
      highest = Math.max(highest, highs[j]);
      lowest = Math.min(lowest, lows[j]);
    }
    stochK[i] = highest > lowest ? 100 * (closes[i] - lowest) / (highest - lowest) : 50;
    const dStart = Math.max(0, i - 2);
    let dSum = 0;
    for (let j = dStart; j <= i; j++) dSum += stochK[j];
    stochD[i] = dSum / (i - dStart + 1);

    closeSum += closes[i];
    closeSquareSum += closes[i] * closes[i];
    if (i >= BB_PERIOD) {
      closeSum -= closes[i - BB_PERIOD];
      closeSquareSum -= closes[i - BB_PERIOD] * closes[i - BB_PERIOD];
    }
    const count = Math.min(i + 1, BB_PERIOD);
    const mean = closeSum / count;
    const variance = Math.max(0, closeSquareSum / count - mean * mean);
    const standardDeviation = Math.sqrt(variance);
    bbMid[i] = mean;
    bbUpper[i] = mean + 2 * standardDeviation;
    bbLower[i] = mean - 2 * standardDeviation;
    bbWidth[i] = mean > 0 ? (bbUpper[i] - bbLower[i]) / mean : Number.NaN;
  }

  const atrPercentile7d = rollingPercentileRanks(atrPct);
  const rsiPercentile7d = rollingPercentileRanks(rsi);
  const stochPercentile7d = rollingPercentileRanks(stochK);
  const bbCompressionPercentile7d = rollingPercentileRanks(bbWidth);

  const output: PreparedBar[] = [];
  const priceVolumeQueue: number[] = [];
  const volumeQueue: number[] = [];
  const quoteVolumeQueue: number[] = [];
  const priorVolumeQueue: number[] = [];
  let priceVolumeSum = 0;
  let vwapVolumeSum = 0;
  let quoteVolumeSum = 0;
  let priorVolumeSum = 0;
  let currentUtcDay = Number.NaN;
  let currentDayOpen = Number.NaN;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const utcDay = Math.floor(bar.time / 86_400_000);
    if (utcDay !== currentUtcDay) {
      currentUtcDay = utcDay;
      currentDayOpen = bar.open;
    }

    const effectiveQuoteVolume = bar.quoteVolume > 0
      ? bar.quoteVolume
      : ((bar.high + bar.low + bar.close) / 3) * Math.max(0, bar.volume);
    priceVolumeQueue.push(effectiveQuoteVolume);
    volumeQueue.push(Math.max(0, bar.volume));
    quoteVolumeQueue.push(Math.max(0, bar.quoteVolume));
    priceVolumeSum += effectiveQuoteVolume;
    vwapVolumeSum += Math.max(0, bar.volume);
    quoteVolumeSum += Math.max(0, bar.quoteVolume);
    if (priceVolumeQueue.length > VWAP_PERIOD) {
      priceVolumeSum -= priceVolumeQueue.shift()!;
      vwapVolumeSum -= volumeQueue.shift()!;
      quoteVolumeSum -= quoteVolumeQueue.shift()!;
    }

    const priorVolumeMean = priorVolumeQueue.length > 0
      ? priorVolumeSum / priorVolumeQueue.length
      : bar.volume;
    const volumeRatio = priorVolumeMean > 0 ? bar.volume / priorVolumeMean : 0;
    priorVolumeQueue.push(Math.max(0, bar.volume));
    priorVolumeSum += Math.max(0, bar.volume);
    if (priorVolumeQueue.length > VOLUME_PERIOD) priorVolumeSum -= priorVolumeQueue.shift()!;

    const high20Prev = previousExtreme(highs, i, 20, "MAX");
    const low20Prev = previousExtreme(lows, i, 20, "MIN");
    const high8Prev = previousExtreme(highs, i, 8, "MAX");
    const low8Prev = previousExtreme(lows, i, 8, "MIN");
    const barAtr = atr[i];
    const rollingVwap = vwapVolumeSum > 0 ? priceVolumeSum / vwapVolumeSum : bar.close;

    output.push({
      ...bar,
      atr: barAtr,
      atrPct: atrPct[i],
      atrPercentile7d: atrPercentile7d[i],
      rsi: rsi[i],
      rsiSlope2: i >= 2 ? rsi[i] - rsi[i - 2] : 0,
      rsiPercentile7d: rsiPercentile7d[i],
      ema20: ema20[i],
      ema50: ema50[i],
      ema20SlopeAtr: i >= 4 && barAtr > 0 ? (ema20[i] - ema20[i - 4]) / barAtr : 0,
      stochK: stochK[i],
      stochD: stochD[i],
      stochPercentile7d: stochPercentile7d[i],
      adx: adx[i],
      vwap96: rollingVwap,
      dayOpen: currentDayOpen,
      vwapDeviationAtr: barAtr > 0 ? (bar.close - rollingVwap) / barAtr : 0,
      dayOpenDeviationAtr: barAtr > 0 ? (bar.close - currentDayOpen) / barAtr : 0,
      qv24: quoteVolumeSum,
      volumeRatio,
      ret2: returnOver(closes, i, 2),
      ret4: returnOver(closes, i, 4),
      ret6h: returnOver(closes, i, 24),
      ret24h: returnOver(closes, i, 96),
      high20Prev,
      low20Prev,
      high8Prev,
      low8Prev,
      rangeMid20Prev: Number.isFinite(high20Prev) && Number.isFinite(low20Prev)
        ? (high20Prev + low20Prev) / 2
        : Number.NaN,
      bbMid: bbMid[i],
      bbUpper: bbUpper[i],
      bbLower: bbLower[i],
      bbCompressionPercentile7d: bbCompressionPercentile7d[i],
    });
  }

  return output;
}
