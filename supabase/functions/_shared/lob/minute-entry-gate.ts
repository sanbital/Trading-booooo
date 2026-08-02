// Mandatory one-minute entry confirmation for LOB_SCALP.
// Stochastic: raw %K length 14, %K smoothing 3, %D smoothing 3.
export const MINUTE_ENTRY_GATE_VERSION = "M1-STOCH-14-3-3-V1";
export const MINUTE_STOCH_LENGTH = 14;
export const MINUTE_STOCH_K_SMOOTHING = 3;
export const MINUTE_STOCH_D_SMOOTHING = 3;
const MINUTE_GATE_MIN_COMPLETED_BARS = 18;
const COMPLETION_GRACE_MS = 1_000;

export type MinuteCandle = {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
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
  reasons: string[];
  error: string | null;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function unavailableMinuteEntryGate(error: unknown = null): MinuteEntryGate {
  return {
    version: MINUTE_ENTRY_GATE_VERSION,
    passed: false,
    dataAvailable: false,
    previousBullish: null,
    stochK: null,
    stochD: null,
    completedBars: 0,
    completedCandleOpenTime: null,
    completedCandleCloseTime: null,
    reasons: ["M1_CANDLE_DATA_UNAVAILABLE"],
    error: error == null ? null : String(error).slice(0, 300),
  };
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
    if (
      openTimeMs == null || closeTimeMs == null || open == null || high == null ||
      low == null || close == null || !(closeTimeMs > openTimeMs) ||
      !(open > 0 && high > 0 && low > 0 && close > 0) ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)
    ) continue;
    if (closeTimeMs > nowMs - COMPLETION_GRACE_MS) continue;
    unique.set(openTimeMs, { openTimeMs, closeTimeMs, open, high, low, close });
  }
  const completed = [...unique.values()].sort((left, right) => left.openTimeMs - right.openTimeMs);
  const last = completed.at(-1) ?? null;
  if (completed.length < MINUTE_GATE_MIN_COMPLETED_BARS || !last) {
    return {
      version: MINUTE_ENTRY_GATE_VERSION,
      passed: false,
      dataAvailable: true,
      previousBullish: last ? last.close > last.open : null,
      stochK: null,
      stochD: null,
      completedBars: completed.length,
      completedCandleOpenTime: last ? new Date(last.openTimeMs).toISOString() : null,
      completedCandleCloseTime: last ? new Date(last.closeTimeMs).toISOString() : null,
      reasons: ["M1_CANDLE_DATA_INSUFFICIENT"],
      error: null,
    };
  }

  const rawK: number[] = [];
  for (let index = MINUTE_STOCH_LENGTH - 1; index < completed.length; index++) {
    const window = completed.slice(index - MINUTE_STOCH_LENGTH + 1, index + 1);
    const highest = Math.max(...window.map((candle) => candle.high));
    const lowest = Math.min(...window.map((candle) => candle.low));
    const range = highest - lowest;
    rawK.push(range > 0 ? (completed[index].close - lowest) / range * 100 : 50);
  }
  const smoothedK: number[] = [];
  for (let index = MINUTE_STOCH_K_SMOOTHING - 1; index < rawK.length; index++) {
    const value = average(
      rawK.slice(index - MINUTE_STOCH_K_SMOOTHING + 1, index + 1),
    );
    if (value != null) smoothedK.push(value);
  }
  const stochK = smoothedK.at(-1) ?? null;
  const stochD = average(smoothedK.slice(-MINUTE_STOCH_D_SMOOTHING));
  const previousBullish = last.close > last.open;
  const reasons: string[] = [];
  if (stochK == null || stochD == null) reasons.push("M1_CANDLE_DATA_INSUFFICIENT");
  if (!previousBullish) reasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
  if (stochK != null && stochD != null && !(stochK > stochD)) {
    reasons.push("M1_STOCH_K_NOT_ABOVE_D");
  }
  return {
    version: MINUTE_ENTRY_GATE_VERSION,
    passed: reasons.length === 0,
    dataAvailable: true,
    previousBullish,
    stochK,
    stochD,
    completedBars: completed.length,
    completedCandleOpenTime: new Date(last.openTimeMs).toISOString(),
    completedCandleCloseTime: new Date(last.closeTimeMs).toISOString(),
    reasons: [...new Set(reasons)],
    error: null,
  };
}
