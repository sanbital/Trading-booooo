"""Production signal gates, ported from p10SignalEligible / p10SignalScore / p10RegimeEligible.

Kept in one place and diffed against the deployed module by parity/check_gates.py so the
SHORT research runs the same admission logic the live system runs, not an approximation.
The functions are side-generic exactly as production is: the LONG and SHORT branches in
p10-policy.ts differ only by `direction`, so any asymmetry here would be a porting bug.
"""
from __future__ import annotations
from .indicators import PreparedBar, BenchmarkState, LIQUIDITY_FLOOR  # noqa: F401

P10_CONFIG = dict(
    breakoutLookback=72, breakoutBufferAtr=0.10, minVolumeRatio=1.60,
    trendMinPct=1.20, trendMaxPct=20.0, minCloseLocation=0.74,
    minEmaSlope6Pct=0.10, maxEntryGapAtr=0.50, stopAtr=2.00, targetR=5.00,
    trailAtr=2.50, breakEvenAtR=1.50, partialAtR=2.00, partialFraction=0.40,
    lossTimeStopBars=24, maxHoldBars=96,
)


def regime_eligible(state, side: str) -> bool:
    if side == "LONG":
        return state.regime != "BEAR" and state.ret24_pct >= 0.10 and state.ret72_pct >= 0
    return state.regime != "BULL" and state.ret24_pct <= -0.10 and state.ret72_pct <= 0


def signal_score(bar, state, side: str) -> float:
    d = 1.0 if side == "LONG" else -1.0
    return (d * bar.ret24_pct + d * (bar.ret24_pct - state.ret24_pct)
            + bar.volume_ratio * 0.25 + bar.efficiency24)


def signal_eligible(bar, previous, state, side: str, liquidity_floor: float) -> bool:
    long = side == "LONG"
    d = 1.0 if long else -1.0
    C = P10_CONFIG
    if (not regime_eligible(state, side) or bar.atr14 <= 0 or previous.atr14 <= 0
            or bar.close <= 0 or bar.high <= bar.low
            or bar.volume_ratio < C["minVolumeRatio"]
            or bar.quote_volume_mean20 < liquidity_floor):
        return False
    atr_pct = bar.atr14 / bar.close * 100.0
    if atr_pct < 0.15 or atr_pct > 6 or C["stopAtr"] * atr_pct > 5:
        return False
    dir_ret24 = d * bar.ret24_pct
    if dir_ret24 < C["trendMinPct"] or dir_ret24 > C["trendMaxPct"]:
        return False
    close_loc = (bar.close - bar.low) / (bar.high - bar.low)
    dir_close_loc = close_loc if long else 1.0 - close_loc
    candle_dir = bar.close > bar.open if long else bar.close < bar.open
    ema_dir = bar.ema20 > bar.ema50 if long else bar.ema20 < bar.ema50
    rsi_dir = (48 <= bar.rsi14 <= 84) if long else (16 <= bar.rsi14 <= 52)
    if (not candle_dir or not ema_dir or not rsi_dir
            or d * bar.ema20_slope6_pct < C["minEmaSlope6Pct"]
            or dir_close_loc < C["minCloseLocation"]):
        return False
    if long:
        return (bar.close > bar.high72_prev + C["breakoutBufferAtr"] * bar.atr14
                and previous.close <= bar.high72_prev)
    return (bar.close < bar.low72_prev - C["breakoutBufferAtr"] * bar.atr14
            and previous.close >= bar.low72_prev)


def detect_latest_signal(venue: str, prepared, states, permitted=None):
    """Mirror of detectLatestP10Signal: evaluate only the final prepared bar."""
    if len(prepared) < 106:
        return None
    bar, previous = prepared[-1], prepared[-2]
    state = states.get(bar.time)
    if state is None:
        return None
    if permitted is None:
        permitted = ["LONG", "SHORT"] if venue == "binance_futures" else ["LONG"]
    floor = LIQUIDITY_FLOOR[venue]
    eligible = [s for s in permitted if signal_eligible(bar, previous, state, s, floor)]
    if not eligible:
        return None
    eligible.sort(key=lambda s: signal_score(bar, state, s), reverse=True)
    side = eligible[0]
    return dict(
        side=side, signal_time=bar.time, reference_close=bar.close, atr14=bar.atr14,
        score=signal_score(bar, state, side),
        stop_reference=(bar.close - P10_CONFIG["stopAtr"] * bar.atr14 if side == "LONG"
                        else bar.close + P10_CONFIG["stopAtr"] * bar.atr14),
        benchmark=state,
    )


# =======================================================================================
# I46_HYBRID_SCORE_L1 -- the LIVE entry strategy on binance_futures and binance_spot.
#
# Ported from detectI46 / i46Check in the deployed market-v2-signal (v8,
# ezbr 567427c0…). P10 was retired for the Binance venues on 2026-08-22
# (config_key P10_DONCHIAN_BREAKOUT_RETIRED_20260822); v2_strategy_registry now records
# binance_futures as revision I46-LIVE-1.0.0 with strategy_key I46_HYBRID_SCORE_L1 and
# execution_config_key P10_DONCHIAN_BREAKOUT_E10_SLOW_4R. So the live model is
# I46 entry + P10 exit, and I46 is what a "production symmetric SHORT" has to mirror.
#
# I46 has NO breakout requirement. It is a gate stack plus an 8-condition hybrid score
# that must reach 5. Its thresholds are materially looser than P10's on every axis that
# matters for SHORT: benchmark tolerance, volume ratio, directional 24h return, close
# location, EMA slope and the RSI band.
# =======================================================================================

I46_STRATEGY_KEY = "I46_HYBRID_SCORE_L1"
I46_REVISION = "I46-LIVE-1.0.0"
I46_MIN_SCORE = 5


def i46_check(bar, previous, state, side: str, liquidity_floor: float):
    """Return the score payload when the bar qualifies, else None. Mirrors i46Check."""
    long = side == "LONG"
    d = 1.0 if long else -1.0
    if (d * state.ret24_pct < -0.50 or d * state.ret72_pct < -2
            or bar.atr14 <= 0 or previous.atr14 <= 0 or bar.high <= bar.low
            or bar.quote_volume_mean20 < liquidity_floor):
        return None
    ap = bar.atr14 / bar.close * 100.0
    if ap < 0.15 or ap > 6 or 2 * ap > 5:
        return None
    r24 = d * bar.ret24_pct
    cl = (bar.close - bar.low) / (bar.high - bar.low)
    dl = cl if long else 1.0 - cl
    if bar.volume_ratio < 1 or r24 < 0.2 or r24 > 20 or dl < 0.58 or d * bar.ema20_slope6_pct < 0:
        return None
    candle = bar.close > bar.open if long else bar.close < bar.open
    ema_dir = bar.ema20 > bar.ema50 if long else bar.ema20 < bar.ema50
    rsi_dir = (46 <= bar.rsi14 <= 86) if long else (14 <= bar.rsi14 <= 54)
    if not candle or not ema_dir or not rsi_dir:
        return None
    rel24 = d * (bar.ret24_pct - state.ret24_pct)
    m3, m6, m12 = d * bar.ret3_pct, d * bar.ret6_pct, d * bar.ret12_pct
    s3 = d * bar.ema20_slope3_pct
    score = 0
    if m3 >= 0.15: score += 1
    if m6 >= 0.30: score += 1
    if m12 >= 0.50: score += 1
    if bar.volume_ratio >= 1.20: score += 1
    if bar.range_atr >= 0.80: score += 1
    if bar.efficiency24 >= 0.10: score += 1
    if rel24 >= 0: score += 1
    if s3 >= 0.02: score += 1
    if score < I46_MIN_SCORE:
        return None
    return dict(score=score, rel24=rel24, dl=dl, m3=m3, m6=m6, m12=m12, s3=s3)


def detect_latest_i46(venue: str, prepared, states, permitted=None):
    """Mirror of detectI46: last bar only; ties broken on relative 24h return."""
    if venue == "upbit_spot" or len(prepared) < 106:
        return None
    bar, previous = prepared[-1], prepared[-2]
    state = states.get(bar.time)
    if state is None:
        return None
    if permitted is None:
        permitted = ["LONG", "SHORT"] if venue == "binance_futures" else ["LONG"]
    floor = LIQUIDITY_FLOOR[venue]
    xs = [(s, i46_check(bar, previous, state, s, floor)) for s in permitted]
    xs = [(s, c) for s, c in xs if c]
    if not xs:
        return None
    if len(xs) > 1:
        xs.sort(key=lambda x: x[1]["rel24"], reverse=True)
    side, chk = xs[0]
    d = 1.0 if side == "LONG" else -1.0
    return dict(side=side, signal_time=bar.time, reference_close=bar.close,
                atr14=bar.atr14, score=chk["score"],
                stop_reference=bar.close - d * 2 * bar.atr14,
                benchmark=state, check=chk)
