"""Diff the Python indicator port against the deployed p10-policy.ts.

The TypeScript harness dumps both its inputs and its outputs, so this compares the two
implementations on identical bars -- no random-number reproduction, no transcription.
"""
import json, sys, math, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import indicators as I

d = json.load(open(pathlib.Path(__file__).with_name("ts_output.json")))

def to_bars(rows):
    return [I.Bar(time=r["time"], open=r["open"], high=r["high"], low=r["low"],
                  close=r["close"], volume=r["volume"], quote_volume=r["quoteVolume"])
            for r in rows]

asset = to_bars(d["inputAsset"])
bench = to_bars(d["inputBench"])

py = I.prepare_bars(asset)
ts = d["prepared"]
assert len(py) == len(ts), (len(py), len(ts))

FIELDS = [("ema20","ema20"),("ema50","ema50"),("ema100","ema100"),
          ("ema20_slope6_pct","ema20Slope6Pct"),("atr14","atr14"),("rsi14","rsi14"),
          ("ret24_pct","ret24Pct"),("ret72_pct","ret72Pct"),
          ("efficiency24","efficiency24"),("high72_prev","high72Prev"),
          ("low72_prev","low72Prev"),("volume_ratio","volumeRatio"),
          ("quote_volume_mean20","quoteVolumeMean20")]

worst = {}
fails = 0
for i,(p,t) in enumerate(zip(py, ts)):
    assert p.time == t["time"]
    for pf, tf in FIELDS:
        a, b = getattr(p, pf), t[tf]
        if a is None or b is None: continue
        if math.isnan(a) and math.isnan(b): continue
        scale = max(1.0, abs(b))
        err = abs(a-b)/scale
        if err > worst.get(pf, (0,-1))[0]:
            worst[pf] = (err, i)
        if err > 1e-12:
            fails += 1
            if fails <= 5:
                print(f"  MISMATCH bar {i} {pf}: py={a!r} ts={b!r} relerr={err:.3e}")

print(f"prepared bars compared: {len(py)}  fields: {len(FIELDS)}  "
      f"comparisons: {len(py)*len(FIELDS)}")
print("worst relative error per field:")
for f,(e,i) in sorted(worst.items(), key=lambda kv:-kv[1][0]):
    print(f"  {f:22s} {e:.3e}  (bar {i})")

# benchmark regimes
pyb = I.benchmark_states(bench)
tsb = {r["time"]: r for r in d["benchmark"]}
assert set(pyb) == set(tsb), (len(pyb), len(tsb))
regime_bad = [t for t in pyb if pyb[t].regime != tsb[t]["regime"]]
print(f"benchmark states compared: {len(pyb)}  regime mismatches: {len(regime_bad)}")
counts = {}
for t in pyb: counts[pyb[t].regime] = counts.get(pyb[t].regime,0)+1
print("  regime distribution:", counts)

ok = fails == 0 and not regime_bad
print("\nPARITY:", "PASS" if ok else "FAIL", f"({fails} field mismatches, {len(regime_bad)} regime mismatches)")
sys.exit(0 if ok else 1)
