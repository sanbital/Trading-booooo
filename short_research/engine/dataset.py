"""Frozen-dataset loader and validator.

The dataset arrives from an external collector, so nothing about it is trusted until it is
checked: file hashes against the manifest, then candle completeness, duplicate timestamps,
OHLC integrity and funding sanity. A dataset that fails integrity is reported, not quietly
patched -- a silently repaired gap becomes an invented price.

Parquet is preferred; CSV of the same schema is accepted so a collector without pyarrow can
still deliver.
"""
from __future__ import annotations
import hashlib, json, math, pathlib
from dataclasses import dataclass, field

from .indicators import Bar

HOUR_MS = 3_600_000

CANDLE_COLUMNS = ["symbol", "interval", "open_time", "close_time", "open", "high", "low",
                  "close", "volume", "quote_volume", "trade_count",
                  "taker_buy_base_volume", "taker_buy_quote_volume"]
FUNDING_COLUMNS = ["symbol", "funding_time", "funding_rate"]


def sha256_file(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_table(path: pathlib.Path):
    import pandas as pd
    if path.suffix.lower() in (".parquet", ".pq"):
        return pd.read_parquet(path)
    return pd.read_csv(path)


@dataclass
class Validation:
    ok: bool = True
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def error(self, m):
        self.ok = False
        self.errors.append(m)

    def warn(self, m):
        self.warnings.append(m)


def validate_manifest(root: pathlib.Path, manifest: dict, v: Validation) -> None:
    required = ["dataset_version", "source", "exchange", "market_type",
                "primary_start_utc", "primary_end_utc", "warmup_start_utc",
                "candle_interval", "files"]
    for k in required:
        if k not in manifest:
            v.error(f"manifest missing required key: {k}")
    for f in manifest.get("files", []):
        name = f.get("filename")
        p = root / name if name else None
        if not name or not p.exists():
            v.error(f"manifest lists missing file: {name}")
            continue
        want = f.get("sha256")
        if want:
            got = sha256_file(p)
            if got != want:
                v.error(f"sha256 mismatch for {name}: manifest={want} actual={got}")
        else:
            v.warn(f"no sha256 recorded for {name}")


def validate_candles(df, interval_ms: int, v: Validation) -> dict:
    """Per-symbol completeness, duplicates and OHLC integrity."""
    missing = [c for c in CANDLE_COLUMNS if c not in df.columns]
    if missing:
        v.error(f"candles missing columns: {missing}")
        return {}
    report = {}
    dup_total = gap_total = bad_ohlc_total = 0
    for sym, g in df.groupby("symbol", sort=True):
        t = sorted(int(x) for x in g["open_time"])
        dups = len(t) - len(set(t))
        span = (t[-1] - t[0]) // interval_ms + 1 if t else 0
        gaps = max(0, span - len(set(t)))
        sub = g
        bad = int((
            (sub["high"] < sub["low"]) |
            (sub["high"] < sub["open"]) | (sub["high"] < sub["close"]) |
            (sub["low"] > sub["open"]) | (sub["low"] > sub["close"]) |
            (sub["open"] <= 0) | (sub["close"] <= 0)
        ).sum())
        dup_total += dups; gap_total += gaps; bad_ohlc_total += bad
        report[sym] = dict(bars=len(t), duplicates=dups, gaps=gaps, bad_ohlc=bad,
                           first=t[0] if t else None, last=t[-1] if t else None)
        if dups:
            v.error(f"{sym}: {dups} duplicate open_time values")
        if bad:
            v.error(f"{sym}: {bad} bars violate OHLC integrity")
        if gaps:
            v.warn(f"{sym}: {gaps} missing bars inside its own range")
    v.stats.update(symbols=len(report), duplicate_bars=dup_total,
                   missing_bars=gap_total, bad_ohlc_bars=bad_ohlc_total,
                   total_bars=int(len(df)))
    return report


def validate_funding(df, v: Validation) -> None:
    missing = [c for c in FUNDING_COLUMNS if c not in df.columns]
    if missing:
        v.error(f"funding missing columns: {missing}")
        return
    n_bad = int((df["funding_rate"].abs() > 0.05).sum())
    if n_bad:
        v.warn(f"{n_bad} funding rows have |rate| > 5%, which is implausible")
    v.stats["funding_records"] = int(len(df))
    v.stats["funding_symbols"] = int(df["symbol"].nunique())


def load(root: str | pathlib.Path) -> dict:
    """Load and validate a binance_dataset/ directory. Never raises on data problems."""
    root = pathlib.Path(root)
    v = Validation()
    manifest = json.loads((root / "manifest.json").read_text())
    validate_manifest(root, manifest, v)

    interval = manifest.get("candle_interval", "1h")
    interval_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000,
                   "1h": HOUR_MS, "4h": 4 * HOUR_MS}.get(interval, HOUR_MS)

    cpath = next((root / f["filename"] for f in manifest["files"]
                  if f["filename"].startswith("candles")), root / "candles.parquet")
    candles = _read_table(cpath)
    per_symbol = validate_candles(candles, interval_ms, v)

    funding = {}
    fpath = next((root / f["filename"] for f in manifest["files"]
                  if f["filename"].startswith("funding")), None)
    if fpath and fpath.exists():
        fdf = _read_table(fpath)
        validate_funding(fdf, v)
        for sym, g in fdf.groupby("symbol", sort=False):
            funding[sym] = sorted((int(r.funding_time), float(r.funding_rate))
                                  for r in g.itertuples())
    else:
        v.warn("no funding file supplied; funding will be treated as zero")

    exch = {}
    epath = root / "exchange_info.json"
    if epath.exists():
        raw = json.loads(epath.read_text())
        for s in raw.get("symbols", raw if isinstance(raw, list) else []):
            exch[s["symbol"]] = _rules_from_symbol(s)
    else:
        v.error("exchange_info.json missing; precision and minimums cannot be enforced")

    bars: dict[str, list[Bar]] = {}
    for sym, g in candles.groupby("symbol", sort=False):
        rows = []
        for r in g.itertuples():
            rows.append(Bar(int(r.open_time), float(r.open), float(r.high), float(r.low),
                            float(r.close), float(r.volume), float(r.quote_volume)))
        rows.sort(key=lambda b: b.time)
        bars[sym] = rows

    return dict(manifest=manifest, bars=bars, funding=funding, rules=exch,
                validation=v, per_symbol=per_symbol, interval_ms=interval_ms)


def _rules_from_symbol(s: dict) -> dict:
    out = dict(tick_size=0.0, step_size=0.0, min_qty=0.0, min_notional=0.0,
               status=s.get("status"), contract_type=s.get("contractType"),
               base=s.get("baseAsset"), quote=s.get("quoteAsset"))
    for f in s.get("filters", []):
        t = f.get("filterType")
        if t == "PRICE_FILTER":
            out["tick_size"] = float(f.get("tickSize", 0) or 0)
        elif t == "LOT_SIZE":
            out["step_size"] = float(f.get("stepSize", 0) or 0)
            out["min_qty"] = float(f.get("minQty", 0) or 0)
        elif t in ("MIN_NOTIONAL", "NOTIONAL"):
            out["min_notional"] = float(f.get("notional", f.get("minNotional", 0)) or 0)
    return out


def production_eligible(sym: str, rules: dict, bars: list[Bar]) -> tuple[bool, str]:
    """Production universe rules for binance_futures, applied to a dataset symbol."""
    if rules.get("contract_type") != "PERPETUAL":
        return False, "NOT_PERPETUAL"
    if rules.get("status") != "TRADING":
        return False, f"STATUS_{rules.get('status')}"
    if rules.get("quote") != "USDT":
        return False, f"QUOTE_{rules.get('quote')}"
    if len(bars) < 106:
        return False, "HISTORY_LT_106_BARS"
    return True, ""
