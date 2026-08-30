#!/usr/bin/env python3
"""V10 R7 blocked-time-series discovery for genuinely new RANGE and BEAR mechanisms.

Discovery/selection/confirmation use only 2023, 2024 and 2025-01-01..2025-10-08.
The separately locked 2022 final holdout is never loaded by this file.

Mechanisms:
- RANGE_BETA_RESID_ENSEMBLE: beta-neutral 8h/12h/24h residual extremes with
  completed-bar reconvergence or opposing taker-flow confirmation.
- BEAR_FAILED_REBOUND_REBREAK: structurally weak assets that rebound and then
  break the prior completed 4h low under broad negative breadth.
- BEAR_RELWEAK_REBREAK: cross-sectional residual weakness followed by a failed
  tactical rebound and renewed downside confirmation.
"""
from __future__ import annotations

import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import run as base
import run_r3 as loader
import run_xs as xs

UTC = timezone.utc
HERE = Path(__file__).resolve().parent
OUT = HERE / "r7-result.json"
PROTOCOL = HERE / "r7-protocol-lock.json"
BAR_MS = 15 * 60 * 1000
HOUR_BARS = 4
DAY_MS = 24 * 60 * 60 * 1000

# Fixed long-history universe. Every non-BTC member has a complete Binance USD-M
# history for the independently locked 2022 holdout and remains production tradable.
R7_ASSETS = [
    "BTC", "ETH", "XRP", "SOL", "DOGE", "ADA", "AVAX", "LINK",
    "BCH", "DOT", "TRX", "NEAR", "ETC", "XLM", "ATOM", "UNI",
]
NON_BTC = [asset for asset in R7_ASSETS if asset != "BTC"]
base.ASSETS = list(R7_ASSETS)
xs.NON_BTC = list(NON_BTC)
xs.BASE_COST = 18.0
xs.STRESS_COST = 21.0
base.CACHE = Path("v10-cache-r3")
loader.base.CACHE = base.CACHE

P23S = datetime(2023, 1, 1, tzinfo=UTC)
P23E = datetime(2024, 1, 1, tzinfo=UTC)
P24S = datetime(2024, 1, 1, tzinfo=UTC)
P24E = datetime(2025, 1, 1, tzinfo=UTC)
P25S = datetime(2025, 1, 1, tzinfo=UTC)
P25E = datetime(2025, 10, 8, tzinfo=UTC)
PERIODS = (("2023", P23S, P23E), ("2024", P24S, P24E), ("2025_PRETEST", P25S, P25E))


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha256_object(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def dt_hour(ts: int) -> int:
    return datetime.fromtimestamp(ts / 1000, UTC).hour


def scheduled(ts: int, cadence_h: int) -> bool:
    dt = datetime.fromtimestamp(ts / 1000, UTC)
    return dt.minute == 0 and dt.hour % cadence_h == 0


def ret_at(bars: list[base.Bar], index: int, bars_back: int) -> float | None:
    prior = index - bars_back
    if prior < 0 or bars[index].ts - bars[prior].ts != bars_back * BAR_MS or bars[prior].c <= 0:
        return None
    return bars[index].c / bars[prior].c - 1.0


def log_returns(bars: list[base.Bar], end_index: int, count: int) -> list[float] | None:
    start = end_index - count
    if start < 0 or bars[end_index].ts - bars[start].ts != count * BAR_MS:
        return None
    out: list[float] = []
    for idx in range(start + 1, end_index + 1):
        previous = bars[idx - 1].c
        current = bars[idx].c
        if previous <= 0 or current <= 0:
            return None
        out.append(math.log(current / previous))
    return out


def beta_sigma(asset_bars: list[base.Bar], btc_bars: list[base.Bar], asset_i: int, btc_i: int, lookback_h: int) -> tuple[float, float] | None:
    count = lookback_h * HOUR_BARS
    asset_returns = log_returns(asset_bars, asset_i, count)
    btc_returns = log_returns(btc_bars, btc_i, count)
    if asset_returns is None or btc_returns is None or len(asset_returns) != len(btc_returns):
        return None
    btc_mean = statistics.fmean(btc_returns)
    asset_mean = statistics.fmean(asset_returns)
    variance = sum((value - btc_mean) ** 2 for value in btc_returns)
    if variance <= 1e-14:
        return None
    covariance = sum((a - asset_mean) * (b - btc_mean) for a, b in zip(asset_returns, btc_returns))
    beta = max(-0.5, min(3.0, covariance / variance))
    residuals = [a - beta * b for a, b in zip(asset_returns, btc_returns)]
    sigma = statistics.pstdev(residuals)
    if sigma <= 1e-9:
        return None
    return beta, sigma


def residual_z(asset_bars: list[base.Bar], btc_bars: list[base.Bar], asset_i: int, btc_i: int, hours: int, beta: float, sigma: float) -> float | None:
    asset_ret = ret_at(asset_bars, asset_i, hours * HOUR_BARS)
    btc_ret = ret_at(btc_bars, btc_i, hours * HOUR_BARS)
    if asset_ret is None or btc_ret is None:
        return None
    # Log residual is more stable across high-volatility coins; sigma is 15m residual sigma.
    value = math.log1p(asset_ret) - beta * math.log1p(btc_ret)
    scale = sigma * math.sqrt(hours * HOUR_BARS)
    return value / scale if scale > 1e-12 else None


@dataclass(frozen=True, slots=True)
class AssetContext:
    asset: str
    index: int
    close: float
    ema24: float
    volume_z: float
    taker_signed: float
    r1: float
    r4: float
    r8: float
    r12: float
    r24: float
    r72: float
    rz1: float
    rz4: float
    rz8: float
    rz12: float
    rz24: float
    prior_low_4h: float
    prior_low_12h: float


@dataclass(frozen=True, slots=True)
class MarketContext:
    ts: int
    regime: str
    btc24: float
    btc72: float
    breadth_negative_share: float
    median24: float
    assets: tuple[AssetContext, ...]


def build_contexts(
    bars: dict[str, list[base.Bar]],
    features: dict[str, dict[int, base.Feature]],
    indices: dict[str, dict[int, int]],
    cadence_h: int = 4,
) -> dict[int, MarketContext]:
    contexts: dict[int, MarketContext] = {}
    btc_bars = bars["BTC"]
    for ts in sorted(features["BTC"]):
        if not scheduled(ts, cadence_h):
            continue
        btc_feature = features["BTC"].get(ts)
        btc_i = indices["BTC"].get(ts)
        if btc_feature is None or btc_i is None:
            continue
        btc24 = ret_at(btc_bars, btc_i, 24 * HOUR_BARS)
        btc72 = ret_at(btc_bars, btc_i, 72 * HOUR_BARS)
        if btc24 is None or btc72 is None:
            continue
        asset_rows: list[AssetContext] = []
        returns24: list[float] = []
        for asset in NON_BTC:
            asset_i = indices[asset].get(ts)
            feature = features[asset].get(ts)
            if asset_i is None or feature is None:
                continue
            asset_bars = bars[asset]
            raw = {hours: ret_at(asset_bars, asset_i, hours * HOUR_BARS) for hours in (1, 4, 8, 12, 24, 72)}
            if any(value is None for value in raw.values()):
                continue
            beta_row = beta_sigma(asset_bars, btc_bars, asset_i, btc_i, 72)
            if beta_row is None:
                continue
            beta, sigma = beta_row
            residuals = {hours: residual_z(asset_bars, btc_bars, asset_i, btc_i, hours, beta, sigma) for hours in (1, 4, 8, 12, 24)}
            if any(value is None or not math.isfinite(value) for value in residuals.values()):
                continue
            if asset_i < 48:
                continue
            prior4 = min(bar.l for bar in asset_bars[asset_i - 16:asset_i])
            prior12 = min(bar.l for bar in asset_bars[asset_i - 48:asset_i])
            r24 = float(raw[24])
            returns24.append(r24)
            asset_rows.append(AssetContext(
                asset=asset,
                index=asset_i,
                close=asset_bars[asset_i].c,
                ema24=feature.ema24,
                volume_z=feature.volume_z,
                taker_signed=feature.taker_signed,
                r1=float(raw[1]), r4=float(raw[4]), r8=float(raw[8]), r12=float(raw[12]), r24=r24, r72=float(raw[72]),
                rz1=float(residuals[1]), rz4=float(residuals[4]), rz8=float(residuals[8]), rz12=float(residuals[12]), rz24=float(residuals[24]),
                prior_low_4h=prior4, prior_low_12h=prior12,
            ))
        if len(asset_rows) < 12:
            continue
        contexts[ts] = MarketContext(
            ts=ts,
            regime=btc_feature.regime,
            btc24=btc24,
            btc72=btc72,
            breadth_negative_share=sum(value < 0 for value in returns24) / len(returns24),
            median24=statistics.median(returns24),
            assets=tuple(asset_rows),
        )
    return contexts


def candidates() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    serial = 0

    def add(**candidate: Any) -> None:
        nonlocal serial
        candidate["key"] = f"V10R7_{candidate['lane']}_{candidate['family']}_{serial:04d}"
        serial += 1
        result.append(candidate)

    # RANGE: three independent residual horizons must agree; the current completed
    # hour must either turn toward zero or show opposing taker flow.
    for hold_h in (8, 12):
        for z_threshold in (1.5, 2.0, 2.5):
            for confirmation in ("TURN", "FLOW"):
                add(
                    lane="RANGE", family="BETA_RESID_ENSEMBLE", hold_h=hold_h,
                    cooldown_h=24, z_threshold=z_threshold, confirmation=confirmation,
                    min_agreement=2, max_entries_per_event=2,
                    volume_z_min=-0.5, flow_threshold=0.05,
                )

    # BEAR failed rebound -> completed-bar rebreak. These are mechanism-level surfaces,
    # not threshold changes to the rejected absolute-momentum or rebound-only families.
    for hold_h in (8, 12):
        for weak72 in (0.04, 0.06):
            for rebound12 in (0.01, 0.02):
                for breadth in (0.60, 0.70):
                    add(
                        lane="BEAR", family="FAILED_REBOUND_REBREAK", hold_h=hold_h,
                        cooldown_h=24, weak72=weak72, rebound12=rebound12,
                        rebreak1=-0.004, breadth_min=breadth, volume_z_min=0.0,
                        taker_max=0.0, max_entries_per_event=2,
                    )

    # Cross-sectional weak-asset rebreak: residual weakness plus a small rebound and
    # renewed 4h downside. It is distinct from raw downside momentum.
    for hold_h in (8, 12):
        for residual_z_min in (1.5, 2.0):
            for rebound12 in (0.005, 0.015):
                for breadth in (0.60, 0.70):
                    add(
                        lane="BEAR", family="RELWEAK_REBREAK", hold_h=hold_h,
                        cooldown_h=24, residual_z_min=residual_z_min,
                        rebound12=rebound12, rebreak4=-0.01, breadth_min=breadth,
                        volume_z_min=-0.25, taker_max=0.05, max_entries_per_event=2,
                    )
    return result


CANDIDATES = candidates()


def leg_trade(candidate: dict[str, Any], row: AssetContext, side: str, bars: dict[str, list[base.Bar]], end_ms: int, score: float) -> xs.XTrade | None:
    pnl = xs.leg_pnl(bars[row.asset], row.index, candidate["hold_h"], side, end_ms)
    if pnl is None:
        return None
    return xs.XTrade(
        candidate["key"], candidate["lane"], pnl[3], pnl[4], pnl[2], pnl[1], pnl[0],
        ((row.asset, side, pnl[2]),), score,
    )


def range_signals(candidate: dict[str, Any], context: MarketContext, bars: dict[str, list[base.Bar]], end_ms: int, exclude: str | None) -> list[xs.XTrade]:
    if context.regime != "RANGE":
        return []
    rows: list[tuple[float, str, AssetContext]] = []
    threshold = candidate["z_threshold"]
    for row in context.assets:
        if row.asset == exclude or row.volume_z < candidate["volume_z_min"]:
            continue
        values = (row.rz8, row.rz12, row.rz24)
        positive = sum(value >= threshold for value in values)
        negative = sum(value <= -threshold for value in values)
        if max(positive, negative) < candidate["min_agreement"]:
            continue
        direction = 1 if positive > negative else -1
        if candidate["confirmation"] == "TURN":
            if direction * row.rz1 >= 0:
                continue
        else:
            if direction > 0 and row.taker_signed > -candidate["flow_threshold"]:
                continue
            if direction < 0 and row.taker_signed < candidate["flow_threshold"]:
                continue
        score = statistics.fmean(abs(value) for value in values) + abs(row.rz1)
        rows.append((score, "SHORT" if direction > 0 else "LONG", row))
    rows.sort(key=lambda value: (-value[0], value[2].asset))
    out: list[xs.XTrade] = []
    for score, side, row in rows[: candidate["max_entries_per_event"]]:
        trade = leg_trade(candidate, row, side, bars, end_ms, score)
        if trade is not None:
            out.append(trade)
    return out


def bear_signals(candidate: dict[str, Any], context: MarketContext, bars: dict[str, list[base.Bar]], end_ms: int, exclude: str | None) -> list[xs.XTrade]:
    if context.regime not in ("BEAR", "STRONG_BEAR"):
        return []
    if context.breadth_negative_share < candidate["breadth_min"] or context.median24 > 0:
        return []
    ranked: list[tuple[float, AssetContext]] = []
    for row in context.assets:
        if row.asset == exclude or row.volume_z < candidate["volume_z_min"] or row.taker_signed > candidate["taker_max"]:
            continue
        if row.close >= row.ema24:
            continue
        if candidate["family"] == "FAILED_REBOUND_REBREAK":
            if not (
                row.r72 <= -candidate["weak72"]
                and row.r12 >= candidate["rebound12"]
                and row.r1 <= candidate["rebreak1"]
                and row.close < row.prior_low_4h
            ):
                continue
            score = -row.r72 + row.r12 - row.r1 + context.breadth_negative_share
        else:
            if not (
                row.rz24 <= -candidate["residual_z_min"]
                and row.r12 >= candidate["rebound12"]
                and row.r4 <= candidate["rebreak4"]
                and row.close < row.prior_low_4h
            ):
                continue
            score = -row.rz24 + row.r12 - row.r4 + context.breadth_negative_share
        ranked.append((score, row))
    ranked.sort(key=lambda value: (-value[0], value[1].asset))
    out: list[xs.XTrade] = []
    for score, row in ranked[: candidate["max_entries_per_event"]]:
        trade = leg_trade(candidate, row, "SHORT", bars, end_ms, score)
        if trade is not None:
            out.append(trade)
    return out


def admit(candidate: dict[str, Any], raw: Iterable[xs.XTrade]) -> list[xs.XTrade]:
    grouped: dict[int, list[xs.XTrade]] = defaultdict(list)
    for trade in raw:
        grouped[trade.entry_ts].append(trade)
    active: list[xs.XTrade] = []
    last_entry: dict[str, int] = {}
    admitted: list[xs.XTrade] = []
    cooldown_ms = candidate["cooldown_h"] * 60 * 60 * 1000
    for ts in sorted(grouped):
        active = [trade for trade in active if trade.exit_ts > ts]
        active_assets = {asset for trade in active for asset, _side, _pnl in trade.legs}
        slots = 3 - len(active)
        if slots <= 0:
            continue
        choices = sorted(grouped[ts], key=lambda trade: (-trade.score, trade.legs[0][0]))
        per_event = 0
        for trade in choices:
            if slots <= 0 or per_event >= candidate["max_entries_per_event"]:
                break
            asset = trade.legs[0][0]
            if asset in active_assets:
                continue
            previous = last_entry.get(asset)
            if previous is not None and ts - previous < cooldown_ms:
                continue
            admitted.append(trade)
            active.append(trade)
            active_assets.add(asset)
            last_entry[asset] = ts
            slots -= 1
            per_event += 1
    return admitted


def generate(candidate: dict[str, Any], start_ms: int, end_ms: int, contexts: dict[int, MarketContext], bars: dict[str, list[base.Bar]], exclude: str | None = None) -> list[xs.XTrade]:
    raw: list[xs.XTrade] = []
    for ts, context in contexts.items():
        if ts < start_ms or ts >= end_ms:
            continue
        rows = (
            range_signals(candidate, context, bars, end_ms, exclude)
            if candidate["lane"] == "RANGE"
            else bear_signals(candidate, context, bars, end_ms, exclude)
        )
        raw.extend(rows)
    return admit(candidate, raw)


def extended_metrics(trades: list[xs.XTrade]) -> dict[str, Any]:
    base_metrics = xs.metrics(trades)
    counts: Counter[str] = Counter()
    monthly: dict[str, float] = defaultdict(float)
    absolute = sum(abs(trade.stress) for trade in trades)
    positive = sum(max(0.0, trade.stress) for trade in trades)
    for trade in trades:
        for asset, _side, _pnl in trade.legs:
            counts[asset] += 1
        month = datetime.fromtimestamp(trade.entry_ts / 1000, UTC).strftime("%Y-%m")
        monthly[month] += trade.stress
    top_event_share = max((abs(trade.stress) / absolute for trade in trades), default=0.0) if absolute > 0 else 0.0
    top_positive_month_share = max((max(0.0, value) / positive for value in monthly.values()), default=0.0) if positive > 0 else 0.0
    base_metrics.update({
        "distinct_assets": len(counts),
        "asset_event_counts": dict(sorted(counts.items())),
        "top_event_absolute_pnl_share": round(top_event_share, 4),
        "top_positive_month_share": round(top_positive_month_share, 4),
    })
    return base_metrics


def period_eval(candidate: dict[str, Any], start: datetime, end: datetime, bars: dict[str, list[base.Bar]], contexts: dict[int, MarketContext], exclude: str | None = None) -> dict[str, Any]:
    start_ms, end_ms = base.ms(start), base.ms(end)
    trades = generate(candidate, start_ms, end_ms, contexts, bars, exclude)
    metrics = extended_metrics(trades)
    span = end_ms - start_ms
    quarters: list[dict[str, Any]] = []
    for index in range(4):
        left = start_ms + span * index // 4
        right = start_ms + span * (index + 1) // 4
        quarter_trades = generate(candidate, left, right, contexts, bars, exclude)
        quarters.append(extended_metrics(quarter_trades))
    return {
        "metrics": metrics,
        "quarters": quarters,
        "positive_quarters": sum(row["stress_bps"] > 0 for row in quarters),
        "minimum_quarter_trades": min((row["trades"] for row in quarters), default=0),
        "minimum_quarter_distinct_assets": min((row["distinct_assets"] for row in quarters), default=0),
    }


def period_gates(label: str, row: dict[str, Any]) -> dict[str, bool]:
    metrics = row["metrics"]
    minimum_trades = 32 if label in ("2023", "2024") else 24
    return {
        "positive_after_stress": metrics["stress_bps"] > 0,
        "stress_pf_at_least_1_10": metrics["stress_pf"] >= 1.10,
        "minimum_trades": metrics["trades"] >= minimum_trades,
        "positive_subwindows_3_of_4": row["positive_quarters"] >= 3,
        "positive_first_half": metrics["first_half_stress_bps"] > 0,
        "positive_second_half": metrics["second_half_stress_bps"] > 0,
        "maximum_asset_share_0_25": metrics["max_asset_exposure_share"] <= 0.25,
        "distinct_assets_at_least_6": metrics["distinct_assets"] >= 6,
        "minimum_quarter_events_3": row["minimum_quarter_trades"] >= 3,
        "minimum_quarter_assets_2": row["minimum_quarter_distinct_assets"] >= 2,
        "top_event_share_0_25": metrics["top_event_absolute_pnl_share"] <= 0.25,
        "top_positive_month_share_0_55": metrics["top_positive_month_share"] <= 0.55,
        "drawdown_not_larger_than_2x_gain": abs(metrics["max_drawdown_bps"]) <= max(500.0, 2.0 * metrics["stress_bps"]),
    }


def loo(candidate: dict[str, Any], start: datetime, end: datetime, bars: dict[str, list[base.Bar]], contexts: dict[int, MarketContext]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for asset in NON_BTC:
        result = period_eval(candidate, start, end, bars, contexts, exclude=asset)["metrics"]
        if result["trades"] > 0:
            rows.append(result)
    return {
        "positive_share": round(sum(row["stress_bps"] > 0 for row in rows) / len(rows), 4) if rows else 0.0,
        "median_mean_stress_bps": round(statistics.median(row["mean_stress_bps"] for row in rows), 3) if rows else 0.0,
    }


def robust_gates(period_rows: dict[str, dict[str, Any]], loo_rows: dict[str, dict[str, Any]]) -> dict[str, bool]:
    return {
        "all_period_gates": all(all(row["gates"].values()) for row in period_rows.values()),
        "minimum_total_trades_90": sum(row["metrics"]["trades"] for row in period_rows.values()) >= 90,
        "loo_positive_share_0_90": all(row["positive_share"] >= 0.90 for row in loo_rows.values()),
        "loo_median_mean_stress_5_bps": all(row["median_mean_stress_bps"] >= 5.0 for row in loo_rows.values()),
    }


def neighbor_signature(candidate: dict[str, Any]) -> tuple[Any, ...]:
    if candidate["family"] == "BETA_RESID_ENSEMBLE":
        return candidate["lane"], candidate["family"], candidate["hold_h"], candidate["confirmation"]
    return candidate["lane"], candidate["family"], candidate["hold_h"], candidate["breadth_min"]


def main() -> None:
    protocol = json.loads(PROTOCOL.read_text())
    if protocol["research_windows"] != [[start.isoformat(), end.isoformat()] for _label, start, end in PERIODS]:
        raise RuntimeError("protocol research windows mismatch")
    if protocol["final_holdout"]["accessed_before_lock"] is not False:
        raise RuntimeError("R7 final holdout not sealed")
    if protocol["final_holdout"]["window"] != ["2022-01-01T00:00:00+00:00", "2023-01-01T00:00:00+00:00"]:
        raise RuntimeError("unexpected final holdout")

    data: dict[str, tuple[dict[str, list[base.Bar]], dict[int, MarketContext]]] = {}
    for label, start, end in PERIODS:
        bars = loader.load_period(start, end)
        features, indices = base.build_features(bars)
        data[label] = (bars, build_contexts(bars, features, indices))

    results: dict[str, dict[str, Any]] = {}
    for candidate in CANDIDATES:
        period_rows: dict[str, dict[str, Any]] = {}
        basic_pass = True
        for label, start, end in PERIODS:
            bars, contexts = data[label]
            evaluation = period_eval(candidate, start, end, bars, contexts)
            gates = period_gates(label, evaluation)
            evaluation["gates"] = gates
            period_rows[label] = evaluation
            basic_pass = basic_pass and all(gates.values())
        results[candidate["key"] = {
            "candidate": candidate,
            "periods": period_rows,
            "basic_pass": basic_pass,
        }

    # True LOO is applied only after all non-LOO gates pass, but before plateau scoring.
    for key, result in results.items():
        if not result["basic_pass"]:
            result["robust_pass"] = False
            continue
        candidate = result["candidate"]
        loo_rows: dict[str, dict[str, Any]] = {}
        for label, start, end in PERIODS:
            bars, contexts = data[label]
            loo_rows[label] = loo(candidate, start, end, bars, contexts)
        gates = robust_gates(result["periods"], loo_rows)
        result["loo"] = loo_rows
        result["robust_gates"] = gates
        result["robust_pass"] = all(gates.values())

    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for result in results.values():
        groups[neighbor_signature(result["candidate"])].append(result)

    selected: dict[str, str | None] = {"RANGE": None, "BEAR": None}
    for lane in ("RANGE", "BEAR"):
        eligible: list[tuple[float, float, int, str]] = []
        for result in results.values():
            candidate = result["candidate"]
            if candidate["lane"] != lane or not result.get("robust_pass", False):
                continue
            neighbors = groups[neighbor_signature(candidate)]
            pass_share = sum(row.get("robust_pass", False) for row in neighbors) / len(neighbors)
            result["parameter_plateau"] = {
                "local_variants": len(neighbors),
                "robust_variants": sum(row.get("robust_pass", False) for row in neighbors),
                "pass_share": round(pass_share, 4),
                "passed": len(neighbors) >= 4 and pass_share >= 0.75,
            }
            if not result["parameter_plateau"]["passed"]:
                continue
            worst_mean = min(row["metrics"]["mean_stress_bps"] for row in result["periods"].values())
            worst_pf = min(row["metrics"]["stress_pf"] for row in result["periods"].values())
            total_trades = sum(row["metrics"]["trades"] for row in result["periods"].values())
            eligible.append((worst_mean, worst_pf, total_trades, candidate["key"]))
        if eligible:
            eligible.sort(reverse=True)
            selected[lane] = eligible[0][3]

    output = {
        "schema_version": 1,
        "revision": "V10_R7_BLOCKED_DISCOVERY_20260831",
        "test_accessed": False,
        "final_holdout_accessed": False,
        "final_holdout_window": protocol["final_holdout"]["window"],
        "research_windows": protocol["research_windows"],
        "universe": R7_ASSETS,
        "cost_model": {"base_round_trip_bps": xs.BASE_COST, "stress_round_trip_bps": xs.STRESS_COST, "funding_modeled": False},
        "candidate_universe_sha256": sha256_object(CANDIDATES),
        "candidate_count": len(CANDIDATES),
        "selected": selected,
        "results": results,
    }
    OUT.write_text(json.dumps(output, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    print("V10_R7_RESULT_BEGIN")
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    print("V10_R7_RESULT_END")


if __name__ == "__main__":
    main()
