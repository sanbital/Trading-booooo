from __future__ import annotations

import json
import math
import unittest
from decimal import Decimal
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from validation_gates import asset_exposure_pass, minimum_sample_pass


class AssetExposureGateTests(unittest.TestCase):
    def test_boundary_passes(self) -> None:
        self.assertTrue(asset_exposure_pass(Decimal("0.25"), Decimal("0.25")))

    def test_any_decimal_above_boundary_fails(self) -> None:
        self.assertFalse(asset_exposure_pass(Decimal("0.2500000000000000001"), Decimal("0.25")))

    def test_next_float_above_boundary_fails(self) -> None:
        self.assertFalse(asset_exposure_pass(math.nextafter(0.25, math.inf), 0.25))

    def test_historical_03333_fails(self) -> None:
        self.assertFalse(asset_exposure_pass("0.3333", "0.25"))

    def test_historical_fixture_is_corrected_fail_closed(self) -> None:
        fixture = json.loads((HERE / "fixtures" / "r5_r6_consumed_test.json").read_text())
        for revision, row in fixture["historical_results"].items():
            with self.subTest(revision=revision):
                self.assertFalse(asset_exposure_pass(row["max_asset_exposure_share"], fixture["expected_cap"]))
                self.assertFalse(minimum_sample_pass(row["trades"], 8))


if __name__ == "__main__":
    unittest.main()
