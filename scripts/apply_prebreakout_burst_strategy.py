from __future__ import annotations

from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str, marker: str | None = None) -> None:
    text = read(path)
    if old in text:
        if text.count(old) != 1:
            raise SystemExit(f"{path}: expected one source block, found {text.count(old)}")
        write(path, text.replace(old, new))
        return
    if marker and marker in text:
        return
    raise SystemExit(f"{path}: source block missing: {old[:120]!r}")


def replace_between(path: str, start: str, end: str, replacement: str, marker: str) -> None:
    text = read(path)
    if marker in text:
        return
    left = text.find(start)
    if left < 0:
        raise SystemExit(f"{path}: start marker missing: {start!r}")
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f"{path}: end marker missing: {end!r}")
    write(path, text[:left] + replacement + text[right:])


MINUTE_GATE = dedent(r'''
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
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose)));
  }
  return average(ranges);
}

function stochastic(candles: MinuteCandle[]): { k: number | null; d: number | null; previousK: number | null } {
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

export function evaluateMinuteEntryGate(candles: MinuteCandle[], nowMs = Date.now()): MinuteEntryGate {
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
  if (!currentBb || !previousBb || !(currentAtr && currentAtr > 0) || stoch.k == null || stoch.d == null) {
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
  const upperBandSlopePct = previousBb.upper > 0 ? (currentBb.upper / previousBb.upper - 1) * 100 : 0;
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
  if (!(bodyAtrRatio >= 0.05 && bodyAtrRatio <= 0.75) || rangeAtrRatio > 1.20 || recentLargeBullish) {
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
''').lstrip()

MINUTE_MARKET = dedent(r'''
import {
  evaluateMinuteEntryGate,
  type MinuteCandle,
  type MinuteEntryGate,
  unavailableMinuteEntryGate,
} from "./minute-entry-gate.ts";

export type MinuteEntryExchange = "upbit" | "binance";

const UPBIT = "https://api.upbit.com";
const BINANCE = "https://api.binance.com";

function utcTimestamp(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
}

function normalizeUpbit(raw: unknown): MinuteCandle[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const row = value as Record<string, unknown>;
    const openTimeMs = utcTimestamp(row.candle_date_time_utc);
    if (!Number.isFinite(openTimeMs)) return [];
    return [{
      openTimeMs,
      closeTimeMs: openTimeMs + 60_000,
      open: Number(row.opening_price),
      high: Number(row.high_price),
      low: Number(row.low_price),
      close: Number(row.trade_price),
      volume: Number(row.candle_acc_trade_volume),
    }];
  });
}

function normalizeBinance(raw: unknown): MinuteCandle[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    if (!Array.isArray(value) || value.length < 7) return [];
    return [{
      openTimeMs: Number(value[0]),
      closeTimeMs: Number(value[6]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
      volume: Number(value[5]),
    }];
  });
}

async function fetchJson(url: string, timeoutMs = 6_000): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      const text = await response.text();
      if (!response.ok) throw new Error(`minute candle HTTP ${response.status}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : [];
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function loadMinuteEntryGate(
  exchange: MinuteEntryExchange,
  market: string,
  nowMs = Date.now(),
): Promise<MinuteEntryGate> {
  try {
    const url = exchange === "upbit"
      ? `${UPBIT}/v1/candles/minutes/1?market=${encodeURIComponent(market)}&count=60`
      : `${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(market)}&interval=1m&limit=60`;
    const raw = await fetchJson(url);
    return evaluateMinuteEntryGate(exchange === "upbit" ? normalizeUpbit(raw) : normalizeBinance(raw), nowMs);
  } catch (error) {
    return unavailableMinuteEntryGate(error instanceof Error ? error.message : String(error));
  }
}

export async function loadMinuteEntryGates(
  exchange: MinuteEntryExchange,
  markets: string[],
  nowMs = Date.now(),
): Promise<Map<string, MinuteEntryGate>> {
  const unique = [...new Set(markets.map((market) => String(market)).filter(Boolean))];
  const output = new Map<string, MinuteEntryGate>();
  const batchSize = exchange === "upbit" ? 5 : 10;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const results = await Promise.all(batch.map((market) => loadMinuteEntryGate(exchange, market, nowMs)));
    batch.forEach((market, index) => output.set(market, results[index]));
    if (offset + batchSize < unique.length) await new Promise((resolve) => setTimeout(resolve, exchange === "upbit" ? 300 : 100));
  }
  return output;
}
''').lstrip()

MINUTE_TEST = dedent(r'''
import { evaluateMinuteEntryGate, MINUTE_ENTRY_GATE_VERSION, type MinuteCandle } from "./minute-entry-gate.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function candidate(now: number, step: number): MinuteCandle[] {
  const start = now - 50 * 60_000;
  return Array.from({ length: 44 }, (_, index) => {
    const quiet = Math.sin(index * 1.7) * 0.012;
    const launch = index >= 38 ? (index - 37) * step : 0;
    const close = 100 + quiet + launch;
    const open = close - (index >= 38 ? Math.max(0.004, step * 0.35) : 0.003);
    return {
      openTimeMs: start + index * 60_000,
      closeTimeMs: start + (index + 1) * 60_000 - 1,
      open,
      high: Math.max(open, close) + 0.035,
      low: Math.min(open, close) - 0.035,
      close,
      volume: index === 43 ? 180 : 100 + (index % 4) * 3,
    };
  });
}

Deno.test("pre-breakout gate has an admissible small-candle squeeze-release zone", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  let accepted = null;
  for (const step of [0.006, 0.008, 0.01, 0.012, 0.015, 0.018, 0.02]) {
    const result = evaluateMinuteEntryGate(candidate(now, step), now);
    if (result.passed) {
      accepted = result;
      break;
    }
  }
  assert(accepted, "no synthetic pre-breakout setup passed");
  assert(accepted.version === MINUTE_ENTRY_GATE_VERSION);
  assert(accepted.preBreakout && accepted.squeezeRelease);
  assert(accepted.bodyAtrRatio != null && accepted.bodyAtrRatio <= 0.75);
});

Deno.test("a completed giant bullish candle is never a new entry", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  const last = candles.at(-1)!;
  last.open = last.close - 0.8;
  last.low = last.open - 0.05;
  last.high = last.close + 0.05;
  last.volume = 400;
  const result = evaluateMinuteEntryGate(candles, now);
  assert(!result.passed);
  assert(result.reasons.includes("M1_CANDLE_ALREADY_EXTENDED"));
});

Deno.test("forming candle is excluded and insufficient history fails closed", () => {
  const now = Date.UTC(2026, 7, 2, 15, 0, 30);
  const candles = candidate(now, 0.012);
  candles.push({
    openTimeMs: now - 30_000,
    closeTimeMs: now + 30_000,
    open: 999,
    high: 1000,
    low: 800,
    close: 801,
    volume: 9999,
  });
  const result = evaluateMinuteEntryGate(candles, now);
  assert(result.latestClose !== 801, "forming candle leaked into the gate");
  const short = evaluateMinuteEntryGate(candles.slice(-10), now);
  assert(!short.passed && short.reasons.includes("M1_CANDLE_DATA_INSUFFICIENT"));
});
''').lstrip()

write("supabase/functions/_shared/lob/minute-entry-gate.ts", MINUTE_GATE)
write("supabase/functions/_shared/lob/minute-entry-market.ts", MINUTE_MARKET)
write("supabase/functions/_shared/lob/minute-entry-gate.test.ts", MINUTE_TEST)

FEATURE_FIELDS = '''  m1BandPosition?: number | null;
  m1BandWidth?: number | null;
  m1BandWidthExpansionRatio?: number | null;
  m1UpperBandSlopePct?: number | null;
  m1BodyAtrRatio?: number | null;
  m1RangeAtrRatio?: number | null;
  m1RecentAdvanceAtr?: number | null;
  m1VolumeRatio?: number | null;
  m1SqueezeRelease?: boolean;
  m1PreBreakout?: boolean;
  m1BearishUpperBandReentry?: boolean;
  m1UpperBandReclaimed?: boolean;
  m1PreviousAtUpperBand?: boolean;
  m1LatestClose?: number | null;
  m1UpperBand?: number | null;
'''
replace_once(
    "supabase/functions/_shared/lob/types.ts",
    "  m1CompletedCandleCloseTime?: string | null;\n}",
    "  m1CompletedCandleCloseTime?: string | null;\n" + FEATURE_FIELDS + "}",
    "m1PreBreakout?: boolean",
)

UNIVERSE_FIELDS = '''  m1_band_position?: number | null;
  m1_band_width?: number | null;
  m1_band_width_expansion_ratio?: number | null;
  m1_upper_band_slope_pct?: number | null;
  m1_body_atr_ratio?: number | null;
  m1_range_atr_ratio?: number | null;
  m1_recent_advance_atr?: number | null;
  m1_volume_ratio?: number | null;
  m1_squeeze_release?: boolean;
  m1_pre_breakout?: boolean;
  m1_bearish_upper_band_reentry?: boolean;
  m1_upper_band_reclaimed?: boolean;
  m1_previous_at_upper_band?: boolean;
  m1_latest_close?: number | null;
  m1_upper_band?: number | null;
'''
replace_once(
    "supabase/functions/market-scanner/engine.ts",
    "  m1_completed_candle_close_time?: string | null;\n  recent_notional_per_second?: number;",
    "  m1_completed_candle_close_time?: string | null;\n" + UNIVERSE_FIELDS + "  recent_notional_per_second?: number;",
    "m1_pre_breakout?: boolean",
)

ENGINE_MAP = '''      m1BandPosition: period.universe.m1_band_position ?? null,
      m1BandWidth: period.universe.m1_band_width ?? null,
      m1BandWidthExpansionRatio: period.universe.m1_band_width_expansion_ratio ?? null,
      m1UpperBandSlopePct: period.universe.m1_upper_band_slope_pct ?? null,
      m1BodyAtrRatio: period.universe.m1_body_atr_ratio ?? null,
      m1RangeAtrRatio: period.universe.m1_range_atr_ratio ?? null,
      m1RecentAdvanceAtr: period.universe.m1_recent_advance_atr ?? null,
      m1VolumeRatio: period.universe.m1_volume_ratio ?? null,
      m1SqueezeRelease: period.universe.m1_squeeze_release === true,
      m1PreBreakout: period.universe.m1_pre_breakout === true,
      m1BearishUpperBandReentry: period.universe.m1_bearish_upper_band_reentry === true,
      m1UpperBandReclaimed: period.universe.m1_upper_band_reclaimed === true,
      m1PreviousAtUpperBand: period.universe.m1_previous_at_upper_band === true,
      m1LatestClose: period.universe.m1_latest_close ?? null,
      m1UpperBand: period.universe.m1_upper_band ?? null,
'''
replace_once(
    "supabase/functions/market-scanner/engine.ts",
    "      m1CompletedCandleCloseTime: period.universe.m1_completed_candle_close_time ?? null,\n    };",
    "      m1CompletedCandleCloseTime: period.universe.m1_completed_candle_close_time ?? null,\n" + ENGINE_MAP + "    };",
    "m1PreBreakout: period.universe.m1_pre_breakout",
)

replace_once(
    "supabase/functions/market-scanner/index.ts",
    '''const DEFAULT_DYNAMIC_OBSERVATION_MS = 50_000;
const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 50_000;
const MIN_DYNAMIC_OBSERVATION_MS = 50_000;
const MAX_DYNAMIC_OBSERVATION_MS = 60_000;
// Every symbol must receive its own full 50-second wall-clock observation window.
// The global socket-open timer alone is insufficient because a symbol's first frame can arrive late.
const REQUIRED_PER_MARKET_OBSERVATION_MS = 50_000;
const EXTENDED_PER_MARKET_OBSERVATION_MS = 60_000;
const DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS = 35_000;''',
    '''// The old 50-second wait entered after the expansion candle. Fifteen seconds is enough
// to confirm real tape pressure while the completed 1m candle is still pre-breakout.
const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000;
const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 20_000;
const MIN_DYNAMIC_OBSERVATION_MS = 12_000;
const MAX_DYNAMIC_OBSERVATION_MS = 25_000;
const REQUIRED_PER_MARKET_OBSERVATION_MS = 15_000;
const EXTENDED_PER_MARKET_OBSERVATION_MS = 25_000;
const DYNAMIC_STREAM_HARD_TIMEOUT_BUFFER_MS = 20_000;''',
    "const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000",
)

SCANNER_MAP = '''      m1_band_position: gate?.bandPosition ?? null,
      m1_band_width: gate?.bandWidth ?? null,
      m1_band_width_expansion_ratio: gate?.bandWidthExpansionRatio ?? null,
      m1_upper_band_slope_pct: gate?.upperBandSlopePct ?? null,
      m1_body_atr_ratio: gate?.bodyAtrRatio ?? null,
      m1_range_atr_ratio: gate?.rangeAtrRatio ?? null,
      m1_recent_advance_atr: gate?.recentAdvanceAtr ?? null,
      m1_volume_ratio: gate?.volumeRatio ?? null,
      m1_squeeze_release: gate?.squeezeRelease === true,
      m1_pre_breakout: gate?.preBreakout === true,
      m1_bearish_upper_band_reentry: gate?.bearishUpperBandReentry === true,
      m1_upper_band_reclaimed: gate?.upperBandReclaimed === true,
      m1_previous_at_upper_band: gate?.previousAtUpperBand === true,
      m1_latest_close: gate?.latestClose ?? null,
      m1_upper_band: gate?.upperBand ?? null,
'''
replace_once(
    "supabase/functions/market-scanner/index.ts",
    "      m1_completed_candle_close_time: gate?.completedCandleCloseTime ?? null,\n    };",
    "      m1_completed_candle_close_time: gate?.completedCandleCloseTime ?? null,\n" + SCANNER_MAP + "    };",
    "m1_pre_breakout: gate?.preBreakout",
)
replace_once(
    "supabase/functions/market-scanner/index.ts",
    'm1_entry_gate: "PREVIOUS_CANDLE_BULLISH_AND_STOCH_14_3_3_K_GT_D",',
    'm1_entry_gate: "BB_SQUEEZE_RELEASE_PREBREAKOUT_AND_STOCH_14_3_3_K_GT_D",',
    "BB_SQUEEZE_RELEASE_PREBREAKOUT",
)

replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    'const DEFAULT_BLOCKED_LOB_PATTERNS = ["OFI_CONTINUATION", "MOMENTUM_CONTINUATION"];',
    'const DEFAULT_BLOCKED_LOB_PATTERNS: string[] = [];',
    "const DEFAULT_BLOCKED_LOB_PATTERNS: string[] = []",
)
replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    '''  // Every candidate must be judged from a full 50-second live book/tape window.
  minObservationMs: 50_000,''',
    '''  // Confirm tape pressure quickly enough to enter before the expansion candle.
  minObservationMs: 15_000,''',
    "minObservationMs: 15_000",
)
replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    "  cfg.minObservationMs = 50_000;",
    "  cfg.minObservationMs = 15_000;",
    "cfg.minObservationMs = 15_000",
)
replace_once(
    "supabase/functions/_shared/lob/entry.ts",
    '  if (features.observationMs < 50_000) reasons.push("INSUFFICIENT_50S_OBSERVATION");',
    '  if (features.observationMs < 15_000) reasons.push("INSUFFICIENT_15S_OBSERVATION");',
    "INSUFFICIENT_15S_OBSERVATION",
)

NEW_RISK_FUNCTION = dedent(r'''
export function assessLobEntryRisk(
  features: LobFeatureVector,
  trapOverrides: LobEntryConfig["trap"] = {},
): LobEntryRiskAssessment {
  const trapCfg = { ...DEFAULT_LOB_TRAP_CONFIG, ...trapOverrides };
  const reasons: string[] = [];
  const warnings: string[] = [];
  const status = String(features.dynamicStatus || "INSUFFICIENT").toUpperCase();
  const pressure = clamp(finite(features.tradePressureFast), -1, 1);
  const micropriceBps = finite(features.micropriceDeviationBps);
  const microprice = clamp(micropriceBps / 8, -1, 1);
  const imbalance = clamp(finite(features.bookImbalance), -1, 1);
  const ofi = clamp(finite(features.ofiPersistence), 0, 1);
  const bidSpoof = clamp(finite(features.spoofLikeScore), 0, 1);
  const askSpoof = clamp(finite(features.askSpoofScore), 0, 1);
  const bidSpoofDetected = bidSpoof >= trapCfg.bidSpoofScore;
  const askSpoofDetected = askSpoof >= trapCfg.askSpoofScore;
  const supportBreakdown = status.includes("SUPPORT_BREAKDOWN");
  const dynamicInsufficient = status.includes("INSUFFICIENT") ||
    clamp(finite(features.dataQuality), 0, 1) < trapCfg.minDataQuality;
  const buyNotional = Math.max(0, finite(features.buyNotional));
  const sellNotional = Math.max(0, finite(features.sellNotional));
  const buySellRatio = buyNotional > 0
    ? buyNotional / Math.max(sellNotional, Math.max(1e-9, buyNotional * 0.05))
    : 0;
  const acceleration = finite(features.notionalAcceleration);

  const adverseFlowSignals = [
    finite(features.tradeSpeedTrend) <= -0.20 ? "TRADE_SPEED_DECLINING" : null,
    finite(features.notionalTrend) <= -0.20 ? "FLOW_NOTIONAL_DECLINING" : null,
    pressure < 0 ? "SELL_PRESSURE_DOMINANT" : null,
    micropriceBps < 0 ? "MICROPRICE_BEARISH" : null,
  ].filter((value): value is string => value !== null);

  if (dynamicInsufficient) reasons.push("LOB_DYNAMIC_EVIDENCE_INSUFFICIENT");
  if (supportBreakdown) reasons.push("SUPPORT_BREAKDOWN_RISK");
  if (bidSpoofDetected || askSpoofDetected) reasons.push("SPOOF_WARNING");
  if (bidSpoofDetected && askSpoofDetected) reasons.push("TWO_SIDED_SPOOF_RISK");

  const severeBidSpoofThreshold = Math.max(0.90, trapCfg.bidSpoofScore);
  const bidSpoofConfirmed =
    (bidSpoof >= severeBidSpoofThreshold && adverseFlowSignals.length >= 1) ||
    (bidSpoofDetected && adverseFlowSignals.length >= 2);
  if (bidSpoofConfirmed) reasons.push("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW");
  if (askSpoofDetected && !bidSpoofDetected && !supportBreakdown) warnings.push("ASK_SPOOF");
  if (bidSpoofDetected && adverseFlowSignals.length > 0) {
    warnings.push(`BID_SPOOF_ADVERSE_FLOW_${adverseFlowSignals.length}`);
  }

  // Entry is armed by the completed pre-breakout candle, but executed only when real buys
  // are accelerating now. Resting depth alone never counts as pressure.
  const pressureConfirmations = [
    ofi >= 0.45,
    micropriceBps >= 0,
    imbalance >= 0,
    finite(features.depthRatio) >= 0.90,
    finite(features.tradeSpeedTrend) >= -0.05,
  ].filter(Boolean).length;
  if (pressure < 0.10) reasons.push("BUY_PRESSURE_TOO_WEAK");
  if (buySellRatio < 1.25) reasons.push("AGGRESSIVE_BUY_NOTIONAL_TOO_WEAK");
  if (!(acceleration > 0)) reasons.push("BUY_FLOW_NOT_ACCELERATING");
  if (pressureConfirmations < 3) reasons.push("BUY_PRESSURE_NOT_CONFIRMED");
  if (!(Math.max(0, finite(features.tradeArrivalRate)) > 0)) reasons.push("NO_LIVE_BUY_TAPE");

  const flowScore = pressure * 0.42 + microprice * 0.24 + imbalance * 0.20 + ofi * 0.14;
  return {
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    adverseFlowSignals,
    positiveVotes: pressureConfirmations,
    flowScore,
    bidSpoofThreshold: trapCfg.bidSpoofScore,
    askSpoofThreshold: trapCfg.askSpoofScore,
  };
}

''').lstrip()
replace_between(
    "supabase/functions/_shared/lob/entry.ts",
    "export function assessLobEntryRisk(",
    "/**\n * Pure Top-10 order-book entry gate.",
    NEW_RISK_FUNCTION,
    "BUY_PRESSURE_NOT_CONFIRMED",
)

NEW_M1_ENTRY_BLOCK = '''  // The completed candle is deliberately the small pre-breakout candle. A large expansion
  // candle, a late three-bar advance, or a band that is not just beginning to widen blocks.
  if (cfg.requireMinuteEntryGate === true) {
    if (
      features.m1GateVersion !== MINUTE_ENTRY_GATE_VERSION ||
      features.m1DataAvailable !== true
    ) {
      reasons.push("M1_CANDLE_DATA_UNAVAILABLE");
    } else if (Math.max(0, Math.floor(Number(features.m1CompletedBars) || 0)) < 30) {
      reasons.push("M1_CANDLE_DATA_INSUFFICIENT");
    } else if (features.m1PreBreakout !== true) {
      reasons.push("M1_PREBREAKOUT_SETUP_NOT_READY");
    }
  }

'''
replace_between(
    "supabase/functions/_shared/lob/entry.ts",
    "  // Operator-added 1m entry gate.",
    "  // Structural and execution checks only.",
    NEW_M1_ENTRY_BLOCK,
    "M1_PREBREAKOUT_SETUP_NOT_READY",
)

AUTOTRADER_MAP = '''    m1BandPosition: base.m1BandPosition ?? null,
    m1BandWidth: base.m1BandWidth ?? null,
    m1BandWidthExpansionRatio: base.m1BandWidthExpansionRatio ?? null,
    m1UpperBandSlopePct: base.m1UpperBandSlopePct ?? null,
    m1BodyAtrRatio: base.m1BodyAtrRatio ?? null,
    m1RangeAtrRatio: base.m1RangeAtrRatio ?? null,
    m1RecentAdvanceAtr: base.m1RecentAdvanceAtr ?? null,
    m1VolumeRatio: base.m1VolumeRatio ?? null,
    m1SqueezeRelease: base.m1SqueezeRelease === true,
    m1PreBreakout: base.m1PreBreakout === true,
    m1BearishUpperBandReentry: base.m1BearishUpperBandReentry === true,
    m1UpperBandReclaimed: base.m1UpperBandReclaimed === true,
    m1PreviousAtUpperBand: base.m1PreviousAtUpperBand === true,
    m1LatestClose: base.m1LatestClose ?? null,
    m1UpperBand: base.m1UpperBand ?? null,
'''
replace_once(
    "supabase/functions/market-autotrader/index.ts",
    "    m1CompletedCandleCloseTime: base.m1CompletedCandleCloseTime ?? null,\n  };",
    "    m1CompletedCandleCloseTime: base.m1CompletedCandleCloseTime ?? null,\n" + AUTOTRADER_MAP + "  };",
    "m1PreBreakout: base.m1PreBreakout",
)

NEW_EXIT_POLICY = dedent(r'''
      // PREBREAKOUT-BURST-V1: no planned stop, no experimental arm stop, no fixed target
      // and no time-based exit. The only loss floor is -2% of executable net. Normal exits
      // follow the observed burst ending: bearish upper-band re-entry plus weak tape, a
      // failed reclaim, or an actual order-book collapse.
      if (lobMode && !settings.emergency_liquidation) {
        const BURST_POLICY_VERSION = "PREBREAKOUT-BURST-V1";
        const requestedAction = decision.action;
        const requestedReason = String((decision as any).reason || "");
        const safetyRequested = requestedAction === "STOP" &&
          (requestedReason.includes("RISK_EMERGENCY") ||
            requestedReason.includes("RECONCILIATION_FAILURE"));
        const policyFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);
        const policyQuantity = Math.max(0, finite(position.remaining_quantity));
        const policyUnrecoveredCost = exactUnrecoveredPositionCost(position);
        const liveBook = books[position.market];
        const liveBids = (liveBook?.bids || []).map((row: any) => ({
          price: finite(row?.price ?? row?.[0]),
          size: finite(row?.size ?? row?.[1]),
        }));
        const liveAsks = (liveBook?.asks || []).map((row: any) => ({
          price: finite(row?.price ?? row?.[0]),
          size: finite(row?.size ?? row?.[1]),
        }));
        const executableQuote = quoteExecutableNetExit({
          bids: liveBids,
          requestedQuantity: policyQuantity,
          availableQuantity: position.is_paper
            ? policyQuantity
            : accountQuantity(portfolios[exchange], position.base_asset, true),
          quantityStep: finite(position.quantity_step, 0.00000001),
          buyPrincipalQuote: finite(position.realized_cost_quote),
          alreadyPaidFeesQuote: finite(position.paid_fees_quote),
          priorSellProceedsQuote: finite(position.realized_proceeds_quote),
          sellFeeRate: policyFeeRate,
          slippageSafetyRate: post180SlippageSafetyRate(settings),
        });
        const executableExitPrice = executableQuote.executableVwap > 0
          ? executableQuote.executableVwap
          : current;
        const guardedNetProfitQuote = executableExitPrice * policyQuantity *
            (1 - policyFeeRate) - policyUnrecoveredCost;
        const guardedNetReturnPct = policyUnrecoveredCost > 0
          ? guardedNetProfitQuote / policyUnrecoveredCost * 100
          : 0;

        const freshMinuteGate = await loadMinuteEntryGate(exchange, position.market);
        const liveImbalance = topOfBookImbalance(liveBids, liveAsks);
        const livePressure = finite(liveBook?.trade_flow?.pressure, 0);
        const entryDepth = Math.max(1, finite(position.metadata?.entry_bid_depth_quote, 1));
        const bidDepthRetention = liveBook ? bidDepthQuote(liveBook) / entryDepth : 0;
        const bestBid = finite(liveBook?.best_bid);
        const bestAsk = finite(liveBook?.best_ask);
        const liveSpreadBps = bestBid > 0 ? (bestAsk / bestBid - 1) * 10_000 : 9999;
        const entrySpreadBps = Math.max(
          1,
          finite(
            position.metadata?.lob_signal?.features?.spreadBps,
            position.metadata?.entry_spread_bps,
          ),
        );
        const weaknessSignals = [
          livePressure <= 0,
          liveImbalance <= -0.05,
          bidDepthRetention <= 0.70,
          liveSpreadBps >= Math.max(10, entrySpreadBps * 1.8),
        ];
        const weaknessVotes = weaknessSignals.filter(Boolean).length;
        const orderbookCollapse =
          (livePressure <= -0.35 && liveImbalance <= -0.20) ||
          (bidDepthRetention <= 0.45 &&
            liveSpreadBps >= Math.max(12, entrySpreadBps * 2));

        const nowMs = Date.now();
        const previousWatchText = String(position.metadata?.bb_exit_watch_started_at || "");
        const previousWatchMs = Date.parse(previousWatchText);
        let watchStartedMs = Number.isFinite(previousWatchMs) ? previousWatchMs : Number.NaN;
        if (freshMinuteGate.upperBandReclaimed) watchStartedMs = Number.NaN;
        else if (freshMinuteGate.bearishUpperBandReentry && !Number.isFinite(watchStartedMs)) {
          watchStartedMs = nowMs;
        }
        const watchAgeSeconds = Number.isFinite(watchStartedMs)
          ? Math.max(0, (nowMs - watchStartedMs) / 1000)
          : 0;
        const reentryConfirmed = freshMinuteGate.bearishUpperBandReentry && weaknessVotes >= 2;
        const reclaimFailed = Number.isFinite(watchStartedMs) && watchAgeSeconds >= 45 &&
          !freshMinuteGate.upperBandReclaimed && weaknessVotes >= 1;

        if (safetyRequested) {
          decision = { action: "STOP", fraction: 1, reason: requestedReason } as any;
        } else if (guardedNetReturnPct <= -2) {
          decision = { action: "STOP", fraction: 1, reason: "HARD_STOP_MINUS_2" } as any;
        } else if (orderbookCollapse) {
          decision = { action: "STOP", fraction: 1, reason: "ORDERBOOK_COLLAPSE" } as any;
        } else if (reentryConfirmed) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "BB_UPPER_REENTRY_CONFIRMED",
          } as any;
        } else if (reclaimFailed) {
          decision = { action: "STOP", fraction: 1, reason: "BB_RECLAIM_FAILED" } as any;
        } else {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "BURST_CONTINUES_OR_EXIT_NOT_CONFIRMED",
          } as any;
        }

        const watchIso = Number.isFinite(watchStartedMs)
          ? new Date(watchStartedMs).toISOString()
          : null;
        const watchChanged = watchIso !== (previousWatchText || null);
        if (watchChanged || decision.action !== "NONE") {
          const measuredAt = new Date(nowMs).toISOString();
          const approvedReason = String((decision as any).reason || "");
          const approvedAction = decision.action === "STOP" ? "STOP" : "NONE";
          const exitPolicyQuote = decision.action === "STOP"
            ? {
              revision: VERSION,
              burst_policy_version: BURST_POLICY_VERSION,
              measured_at: measuredAt,
              price: executableExitPrice,
              executable_vwap: executableQuote.executableVwap,
              sell_price: executableQuote.limitPrice,
              approved_action: approvedAction,
              approved_reason: approvedReason,
              requested_action: requestedAction,
              requested_reason: requestedReason,
              hard_stop_net_return_pct: guardedNetReturnPct,
              hard_stop_net_profit_quote: guardedNetProfitQuote,
              bb_upper_reentry_confirmed: reentryConfirmed,
              bb_reclaim_failed: reclaimFailed,
              orderbook_collapse: orderbookCollapse,
              bb_weakness_votes: weaknessVotes,
              bb_exit_watch_age_seconds: watchAgeSeconds,
              minute_entry_gate: freshMinuteGate,
              live_pressure: livePressure,
              live_imbalance: liveImbalance,
              bid_depth_retention: bidDepthRetention,
              spread_bps: liveSpreadBps,
              held_seconds: heldSeconds,
            }
            : position.metadata?.exit_policy_quote;
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                bb_exit_watch_started_at: watchIso,
                bb_last_minute_gate: freshMinuteGate,
                ...(decision.action === "STOP" ? { exit_policy_quote: exitPolicyQuote } : {}),
              },
            }))[0],
          };
        }
      }

''').lstrip("\n")
replace_between(
    "supabase/functions/market-autotrader/index.ts",
    "      // v7.1.4 volatility-aware LOB exit policy.",
    '      if (decision.action === "NONE") continue;',
    NEW_EXIT_POLICY,
    "PREBREAKOUT-BURST-V1: no planned stop",
)
replace_once(
    "supabase/functions/market-autotrader/index.ts",
    '''          decision.reason === "POSITIVE_NET_AFTER_180S" ||
          decision.reason === "HARD_STOP_MINUS_2";''',
    '''          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";''',
    'decision.reason === "BB_UPPER_REENTRY_CONFIRMED"',
)

MIGRATION = dedent(r'''
-- PREBREAKOUT-BURST-V1
-- LOB positions have no planned stop, experimental arm stop, fixed target, timeout or
-- post-180 profit timer. The only price floor is -2% of executable net. Normal exits are
-- evidence-based: confirmed upper-band re-entry, failed reclaim, or order-book collapse.

create or replace function public.guard_lob_sell_order_v714()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  p public.trading_positions%rowtype;
  v_strategy text;
  v_purpose text;
  v_approved_reason text;
  v_policy text;
  v_quote_price numeric;
  v_quote_at timestamptz;
  v_remaining_qty numeric;
  v_qty numeric;
  v_fee_rate numeric;
  v_unrecovered_cost numeric;
  v_allocated_cost numeric;
  v_net numeric;
  v_net_return_pct numeric;
  v_weakness_votes integer;
  v_reentry boolean;
  v_reclaim_failed boolean;
  v_book_collapse boolean;
begin
  if upper(coalesce(new.side, '')) <> 'SELL' or new.position_id is null then
    return new;
  end if;

  select * into p from public.trading_positions where id = new.position_id;
  if not found or p.is_paper is distinct from false then
    return new;
  end if;
  v_strategy := upper(coalesce(p.metadata#>>'{lob_signal,strategy}', ''));
  if v_strategy <> 'LOB_SCALP' then
    return new;
  end if;

  v_purpose := upper(coalesce(new.purpose, ''));
  v_approved_reason := coalesce(p.metadata#>>'{exit_policy_quote,approved_reason}', '');
  v_policy := coalesce(p.metadata#>>'{exit_policy_quote,burst_policy_version}', '');

  -- Human/emergency and reconciliation exits are operational escape hatches, not strategy
  -- stops. They remain unconditional.
  if v_purpose in ('EMERGENCY', 'MANUAL', 'RECONCILIATION')
     or v_approved_reason in ('RISK_EMERGENCY', 'RECONCILIATION_FAILURE', 'MANUAL_EMERGENCY_CLOSE') then
    return new;
  end if;
  if v_purpose <> 'STOP' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_NON_STOP_EXIT_BLOCKED market=%s purpose=%s', new.market, v_purpose
    );
  end if;

  v_quote_price := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,price}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,executable_vwap}', '')::numeric,
    nullif(p.metadata#>>'{exit_policy_quote,sell_price}', '')::numeric,
    nullif(p.metadata#>>'{live_mark,executable_price}', '')::numeric
  );
  v_quote_at := coalesce(
    nullif(p.metadata#>>'{exit_policy_quote,measured_at}', '')::timestamptz,
    nullif(p.metadata#>>'{live_mark,measured_at}', '')::timestamptz
  );
  if coalesce(v_quote_price, 0) <= 0 or v_quote_at is null or now() - v_quote_at > interval '30 seconds' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_MISSING_OR_STALE_EXECUTABLE_QUOTE market=%s reason=%s',
      new.market, v_approved_reason
    );
  end if;

  v_remaining_qty := greatest(coalesce(p.remaining_quantity, 0), 0);
  v_qty := least(greatest(coalesce(new.requested_volume, 0), 0), v_remaining_qty);
  v_fee_rate := case when lower(p.exchange) = 'upbit' then 0.0005 else 0.001 end;
  v_unrecovered_cost := greatest(
    0,
    coalesce(p.realized_cost_quote, 0) + coalesce(p.paid_fees_quote, 0) -
    coalesce(p.realized_proceeds_quote, 0)
  );
  v_allocated_cost := case when v_remaining_qty > 0
    then v_unrecovered_cost * v_qty / v_remaining_qty else 0 end;
  v_net := v_quote_price * v_qty * (1 - v_fee_rate) - v_allocated_cost;
  v_net_return_pct := case when v_allocated_cost > 0
    then v_net / v_allocated_cost * 100 else 0 end;

  if v_approved_reason = 'HARD_STOP_MINUS_2' and v_net_return_pct <= -2 then
    return new;
  end if;
  if v_policy <> 'PREBREAKOUT-BURST-V1' then
    raise exception using errcode='23514', message=format(
      'BURST_POLICY_REVISION_MISMATCH market=%s policy=%s reason=%s',
      new.market, v_policy, v_approved_reason
    );
  end if;

  v_weakness_votes := greatest(0, coalesce(nullif(
    p.metadata#>>'{exit_policy_quote,bb_weakness_votes}', '')::integer, 0));
  v_reentry := coalesce((p.metadata#>>'{exit_policy_quote,bb_upper_reentry_confirmed}')::boolean, false);
  v_reclaim_failed := coalesce((p.metadata#>>'{exit_policy_quote,bb_reclaim_failed}')::boolean, false);
  v_book_collapse := coalesce((p.metadata#>>'{exit_policy_quote,orderbook_collapse}')::boolean, false);

  if v_approved_reason = 'BB_UPPER_REENTRY_CONFIRMED' and v_reentry and v_weakness_votes >= 2 then
    return new;
  end if;
  if v_approved_reason = 'BB_RECLAIM_FAILED' and v_reclaim_failed and v_weakness_votes >= 1 then
    return new;
  end if;
  if v_approved_reason = 'ORDERBOOK_COLLAPSE' and v_book_collapse then
    return new;
  end if;

  raise exception using errcode='23514', message=format(
    'BURST_POLICY_EXIT_BLOCKED market=%s reason=%s net_return_pct=%s weakness=%s reentry=%s reclaim_failed=%s collapse=%s',
    new.market, v_approved_reason, round(v_net_return_pct, 6), v_weakness_votes,
    v_reentry, v_reclaim_failed, v_book_collapse
  );
end;
$function$;

comment on function public.guard_lob_sell_order_v714() is
  'PREBREAKOUT-BURST-V1: no planned/experimental/time stop or fixed target. Executable-net -2 percent is the only loss floor; normal exits require BB upper re-entry plus weak flow, failed reclaim, or order-book collapse.';
''').lstrip()
write("supabase/migrations/20260802151000_prebreakout_burst_entry_exit_policy.sql", MIGRATION)

DEPLOY_WORKFLOW = dedent(r'''
name: Deploy pre-breakout burst strategy

on:
  push:
    branches: [main]
    paths:
      - "supabase/functions/market-autotrader/**"
      - "supabase/functions/market-scanner/**"
      - "supabase/functions/_shared/**"
      - "supabase/migrations/20260802151000_prebreakout_burst_entry_exit_policy.sql"
      - ".github/workflows/deploy-market-autotrader-v707.yml"
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
    paths:
      - "supabase/functions/market-autotrader/**"
      - "supabase/functions/market-scanner/**"
      - "supabase/functions/_shared/**"
      - ".github/workflows/deploy-market-autotrader-v707.yml"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-prebreakout-burst
  cancel-in-progress: false

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
        with:
          fetch-depth: 0
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: Validate strategy invariants
        run: |
          set -euo pipefail
          deno fmt --check \
            supabase/functions/_shared/lob/minute-entry-gate.ts \
            supabase/functions/_shared/lob/minute-entry-market.ts \
            supabase/functions/_shared/lob/minute-entry-gate.test.ts \
            supabase/functions/_shared/lob/types.ts \
            supabase/functions/_shared/lob/entry.ts \
            supabase/functions/market-scanner/index.ts \
            supabase/functions/market-scanner/engine.ts \
            supabase/functions/market-autotrader/index.ts
          deno test supabase/functions/_shared/lob/minute-entry-gate.test.ts
          deno check supabase/functions/market-scanner/index.ts
          deno check supabase/functions/market-autotrader/index.ts
          grep -q 'M1-BB-PREBREAKOUT-STOCH-14-3-3-V2' supabase/functions/_shared/lob/minute-entry-gate.ts
          grep -q 'M1_CANDLE_ALREADY_EXTENDED' supabase/functions/_shared/lob/minute-entry-gate.ts
          grep -q 'BUY_PRESSURE_NOT_CONFIRMED' supabase/functions/_shared/lob/entry.ts
          grep -q 'const DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000' supabase/functions/market-scanner/index.ts
          grep -q 'PREBREAKOUT-BURST-V1: no planned stop' supabase/functions/market-autotrader/index.ts
          grep -q 'BB_UPPER_REENTRY_CONFIRMED' supabase/functions/market-autotrader/index.ts
          grep -q 'BB_RECLAIM_FAILED' supabase/functions/market-autotrader/index.ts
          grep -q 'ORDERBOOK_COLLAPSE' supabase/functions/market-autotrader/index.ts
          grep -q 'guardedNetReturnPct <= -2' supabase/functions/market-autotrader/index.ts
          ! grep -q 'const exp1ArmWidthsBps' supabase/functions/market-autotrader/index.ts

  deploy:
    needs: validate
    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
        with:
          ref: main
          fetch-depth: 0
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - uses: supabase/setup-cli@3c2f5e2ae34c34e428e8e206e2c4d21fa2d20fbf
        with:
          version: 2.109.1
      - name: Deploy scanner and autotrader
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
        run: |
          set -euo pipefail
          for fn in market-scanner market-autotrader; do
            supabase functions deploy "$fn" --project-ref "${SUPABASE_PROJECT_REF}" --no-verify-jwt --use-api
          done
''').lstrip()
write(".github/workflows/deploy-market-autotrader-v707.yml", DEPLOY_WORKFLOW)

for path, marker in {
    "supabase/functions/_shared/lob/minute-entry-gate.ts": "M1_CANDLE_ALREADY_EXTENDED",
    "supabase/functions/_shared/lob/entry.ts": "BUY_PRESSURE_NOT_CONFIRMED",
    "supabase/functions/market-scanner/index.ts": "DEFAULT_DYNAMIC_OBSERVATION_MS = 15_000",
    "supabase/functions/market-autotrader/index.ts": "PREBREAKOUT-BURST-V1: no planned stop",
    "supabase/migrations/20260802151000_prebreakout_burst_entry_exit_policy.sql": "BURST_POLICY_EXIT_BLOCKED",
}.items():
    if marker not in read(path):
        raise SystemExit(f"{path}: verification marker missing: {marker}")

if "const exp1ArmWidthsBps" in read("supabase/functions/market-autotrader/index.ts"):
    raise SystemExit("experimental EXP-1 arm stop still exists in executable runtime")

print("PREBREAKOUT-BURST-V1 production patch applied")
