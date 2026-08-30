#!/usr/bin/env python3
"""V10 independent RANGE/BEAR research runner.

The runner is deliberately self-contained (Python standard library only) and
fail-closed around the final test.  ``discovery`` can only request the
pre-registered TRAIN/VALIDATION data range.  ``test`` requires an immutable
candidate lock and atomically consumes a one-shot access ledger *before* it
requests any final-test bytes.

Research only: this module has no database, exchange-order, or production
router integration.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


UTC = timezone.utc
BAR_MINUTES = 15
BAR_MS = BAR_MINUTES * 60 * 1_000
DAY_MS = 24 * 60 * 60 * 1_000
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_PREREGISTRATION = SCRIPT_DIR / "preregistration.json"
DEFAULT_CANDIDATES = SCRIPT_DIR / "candidate-universe.json"
DEFAULT_CACHE = SCRIPT_DIR.parents[2] / "v10-cache"
BINANCE_ARCHIVE_ROOT = "https://data.binance.vision/data/futures/um/monthly/klines"
UPBIT_CANDLES_URL = "https://api.upbit.com/v1/candles/minutes/15"
USER_AGENT = "Trading-booooo-V10-research/1.0"


class ResearchError(RuntimeError):
    """An invariant failure that must stop research rather than guess."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json_bytes(value))


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ResearchError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ResearchError(f"JSON root must be an object: {path}")
    return value


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def epoch_ms(value: datetime) -> int:
    return int(value.timestamp() * 1_000)


def iso_utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1_000, UTC).isoformat().replace("+00:00", "Z")


def normalize_epoch_ms(value: Any) -> int:
    number = int(value)
    # Binance Spot migrated archive timestamps to microseconds in 2025.  This
    # runner uses USD-M, but accepting either unit prevents a silent year-58200
    # timestamp if the archive format changes.
    return number // 1_000 if number > 100_000_000_000_000 else number


def finite(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def quantile(values: Sequence[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def rounded(value: float | None, digits: int = 6) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, digits)


def write_json(path: Path, payload: Mapping[str, Any], *, exclusive: bool) -> None:
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise ResearchError(f"refusing to overwrite immutable artifact: {path}") from exc
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        return
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@dataclass(frozen=True, slots=True)
class Fold:
    number: int
    train_start_ms: int
    train_end_ms: int
    validation_start_ms: int
    validation_end_ms: int
    embargo_bars: int

    def json(self) -> dict[str, Any]:
        return {
            "fold": self.number,
            "train_start": iso_utc(self.train_start_ms),
            "train_end_exclusive": iso_utc(self.train_end_ms),
            "validation_start": iso_utc(self.validation_start_ms),
            "validation_end_exclusive": iso_utc(self.validation_end_ms),
            "embargo_bars": self.embargo_bars,
        }


@dataclass(frozen=True, slots=True)
class Schedule:
    data_start_ms: int
    selection_end_ms: int
    test_start_ms: int
    test_end_ms: int
    folds: tuple[Fold, ...]

    def json(self) -> dict[str, Any]:
        return {
            "data_start": iso_utc(self.data_start_ms),
            "candidate_selection_end_exclusive": iso_utc(self.selection_end_ms),
            "final_test_start": iso_utc(self.test_start_ms),
            "final_test_end_exclusive": iso_utc(self.test_end_ms),
            "folds": [fold.json() for fold in self.folds],
        }


def validate_preregistration(prereg: Mapping[str, Any]) -> Schedule:
    data = prereg.get("data")
    split = prereg.get("split_protocol")
    if not isinstance(data, Mapping) or not isinstance(split, Mapping):
        raise ResearchError("preregistration is missing data or split_protocol")
    if data.get("interval") != "15m":
        raise ResearchError("V10 runner is locked to completed 15m candles")
    start = parse_utc(str(data["start_inclusive"]))
    end = parse_utc(str(data["end_exclusive"]))
    if start != datetime(2025, 1, 1, tzinfo=UTC) or end != datetime(2026, 1, 1, tzinfo=UTC):
        raise ResearchError("V10 data cut must remain exactly calendar year 2025")
    if prereg.get("v9_test_reuse_for_selection") is not False:
        raise ResearchError("V9 TEST reuse must be explicitly false")
    execution = prereg.get("execution")
    if not isinstance(execution, Mapping):
        raise ResearchError("preregistration is missing execution")
    locked_execution = {
        "base_round_trip_cost_bps": 14,
        "stress_round_trip_cost_bps": 23,
        "max_holding_bars": 16,
        "portfolio_max_concurrent_positions": 3,
        "duplicate_asset_positions": False,
    }
    for key, expected in locked_execution.items():
        if execution.get(key) != expected:
            raise ResearchError(f"preregistered execution invariant changed: {key}")

    fold_count = int(split["folds"])
    train_days = int(split["train_days"])
    validation_days = int(split["validation_days"])
    step_days = int(split["fold_step_days"])
    embargo_bars = int(split["embargo_bars"])
    selection_day = int(split["candidate_selection_end_day"])
    unused_days = int(split["unused_pretest_days"])
    test_days = int(split["final_test_days"])
    if fold_count != 4 or embargo_bars <= 0:
        raise ResearchError("V10 requires exactly four folds and a positive embargo")

    start_ms = epoch_ms(start)
    end_ms = epoch_ms(end)
    selection_end_ms = start_ms + selection_day * DAY_MS
    test_start_ms = selection_end_ms + unused_days * DAY_MS
    expected_end_ms = test_start_ms + test_days * DAY_MS
    if expected_end_ms != end_ms:
        raise ResearchError("split days do not exactly cover the pre-registered 2025 data cut")

    folds: list[Fold] = []
    for offset in range(fold_count):
        fold_start = start_ms + offset * step_days * DAY_MS
        train_end = fold_start + train_days * DAY_MS
        # The embargo occupies the first 16 bars of the registered 40-day
        # validation block; it is excluded from both TRAIN and VALIDATION.
        validation_start = train_end + embargo_bars * BAR_MS
        validation_end = fold_start + (train_days + validation_days) * DAY_MS
        if validation_start >= validation_end:
            raise ResearchError("embargo consumes a validation fold")
        folds.append(Fold(offset + 1, fold_start, train_end, validation_start, validation_end, embargo_bars))
    if folds[-1].validation_end_ms != selection_end_ms:
        raise ResearchError("last validation fold must end at candidate_selection_end_day")
    return Schedule(start_ms, selection_end_ms, test_start_ms, end_ms, tuple(folds))


def candidate_payload(universe: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in universe.items() if key != "lock"}


def validate_candidate_universe(
    prereg: Mapping[str, Any], universe: Mapping[str, Any]
) -> tuple[list[dict[str, Any]], str]:
    if universe.get("revision") != prereg.get("revision"):
        raise ResearchError("candidate universe revision differs from preregistration")
    if universe.get("preregistration_revision") != prereg.get("revision"):
        raise ResearchError("candidate universe does not name the exact preregistration")
    declared = universe.get("lock", {}).get("sha256") if isinstance(universe.get("lock"), Mapping) else None
    calculated = sha256_json(candidate_payload(universe))
    if declared != calculated:
        raise ResearchError(f"candidate universe hash mismatch: declared={declared!r} calculated={calculated}")
    candidates = universe.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ResearchError("candidate universe is empty")
    prereg_families = set(prereg.get("hypothesis_families", []))
    observed_families: set[str] = set()
    keys: set[str] = set()
    groups: defaultdict[str, int] = defaultdict(int)
    normalized: list[dict[str, Any]] = []
    for raw in candidates:
        if not isinstance(raw, dict):
            raise ResearchError("candidate must be an object")
        key = str(raw.get("key", ""))
        family = str(raw.get("family", ""))
        group = str(raw.get("neighbor_group", ""))
        if not key or key in keys:
            raise ResearchError(f"missing or duplicate candidate key: {key!r}")
        if family not in prereg_families:
            raise ResearchError(f"candidate {key} is outside preregistered families: {family}")
        if raw.get("enabled") is not True:
            raise ResearchError(f"locked universe contains a disabled candidate: {key}")
        if not group or not isinstance(raw.get("parameters"), dict):
            raise ResearchError(f"candidate {key} lacks neighbor group or parameters")
        keys.add(key)
        observed_families.add(family)
        groups[group] += 1
        normalized.append(raw)
    if observed_families != prereg_families:
        missing = sorted(prereg_families - observed_families)
        extra = sorted(observed_families - prereg_families)
        raise ResearchError(f"candidate family coverage mismatch; missing={missing} extra={extra}")
    invalid_groups = sorted(group for group, count in groups.items() if count != 2)
    if invalid_groups:
        raise ResearchError(f"neighbor groups require exactly two locked candidates: {invalid_groups}")
    return normalized, calculated


class DataAccessGuard:
    """Records every input and prevents discovery from touching final TEST."""

    def __init__(self, mode: str, schedule: Schedule) -> None:
        self.mode = mode
        self.schedule = schedule
        self.files: list[dict[str, Any]] = []

    def assert_range(self, start_ms: int, end_ms: int, label: str) -> None:
        if start_ms >= end_ms:
            raise ResearchError(f"invalid data request for {label}")
        if start_ms < self.schedule.data_start_ms or end_ms > self.schedule.test_end_ms:
            raise ResearchError(f"request outside preregistered 2025 data cut: {label}")
        overlaps_test = start_ms < self.schedule.test_end_ms and end_ms > self.schedule.test_start_ms
        if self.mode == "DISCOVERY" and overlaps_test:
            raise ResearchError(f"DISCOVERY attempted to access final TEST: {label}")
        if self.mode == "DISCOVERY" and end_ms > self.schedule.selection_end_ms:
            raise ResearchError(f"DISCOVERY attempted to access unused pretest data: {label}")

    def record(self, path: Path, source: str, *, checksum_verified: bool) -> None:
        self.files.append(
            {
                "path": str(path.resolve()),
                "source": source,
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "checksum_verified": checksum_verified,
            }
        )

    def manifest(self) -> dict[str, Any]:
        ordered = sorted(self.files, key=lambda row: (row["source"], row["path"]))
        return {"files": ordered, "snapshot_sha256": sha256_json(ordered)}


def month_floor(ms: int) -> datetime:
    value = datetime.fromtimestamp(ms / 1_000, UTC)
    return datetime(value.year, value.month, 1, tzinfo=UTC)


def next_month(value: datetime) -> datetime:
    return datetime(value.year + (value.month == 12), 1 if value.month == 12 else value.month + 1, 1, tzinfo=UTC)


def iter_months(start_ms: int, end_ms: int) -> Iterator[datetime]:
    current = month_floor(start_ms)
    while epoch_ms(current) < end_ms:
        yield current
        current = next_month(current)


def http_bytes(url: str, *, attempts: int = 4, timeout: int = 60) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(min(8.0, 0.75 * (2**attempt)))
    raise ResearchError(f"download failed after {attempts} attempts: {url}: {last_error}")


def ensure_download(path: Path, url: str, *, offline: bool) -> None:
    if path.exists() and path.stat().st_size > 0:
        return
    if offline:
        raise ResearchError(f"offline cache miss: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = http_bytes(url)
    temporary = path.with_name(f".{path.name}.part-{os.getpid()}")
    temporary.write_bytes(data)
    os.replace(temporary, path)


@dataclass(frozen=True, slots=True)
class Bar:
    open_time_ms: int
    close_time_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    quote_volume: float
    trades: int
    taker_buy_base: float | None
    synthetic: bool = False


def parse_binance_archive(path: Path, start_ms: int, end_ms: int) -> dict[int, Bar]:
    rows: dict[int, Bar] = {}
    try:
        with zipfile.ZipFile(path) as archive:
            bad_member = archive.testzip()
            if bad_member is not None:
                raise ResearchError(f"CRC failure in {path}: {bad_member}")
            members = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if len(members) != 1:
                raise ResearchError(f"expected one CSV in {path}, got {members}")
            with archive.open(members[0]) as raw:
                text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
                for values in csv.reader(text):
                    if not values or not values[0].lstrip("-").isdigit():
                        continue
                    if len(values) < 11:
                        raise ResearchError(f"short Binance kline row in {path}: {values[:3]}")
                    open_ms = normalize_epoch_ms(values[0])
                    close_ms = normalize_epoch_ms(values[6])
                    if open_ms < start_ms or open_ms >= end_ms or close_ms >= end_ms:
                        continue
                    bar = Bar(
                        open_ms,
                        close_ms,
                        finite(values[1]),
                        finite(values[2]),
                        finite(values[3]),
                        finite(values[4]),
                        finite(values[5]),
                        finite(values[7]),
                        int(finite(values[8])),
                        finite(values[9]),
                    )
                    if min(bar.open, bar.high, bar.low, bar.close) <= 0:
                        continue
                    rows[open_ms] = bar
    except (OSError, zipfile.BadZipFile) as exc:
        raise ResearchError(f"invalid Binance archive {path}: {exc}") from exc
    return rows


def binance_archive_path(cache: Path, symbol: str, month: datetime) -> Path:
    name = f"{symbol}-15m-{month:%Y-%m}.zip"
    return cache / "binance" / "futures_um" / "monthly" / "klines" / symbol / "15m" / name


def load_binance_symbol(
    cache: Path,
    symbol: str,
    start_ms: int,
    end_ms: int,
    *,
    guard: DataAccessGuard,
    offline: bool,
) -> dict[int, Bar]:
    guard.assert_range(start_ms, end_ms, f"Binance {symbol}")
    result: dict[int, Bar] = {}
    for month in iter_months(start_ms, end_ms):
        month_start = epoch_ms(month)
        month_end = epoch_ms(next_month(month))
        if guard.mode == "DISCOVERY" and month_start < guard.schedule.test_end_ms and month_end > guard.schedule.test_start_ms:
            raise ResearchError(f"DISCOVERY refused TEST-overlapping monthly archive: {month:%Y-%m}")
        path = binance_archive_path(cache, symbol, month)
        url = f"{BINANCE_ARCHIVE_ROOT}/{symbol}/15m/{path.name}"
        ensure_download(path, url, offline=offline)
        sidecar = Path(str(path) + ".CHECKSUM")
        verified = False
        if sidecar.exists() or not offline:
            try:
                ensure_download(sidecar, url + ".CHECKSUM", offline=offline)
                expected = sidecar.read_text(encoding="utf-8").strip().split()[0].lower()
                actual = sha256_file(path)
                if expected != actual:
                    raise ResearchError(f"Binance checksum mismatch: {path}")
                verified = True
            except ResearchError:
                if sidecar.exists():
                    raise
        guard.record(path, url, checksum_verified=verified)
        result.update(parse_binance_archive(path, start_ms, end_ms))
    return result


def upbit_cache_path(cache: Path, market: str, start_ms: int, end_ms: int) -> Path:
    return cache / "upbit" / market / "15m" / f"{start_ms}-{end_ms}.jsonl"


def upbit_raw_to_bar(raw: Mapping[str, Any]) -> Bar:
    if "open_time_ms" in raw:
        open_ms = normalize_epoch_ms(raw["open_time_ms"])
        return Bar(
            open_ms,
            normalize_epoch_ms(raw.get("close_time_ms", open_ms + BAR_MS - 1)),
            finite(raw.get("open")),
            finite(raw.get("high")),
            finite(raw.get("low")),
            finite(raw.get("close")),
            finite(raw.get("volume")),
            finite(raw.get("quote_volume")),
            int(finite(raw.get("trades"))),
            None,
            bool(raw.get("synthetic", False)),
        )
    timestamp = str(raw.get("candle_date_time_utc", ""))
    if not timestamp:
        raise ResearchError("Upbit candle has no candle_date_time_utc")
    if timestamp.endswith("Z") or "+" in timestamp[10:] or "-" in timestamp[10:]:
        open_dt = parse_utc(timestamp)
    else:
        open_dt = parse_utc(timestamp + "Z")
    open_ms = epoch_ms(open_dt)
    return Bar(
        open_ms,
        open_ms + BAR_MS - 1,
        finite(raw.get("opening_price")),
        finite(raw.get("high_price")),
        finite(raw.get("low_price")),
        finite(raw.get("trade_price")),
        finite(raw.get("candle_acc_trade_volume")),
        finite(raw.get("candle_acc_trade_price")),
        0,
        None,
    )


def read_upbit_jsonl(path: Path, start_ms: int, end_ms: int) -> dict[int, Bar]:
    result: dict[int, Bar] = {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                raw = json.loads(line)
                if not isinstance(raw, Mapping):
                    raise ResearchError(f"non-object Upbit JSONL row {path}:{line_number}")
                bar = upbit_raw_to_bar(raw)
                if start_ms <= bar.open_time_ms < end_ms and bar.close_time_ms < end_ms:
                    if min(bar.open, bar.high, bar.low, bar.close) > 0:
                        result[bar.open_time_ms] = bar
    except (OSError, json.JSONDecodeError) as exc:
        raise ResearchError(f"invalid Upbit cache {path}: {exc}") from exc
    return result


def fetch_upbit_jsonl(
    path: Path,
    market: str,
    start_ms: int,
    end_ms: int,
    *,
    minimum_interval_seconds: float,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cursor_ms = end_ms
    rows: dict[int, Mapping[str, Any]] = {}
    previous_oldest: int | None = None
    while cursor_ms > start_ms:
        query = urllib.parse.urlencode(
            {
                "market": market,
                "to": iso_utc(cursor_ms),
                "count": 200,
            }
        )
        raw_bytes = http_bytes(f"{UPBIT_CANDLES_URL}?{query}")
        try:
            page = json.loads(raw_bytes)
        except json.JSONDecodeError as exc:
            raise ResearchError(f"Upbit returned invalid JSON for {market}: {exc}") from exc
        if not isinstance(page, list) or not page:
            break
        oldest = cursor_ms
        for raw in page:
            if not isinstance(raw, Mapping):
                continue
            bar = upbit_raw_to_bar(raw)
            oldest = min(oldest, bar.open_time_ms)
            if start_ms <= bar.open_time_ms < end_ms:
                rows[bar.open_time_ms] = raw
        if oldest >= cursor_ms or oldest == previous_oldest:
            raise ResearchError(f"Upbit pagination stopped moving backward for {market}")
        previous_oldest = oldest
        cursor_ms = oldest  # Upbit `to` is exclusive.
        if oldest < start_ms:
            break
        time.sleep(max(0.0, minimum_interval_seconds))

    temporary = path.with_name(f".{path.name}.part-{os.getpid()}")
    with temporary.open("w", encoding="utf-8") as handle:
        for timestamp in sorted(rows):
            handle.write(json.dumps(rows[timestamp], ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def load_upbit_market(
    cache: Path,
    market: str,
    start_ms: int,
    end_ms: int,
    *,
    guard: DataAccessGuard,
    offline: bool,
    minimum_interval_seconds: float,
) -> dict[int, Bar]:
    guard.assert_range(start_ms, end_ms, f"Upbit {market}")
    path = upbit_cache_path(cache, market, start_ms, end_ms)
    if not path.exists():
        if offline:
            raise ResearchError(f"offline Upbit cache miss: {path}")
        fetch_upbit_jsonl(path, market, start_ms, end_ms, minimum_interval_seconds=minimum_interval_seconds)
    guard.record(path, f"{UPBIT_CANDLES_URL}?market={market}", checksum_verified=False)
    return read_upbit_jsonl(path, start_ms, end_ms)


def exact_upbit_bars(raw: Mapping[int, Bar], timestamps: Sequence[int]) -> dict[int, Bar]:
    """Keep only observed candles; an Upbit missing interval means NO SIGNAL."""
    return {timestamp: raw[timestamp] for timestamp in timestamps if timestamp in raw}


def prior_zscores(values: Sequence[float], window: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    for index in range(window, len(values)):
        history = values[index - window : index]
        mean = sum(history) / window
        variance = sum((value - mean) ** 2 for value in history) / window
        std = math.sqrt(variance)
        result[index] = 0.0 if std <= 1e-12 else (values[index] - mean) / std
    return result


def prior_optional_zscores(values: Sequence[float | None], window: int) -> list[float | None]:
    """A missing current or baseline candle invalidates the feature, never zero-fills it."""
    result: list[float | None] = [None] * len(values)
    for index in range(window, len(values)):
        current = values[index]
        history = values[index - window : index]
        if current is None or any(value is None for value in history):
            continue
        complete = [float(value) for value in history if value is not None]
        mean = sum(complete) / window
        variance = sum((value - mean) ** 2 for value in complete) / window
        std = math.sqrt(variance)
        result[index] = 0.0 if std <= 1e-12 else (current - mean) / std
    return result


def prior_realized_vol(returns: Sequence[float | None], window: int) -> list[float | None]:
    result: list[float | None] = [None] * len(returns)
    for index in range(window + 1, len(returns)):
        history = [value for value in returns[index - window : index] if value is not None]
        if len(history) != window:
            continue
        result[index] = statistics.pstdev(history)
    return result


@dataclass(slots=True)
class Feature:
    asset: str
    time_ms: int
    bin_ret1_bps: float | None
    bin_ret4_bps: float | None
    bin_ret96: float | None
    up_ret1_bps: float | None
    up_ret4_bps: float | None
    up_volume_z: float | None
    bin_volume_z: float | None
    bin_taker_signed: float | None
    atr: float | None
    atr_bps: float | None
    prior_rv_ratio: float | None
    ema72h: float | None
    trend_efficiency24h: float | None
    vwap_deviation_atr: float | None
    prior_bin_ret1_bps: float | None
    prior_bin_ret4_bps: float | None
    prior_bin_volume_z: float | None
    prior_atr_bps: float | None
    close_location: float
    breadth24h: float | None = None
    breadth24h_assets: int = 0
    upbit_breadth1: float | None = None
    upbit_breadth_assets: int = 0
    upbit_breadth_change4: float | None = None
    residual_bps: float | None = None
    residual_percentile: float | None = None
    residual_rank_assets: int = 0
    beta_residual4_bps: float | None = None
    beta_residual_percentile: float | None = None
    beta_residual_rank_assets: int = 0
    regime: str = "OTHER"
    tactical: str = "STABLE"


@dataclass(slots=True)
class Dataset:
    assets: tuple[str, ...]
    start_ms: int
    end_ms: int
    binance: dict[str, dict[int, Bar]]
    upbit: dict[str, dict[int, Bar]]
    features: dict[str, dict[int, Feature]]
    audit: dict[str, Any]


def bar_return(bars: Sequence[Bar], index: int, lag: int) -> float | None:
    if index < lag or bars[index].open_time_ms - bars[index - lag].open_time_ms != lag * BAR_MS:
        return None
    denominator = bars[index - lag].close
    return None if denominator <= 0 else bars[index].close / denominator - 1.0


def true_ranges(bars: Sequence[Bar]) -> list[float]:
    values: list[float] = []
    for index, bar in enumerate(bars):
        previous_close = bars[index - 1].close if index else bar.open
        values.append(max(bar.high - bar.low, abs(bar.high - previous_close), abs(bar.low - previous_close)))
    return values


def rolling_mean(values: Sequence[float], window: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    running = 0.0
    for index, value in enumerate(values):
        running += value
        if index >= window:
            running -= values[index - window]
        if index + 1 >= window:
            result[index] = running / window
    return result


def rolling_vwap(bars: Sequence[Bar], window: int) -> list[float | None]:
    """Completed-bar typical-price VWAP; every observation is known at bar close."""
    result: list[float | None] = [None] * len(bars)
    weighted = 0.0
    volume = 0.0
    for index, bar in enumerate(bars):
        typical = (bar.high + bar.low + bar.close) / 3.0
        weight = max(0.0, bar.volume)
        weighted += typical * weight
        volume += weight
        if index >= window:
            old = bars[index - window]
            old_typical = (old.high + old.low + old.close) / 3.0
            old_weight = max(0.0, old.volume)
            weighted -= old_typical * old_weight
            volume -= old_weight
        if (
            index + 1 >= window
            and volume > 1e-12
            and bar.open_time_ms - bars[index - window + 1].open_time_ms == (window - 1) * BAR_MS
        ):
            result[index] = weighted / volume
    return result


def build_asset_features(
    asset: str,
    binance: Mapping[int, Bar],
    upbit: Mapping[int, Bar],
) -> dict[int, Feature]:
    bars = [binance[timestamp] for timestamp in sorted(binance)]
    if not bars:
        return {}
    up_exact = exact_upbit_bars(upbit, [bar.open_time_ms for bar in bars])
    bin_ret1 = [bar_return(bars, index, 1) for index in range(len(bars))]
    bin_ret4 = [bar_return(bars, index, 4) for index in range(len(bars))]
    bin_ret96 = [bar_return(bars, index, 96) for index in range(len(bars))]
    bin_volume_z = prior_zscores([math.log1p(max(0.0, bar.quote_volume)) for bar in bars], 96)
    ranges = true_ranges(bars)
    atr14 = rolling_mean(ranges, 14)
    vwap16 = rolling_vwap(bars, 16)
    rv16 = prior_realized_vol(bin_ret1, 16)
    rv96 = prior_realized_vol(bin_ret1, 96)

    up_bars: list[Bar | None] = [up_exact.get(bar.open_time_ms) for bar in bars]
    up_ret1: list[float | None] = [None] * len(bars)
    up_ret4: list[float | None] = [None] * len(bars)
    up_logs: list[float | None] = [
        math.log1p(max(0.0, bar.quote_volume)) if bar is not None else None for bar in up_bars
    ]
    up_volume_z = prior_optional_zscores(up_logs, 96)
    for index, current in enumerate(up_bars):
        if current is None:
            continue
        for lag, target in ((1, up_ret1), (4, up_ret4)):
            if index < lag:
                continue
            window = up_bars[index - lag : index + 1]
            previous = up_bars[index - lag]
            if (
                previous is None
                or any(value is None for value in window)
                or current.open_time_ms - previous.open_time_ms != lag * BAR_MS
                or previous.close <= 0
            ):
                continue
            target[index] = current.close / previous.close - 1.0

    ema_values: list[float | None] = [None] * len(bars)
    alpha = 2.0 / (288.0 + 1.0)
    ema = bars[0].close
    path_lengths = [0.0]
    for index in range(1, len(bars)):
        ema = alpha * bars[index].close + (1.0 - alpha) * ema
        path_lengths.append(path_lengths[-1] + abs(bars[index].close - bars[index - 1].close))
        if index >= 287:
            ema_values[index] = ema

    result: dict[int, Feature] = {}
    for index, bar in enumerate(bars):
        taker_signed: float | None = None
        if bar.volume > 0 and bar.taker_buy_base is not None:
            taker_signed = clamp(2.0 * bar.taker_buy_base / bar.volume - 1.0, -1.0, 1.0)
        efficiency: float | None = None
        if index >= 96 and bars[index].open_time_ms - bars[index - 96].open_time_ms == 96 * BAR_MS:
            path = path_lengths[index] - path_lengths[index - 96]
            efficiency = 0.0 if path <= 1e-12 else abs(bar.close - bars[index - 96].close) / path
        atr = atr14[index]
        has_exact_prior = index > 0 and bar.open_time_ms - bars[index - 1].open_time_ms == BAR_MS
        prior_atr_bps = None
        if has_exact_prior and atr14[index - 1] is not None and bars[index - 1].close > 0:
            prior_atr_bps = atr14[index - 1] / bars[index - 1].close * 10_000
        vwap_deviation_atr = None
        if atr is not None and atr > 1e-12 and vwap16[index] is not None:
            vwap_deviation_atr = (bar.close - vwap16[index]) / atr
        candle_range = bar.high - bar.low
        close_location = 0.5 if candle_range <= 1e-12 else clamp((bar.close - bar.low) / candle_range, 0.0, 1.0)
        ratio = None
        if rv16[index] is not None and rv96[index] is not None and rv96[index] > 1e-12:
            ratio = rv16[index] / rv96[index]
        up1 = up_ret1[index]
        up4 = up_ret4[index]
        feature = Feature(
            asset=asset,
            time_ms=bar.open_time_ms,
            bin_ret1_bps=None if bin_ret1[index] is None else bin_ret1[index] * 10_000,
            bin_ret4_bps=None if bin_ret4[index] is None else bin_ret4[index] * 10_000,
            bin_ret96=bin_ret96[index],
            up_ret1_bps=None if up1 is None else up1 * 10_000,
            up_ret4_bps=None if up4 is None else up4 * 10_000,
            up_volume_z=up_volume_z[index],
            bin_volume_z=bin_volume_z[index],
            bin_taker_signed=taker_signed,
            atr=atr,
            atr_bps=None if atr is None else atr / bar.close * 10_000,
            prior_rv_ratio=ratio,
            ema72h=ema_values[index],
            trend_efficiency24h=efficiency,
            vwap_deviation_atr=vwap_deviation_atr,
            prior_bin_ret1_bps=None if not has_exact_prior or bin_ret1[index - 1] is None else bin_ret1[index - 1] * 10_000,
            prior_bin_ret4_bps=None if not has_exact_prior or bin_ret4[index - 1] is None else bin_ret4[index - 1] * 10_000,
            prior_bin_volume_z=None if not has_exact_prior else bin_volume_z[index - 1],
            prior_atr_bps=prior_atr_bps,
            close_location=close_location,
            residual_bps=None if up1 is None or bin_ret1[index] is None else (up1 - bin_ret1[index]) * 10_000,
        )
        result[bar.open_time_ms] = feature
    return result


def enrich_binance_beta_features(
    dataset: Dataset, estimation_window: int = 96, residual_horizon: int = 4
) -> None:
    """Estimate prior, non-overlapping BTC/ETH betas and completed 4-bar residuals."""
    btc_features = dataset.features.get("BTC", {})
    eth_features = dataset.features.get("ETH", {})
    for asset in dataset.assets:
        if asset in {"BTC", "ETH"}:
            continue
        features = dataset.features[asset]
        timestamps = sorted(features)
        for index in range(estimation_window + residual_horizon, len(timestamps)):
            timestamp = timestamps[index]
            if timestamp - timestamps[index - residual_horizon] != residual_horizon * BAR_MS:
                continue
            training_times = timestamps[
                index - residual_horizon - estimation_window + 1 : index - residual_horizon + 1
            ]
            if (
                len(training_times) != estimation_window
                or training_times[-1] - training_times[0] != (estimation_window - 1) * BAR_MS
            ):
                continue
            observations: list[tuple[float, float, float]] = []
            for training_time in training_times:
                row = features.get(training_time)
                btc = btc_features.get(training_time)
                eth = eth_features.get(training_time)
                if (
                    row is None
                    or btc is None
                    or eth is None
                    or row.bin_ret1_bps is None
                    or btc.bin_ret1_bps is None
                    or eth.bin_ret1_bps is None
                ):
                    observations = []
                    break
                observations.append((btc.bin_ret1_bps, eth.bin_ret1_bps, row.bin_ret1_bps))
            current = features[timestamp]
            btc_now = btc_features.get(timestamp)
            eth_now = eth_features.get(timestamp)
            if (
                len(observations) != estimation_window
                or current.bin_ret4_bps is None
                or btc_now is None
                or eth_now is None
                or btc_now.bin_ret4_bps is None
                or eth_now.bin_ret4_bps is None
            ):
                continue
            count = float(estimation_window)
            mean_x1 = sum(row[0] for row in observations) / count
            mean_x2 = sum(row[1] for row in observations) / count
            mean_y = sum(row[2] for row in observations) / count
            s11 = sum((row[0] - mean_x1) ** 2 for row in observations)
            s22 = sum((row[1] - mean_x2) ** 2 for row in observations)
            s12 = sum((row[0] - mean_x1) * (row[1] - mean_x2) for row in observations)
            sy1 = sum((row[0] - mean_x1) * (row[2] - mean_y) for row in observations)
            sy2 = sum((row[1] - mean_x1) * (row[2] - mean_y) for row in observations)
            determinant = s11 * s22 - s12 * s12
            if determinant <= 1e-9:
                continue
            beta_btc = (sy1 * s22 - sy2 * s12) / determinant
            beta_eth = (sy2 * s11 - sy1 * s12) / determinant
            alpha = mean_y - beta_btc * mean_x1 - beta_eth * mean_x2
            expected = (
                residual_horizon * alpha
                + beta_btc * btc_now.bin_ret4_bps
                + beta_eth * eth_now.bin_ret4_bps
            )
            current.beta_residual4_bps = current.bin_ret4_bps - expected


def enrich_cross_sectional_features(dataset: Dataset) -> None:
    enrich_binance_beta_features(dataset)
    by_time: defaultdict[int, list[Feature]] = defaultdict(list)
    for features in dataset.features.values():
        for feature in features.values():
            by_time[feature.time_ms].append(feature)
    upbit_breadth_history: dict[int, float] = {}
    for timestamp in sorted(by_time):
        rows = by_time[timestamp]
        ret96 = [row.bin_ret96 for row in rows if row.bin_ret96 is not None]
        up1 = [row.up_ret1_bps for row in rows if row.up_ret1_bps is not None]
        breadth24 = None if not ret96 else sum(value > 0 for value in ret96) / len(ret96)
        up_breadth = None if not up1 else sum(value > 0 for value in up1) / len(up1)
        if up_breadth is not None:
            upbit_breadth_history[timestamp] = up_breadth
        residuals = sorted((row.residual_bps, row.asset, row) for row in rows if row.residual_bps is not None)
        beta_residuals = sorted(
            (row.beta_residual4_bps, row.asset, row)
            for row in rows
            if row.asset not in {"BTC", "ETH"} and row.beta_residual4_bps is not None
        )
        rank_count = len(residuals)
        for rank, (_, _, row) in enumerate(residuals):
            row.residual_percentile = 0.5 if rank_count == 1 else rank / (rank_count - 1)
            row.residual_rank_assets = rank_count
        beta_rank_count = len(beta_residuals)
        for rank, (_, _, row) in enumerate(beta_residuals):
            row.beta_residual_percentile = (
                0.5 if beta_rank_count == 1 else rank / (beta_rank_count - 1)
            )
            row.beta_residual_rank_assets = beta_rank_count
        btc = dataset.features.get("BTC", {}).get(timestamp)
        for row in rows:
            row.breadth24h = breadth24
            row.breadth24h_assets = len(ret96)
            row.upbit_breadth1 = up_breadth
            row.upbit_breadth_assets = len(up1)
            prior_breadth = upbit_breadth_history.get(timestamp - 4 * BAR_MS)
            if up_breadth is not None and prior_breadth is not None:
                row.upbit_breadth_change4 = up_breadth - prior_breadth
            if btc is None or btc.bin_ret96 is None or btc.ema72h is None or btc.trend_efficiency24h is None or breadth24 is None:
                continue
            btc_close = dataset.binance["BTC"][timestamp].close
            if btc.bin_ret96 <= -0.03 and btc_close < btc.ema72h and breadth24 <= 0.30:
                row.regime = "STRONG_BEAR"
            elif btc.bin_ret96 <= -0.01 and btc_close < btc.ema72h and breadth24 <= 0.45:
                row.regime = "BEAR"
            elif abs(btc.bin_ret96) <= 0.02 and btc.trend_efficiency24h <= 0.35 and 0.30 <= breadth24 <= 0.70:
                row.regime = "RANGE"
            prior_drop_atr = None
            if (
                row.prior_bin_ret1_bps is not None
                and row.prior_atr_bps is not None
                and row.prior_atr_bps > 1e-9
            ):
                prior_drop_atr = -row.prior_bin_ret1_bps / row.prior_atr_bps
            if (
                row.regime in {"BEAR", "STRONG_BEAR"}
                and prior_drop_atr is not None
                and prior_drop_atr >= 0.8
                and row.prior_bin_volume_z is not None
                and row.prior_bin_volume_z >= 1.5
                and row.bin_ret1_bps is not None
                and row.bin_ret1_bps > 0
            ):
                row.tactical = "CAPITULATION_RECOVERY"
            elif (
                row.regime in {"BEAR", "STRONG_BEAR"}
                and row.prior_bin_ret4_bps is not None
                and row.prior_bin_ret4_bps > 0
                and row.bin_ret1_bps is not None
                and row.bin_ret1_bps < 0
            ):
                row.tactical = "REBOUND_FAILURE"
            elif row.prior_rv_ratio is not None and row.prior_rv_ratio <= 0.65:
                row.tactical = "COMPRESSION"
            elif row.atr_bps and row.bin_ret1_bps is not None and abs(row.bin_ret1_bps) >= 0.8 * row.atr_bps:
                row.tactical = "EXPANSION"
            elif row.regime in {"BEAR", "STRONG_BEAR"} and row.bin_ret4_bps is not None:
                row.tactical = "REBOUND" if row.bin_ret4_bps > 0 else "REBREAK"


def load_dataset(
    prereg: Mapping[str, Any],
    schedule: Schedule,
    cache: Path,
    start_ms: int,
    end_ms: int,
    *,
    mode: str,
    offline: bool,
    upbit_interval: float,
) -> Dataset:
    guard = DataAccessGuard(mode, schedule)
    guard.assert_range(start_ms, end_ms, f"{mode} dataset")
    assets = tuple(str(asset) for asset in prereg["data"]["assets"])
    binance: dict[str, dict[int, Bar]] = {}
    upbit: dict[str, dict[int, Bar]] = {}
    for asset in assets:
        binance[asset] = load_binance_symbol(
            cache, f"{asset}USDT", start_ms, end_ms, guard=guard, offline=offline
        )
        upbit[asset] = load_upbit_market(
            cache,
            f"KRW-{asset}",
            start_ms,
            end_ms,
            guard=guard,
            offline=offline,
            minimum_interval_seconds=upbit_interval,
        )
    if "BTC" not in binance or not binance["BTC"]:
        raise ResearchError("BTC benchmark data is missing")
    features = {
        asset: build_asset_features(asset, binance[asset], upbit[asset])
        for asset in assets
    }
    dataset = Dataset(assets, start_ms, end_ms, binance, upbit, features, guard.manifest())
    enrich_cross_sectional_features(dataset)
    return dataset


@dataclass(frozen=True, slots=True)
class Signal:
    candidate_key: str
    family: str
    asset: str
    signal_time_ms: int
    entry_time_ms: int
    side: str
    score: float
    regime: str
    tactical: str
    atr: float


@dataclass(frozen=True, slots=True)
class Trade:
    candidate_key: str
    family: str
    asset: str
    side: str
    signal_time_ms: int
    entry_time_ms: int
    exit_time_ms: int
    regime: str
    tactical: str
    exit_reason: str
    holding_bars: int
    gross_bps: float
    base_bps: float
    stress_bps: float
    mae_bps: float
    mfe_bps: float


def direction(value: float) -> str:
    return "LONG" if value > 0 else "SHORT"


def trigger_excess(observed: float, threshold: float) -> float:
    """Dimensionless non-negative excess used only for deterministic priority."""
    if abs(threshold) <= 1e-9:
        return max(0.0, observed - threshold)
    return max(0.0, observed / abs(threshold) - 1.0)


def crosses_funding_event(entry_time_ms: int, exit_time_ms: int) -> bool:
    """Whether (entry, exit] contains a UTC 00:00/08:00/16:00 event."""
    funding_interval_ms = 8 * 60 * 60 * 1_000
    next_event = (entry_time_ms // funding_interval_ms + 1) * funding_interval_ms
    return next_event <= exit_time_ms


def candidate_signal(candidate: Mapping[str, Any], feature: Feature) -> tuple[str, float] | None:
    if feature.regime not in candidate["regimes"]:
        return None
    family = str(candidate["family"])
    parameters = candidate["parameters"]
    side: str | None = None
    score = 0.0
    up1 = feature.up_ret1_bps
    bin1 = feature.bin_ret1_bps
    upz = feature.up_volume_z

    if family == "UPBIT_LEAD_CONTINUATION":
        if up1 is None or bin1 is None or upz is None:
            return None
        minimum = finite(parameters["min_upbit_move_bps"])
        if abs(up1) < minimum or upz < finite(parameters["min_upbit_quote_volume_z"]):
            return None
        if abs(bin1) > abs(up1) * finite(parameters["max_binance_follow_ratio"]):
            return None
        side = direction(up1)
        follow_limit = abs(up1) * finite(parameters["max_binance_follow_ratio"])
        score = (
            trigger_excess(abs(up1), minimum)
            + max(0.0, 1.0 - abs(bin1) / max(follow_limit, 1e-9))
            + trigger_excess(upz, finite(parameters["min_upbit_quote_volume_z"]))
        )

    elif family == "UPBIT_BINANCE_DIVERGENCE_CONVERGENCE":
        if int(parameters["horizon_bars"]) != 4:
            raise ResearchError("V10 divergence candidate is locked to an exact four-bar residual")
        if feature.up_ret4_bps is None or feature.bin_ret4_bps is None:
            return None
        gap = feature.up_ret4_bps - feature.bin_ret4_bps
        if abs(gap) < finite(parameters["min_divergence_bps"]):
            return None
        if abs(gap) > finite(parameters["max_divergence_bps"]):
            return None
        if abs(feature.up_ret4_bps) < finite(parameters["min_upbit_absolute_move_bps"]):
            return None
        side = direction(gap)
        score = trigger_excess(abs(gap), finite(parameters["min_divergence_bps"]))

    elif family == "KOREAN_VOLUME_SHOCK_TRANSMISSION":
        if up1 is None or bin1 is None or upz is None:
            return None
        if upz < finite(parameters["min_upbit_quote_volume_z"]):
            return None
        if abs(up1) < finite(parameters["min_upbit_move_bps"]):
            return None
        if abs(bin1) > abs(up1) * finite(parameters["max_binance_follow_ratio"]):
            return None
        side = direction(up1)
        score = (
            trigger_excess(upz, finite(parameters["min_upbit_quote_volume_z"]))
            + trigger_excess(abs(up1), finite(parameters["min_upbit_move_bps"]))
            + max(
                0.0,
                1.0
                - abs(bin1)
                / max(abs(up1) * finite(parameters["max_binance_follow_ratio"]), 1e-9),
            )
        )

    elif family == "CROSS_SECTIONAL_KOREAN_RESIDUAL_RANK":
        rank = feature.residual_percentile
        residual = feature.residual_bps
        tail = finite(parameters["tail_fraction"])
        if rank is None or residual is None:
            return None
        if feature.residual_rank_assets < int(parameters["minimum_ranked_assets"]):
            return None
        if abs(residual) < finite(parameters["min_absolute_residual_bps"]):
            return None
        if rank >= 1.0 - tail:
            side = "LONG"
        elif rank <= tail:
            side = "SHORT"
        else:
            return None
        rank_threshold = 0.5 - tail
        score = (
            trigger_excess(abs(rank - 0.5), rank_threshold)
            + trigger_excess(abs(residual), finite(parameters["min_absolute_residual_bps"]))
        )

    elif family == "CROSS_EXCHANGE_BREADTH_PROPAGATION":
        breadth = feature.upbit_breadth1
        change = feature.upbit_breadth_change4
        if breadth is None or change is None or bin1 is None:
            return None
        if feature.upbit_breadth_assets < int(parameters["minimum_breadth_assets"]):
            return None
        if abs(bin1) > finite(parameters["max_binance_absolute_move_bps"]):
            return None
        minimum_change = finite(parameters["min_four_bar_breadth_change"])
        if breadth >= finite(parameters["upper_breadth"]) and change >= minimum_change:
            side = "LONG"
        elif breadth <= finite(parameters["lower_breadth"]) and change <= -minimum_change:
            side = "SHORT"
        else:
            return None
        breadth_threshold = abs(
            (finite(parameters["upper_breadth"]) if side == "LONG" else finite(parameters["lower_breadth"]))
            - 0.5
        )
        score = trigger_excess(abs(change), minimum_change) + trigger_excess(
            abs(breadth - 0.5), breadth_threshold
        ) + max(
            0.0,
            1.0
            - abs(bin1) / max(finite(parameters["max_binance_absolute_move_bps"]), 1e-9),
        )

    elif family == "CROSS_EXCHANGE_FLOW_DISAGREEMENT":
        taker = feature.bin_taker_signed
        if up1 is None or bin1 is None or upz is None or taker is None:
            return None
        if abs(up1) < finite(parameters["min_upbit_move_bps"]):
            return None
        if upz < finite(parameters["min_upbit_quote_volume_z"]):
            return None
        if abs(bin1) > finite(parameters["max_binance_absolute_move_bps"]):
            return None
        signed_disagreement = -taker if up1 > 0 else taker
        if signed_disagreement < finite(parameters["min_opposite_binance_taker_imbalance"]):
            return None
        side = direction(up1)
        score = (
            trigger_excess(abs(up1), finite(parameters["min_upbit_move_bps"]))
            + trigger_excess(
                signed_disagreement,
                finite(parameters["min_opposite_binance_taker_imbalance"]),
            )
            + trigger_excess(upz, finite(parameters["min_upbit_quote_volume_z"]))
        )

    elif family == "KOREAN_FLOW_CONDITIONAL_VOLATILITY_BREAKOUT":
        if (
            up1 is None
            or bin1 is None
            or upz is None
            or feature.atr_bps is None
            or feature.prior_rv_ratio is None
        ):
            return None
        if feature.prior_rv_ratio > finite(parameters["max_prior_rv16_to_rv96"]):
            return None
        if abs(bin1) < finite(parameters["min_breakout_atr"]) * feature.atr_bps:
            return None
        if abs(up1) < finite(parameters["min_upbit_confirmation_bps"]):
            return None
        if upz < finite(parameters["min_upbit_quote_volume_z"]):
            return None
        if (bin1 > 0) != (up1 > 0):
            return None
        side = direction(bin1)
        score = (
            max(
                0.0,
                1.0
                - feature.prior_rv_ratio
                / max(finite(parameters["max_prior_rv16_to_rv96"]), 1e-9),
            )
            + trigger_excess(
                abs(bin1) / max(feature.atr_bps, 1e-9),
                finite(parameters["min_breakout_atr"]),
            )
            + trigger_excess(abs(up1), finite(parameters["min_upbit_confirmation_bps"]))
            + trigger_excess(upz, finite(parameters["min_upbit_quote_volume_z"]))
        )

    elif family == "INTRADAY_SEASONALITY_CONDITIONAL_TRANSMISSION":
        if up1 is None or bin1 is None or upz is None:
            return None
        hour = datetime.fromtimestamp(feature.time_ms / 1_000, UTC).hour
        if hour not in {int(value) for value in parameters["utc_hours"]}:
            return None
        if abs(up1) < finite(parameters["min_upbit_move_bps"]):
            return None
        if abs(bin1) > abs(up1) * finite(parameters["max_binance_follow_ratio"]):
            return None
        if upz < finite(parameters["min_upbit_quote_volume_z"]):
            return None
        side = direction(up1)
        follow_limit = abs(up1) * finite(parameters["max_binance_follow_ratio"])
        score = (
            trigger_excess(abs(up1), finite(parameters["min_upbit_move_bps"]))
            + max(0.0, 1.0 - abs(bin1) / max(follow_limit, 1e-9))
            + trigger_excess(upz, finite(parameters["min_upbit_quote_volume_z"]))
        )

    elif family == "RANGE_VWAP_VOL_NORMALIZED_REVERSAL":
        if int(parameters["vwap_window_bars"]) != 16:
            raise ResearchError("V10 RANGE VWAP feature is locked to 16 completed bars")
        if (
            feature.vwap_deviation_atr is None
            or feature.bin_ret4_bps is None
            or feature.atr_bps is None
            or feature.atr_bps <= 1e-9
            or feature.trend_efficiency24h is None
        ):
            return None
        deviation = feature.vwap_deviation_atr
        move_atr = feature.bin_ret4_bps / feature.atr_bps
        minimum_deviation = finite(parameters["min_abs_vwap_deviation_atr"])
        minimum_move = finite(parameters["min_abs_four_bar_move_atr"])
        maximum_efficiency = finite(parameters["max_trend_efficiency24h"])
        if abs(deviation) < minimum_deviation or abs(move_atr) < minimum_move:
            return None
        if (deviation > 0) != (move_atr > 0):
            return None
        if feature.trend_efficiency24h > maximum_efficiency:
            return None
        side = "SHORT" if deviation > 0 else "LONG"
        score = (
            trigger_excess(abs(deviation), minimum_deviation)
            + trigger_excess(abs(move_atr), minimum_move)
            + max(0.0, 1.0 - feature.trend_efficiency24h / max(maximum_efficiency, 1e-9))
        )

    elif family == "BEAR_WEAK_REBOUND_FAILURE_SHORT":
        if int(parameters["rebound_lookback_bars"]) != 4:
            raise ResearchError("V10 BEAR rebound feature is locked to four prior completed bars")
        if (
            feature.prior_bin_ret4_bps is None
            or bin1 is None
            or feature.atr_bps is None
            or feature.atr_bps <= 1e-9
        ):
            return None
        rebound_atr = feature.prior_bin_ret4_bps / feature.atr_bps
        renewed_sell_atr = -bin1 / feature.atr_bps
        minimum_rebound = finite(parameters["min_prior_rebound_atr"])
        maximum_rebound = finite(parameters["max_prior_rebound_atr"])
        minimum_sell = finite(parameters["min_renewed_sell_atr"])
        maximum_close = finite(parameters["max_close_location"])
        if not minimum_rebound <= rebound_atr <= maximum_rebound:
            return None
        if renewed_sell_atr < minimum_sell or feature.close_location > maximum_close:
            return None
        side = "SHORT"
        score = (
            trigger_excess(rebound_atr, minimum_rebound)
            + trigger_excess(renewed_sell_atr, minimum_sell)
            + max(0.0, 1.0 - feature.close_location / max(maximum_close, 1e-9))
        )

    elif family == "BEAR_VOLUME_CAPITULATION_RECOVERY_LONG":
        if (
            feature.prior_bin_ret1_bps is None
            or feature.prior_bin_volume_z is None
            or feature.prior_atr_bps is None
            or feature.prior_atr_bps <= 1e-9
            or bin1 is None
            or feature.atr_bps is None
            or feature.atr_bps <= 1e-9
        ):
            return None
        prior_drop_atr = -feature.prior_bin_ret1_bps / feature.prior_atr_bps
        recovery_atr = bin1 / feature.atr_bps
        recovery_fraction = bin1 / max(-feature.prior_bin_ret1_bps, 1e-9)
        minimum_drop = finite(parameters["min_prior_drop_atr"])
        minimum_volume = finite(parameters["min_prior_quote_volume_z"])
        minimum_recovery = finite(parameters["min_recovery_atr"])
        minimum_fraction = finite(parameters["min_recovery_fraction"])
        maximum_fraction = finite(parameters["max_recovery_fraction"])
        minimum_close = finite(parameters["min_recovery_close_location"])
        if prior_drop_atr < minimum_drop or feature.prior_bin_volume_z < minimum_volume:
            return None
        if recovery_atr < minimum_recovery:
            return None
        if not minimum_fraction <= recovery_fraction <= maximum_fraction:
            return None
        if feature.close_location < minimum_close:
            return None
        side = "LONG"
        score = (
            trigger_excess(prior_drop_atr, minimum_drop)
            + trigger_excess(feature.prior_bin_volume_z, minimum_volume)
            + trigger_excess(recovery_atr, minimum_recovery)
            + trigger_excess(recovery_fraction, minimum_fraction)
            + trigger_excess(feature.close_location, minimum_close)
        )

    elif family == "BINANCE_BETA_RESIDUAL_CROSS_SECTIONAL_CONTINUATION":
        if int(parameters["residual_horizon_bars"]) != 4 or int(parameters["beta_estimation_bars"]) != 96:
            raise ResearchError("V10 Binance beta residual is locked to prior non-overlapping 96-bar beta and four-bar signal")
        residual = feature.beta_residual4_bps
        rank = feature.beta_residual_percentile
        tail = finite(parameters["tail_fraction"])
        minimum_residual = finite(parameters["min_absolute_residual_bps"])
        if residual is None or rank is None:
            return None
        if feature.beta_residual_rank_assets < int(parameters["minimum_ranked_assets"]):
            return None
        if abs(residual) < minimum_residual:
            return None
        if rank >= 1.0 - tail and residual > 0:
            side = "LONG"
        elif rank <= tail and residual < 0:
            side = "SHORT"
        else:
            return None
        rank_threshold = 0.5 - tail
        score = trigger_excess(abs(rank - 0.5), rank_threshold) + trigger_excess(
            abs(residual), minimum_residual
        )
    else:
        raise ResearchError(f"unimplemented candidate family: {family}")

    if side not in candidate["allowed_sides"]:
        return None
    return side, score


def execute_signal(
    signal: Signal,
    bars: Mapping[int, Bar],
    end_ms: int,
    execution: Mapping[str, Any],
) -> Trade | None:
    entry_bar = bars.get(signal.entry_time_ms)
    if entry_bar is None or entry_bar.open <= 0:
        return None
    max_holding = int(execution["max_holding_bars"])
    expected_times = [signal.entry_time_ms + offset * BAR_MS for offset in range(max_holding)]
    path = [bars.get(timestamp) for timestamp in expected_times]
    if any(bar is None or bar.close_time_ms >= end_ms for bar in path):
        return None
    complete_path = [bar for bar in path if bar is not None]
    entry = entry_bar.open
    minimum = finite(execution["minimum_barrier_bps"])
    maximum = finite(execution["maximum_barrier_bps"])
    stop_bps = clamp(finite(execution["stop_atr"]) * signal.atr / entry * 10_000, minimum, maximum)
    target_bps = clamp(finite(execution["target_atr"]) * signal.atr / entry * 10_000, minimum, maximum)
    sign = 1.0 if signal.side == "LONG" else -1.0
    stop_price = entry * (1.0 - sign * stop_bps / 10_000)
    target_price = entry * (1.0 + sign * target_bps / 10_000)
    maximum_favorable = -math.inf
    maximum_adverse = math.inf
    gross = 0.0
    reason = "TIME"
    exit_time = complete_path[-1].close_time_ms
    holding = max_holding
    for index, bar in enumerate(complete_path, 1):
        favorable = ((bar.high / entry - 1.0) if sign > 0 else (1.0 - bar.low / entry)) * 10_000
        adverse = ((bar.low / entry - 1.0) if sign > 0 else (1.0 - bar.high / entry)) * 10_000
        maximum_favorable = max(maximum_favorable, favorable)
        maximum_adverse = min(maximum_adverse, adverse)
        adverse_open_gap = bar.open <= stop_price if sign > 0 else bar.open >= stop_price
        stop_hit = bar.low <= stop_price if sign > 0 else bar.high >= stop_price
        target_hit = bar.high >= target_price if sign > 0 else bar.low <= target_price
        # Required conservative intrabar rule: STOP wins when both are touched.
        if adverse_open_gap:
            gross = sign * (bar.open / entry - 1.0) * 10_000
            reason = "STOP_GAP"
        elif stop_hit:
            gross = -stop_bps
            reason = "STOP"
        elif target_hit:
            gross = target_bps
            reason = "TARGET"
        else:
            continue
        exit_time = bar.close_time_ms
        holding = index
        break
    else:
        exit_price = complete_path[-1].close
        gross = sign * (exit_price / entry - 1.0) * 10_000
    # Funding was deliberately not approximated.  The preregistration makes
    # any trade crossing a standard 8h funding timestamp ineligible unless the
    # event is explicitly accounted, so fail closed even for a <=4h hold.
    if crosses_funding_event(signal.entry_time_ms, exit_time):
        return None
    base_cost = finite(execution["base_round_trip_cost_bps"])
    stress_cost = finite(execution["stress_round_trip_cost_bps"])
    return Trade(
        signal.candidate_key,
        signal.family,
        signal.asset,
        signal.side,
        signal.signal_time_ms,
        signal.entry_time_ms,
        exit_time,
        signal.regime,
        signal.tactical,
        reason,
        holding,
        gross,
        gross - base_cost,
        gross - stress_cost,
        maximum_adverse,
        maximum_favorable,
    )


def simulate_candidate(
    candidate: Mapping[str, Any],
    dataset: Dataset,
    start_ms: int,
    end_ms: int,
    execution: Mapping[str, Any],
) -> tuple[list[Trade], int]:
    by_entry: defaultdict[int, list[Signal]] = defaultdict(list)
    for asset in dataset.assets:
        bars = dataset.binance[asset]
        for timestamp, feature in dataset.features[asset].items():
            if timestamp < start_ms or timestamp >= end_ms:
                continue
            decision = candidate_signal(candidate, feature)
            if decision is None or feature.atr is None or feature.atr <= 0:
                continue
            side, score = decision
            entry_time = timestamp + BAR_MS
            if entry_time not in bars:
                continue
            by_entry[entry_time].append(
                Signal(
                    str(candidate["key"]),
                    str(candidate["family"]),
                    asset,
                    timestamp,
                    entry_time,
                    side,
                    score,
                    feature.regime,
                    feature.tactical,
                    feature.atr,
                )
            )
    raw_signals = sum(len(values) for values in by_entry.values())
    max_positions = int(execution["portfolio_max_concurrent_positions"])
    active: list[Trade] = []
    trades: list[Trade] = []
    for entry_time in sorted(by_entry):
        active = [trade for trade in active if trade.exit_time_ms >= entry_time]
        active_assets = {trade.asset for trade in active}
        slots = max_positions - len(active)
        if slots <= 0:
            continue
        for signal in sorted(
            by_entry[entry_time], key=lambda row: (-row.score, row.asset, row.candidate_key)
        ):
            if slots <= 0:
                break
            if signal.asset in active_assets:
                continue
            trade = execute_signal(signal, dataset.binance[signal.asset], end_ms, execution)
            if trade is None:
                continue
            trades.append(trade)
            active.append(trade)
            active_assets.add(signal.asset)
            slots -= 1
    return sorted(trades, key=lambda trade: (trade.entry_time_ms, trade.asset)), raw_signals


def profit_factor(values: Sequence[float]) -> float | None:
    gains = sum(value for value in values if value > 0)
    losses = -sum(value for value in values if value < 0)
    if losses <= 1e-12:
        return None if gains <= 1e-12 else 999.0
    return gains / losses


def maximum_drawdown(values: Sequence[float]) -> float:
    equity = 0.0
    peak = 0.0
    drawdown = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return drawdown


def grouped_trade_summary(trades: Sequence[Trade], key_name: str) -> dict[str, Any]:
    groups: defaultdict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        if key_name == "market":
            key = trade.asset
        elif key_name == "month":
            key = datetime.fromtimestamp(trade.entry_time_ms / 1_000, UTC).strftime("%Y-%m")
        elif key_name == "regime":
            key = trade.regime
        elif key_name == "tactical":
            key = trade.tactical
        elif key_name == "side":
            key = trade.side
        else:
            raise ResearchError(f"unsupported summary group: {key_name}")
        groups[key].append(trade)
    return {
        key: {
            "trades": len(rows),
            "wins": sum(row.stress_bps > 0 for row in rows),
            "stress_bps": rounded(sum(row.stress_bps for row in rows)),
            "stress_bps_per_trade": rounded(sum(row.stress_bps for row in rows) / len(rows)),
        }
        for key, rows in sorted(groups.items())
    }


def summarize_trades(trades: Sequence[Trade], raw_signals: int = 0) -> dict[str, Any]:
    rows = sorted(trades, key=lambda trade: (trade.entry_time_ms, trade.asset))
    gross = [trade.gross_bps for trade in rows]
    base = [trade.base_bps for trade in rows]
    stress = [trade.stress_bps for trade in rows]
    count = len(rows)
    market_counts: defaultdict[str, int] = defaultdict(int)
    for trade in rows:
        market_counts[trade.asset] += 1
    top_winner = max([0.0, *stress])
    half = count // 2
    signal_days = {
        datetime.fromtimestamp(trade.signal_time_ms / 1_000, UTC).date().isoformat() for trade in rows
    }
    result: dict[str, Any] = {
        "raw_signals": raw_signals,
        "trades": count,
        "signal_days": len(signal_days),
        "wins": sum(value > 0 for value in stress),
        "win_rate": rounded(sum(value > 0 for value in stress) / count if count else 0.0),
        "gross_bps": rounded(sum(gross)),
        "base_bps": rounded(sum(base)),
        "stress_bps": rounded(sum(stress)),
        "gross_bps_per_trade": rounded(sum(gross) / count if count else 0.0),
        "base_bps_per_trade": rounded(sum(base) / count if count else 0.0),
        "stress_bps_per_trade": rounded(sum(stress) / count if count else 0.0),
        "gross_profit_factor": rounded(profit_factor(gross)),
        "base_profit_factor": rounded(profit_factor(base)),
        "stress_profit_factor": rounded(profit_factor(stress)),
        "max_drawdown_stress_bps": rounded(maximum_drawdown(stress)),
        "stress_p01_bps": rounded(quantile(stress, 0.01)),
        "stress_p05_bps": rounded(quantile(stress, 0.05)),
        "worst_stress_bps": rounded(min(stress)) if stress else None,
        "average_mae_bps": rounded(sum(trade.mae_bps for trade in rows) / count if count else 0.0),
        "average_mfe_bps": rounded(sum(trade.mfe_bps for trade in rows) / count if count else 0.0),
        "turnover_round_trips": count,
        "turnover_legs": count * 2,
        "exposure_hours": rounded(sum(trade.holding_bars for trade in rows) * BAR_MINUTES / 60.0),
        "max_single_market_trade_share": rounded(max(market_counts.values(), default=0) / count if count else 0.0),
        "stress_without_top_winner_bps": rounded(sum(stress) - top_winner if stress else 0.0),
        "first_half_stress_bps": rounded(sum(stress[:half])),
        "second_half_stress_bps": rounded(sum(stress[half:])),
        "by_market": grouped_trade_summary(rows, "market"),
        "by_month": grouped_trade_summary(rows, "month"),
        "by_regime": grouped_trade_summary(rows, "regime"),
        "by_tactical": grouped_trade_summary(rows, "tactical"),
        "by_side": grouped_trade_summary(rows, "side"),
    }
    return result


SCALAR_METRIC_KEYS = (
    "raw_signals",
    "trades",
    "signal_days",
    "wins",
    "win_rate",
    "gross_bps",
    "base_bps",
    "stress_bps",
    "stress_bps_per_trade",
    "stress_profit_factor",
    "max_drawdown_stress_bps",
    "stress_p05_bps",
    "worst_stress_bps",
    "average_mae_bps",
    "average_mfe_bps",
    "max_single_market_trade_share",
    "stress_without_top_winner_bps",
    "first_half_stress_bps",
    "second_half_stress_bps",
)


def compact_metrics(metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {key: metrics.get(key) for key in SCALAR_METRIC_KEYS}


def evaluate_discovery(
    prereg: Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    schedule: Schedule,
    dataset: Dataset,
) -> list[dict[str, Any]]:
    execution = prereg["execution"]
    gates = prereg["promotion_gates"]
    results: list[dict[str, Any]] = []
    for candidate in candidates:
        folds: list[dict[str, Any]] = []
        validation_trades: list[Trade] = []
        training_trades: list[Trade] = []
        validation_raw_signals = 0
        training_raw_signals = 0
        positive_validation_folds = 0
        for fold in schedule.folds:
            train, train_raw = simulate_candidate(
                candidate, dataset, fold.train_start_ms, fold.train_end_ms, execution
            )
            validation, validation_raw = simulate_candidate(
                candidate,
                dataset,
                fold.validation_start_ms,
                fold.validation_end_ms,
                execution,
            )
            train_metrics = summarize_trades(train, train_raw)
            validation_metrics = summarize_trades(validation, validation_raw)
            if finite(validation_metrics["stress_bps"]) > 0:
                positive_validation_folds += 1
            folds.append(
                {
                    "fold": fold.number,
                    "train": compact_metrics(train_metrics),
                    "validation": compact_metrics(validation_metrics),
                }
            )
            training_trades.extend(train)
            validation_trades.extend(validation)
            training_raw_signals += train_raw
            validation_raw_signals += validation_raw

        training_summary = summarize_trades(training_trades, training_raw_signals)
        validation_summary = summarize_trades(validation_trades, validation_raw_signals)
        pf = validation_summary["stress_profit_factor"]
        gate_status: dict[str, bool] = {
            "minimum_trades": validation_summary["trades"] >= int(gates["validation_min_trades"]),
            "minimum_signal_days": validation_summary["signal_days"] >= int(gates["validation_min_signal_days"]),
            "positive_stress_folds": positive_validation_folds >= int(gates["validation_positive_stress_folds"]),
            "minimum_stress_profit_factor": pf is not None and finite(pf) >= finite(gates["validation_min_stress_profit_factor"]),
            "minimum_mean_stress_bps_per_trade": finite(validation_summary["stress_bps_per_trade"]) >= finite(gates["validation_min_mean_stress_bps_per_trade"]),
            "maximum_single_market_share": finite(validation_summary["max_single_market_trade_share"], 1.0) <= finite(gates["validation_max_single_market_trade_share"]),
        }
        results.append(
            {
                "candidate_key": candidate["key"],
                "family": candidate["family"],
                "neighbor_group": candidate["neighbor_group"],
                "folds": folds,
                "positive_validation_folds": positive_validation_folds,
                "training": compact_metrics(training_summary),
                "validation": validation_summary,
                "gates": gate_status,
            }
        )

    for result in results:
        neighbors = [
            other
            for other in results
            if other["candidate_key"] != result["candidate_key"]
            and other["neighbor_group"] == result["neighbor_group"]
        ]
        passing_neighbors = [
            other["candidate_key"]
            for other in neighbors
            if finite(other["validation"]["stress_bps"]) > 0
            and int(other["positive_validation_folds"]) >= 2
        ]
        result["gates"]["positive_neighbor"] = bool(passing_neighbors)
        result["passing_neighbors"] = passing_neighbors
        result["selection_eligible"] = all(result["gates"].values())
    return results


def report_with_hash(payload: dict[str, Any], field: str) -> dict[str, Any]:
    if field in payload:
        raise ResearchError(f"hash field already exists: {field}")
    payload[field] = sha256_json(payload)
    return payload


def verify_embedded_hash(payload: Mapping[str, Any], field: str) -> str:
    declared = payload.get(field)
    if not isinstance(declared, str):
        raise ResearchError(f"missing embedded hash: {field}")
    calculated = sha256_json({key: value for key, value in payload.items() if key != field})
    if calculated != declared:
        raise ResearchError(f"embedded hash mismatch for {field}: {declared} != {calculated}")
    return declared


def load_context(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], Schedule, list[dict[str, Any]], str]:
    prereg = load_json(Path(args.preregistration))
    universe = load_json(Path(args.candidates))
    schedule = validate_preregistration(prereg)
    candidates, universe_hash = validate_candidate_universe(prereg, universe)
    return prereg, universe, schedule, candidates, universe_hash


def discovery_report(
    prereg: Mapping[str, Any],
    schedule: Schedule,
    universe_hash: str,
    results: Sequence[Mapping[str, Any]],
    dataset: Dataset,
    preregistration_path: Path,
) -> dict[str, Any]:
    eligible_results = [result for result in results if result["selection_eligible"]]
    eligible_results.sort(
        key=lambda result: (
            -finite(result["validation"]["stress_bps"]),
            finite(result["validation"]["max_drawdown_stress_bps"], math.inf),
            str(result["candidate_key"]),
        )
    )
    eligible = [str(result["candidate_key"]) for result in eligible_results]
    report = {
        "schema_version": 1,
        "mode": "DISCOVERY_TRAIN_VALIDATION_ONLY",
        "revision": prereg["revision"],
        "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "preregistration_sha256": sha256_json(dict(prereg)),
        "preregistration_file_sha256": sha256_file(preregistration_path),
        "candidate_universe_sha256": universe_hash,
        "schedule": schedule.json(),
        "data_scope": {
            "start_inclusive": iso_utc(dataset.start_ms),
            "end_exclusive": iso_utc(dataset.end_ms),
            "final_test_data_accessed": False,
            "unused_pretest_rows_evaluated": False,
            "monthly_archive_contains_discarded_post_selection_rows": True,
        },
        "data_manifest": dataset.audit,
        "candidate_results": list(results),
        "eligible_candidates": eligible,
        "candidate_selection_priority": "validation stress bps DESC, stress max drawdown ASC, candidate key ASC",
        "recommended_lock_candidate": eligible[0] if eligible else None,
        "decision": "LOCK_ELIGIBLE_CANDIDATE" if eligible else "NO_TRADE_NO_VALIDATION_EDGE",
        "test_metrics": None,
    }
    return report_with_hash(report, "discovery_report_sha256")


def command_plan(args: argparse.Namespace) -> int:
    prereg, _, schedule, candidates, universe_hash = load_context(args)
    value = {
        "revision": prereg["revision"],
        "preregistration_sha256": sha256_json(prereg),
        "candidate_universe_sha256": universe_hash,
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "schedule": schedule.json(),
        "candidate_count": len(candidates),
        "candidate_keys": [candidate["key"] for candidate in candidates],
        "discovery_binance_months": [month.strftime("%Y-%m") for month in iter_months(schedule.data_start_ms, schedule.selection_end_ms)],
        "test_binance_months_not_accessed": [month.strftime("%Y-%m") for month in iter_months(schedule.test_start_ms, schedule.test_end_ms)],
    }
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


def command_download(args: argparse.Namespace) -> int:
    prereg, _, schedule, _, _ = load_context(args)
    guard = DataAccessGuard("DISCOVERY", schedule)
    cache = Path(args.cache_dir)
    counts: dict[str, Any] = {}
    for asset in prereg["data"]["assets"]:
        binance = load_binance_symbol(
            cache,
            f"{asset}USDT",
            schedule.data_start_ms,
            schedule.selection_end_ms,
            guard=guard,
            offline=args.offline,
        )
        upbit = load_upbit_market(
            cache,
            f"KRW-{asset}",
            schedule.data_start_ms,
            schedule.selection_end_ms,
            guard=guard,
            offline=args.offline,
            minimum_interval_seconds=args.upbit_min_interval,
        )
        counts[str(asset)] = {"binance_bars": len(binance), "upbit_traded_bars": len(upbit)}
    print(
        json.dumps(
            {
                "mode": "DISCOVERY_DOWNLOAD_ONLY",
                "final_test_data_accessed": False,
                "counts": counts,
                "data_manifest": guard.manifest(),
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
    )
    return 0


def command_discovery(args: argparse.Namespace) -> int:
    prereg, _, schedule, candidates, universe_hash = load_context(args)
    dataset = load_dataset(
        prereg,
        schedule,
        Path(args.cache_dir),
        schedule.data_start_ms,
        schedule.selection_end_ms,
        mode="DISCOVERY",
        offline=args.offline,
        upbit_interval=args.upbit_min_interval,
    )
    results = evaluate_discovery(prereg, candidates, schedule, dataset)
    report = discovery_report(
        prereg,
        schedule,
        universe_hash,
        results,
        dataset,
        Path(args.preregistration),
    )
    if args.output:
        write_json(Path(args.output), report, exclusive=True)
    else:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


def command_lock(args: argparse.Namespace) -> int:
    prereg, _, schedule, candidates, universe_hash = load_context(args)
    discovery = load_json(Path(args.discovery_report))
    discovery_hash = verify_embedded_hash(discovery, "discovery_report_sha256")
    if discovery.get("mode") != "DISCOVERY_TRAIN_VALIDATION_ONLY":
        raise ResearchError("candidate lock requires a discovery-only report")
    if discovery.get("revision") != prereg.get("revision"):
        raise ResearchError("discovery report revision mismatch")
    if discovery.get("candidate_universe_sha256") != universe_hash:
        raise ResearchError("discovery report used a different candidate universe")
    if discovery.get("preregistration_sha256") != sha256_json(prereg):
        raise ResearchError("preregistration changed after discovery")
    if discovery.get("runner_sha256") != sha256_file(Path(__file__).resolve()):
        raise ResearchError("runner changed after discovery; rerun discovery as a new lineage")
    eligible_results = [
        row
        for row in discovery.get("candidate_results", [])
        if isinstance(row, Mapping) and row.get("selection_eligible") is True
    ]
    eligible_results.sort(
        key=lambda row: (
            -finite(row["validation"]["stress_bps"]),
            finite(row["validation"]["max_drawdown_stress_bps"], math.inf),
            str(row["candidate_key"]),
        )
    )
    ranked_keys = [str(row["candidate_key"]) for row in eligible_results]
    if ranked_keys != discovery.get("eligible_candidates", []):
        raise ResearchError("discovery report candidate priority is inconsistent")
    if not ranked_keys:
        if args.candidate_key:
            raise ResearchError("no candidate passed validation; candidate key cannot be locked")
        lock = {
            "schema_version": 1,
            "revision": prereg["revision"],
            "locked_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "runner_sha256": sha256_file(Path(__file__).resolve()),
            "preregistration_sha256": sha256_json(prereg),
            "candidate_universe_sha256": universe_hash,
            "discovery_report_sha256": discovery_hash,
            "candidate_key": None,
            "candidate": None,
            "candidate_set": [],
            "locked_validation_metrics": None,
            "locked_validation_gates": None,
            "execution": prereg["execution"],
            "test_window": {
                "start_inclusive": iso_utc(schedule.test_start_ms),
                "end_exclusive": iso_utc(schedule.test_end_ms),
            },
            "decision": "NO_TRADE_NO_VALIDATION_EDGE",
            "final_test_access_required": False,
            "test_access_timestamp": None,
            "one_shot_test_required": False,
        }
        report_with_hash(lock, "candidate_lock_sha256")
        write_json(Path(args.output), lock, exclusive=True)
        print(
            json.dumps(
                {
                    "candidate_lock": str(Path(args.output).resolve()),
                    "candidate_lock_sha256": lock["candidate_lock_sha256"],
                    "decision": lock["decision"],
                },
                indent=2,
            )
        )
        return 0
    if args.no_candidate:
        raise ResearchError("at least one candidate passed validation; lock must use the deterministic top candidate")
    deterministic_top = ranked_keys[0]
    candidate_key = str(args.candidate_key or deterministic_top)
    if candidate_key != deterministic_top:
        raise ResearchError(
            f"non-top candidate lock refused: requested={candidate_key} required={deterministic_top}"
        )
    selected = next((candidate for candidate in candidates if candidate["key"] == candidate_key), None)
    if selected is None:
        raise ResearchError(f"candidate no longer exists: {candidate_key}")
    result = next(
        (row for row in discovery.get("candidate_results", []) if row.get("candidate_key") == candidate_key),
        None,
    )
    if not isinstance(result, Mapping) or result.get("selection_eligible") is not True:
        raise ResearchError("discovery eligibility record is absent or false")
    lock = {
        "schema_version": 1,
        "revision": prereg["revision"],
        "locked_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "preregistration_sha256": sha256_json(prereg),
        "candidate_universe_sha256": universe_hash,
        "discovery_report_sha256": discovery_hash,
        "candidate_key": candidate_key,
        "candidate": selected,
        "candidate_set": [candidate_key],
        "locked_validation_metrics": result["validation"],
        "locked_validation_gates": result["gates"],
        "execution": prereg["execution"],
        "test_window": {
            "start_inclusive": iso_utc(schedule.test_start_ms),
            "end_exclusive": iso_utc(schedule.test_end_ms),
        },
        "one_shot_test_required": True,
        "final_test_access_required": True,
        "test_access_timestamp": None,
    }
    report_with_hash(lock, "candidate_lock_sha256")
    write_json(Path(args.output), lock, exclusive=True)
    print(json.dumps({"candidate_lock": str(Path(args.output).resolve()), "candidate_lock_sha256": lock["candidate_lock_sha256"]}, indent=2))
    return 0


def reserve_test_access(path: Path, lock: Mapping[str, Any]) -> dict[str, Any]:
    ledger = {
        "schema_version": 1,
        "status": "RESERVED",
        "reserved_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "candidate_lock_sha256": lock["candidate_lock_sha256"],
        "candidate_key": lock["candidate_key"],
        "test_window": lock["test_window"],
        "note": "The one-shot TEST is consumed even if data retrieval or evaluation later fails.",
    }
    write_json(path, ledger, exclusive=True)
    return ledger


def command_test(args: argparse.Namespace) -> int:
    prereg, _, schedule, candidates, universe_hash = load_context(args)
    lock_path = Path(args.lock_file)
    lock = load_json(lock_path)
    lock_hash = verify_embedded_hash(lock, "candidate_lock_sha256")
    if lock.get("final_test_access_required") is not True or not lock.get("candidate_set"):
        raise ResearchError("NO_TRADE lock forbids final TEST access")
    if lock.get("revision") != prereg.get("revision"):
        raise ResearchError("candidate lock revision mismatch")
    if lock.get("runner_sha256") != sha256_file(Path(__file__).resolve()):
        raise ResearchError("runner code differs from locked implementation")
    if lock.get("preregistration_sha256") != sha256_json(prereg):
        raise ResearchError("preregistration differs from candidate lock")
    if lock.get("candidate_universe_sha256") != universe_hash:
        raise ResearchError("candidate universe differs from candidate lock")
    if lock.get("test_window") != {
        "start_inclusive": iso_utc(schedule.test_start_ms),
        "end_exclusive": iso_utc(schedule.test_end_ms),
    }:
        raise ResearchError("candidate lock test window mismatch")
    candidate_key = str(lock["candidate_key"])
    candidate = next((row for row in candidates if row["key"] == candidate_key), None)
    if candidate is None or candidate != lock.get("candidate"):
        raise ResearchError("locked candidate definition differs from universe")

    ledger_path = Path(args.test_access_ledger)
    output_path = Path(args.output)
    protected = {lock_path.resolve(), Path(args.preregistration).resolve(), Path(args.candidates).resolve()}
    if ledger_path.resolve() in protected or output_path.resolve() in protected:
        raise ResearchError("TEST ledger/output must not overwrite a locked input")
    if ledger_path.resolve() == output_path.resolve():
        raise ResearchError("TEST ledger and report paths must be distinct")
    if output_path.exists():
        raise ResearchError(f"refusing to consume TEST because output already exists: {output_path}")
    ledger = reserve_test_access(ledger_path, lock)
    try:
        warmup_start = schedule.test_start_ms - 7 * DAY_MS
        dataset = load_dataset(
            prereg,
            schedule,
            Path(args.cache_dir),
            warmup_start,
            schedule.test_end_ms,
            mode="TEST",
            offline=args.offline,
            upbit_interval=args.upbit_min_interval,
        )
        trades, raw_signals = simulate_candidate(
            candidate,
            dataset,
            schedule.test_start_ms,
            schedule.test_end_ms,
            prereg["execution"],
        )
        metrics = summarize_trades(trades, raw_signals)
        gates = prereg["promotion_gates"]
        test_gates = {
            "minimum_trades": metrics["trades"] >= int(gates["test_min_trades"]),
            "positive_stress": finite(metrics["stress_bps"]) > 0,
            "minimum_stress_profit_factor": metrics["stress_profit_factor"] is not None and finite(metrics["stress_profit_factor"]) >= finite(gates["test_min_stress_profit_factor"]),
            "maximum_single_market_share": finite(metrics["max_single_market_trade_share"], 1.0) <= finite(gates["test_max_single_market_trade_share"]),
            "cash_portfolio_marginal_value": finite(metrics["stress_bps"]) > 0 and finite(metrics["max_drawdown_stress_bps"]) <= finite(metrics["stress_bps"]),
        }
        report = {
            "schema_version": 1,
            "mode": "FINAL_TEST_ONE_SHOT",
            "revision": prereg["revision"],
            "completed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "candidate_lock_sha256": lock_hash,
            "candidate_key": candidate_key,
            "test_window": lock["test_window"],
            "warmup_start": iso_utc(warmup_start),
            "test_metrics": metrics,
            "test_gates": test_gates,
            "promotion_decision": "PROMOTION_ELIGIBLE_PENDING_IMPLEMENTATION_PARITY" if all(test_gates.values()) else "REJECT_FINAL_TEST_NO_TUNING",
            "data_manifest": dataset.audit,
            "candidate_changed_after_test": False,
        }
        report_with_hash(report, "final_test_report_sha256")
        write_json(output_path, report, exclusive=True)
        ledger.update(
            {
                "status": "COMPLETE",
                "completed_at": report["completed_at"],
                "final_test_report_sha256": report["final_test_report_sha256"],
                "output": str(output_path.resolve()),
            }
        )
        write_json(ledger_path, ledger, exclusive=False)
        print(json.dumps({"result": str(output_path.resolve()), "decision": report["promotion_decision"]}, indent=2))
        return 0
    except Exception as exc:
        ledger.update(
            {
                "status": "FAILED_TEST_CONSUMED",
                "failed_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
        write_json(ledger_path, ledger, exclusive=False)
        raise


def command_self_test(args: argparse.Namespace) -> int:
    prereg, _, schedule, candidates, universe_hash = load_context(args)
    assert len(schedule.folds) == 4
    assert schedule.folds[-1].validation_end_ms == schedule.selection_end_ms
    assert schedule.test_start_ms == epoch_ms(datetime(2025, 11, 2, tzinfo=UTC))
    assert schedule.test_end_ms == epoch_ms(datetime(2026, 1, 1, tzinfo=UTC))
    guard = DataAccessGuard("DISCOVERY", schedule)
    guard.assert_range(schedule.data_start_ms, schedule.selection_end_ms, "self-test discovery")
    try:
        guard.assert_range(schedule.test_start_ms, schedule.test_end_ms, "self-test forbidden TEST")
    except ResearchError:
        pass
    else:
        raise AssertionError("discovery guard allowed TEST")
    sample = [
        Trade("X", "F", "BTC", "LONG", 0, BAR_MS, 2 * BAR_MS - 1, "RANGE", "STABLE", "TARGET", 1, 50, 36, 27, -10, 60),
        Trade("X", "F", "ETH", "SHORT", DAY_MS, DAY_MS + BAR_MS, DAY_MS + 2 * BAR_MS - 1, "BEAR", "REBREAK", "STOP", 1, -30, -44, -53, -35, 5),
    ]
    metrics = summarize_trades(sample, 3)
    assert metrics["trades"] == 2 and metrics["raw_signals"] == 3
    assert metrics["stress_bps"] == -26 and metrics["signal_days"] == 2
    assert crosses_funding_event(
        epoch_ms(datetime(2025, 1, 1, 7, 0, tzinfo=UTC)),
        epoch_ms(datetime(2025, 1, 1, 8, 0, tzinfo=UTC)),
    )
    assert not crosses_funding_event(
        epoch_ms(datetime(2025, 1, 1, 8, 0, tzinfo=UTC)),
        epoch_ms(datetime(2025, 1, 1, 8, 30, tzinfo=UTC)),
    )
    sample_execution = dict(prereg["execution"])
    sample_execution["max_holding_bars"] = 2
    entry_time = epoch_ms(datetime(2025, 1, 1, 1, 0, tzinfo=UTC))
    gap_bars = {
        entry_time: Bar(entry_time, entry_time + BAR_MS - 1, 100, 100.5, 99.5, 100, 1, 1, 1, 0.5),
        entry_time + BAR_MS: Bar(
            entry_time + BAR_MS,
            entry_time + 2 * BAR_MS - 1,
            98,
            98.5,
            97.5,
            98,
            1,
            1,
            1,
            0.5,
        ),
    }
    gap_signal = Signal("X", "F", "BTC", entry_time - BAR_MS, entry_time, "LONG", 1, "RANGE", "STABLE", 1)
    gap_trade = execute_signal(gap_signal, gap_bars, entry_time + 3 * BAR_MS, sample_execution)
    assert gap_trade is not None and gap_trade.exit_reason == "STOP_GAP"
    assert round(gap_trade.gross_bps, 6) == -200.0
    exact = exact_upbit_bars(
        {entry_time: gap_bars[entry_time], entry_time + 2 * BAR_MS: gap_bars[entry_time + BAR_MS]},
        [entry_time, entry_time + BAR_MS, entry_time + 2 * BAR_MS],
    )
    assert entry_time + BAR_MS not in exact
    with tempfile.TemporaryDirectory() as temporary:
        ledger_path = Path(temporary) / "ledger.json"
        fake_lock = {
            "candidate_lock_sha256": "a" * 64,
            "candidate_key": "X",
            "test_window": {"start_inclusive": "x", "end_exclusive": "y"},
        }
        reserve_test_access(ledger_path, fake_lock)
        try:
            reserve_test_access(ledger_path, fake_lock)
        except ResearchError:
            pass
        else:
            raise AssertionError("one-shot ledger allowed a second reservation")
    assert len(candidates) == 24
    assert len({candidate["family"] for candidate in candidates}) == 12
    assert all(
        sum(candidate["neighbor_group"] == group for candidate in candidates) == 2
        for group in {candidate["neighbor_group"] for candidate in candidates}
    )
    candidates_by_key = {str(candidate["key"]): candidate for candidate in candidates}
    branch_feature = Feature(
        asset="SOL",
        time_ms=entry_time,
        bin_ret1_bps=-50.0,
        bin_ret4_bps=100.0,
        bin_ret96=-0.01,
        up_ret1_bps=None,
        up_ret4_bps=None,
        up_volume_z=None,
        bin_volume_z=0.0,
        bin_taker_signed=-0.2,
        atr=1.0,
        atr_bps=100.0,
        prior_rv_ratio=1.0,
        ema72h=100.0,
        trend_efficiency24h=0.1,
        vwap_deviation_atr=1.5,
        prior_bin_ret1_bps=-100.0,
        prior_bin_ret4_bps=50.0,
        prior_bin_volume_z=2.0,
        prior_atr_bps=100.0,
        close_location=0.2,
        beta_residual4_bps=50.0,
        beta_residual_percentile=0.95,
        beta_residual_rank_assets=19,
        regime="RANGE",
    )
    assert candidate_signal(candidates_by_key["V10_RANGE_VWAP_REVERSAL_A"], branch_feature)[0] == "SHORT"
    branch_feature.regime = "BEAR"
    assert candidate_signal(candidates_by_key["V10_BEAR_REBOUND_FAILURE_A"], branch_feature)[0] == "SHORT"
    branch_feature.bin_ret1_bps = 40.0
    branch_feature.close_location = 0.8
    assert candidate_signal(candidates_by_key["V10_BEAR_CAPITULATION_RECOVERY_A"], branch_feature)[0] == "LONG"
    assert candidate_signal(candidates_by_key["V10_BINANCE_BETA_RESIDUAL_A"], branch_feature)[0] == "LONG"
    print(
        json.dumps(
            {
                "ok": True,
                "revision": prereg["revision"],
                "candidate_universe_sha256": universe_hash,
                "checks": [
                    "four chronological folds",
                    "16-bar embargo",
                    "discovery rejects final TEST",
                    "candidate-universe hash",
                    "robust metric smoke",
                    "funding-event exclusion",
                    "adverse stop-gap fill",
                    "missing Upbit candle means no signal",
                    "atomic one-shot TEST ledger",
                    "twelve independent families with exactly two neighbours each",
                    "four new family side/threshold branches",
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
    )
    return 0


def add_common_arguments(parser: argparse.ArgumentParser, *, data: bool) -> None:
    parser.add_argument("--preregistration", default=str(DEFAULT_PREREGISTRATION))
    parser.add_argument("--candidates", default=str(DEFAULT_CANDIDATES))
    if data:
        parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
        parser.add_argument("--offline", action="store_true")
        parser.add_argument("--upbit-min-interval", type=float, default=0.13)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan", help="print immutable splits and hashes; no market-data access")
    add_common_arguments(plan, data=False)
    plan.set_defaults(function=command_plan)

    download = subparsers.add_parser("download", help="download discovery data only; TEST is inaccessible")
    add_common_arguments(download, data=True)
    download.set_defaults(function=command_download)

    discovery = subparsers.add_parser("discovery", help="evaluate TRAIN/VALIDATION only")
    add_common_arguments(discovery, data=True)
    discovery.add_argument("--output", help="immutable discovery report path; stdout when omitted")
    discovery.set_defaults(function=command_discovery)

    lock = subparsers.add_parser("lock", help="lock one validation-eligible candidate without reading TEST")
    add_common_arguments(lock, data=False)
    lock.add_argument("--discovery-report", required=True)
    lock_choice = lock.add_mutually_exclusive_group()
    lock_choice.add_argument("--candidate-key")
    lock_choice.add_argument("--no-candidate", action="store_true")
    lock.add_argument("--output", required=True)
    lock.set_defaults(function=command_lock)

    test = subparsers.add_parser("test", help="consume the final TEST exactly once for the locked candidate")
    add_common_arguments(test, data=True)
    test.add_argument("--lock-file", required=True)
    test.add_argument("--test-access-ledger", required=True)
    test.add_argument("--output", required=True)
    test.set_defaults(function=command_test)

    self_test = subparsers.add_parser("self-test", help="offline invariant/unit smoke")
    add_common_arguments(self_test, data=False)
    self_test.set_defaults(function=command_self_test)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.function(args))
    except ResearchError as exc:
        print(f"V10_RESEARCH_ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
