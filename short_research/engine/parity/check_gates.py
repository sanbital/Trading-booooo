"""Diff the Python gate port against the deployed module's own per-bar verdicts."""
import json, sys, math, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
from engine import indicators as I
from engine.gates import detect_latest_signal

d = json.load(open(pathlib.Path(__file__).with_name("ts_gates.json")))

def to_bars(rows):
    return [I.Bar(r["time"], r["open"], r["high"], r["low"], r["close"],
                  r["volume"], r["quoteVolume"]) for r in rows]

total = mism = 0
detail = []
for name, sc in d["scenarios"].items():
    asset, bench = to_bars(sc["asset"]), to_bars(sc["bench"])
    states = I.benchmark_states(bench)
    n_side = n_ts = 0
    for row in sc["rows"]:
        end = row["endIndex"] + 1
        prep = I.prepare_bars(asset[:end])
        py = detect_latest_signal("binance_futures", prep, states)
        py_side = py["side"] if py else None
        total += 1
        if py_side != row["side"]:
            mism += 1
            if mism <= 5:
                print(f"  MISMATCH {name} bar {row['endIndex']}: py={py_side} ts={row['side']}")
        if py_side: n_side += 1
        if row["side"]: n_ts += 1
        if py and row["side"]:
            for pf, tf in (("score","score"),("reference_close","referenceClose"),
                           ("atr14","atr14"),("stop_reference","stopReference")):
                a, b = py[pf], row[tf]
                if abs(a-b) > 1e-12 * max(1.0, abs(b)):
                    mism += 1
                    print(f"  VALUE MISMATCH {name} {pf}: {a!r} vs {b!r}")
    detail.append((name, n_ts, n_side))

print(f"bar verdicts compared: {total}")
for name, ts_n, py_n in detail:
    print(f"  {name:14s} production signals: {ts_n:3d}   python signals: {py_n:3d}")
print(f"\nGATE PARITY: {'PASS' if mism==0 else 'FAIL'} ({mism} mismatches)")
sys.exit(0 if mism == 0 else 1)
