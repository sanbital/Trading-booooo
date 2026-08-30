"""Fail-closed validation gates shared by V10 research/audit runners.

The module deliberately avoids epsilon-based comparisons for immutable release gates.
JSON metrics used for release decisions should be loaded with ``parse_float=Decimal``.
"""
from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


class GateInputError(ValueError):
    """Raised when a gate input cannot be represented deterministically."""


def as_decimal(value: Any) -> Decimal:
    """Convert a scalar to Decimal without a release-gate tolerance.

    Strings and Decimal values are preferred. Float conversion uses ``str(value)`` so
    ``math.nextafter`` values remain distinguishable from their nominal boundary.
    Booleans and non-finite values fail closed.
    """
    if isinstance(value, bool):
        raise GateInputError("boolean is not a numeric gate input")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, (str, int, float)):
        try:
            result = Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise GateInputError(f"invalid decimal input: {value!r}") from exc
    else:
        raise GateInputError(f"unsupported decimal input type: {type(value).__name__}")
    if not result.is_finite():
        raise GateInputError("non-finite gate input")
    return result


def load_json_decimal(path: str | Path) -> Any:
    """Load JSON while preserving every decimal token exactly."""
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle, parse_float=Decimal, parse_int=Decimal)


def asset_exposure_pass(exposure_share: Any, cap: Any = "0.25") -> bool:
    """Return True only when exposure is non-negative and no greater than the cap."""
    exposure = as_decimal(exposure_share)
    maximum = as_decimal(cap)
    if maximum < 0 or exposure < 0:
        return False
    return exposure <= maximum


def minimum_sample_pass(trades: Any, minimum: Any) -> bool:
    """Exact integer sample gate."""
    observed = as_decimal(trades)
    required = as_decimal(minimum)
    if observed != observed.to_integral_value() or required != required.to_integral_value():
        raise GateInputError("trade counts must be integers")
    return observed >= required >= 0
