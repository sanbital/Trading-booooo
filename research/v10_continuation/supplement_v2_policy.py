"""Precommitted promotion policy for the V10 RANGE 2026 supplemental OOS run."""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from validation_gates import as_decimal, asset_exposure_pass, minimum_sample_pass


def _positive(value: Any) -> bool:
    return as_decimal(value) > 0


def evaluate_main_gates(
    metrics: Mapping[str, Any],
    *,
    positive_quarters: int,
    loo: Mapping[str, Any],
) -> dict[str, bool]:
    """Evaluate the immutable user-directed supplemental gates."""
    return {
        "positive_after_stress": _positive(metrics["stress_bps"]),
        "minimum_mean_stress_20_bps": as_decimal(metrics["mean_stress_bps"]) >= Decimal("20"),
        "minimum_pf_1_15": as_decimal(metrics["stress_pf"]) >= Decimal("1.15"),
        "minimum_trades_20": minimum_sample_pass(metrics["trades"], 20),
        "positive_quarters_at_least_3": int(positive_quarters) >= 3,
        "positive_first_half": _positive(metrics["first_half_stress_bps"]),
        "positive_second_half": _positive(metrics["second_half_stress_bps"]),
        "max_asset_exposure_0_25": asset_exposure_pass(metrics["max_asset_exposure_share"], "0.25"),
        "loo_positive_share_0_90": as_decimal(loo["positive_share"]) >= Decimal("0.90"),
        "loo_median_mean_stress_15_bps": as_decimal(loo["median_mean_stress_bps"]) >= Decimal("15"),
    }


def evaluate_neighbor_gate(metrics: Mapping[str, Any], *, positive_quarters: int) -> bool:
    """Gate one predeclared threshold neighbor without LOO re-selection."""
    checks = (
        _positive(metrics["stress_bps"]),
        as_decimal(metrics["mean_stress_bps"]) >= Decimal("15"),
        as_decimal(metrics["stress_pf"]) >= Decimal("1.10"),
        minimum_sample_pass(metrics["trades"], 16),
        int(positive_quarters) >= 3,
        _positive(metrics["first_half_stress_bps"]),
        _positive(metrics["second_half_stress_bps"]),
        asset_exposure_pass(metrics["max_asset_exposure_share"], "0.25"),
    )
    return all(checks)


def evaluate_combined_rule(
    *,
    supplement_metrics: Mapping[str, Any],
    supplement_max_asset_count: int,
    main_gates_passed: bool,
    neighbor_pass_share: Any,
) -> dict[str, bool]:
    """Conservative sequential-OOS rule without rerunning the consumed R5 test.

    The consumed window had six events and a maximum observed count of two for one
    asset. For concentration, the combined rule pessimistically adds two events to
    the most frequent supplemental asset, regardless of symbol identity.
    """
    original_trades = Decimal("6")
    original_stress_bps = Decimal("969.273")
    supplement_trades = as_decimal(supplement_metrics["trades"])
    supplement_stress = as_decimal(supplement_metrics["stress_bps"])
    combined_trades = original_trades + supplement_trades
    combined_stress = original_stress_bps + supplement_stress
    combined_mean = combined_stress / combined_trades if combined_trades > 0 else Decimal("-Infinity")
    conservative_asset_share = (
        Decimal(int(supplement_max_asset_count) + 2) / combined_trades
        if combined_trades > 0
        else Decimal("Infinity")
    )
    return {
        "supplement_passes_all_locked_gates": bool(main_gates_passed),
        "threshold_neighbor_pass_share_0_75": as_decimal(neighbor_pass_share) >= Decimal("0.75"),
        "combined_minimum_trades_26": combined_trades >= Decimal("26"),
        "combined_positive_stress": combined_stress > 0,
        "combined_mean_stress_20_bps": combined_mean >= Decimal("20"),
        "combined_conservative_asset_share_0_25": conservative_asset_share <= Decimal("0.25"),
    }
