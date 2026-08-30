#!/usr/bin/env python3
"""Independent V10 TRAIN/VALIDATION replay.

This is intentionally not imported by ``run.py`` and cannot create a
candidate lock or inspect the final TEST.  It reconstructs features from the
raw cached Binance and Upbit files, admits at most three concurrent positions,
and evaluates the four preregistered chronological validation folds.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd


UTC = timezone.utc
BAR_MS = 15 * 60 * 1_000
DAY_MS = 24 * 60 * 60 * 1_000
HERE = Path(__file__).resolve().parent
DEFAULT_CACHE = HERE.parents[2] / "v10-cache"
DEFAULT_OUTPUT = HERE / "independent-replay.json"
DEFAULT_PRIMARY = HERE / "discovery-results.json"


class ReplayError(RuntimeError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ReplayError(f"object expected in {path}")
    return value


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def iso_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, UTC).isoformat().replace("+00:00", "Z")


def normalize_ms(value: Any) -> int:
    number = int(value)
    return number // 1_000 if number > 100_000_000_000_000 else number


def schedule(prereg: dict[str, Any]) -> dict[str, Any]:
    data = prereg["data"]
    split = prereg["split_protocol"]
    start = int(parse_time(data["start_inclusive"]).timestamp() * 1000)
    registered_end = int(parse_time(data["end_exclusive"]).timestamp() * 1000)
    cutoff = start + int(split["candidate_selection_end_day"]) * DAY_MS
    test_start = cutoff + int(split["unused_pretest_days"]) * DAY_MS
    test_end = test_start + int(split["final_test_days"]) * DAY_MS
    if registered_end != test_end:
        raise ReplayError("registered split does not terminate at data end")
    if int(split["folds"]) != 4:
        raise ReplayError("independent replay requires exactly four folds")
    train_days = int(split["train_days"])
    validation_days = int(split["validation_days"])
    step_days = int(split["fold_step_days"])
    embargo = int(split["embargo_bars"])
    folds = []
    for offset in range(4):
        fold_start = start + offset * step_days * DAY_MS
        train_end = fold_start + train_days * DAY_MS
        validation_start = train_end + embargo * BAR_MS
        validation_end = fold_start + (train_days + validation_days) * DAY_MS
        folds.append(
            {
                "fold": offset + 1,
                "train_start_ms": fold_start,
                "train_end_ms": train_end,
                "validation_start_ms": validation_start,
                "validation_end_ms": validation_end,
            }
        )
    if folds[-1]["validation_end_ms"] != cutoff:
        raise ReplayError("fold 4 does not end at the discovery cutoff")
    return {
        "start_ms": start,
        "cutoff_ms": cutoff,
        "test_start_ms": test_start,
        "test_end_ms": test_end,
        "folds": folds,
    }


def validate_inputs(prereg: dict[str, Any], universe: dict[str, Any]) -> tuple[dict[str, Any], str]:
    sched = schedule(prereg)
    if prereg.get("v9_test_reuse_for_selection") is not False:
        raise ReplayError("V9 TEST reuse is not explicitly prohibited")
    if universe.get("revision") != prereg.get("revision"):
        raise ReplayError("candidate/preregistration revisions differ")
    payload = {key: value for key, value in universe.items() if key != "lock"}
    calculated = canonical_hash(payload)
    declared = universe.get("lock", {}).get("sha256")
    if declared != calculated:
        raise ReplayError(f"candidate universe hash mismatch: {declared!r} != {calculated}")
    candidates = universe.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ReplayError("candidate universe is empty")
    if any(candidate.get("enabled") is not True for candidate in candidates):
        raise ReplayError("disabled candidate present in locked universe")
    return sched, calculated


def strict_return(series: pd.Series, periods: int) -> pd.Series:
    result = series / series.shift(periods) - 1.0
    index = series.index.to_numpy(dtype=np.int64)
    continuous = np.zeros(len(series), dtype=bool)
    if len(series) > periods:
        continuous[periods:] = index[periods:] - index[:-periods] == periods * BAR_MS
    return result.where(continuous)


def prior_zscore(series: pd.Series, window: int) -> pd.Series:
    prior = series.shift(1).rolling(window, min_periods=window)
    std = prior.std(ddof=0)
    result = (series - prior.mean()) / std
    constant_complete_window = std.notna() & (std <= 1e-12) & series.notna()
    return result.mask(constant_complete_window, 0.0)


def read_binance(cache: Path, symbol: str, start_ms: int, cutoff_ms: int) -> tuple[pd.DataFrame, list[Path]]:
    directory = cache / "binance" / "futures_um" / "monthly" / "klines" / symbol / "15m"
    paths = sorted(directory.glob(f"{symbol}-15m-2025-*.zip"))
    if not paths:
        raise ReplayError(f"missing Binance cache for {symbol}: {directory}")
    rows: list[list[Any]] = []
    used: list[Path] = []
    for path in paths:
        month = int(path.stem.rsplit("-", 1)[-1])
        if month > 10:  # October is the only archive overlapping the October 8 cutoff.
            continue
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if name.endswith(".csv")]
            if len(names) != 1 or archive.testzip() is not None:
                raise ReplayError(f"invalid archive {path}")
            with archive.open(names[0]) as raw:
                frame = pd.read_csv(
                    io.BytesIO(raw.read()),
                    header=None,
                    names=[
                        "time_ms", "open", "high", "low", "close", "volume",
                        "close_ms", "quote_volume", "trades", "taker_buy_base",
                        "taker_buy_quote", "ignore",
                    ],
                    dtype=str,
                )
        frame = frame[pd.to_numeric(frame["time_ms"], errors="coerce").notna()].copy()
        frame["time_ms"] = frame["time_ms"].map(normalize_ms)
        frame["close_ms"] = frame["close_ms"].map(normalize_ms)
        frame = frame[(frame.time_ms >= start_ms) & (frame.time_ms < cutoff_ms) & (frame.close_ms < cutoff_ms)]
        for column in ("open", "high", "low", "close", "volume", "quote_volume", "taker_buy_base"):
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        rows.extend(frame[["time_ms", "open", "high", "low", "close", "volume", "quote_volume", "taker_buy_base"]].values.tolist())
        used.append(path)
    result = pd.DataFrame(rows, columns=["time_ms", "open", "high", "low", "close", "volume", "quote_volume", "taker_buy_base"])
    result = result.dropna().drop_duplicates("time_ms", keep="last").sort_values("time_ms").set_index("time_ms")
    if result.empty or result.index.max() >= cutoff_ms:
        raise ReplayError(f"bad discovery slice for {symbol}")
    return result, used


def upbit_cache_file(cache: Path, market: str, start_ms: int, cutoff_ms: int) -> Path:
    directory = cache / "upbit" / market / "15m"
    exact = directory / f"{start_ms}-{cutoff_ms}.jsonl"
    if exact.exists():
        return exact
    # Refuse larger snapshots: opening a full-year file would touch final TEST.
    compatible = []
    for path in directory.glob("*.jsonl"):
        try:
            file_start, file_end = (int(part) for part in path.stem.split("-", 1))
        except ValueError:
            continue
        if file_start <= start_ms and file_end == cutoff_ms:
            compatible.append(path)
    if not compatible:
        raise ReplayError(f"no TEST-safe Upbit cache for {market}; expected {exact}")
    return max(compatible, key=lambda path: int(path.stem.split("-", 1)[1]))


def read_upbit(cache: Path, market: str, start_ms: int, cutoff_ms: int) -> tuple[pd.DataFrame, Path]:
    path = upbit_cache_file(cache, market, start_ms, cutoff_ms)
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            raw = json.loads(line)
            if "open_time_ms" in raw:
                timestamp = normalize_ms(raw["open_time_ms"])
                values = (
                    raw.get("open"), raw.get("high"), raw.get("low"), raw.get("close"),
                    raw.get("volume"), raw.get("quote_volume"), bool(raw.get("synthetic", False)),
                )
            else:
                timestamp_text = str(raw["candle_date_time_utc"])
                timestamp = int(parse_time(timestamp_text + ("" if timestamp_text.endswith("Z") else "Z")).timestamp() * 1000)
                values = (
                    raw.get("opening_price"), raw.get("high_price"), raw.get("low_price"),
                    raw.get("trade_price"), raw.get("candle_acc_trade_volume"),
                    raw.get("candle_acc_trade_price"), False,
                )
            if start_ms <= timestamp < cutoff_ms and not values[-1]:
                rows.append((timestamp, *values[:-1]))
    frame = pd.DataFrame(rows, columns=["time_ms", "up_open", "up_high", "up_low", "up_close", "up_volume", "up_quote_volume"])
    if frame.empty:
        raise ReplayError(f"empty Upbit discovery slice for {market}")
    for column in frame.columns[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.dropna().drop_duplicates("time_ms", keep="last").sort_values("time_ms").set_index("time_ms")
    if frame.index.max() >= cutoff_ms:
        raise ReplayError(f"Upbit TEST guard failed for {market}")
    return frame, path


def asset_features(asset: str, binary: pd.DataFrame, upbit: pd.DataFrame) -> pd.DataFrame:
    frame = binary.copy()
    frame["asset"] = asset
    frame["bin_ret1"] = strict_return(frame.close, 1)
    frame["bin_ret4"] = strict_return(frame.close, 4)
    frame["bin_ret96"] = strict_return(frame.close, 96)
    frame["bin_ret1_bps"] = frame.bin_ret1 * 10_000
    frame["bin_ret4_bps"] = frame.bin_ret4 * 10_000
    frame["bin_volume_z"] = prior_zscore(np.log1p(frame.quote_volume.clip(lower=0)), 96)
    previous_close = frame.close.shift(1)
    true_range = pd.concat(
        [(frame.high - frame.low), (frame.high - previous_close).abs(), (frame.low - previous_close).abs()],
        axis=1,
    ).max(axis=1)
    frame["atr"] = true_range.rolling(14, min_periods=14).mean()
    frame["atr_bps"] = frame.atr / frame.close * 10_000
    typical = (frame.high + frame.low + frame.close) / 3
    vwap_numerator = (typical * frame.volume.clip(lower=0)).rolling(16, min_periods=16).sum()
    vwap_denominator = frame.volume.clip(lower=0).rolling(16, min_periods=16).sum()
    vwap16 = (vwap_numerator / vwap_denominator).where(vwap_denominator > 1e-12)
    index_values = frame.index.to_numpy(dtype=np.int64)
    vwap_continuous = np.zeros(len(frame), dtype=bool)
    vwap_continuous[15:] = index_values[15:] - index_values[:-15] == 15 * BAR_MS
    vwap16 = vwap16.where(vwap_continuous)
    frame["vwap_deviation_atr"] = ((frame.close - vwap16) / frame.atr).where(frame.atr > 1e-12)
    exact_prior = pd.Series(False, index=frame.index)
    exact_prior.iloc[1:] = index_values[1:] - index_values[:-1] == BAR_MS
    frame["prior_bin_ret1_bps"] = frame.bin_ret1_bps.shift(1).where(exact_prior)
    frame["prior_bin_ret4_bps"] = frame.bin_ret4_bps.shift(1).where(exact_prior)
    frame["prior_bin_volume_z"] = frame.bin_volume_z.shift(1).where(exact_prior)
    frame["prior_atr_bps"] = frame.atr_bps.shift(1).where(exact_prior)
    candle_range = frame.high - frame.low
    frame["close_location"] = ((frame.close - frame.low) / candle_range).clip(0, 1).where(candle_range > 1e-12, 0.5)
    rv16 = frame.bin_ret1.shift(1).rolling(16, min_periods=16).std(ddof=0)
    rv96 = frame.bin_ret1.shift(1).rolling(96, min_periods=96).std(ddof=0)
    frame["prior_rv_ratio"] = (rv16 / rv96).where(rv96 > 1e-12)
    frame["ema72h"] = frame.close.ewm(span=288, adjust=False, min_periods=288).mean()
    path = frame.close.diff().abs().rolling(96, min_periods=96).sum()
    frame["trend_efficiency24h"] = ((frame.close - frame.close.shift(96)).abs() / path).where(path > 0)
    frame["bin_taker_signed"] = (2 * frame.taker_buy_base / frame.volume - 1).clip(-1, 1).where(frame.volume > 0)

    # Missing Upbit candles remain missing.  A signal requires the completed
    # actual candle and the exact lagged actual candle; no zero-volume fill.
    joined = frame.join(upbit, how="left")
    joined["up_ret1"] = strict_return(joined.up_close, 1).where(
        joined.up_close.notna().rolling(2, min_periods=2).sum() == 2
    )
    joined["up_ret4"] = strict_return(joined.up_close, 4).where(
        joined.up_close.notna().rolling(5, min_periods=5).sum() == 5
    )
    joined["up_ret1_bps"] = joined.up_ret1 * 10_000
    joined["up_ret4_bps"] = joined.up_ret4 * 10_000
    joined["up_volume_z"] = prior_zscore(np.log1p(joined.up_quote_volume.clip(lower=0)), 96)
    joined["residual1_bps"] = (joined.up_ret1 - joined.bin_ret1) * 10_000
    joined["residual4_bps"] = (joined.up_ret4 - joined.bin_ret4) * 10_000
    joined["time_ms"] = joined.index.astype(np.int64)
    return joined.reset_index(drop=True)


def enrich(features: pd.DataFrame) -> pd.DataFrame:
    frame = features.copy()
    btc_returns = frame[frame.asset == "BTC"].set_index("time_ms")[["bin_ret1_bps", "bin_ret4_bps"]]
    eth_returns = frame[frame.asset == "ETH"].set_index("time_ms")[["bin_ret1_bps", "bin_ret4_bps"]]
    frame["beta_residual4_bps"] = np.nan
    for asset in sorted(set(frame.asset) - {"BTC", "ETH"}):
        index = frame.index[frame.asset == asset]
        rows = frame.loc[index].sort_values("time_ms")
        x1 = rows.time_ms.map(btc_returns.bin_ret1_bps)
        x2 = rows.time_ms.map(eth_returns.bin_ret1_bps)
        y = rows.bin_ret1_bps
        # Prior, non-overlapping 96-bar regression ending at t-4.
        def prior_roll(series: pd.Series) -> pd.Series:
            return series.rolling(96, min_periods=96).sum().shift(4)
        n = 96.0
        sx1, sx2, sy = prior_roll(x1), prior_roll(x2), prior_roll(y)
        sx1x1, sx2x2 = prior_roll(x1 * x1), prior_roll(x2 * x2)
        sx1x2 = prior_roll(x1 * x2)
        sx1y, sx2y = prior_roll(x1 * y), prior_roll(x2 * y)
        mean_x1, mean_x2, mean_y = sx1 / n, sx2 / n, sy / n
        s11 = sx1x1 - sx1 * sx1 / n
        s22 = sx2x2 - sx2 * sx2 / n
        s12 = sx1x2 - sx1 * sx2 / n
        sy1 = sx1y - sx1 * sy / n
        sy2 = sx2y - sx2 * sy / n
        determinant = s11 * s22 - s12 * s12
        beta_btc = ((sy1 * s22 - sy2 * s12) / determinant).where(determinant > 1e-9)
        beta_eth = ((sy2 * s11 - sy1 * s12) / determinant).where(determinant > 1e-9)
        alpha = mean_y - beta_btc * mean_x1 - beta_eth * mean_x2
        btc4 = rows.time_ms.map(btc_returns.bin_ret4_bps)
        eth4 = rows.time_ms.map(eth_returns.bin_ret4_bps)
        expected = 4 * alpha + beta_btc * btc4 + beta_eth * eth4
        frame.loc[rows.index, "beta_residual4_bps"] = (rows.bin_ret4_bps - expected).to_numpy()
    valid96 = frame.bin_ret96.notna()
    counts96 = valid96.groupby(frame.time_ms).transform("sum")
    positives96 = (frame.bin_ret96 > 0).where(valid96, False).groupby(frame.time_ms).transform("sum")
    frame["breadth24h"] = positives96 / counts96.replace(0, np.nan)
    frame["breadth24h_assets"] = counts96

    valid_up = frame.up_ret1.notna()
    counts_up = valid_up.groupby(frame.time_ms).transform("sum")
    positives_up = (frame.up_ret1 > 0).where(valid_up, False).groupby(frame.time_ms).transform("sum")
    frame["upbit_breadth1"] = positives_up / counts_up.replace(0, np.nan)
    frame["upbit_breadth_assets"] = counts_up
    breadth_map = frame.drop_duplicates("time_ms").set_index("time_ms").upbit_breadth1
    frame["upbit_breadth_change4"] = frame.upbit_breadth1 - (frame.time_ms - 4 * BAR_MS).map(breadth_map)

    order = frame.sort_values(["time_ms", "residual1_bps", "asset"], kind="stable").index
    ranked = frame.loc[order].copy()
    ranked["residual_rank"] = ranked.groupby("time_ms").residual1_bps.rank(method="first") - 1
    ranked["residual_rank_assets"] = ranked.groupby("time_ms").residual1_bps.transform("count")
    denominator = (ranked.residual_rank_assets - 1).replace(0, np.nan)
    ranked["residual_percentile"] = (ranked.residual_rank / denominator).fillna(0.5)
    frame.loc[ranked.index, "residual_rank_assets"] = ranked.residual_rank_assets
    frame.loc[ranked.index, "residual_percentile"] = ranked.residual_percentile
    beta_order = frame[~frame.asset.isin(["BTC", "ETH"])].sort_values(
        ["time_ms", "beta_residual4_bps", "asset"], kind="stable"
    ).index
    beta_ranked = frame.loc[beta_order].copy()
    beta_ranked["beta_residual_rank"] = beta_ranked.groupby("time_ms").beta_residual4_bps.rank(method="first") - 1
    beta_ranked["beta_residual_rank_assets"] = beta_ranked.groupby("time_ms").beta_residual4_bps.transform("count")
    beta_denominator = (beta_ranked.beta_residual_rank_assets - 1).replace(0, np.nan)
    beta_ranked["beta_residual_percentile"] = (beta_ranked.beta_residual_rank / beta_denominator).fillna(0.5)
    frame.loc[beta_ranked.index, "beta_residual_rank_assets"] = beta_ranked.beta_residual_rank_assets
    frame.loc[beta_ranked.index, "beta_residual_percentile"] = beta_ranked.beta_residual_percentile

    btc = frame[frame.asset == "BTC"].set_index("time_ms")
    for source, target in (
        ("bin_ret96", "btc_ret96"), ("ema72h", "btc_ema72h"),
        ("trend_efficiency24h", "btc_efficiency24h"), ("close", "btc_close"),
    ):
        frame[target] = frame.time_ms.map(btc[source])
    strong_bear = (
        (frame.btc_ret96 <= -0.03) & (frame.btc_close < frame.btc_ema72h) & (frame.breadth24h <= 0.30)
    )
    bear = (
        (frame.btc_ret96 <= -0.01) & (frame.btc_close < frame.btc_ema72h) & (frame.breadth24h <= 0.45)
    )
    range_regime = (
        (frame.btc_ret96.abs() <= 0.02) & (frame.btc_efficiency24h <= 0.35)
        & frame.breadth24h.between(0.30, 0.70)
    )
    frame["regime"] = np.select([strong_bear, bear, range_regime], ["STRONG_BEAR", "BEAR", "RANGE"], default="OTHER")
    frame["tactical"] = "STABLE"
    prior_drop_atr = -frame.prior_bin_ret1_bps / frame.prior_atr_bps
    capitulation = (
        frame.regime.isin(["BEAR", "STRONG_BEAR"]) & (prior_drop_atr >= 0.8)
        & (frame.prior_bin_volume_z >= 1.5) & (frame.bin_ret1_bps > 0)
    )
    rebound_failure = (
        frame.regime.isin(["BEAR", "STRONG_BEAR"]) & (frame.prior_bin_ret4_bps > 0)
        & (frame.bin_ret1_bps < 0)
    )
    frame.loc[capitulation, "tactical"] = "CAPITULATION_RECOVERY"
    frame.loc[rebound_failure & (frame.tactical == "STABLE"), "tactical"] = "REBOUND_FAILURE"
    frame.loc[(frame.prior_rv_ratio <= 0.65) & (frame.tactical == "STABLE"), "tactical"] = "COMPRESSION"
    expansion = frame.bin_ret1_bps.abs() >= 0.8 * frame.atr_bps
    frame.loc[expansion & (frame.tactical == "STABLE"), "tactical"] = "EXPANSION"
    bear_mask = frame.regime.isin(["BEAR", "STRONG_BEAR"]) & (frame.tactical == "STABLE")
    frame.loc[bear_mask & (frame.bin_ret4_bps > 0), "tactical"] = "REBOUND"
    frame.loc[bear_mask & (frame.bin_ret4_bps <= 0), "tactical"] = "REBREAK"
    return frame


def signal_frame(frame: pd.DataFrame, candidate: dict[str, Any]) -> pd.DataFrame:
    family = candidate["family"]
    p = candidate["parameters"]
    side = pd.Series(0, index=frame.index, dtype=np.int8)
    strength = pd.Series(np.nan, index=frame.index)
    condition = pd.Series(False, index=frame.index)
    def excess(observed: pd.Series, threshold: float) -> pd.Series:
        return (observed / max(abs(threshold), 1e-9) - 1).clip(lower=0)

    if family in {"UPBIT_LEAD_CONTINUATION", "KOREAN_VOLUME_SHOCK_TRANSMISSION", "INTRADAY_SEASONALITY_CONDITIONAL_TRANSMISSION"}:
        up_move = frame.up_ret1_bps
        signed = np.sign(up_move).fillna(0).astype(np.int8)
        follow_limit = up_move.abs() * float(p["max_binance_follow_ratio"])
        min_move = float(p["min_upbit_move_bps"])
        min_volume = float(p["min_upbit_quote_volume_z"])
        condition = (up_move.abs() >= min_move) & (frame.bin_ret1_bps.abs() <= follow_limit) & (frame.up_volume_z >= min_volume)
        if family == "INTRADAY_SEASONALITY_CONDITIONAL_TRANSMISSION":
            hours = pd.to_datetime(frame.time_ms, unit="ms", utc=True).dt.hour
            condition &= hours.isin(p["utc_hours"])
        side = signed
        strength = (
            excess(up_move.abs(), min_move)
            + (1 - frame.bin_ret1_bps.abs() / follow_limit.clip(lower=1e-9)).clip(lower=0)
            + excess(frame.up_volume_z, min_volume)
        )
    elif family == "UPBIT_BINANCE_DIVERGENCE_CONVERGENCE":
        residual = frame.residual4_bps
        side = np.sign(residual).fillna(0).astype(np.int8)
        condition = (
            residual.abs().between(float(p["min_divergence_bps"]), float(p["max_divergence_bps"]))
            & (frame.up_ret4_bps.abs() >= float(p["min_upbit_absolute_move_bps"]))
        )
        strength = excess(residual.abs(), float(p["min_divergence_bps"]))
    elif family == "CROSS_SECTIONAL_KOREAN_RESIDUAL_RANK":
        tail = float(p["tail_fraction"])
        upper = frame.residual_percentile >= 1 - tail
        lower = frame.residual_percentile <= tail
        side = upper.astype(np.int8) - lower.astype(np.int8)
        condition = (
            (upper | lower) & (frame.residual1_bps.abs() >= float(p["min_absolute_residual_bps"]))
            & (frame.residual_rank_assets >= int(p["minimum_ranked_assets"]))
        )
        strength = (
            excess((frame.residual_percentile - 0.5).abs(), 0.5 - tail)
            + excess(frame.residual1_bps.abs(), float(p["min_absolute_residual_bps"]))
        )
    elif family == "CROSS_EXCHANGE_BREADTH_PROPAGATION":
        change = frame.upbit_breadth_change4
        upper = (frame.upbit_breadth1 >= float(p["upper_breadth"])) & (change >= float(p["min_four_bar_breadth_change"]))
        lower = (frame.upbit_breadth1 <= float(p["lower_breadth"])) & (change <= -float(p["min_four_bar_breadth_change"]))
        side = upper.astype(np.int8) - lower.astype(np.int8)
        condition = (
            (upper | lower) & (frame.bin_ret1_bps.abs() <= float(p["max_binance_absolute_move_bps"]))
            & (frame.upbit_breadth_assets >= int(p["minimum_breadth_assets"]))
        )
        breadth_threshold = pd.Series(
            np.where(side > 0, abs(float(p["upper_breadth"]) - 0.5), abs(float(p["lower_breadth"]) - 0.5)),
            index=frame.index,
        )
        strength = excess(change.abs(), float(p["min_four_bar_breadth_change"])) + (
            (frame.upbit_breadth1.sub(0.5).abs() / breadth_threshold.clip(lower=1e-9) - 1).clip(lower=0)
        ) + (1 - frame.bin_ret1_bps.abs() / max(float(p["max_binance_absolute_move_bps"]), 1e-9)).clip(lower=0)
    elif family == "CROSS_EXCHANGE_FLOW_DISAGREEMENT":
        up_move = frame.up_ret1_bps
        side = np.sign(up_move).fillna(0).astype(np.int8)
        condition = (
            (up_move.abs() >= float(p["min_upbit_move_bps"]))
            & (frame.up_volume_z >= float(p["min_upbit_quote_volume_z"]))
            & (side * frame.bin_taker_signed <= -float(p["min_opposite_binance_taker_imbalance"]))
            & (frame.bin_ret1_bps.abs() <= float(p["max_binance_absolute_move_bps"]))
        )
        disagreement = -side * frame.bin_taker_signed
        strength = (
            excess(up_move.abs(), float(p["min_upbit_move_bps"]))
            + excess(disagreement, float(p["min_opposite_binance_taker_imbalance"]))
            + excess(frame.up_volume_z, float(p["min_upbit_quote_volume_z"]))
        )
    elif family == "KOREAN_FLOW_CONDITIONAL_VOLATILITY_BREAKOUT":
        side = np.sign(frame.bin_ret1_bps).fillna(0).astype(np.int8)
        condition = (
            (frame.prior_rv_ratio <= float(p["max_prior_rv16_to_rv96"]))
            & (frame.bin_ret1_bps.abs() >= float(p["min_breakout_atr"]) * frame.atr_bps)
            & (side * frame.up_ret1_bps >= float(p["min_upbit_confirmation_bps"]))
            & (frame.up_volume_z >= float(p["min_upbit_quote_volume_z"]))
        )
        breakout_atr = frame.bin_ret1_bps.abs() / frame.atr_bps.replace(0, np.nan)
        strength = (
            (1 - frame.prior_rv_ratio / max(float(p["max_prior_rv16_to_rv96"]), 1e-9)).clip(lower=0)
            + excess(breakout_atr, float(p["min_breakout_atr"]))
            + excess(frame.up_ret1_bps.abs(), float(p["min_upbit_confirmation_bps"]))
            + excess(frame.up_volume_z, float(p["min_upbit_quote_volume_z"]))
        )
    elif family == "RANGE_VWAP_VOL_NORMALIZED_REVERSAL":
        deviation = frame.vwap_deviation_atr
        move_atr = frame.bin_ret4_bps / frame.atr_bps
        minimum_deviation = float(p["min_abs_vwap_deviation_atr"])
        minimum_move = float(p["min_abs_four_bar_move_atr"])
        maximum_efficiency = float(p["max_trend_efficiency24h"])
        condition = (
            (deviation.abs() >= minimum_deviation) & (move_atr.abs() >= minimum_move)
            & ((deviation > 0) == (move_atr > 0))
            & (frame.trend_efficiency24h <= maximum_efficiency) & (frame.atr_bps > 1e-9)
        )
        side = -np.sign(deviation).fillna(0).astype(np.int8)
        strength = (
            excess(deviation.abs(), minimum_deviation) + excess(move_atr.abs(), minimum_move)
            + (1 - frame.trend_efficiency24h / max(maximum_efficiency, 1e-9)).clip(lower=0)
        )
    elif family == "BEAR_WEAK_REBOUND_FAILURE_SHORT":
        rebound_atr = frame.prior_bin_ret4_bps / frame.atr_bps
        renewed_sell_atr = -frame.bin_ret1_bps / frame.atr_bps
        minimum_rebound = float(p["min_prior_rebound_atr"])
        maximum_rebound = float(p["max_prior_rebound_atr"])
        minimum_sell = float(p["min_renewed_sell_atr"])
        maximum_close = float(p["max_close_location"])
        condition = (
            rebound_atr.between(minimum_rebound, maximum_rebound)
            & (renewed_sell_atr >= minimum_sell) & (frame.close_location <= maximum_close)
            & (frame.atr_bps > 1e-9)
        )
        side = pd.Series(-1, index=frame.index, dtype=np.int8)
        strength = (
            excess(rebound_atr, minimum_rebound) + excess(renewed_sell_atr, minimum_sell)
            + (1 - frame.close_location / max(maximum_close, 1e-9)).clip(lower=0)
        )
    elif family == "BEAR_VOLUME_CAPITULATION_RECOVERY_LONG":
        prior_drop_atr = -frame.prior_bin_ret1_bps / frame.prior_atr_bps
        recovery_atr = frame.bin_ret1_bps / frame.atr_bps
        recovery_fraction = frame.bin_ret1_bps / (-frame.prior_bin_ret1_bps).clip(lower=1e-9)
        minimum_drop = float(p["min_prior_drop_atr"])
        minimum_volume = float(p["min_prior_quote_volume_z"])
        minimum_recovery = float(p["min_recovery_atr"])
        minimum_fraction = float(p["min_recovery_fraction"])
        maximum_fraction = float(p["max_recovery_fraction"])
        minimum_close = float(p["min_recovery_close_location"])
        condition = (
            (prior_drop_atr >= minimum_drop) & (frame.prior_bin_volume_z >= minimum_volume)
            & (recovery_atr >= minimum_recovery)
            & recovery_fraction.between(minimum_fraction, maximum_fraction)
            & (frame.close_location >= minimum_close)
            & (frame.prior_atr_bps > 1e-9) & (frame.atr_bps > 1e-9)
        )
        side = pd.Series(1, index=frame.index, dtype=np.int8)
        strength = (
            excess(prior_drop_atr, minimum_drop) + excess(frame.prior_bin_volume_z, minimum_volume)
            + excess(recovery_atr, minimum_recovery) + excess(recovery_fraction, minimum_fraction)
            + excess(frame.close_location, minimum_close)
        )
    elif family == "BINANCE_BETA_RESIDUAL_CROSS_SECTIONAL_CONTINUATION":
        residual = frame.beta_residual4_bps
        tail = float(p["tail_fraction"])
        minimum_residual = float(p["min_absolute_residual_bps"])
        upper = (frame.beta_residual_percentile >= 1 - tail) & (residual > 0)
        lower = (frame.beta_residual_percentile <= tail) & (residual < 0)
        condition = (
            (upper | lower) & (residual.abs() >= minimum_residual)
            & (frame.beta_residual_rank_assets >= int(p["minimum_ranked_assets"]))
        )
        side = upper.astype(np.int8) - lower.astype(np.int8)
        strength = (
            excess((frame.beta_residual_percentile - 0.5).abs(), 0.5 - tail)
            + excess(residual.abs(), minimum_residual)
        )
    else:
        raise ReplayError(f"unsupported family {family}")
    allowed = {1 if value == "LONG" else -1 for value in candidate["allowed_sides"]}
    condition &= frame.regime.isin(candidate["regimes"]) & side.isin(allowed) & frame.atr.notna()
    result = frame.loc[condition, ["asset", "time_ms", "atr", "regime", "tactical"]].copy()
    result["side"] = side[condition]
    result["strength"] = strength[condition]
    return result.sort_values(["time_ms", "strength", "asset"], ascending=[True, False, True], kind="stable")


def simulate_one(
    signal: Any,
    bars: dict[str, pd.DataFrame],
    validation_end_ms: int,
    execution: dict[str, Any],
) -> dict[str, Any] | None:
    asset = str(signal.asset)
    signal_ms = int(signal.time_ms)
    frame = bars[asset]
    entry_ms = signal_ms + BAR_MS
    required = np.arange(entry_ms, entry_ms + int(execution["max_holding_bars"]) * BAR_MS, BAR_MS, dtype=np.int64)
    if required[-1] + BAR_MS > validation_end_ms or not np.isin(required, frame.index.to_numpy()).all():
        return None
    window = frame.loc[required]
    entry = float(window.iloc[0].open)
    side = int(signal.side)
    stop_distance = float(np.clip(float(execution["stop_atr"]) * signal.atr, entry * execution["minimum_barrier_bps"] / 10_000, entry * execution["maximum_barrier_bps"] / 10_000))
    target_distance = float(np.clip(float(execution["target_atr"]) * signal.atr, entry * execution["minimum_barrier_bps"] / 10_000, entry * execution["maximum_barrier_bps"] / 10_000))
    stop = entry - side * stop_distance
    target = entry + side * target_distance
    exit_price = float(window.iloc[-1].close)
    exit_ms = int(required[-1] + BAR_MS - 1)
    reason = "TIME"
    mae = math.inf
    mfe = -math.inf
    bars_held = len(window)
    for offset, (timestamp, bar) in enumerate(window.iterrows(), 1):
        if side == 1:
            adverse = (float(bar.low) / entry - 1) * 10_000
            favorable = (float(bar.high) / entry - 1) * 10_000
            stop_hit, target_hit = float(bar.low) <= stop, float(bar.high) >= target
        else:
            adverse = (1 - float(bar.high) / entry) * 10_000
            favorable = (1 - float(bar.low) / entry) * 10_000
            stop_hit, target_hit = float(bar.high) >= stop, float(bar.low) <= target
        mae, mfe = min(mae, adverse), max(mfe, favorable)
        # Conservative ordering if both levels occur inside one OHLC bar.
        adverse_open_gap = float(bar.open) <= stop if side == 1 else float(bar.open) >= stop
        if adverse_open_gap:
            exit_price, exit_ms, reason, bars_held = float(bar.open), int(timestamp + BAR_MS - 1), "STOP_GAP", offset
            break
        if stop_hit:
            exit_price, exit_ms, reason, bars_held = stop, int(timestamp + BAR_MS - 1), "STOP", offset
            break
        if target_hit:
            exit_price, exit_ms, reason, bars_held = target, int(timestamp + BAR_MS - 1), "TARGET", offset
            break
    funding_ms = 8 * 60 * 60 * 1_000
    next_funding = (entry_ms // funding_ms + 1) * funding_ms
    if next_funding <= exit_ms:
        return None
    gross = side * (exit_price / entry - 1) * 10_000
    return {
        "asset": asset,
        "signal_ms": signal_ms,
        "entry_ms": entry_ms,
        "exit_ms": exit_ms,
        "side": side,
        "regime": str(signal.regime),
        "tactical": str(signal.tactical),
        "strength": float(signal.strength),
        "gross_bps": gross,
        "base_bps": gross - float(execution["base_round_trip_cost_bps"]),
        "stress_bps": gross - float(execution["stress_round_trip_cost_bps"]),
        "mae_bps": mae,
        "mfe_bps": mfe,
        "bars_held": bars_held,
        "exit_reason": reason,
    }


def admit(signals: pd.DataFrame, bars: dict[str, pd.DataFrame], fold: dict[str, Any], execution: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    start, end = fold["validation_start_ms"], fold["validation_end_ms"]
    eligible = signals[(signals.time_ms >= start) & (signals.time_ms < end)].copy()
    if not eligible.empty:
        has_next_open = [
            int(row.time_ms) + BAR_MS in bars[str(row.asset)].index
            for row in eligible.itertuples(index=False)
        ]
        eligible = eligible.loc[has_next_open]
    grouped: defaultdict[int, list[Any]] = defaultdict(list)
    for row in eligible.itertuples(index=False):
        grouped[int(row.time_ms) + BAR_MS].append(row)
    active: list[dict[str, Any]] = []
    admitted: list[dict[str, Any]] = []
    cap = int(execution["portfolio_max_concurrent_positions"])
    for entry_ms in sorted(grouped):
        active = [trade for trade in active if trade["exit_ms"] >= entry_ms]
        occupied = {trade["asset"] for trade in active}
        for signal in sorted(grouped[entry_ms], key=lambda row: (-float(row.strength), str(row.asset))):
            asset = str(signal.asset)
            if len(active) >= cap:
                break
            if asset in occupied:
                continue
            trade = simulate_one(signal, bars, end, execution)
            if trade is None:
                continue
            active.append(trade)
            admitted.append(trade)
            occupied.add(asset)
    return admitted, len(eligible)


def drawdown(values: Iterable[float]) -> float:
    equity = peak = worst = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        worst = max(worst, peak - equity)
    return worst


def metric(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "trades": 0, "signal_days": 0, "stress_total_bps": 0.0,
            "stress_mean_bps": None, "stress_profit_factor": None,
            "max_drawdown_bps": 0.0, "max_market_share": None,
        }
    chronological = sorted(trades, key=lambda row: (row["entry_ms"], row["asset"]))
    gross = np.array([trade["gross_bps"] for trade in trades])
    base = np.array([trade["base_bps"] for trade in trades])
    stress = np.array([trade["stress_bps"] for trade in trades])
    positive = stress[stress > 0].sum()
    negative = -stress[stress < 0].sum()
    pf = (None if positive <= 1e-12 else 999.0) if negative <= 1e-12 else float(positive / negative)
    markets: defaultdict[str, int] = defaultdict(int)
    months: defaultdict[str, list[float]] = defaultdict(list)
    regimes: defaultdict[str, list[float]] = defaultdict(list)
    tacticals: defaultdict[str, list[float]] = defaultdict(list)
    exits: defaultdict[str, int] = defaultdict(int)
    for trade in trades:
        markets[trade["asset"]] += 1
        months[iso_ms(trade["signal_ms"])[:7]].append(trade["stress_bps"])
        regimes[trade["regime"]].append(trade["stress_bps"])
        tacticals[trade["tactical"]].append(trade["stress_bps"])
        exits[trade["exit_reason"]] += 1
    return {
        "trades": len(trades),
        "signal_days": len({iso_ms(trade["signal_ms"])[:10] for trade in trades}),
        "win_rate_stress": round(float((stress > 0).mean()), 6),
        "gross_total_bps": round(float(gross.sum()), 6),
        "base_total_bps": round(float(base.sum()), 6),
        "stress_total_bps": round(float(stress.sum()), 6),
        "gross_mean_bps": round(float(gross.mean()), 6),
        "base_mean_bps": round(float(base.mean()), 6),
        "stress_mean_bps": round(float(stress.mean()), 6),
        "stress_profit_factor": None if pf is None else round(pf, 6),
        "max_drawdown_bps": round(drawdown(row["stress_bps"] for row in chronological), 6),
        "stress_downside_p05_bps": round(float(np.quantile(stress, 0.05)), 6),
        "average_mae_bps": round(float(np.mean([trade["mae_bps"] for trade in trades])), 6),
        "average_mfe_bps": round(float(np.mean([trade["mfe_bps"] for trade in trades])), 6),
        "average_holding_bars": round(float(np.mean([trade["bars_held"] for trade in trades])), 6),
        "turnover_legs": 2 * len(trades),
        "max_market_share": round(max(markets.values()) / len(trades), 6),
        "by_market": {key: {"trades": value, "share": round(value / len(trades), 6)} for key, value in sorted(markets.items())},
        "by_month": {key: {"trades": len(value), "stress_total_bps": round(sum(value), 6)} for key, value in sorted(months.items())},
        "by_regime": {key: {"trades": len(value), "stress_total_bps": round(sum(value), 6)} for key, value in sorted(regimes.items())},
        "by_tactical": {key: {"trades": len(value), "stress_total_bps": round(sum(value), 6)} for key, value in sorted(tacticals.items())},
        "exit_reasons": dict(sorted(exits.items())),
    }


def base_gate(metrics: dict[str, Any], fold_metrics: list[dict[str, Any]], gates: dict[str, Any]) -> tuple[bool, list[str]]:
    positive_folds = sum(row["stress_total_bps"] > 0 for row in fold_metrics)
    failures = []
    profit_factor = metrics["stress_profit_factor"]
    profit_factor_pass = (
        profit_factor is not None and profit_factor >= float(gates["validation_min_stress_profit_factor"])
    ) or (
        profit_factor is None and metrics["trades"] > 0 and metrics["stress_total_bps"] > 0
    )
    checks = (
        (metrics["trades"] >= int(gates["validation_min_trades"]), "MIN_TRADES"),
        (metrics["signal_days"] >= int(gates["validation_min_signal_days"]), "MIN_SIGNAL_DAYS"),
        (positive_folds >= int(gates["validation_positive_stress_folds"]), "POSITIVE_FOLDS"),
        (profit_factor_pass, "STRESS_PROFIT_FACTOR"),
        ((metrics["stress_mean_bps"] or -math.inf) >= float(gates["validation_min_mean_stress_bps_per_trade"]), "STRESS_MEAN"),
        ((metrics["max_market_share"] or 1) <= float(gates["validation_max_single_market_trade_share"]), "MARKET_CONCENTRATION"),
    )
    for passed, label in checks:
        if not passed:
            failures.append(label)
    return not failures, failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--preregistration", type=Path, default=HERE / "preregistration.json")
    parser.add_argument("--candidates", type=Path, default=HERE / "candidate-universe.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--primary", type=Path, default=DEFAULT_PRIMARY)
    args = parser.parse_args()

    prereg = read_json(args.preregistration)
    universe = read_json(args.candidates)
    sched, universe_hash = validate_inputs(prereg, universe)
    assets = [str(asset) for asset in prereg["data"]["assets"]]
    feature_parts = []
    bars: dict[str, pd.DataFrame] = {}
    used_files: list[Path] = []
    for asset in assets:
        binary, bin_paths = read_binance(args.cache, f"{asset}USDT", sched["start_ms"], sched["cutoff_ms"])
        upbit, up_path = read_upbit(args.cache, f"KRW-{asset}", sched["start_ms"], sched["cutoff_ms"])
        bars[asset] = binary
        feature_parts.append(asset_features(asset, binary, upbit))
        used_files.extend(bin_paths)
        used_files.append(up_path)
    features = enrich(pd.concat(feature_parts, ignore_index=True))

    results: dict[str, Any] = {}
    execution = prereg["execution"]
    for candidate in universe["candidates"]:
        signals = signal_frame(features, candidate)
        candidate_trades: list[dict[str, Any]] = []
        folds = []
        raw_count = 0
        for fold in sched["folds"]:
            trades, raw = admit(signals, bars, fold, execution)
            raw_count += raw
            candidate_trades.extend(trades)
            fold_metric = metric(trades)
            fold_metric.update(
                {
                    "fold": fold["fold"],
                    "validation_start": iso_ms(fold["validation_start_ms"]),
                    "validation_end_exclusive": iso_ms(fold["validation_end_ms"]),
                    "raw_signals": raw,
                }
            )
            folds.append(fold_metric)
        aggregate = metric(candidate_trades)
        passed, failures = base_gate(aggregate, folds, prereg["promotion_gates"])
        aggregate["raw_signals"] = raw_count
        results[candidate["key"]] = {
            "family": candidate["family"],
            "neighbor_group": candidate["neighbor_group"],
            "aggregate": aggregate,
            "folds": folds,
            "positive_stress_folds": sum(row["stress_total_bps"] > 0 for row in folds),
            "base_gate_pass": passed,
            "base_gate_failures": failures,
        }

    for key, result in results.items():
        neighbors = [
            other for other, other_result in results.items()
            if other != key and other_result["neighbor_group"] == result["neighbor_group"]
        ]
        valid_neighbors = [
            other for other in neighbors
            if results[other]["aggregate"]["stress_total_bps"] > 0
            and results[other]["positive_stress_folds"] >= 2
        ]
        result["neighbor_pass"] = bool(valid_neighbors)
        result["qualifying_neighbors"] = valid_neighbors
        result["independent_promotion_gate_pass"] = result["base_gate_pass"] and bool(valid_neighbors)
        if not valid_neighbors:
            result["base_gate_failures"].append("NEIGHBOR_ROBUSTNESS")

    manifest = [
        {"path": str(path.resolve()), "bytes": path.stat().st_size, "sha256": file_hash(path)}
        for path in sorted(set(used_files))
    ]
    primary_comparison: dict[str, Any] = {"available": False, "path": str(args.primary.resolve())}
    if args.primary.exists():
        primary = read_json(args.primary)
        if primary.get("mode") != "DISCOVERY_TRAIN_VALIDATION_ONLY":
            raise ReplayError("primary comparison artifact is not discovery-only")
        if primary.get("revision") != prereg["revision"]:
            raise ReplayError("primary comparison revision mismatch")
        if primary.get("candidate_universe_sha256") != universe_hash:
            raise ReplayError("primary comparison candidate universe mismatch")
        scope = primary.get("data_scope", {})
        if scope.get("final_test_data_accessed") is not False or primary.get("test_metrics") is not None:
            raise ReplayError("primary comparison artifact touched TEST")
        primary_rows = {row["candidate_key"]: row for row in primary.get("candidate_results", [])}
        comparisons = {}
        for key, independent in results.items():
            row = primary_rows.get(key)
            if row is None:
                comparisons[key] = {"missing_primary": True}
                continue
            pm = row["validation"]
            im = independent["aggregate"]
            fields = {
                "raw_signals": (im["raw_signals"], pm["raw_signals"]),
                "trades": (im["trades"], pm["trades"]),
                "signal_days": (im["signal_days"], pm["signal_days"]),
                "gross_bps": (im.get("gross_total_bps"), pm.get("gross_bps")),
                "base_bps": (im.get("base_total_bps"), pm.get("base_bps")),
                "stress_bps": (im.get("stress_total_bps"), pm.get("stress_bps")),
                "stress_bps_per_trade": (im.get("stress_mean_bps"), pm.get("stress_bps_per_trade")),
                "stress_profit_factor": (im.get("stress_profit_factor"), pm.get("stress_profit_factor")),
                "max_drawdown_stress_bps": (im.get("max_drawdown_bps"), pm.get("max_drawdown_stress_bps")),
                "positive_stress_folds": (independent["positive_stress_folds"], row["positive_validation_folds"]),
                "selection_eligible": (independent["independent_promotion_gate_pass"], row["selection_eligible"]),
            }
            deltas = {}
            for field, (left, right) in fields.items():
                if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
                    deltas[field] = round(float(left) - float(right), 6)
                else:
                    deltas[field] = None if left == right else {"independent": left, "primary": right}
            comparisons[key] = deltas
        primary_comparison = {
            "available": True,
            "path": str(args.primary.resolve()),
            "primary_discovery_sha256": file_hash(args.primary),
            "candidate_differences": comparisons,
            "eligible_set_agreement": sorted(key for key, value in results.items() if value["independent_promotion_gate_pass"])
            == sorted(primary.get("eligible_candidates", [])),
        }
    payload = {
        "schema_version": 1,
        "revision": prereg["revision"],
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "purpose": "Independent discovery-only parity replay; not a candidate lock or TEST result.",
        "implementation": {
            "path": str(Path(__file__).resolve()),
            "sha256": file_hash(Path(__file__)),
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "missing_upbit_policy": "Exact actual completed candles only; no forward-fill and no synthetic zero-volume candles.",
            "same_bar_barrier_order": "STOP_FIRST",
            "signal_tie_break": "family strength descending, then asset ascending",
        },
        "lineage": {
            "preregistration_canonical_sha256": canonical_hash(prereg),
            "preregistration_file_sha256": file_hash(args.preregistration),
            "candidate_universe_file_sha256": file_hash(args.candidates),
            "candidate_universe_payload_sha256": universe_hash,
        },
        "access_guard": {
            "start": iso_ms(sched["start_ms"]),
            "discovery_cutoff_exclusive": iso_ms(sched["cutoff_ms"]),
            "final_test_start": iso_ms(sched["test_start_ms"]),
            "final_test_end_exclusive": iso_ms(sched["test_end_ms"]),
            "final_test_accessed": False,
            "unused_pretest_evaluated": False,
            "fold_count": len(sched["folds"]),
        },
        "execution": execution,
        "input_manifest": {
            "files": manifest,
            "snapshot_sha256": canonical_hash(manifest),
        },
        "candidates": results,
        "independent_survivors": sorted(key for key, value in results.items() if value["independent_promotion_gate_pass"]),
        "primary_parity": primary_comparison,
    }
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "survivors": payload["independent_survivors"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, json.JSONDecodeError, ReplayError, zipfile.BadZipFile) as exc:
        print(f"independent replay failed closed: {exc}", file=sys.stderr)
        raise SystemExit(2)
