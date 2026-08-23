"""SHORT strategy backtest engine with production-consistent execution.

Execution model, chosen to match the live system rather than to flatter the results:

  * Signals are evaluated on CLOSED bars only. The bar that produces a signal at time T is
    fully closed; production drops the in-progress candle via floor(now/1h)*1h - 1.
  * Entry fills at the OPEN of the next bar (production's nextBarEntry), never at the
    signal bar's close, and is rejected if |entry - referenceClose| / atr14 exceeds
    maxEntryGapAtr, exactly as planP10Entry does.
  * Within a bar, stop is tested before targets. Production's evaluateP10Exit returns STOP
    ahead of TARGET_2 and TARGET_1, and when a bar's range covers both we cannot know the
    path, so STOP_FIRST is both production-consistent and the conservative choice.
  * Trailing and rule exits update only when a bar has CLOSED, mirroring the
    `bar.time > lastPolicyBarTime` guard, so a trail can never tighten using a high the
    market has not printed yet.
  * A bar's high/low is never read before that bar is closed, so no entry decision can see
    its own outcome.

Costs are always charged: taker fee both sides on notional, slippage in bps against the
fill on both sides, and funding on every funding timestamp the position spans.
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Optional

from .indicators import PreparedBar, pct
from .gates import regime_eligible, P10_CONFIG

HOUR_MS = 3_600_000


def round_quantity(qty: float, step: float) -> float:
    if step <= 0:
        return qty
    return math.floor((qty + step * 1e-9) / step) * step


def round_price(price: float, tick: float, direction: str) -> float:
    if tick <= 0:
        return price
    n = price / tick
    return (math.floor(n + 1e-9) if direction == "down" else math.ceil(n - 1e-9)) * tick


def validate_size(qty: float, price: float, rules: dict) -> Optional[str]:
    if qty <= 0:
        return "QTY_ZERO_AFTER_ROUNDING"
    if qty < rules.get("min_qty", 0.0):
        return "BELOW_MIN_QTY"
    if qty * price < rules.get("min_notional", 0.0):
        return "BELOW_MIN_NOTIONAL"
    return None


@dataclass
class Costs:
    taker_fee_pct: float = 0.05      # per side, percent of notional
    slippage_bps: float = 5.0        # per side, always against the fill

    def fill_price(self, price: float, side: str, opening: bool) -> float:
        selling = (side == "SHORT" and opening) or (side == "LONG" and not opening)
        adj = self.slippage_bps / 10_000.0
        return price * (1 - adj) if selling else price * (1 + adj)

    def fee(self, notional: float) -> float:
        return abs(notional) * self.taker_fee_pct / 100.0


@dataclass
class Trade:
    strategy_id: str
    symbol: str
    side: str
    signal_time: int
    entry_time: int
    entry_price: float
    quantity: float
    notional: float
    margin: float
    initial_risk: float
    stop_price: float
    exit_time: int = 0
    exit_price: float = 0.0
    exit_reason: str = ""
    gross_pnl: float = 0.0
    fees: float = 0.0
    funding: float = 0.0
    slippage_cost: float = 0.0
    net_pnl: float = 0.0
    mfe_r: float = 0.0
    mae_r: float = 0.0
    holding_bars: int = 0
    partial_done: bool = False
    legs: list = field(default_factory=list)

    @property
    def return_pct_on_margin(self) -> float:
        return self.net_pnl / self.margin * 100.0 if self.margin > 0 else 0.0


def _swing_high(bars: list[PreparedBar], i: int, lookback: int) -> float:
    lo = max(0, i - lookback + 1)
    return max(b.high for b in bars[lo:i + 1])


def _atr_percentile(bars: list[PreparedBar], i: int, lookback: int) -> float:
    lo = max(0, i - lookback + 1)
    window = [b.atr_pct for b in bars[lo:i + 1] if b.atr_pct == b.atr_pct]
    if not window:
        return 50.0
    cur = bars[i].atr_pct
    return 100.0 * sum(1 for x in window if x <= cur) / len(window)


def entry_triggered(spec: dict, bars: list[PreparedBar], i: int) -> tuple[bool, Optional[float]]:
    """Structural entry rule. Returns (triggered, explicit_trigger_price_or_None).

    Reads only bars up to and including i, and only fields of bar i known at its close.
    """
    rule = spec["entry"]["rule"]
    p = spec["entry"]["params"]
    b, prev = bars[i], bars[i - 1]
    n = p.get("n", 72)

    if rule == "DONCHIAN_BREAKDOWN":
        lvl = b.low72_prev
        ok = b.close < lvl - p.get("buffer_atr", 0.0) * b.atr14
        if p.get("require_prior_inside", True):
            ok = ok and prev.close >= lvl
        return ok, None

    if rule == "DONCHIAN_BREAKDOWN_INTRABAR":
        lvl = b.low72_prev
        trigger = lvl - p.get("buffer_atr", 0.0) * b.atr14
        prior = prev.close >= lvl if p.get("require_prior_inside", True) else True
        return (b.low < trigger and prior), trigger

    if rule == "DONCHIAN_BREAKDOWN_CONFIRMED":
        k = p.get("confirm_closes", 2)
        if i - k < 0:
            return False, None
        lvl = bars[i - k + 1].low72_prev
        closes_below = all(bars[i - j].close < lvl - p.get("buffer_atr", 0.0) * bars[i - j].atr14
                           for j in range(k))
        return (closes_below and bars[i - k].close >= lvl), None

    if rule == "BREAKDOWN_RETEST_REJECT":
        w = p.get("retest_window_bars", 6)
        tol = p.get("reject_tolerance_atr", 0.25)
        for j in range(max(1, i - w), i):
            lvl = bars[j].low72_prev
            if bars[j].close < lvl and bars[j - 1].close >= lvl:
                if b.high >= lvl - tol * b.atr14 and b.close < lvl and b.close < b.open:
                    return True, None
        return False, None

    if rule == "FAILED_RECLAIM_DONCHIAN":
        w = p.get("reclaim_window_bars", 8)
        for j in range(max(1, i - w), i):
            lvl = bars[j].low72_prev
            if bars[j].close < lvl and bars[j - 1].close >= lvl:
                if any(bars[k].close > lvl for k in range(j + 1, i)) \
                        and b.close < lvl and b.close < b.open:
                    return True, None
        return False, None

    if rule == "FAILED_RECLAIM_EMA":
        e = p.get("ema", 20)
        w = p.get("reclaim_window_bars", 6)
        val = (lambda x: x.ema20) if e == 20 else (lambda x: x.ema50)
        below_before = any(bars[j].close < val(bars[j]) for j in range(max(1, i - w), i))
        return (below_before and b.high >= val(b) and b.close < val(b) and b.close < b.open), None

    if rule == "LOWER_HIGH_BREAKDOWN":
        lb = p.get("swing_lookback", 12)
        need = p.get("min_lower_highs", 2)
        if i < lb * (need + 1):
            return False, None
        highs = [_swing_high(bars, i - lb * k, lb) for k in range(need + 1)]
        descending = all(highs[k] < highs[k + 1] for k in range(need))
        return (descending and b.close < bars[i - 1].low and b.close < b.open), None

    if rule == "MOMENTUM_CONTINUATION":
        ok = b.ret24_pct <= p.get("ret24_max_pct", -3.0) and b.close < b.open
        if p.get("require_ema_stack", True):
            ok = ok and b.ema20 < b.ema50 < b.ema100
        return ok, None

    if rule == "EMA_STACK_BEARISH":
        sep = abs(pct(b.ema20, b.ema50))
        return (b.ema20 < b.ema50 < b.ema100 and sep >= p.get("min_separation_pct", 0.15)
                and b.close < b.ema100 and b.close < b.open), None

    if rule == "EMA_PULLBACK_SHORT":
        t = p.get("trend_ema", 100)
        trend = b.close < (b.ema100 if t == 100 else b.ema50)
        near = abs(b.high - b.ema20) <= p.get("max_pullback_atr", 1.0) * b.atr14
        return (trend and near and b.close < b.ema20 and b.close < b.open), None

    if rule == "RSI_MOMENTUM":
        k = p.get("rsi_falling_bars", 3)
        if i - k - 1 < 0:
            return False, None
        falling = all(bars[i - j].rsi14 < bars[i - j - 1].rsi14 for j in range(k))
        return (b.rsi14 <= p.get("rsi_max", 40) and falling and b.close < b.open), None

    if rule == "SQUEEZE_EXPANSION_BREAKDOWN":
        sl = p.get("squeeze_lookback", 48)
        was_squeezed = _atr_percentile(bars, i - 1, sl) <= p.get("squeeze_pct", 30)
        expanding = (bars[i - 1].atr14 > 0
                     and b.atr14 / bars[i - 1].atr14 >= p.get("expansion_atr_ratio", 1.3))
        lvl = b.low72_prev
        return (was_squeezed and expanding and b.close < lvl and prev.close >= lvl), None

    raise ValueError(f"unknown entry rule {rule}")


def regime_ok(spec: dict, bar_time: int, ctx: dict) -> bool:
    mode = spec["regime"]["mode"]
    p = spec["regime"].get("params", {})
    if mode == "NONE":
        return True
    if mode == "SYMMETRIC_P10":
        st = ctx["benchmarks"].get(p.get("benchmark", "BTCUSDT"), {}).get(bar_time)
        return bool(st) and regime_eligible(st, "SHORT")
    if mode == "BENCHMARK_BEAR_ONLY":
        st = ctx["benchmarks"].get(p.get("benchmark", "BTCUSDT"), {}).get(bar_time)
        return bool(st) and st.regime == "BEAR"
    if mode == "DUAL_BENCHMARK_BEAR":
        for name in p.get("benchmarks", []):
            st = ctx["benchmarks"].get(name, {}).get(bar_time)
            if not st or st.regime != "BEAR":
                return False
        return True
    if mode == "BREADTH_BEAR":
        share_up = ctx["breadth"].get(bar_time)
        return share_up is not None and share_up <= p.get("max_share_up", 0.40)
    raise ValueError(f"unknown regime mode {mode}")


def filters_ok(spec: dict, bars: list[PreparedBar], i: int, symbol: str, ctx: dict) -> bool:
    f = spec["filters"]
    b, prev = bars[i], bars[i - 1]
    if b.atr14 <= 0 or prev.atr14 <= 0 or b.close <= 0 or b.high <= b.low:
        return False
    if b.volume_ratio < f.get("min_volume_ratio", 0.0):
        return False
    if b.quote_volume_mean20 < f.get("liquidity_floor_quote_mean20", 0.0):
        return False
    lo, hi = f.get("atr_pct_range", [0.15, 6.0])
    if b.atr_pct < lo or b.atr_pct > hi:
        return False
    stop_mult = spec["stop"].get("mult") or P10_CONFIG["stopAtr"]
    if spec["stop"]["method"] == "ATR" and stop_mult * b.atr_pct > 5:
        return False
    r_lo, r_hi = f.get("ret24_pct_range", [-1e9, 1e9])
    if not (r_lo <= b.ret24_pct <= r_hi):
        return False
    q_lo, q_hi = f.get("rsi14_range", [0, 100])
    if not (q_lo <= b.rsi14 <= q_hi):
        return False
    if f.get("min_close_location") is not None and (1.0 - b.close_location) < f["min_close_location"]:
        return False
    if f.get("min_ema_slope6_pct") is not None and -b.ema20_slope6_pct < f["min_ema_slope6_pct"]:
        return False
    if f.get("require_ema20_below_ema50") and not (b.ema20 < b.ema50):
        return False
    if f.get("require_bearish_candle") and not (b.close < b.open):
        return False
    ov = f.get("overextension_max_abs_ret24_pct")
    if ov is not None and abs(b.ret24_pct) > ov:
        return False
    rk = f.get("extreme_mover_rank_guard")
    if rk is not None:
        rank = ctx.get("decliner_rank", {}).get((b.time, symbol))
        if rank is not None and rank <= rk:
            return False
    fr = f.get("funding_rate_min")
    if fr is not None:
        rate = ctx.get("funding_at", {}).get((symbol, b.time))
        if rate is None or rate < fr:
            return False
    qp = f.get("min_quote_volume_percentile")
    if qp is not None:
        v = ctx.get("liquidity_percentile", {}).get((b.time, symbol))
        if v is None or v < qp:
            return False
    return True


def generate_signals(spec: dict, symbol: str, bars: list[PreparedBar], ctx: dict,
                     window: tuple[int, int]) -> list[dict]:
    """All signal bars for one symbol. `window` bounds the SIGNAL bar time, not the exit."""
    out = []
    start, end = window
    for i in range(1, len(bars)):
        b = bars[i]
        if b.time < start or b.time > end:
            continue
        if i + 1 < spec.get("min_history_bars", 106):
            continue
        if not regime_ok(spec, b.time, ctx):
            continue
        if not filters_ok(spec, bars, i, symbol, ctx):
            continue
        trig, trigger_price = entry_triggered(spec, bars, i)
        if not trig:
            continue
        out.append(dict(symbol=symbol, index=i, signal_time=b.time,
                        reference_close=b.close, atr14=b.atr14,
                        trigger_price=trigger_price,
                        score=-b.ret24_pct + b.volume_ratio * 0.25 + b.efficiency24))
    return out


# --------------------------------------------------------------------------------------
# trade simulation
# --------------------------------------------------------------------------------------
def _stop_from_spec(spec: dict, bars: list[PreparedBar], sig_i: int, entry: float) -> float:
    m = spec["stop"]
    atr = bars[sig_i].atr14
    if m["method"] == "ATR":
        return entry + (m.get("mult") or 2.0) * atr
    if m["method"] == "SWING_HIGH":
        sw = _swing_high(bars, sig_i, m.get("lookback", 12))
        return sw + m.get("buffer_atr", 0.0) * atr
    raise ValueError(f"unknown stop method {m['method']}")


def _trail_stop(spec: dict, bars: list[PreparedBar], j: int, cur: float, entry: float,
                risk: float) -> float:
    """Tighten the stop from the last CLOSED bar only. SHORT stops move down, never up."""
    t = spec["trailing"]
    method = t.get("method")
    if method in (None, "NONE"):
        return cur
    b = bars[j]
    fav_r = (entry - b.close) / risk if risk > 0 else 0.0
    if t.get("activation") == "FAVORABLE_CLOSE_R_GT_0" and fav_r <= 0:
        return cur
    if method == "ATR":
        return min(cur, b.close + (t.get("mult") or 2.5) * b.atr14)
    if method == "DONCHIAN":
        n = t.get("n", 20)
        lo = max(0, j - n + 1)
        return min(cur, max(x.high for x in bars[lo:j + 1]))
    if method == "EMA":
        return min(cur, b.ema20)
    if method == "VOL_SCALED":
        p = _atr_percentile(bars, j, t.get("atr_percentile_lookback", 48))
        mult = t.get("low_vol_mult", 1.5) if p <= 50 else t.get("high_vol_mult", 3.5)
        return min(cur, b.close + mult * b.atr14)
    raise ValueError(f"unknown trailing method {method}")


def _funding_between(symbol: str, t0: int, t1: int, notional: float, side: str,
                     funding: dict) -> float:
    """Funding for every settlement stamp strictly after entry and at or before exit.

    A SHORT receives when the rate is positive (longs pay shorts) and pays when negative.
    """
    total = 0.0
    sign = 1.0 if side == "SHORT" else -1.0
    for ts, rate in funding.get(symbol, ()):
        if t0 < ts <= t1:
            total += sign * rate * notional
    return total


def simulate_trade(spec: dict, symbol: str, bars: list[PreparedBar], sig: dict,
                   rules: dict, costs: Costs, funding: dict,
                   ctx: dict, sizing: dict) -> tuple[Optional[Trade], Optional[str]]:
    """Simulate one SHORT trade. Returns (trade, rejection_reason)."""
    side = "SHORT"
    i = sig["index"]
    intrabar = spec["entry"]["timing"] == "INTRABAR_TRIGGER"

    if intrabar:
        entry_bar = i
        raw_entry = sig["trigger_price"]
        first_exit_bar = i + 1     # no intrabar path data; evaluate exits from the next bar
    else:
        entry_bar = i + 1
        if entry_bar >= len(bars):
            return None, "NO_NEXT_BAR"
        raw_entry = bars[entry_bar].open
        first_exit_bar = entry_bar

    atr = sig["atr14"]
    if not (atr > 0) or not (raw_entry > 0):
        return None, "INVALID_ENTRY"

    gap_atr = abs(raw_entry - sig["reference_close"]) / atr
    if gap_atr > spec["entry"].get("max_entry_gap_atr", 0.50):
        return None, "ENTRY_GAP_EXCEEDED"

    stop0 = _stop_from_spec(spec, bars, i, raw_entry)
    risk = stop0 - raw_entry
    if risk <= 0:
        return None, "INVALID_RISK"
    risk_pct = risk / raw_entry * 100.0
    if risk_pct > spec["entry"].get("max_initial_risk_pct", 5.0):
        return None, "RISK_PCT_EXCEEDED"

    entry_price = costs.fill_price(raw_entry, side, opening=True)
    entry_price = round_price(entry_price, rules.get("tick_size", 0.0), "down")

    margin = sizing["margin_per_slot"]
    notional_target = margin * sizing["leverage"]
    qty = round_quantity(notional_target / entry_price, rules.get("step_size", 0.0))
    bad = validate_size(qty, entry_price, rules)
    if bad:
        return None, bad
    notional = qty * entry_price

    tr = Trade(strategy_id=spec["strategy_id"], symbol=symbol, side=side,
               signal_time=sig["signal_time"], entry_time=bars[entry_bar].time,
               entry_price=entry_price, quantity=qty, notional=notional, margin=margin,
               initial_risk=risk, stop_price=stop0)
    tr.slippage_cost += abs(entry_price - raw_entry) * qty
    tr.fees += costs.fee(notional)

    tp = spec["take_profit"]
    final_target = raw_entry - tp["r"] * risk if tp.get("method") == "R_MULTIPLE" else None
    pe = spec["partial_exit"]
    partial_target = raw_entry - pe["at_r"] * risk if pe.get("enabled") else None
    be = spec.get("breakeven", {})

    stop = stop0
    remaining = qty
    realized = 0.0
    partial_done = False
    max_hold = spec.get("max_holding_bars", 96)
    loss_time = spec.get("loss_time_stop_bars", 24)
    rx = spec.get("rule_exits", {})

    def close_leg(price_raw: float, frac: float, reason: str, ts: int):
        nonlocal remaining, realized
        q = remaining if frac >= 1.0 else round_quantity(qty * frac, rules.get("step_size", 0.0))
        q = min(q, remaining)
        if q <= 0:
            return
        fill = costs.fill_price(price_raw, side, opening=False)
        fill = round_price(fill, rules.get("tick_size", 0.0), "up")
        realized += (entry_price - fill) * q
        tr.slippage_cost += abs(fill - price_raw) * q
        tr.fees += costs.fee(q * fill)
        tr.legs.append(dict(time=ts, price=fill, qty=q, reason=reason))
        remaining -= q
        tr.exit_time, tr.exit_price, tr.exit_reason = ts, fill, reason

    for j in range(first_exit_bar, len(bars)):
        b = bars[j]
        held = j - entry_bar + 1
        tr.holding_bars = held

        fav = (raw_entry - b.low) / risk
        adv = (b.high - raw_entry) / risk
        tr.mfe_r = max(tr.mfe_r, fav)
        tr.mae_r = max(tr.mae_r, adv)

        if b.high >= stop:                                    # STOP_FIRST
            close_leg(stop, 1.0, "STOP", b.time)
            break
        if final_target is not None and b.low <= final_target:
            close_leg(final_target, 1.0, "TARGET_FINAL", b.time)
            break
        if partial_target is not None and not partial_done and b.low <= partial_target:
            close_leg(partial_target, pe["fraction"], "PARTIAL", b.time)
            partial_done = True
            tr.partial_done = True
            if remaining <= 0:
                break

        # bar has closed: policy updates for the NEXT bar
        if be.get("enabled"):
            fav_close_r = (raw_entry - b.close) / risk
            if fav_close_r >= be.get("at_r", 1.5):
                cost_rate = 18.0 * be.get("cost_stress_multiple", 1.5) / 10_000.0
                stop = min(stop, raw_entry * (1 - cost_rate))
        stop = _trail_stop(spec, bars, j, stop, raw_entry, risk)

        reason = None
        er = rx.get("ema_reclaim")
        if er == "EMA20" and b.close > b.ema20:
            reason = "EMA20_CLOSE"
        elif er == "EMA50" and b.close > b.ema50:
            reason = "EMA50_CLOSE"
        dn = rx.get("donchian_reclaim_n")
        if reason is None and dn:
            lo = max(0, j - dn + 1)
            prior = bars[lo:j]
            if prior and b.close > max(x.high for x in prior):
                reason = f"DONCHIAN{dn}_RECLAIM"
        mr = rx.get("momentum_reversal_rsi_above")
        if reason is None and mr is not None and b.rsi14 > mr:
            reason = "MOMENTUM_REVERSAL"
        if reason is None and rx.get("regime_reversal"):
            st = ctx["benchmarks"].get("BTCUSDT", {}).get(b.time)
            if st and st.regime == "BULL":
                reason = "REGIME_REVERSAL"
        if reason is None and held >= loss_time and b.close >= raw_entry:
            reason = "LOSS_TIME_STOP"
        if reason is None and held >= max_hold:
            reason = "MAX_HOLD"
        if reason:
            close_leg(b.close, 1.0, reason, b.time)
            break
    else:
        close_leg(bars[-1].close, 1.0, "DATASET_END", bars[-1].time)

    if remaining > 0:                       # partial filled but loop ended without a close
        close_leg(bars[min(len(bars) - 1, entry_bar + max_hold)].close, 1.0,
                  tr.exit_reason or "MAX_HOLD", tr.exit_time or bars[-1].time)

    tr.gross_pnl = realized
    tr.funding = _funding_between(symbol, tr.entry_time, tr.exit_time, notional, side, funding)
    # slippage is already inside every fill price, so it is reported but NOT subtracted
    # again here -- doing both would charge it twice.
    tr.net_pnl = tr.gross_pnl + tr.funding - tr.fees
    return tr, None


# --------------------------------------------------------------------------------------
# portfolio replay
# --------------------------------------------------------------------------------------
def portfolio_replay(spec: dict, signals_by_symbol: dict, prepared: dict, rules_by_symbol: dict,
                     costs: Costs, funding: dict, ctx: dict, sizing: dict,
                     long_trades: Optional[list] = None) -> dict:
    """Replay signals in time order under the live slot, cooldown and per-scan limits.

    Summing per-symbol trades would let the book hold far more positions than production
    can, so every entry here has to win a slot the same way it would live: one position per
    symbol, a shared slot pool (shared with LONG when long_trades is supplied), at most
    max_new_entries_per_scan opened at any one timestamp, and a per-symbol cooldown.
    """
    all_sigs = []
    for sym, sigs in signals_by_symbol.items():
        all_sigs.extend(sigs)
    # deterministic: by signal time, then best score, then symbol
    all_sigs.sort(key=lambda s: (s["signal_time"], -s["score"], s["symbol"]))

    max_slots = sizing["max_positions"]
    per_scan = sizing["max_new_entries_per_scan"]
    cooldown_ms = spec.get("cooldown_bars", 0) * HOUR_MS

    occupied: list[dict] = []          # [{symbol, side, entry_time, exit_time}]
    if long_trades:
        for t in long_trades:
            occupied.append(dict(symbol=t.symbol, side="LONG",
                                 entry_time=t.entry_time, exit_time=t.exit_time))

    taken: list[Trade] = []
    rejected: dict[str, int] = {}
    last_exit_by_symbol: dict[str, int] = {}
    opened_at_ts: dict[int, int] = {}

    def bump(reason: str):
        rejected[reason] = rejected.get(reason, 0) + 1

    for sig in all_sigs:
        ts = sig["signal_time"]
        sym = sig["symbol"]
        entry_ts = ts + HOUR_MS

        live = [o for o in occupied if o["entry_time"] <= entry_ts < o["exit_time"]]
        if any(o["symbol"] == sym for o in live):
            bump("SYMBOL_ALREADY_OPEN"); continue
        if len(live) >= max_slots:
            bump("NO_SLOT"); continue
        if opened_at_ts.get(ts, 0) >= per_scan:
            bump("MAX_NEW_ENTRIES_PER_SCAN"); continue
        if cooldown_ms and entry_ts - last_exit_by_symbol.get(sym, -10**18) < cooldown_ms:
            bump("COOLDOWN"); continue

        tr, why = simulate_trade(spec, sym, prepared[sym], sig,
                                 rules_by_symbol.get(sym, {}), costs, funding, ctx, sizing)
        if tr is None:
            bump(why or "REJECTED"); continue

        taken.append(tr)
        occupied.append(dict(symbol=sym, side="SHORT",
                             entry_time=tr.entry_time, exit_time=tr.exit_time))
        last_exit_by_symbol[sym] = tr.exit_time
        opened_at_ts[ts] = opened_at_ts.get(ts, 0) + 1

    return dict(trades=taken, signals=len(all_sigs), rejected=rejected)
