from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from supplement_v2_policy import evaluate_combined_rule, evaluate_main_gates, evaluate_neighbor_gate


GOOD = {
    "stress_bps": 1000,
    "mean_stress_bps": 40,
    "stress_pf": 1.4,
    "trades": 25,
    "first_half_stress_bps": 400,
    "second_half_stress_bps": 600,
    "max_asset_exposure_share": 0.2,
}


class SupplementPolicyTests(unittest.TestCase):
    def test_main_gate_is_fail_closed_at_asset_03333(self) -> None:
        metrics = dict(GOOD, max_asset_exposure_share=0.3333)
        gates = evaluate_main_gates(metrics, positive_quarters=4, loo={"positive_share": 0.95, "median_mean_stress_bps": 20})
        self.assertFalse(gates["max_asset_exposure_0_25"])
        self.assertFalse(all(gates.values()))

    def test_exact_main_gate_pass(self) -> None:
        gates = evaluate_main_gates(GOOD, positive_quarters=3, loo={"positive_share": 0.9, "median_mean_stress_bps": 15})
        self.assertTrue(all(gates.values()))

    def test_neighbor_requires_16_trades_and_25_percent_cap(self) -> None:
        self.assertTrue(evaluate_neighbor_gate(GOOD, positive_quarters=3))
        self.assertFalse(evaluate_neighbor_gate(dict(GOOD, trades=15), positive_quarters=3))
        self.assertFalse(evaluate_neighbor_gate(dict(GOOD, max_asset_exposure_share=0.2501), positive_quarters=3))

    def test_combined_rule_pessimistically_adds_two_asset_events(self) -> None:
        result = evaluate_combined_rule(
            supplement_metrics=GOOD,
            supplement_max_asset_count=5,
            main_gates_passed=True,
            neighbor_pass_share=0.75,
        )
        self.assertTrue(all(result.values()))
        fail = evaluate_combined_rule(
            supplement_metrics=dict(GOOD, trades=20),
            supplement_max_asset_count=5,
            main_gates_passed=True,
            neighbor_pass_share=0.75,
        )
        self.assertFalse(fail["combined_conservative_asset_share_0_25"])


if __name__ == "__main__":
    unittest.main()
