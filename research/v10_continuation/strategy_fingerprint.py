"""Canonical strategy identity for V10 research-to-production parity.

A behavioral fingerprint excludes cosmetic candidate keys and revision names so a
renamed strategy cannot be counted as independent evidence. An evidence fingerprint
adds immutable code and data lineage to the behavioral identity.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any, Mapping


class IncompleteStrategyIdentity(ValueError):
    """Raised when any behaviorally relevant field is absent."""


REQUIRED_BEHAVIOR_FIELDS = (
    "lane",
    "family",
    "parameters",
    "universe",
    "source_interval",
    "resampling",
    "structural_regime_rule",
    "tactical_entry_formula",
    "completed_bar_semantics",
    "entry_price_convention",
    "exit_formula",
    "hold_hours",
    "ranking_rules",
    "concurrency_rules",
    "cooldown",
    "cost_model",
    "funding_treatment",
    "asset_exposure_cap",
)

REQUIRED_EVIDENCE_FIELDS = (
    "behavior",
    "code_sha",
    "data_manifest_sha256",
    "revision_sha",
)


def _normalise(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, Mapping):
        return {str(k): _normalise(value[k]) for k in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_normalise(v) for v in value]
    if isinstance(value, float):
        return format(Decimal(str(value)), "f")
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    raise TypeError(f"unsupported fingerprint value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(_normalise(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_behavior(spec: Mapping[str, Any]) -> dict[str, Any]:
    missing = [field for field in REQUIRED_BEHAVIOR_FIELDS if field not in spec]
    if missing:
        raise IncompleteStrategyIdentity(f"missing behavior fields: {', '.join(missing)}")
    parameters = spec["parameters"]
    if not isinstance(parameters, Mapping):
        raise IncompleteStrategyIdentity("parameters must be a mapping")
    if spec["family"] == "CYCLE_RESID_MR" and "sign_req" not in parameters:
        raise IncompleteStrategyIdentity("CYCLE_RESID_MR identity must explicitly include sign_req")
    return {field: spec[field] for field in REQUIRED_BEHAVIOR_FIELDS}


def behavioral_fingerprint(spec: Mapping[str, Any]) -> str:
    payload = validate_behavior(spec)
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def evidence_fingerprint(record: Mapping[str, Any]) -> str:
    missing = [field for field in REQUIRED_EVIDENCE_FIELDS if field not in record]
    if missing:
        raise IncompleteStrategyIdentity(f"missing evidence fields: {', '.join(missing)}")
    behavior = validate_behavior(record["behavior"])
    payload = {
        "behavioral_fingerprint": behavioral_fingerprint(behavior),
        "code_sha": record["code_sha"],
        "data_manifest_sha256": record["data_manifest_sha256"],
        "revision_sha": record["revision_sha"],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
