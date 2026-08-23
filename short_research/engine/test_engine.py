"""Engine tests, with future-data leakage as the first-class concern.

The strongest leakage test here is truncation equivalence: a signal computed with the
dataset cut off at bar k must equal the signal computed for bar k from the full dataset.
Any use of a later bar -- a rolling window that reaches forward, a Donchian channel that
includes the current bar, an exit that peeks at tomorrow -- breaks it.
"""
from __future__ import annotations
import json, math, pathlib, sys, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent))
from short_research.engine import indicators as I
from short_research.engine.backtest import (
    Costs, Trade, simulate_trade, generate_signals, portfolio_replay,
    round_quantity, round_price, validate_size, _funding_between, entry_triggered,
)

DEFS = json.loads((ROOT / "strategy_definitions.json").read_text())
SPECS = {s["strategy_id"]: s for s in DEFS["strategies"]}
RULES = dict(tick_size=0.0001, step_size=0.001, min_qty=0.001, min_notional=5.0)
SIZING = dict(margin_per_slot=60.0, leverage=3, max_positions=10, max_new_entries_per_scan=3)


def synth(n=400, seed=7, base=100.0, drift=0.0, vol=0.01, break_at=300, direction=-1,
          vol_scale=10.0):
    s = seed & 0xFFFFFFFF
    def rnd():
        nonlocal s
        s = (s * 1103515245 + 12345) & 0xFFFFFFFF
        return s / 4294967296
    bars, price = [], base
    for i in range(n):
        d = drift + (rnd() - 0.5) * vol
        m = 1.0
        if break_at and i >= break_at:
            d += direction * 0.0035
            m = 3.2
        o = price
        c = max(1e-6, o * (1 + d))
        up = c >= o
        h = (c if up else o) * (1 + rnd() * 0.0008)
        l = (o if up else c) * (1 - rnd() * 0.0008)
        v = (1000 + rnd() * 500) * m * vol_scale
        bars.append(I.Bar(1700000000000 + i * 3600000, o, h, l, c, v, v * c))
        price = c
    return bars


class TestNoLookahead(unittest.TestCase):
    def setUp(self):
        self.asset = synth(seed=44, direction=-1)
        self.bench = synth(seed=33, base=50000, drift=-0.0012, vol=0.004, break_at=0)
        self.ctx = {"benchmarks": {"BTCUSDT": I.benchmark_states(self.bench)},
                    "breadth": {}, "funding_at": {}, "decliner_rank": {},
                    "liquidity_percentile": {}}

    def test_truncation_equivalence_indicators(self):
        """Indicators for bar k must not change when later bars are appended."""
        full = I.prepare_bars(self.asset)
        for k in (150, 200, 275, 330, 399):
            part = I.prepare_bars(self.asset[:k + 1])
            self.assertEqual(len(part), k + 1)
            a, b = part[k], full[k]
            for f in ("ema20", "ema50", "ema100", "atr14", "rsi14", "ret24_pct",
                      "ret72_pct", "efficiency24", "high72_prev", "low72_prev",
                      "volume_ratio", "quote_volume_mean20", "ema20_slope6_pct"):
                x, y = getattr(a, f), getattr(b, f)
                if math.isnan(x) and math.isnan(y):
                    continue
                self.assertAlmostEqual(x, y, places=12, msg=f"{f} at bar {k} changed")

    def test_truncation_equivalence_signals(self):
        """A signal at bar k must be identical whether or not bars after k exist."""
        spec = SPECS["S01"]
        full = I.prepare_bars(self.asset)
        window = (full[0].time, full[-1].time)
        full_sigs = {s["signal_time"]: s for s in
                     generate_signals(spec, "T", full, self.ctx, window)}
        self.assertGreater(len(full_sigs), 0, "scenario produced no signals to test")
        for k in range(106, len(full)):
            part = I.prepare_bars(self.asset[:k + 1])
            t = part[k].time
            got = generate_signals(spec, "T", part, self.ctx, (t, t))
            expect = full_sigs.get(t)
            self.assertEqual(bool(got), bool(expect), f"signal presence differs at bar {k}")
            if got and expect:
                self.assertAlmostEqual(got[0]["reference_close"], expect["reference_close"], 12)
                self.assertAlmostEqual(got[0]["atr14"], expect["atr14"], 12)

    def test_donchian_excludes_current_bar(self):
        bars = I.prepare_bars(self.asset)
        for i in range(80, 120):
            lows = [b.low for b in bars[max(0, i - 72):i]]
            self.assertAlmostEqual(bars[i].low72_prev, min(lows), places=10,
                                   msg=f"low72_prev at {i} must exclude bar {i}")
            self.assertNotIn(bars[i].time, [], "sanity")

    def test_entry_uses_next_bar_open(self):
        spec = SPECS["S01"]
        bars = I.prepare_bars(self.asset)
        sigs = generate_signals(spec, "T", bars, self.ctx, (bars[0].time, bars[-1].time))
        self.assertTrue(sigs)
        for s in sigs:
            tr, why = simulate_trade(spec, "T", bars, s, RULES, Costs(0, 0), {},
                                     self.ctx, SIZING)
            if tr is None:
                continue
            self.assertEqual(tr.entry_time, bars[s["index"] + 1].time)
            # exchange tick rounding still applies with costs zeroed
            expect = round_price(bars[s["index"] + 1].open, RULES["tick_size"], "down")
            self.assertAlmostEqual(tr.entry_price, expect, places=9)

    def test_mfe_mae_never_gate_entry(self):
        """Rewriting bars strictly after the signal must not change the entry decision."""
        spec = SPECS["S01"]
        bars = I.prepare_bars(self.asset)
        sigs = generate_signals(spec, "T", bars, self.ctx, (bars[0].time, bars[-1].time))
        self.assertTrue(sigs)
        k = sigs[0]["index"]
        tampered = list(self.asset)
        for j in range(k + 1, len(tampered)):
            b = tampered[j]
            tampered[j] = I.Bar(b.time, b.open, b.high * 5, b.low / 5, b.close,
                                b.volume, b.quote_volume)
        re_sigs = generate_signals(spec, "T", I.prepare_bars(tampered), self.ctx,
                                   (bars[k].time, bars[k].time))
        self.assertEqual(len(re_sigs), 1)
        self.assertAlmostEqual(re_sigs[0]["reference_close"], sigs[0]["reference_close"], 12)


class TestExecution(unittest.TestCase):
    def setUp(self):
        self.bench = synth(seed=33, base=50000, drift=-0.0012, vol=0.004, break_at=0)
        self.ctx = {"benchmarks": {"BTCUSDT": I.benchmark_states(self.bench)},
                    "breadth": {}, "funding_at": {}, "decliner_rank": {},
                    "liquidity_percentile": {}}

    def _bars(self, rows):
        return I.prepare_bars(rows)

    def test_stop_before_target_in_same_bar(self):
        """A bar whose range covers both stop and target must resolve as STOP."""
        rows = synth(seed=44, direction=-1)
        bars = self._bars(rows)
        spec = json.loads(json.dumps(SPECS["S01"]))
        sigs = generate_signals(spec, "T", bars, self.ctx, (bars[0].time, bars[-1].time))
        self.assertTrue(sigs)
        s = sigs[0]
        k = s["index"] + 1
        entry_open = bars[k].open
        atr = s["atr14"]
        # widen the first exit bar so it spans stop (entry+2atr) and final target (entry-5*2atr)
        rows2 = list(rows)
        b = rows2[k]
        rows2[k] = I.Bar(b.time, b.open, entry_open + 3 * atr, entry_open - 12 * atr,
                         b.close, b.volume, b.quote_volume)
        tr, why = simulate_trade(spec, "T", self._bars(rows2), s, RULES, Costs(0, 0), {},
                                 self.ctx, SIZING)
        self.assertIsNotNone(tr, why)
        self.assertEqual(tr.exit_reason, "STOP")

    def test_costs_always_charged(self):
        rows = synth(seed=44, direction=-1)
        bars = self._bars(rows)
        spec = SPECS["S01"]
        sigs = generate_signals(spec, "T", bars, self.ctx, (bars[0].time, bars[-1].time))
        self.assertTrue(sigs)
        tr, why = simulate_trade(spec, "T", bars, sigs[0], RULES,
                                 Costs(taker_fee_pct=0.05, slippage_bps=5), {},
                                 self.ctx, SIZING)
        self.assertIsNotNone(tr, why)
        self.assertGreater(tr.fees, 0, "taker fee must be charged")
        self.assertGreater(tr.slippage_cost, 0, "slippage must be applied")
        self.assertLess(tr.net_pnl, tr.gross_pnl + tr.funding + 1e-12)

    def test_slippage_direction_is_adverse(self):
        c = Costs(taker_fee_pct=0, slippage_bps=10)
        self.assertLess(c.fill_price(100, "SHORT", opening=True), 100)   # sell lower
        self.assertGreater(c.fill_price(100, "SHORT", opening=False), 100)  # buy back higher

    def test_funding_sign_for_short(self):
        f = {"X": [(1000, 0.0001), (2000, -0.0002)]}
        self.assertAlmostEqual(_funding_between("X", 0, 1500, 10000, "SHORT", f), 1.0)
        self.assertAlmostEqual(_funding_between("X", 0, 2500, 10000, "SHORT", f), 1.0 - 2.0)
        self.assertAlmostEqual(_funding_between("X", 1500, 2500, 10000, "SHORT", f), -2.0)

    def test_quantity_rounding_and_minimums(self):
        self.assertAlmostEqual(round_quantity(1.23456, 0.001), 1.234)
        self.assertEqual(validate_size(0.0, 100, RULES), "QTY_ZERO_AFTER_ROUNDING")
        self.assertEqual(validate_size(0.0005, 100, RULES), "BELOW_MIN_QTY")
        self.assertEqual(validate_size(0.01, 100, dict(RULES, min_notional=1e9)),
                         "BELOW_MIN_NOTIONAL")
        self.assertIsNone(validate_size(1.0, 100, RULES))

    def test_entry_gap_guard(self):
        """A next-bar open that gaps away from the signal close must be refused.

        The synthetic generator opens each bar exactly at the prior close, so the gap has to
        be introduced explicitly -- otherwise the guard can never fire and the test is vacuous.
        """
        spec = SPECS["S01"]
        rows = synth(seed=44, direction=-1)
        bars = self._bars(rows)
        sigs = generate_signals(spec, "T", bars, self.ctx, (bars[0].time, bars[-1].time))
        self.assertTrue(sigs)
        s = sigs[0]
        k = s["index"] + 1
        gapped = list(rows)
        b = gapped[k]
        far = s["reference_close"] - 5 * s["atr14"]      # 5 ATR below, guard allows 0.50
        gapped[k] = I.Bar(b.time, far, max(b.high, far), min(b.low, far), b.close,
                          b.volume, b.quote_volume)
        tr, why = simulate_trade(spec, "T", self._bars(gapped), s, RULES, Costs(), {},
                                 self.ctx, SIZING)
        self.assertIsNone(tr)
        self.assertEqual(why, "ENTRY_GAP_EXCEEDED")
        # and the unmodified series, whose gap is zero, is accepted
        tr2, why2 = simulate_trade(spec, "T", bars, s, RULES, Costs(), {}, self.ctx, SIZING)
        self.assertIsNotNone(tr2, why2)


class TestPortfolio(unittest.TestCase):
    def test_slot_and_per_scan_limits(self):
        spec = SPECS["S01"]
        bench = synth(seed=33, base=50000, drift=-0.0012, vol=0.004, break_at=0)
        ctx = {"benchmarks": {"BTCUSDT": I.benchmark_states(bench)}, "breadth": {},
               "funding_at": {}, "decliner_rank": {}, "liquidity_percentile": {}}
        prepared, sigs_by = {}, {}
        for n in range(8):
            rows = synth(seed=44 + n * 7, direction=-1)
            bars = I.prepare_bars(rows)
            prepared[f"SYM{n}"] = bars
            sigs_by[f"SYM{n}"] = generate_signals(spec, f"SYM{n}", bars, ctx,
                                                  (bars[0].time, bars[-1].time))
        sizing = dict(SIZING, max_positions=2, max_new_entries_per_scan=1)
        res = portfolio_replay(spec, sigs_by, prepared,
                               {k: RULES for k in prepared}, Costs(), {}, ctx, sizing)
        by_ts = {}
        for t in res["trades"]:
            by_ts[t.signal_time] = by_ts.get(t.signal_time, 0) + 1
        for ts, c in by_ts.items():
            self.assertLessEqual(c, 1, "max_new_entries_per_scan violated")
        for t in res["trades"]:
            live = [o for o in res["trades"]
                    if o.entry_time <= t.entry_time < o.exit_time]
            self.assertLessEqual(len(live), 2, "slot cap violated")
        syms = [t.symbol for t in res["trades"]]
        for t in res["trades"]:
            overlap = [o for o in res["trades"]
                       if o.symbol == t.symbol and o is not t
                       and o.entry_time < t.exit_time and t.entry_time < o.exit_time]
            self.assertEqual(overlap, [], "two concurrent positions on one symbol")


class TestDefinitionsFrozen(unittest.TestCase):
    def test_exactly_50_and_hash_matches(self):
        import hashlib
        self.assertEqual(len(DEFS["strategies"]), 50)
        ids = [s["strategy_id"] for s in DEFS["strategies"]]
        self.assertEqual(ids, [f"S{i:02d}" for i in range(1, 51)])
        blob = (ROOT / "strategy_definitions.json").read_bytes()
        want = (ROOT / "strategy_definitions_hash.txt").read_text().split()[0]
        self.assertEqual(hashlib.sha256(blob).hexdigest(), want,
                         "frozen definitions changed after hashing")

    def test_every_strategy_has_required_fields(self):
        req = ["strategy_id", "family", "entry", "filters", "regime", "stop",
               "take_profit", "partial_exit", "trailing", "rule_exits",
               "max_holding_bars", "cooldown_bars", "same_symbol_rule",
               "conflict_rule", "expected_strength", "expected_risk"]
        for s in DEFS["strategies"]:
            for f in req:
                self.assertIn(f, s, f"{s['strategy_id']} missing {f}")

    def test_all_entry_rules_dispatch(self):
        """Every frozen entry rule must be executable, so no strategy can silently no-op."""
        rows = synth(seed=44, direction=-1)
        bars = I.prepare_bars(rows)
        for s in DEFS["strategies"]:
            try:
                entry_triggered(s, bars, 350)
            except ValueError as e:
                self.fail(f"{s['strategy_id']}: {e}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
