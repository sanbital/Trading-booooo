"""Run the frozen S01..S50 over a frozen dataset and emit the result tables.

Every strategy sees the same universe, the same bars, the same funding, the same windows,
the same capital, fees, slippage and slot constraints. A strategy that produces zero trades
is still a result and is still reported; a strategy is never dropped for being unprofitable.
"""
from __future__ import annotations
import argparse, csv, json, math, pathlib, sys, time
from datetime import datetime, timezone, timedelta

from . import dataset as DS
from . import indicators as I
from . import metrics as M
from .backtest import Costs, portfolio_replay, generate_signals, simulate_trade
from .gates import signal_eligible, signal_score

KST = timezone(timedelta(hours=9))
HOUR_MS = 3_600_000


# Frozen dataset boundaries, fixed by the study spec and not derived from the data.
FROZEN = dict(
    warmup_start_utc="2026-07-24T00:00:00Z",
    primary_start_utc="2026-08-22T07:45:00Z",
    primary_end_utc="2026-08-23T07:45:00Z",
)


def _ms(iso: str) -> int:
    return int(datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")
               .replace(tzinfo=timezone.utc).timestamp() * 1000)


def last_closed_signal_bar(boundary_ms: int) -> int:
    """open_time of the newest bar fully closed at `boundary_ms`.

    A bar with open_time T closes at T+1h, so it is usable only when T + 1h <= boundary.
    This matches production's own cutoff, endTime = floor(now/1h)*1h - 1: at 07:45 that is
    06:59:59.999, whose newest kline has open_time 06:00. The 07:00-08:00 bar is still
    forming and must not be read.
    """
    return ((boundary_ms - HOUR_MS) // HOUR_MS) * HOUR_MS


def first_signal_bar_after(boundary_ms: int) -> int:
    """open_time of the first bar whose CLOSE lands strictly after `boundary_ms`.

    A bar becomes actionable only when it closes, so a window that opens at 07:45 starts
    with the bar closing at 08:00 -- open_time 07:00.
    """
    return (boundary_ms // HOUR_MS) * HOUR_MS


def frozen_windows() -> dict[str, tuple[int, int]]:
    """Signal-bar open_time bounds for each evaluation window.

    The bounds constrain the SIGNAL bar, not the exit: a trade opened inside a window runs
    to its own exit, and one still open when the data ends is closed at the last bar and
    tagged DATASET_END so truncation stays visible.
    """
    end = last_closed_signal_bar(_ms(FROZEN["primary_end_utc"]))
    start = first_signal_bar_after(_ms(FROZEN["primary_start_utc"]))
    d = 24 * HOUR_MS
    return {
        "primary_24h": (start, end),
        "prior_24h":   (start - d, end - d),
        "recent_72h":  (start - 2 * d, end),
        "recent_7d":   (start - 6 * d, end),
    }


def windows(primary_end_ms: int) -> dict[str, tuple[int, int]]:
    """Data-derived fallback, used only when the frozen boundaries are overridden."""
    d = 24 * HOUR_MS
    return {
        "primary_24h": (primary_end_ms - d, primary_end_ms),
        "prior_24h":   (primary_end_ms - 2 * d, primary_end_ms - d),
        "recent_72h":  (primary_end_ms - 3 * d, primary_end_ms),
        "recent_7d":   (primary_end_ms - 7 * d, primary_end_ms),
    }


def build_context(prepared: dict, benchmarks: list[str], funding: dict) -> dict:
    ctx = {"benchmarks": {}, "breadth": {}, "funding_at": {},
           "decliner_rank": {}, "liquidity_percentile": {}}
    for b in benchmarks:
        if b in prepared:
            ctx["benchmarks"][b] = _states_from_prepared(prepared[b])
    # breadth, cross-sectional decliner rank and liquidity percentile per timestamp
    by_time: dict[int, list[tuple[str, float, float]]] = {}
    for sym, bars in prepared.items():
        for p in bars:
            by_time.setdefault(p.time, []).append((sym, p.ret24_pct, p.quote_volume_mean20))
    for t, rows in by_time.items():
        up = sum(1 for _, r, _ in rows if r > 0)
        ctx["breadth"][t] = up / len(rows) if rows else None
        for rank, (sym, _, _) in enumerate(sorted(rows, key=lambda x: x[1]), start=1):
            ctx["decliner_rank"][(t, sym)] = rank
        liq = sorted(rows, key=lambda x: x[2])
        n = len(liq)
        for idx, (sym, _, _) in enumerate(liq):
            ctx["liquidity_percentile"][(t, sym)] = 100.0 * (idx + 1) / n
    for sym, series in funding.items():
        for ts, rate in series:
            ctx["funding_at"][(sym, (ts // HOUR_MS) * HOUR_MS)] = rate
    return ctx


def _states_from_prepared(bars):
    """Benchmark regimes from already-prepared bars (same rule as p10BenchmarkStates)."""
    out = {}
    for i in range(100, len(bars)):
        b = bars[i]
        sep = I.pct(b.ema20, b.ema50)
        bull = (b.close > b.ema20 and b.ema20 > b.ema50 and b.ema50 > b.ema100
                and sep >= 0.15 and b.ret24_pct >= 0.20 and b.ret72_pct >= 0.5)
        bear = (b.close < b.ema20 and b.ema20 < b.ema50 and b.ema50 < b.ema100
                and sep <= -0.15 and b.ret24_pct <= -0.20 and b.ret72_pct <= -0.5)
        out[b.time] = I.BenchmarkState("BULL" if bull else "BEAR" if bear else "RANGE",
                                       b.ret24_pct, b.ret72_pct)
    return out


def long_signals(prepared: dict, ctx: dict, window, floor: float) -> dict:
    """Production LONG signals, using the parity-checked gate functions unchanged."""
    out = {}
    btc = ctx["benchmarks"].get("BTCUSDT", {})
    for sym, bars in prepared.items():
        sigs = []
        for i in range(1, len(bars)):
            b = bars[i]
            if not (window[0] <= b.time <= window[1]) or i + 1 < 106:
                continue
            st = btc.get(b.time)
            if not st or not signal_eligible(b, bars[i - 1], st, "LONG", floor):
                continue
            sigs.append(dict(symbol=sym, index=i, signal_time=b.time,
                             reference_close=b.close, atr14=b.atr14, trigger_price=None,
                             score=signal_score(b, st, "LONG")))
        if sigs:
            out[sym] = sigs
    return out


def run(dataset_dir: str, outdir: str, capital: float, primary_end_ms: int | None = None):
    out = pathlib.Path(outdir); out.mkdir(parents=True, exist_ok=True)
    d = DS.load(dataset_dir)
    v = d["validation"]
    print(f"dataset validation: ok={v.ok} errors={len(v.errors)} warnings={len(v.warnings)}")
    for e in v.errors[:20]:
        print("  ERROR:", e)
    (out / "dataset_validation.json").write_text(json.dumps(
        dict(ok=v.ok, errors=v.errors, warnings=v.warnings[:200], stats=v.stats), indent=2))

    universe, excluded = [], []
    for sym, bars in d["bars"].items():
        rules = d["rules"].get(sym, {})
        ok, why = DS.production_eligible(sym, rules, bars)
        (universe if ok else excluded).append(sym if ok else (sym, why))
    print(f"symbols in dataset: {len(d['bars'])}  production eligible: {len(universe)}  "
          f"excluded: {len(excluded)}")
    with open(out / "exclusions.csv", "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["symbol", "reason"]); w.writerows(excluded)

    prepared = {s: I.prepare_bars(d["bars"][s]) for s in universe}
    for b in ("BTCUSDT", "ETHUSDT"):
        if b in d["bars"] and b not in prepared:
            prepared[b] = I.prepare_bars(d["bars"][b])
    ctx = build_context(prepared, ["BTCUSDT", "ETHUSDT"], d["funding"])

    W = frozen_windows() if primary_end_ms is None else windows(primary_end_ms)
    for label, (a, b) in W.items():
        n = (b - a) // HOUR_MS + 1
        print(f"  {label:12s} signal bars {n:4d}  "
              f"UTC {datetime.fromtimestamp(a/1000, timezone.utc):%Y-%m-%d %H:%M} -> "
              f"{datetime.fromtimestamp(b/1000, timezone.utc):%Y-%m-%d %H:%M}  |  "
              f"KST {datetime.fromtimestamp(a/1000, KST):%Y-%m-%d %H:%M} -> "
              f"{datetime.fromtimestamp(b/1000, KST):%Y-%m-%d %H:%M}")

    defs = json.loads((pathlib.Path(__file__).parents[1] / "strategy_definitions.json").read_text())
    sizing = dict(margin_per_slot=60.0, leverage=3, max_positions=10,
                  max_new_entries_per_scan=3)
    costs = Costs(taker_fee_pct=0.05, slippage_bps=5.0)
    rules = {s: d["rules"].get(s, {}) for s in prepared}
    floor = I.LIQUIDITY_FLOOR["binance_futures"]

    all_rows = {name: [] for name in W}
    trade_rows = []
    for name, win in W.items():
        t0 = time.time()
        for spec in defs["strategies"]:
            sigs = {s: generate_signals(spec, s, prepared[s], ctx, win)
                    for s in universe}
            sigs = {k: v_ for k, v_ in sigs.items() if v_}
            res = portfolio_replay(spec, sigs, prepared, rules, costs, d["funding"],
                                   ctx, sizing)
            m = M.compute(spec["strategy_id"], res["trades"], res["signals"], capital,
                          res["rejected"])
            m["window"] = name
            all_rows[name].append(m)
            if name == "primary_24h":
                for t in res["trades"]:
                    trade_rows.append(dict(
                        strategy_id=t.strategy_id, symbol=t.symbol, side=t.side,
                        signal_time=t.signal_time, entry_time=t.entry_time,
                        entry_price=t.entry_price, exit_time=t.exit_time,
                        exit_price=t.exit_price, exit_reason=t.exit_reason,
                        quantity=t.quantity, notional=t.notional, margin=t.margin,
                        gross_pnl=t.gross_pnl, fees=t.fees, funding=t.funding,
                        slippage=t.slippage_cost, net_pnl=t.net_pnl,
                        mfe_r=t.mfe_r, mae_r=t.mae_r, holding_bars=t.holding_bars))
        print(f"  {name}: 50 strategies in {time.time()-t0:.1f}s")

    for name, rows in all_rows.items():
        _write_csv(out / f"results_{name}.csv", rows)
    _write_csv(out / "primary_trades.csv", trade_rows)
    print("wrote", out)
    return all_rows


def _write_csv(path, rows):
    if not rows:
        path.write_text("")
        return
    keys = [k for k in rows[0] if k != "rejected"]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in keys})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", default="short_research/results")
    ap.add_argument("--capital", type=float, default=600.0)
    a = ap.parse_args()
    run(a.dataset, a.out, a.capital)
