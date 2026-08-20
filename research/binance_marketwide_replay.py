#!/usr/bin/env python3
import argparse
import json
import math
import os
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import requests

SPOT = "binance"
FUT = "binance_futures"
LEVERAGE = {SPOT: 1.0, FUT: 3.0}
FEE_ONLY_ROUNDTRIP_PCT = {SPOT: 0.20, FUT: 0.10}  # engine defaults: 0.10% / 0.05% per side
CHECKPOINTS = [180, 300, 460, 600, 900, 1200, 1800]
ARM_BPS = [10, 15, 20, 25, 30, 40, 50, 75, 100]
RECOVERY_RATIOS = [0.20, 0.25, 0.33, 0.40, 0.50, 0.67]
TAIL_SECONDS = [600, 900, 1200, 1800]


def utcnow():
    return datetime.now(timezone.utc)


def ms(dt):
    return int(dt.timestamp() * 1000)


def get_json(session, url, params=None, attempts=6):
    delay = 0.6
    for i in range(attempts):
        r = session.get(url, params=params or {}, timeout=20)
        if r.status_code == 200:
            return r.json()
        if r.status_code in (418, 429):
            retry = float(r.headers.get("Retry-After", delay))
            time.sleep(max(delay, retry))
            delay *= 2
            continue
        if 500 <= r.status_code < 600:
            time.sleep(delay)
            delay *= 2
            continue
        raise RuntimeError(f"GET {url} {r.status_code}: {r.text[:240]}")
    raise RuntimeError(f"GET {url} failed after {attempts} attempts")


def active_symbols(session, exchange):
    if exchange == SPOT:
        payload = get_json(session, "https://api.binance.com/api/v3/exchangeInfo")
        return sorted({
            str(x.get("symbol", "")).upper() for x in payload.get("symbols", [])
            if x.get("status") == "TRADING" and x.get("quoteAsset") == "USDT"
            and x.get("isSpotTradingAllowed", True)
        })
    payload = get_json(session, "https://fapi.binance.com/fapi/v1/exchangeInfo")
    return sorted({
        str(x.get("symbol", "")).upper() for x in payload.get("symbols", [])
        if x.get("status") == "TRADING" and x.get("quoteAsset") == "USDT"
        and x.get("contractType") == "PERPETUAL"
    })


def fetch_1m(session, exchange, symbol, start_ms, end_ms):
    url = "https://api.binance.com/api/v3/klines" if exchange == SPOT else "https://fapi.binance.com/fapi/v1/klines"
    cursor = start_ms
    rows = []
    while cursor < end_ms:
        payload = get_json(session, url, {
            "symbol": symbol,
            "interval": "1m",
            "startTime": cursor,
            "endTime": end_ms,
            "limit": 1000,
        })
        if not payload:
            break
        rows.extend(payload)
        nxt = int(payload[-1][0]) + 60_000
        if nxt <= cursor:
            break
        cursor = nxt
        # Keep well below Binance request-weight ceilings across the full universe.
        time.sleep(0.045 if exchange == SPOT else 0.075)
    if not rows:
        return None
    a = np.asarray([[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[7]), int(r[8]), float(r[9])] for r in rows], dtype=float)
    # ts, open, high, low, close, base_volume, quote_volume, trades, taker_buy_base
    return a


def load_db(days):
    dsn = os.environ["SUPABASE_DB_URL"]
    since = utcnow() - timedelta(days=days)
    with psycopg.connect(dsn, autocommit=True) as conn:
        candidates = pd.read_sql_query(
            """
            select id::text, exchange, market, created_at, decision, score, confidence,
                   entry_low, entry_high, estimated_cost_pct, failed_gate_count,
                   coalesce(snapshot->'failed_gates', snapshot->'reasons', snapshot#>'{scalp_signal,reasons}', snapshot#>'{lob_signal,reasons}', '[]'::jsonb)::text as failed_gates
            from public.scanner_candidates
            where created_at >= %s
              and exchange in ('binance','binance_futures')
              and entry_low > 0
            order by created_at
            """, conn, params=(since,)
        )
        positions = pd.read_sql_query(
            """
            select id::text, candidate_id::text, exchange, market, opened_at, closed_at,
                   average_entry_price::float8 as average_entry_price,
                   realized_return_pct::float8 as realized_return_pct,
                   realized_pnl_quote::float8 as realized_pnl_quote,
                   paid_fees_quote::float8 as paid_fees_quote,
                   peak_return_pct::float8 as peak_return_pct,
                   profit_giveback_pct::float8 as profit_giveback_pct,
                   mfe_capture_ratio::float8 as mfe_capture_ratio,
                   leverage::float8 as leverage, close_reason, metadata::text as metadata
            from public.trading_positions
            where is_paper=false and opened_at >= %s
              and exchange in ('binance','binance_futures')
            order by opened_at
            """, conn, params=(since,)
        )
    candidates["created_at"] = pd.to_datetime(candidates["created_at"], utc=True)
    if len(positions):
        positions["opened_at"] = pd.to_datetime(positions["opened_at"], utc=True)
        positions["closed_at"] = pd.to_datetime(positions["closed_at"], utc=True)
    return candidates, positions


def cost_pct(row, mode):
    fee = FEE_ONLY_ROUNDTRIP_PCT[row.exchange]
    if mode == "fee_only":
        return fee
    v = row.estimated_cost_pct
    if pd.isna(v) or float(v) <= 0:
        return fee
    return max(fee, float(v))


def path_for_candidate(bars, created_at, max_seconds=1800):
    if bars is None or not len(bars):
        return None
    t = int(created_at.timestamp() * 1000)
    # No pre-signal leakage: use the first full 1m bar whose open is >= signal time.
    idx = int(np.searchsorted(bars[:, 0], t, side="left"))
    if idx >= len(bars):
        return None
    end_t = t + max_seconds * 1000 + 60_000
    j = int(np.searchsorted(bars[:, 0], end_t, side="right"))
    p = bars[idx:j]
    if len(p) < 4:
        return None
    return p


def checkpoint_close(path, entry, signal_ts_ms, sec):
    target = signal_ts_ms + sec * 1000
    idx = int(np.searchsorted(path[:, 0], target, side="left"))
    if idx >= len(path):
        return np.nan
    return (path[idx, 4] / entry - 1.0) * 100.0


def summarize_path(path, entry, signal_ts_ms):
    out = {}
    for sec in CHECKPOINTS:
        out[f"ret_{sec}s_pct"] = checkpoint_close(path, entry, signal_ts_ms, sec)
    out["mfe_600_pct"] = np.nan
    out["mae_600_pct"] = np.nan
    cutoff = signal_ts_ms + 600_000
    q = path[path[:, 0] <= cutoff]
    if len(q):
        out["mfe_600_pct"] = (np.max(q[:, 2]) / entry - 1) * 100
        out["mae_600_pct"] = (np.min(q[:, 3]) / entry - 1) * 100
    qall = path
    out["mfe_1800_pct"] = (np.max(qall[:, 2]) / entry - 1) * 100
    out["mae_1800_pct"] = (np.min(qall[:, 3]) / entry - 1) * 100
    return out


def breakeven_lock(path, entry, signal_ts_ms, exchange, c_pct, arm_bps):
    lev = LEVERAGE[exchange]
    # Stored futures peak_return_pct is ROE; translate the tested ROE arm into price-space.
    arm_price_pct = (arm_bps / 100.0) / lev
    floor_price_pct = c_pct
    effective_arm_pct = max(arm_price_pct, floor_price_pct)
    arm_price = entry * (1 + effective_arm_pct / 100.0)
    floor_price = entry * (1 + floor_price_pct / 100.0)
    armed_at = None
    for i, b in enumerate(path):
        if b[0] > signal_ts_ms + 600_000:
            break
        if armed_at is None:
            if b[2] >= arm_price:
                armed_at = i
            continue
        # Do not resolve arm and stop inside the same 1m candle; start protection next bar.
        if i <= armed_at:
            continue
        if b[3] <= floor_price:
            gross = floor_price_pct
            net_price_pct = gross - c_pct
            return {
                "armed": 1, "exit": 1, "exit_sec": max(0.0, (b[0] - signal_ts_ms) / 1000.0),
                "net_roe_pct": net_price_pct * lev,
                "effective_arm_roe_bps": effective_arm_pct * lev * 100,
            }
    return {
        "armed": int(armed_at is not None), "exit": 0, "exit_sec": np.nan,
        "net_roe_pct": np.nan,
        "effective_arm_roe_bps": effective_arm_pct * lev * 100,
    }


def recovery_sim(path, entry, signal_ts_ms, c_pct, ratio, tail_sec):
    lev = 3.0
    hard_stop_price = entry * (1 - (12.0 / lev) / 100.0)
    net_floor_price = entry * (1 + c_pct / 100.0)
    # State at first full bar at/after 180 seconds.
    idx180 = int(np.searchsorted(path[:, 0], signal_ts_ms + 180_000, side="left"))
    if idx180 >= len(path):
        return None
    p180 = path[idx180, 4]
    net180 = ((p180 / entry - 1) * 100 - c_pct) * lev
    if net180 > 0:
        return {"latched": 0, "exit_reason": "NORMAL_POSITIVE_AT_180", "exit_sec": 180, "net_roe_pct": net180}
    trough = min(np.min(path[idx180:idx180+1, 3]), p180)
    last_close = p180
    for i in range(idx180, len(path)):
        b = path[i]
        age = max(0.0, (b[0] - signal_ts_ms) / 1000.0)
        if b[3] <= hard_stop_price:
            gross = -12.0 / lev
            return {"latched": 1, "exit_reason": "HARD_STOP", "exit_sec": age, "net_roe_pct": (gross - c_pct) * lev}
        trough = min(trough, b[3])
        close = b[4]
        last_close = close
        net_price = (close / entry - 1) * 100 - c_pct
        if net_price > 0:
            return {"latched": 1, "exit_reason": "RECOVERY_NET_POSITIVE", "exit_sec": age, "net_roe_pct": net_price * lev}
        if 460 <= age < 600 and trough < entry:
            rr = (close - trough) / (entry - trough)
            if rr >= ratio:
                return {"latched": 1, "exit_reason": f"LATE_R_{ratio:.2f}", "exit_sec": age, "net_roe_pct": net_price * lev}
        if age >= tail_sec:
            return {"latched": 1, "exit_reason": f"TAIL_{tail_sec}", "exit_sec": age, "net_roe_pct": net_price * lev}
    net_price = (last_close / entry - 1) * 100 - c_pct
    return {"latched": 1, "exit_reason": "UNRESOLVED", "exit_sec": np.nan, "net_roe_pct": net_price * lev}


def split_name(ts, start, end):
    total = (end - start).total_seconds()
    x = (ts.to_pydatetime() - start).total_seconds() / total if total > 0 else 1
    if x < 0.60:
        return "train"
    if x < 0.80:
        return "validation"
    return "holdout"


def gate_name(raw):
    try:
        x = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(x, list) and len(x) == 1:
            v = x[0]
            if isinstance(v, str): return v
            if isinstance(v, dict): return str(v.get("code") or v.get("reason") or v)
        return None
    except Exception:
        return None


def metric_table(df, group_cols, value="net_roe_pct"):
    if df.empty:
        return pd.DataFrame()
    g = df.groupby(group_cols, dropna=False)[value]
    out = g.agg(n="size", mean="mean", median="median", std="std").reset_index()
    wins = g.apply(lambda s: float((s > 0).mean()) if len(s) else np.nan).reset_index(name="win_rate")
    q05 = g.quantile(0.05).reset_index(name="p05")
    q95 = g.quantile(0.95).reset_index(name="p95")
    return out.merge(wins, on=group_cols).merge(q05, on=group_cols).merge(q95, on=group_cols)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", default="research-output")
    ap.add_argument("--control-step-min", type=int, default=30)
    args = ap.parse_args()
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    end = utcnow().replace(second=0, microsecond=0)
    start = end - timedelta(days=args.days)
    candidates, positions = load_db(args.days)
    candidates["market"] = candidates.market.str.upper()
    candidates["single_gate"] = candidates.apply(lambda r: gate_name(r.failed_gates) if int(r.failed_gate_count or 0) == 1 else None, axis=1)
    candidates["eligible_class"] = np.where(candidates.decision.isin(["BUY", "ENTER"]), "BUY", np.where(candidates.failed_gate_count == 1, "SINGLE_GATE_FAIL", "OTHER"))
    candidates = candidates[candidates.eligible_class.isin(["BUY", "SINGLE_GATE_FAIL"])].copy()
    candidates["split"] = candidates.created_at.apply(lambda x: split_name(x, start, end))

    session = requests.Session()
    session.headers.update({"User-Agent": "Trading-booooo-marketwide-replay/1.0"})
    universe = {SPOT: active_symbols(session, SPOT), FUT: active_symbols(session, FUT)}
    universe_sets = {k: set(v) for k, v in universe.items()}

    # Keep every active USDT symbol for the market-wide control. Candidate replay only uses
    # symbols that are valid on the lane today; invalid/stale names are reported separately.
    candidate_groups = {k: defaultdict(list) for k in [SPOT, FUT]}
    stale_candidate_symbols = []
    for i, r in candidates.iterrows():
        if r.market in universe_sets[r.exchange]:
            candidate_groups[r.exchange][r.market].append(i)
        else:
            stale_candidate_symbols.append((r.exchange, r.market))

    replay_rows = []
    be_rows = []
    rec_rows = []
    control_rows = []
    fetch_failures = []

    for exchange in [SPOT, FUT]:
        symbols = universe[exchange]
        print(f"[{exchange}] active USDT symbols={len(symbols)}", flush=True)
        for n, symbol in enumerate(symbols, 1):
            try:
                bars = fetch_1m(session, exchange, symbol, ms(start), ms(end))
            except Exception as e:
                fetch_failures.append({"exchange": exchange, "market": symbol, "error": str(e)[:300]})
                continue
            if bars is None or len(bars) < 20:
                continue

            # Whole-Binance control sample: systematic entries every N minutes. This is not
            # treated as our entry signal; it measures whether recovery/giveback patterns are
            # generic market behavior or specific to our scanner-selected opportunities.
            stride = max(1, args.control_step_min)
            for ix in range(1, max(1, len(bars) - 31), stride):
                p = bars[ix: min(len(bars), ix + 31)]
                if len(p) < 11:
                    continue
                entry = p[0, 1]
                if entry <= 0:
                    continue
                sig = int(p[0, 0])
                sm = summarize_path(p, entry, sig)
                row = {"exchange": exchange, "market": symbol, "signal_ms": sig, **sm}
                control_rows.append(row)

            for idx in candidate_groups[exchange].get(symbol, []):
                r = candidates.loc[idx]
                path = path_for_candidate(bars, r.created_at, 1800)
                if path is None:
                    continue
                entry = float(path[0, 1])  # executable no-lookahead proxy: next full minute open
                if not math.isfinite(entry) or entry <= 0:
                    continue
                sig_ms = int(r.created_at.timestamp() * 1000)
                base = {
                    "candidate_id": r.id, "exchange": exchange, "market": symbol,
                    "created_at": r.created_at.isoformat(), "split": r.split,
                    "eligible_class": r.eligible_class, "decision": r.decision,
                    "failed_gate_count": int(r.failed_gate_count or 0), "single_gate": r.single_gate,
                    "candidate_entry_low": float(r.entry_low), "replay_entry": entry,
                    "entry_slip_vs_candidate_pct": (entry / float(r.entry_low) - 1) * 100,
                    "estimated_cost_pct": float(r.estimated_cost_pct) if pd.notna(r.estimated_cost_pct) else np.nan,
                }
                sm = summarize_path(path, entry, sig_ms)
                replay_rows.append({**base, **sm})

                for cmode in ["fee_only", "candidate_cost"]:
                    cpct = cost_pct(r, cmode)
                    for arm in ARM_BPS:
                        z = breakeven_lock(path, entry, sig_ms, exchange, cpct, arm)
                        # If lock never exits, compare at 600s close after cost.
                        if not z["exit"]:
                            rr = checkpoint_close(path, entry, sig_ms, 600)
                            if math.isfinite(rr):
                                z["net_roe_pct"] = (rr - cpct) * LEVERAGE[exchange]
                        be_rows.append({**base, "cost_mode": cmode, "cost_pct": cpct, "arm_bps": arm, **z})

                if exchange == FUT:
                    # Recovery policy is evaluated under both fee-only and scanner conservative cost.
                    for cmode in ["fee_only", "candidate_cost"]:
                        cpct = cost_pct(r, cmode)
                        for ratio in RECOVERY_RATIOS:
                            for tail in TAIL_SECONDS:
                                z = recovery_sim(path, entry, sig_ms, cpct, ratio, tail)
                                if z is not None:
                                    rec_rows.append({**base, "cost_mode": cmode, "cost_pct": cpct, "recovery_ratio": ratio, "tail_sec": tail, **z})

            if n % 50 == 0:
                print(f"[{exchange}] {n}/{len(symbols)} symbols", flush=True)

    replay = pd.DataFrame(replay_rows)
    be = pd.DataFrame(be_rows)
    rec = pd.DataFrame(rec_rows)
    controls = pd.DataFrame(control_rows)

    replay.to_csv(outdir / "candidate_replay.csv", index=False)
    be.to_csv(outdir / "breakeven_grid.csv", index=False)
    rec.to_csv(outdir / "recovery_grid.csv", index=False)
    pd.DataFrame(fetch_failures).to_csv(outdir / "fetch_failures.csv", index=False)

    # Aggregates small enough for direct inspection.
    be_metrics = metric_table(be, ["exchange", "cost_mode", "split", "arm_bps"])
    be_metrics.to_csv(outdir / "breakeven_metrics.csv", index=False)
    if len(rec):
        rec_latched = rec[rec.latched == 1].copy()
        rec_metrics = metric_table(rec_latched, ["cost_mode", "split", "recovery_ratio", "tail_sec"])
    else:
        rec_metrics = pd.DataFrame()
    rec_metrics.to_csv(outdir / "recovery_metrics.csv", index=False)

    gate_metrics = pd.DataFrame()
    if len(replay):
        sg = replay[replay.eligible_class == "SINGLE_GATE_FAIL"].copy()
        if len(sg):
            sg["net600_feeonly_roe_pct"] = (sg.ret_600s_pct - sg.exchange.map(FEE_ONLY_ROUNDTRIP_PCT)) * sg.exchange.map(LEVERAGE)
            gate_metrics = metric_table(sg.dropna(subset=["single_gate"]), ["exchange", "split", "single_gate"], "net600_feeonly_roe_pct")
    gate_metrics.to_csv(outdir / "single_gate_metrics.csv", index=False)

    # Whole-market baseline summaries.
    control_summary = []
    if len(controls):
        for exchange, d in controls.groupby("exchange"):
            lev = LEVERAGE[exchange]
            fee = FEE_ONLY_ROUNDTRIP_PCT[exchange]
            for sec in [180, 460, 600, 900, 1800]:
                col = f"ret_{sec}s_pct"
                x = d[col].dropna()
                if not len(x): continue
                net = (x - fee) * lev
                control_summary.append({
                    "exchange": exchange, "horizon_sec": sec, "n": int(len(net)),
                    "mean_net_roe_pct": float(net.mean()), "median_net_roe_pct": float(net.median()),
                    "win_rate": float((net > 0).mean()), "p05": float(net.quantile(.05)), "p95": float(net.quantile(.95)),
                })
    control_summary = pd.DataFrame(control_summary)
    control_summary.to_csv(outdir / "whole_market_controls.csv", index=False)

    # Candidate checkpoint summary and winner->loser diagnostics.
    checkpoint_summary = []
    if len(replay):
        for (exchange, cls, split), d in replay.groupby(["exchange", "eligible_class", "split"]):
            lev = LEVERAGE[exchange]
            fee = FEE_ONLY_ROUNDTRIP_PCT[exchange]
            row = {"exchange": exchange, "eligible_class": cls, "split": split, "n": len(d)}
            for sec in [180, 460, 600, 900, 1800]:
                x = d[f"ret_{sec}s_pct"].dropna()
                row[f"mean_net_roe_{sec}s"] = float(((x-fee)*lev).mean()) if len(x) else np.nan
                row[f"win_rate_{sec}s"] = float((((x-fee)*lev)>0).mean()) if len(x) else np.nan
            peak = d.mfe_600_pct * lev
            endnet = (d.ret_600s_pct - fee) * lev
            row["peak20bps_to_loss_rate"] = float(((peak >= 0.20) & (endnet < 0)).mean())
            checkpoint_summary.append(row)
    checkpoint_summary = pd.DataFrame(checkpoint_summary)
    checkpoint_summary.to_csv(outdir / "checkpoint_summary.csv", index=False)

    meta = {
        "generated_at": utcnow().isoformat(), "days": args.days,
        "window_start": start.isoformat(), "window_end": end.isoformat(),
        "active_spot_usdt_symbols": len(universe[SPOT]),
        "active_futures_usdt_perpetual_symbols": len(universe[FUT]),
        "db_candidates_selected": int(len(candidates)),
        "candidate_replays": int(len(replay)),
        "live_positions": int(len(positions)),
        "stale_candidate_symbol_rows": int(len(stale_candidate_symbols)),
        "fetch_failures": int(len(fetch_failures)),
        "method": {
            "market_data": "Binance official REST 1m raw klines across all active USDT spot + USD-M perpetual symbols",
            "entry": "first full 1m open at/after scanner timestamp; excludes pre-signal part of candle",
            "fees": "fee_only uses engine configured default round-trip fees; candidate_cost uses max(fee_only, scanner estimated_cost_pct)",
            "intrabar": "1m OHLC; same-bar arm+floor is not resolved in favor of strategy",
            "orderbook_limit": "historical L2 depth is not reconstructed; executable-depth conclusions are not claimed",
            "splits": "chronological 60/20/20 train/validation/holdout",
        },
    }
    (outdir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    # Markdown summary for Actions step summary and artifact.
    lines = ["# Binance market-wide replay", "", "```json", json.dumps(meta, indent=2, ensure_ascii=False), "```", ""]
    if len(checkpoint_summary):
        lines += ["## Candidate checkpoint summary", "", checkpoint_summary.to_markdown(index=False), ""]
    if len(be_metrics):
        hold = be_metrics[be_metrics.split == "holdout"].sort_values(["exchange", "cost_mode", "mean"], ascending=[True, True, False])
        lines += ["## Breakeven grid — holdout", "", hold.to_markdown(index=False), ""]
    if len(rec_metrics):
        holdr = rec_metrics[rec_metrics.split == "holdout"].sort_values(["cost_mode", "mean"], ascending=[True, False])
        lines += ["## Recovery grid — holdout", "", holdr.to_markdown(index=False), ""]
    if len(gate_metrics):
        gh = gate_metrics[gate_metrics.split == "holdout"].sort_values(["exchange", "mean"], ascending=[True, False])
        lines += ["## Single-gate counterfactual — holdout", "", gh.to_markdown(index=False), ""]
    if len(control_summary):
        lines += ["## Whole-market systematic control", "", control_summary.to_markdown(index=False), ""]
    summary = "\n".join(lines)
    (outdir / "SUMMARY.md").write_text(summary)
    print(summary[:30000])


if __name__ == "__main__":
    main()
