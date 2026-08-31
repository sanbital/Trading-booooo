#!/usr/bin/env python3
"""V10 regime-specific exit research.

This runner keeps V10-LANES-3.0.0 entries fixed and compares distinct BULL,
RANGE and BEAR exit state machines on completed 15-minute Binance USD-M bars.
It never treats a regime-label change by itself as an exit.  Intrabar stop/price
trigger collisions are resolved stop-first, and completed-bar invalidations
execute at the next 15-minute open.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import statistics
import sys
import urllib.error
import urllib.request
import zipfile
from array import array
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from itertools import product
from pathlib import Path
from typing import Any, Iterable

UTC = timezone.utc
HERE = Path(__file__).resolve().parent
PROTOCOL_PATH = HERE / "v10-lanes-exit-r1-protocol.json"
RESULT_PATH = HERE / "v10-lanes-exit-r1-result.json"
LOCK_PATH = HERE / "v10-lanes-exit-r1-lock.json"
CONFIG_PATH = HERE.parent.parent / "supabase/functions/_shared/v10_lane_exit_config.ts"
CACHE = Path(os.environ.get("V10_EXIT_CACHE", "v10-exit-cache"))
CACHE.mkdir(parents=True, exist_ok=True)

BAR_MS = 15 * 60 * 1000
LEVERAGE = 3.0
COST_BPS = 21.0
SMA_BARS = 80
ATR_BARS = 56
ATR_BASE_BARS = 2880
QV24_BARS = 96
RET24_BARS = 96
BTC72_BARS = 288
BTC30D_BARS = 2880
REQUIRED_RUN = ATR_BASE_BARS + ATR_BARS
MAX_PATH_BARS = 72 * 4
DATA_START = datetime(2020, 11, 1, tzinfo=UTC)
SIGNAL_START = datetime(2021, 1, 1, tzinfo=UTC)
SIGNAL_END = datetime(2026, 8, 1, tzinfo=UTC)
DATA_END = datetime(2026, 8, 4, tzinfo=UTC)

UNIVERSE = [
    "ETHUSDT", "XRPUSDT", "SOLUSDT", "DOGEUSDT", "ADAUSDT",
    "AVAXUSDT", "LINKUSDT", "BCHUSDT", "DOTUSDT", "TRXUSDT",
    "NEARUSDT", "ETCUSDT", "XLMUSDT", "ATOMUSDT", "UNIUSDT",
]
SYMBOLS = ["BTCUSDT", *UNIVERSE]


def ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def month_keys(start: datetime, end: datetime) -> list[str]:
    cursor = date(start.year, start.month, 1)
    stop = date(end.year, end.month, 1)
    out: list[str] = []
    while cursor < stop:
        out.append(f"{cursor.year:04d}-{cursor.month:02d}")
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)
    return out


def daily_keys(start: datetime, end: datetime) -> list[str]:
    cursor = start.date()
    out: list[str] = []
    while cursor < end.date():
        out.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return out


def archive_target(symbol: str, key: str, daily: bool) -> tuple[str, Path]:
    scope = "daily" if daily else "monthly"
    name = f"{symbol}-15m-{key}.zip"
    url = f"https://data.binance.vision/data/futures/um/{scope}/klines/{symbol}/15m/{name}"
    return url, CACHE / scope / symbol / name


def download_one(item: tuple[str, str, bool]) -> dict[str, Any]:
    symbol, key, daily = item
    url, path = archive_target(symbol, key, daily)
    path.parent.mkdir(parents=True, exist_ok=True)
    missing = path.with_suffix(path.suffix + ".missing")
    if path.exists() and path.stat().st_size > 0:
        return {"symbol": symbol, "key": key, "daily": daily, "path": str(path), "status": "CACHE"}
    if missing.exists():
        return {"symbol": symbol, "key": key, "daily": daily, "path": None, "status": "MISSING_CACHE"}
    request = urllib.request.Request(url, headers={"User-Agent": "Trading-booooo-V10-Exit-R1/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
        path.write_bytes(payload)
        return {"symbol": symbol, "key": key, "daily": daily, "path": str(path), "status": "DOWNLOADED"}
    except urllib.error.HTTPError as error:
        if error.code == 404:
            missing.write_text("404\n")
            return {"symbol": symbol, "key": key, "daily": daily, "path": None, "status": "MISSING_404"}
        raise


def acquire_archives() -> list[dict[str, Any]]:
    monthly = month_keys(DATA_START, datetime(2026, 8, 1, tzinfo=UTC))
    daily = daily_keys(datetime(2026, 8, 1, tzinfo=UTC), DATA_END)
    work = [(symbol, key, False) for symbol in SYMBOLS for key in monthly]
    work += [(symbol, key, True) for symbol in SYMBOLS for key in daily]
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(download_one, item): item for item in work}
        for future in as_completed(futures):
            results.append(future.result())
    return sorted(results, key=lambda row: (row["symbol"], row["daily"], row["key"]))


@dataclass(slots=True)
class Series:
    symbol: str
    ts: array
    o: array
    h: array
    l: array
    c: array
    qv: array
    index: dict[int, int]
    run: array


@dataclass(slots=True)
class Features:
    bb: array
    atr: array
    atr_base: array
    atr_ratio: array
    qv24: array
    r24: array
    r72: array
    r30d: array


def load_series(symbol: str, manifest: list[dict[str, Any]]) -> Series:
    rows: dict[int, tuple[float, float, float, float, float]] = {}
    start_ms, end_ms = ms(DATA_START), ms(DATA_END)
    for item in manifest:
        if item["symbol"] != symbol or not item["path"]:
            continue
        path = Path(item["path"])
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if not names:
                continue
            with archive.open(names[0]) as raw:
                reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8"))
                for row in reader:
                    if len(row) < 8:
                        continue
                    try:
                        timestamp = int(row[0])
                        values = (float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[7]))
                    except (ValueError, TypeError):
                        continue
                    if start_ms <= timestamp < end_ms:
                        rows[timestamp] = values
    ordered = sorted(rows)
    ts = array("q", ordered)
    o, h, l, c, qv = (array("d") for _ in range(5))
    run = array("I")
    previous: int | None = None
    streak = 0
    for timestamp in ordered:
        values = rows[timestamp]
        o.append(values[0]); h.append(values[1]); l.append(values[2]); c.append(values[3]); qv.append(values[4])
        streak = streak + 1 if previous is not None and timestamp - previous == BAR_MS else 1
        run.append(streak)
        previous = timestamp
    return Series(symbol, ts, o, h, l, c, qv, {timestamp: i for i, timestamp in enumerate(ordered)}, run)


def rolling_prefix(values: array) -> tuple[list[float], list[float]]:
    prefix = [0.0] * (len(values) + 1)
    square = [0.0] * (len(values) + 1)
    for i, value in enumerate(values):
        prefix[i + 1] = prefix[i] + value
        square[i + 1] = square[i] + value * value
    return prefix, square


def compute_features(series: Series) -> Features:
    n = len(series.ts)
    nan = float("nan")
    bb = array("d", [nan]) * n
    atr = array("d", [nan]) * n
    atr_base = array("d", [nan]) * n
    atr_ratio = array("d", [nan]) * n
    qv24 = array("d", [nan]) * n
    r24 = array("d", [nan]) * n
    r72 = array("d", [nan]) * n
    r30d = array("d", [nan]) * n

    close_prefix, close_square = rolling_prefix(series.c)
    qv_prefix, _ = rolling_prefix(series.qv)
    true_range = array("d", [nan]) * n
    for i in range(1, n):
        true_range[i] = max(series.h[i] - series.l[i], abs(series.h[i] - series.c[i - 1]), abs(series.l[i] - series.c[i - 1]))

    tr_sum = 0.0
    tr_count = 0
    for i in range(n):
        incoming = true_range[i]
        if math.isfinite(incoming):
            tr_sum += incoming; tr_count += 1
        outgoing = i - ATR_BARS
        if outgoing >= 0 and math.isfinite(true_range[outgoing]):
            tr_sum -= true_range[outgoing]; tr_count -= 1
        if tr_count == ATR_BARS:
            atr[i] = tr_sum / ATR_BARS

        if i >= SMA_BARS - 1:
            left = i - SMA_BARS + 1
            total = close_prefix[i + 1] - close_prefix[left]
            total_sq = close_square[i + 1] - close_square[left]
            mean = total / SMA_BARS
            variance = max(0.0, (total_sq - total * total / SMA_BARS) / (SMA_BARS - 1))
            std = math.sqrt(variance)
            if std > 0:
                bb[i] = (series.c[i] - mean) / (2 * std)
        if i >= QV24_BARS - 1:
            qv24[i] = qv_prefix[i + 1] - qv_prefix[i + 1 - QV24_BARS]
        if i >= RET24_BARS and series.c[i - RET24_BARS] > 0:
            r24[i] = series.c[i] / series.c[i - RET24_BARS] - 1
        if i >= BTC72_BARS and series.c[i - BTC72_BARS] > 0:
            r72[i] = series.c[i] / series.c[i - BTC72_BARS] - 1
        if i >= BTC30D_BARS and series.c[i - BTC30D_BARS] > 0:
            r30d[i] = series.c[i] / series.c[i - BTC30D_BARS] - 1

    atr_prefix = [0.0] * (n + 1)
    atr_count = [0] * (n + 1)
    for i, value in enumerate(atr):
        atr_prefix[i + 1] = atr_prefix[i]
        atr_count[i + 1] = atr_count[i]
        if math.isfinite(value):
            atr_prefix[i + 1] += value
            atr_count[i + 1] += 1
    for i in range(ATR_BASE_BARS, n):
        left = i - ATR_BASE_BARS
        count = atr_count[i] - atr_count[left]
        if count == ATR_BASE_BARS:
            baseline = (atr_prefix[i] - atr_prefix[left]) / ATR_BASE_BARS
            if baseline > 0 and math.isfinite(atr[i]):
                atr_base[i] = baseline
                atr_ratio[i] = atr[i] / baseline
    return Features(bb, atr, atr_base, atr_ratio, qv24, r24, r72, r30d)


@dataclass(frozen=True, slots=True)
class Event:
    event_id: str
    lane: str
    symbol: str
    signal_at: int
    entry_at: int
    entry_index: int
    entry_price: float
    entry_atr: float
    entry_btc72: float


@dataclass(frozen=True, slots=True)
class Policy:
    key: str
    lane: str
    family: str
    stop_roe: float | None
    t1_roe: float | None = None
    t1_fraction: float | None = None
    residual_floor_roe: float | None = None
    residual_giveback_roe: float | None = None
    target: str | None = None
    invalidation: str = "NONE"
    max_hold_h: int = 0

    def parameters(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Outcome:
    event_id: str
    lane: str
    policy_key: str
    symbol: str
    entry_at: int
    exit_at: int
    net_bps: float
    hold_minutes: int
    exit_reason: str
    split: bool
    mfe_roe: float
    mae_roe: float


def route(btc72: float) -> str:
    if not math.isfinite(btc72): return "CASH"
    if btc72 < -0.05: return "BEAR"
    if btc72 <= 0.04: return "RANGE"
    if btc72 > 0.05: return "BULL"
    return "CASH"


def generate_events(series_by_symbol: dict[str, Series], feature_by_symbol: dict[str, Features]) -> list[Event]:
    btc = series_by_symbol["BTCUSDT"]
    bf = feature_by_symbol["BTCUSDT"]
    start_ms, end_ms = ms(SIGNAL_START), ms(SIGNAL_END)
    events: list[Event] = []
    for symbol in UNIVERSE:
        series = series_by_symbol[symbol]
        features = feature_by_symbol[symbol]
        last_signal: dict[str, int] = {"BULL": -10**18, "RANGE": -10**18, "BEAR": -10**18}
        for i in range(REQUIRED_RUN - 1, len(series.ts) - MAX_PATH_BARS - 2):
            timestamp = series.ts[i]
            if timestamp < start_ms or timestamp >= end_ms:
                continue
            if series.run[i] < REQUIRED_RUN:
                continue
            btc_i = btc.index.get(timestamp)
            if btc_i is None or btc.run[btc_i] < BTC30D_BARS + 1:
                continue
            btc72 = bf.r72[btc_i]
            btc30d = bf.r30d[btc_i]
            lane = route(btc72)
            if lane == "CASH":
                continue
            atr_ratio = features.atr_ratio[i]
            bb = features.bb[i]
            r24 = features.r24[i]
            qv24 = features.qv24[i]
            if not all(math.isfinite(value) for value in (atr_ratio, bb, r24, qv24, features.atr[i], btc30d)):
                continue
            eligible = False
            cooldown_h = 0
            if lane == "BULL":
                eligible = atr_ratio >= 1.65 and bb <= -0.20 and r24 >= -0.02 and qv24 >= 50_000_000
                cooldown_h = 12
            elif lane == "RANGE":
                eligible = atr_ratio >= 1.65 and bb <= -1.05 and qv24 >= 50_000_000
                cooldown_h = 6
            else:
                bb1 = features.bb[i - 4] if i >= 4 else float("nan")
                eligible = (-0.20 <= btc30d <= -0.10 and atr_ratio >= 1.60 and bb <= -0.90 and
                            math.isfinite(bb1) and bb1 > -0.90 and qv24 >= 50_000_000)
                cooldown_h = 24
            if not eligible or timestamp - last_signal[lane] < cooldown_h * 60 * 60 * 1000:
                continue
            entry_i = i + 1
            if series.ts[entry_i] - timestamp != BAR_MS or series.run[entry_i + MAX_PATH_BARS] < MAX_PATH_BARS + 1:
                continue
            entry_price = series.o[entry_i]
            if not (entry_price > 0):
                continue
            event_id = hashlib.sha256(f"{lane}|{symbol}|{timestamp}".encode()).hexdigest()[:24]
            events.append(Event(event_id, lane, symbol, timestamp, series.ts[entry_i], entry_i,
                                entry_price, features.atr[i], btc72))
            last_signal[lane] = timestamp
    return sorted(events, key=lambda event: (event.signal_at, event.symbol, event.lane))


def policies() -> dict[str, list[Policy]]:
    out: dict[str, list[Policy]] = {"BULL": [], "RANGE": [], "BEAR": []}
    out["BULL"].append(Policy("BULL_BASE_TIME_12H", "BULL", "BASE_TIME", None, max_hold_h=12))
    serial = 0
    for values in product((-9.0, -12.0, -15.0), (12.0, 15.0, 18.0), (6.0, 9.0), (4.5, 6.0),
                          ("NONE", "FOUR_BAR_NON_BULL_AND_LOWER_BAND_LOSS"), (24, 36)):
        serial += 1
        out["BULL"].append(Policy(f"BULL_TREND_SCALE_{serial:03d}", "BULL", "TREND_SCALE",
                                  values[0], values[1], 0.5, values[2], values[3], None, values[4], values[5]))
    for stop, target, invalid, maxh in product((-9.0, -12.0, -15.0), (12.0, 15.0, 18.0),
                                               ("NONE", "FOUR_BAR_NON_BULL_AND_LOWER_BAND_LOSS"), (24, 36)):
        serial += 1
        out["BULL"].append(Policy(f"BULL_FULL_IMPULSE_{serial:03d}", "BULL", "FULL_IMPULSE",
                                  stop, target, 1.0, None, None, None, invalid, maxh))

    out["RANGE"].append(Policy("RANGE_BASE_TIME_6H", "RANGE", "BASE_TIME", None, max_hold_h=6))
    serial = 0
    for stop, target, invalid, maxh in product((-9.0, -12.0, -15.0),
                                               ("FULL_BB_NEG_025", "FULL_BB_ZERO", "SPLIT_BB_NEG_050_TO_ZERO"),
                                               ("NONE", "FOUR_BAR_BEAR_BREAK_AND_DEEPER_BAND"), (12, 18)):
        serial += 1
        out["RANGE"].append(Policy(f"RANGE_MEAN_EXIT_{serial:03d}", "RANGE", "MEAN_EXIT",
                                   stop, None, 0.5 if target.startswith("SPLIT") else 1.0,
                                   None, None, target, invalid, maxh))

    out["BEAR"].append(Policy("BEAR_BASE_TIME_24H", "BEAR", "BASE_TIME", None, max_hold_h=24))
    serial = 0
    for stop, target, invalid, maxh in product((-9.0, -12.0, -15.0, -18.0),
                                               ("FULL_ROE_15", "FULL_ROE_21", "FULL_BB_NEG_025",
                                                "SPLIT_ROE_15_TRAIL", "SPLIT_BB_NEG_050_TO_ZERO"),
                                               ("FOUR_BAR_FAILED_RECOVERY_NEW_LOW", "EIGHT_BAR_FAILED_RECOVERY_NEW_LOW"),
                                               (36, 48, 72)):
        serial += 1
        t1 = 15.0 if target in ("FULL_ROE_15", "SPLIT_ROE_15_TRAIL") else 21.0 if target == "FULL_ROE_21" else None
        fraction = 0.5 if target.startswith("SPLIT") else 1.0
        floor = 9.0 if target == "SPLIT_ROE_15_TRAIL" else None
        giveback = 6.0 if target == "SPLIT_ROE_15_TRAIL" else None
        out["BEAR"].append(Policy(f"BEAR_RECOVERY_EXIT_{serial:03d}", "BEAR", "RECOVERY_EXIT",
                                  stop, t1, fraction, floor, giveback, target, invalid, maxh))
    return out


def price_for_roe(entry: float, roe_pct: float) -> float:
    return entry * (1.0 + roe_pct / (100.0 * LEVERAGE))


def simulate(event: Event, policy: Policy, series: Series, features: Features,
             btc: Series, btc_features: Features) -> Outcome | None:
    entry = event.entry_price
    remaining = 1.0
    realized = 0.0
    t1_done = False
    pending_fraction = 0.0
    pending_reason = ""
    peak = entry
    min_price = entry
    invalid_count = 0
    split = False
    mfe_roe = 0.0
    mae_roe = 0.0
    max_bars = policy.max_hold_h * 4
    stop_price = price_for_roe(entry, policy.stop_roe) if policy.stop_roe is not None else 0.0
    last_reason = "MAX_HOLD_BACKSTOP"
    exit_at = 0

    def exit_fraction(fraction: float, price: float, reason: str, timestamp: int) -> None:
        nonlocal remaining, realized, last_reason, exit_at, split
        fraction = min(remaining, max(0.0, fraction))
        if fraction <= 0:
            return
        realized += fraction * (price / entry - 1.0) * 10_000.0
        remaining -= fraction
        split = split or remaining > 1e-12
        last_reason = reason
        exit_at = timestamp

    for step in range(max_bars):
        j = event.entry_index + step
        if j >= len(series.ts):
            return None
        timestamp = series.ts[j]
        if step > 0 and series.ts[j] - series.ts[j - 1] != BAR_MS:
            return None
        bar_open, bar_high, bar_low, bar_close = series.o[j], series.h[j], series.l[j], series.c[j]
        if pending_fraction > 0:
            exit_fraction(pending_fraction, bar_open, pending_reason, timestamp)
            pending_fraction = 0.0
            pending_reason = ""
            if remaining <= 1e-12:
                break
            t1_done = True

        current_stop = stop_price
        if t1_done and policy.residual_floor_roe is not None and policy.residual_giveback_roe is not None:
            floor_price = price_for_roe(entry, policy.residual_floor_roe)
            trail_price = peak * (1.0 - policy.residual_giveback_roe / (100.0 * LEVERAGE))
            current_stop = max(current_stop, floor_price, trail_price)
        if current_stop > 0 and bar_low <= current_stop:
            exit_fraction(remaining, current_stop, "HARD_STOP" if not t1_done else "RESIDUAL_PROTECTED_TRAIL", timestamp)
            break

        if not t1_done and policy.t1_roe is not None:
            target_price = price_for_roe(entry, policy.t1_roe)
            if bar_high >= target_price:
                fraction = policy.t1_fraction or 1.0
                exit_fraction(fraction, target_price, "FULL_PRICE_TARGET" if fraction >= 0.999 else "FIRST_TAKE_PROFIT", timestamp)
                if remaining <= 1e-12:
                    break
                t1_done = True

        peak = max(peak, bar_high)
        min_price = min(min_price, bar_low)
        mfe_roe = max(mfe_roe, (peak / entry - 1.0) * 100.0 * LEVERAGE)
        mae_roe = min(mae_roe, (min_price / entry - 1.0) * 100.0 * LEVERAGE)

        bb = features.bb[j]
        close_roe = (bar_close / entry - 1.0) * 100.0 * LEVERAGE
        btc_i = btc.index.get(timestamp)
        btc72 = btc_features.r72[btc_i] if btc_i is not None else float("nan")
        current_route = route(btc72)

        if policy.lane == "RANGE" and math.isfinite(bb):
            if policy.target == "FULL_BB_NEG_025" and bb >= -0.25:
                pending_fraction, pending_reason = remaining, "MEAN_REVERSION_BB_NEG_025"
            elif policy.target == "FULL_BB_ZERO" and bb >= 0.0:
                pending_fraction, pending_reason = remaining, "MEAN_REVERSION_BB_ZERO"
            elif policy.target == "SPLIT_BB_NEG_050_TO_ZERO":
                if not t1_done and bb >= -0.50:
                    pending_fraction, pending_reason = min(0.5, remaining), "MEAN_REVERSION_FIRST_TRANCHE"
                elif t1_done and bb >= 0.0:
                    pending_fraction, pending_reason = remaining, "MEAN_REVERSION_RESIDUAL_CENTER"
        elif policy.lane == "BEAR" and math.isfinite(bb):
            if policy.target == "FULL_BB_NEG_025" and bb >= -0.25:
                pending_fraction, pending_reason = remaining, "CAPITULATION_REBOUND_BB_NEG_025"
            elif policy.target == "SPLIT_BB_NEG_050_TO_ZERO":
                if not t1_done and bb >= -0.50:
                    pending_fraction, pending_reason = min(0.5, remaining), "CAPITULATION_FIRST_TRANCHE"
                elif t1_done and bb >= 0.0:
                    pending_fraction, pending_reason = remaining, "CAPITULATION_RESIDUAL_CENTER"

        invalid = False
        required = 0
        if policy.invalidation == "FOUR_BAR_NON_BULL_AND_LOWER_BAND_LOSS":
            invalid = current_route != "BULL" and math.isfinite(bb) and bb <= -1.0 and close_roe < 0
            required = 4
        elif policy.invalidation == "FOUR_BAR_BEAR_BREAK_AND_DEEPER_BAND":
            invalid = current_route == "BEAR" and math.isfinite(bb) and bb <= -1.50 and close_roe < 0
            required = 4
        elif policy.invalidation in ("FOUR_BAR_FAILED_RECOVERY_NEW_LOW", "EIGHT_BAR_FAILED_RECOVERY_NEW_LOW"):
            invalid = (step >= 4 and math.isfinite(bb) and bb <= -0.90 and close_roe < 0 and
                       math.isfinite(btc72) and btc72 <= event.entry_btc72 - 0.01 and
                       bar_close < min(series.l[max(event.entry_index, j - 16):j], default=entry))
            required = 4 if policy.invalidation.startswith("FOUR") else 8
        invalid_count = invalid_count + 1 if invalid else 0
        if required and invalid_count >= required and pending_fraction <= 0:
            pending_fraction, pending_reason = remaining, "LANE_SPECIFIC_INVALIDATION"

        if step == max_bars - 1 and remaining > 1e-12:
            exit_fraction(remaining, bar_close, "MAX_HOLD_BACKSTOP", timestamp)
            break

    if remaining > 1e-9 or exit_at <= 0:
        return None
    net = realized - COST_BPS
    hold_minutes = max(0, int((exit_at - event.entry_at) / 60_000))
    return Outcome(event.event_id, event.lane, policy.key, event.symbol, event.entry_at, exit_at,
                   net, hold_minutes, last_reason, split, mfe_roe, mae_roe)


def apply_capacity(outcomes: Iterable[Outcome], capacity: int, excluded_symbol: str | None = None) -> list[Outcome]:
    active: list[tuple[int, str]] = []
    admitted: list[Outcome] = []
    for outcome in sorted(outcomes, key=lambda row: (row.entry_at, row.symbol, row.event_id)):
        if excluded_symbol and outcome.symbol == excluded_symbol:
            continue
        active = [(exit_at, symbol) for exit_at, symbol in active if exit_at > outcome.entry_at]
        occupied = {symbol for _, symbol in active}
        if len(active) >= capacity or outcome.symbol in occupied:
            continue
        admitted.append(outcome)
        active.append((outcome.exit_at, outcome.symbol))
    return admitted


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    lower = int(math.floor(position)); upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def basic_metrics(outcomes: list[Outcome]) -> dict[str, Any]:
    if not outcomes:
        return {"trades": 0, "net_bps": 0.0, "mean_net_bps": 0.0, "pf": 0.0,
                "max_drawdown_bps": 0.0, "distinct_symbols": 0}
    pnl = [row.net_bps for row in outcomes]
    positive = sum(max(0.0, value) for value in pnl)
    negative = -sum(min(0.0, value) for value in pnl)
    equity = 0.0; peak = 0.0; max_dd = 0.0
    for row in sorted(outcomes, key=lambda item: (item.entry_at, item.symbol)):
        equity += row.net_bps
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    symbols: dict[str, int] = {}
    months: dict[str, float] = {}
    reasons: dict[str, int] = {}
    for row in outcomes:
        symbols[row.symbol] = symbols.get(row.symbol, 0) + 1
        key = datetime.fromtimestamp(row.entry_at / 1000, UTC).strftime("%Y-%m")
        months[key] = months.get(key, 0.0) + row.net_bps
        reasons[row.exit_reason] = reasons.get(row.exit_reason, 0) + 1
    positive_month_total = sum(max(0.0, value) for value in months.values())
    top_month_share = max((max(0.0, value) / positive_month_total for value in months.values()), default=0.0) if positive_month_total > 0 else 0.0
    capture = [row.net_bps / (row.mfe_roe / LEVERAGE * 100.0) for row in outcomes if row.mfe_roe > 0]
    return {
        "trades": len(outcomes),
        "wins": sum(value > 0 for value in pnl),
        "net_bps": round(sum(pnl), 3),
        "mean_net_bps": round(statistics.fmean(pnl), 3),
        "pf": round(positive / negative, 4) if negative > 0 else 99.0,
        "win_rate": round(sum(value > 0 for value in pnl) / len(pnl), 4),
        "max_drawdown_bps": round(max_dd, 3),
        "p05_net_bps": round(percentile(pnl, 0.05), 3),
        "worst_net_bps": round(min(pnl), 3),
        "mean_hold_minutes": round(statistics.fmean(row.hold_minutes for row in outcomes), 2),
        "distinct_symbols": len(symbols),
        "max_symbol_trade_share": round(max(symbols.values()) / len(outcomes), 4),
        "max_positive_month_share": round(top_month_share, 4),
        "split_share": round(sum(row.split for row in outcomes) / len(outcomes), 4),
        "mean_mfe_roe": round(statistics.fmean(row.mfe_roe for row in outcomes), 3),
        "mean_mae_roe": round(statistics.fmean(row.mae_roe for row in outcomes), 3),
        "median_mfe_capture": round(statistics.median(capture), 4) if capture else 0.0,
        "exit_reasons": dict(sorted(reasons.items())),
    }


def between(outcomes: list[Outcome], start: datetime, end: datetime) -> list[Outcome]:
    left, right = ms(start), ms(end)
    return [row for row in outcomes if left <= row.entry_at < right]


def policy_report(raw: list[Outcome], lane: str, baseline_dd: float) -> dict[str, Any]:
    cap2 = apply_capacity(raw, 2)
    cap1 = apply_capacity(raw, 1)
    cap3 = apply_capacity(raw, 3)
    blocks = {
        "discovery_2021_2023": (datetime(2021,1,1,tzinfo=UTC), datetime(2024,1,1,tzinfo=UTC)),
        "selection_2024": (datetime(2024,1,1,tzinfo=UTC), datetime(2025,1,1,tzinfo=UTC)),
        "confirmation_2025": (datetime(2025,1,1,tzinfo=UTC), datetime(2026,1,1,tzinfo=UTC)),
        "final_2026_partial": (datetime(2026,1,1,tzinfo=UTC), datetime(2026,8,1,tzinfo=UTC)),
    }
    block_metrics = {key: basic_metrics(between(cap2, *window)) for key, window in blocks.items()}
    yearly = {str(year): basic_metrics(between(cap2, datetime(year,1,1,tzinfo=UTC), datetime(year+1,1,1,tzinfo=UTC))) for year in range(2021, 2026)}
    yearly["2026_partial"] = block_metrics["final_2026_partial"]
    overall = basic_metrics(cap2)
    loo_rows = []
    for symbol in UNIVERSE:
        row = basic_metrics(apply_capacity(raw, 2, symbol))
        if row["trades"] > 0:
            loo_rows.append(row)
    loo = {
        "positive_fraction": round(sum(row["mean_net_bps"] > 0 for row in loo_rows) / len(loo_rows), 4) if loo_rows else 0.0,
        "median_mean_net_bps": round(statistics.median(row["mean_net_bps"] for row in loo_rows), 3) if loo_rows else 0.0,
        "worst_mean_net_bps": round(min((row["mean_net_bps"] for row in loo_rows), default=0.0), 3),
    }
    robustness = {}
    for capacity, rows in ((1, cap1), (3, cap3)):
        robustness[str(capacity)] = {
            "confirmation_2025": basic_metrics(between(rows, *blocks["confirmation_2025"])),
            "final_2026_partial": basic_metrics(between(rows, *blocks["final_2026_partial"])),
        }
    min_full = {"BULL": 20, "RANGE": 30, "BEAR": 10}[lane]
    min_partial = {"BULL": 10, "RANGE": 15, "BEAR": 8}[lane]
    gates = {
        "discovery_positive": block_metrics["discovery_2021_2023"]["mean_net_bps"] > 0,
        "selection_positive_pf": block_metrics["selection_2024"]["mean_net_bps"] > 0 and block_metrics["selection_2024"]["pf"] >= 1.10,
        "confirmation_positive_pf": block_metrics["confirmation_2025"]["mean_net_bps"] > 0 and block_metrics["confirmation_2025"]["pf"] >= 1.10,
        "final_positive_pf": block_metrics["final_2026_partial"]["mean_net_bps"] > 0 and block_metrics["final_2026_partial"]["pf"] >= 1.05,
        "full_pf_1_15": overall["pf"] >= 1.15,
        "annual_samples": all(yearly[str(year)]["trades"] >= min_full for year in range(2021, 2026)),
        "partial_sample": yearly["2026_partial"]["trades"] >= min_partial,
        "annual_positive": all(yearly[str(year)]["mean_net_bps"] > 0 for year in range(2021, 2026)) and yearly["2026_partial"]["mean_net_bps"] > 0,
        "symbol_concentration": overall["max_symbol_trade_share"] <= 0.25,
        "distinct_symbols": overall["distinct_symbols"] >= 8,
        "month_concentration": overall["max_positive_month_share"] <= 0.35,
        "loo_positive": loo["positive_fraction"] >= 0.90,
        "loo_median": loo["median_mean_net_bps"] >= 5,
        "drawdown_vs_baseline": abs(overall["max_drawdown_bps"]) <= max(1.0, abs(baseline_dd) * 1.05),
        "capacity_robustness": all(
            robustness[str(cap)][block]["mean_net_bps"] > 0
            for cap in (1,3) for block in ("confirmation_2025","final_2026_partial")
        ),
    }
    return {"overall": overall, "blocks": block_metrics, "yearly": yearly, "loo": loo,
            "capacity_robustness": robustness, "gates": gates, "base_pass": all(gates.values())}


def distance_one(left: Policy, right: Policy) -> bool:
    if left.lane != right.lane or left.family != right.family or left.family == "BASE_TIME":
        return False
    ignored = {"key", "lane", "family"}
    a = {k: v for k, v in left.parameters().items() if k not in ignored}
    b = {k: v for k, v in right.parameters().items() if k not in ignored}
    return sum(a[key] != b[key] for key in a) == 1


def generate_typescript(selected: dict[str, dict[str, Any]], spec_sha: str) -> str:
    payload = {lane: row["policy"] for lane, row in selected.items()}
    body = json.dumps(payload, sort_keys=True, indent=2)
    return (
        'export const V10_LANE_EXIT_REVISION = "V10-LANES-EXIT-R1.0.0" as const;\n'
        f'export const V10_LANE_EXIT_SPEC_SHA256 = "{spec_sha}" as const;\n'
        'export const V10_LANE_EXIT_POLICY = ' + body + ' as const;\n'
        'export type V10LaneExitPolicy = typeof V10_LANE_EXIT_POLICY;\n'
    )


def main() -> None:
    protocol = json.loads(PROTOCOL_PATH.read_text())
    manifest_rows = acquire_archives()
    source_manifest = []
    for row in manifest_rows:
        if row["path"]:
            path = Path(row["path"])
            source_manifest.append({"symbol": row["symbol"], "key": row["key"], "daily": row["daily"],
                                    "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    series_by_symbol = {symbol: load_series(symbol, manifest_rows) for symbol in SYMBOLS}
    if len(series_by_symbol["BTCUSDT"].ts) == 0:
        raise RuntimeError("BTC_DATA_EMPTY")
    feature_by_symbol = {symbol: compute_features(series) for symbol, series in series_by_symbol.items()}
    events = generate_events(series_by_symbol, feature_by_symbol)
    event_counts = {lane: sum(event.lane == lane for event in events) for lane in ("BULL","RANGE","BEAR")}
    if any(event_counts[lane] == 0 for lane in event_counts):
        raise RuntimeError(f"ENTRY_EVENTS_MISSING:{event_counts}")

    candidate_map = policies()
    reports: dict[str, dict[str, Any]] = {}
    selected: dict[str, dict[str, Any]] = {}
    btc = series_by_symbol["BTCUSDT"]
    btc_features = feature_by_symbol["BTCUSDT"]

    for lane in ("BULL", "RANGE", "BEAR"):
        lane_events = [event for event in events if event.lane == lane]
        raw_by_key: dict[str, list[Outcome]] = {}
        for policy in candidate_map[lane]:
            raw: list[Outcome] = []
            for event in lane_events:
                outcome = simulate(event, policy, series_by_symbol[event.symbol], feature_by_symbol[event.symbol], btc, btc_features)
                if outcome is not None:
                    raw.append(outcome)
            raw_by_key[policy.key] = raw
        baseline = candidate_map[lane][0]
        baseline_report = policy_report(raw_by_key[baseline.key], lane, -1.0)
        baseline_dd = baseline_report["overall"]["max_drawdown_bps"]
        lane_reports: dict[str, Any] = {}
        for policy in candidate_map[lane]:
            report = policy_report(raw_by_key[policy.key], lane, baseline_dd if policy.family != "BASE_TIME" else baseline_dd)
            report["policy"] = policy.parameters()
            lane_reports[policy.key] = report
        for policy in candidate_map[lane]:
            report = lane_reports[policy.key]
            neighbors = [other for other in candidate_map[lane] if distance_one(policy, other)]
            pass_share = sum(lane_reports[other.key]["base_pass"] for other in neighbors) / len(neighbors) if neighbors else 0.0
            plateau = {"neighbor_count": len(neighbors), "passing_neighbors": sum(lane_reports[other.key]["base_pass"] for other in neighbors),
                       "pass_share": round(pass_share, 4), "passed": len(neighbors) >= 4 and pass_share >= 0.75}
            report["plateau"] = plateau
            report["eligible"] = policy.family != "BASE_TIME" and report["base_pass"] and plateau["passed"]
        reports[lane] = {"baseline": lane_reports[baseline.key], "candidates": lane_reports}
        eligible = [row for row in lane_reports.values() if row["eligible"]]
        if eligible:
            def score(row: dict[str, Any]) -> tuple[float, float, float, str]:
                block_means = [metric["mean_net_bps"] for metric in row["blocks"].values()]
                block_pfs = [metric["pf"] for metric in row["blocks"].values()]
                return (min(block_means), -abs(row["overall"]["max_drawdown_bps"]), min(block_pfs), row["policy"]["key"])
            eligible.sort(key=score, reverse=True)
            selected[lane] = eligible[0]

    all_passed = set(selected) == {"BULL", "RANGE", "BEAR"}
    selected_compact = {
        lane: {
            "policy": row["policy"], "overall": row["overall"], "blocks": row["blocks"],
            "yearly": row["yearly"], "loo": row["loo"], "plateau": row["plateau"],
            "capacity_robustness": row["capacity_robustness"],
        }
        for lane, row in selected.items()
    }
    result = {
        "schema_version": 1,
        "revision": "V10-LANES-EXIT-R1-RESULT-20260831",
        "protocol_sha256": hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_manifest_sha256": hashlib.sha256(canonical(source_manifest)).hexdigest(),
        "source_file_count": len(source_manifest),
        "entry_event_counts": event_counts,
        "candidate_counts": {lane: len(rows) for lane, rows in candidate_map.items()},
        "all_lanes_passed": all_passed,
        "selected": selected_compact,
        "reports": reports,
    }
    RESULT_PATH.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
    if all_passed:
        fingerprint_payload = {"protocol": protocol, "selected": selected_compact, "runner_sha256": result["runner_sha256"]}
        spec_sha = hashlib.sha256(canonical(fingerprint_payload)).hexdigest()
        lock = {
            "schema_version": 1,
            "revision": "V10-LANES-EXIT-R1-FINAL-LOCK-20260831",
            "entry_engine_revision": "V10-LANES-3.0.0",
            "exit_engine_revision": "V10-LANES-EXIT-R1.0.0",
            "spec_sha256": spec_sha,
            "protocol_sha256": result["protocol_sha256"],
            "runner_sha256": result["runner_sha256"],
            "source_manifest_sha256": result["source_manifest_sha256"],
            "selected": selected_compact,
            "production_sizing_not_part_of_exit_selection": {"margin_usdt": 40, "leverage": 3, "notional_usdt": 120},
            "release_status": "RESEARCH_SELECTED_PENDING_TYPESCRIPT_GOLDEN_PARITY_AND_PRODUCTION_INTEGRATION",
        }
        LOCK_PATH.write_text(json.dumps(lock, sort_keys=True, indent=2) + "\n")
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(generate_typescript(selected, spec_sha))
    print(json.dumps({"all_lanes_passed": all_passed, "selected": {lane: row["policy"]["key"] for lane, row in selected.items()},
                      "entry_event_counts": event_counts}, sort_keys=True))


if __name__ == "__main__":
    main()
