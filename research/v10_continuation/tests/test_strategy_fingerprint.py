from __future__ import annotations

import copy
import unittest
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from strategy_fingerprint import IncompleteStrategyIdentity, behavioral_fingerprint


def behavior(sign_req: bool = True):
    return {
        "lane": "RANGE",
        "family": "CYCLE_RESID_MR",
        "parameters": {"lookback_h": 72, "cycle_h": 12, "threshold": 0.05, "sign_req": sign_req},
        "universe": ["ETH", "XRP", "SOL", "DOGE", "ADA", "AVAX", "LINK", "BCH", "DOT", "TRX", "NEAR", "APT", "SUI", "ETC", "XLM", "ATOM", "UNI", "ARB", "OP", "SEI"],
        "source_interval": "15m",
        "resampling": "none_for_execution; 1h_features_from_completed_15m_bars",
        "structural_regime_rule": "BTC completed-bar structural regime == RANGE",
        "tactical_entry_formula": "12h BTC cycle sign selects strongest/weakest 72h asset-minus-BTC residual; abs residual >= 0.05; sign_req explicit",
        "completed_bar_semantics": "signal at completed 15m bar, hourly schedule only",
        "entry_price_convention": "next 15m bar open",
        "exit_formula": "fixed-time close at final 15m bar",
        "hold_hours": 24,
        "ranking_rules": "single highest/lowest residual among >=12 available non-BTC assets",
        "concurrency_rules": "one event per scheduled timestamp",
        "cooldown": "24h schedule",
        "cost_model": {"base_bps_per_leg": 14, "stress_bps_per_leg": 23},
        "funding_treatment": "not modeled in historical runner",
        "asset_exposure_cap": 0.25,
    }


class StrategyFingerprintTests(unittest.TestCase):
    def test_cosmetic_rename_does_not_create_new_behavior(self) -> None:
        r4 = behavior(True)
        r5 = copy.deepcopy(r4)
        r4["candidate_key"] = "R4_RANGE_CYCLE_RESID_MR_0021"
        r5["candidate_key"] = "R5_RENAMED"
        r4["revision_sha"] = "aaa"
        r5["revision_sha"] = "bbb"
        self.assertEqual(behavioral_fingerprint(r4), behavioral_fingerprint(r5))

    def test_r6_missing_sign_req_fails_identity(self) -> None:
        r6 = behavior(True)
        del r6["parameters"]["sign_req"]
        with self.assertRaises(IncompleteStrategyIdentity):
            behavioral_fingerprint(r6)

    def test_explicit_false_is_different_behavior(self) -> None:
        self.assertNotEqual(behavioral_fingerprint(behavior(True)), behavioral_fingerprint(behavior(False)))


if __name__ == "__main__":
    unittest.main()
