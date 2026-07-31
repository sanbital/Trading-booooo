#!/usr/bin/env python3
"""Idempotent production-source guard for the LOB deployment workflow.

The reviewed source patches are already committed on main. This script verifies the
required invariants and exits without rewriting code, so a deployment rerun is safe.
"""
from pathlib import Path


def require(path: str, needle: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle not in text:
        raise SystemExit(f"{path}: required production invariant missing: {needle}")


require(
    "supabase/functions/_shared/spot-market.ts",
    "const UPBIT_MARKET = /^KRW-[A-Z0-9]{1,20}$/;",
)
require(
    "supabase/functions/_shared/spot-market.ts",
    "const BINANCE_MARKET = /^[A-Z0-9]{1,24}USDT$/;",
)
require(
    "supabase/functions/market-scanner/index.ts",
    "const topTen = heatSample.heat.slice(0, 10);",
)
require(
    "supabase/functions/market-scanner/index.ts",
    'reason: "STRICT_TOP10_NO_BACKFILL"',
)
require(
    "supabase/functions/market-scanner/index.ts",
    "const REQUIRED_PER_MARKET_OBSERVATION_MS = 45_000;",
)
require(
    "supabase/functions/_shared/lob/market-heat.ts",
    "flowHealthy: true,",
)

print("LOB deployment source invariants verified; no source rewrite required.")
