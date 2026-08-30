#!/usr/bin/env python3
"""Audited V10 R7 V3 discovery wrapper.

R7 V1 stopped before market-data evaluation because the committed source hash
did not match its protocol. R7 V2 verified the exact V1 source and its single
syntax correction, but stopped before market-data evaluation because dataclass
resolution requires dynamically executed classes to belong to a registered
module. Historical V1/V2 evidence is preserved. This wrapper makes only that
runtime-module registration correction and executes the same locked research
logic without modifying the V1 source.
"""
from __future__ import annotations

import hashlib
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "run_r7.py"
PROTOCOL = HERE / "r7-protocol-lock-v3.json"
OUT = HERE / "r7-v3-result.json"
EXPECTED_SOURCE_SHA256 = "5b8d97649d24afcadfd637f18dd63b656935336c43be88a923af7fb25ede509f"
BROKEN = 'results[candidate["key"] = {'
FIXED = 'results[candidate["key"]] = {'
MODULE_NAME = "v10_r7_audited_source_v3"


def main() -> None:
    raw = SOURCE.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(f"R7 v1 source drift: {actual}")
    text = raw.decode("utf-8")
    if text.count(BROKEN) != 1:
        raise RuntimeError("R7 audited syntax transform is not unique")
    corrected = text.replace(BROKEN, FIXED, 1)

    module = types.ModuleType(MODULE_NAME)
    module.__file__ = str(SOURCE)
    module.__package__ = ""
    sys.modules[MODULE_NAME] = module
    exec(compile(corrected, str(SOURCE), "exec"), module.__dict__)

    module.PROTOCOL = PROTOCOL
    module.OUT = OUT
    module.main()

    result = json.loads(OUT.read_text())
    result["execution_wrapper_revision"] = "V10_R7_DISCOVERY_WRAPPER_V3_20260831"
    result["source_runner_sha256"] = actual
    result["audited_transform"] = {
        "count": 1,
        "from": BROKEN,
        "to": FIXED,
    }
    result["runtime_module_registration"] = MODULE_NAME
    result["v1_market_data_accessed"] = False
    result["v2_market_data_accessed"] = False
    OUT.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


if __name__ == "__main__":
    main()
