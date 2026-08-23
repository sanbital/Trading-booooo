"""Diff the Python I46 port against the deployed market-v2-signal gate functions."""
import json, sys, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root.parent))
from short_research.engine import indicators as I
from short_research.engine.gates import detect_latest_i46, detect_latest_signal

d = json.load(open(pathlib.Path(__file__).with_name("ts_i46.json")))
to_bars = lambda rows: [I.Bar(r["time"], r["open"], r["high"], r["low"], r["close"],
                              r["volume"], r["quoteVolume"]) for r in rows]

total = mism = 0
summary = []
for name, sc in d["scenarios"].items():
    asset, bench = to_bars(sc["asset"]), to_bars(sc["bench"])
    states = I.benchmark_states(bench)
    n_ts = n_py = 0
    for row in sc["rows"]:
        prep = I.prepare_bars(asset[:row["endIndex"] + 1])
        py = detect_latest_i46("binance_futures", prep, states)
        py_side = py["side"] if py else None
        total += 1
        if py_side != row["i46_side"]:
            mism += 1
            if mism <= 5:
                print(f"  MISMATCH {name} bar {row['endIndex']}: py={py_side} ts={row['i46_side']}")
        elif py and row["i46_side"]:
            for pf, tf in (("score", "i46_score"), ("atr14", "i46_atr"),
                           ("stop_reference", "i46_stop")):
                a, b = py[pf], row[tf]
                if abs(a - b) > 1e-12 * max(1.0, abs(b)):
                    mism += 1
                    print(f"  VALUE MISMATCH {name} {pf}: {a!r} vs {b!r}")
        # P10 must stay in parity too, on the same bars
        p10 = detect_latest_signal("binance_futures", prep, states)
        if (p10["side"] if p10 else None) != row["p10_side"]:
            mism += 1
            print(f"  P10 MISMATCH {name} bar {row['endIndex']}")
        n_ts += 1 if row["i46_side"] else 0
        n_py += 1 if py_side else 0
    summary.append((name, n_ts, n_py))

print(f"bar verdicts compared: {total} (I46 and P10 on every bar)")
for name, ts_n, py_n in summary:
    print(f"  {name:12s} deployed I46 signals: {ts_n:3d}   python I46 signals: {py_n:3d}")
print(f"\nI46 GATE PARITY: {'PASS' if mism==0 else 'FAIL'} ({mism} mismatches)")
sys.exit(0 if mism == 0 else 1)
