#!/usr/bin/env python3
"""Audited V10 R7 discovery wrapper.

The first R7 workflow stopped before any market-data evaluation because the
committed source hash did not match its protocol and the source contained one
syntax typo.  Historical evidence is preserved.  This wrapper verifies the
exact v1 source bytes, applies one predeclared textual correction in memory,
uses the superseding immutable v2 protocol, and executes the same research
logic without modifying the v1 source file.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "run_r7.py"
PROTOCOL = HERE / "r7-protocol-lock-v2.json"
OUT = HERE / "r7-v2-result.json"
EXPECTED_SOURCE_SHA256 = "5b8d97649d24afcadfd637f18dd63b656935336c43be88a923af7fb25ede509f"
BROKEN = 'results[candidate["key"] = {'
FIXED = 'results[candidate["key"]] = {'


def main() -> None:
    raw = SOURCE.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(f"R7 v1 source drift: {actual}")
    text = raw.decode("utf-8")
    if text.count(BROKEN) != 1:
        raise RuntimeError("R7 audited syntax transform is not unique")
    corrected = text.replace(BROKEN, FIXED, 1)
    namespace: dict[str, Any] = {
        "__name__": "v10_r7_audited_source",
        "__file__": str(SOURCE),
    }
    exec(compile(corrected, str(SOURCE), "exec"), namespace)
    namespace["PROTOCOL"] = PROTOCOL
    namespace["OUT"] = OUT
    namespace["main"]()


if __name__ == "__main__":
    main()
