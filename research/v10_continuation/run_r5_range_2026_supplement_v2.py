#!/usr/bin/env python3
"""One-shot supplemental OOS for the immutable R4/R5 RANGE candidate.

This runner never reads the consumed 2025 final window. It evaluates only the
append-only superseding lock's 2026 window and cannot promote directly to live.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import run as base
import run_r3 as r3
import run_r4 as r4
from strategy_fingerprint import behavioral_fingerprint
from supplement_v2_policy import evaluate_combined_rule, evaluate_main_gates, evaluate_neighbor_gate

UTC = timezone.utc
HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / "r5-range-2026-supplement-superseding-lock.json"
OUT_PATH = HERE / "r5-range-2026-supplement-v2-result.json"
MANIFEST_PATH = HERE / "r5-range-2026-supplement-v2-data-manifest.json"
CACHE = Path("v10-cache-range-2026-supplement-v2")
MONTHLY_ROOT = "https://data.binance.vision/data/futures/um/monthly/klines"
DAILY_ROOT = "https://data.binance.vision/data/futures/um/daily/klines"
USER_AGENT = "Trading-booooo-V10-supplement-v2/1.0"
BY = {candidate["key"]: candidate for candidate in r4.CANDS}


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha256_object(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, attempts: int = 5) -> bytes:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.read()
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            last = exc
            if attempt + 1 < attempts:
                import time
                time.sleep(min(10, 2**attempt))
    raise RuntimeError(f"download failed {url}: {last}")


def download_verified(root: str, symbol: str, interval: str, filename: str) -> tuple[Path, dict[str, Any]]:
    directory = CACHE / symbol
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    base_url = f"{root}/{symbol}/{interval}/{filename}"
    checksum_url = f"{base_url}.CHECKSUM"
    expected = fetch(checksum_url).decode("utf-8", "replace").strip().split()[0].lower()
    if path.exists() and sha256_file(path) != expected:
        path.unlink()
    if not path.exists():
        data = fetch(base_url)
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise RuntimeError(f"checksum mismatch for {filename}: {actual} != {expected}")
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, path)
    actual = sha256_file(path)
    if actual != expected:
        raise RuntimeError(f"cached checksum mismatch for {filename}")
    return path, {
        "url": base_url,
        "checksum_url": checksum_url,
        "sha256": actual,
        "bytes": path.stat().st_size,
        "symbol": symbol,
        "interval": interval,
        "filename": filename,
    }


def source_plan(start: datetime, end: datetime) -> list[tuple[str, str, int, int | None]]:
    """Return monthly Jan-Jul and daily Aug 1-23 sources for the locked window."""
    if start != datetime(2026, 1, 1, tzinfo=UTC) or end != datetime(2026, 8, 24, tzinfo=UTC):
        raise RuntimeError("unexpected locked source window")
    plan: list[tuple[str, str, int, int | None]] = []
    for month in range(1, 8):
        plan.append(("monthly", "2026", month, None))
    day = date(2026, 8, 1)
    while day < date(2026, 8, 24):
        plan.append(("daily", day.isoformat(), day.month, day.day))
        day += timedelta(days=1)
    return plan


def parse_archive(path: Path, start_ms: int, end_ms: int) -> list[base.Bar]:
    rows: list[base.Bar] = []
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")]
        if len(names) != 1:
            raise RuntimeError(f"unexpected zip layout: {path}")
        with archive.open(names[0]) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8"))
            for row in reader:
                if not row or not row[0].isdigit():
                    continue
                timestamp = int(row[0])
                if timestamp > 100_000_000_000_000:
                    timestamp //= 1000
                if not start_ms <= timestamp < end_ms:
                    continue
                rows.append(base.Bar(timestamp, float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]), float(row[7]), float(row[9])))
    return rows


def load_locked_period(start: datetime, end: datetime) -> tuple[dict[str, list[base.Bar]], dict[str, Any]]:
    tasks: list[tuple[str, str, str, str]] = []
    for asset in base.ASSETS:
        symbol = f"{asset}USDT"
        for kind, label, month, day in source_plan(start, end):
            if kind == "monthly":
                filename = f"{symbol}-15m-2026-{month:02d}.zip"
                tasks.append((asset, MONTHLY_ROOT, symbol, filename))
            else:
                assert day is not None
                filename = f"{symbol}-15m-2026-08-{day:02d}.zip"
                tasks.append((asset, DAILY_ROOT, symbol, filename))
    paths: dict[tuple[str, str], Path] = {}
    entries: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = {
            executor.submit(download_verified, root, symbol, "15m", filename): (asset, filename)
            for asset, root, symbol, filename in tasks
        }
        for future in as_completed(futures):
            asset, filename = futures[future]
            path, entry = future.result()
            paths[(asset, filename)] = path
            entries.append(entry)
    start_ms, end_ms = base.ms(start), base.ms(end)
    bars: dict[str, list[base.Bar]] = {}
    for asset in base.ASSETS:
        symbol = f"{asset}USDT"
        rows: list[base.Bar] = []
        for kind, label, month, day in source_plan(start, end):
            filename = (
                f"{symbol}-15m-2026-{month:02d}.zip"
                if kind == "monthly"
                else f"{symbol}-15m-2026-08-{int(day):02d}.zip"
            )
            rows.extend(parse_archive(paths[(asset, filename)], start_ms, end_ms))
        rows.sort(key=lambda bar: bar.ts)
        if len(rows) < 10_000:
            raise RuntimeError(f"insufficient bars for {asset}: {len(rows)}")
        timestamps = [bar.ts for bar in rows]
        if len(timestamps) != len(set(timestamps)):
            raise RuntimeError(f"duplicate bars for {asset}")
        bars[asset] = rows
    entries.sort(key=lambda item: (item["symbol"], item["filename"]))
    manifest = {
        "schema_version": 1,
        "source": "Binance Data Vision USD-M Futures",
        "interval": "15m",
        "window": [start.isoformat(), end.isoformat()],
        "entries": entries,
        "entry_count": len(entries),
        "manifest_sha256": sha256_object(entries),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    return bars, manifest


def asset_counts(trades: list[Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for trade in trades:
        for asset, _side, _pnl in trade.legs:
            counts[asset] += 1
    return counts


def candidate_behavior() -> dict[str, Any]:
    return {
        "lane": "RANGE",
        "family": "CYCLE_RESID_MR",
        "parameters": {"lookback_h": 72, "cycle_h": 12, "threshold": 0.05, "sign_req": True},
        "universe": ["ETH", "XRP", "SOL", "DOGE", "ADA", "AVAX", "LINK", "BCH", "DOT", "TRX", "NEAR", "APT", "SUI", "ETC", "XLM", "ATOM", "UNI", "ARB", "OP", "SEI"],
        "source_interval": "15m",
        "resampling": "none; signal evaluated hourly on completed 15m bars",
        "structural_regime_rule": "BTC RANGE iff abs(ret24)<=0.02 and efficiency24<=0.35 and breadth_positive_share in [0.30,0.70]",
        "tactical_entry_formula": "if BTC 12h return>=0 short max 72h asset-minus-BTC residual; if BTC 12h return<0 long min residual; abs residual>=0.05 and selected asset raw 72h return sign matches cycle side",
        "completed_bar_semantics": "signal on completed 15m bar at minute=0 and UTC hour modulo 24=0",
        "entry_price_convention": "next 15m bar open",
        "exit_formula": "fixed 24h holding exit at close of final 15m bar",
        "hold_hours": 24,
        "ranking_rules": "one extreme residual among at least 12 available non-BTC assets",
        "concurrency_rules": "at most one lane event per scheduled timestamp; 24h schedule prevents overlap",
        "cooldown": "24h",
        "cost_model": {"base_bps_per_leg": 14, "stress_bps_per_leg": 23},
        "funding_treatment": "not modeled; remains a live-release blocker",
        "asset_exposure_cap": 0.25,
    }


def main() -> None:
    lock = json.loads(LOCK_PATH.read_text())
    start = datetime.fromisoformat(lock["evaluation_window"][0])
    end = datetime.fromisoformat(lock["evaluation_window"][1])
    if lock.get("immutable_after_commit") is not True or lock.get("parameter_mutation_allowed") is not False:
        raise RuntimeError("lock is not immutable/fail-closed")
    if lock.get("test_accessed_before_lock") is not False:
        raise RuntimeError("supplement was not certified untouched")
    if sha256_file(Path(__file__)) != lock["runner_sha256"]:
        raise RuntimeError("runner SHA mismatch")
    if behavioral_fingerprint(candidate_behavior()) != lock["strategy_behavioral_fingerprint"]:
        raise RuntimeError("strategy fingerprint mismatch")
    candidate = BY.get(lock["locked_candidate_key"])
    if candidate is None or candidate != lock["candidate"]:
        raise RuntimeError("candidate payload mismatch")
    if sha256_object(candidate) != lock["candidate_payload_sha256"]:
        raise RuntimeError("candidate payload SHA mismatch")

    base.CACHE = CACHE
    r3.base.CACHE = CACHE
    bars, manifest = load_locked_period(start, end)
    features, indices = base.build_features(bars)
    trades, metrics = r4.eval_c(candidate, base.ms(start), base.ms(end), bars, features, indices)
    period = r4.period_eval(candidate, start, end, bars, features, indices)
    loo = r4.loo(candidate, start, end, bars, features, indices)
    counts = asset_counts(trades)
    main_gates = evaluate_main_gates(metrics, positive_quarters=period["positive_quarters"], loo=loo)

    neighbor_rows = []
    for threshold in lock["threshold_neighbors"]:
        neighbor = dict(candidate)
        neighbor["key"] = f"SUPPLEMENT_V2_NEIGHBOR_{threshold}"
        neighbor["threshold"] = float(threshold)
        neighbor_period = r4.period_eval(neighbor, start, end, bars, features, indices)
        neighbor_metrics = neighbor_period["metrics"]
        passed = evaluate_neighbor_gate(neighbor_metrics, positive_quarters=neighbor_period["positive_quarters"])
        neighbor_rows.append({
            "threshold": threshold,
            "metrics": neighbor_metrics,
            "positive_quarters": neighbor_period["positive_quarters"],
            "passed": passed,
        })
    neighbor_pass_share = sum(row["passed"] for row in neighbor_rows) / len(neighbor_rows)
    combined = evaluate_combined_rule(
        supplement_metrics=metrics,
        supplement_max_asset_count=max(counts.values(), default=0),
        main_gates_passed=all(main_gates.values()),
        neighbor_pass_share=neighbor_pass_share,
    )
    passed = all(main_gates.values()) and all(combined.values())
    decision = (
        "ELIGIBLE_FOR_CONTROLLED_SHADOW_CANARY_REVIEW_ONLY"
        if passed
        else "PERMANENTLY_REJECT_CURRENT_R4_R5_RANGE_MECHANISM"
    )
    result = {
        "schema_version": 1,
        "revision": "V10_R5_RANGE_2026_SUPPLEMENT_V2_20260830",
        "test_accessed": True,
        "window": [start.isoformat(), end.isoformat()],
        "github": {
            "run_id": os.getenv("GITHUB_RUN_ID"),
            "run_attempt": os.getenv("GITHUB_RUN_ATTEMPT"),
            "commit_sha": os.getenv("GITHUB_SHA"),
            "workflow": os.getenv("GITHUB_WORKFLOW"),
        },
        "lock_sha256": sha256_file(LOCK_PATH),
        "runner_sha256": sha256_file(Path(__file__)),
        "strategy_behavioral_fingerprint": behavioral_fingerprint(candidate_behavior()),
        "candidate": candidate,
        "source_data": {
            "manifest_file": MANIFEST_PATH.name,
            "manifest_sha256": manifest["manifest_sha256"],
            "entry_count": manifest["entry_count"],
        },
        "metrics": metrics,
        "positive_quarters": period["positive_quarters"],
        "quarters": period["quarters"],
        "loo": loo,
        "asset_event_counts": dict(sorted(counts.items())),
        "main_gates": main_gates,
        "threshold_neighbors": neighbor_rows,
        "threshold_neighbor_pass_share": round(neighbor_pass_share, 4),
        "combined_sequential_oos_rule": combined,
        "passed": passed,
        "decision": decision,
        "automatic_live_release_allowed": False,
        "original_final_test_verdict_changed": False,
        "consumed_2025_final_test_rerun": False,
    }
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    print("V10_RANGE_SUPPLEMENT_V2_BEGIN")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    print("V10_RANGE_SUPPLEMENT_V2_END")


if __name__ == "__main__":
    main()
