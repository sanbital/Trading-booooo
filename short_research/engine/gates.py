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
