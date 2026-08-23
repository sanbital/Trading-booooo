"""Indicators ported line-for-line from supabase/functions/_shared/p10-policy.ts.

Parity with the deployed policy module is the point of this file. Every function below
mirrors a named function in p10-policy.ts, including its seeding and edge-case choices,
because a backtest that computes EMA or ATR "correctly" but differently from production
is measuring a strategy the live system does not run.

Deliberate fidelity choices carried over from the TypeScript:
  * ema()     seeds with values[0] rather than an SMA of the first `period` values.
  * wilder()  seeds with values[0] and smooths from index 1, used for both ATR and RSI.
  * rolling() is inclusive of the current bar; the Donchian channel excludes the current
              bar by reading the series at index-1 (see prepare_bars high72_prev/low72_prev).
  * rsi()     returns 50 when average gain and loss are both zero, 100 when only loss is.
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Sequence

NAN = float("nan")


def _mean(v: Sequence[float]) -> float:
    return sum(v) / len(v) if len(v) else 0.0


def pct(now: float, before: float) -> float:
    return (now / before - 1.0) * 100.0 if before > 0 else 0.0


def ema(values: Sequence[float], period: int) -> list[float]:
    out = [NAN] * len(values)
    if not values:
        return out
    alpha = 2.0 / (period + 1.0)
    v = values[0]
    out[0] = v
    for i in range(1, len(values)):
        v = values[i] * alpha + v * (1.0 - alpha)
        out[i] = v
    return out


def wilder(values: Sequence[float], period: int) -> list[float]:
    out = [NAN] * len(values)
    if not values:
        return out
    v = values[0]
    out[0] = v
    for i in range(1, len(values)):
        v = (v * (period - 1) + values[i]) / period
        out[i] = v
    return out


def rolling(values: Sequence[float], period: int, kind: str) -> list[float]:
    out = [NAN] * len(values)
    for i in range(len(values)):
        s = values[max(0, i - period + 1): i + 1]
        out[i] = max(s) if kind == "max" else min(s) if kind == "min" else _mean(s)
    return out


def efficiency(values: Sequence[float], period: int) -> list[float]:
    out = [0.0] * len(values)
    for i in range(period, len(values)):
        path = 0.0
        for c in range(i - period + 1, i + 1):
            path += abs(values[c] - values[c - 1])
        out[i] = min(1.0, abs(values[i] - values[i - period]) / path) if path > 0 else 0.0
    return out


def rsi(closes: Sequence[float], period: int = 14) -> list[float]:
    n = len(closes)
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        ch = closes[i] - closes[i - 1]
        gains[i] = max(ch, 0.0)
        losses[i] = max(-ch, 0.0)
    ag = wilder(gains, period)
    al = wilder(losses, period)
    out = []
    for i in range(n):
        if al[i] == 0:
            out.append(50.0 if ag[i] == 0 else 100.0)
        else:
            rs = ag[i] / al[i]
            out.append(100.0 - 100.0 / (1.0 + rs))
    return out


@dataclass
class Bar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    quote_volume: float


@dataclass
class PreparedBar(Bar):
    ema20: float = NAN
    ema50: float = NAN
    ema100: float = NAN
    ema20_slope6_pct: float = 0.0
    atr14: float = NAN
    rsi14: float = NAN
    ret24_pct: float = 0.0
    ret72_pct: float = 0.0
    efficiency24: float = 0.0
    high72_prev: float = NAN
    low72_prev: float = NAN
    volume_ratio: float = 0.0
    quote_volume_mean20: float = 0.0
    atr_pct: float = 0.0
    close_location: float = 0.0


def prepare_bars(rows: Sequence[Bar]) -> list[PreparedBar]:
    """Mirror of prepareP10Bars: filter invalid, sort by time, drop duplicate timestamps."""
    bars = [b for b in rows
            if b.time > 0 and b.open > 0 and b.high > 0 and b.low > 0 and b.close > 0]
    bars.sort(key=lambda b: b.time)
    dedup: list[Bar] = []
    for b in bars:
        if not dedup or b.time != dedup[-1].time:
            dedup.append(b)
    bars = dedup
    if not bars:
        return []

    closes = [b.close for b in bars]
    highs = [b.high for b in bars]
    lows = [b.low for b in bars]
    vols = [max(0.0, b.quote_volume or b.volume) for b in bars]

    e20, e50, e100 = ema(closes, 20), ema(closes, 50), ema(closes, 100)
    tr = []
    for i, b in enumerate(bars):
        if i == 0:
            tr.append(b.high - b.low)
        else:
            pc = bars[i - 1].close
            tr.append(max(b.high - b.low, abs(b.high - pc), abs(b.low - pc)))
    atr14 = wilder(tr, 14)
    rsi14 = rsi(closes, 14)
    eff24 = efficiency(closes, 24)
    h72 = rolling(highs, 72, "max")
    l72 = rolling(lows, 72, "min")
    v20 = rolling(vols, 20, "mean")

    out: list[PreparedBar] = []
    for i, b in enumerate(bars):
        rng = b.high - b.low
        p = PreparedBar(
            time=b.time, open=b.open, high=b.high, low=b.low, close=b.close,
            volume=b.volume, quote_volume=b.quote_volume,
            ema20=e20[i], ema50=e50[i], ema100=e100[i],
            ema20_slope6_pct=pct(e20[i], e20[i - 6]) if i >= 6 else 0.0,
            atr14=atr14[i], rsi14=rsi14[i],
            ret24_pct=pct(b.close, bars[i - 24].close) if i >= 24 else 0.0,
            ret72_pct=pct(b.close, bars[i - 72].close) if i >= 72 else 0.0,
            efficiency24=eff24[i],
            high72_prev=h72[i - 1] if i > 0 else b.high,
            low72_prev=l72[i - 1] if i > 0 else b.low,
            volume_ratio=(vols[i] / v20[i]) if v20[i] > 0 else 0.0,
            quote_volume_mean20=v20[i],
        )
        p.atr_pct = (p.atr14 / b.close * 100.0) if b.close > 0 else 0.0
        p.close_location = ((b.close - b.low) / rng) if rng > 0 else 0.0
        out.append(p)
    return out


@dataclass
class BenchmarkState:
    regime: str
    ret24_pct: float
    ret72_pct: float


def benchmark_states(rows: Sequence[Bar]) -> dict[int, BenchmarkState]:
    """Mirror of p10BenchmarkStates, including the index>=100 warm-up floor."""
    bars = prepare_bars(rows)
    out: dict[int, BenchmarkState] = {}
    for i in range(100, len(bars)):
        b = bars[i]
        sep = pct(b.ema20, b.ema50)
        bull = (b.close > b.ema20 and b.ema20 > b.ema50 and b.ema50 > b.ema100
                and sep >= 0.15 and b.ret24_pct >= 0.20 and b.ret72_pct >= 0.5)
        bear = (b.close < b.ema20 and b.ema20 < b.ema50 and b.ema50 < b.ema100
                and sep <= -0.15 and b.ret24_pct <= -0.20 and b.ret72_pct <= -0.5)
        out[b.time] = BenchmarkState(
            regime="BULL" if bull else "BEAR" if bear else "RANGE",
            ret24_pct=b.ret24_pct, ret72_pct=b.ret72_pct)
    return out


LIQUIDITY_FLOOR = {"upbit_spot": 100_000_000, "binance_futures": 500_000,
                   "binance_spot": 100_000}
ROUND_TRIP_COST_BPS = {"upbit_spot": 20, "binance_futures": 18, "binance_spot": 26}
