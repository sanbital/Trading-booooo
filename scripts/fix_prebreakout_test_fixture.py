from pathlib import Path

path = Path("supabase/functions/_shared/lob/minute-entry-gate.test.ts")
text = path.read_text()
old = '''    const quiet = Math.sin(index * 1.7) * 0.012;
    const launch = index >= 38 ? (index - 37) * step : 0;
'''
new = '''    // The reference window is volatile, then compresses before a two-candle release.
    // This is a real squeeze rather than an always-flat series.
    const quietAmplitude = index < 22 ? 0.08 : 0.004;
    const quiet = Math.sin(index * 1.7) * quietAmplitude;
    const launch = index >= 42 ? (index - 41) * step : 0;
'''
if old not in text:
    if "quietAmplitude = index < 22 ? 0.08 : 0.004" in text:
        raise SystemExit(0)
    raise SystemExit("minute-entry-gate test fixture source block missing")
path.write_text(text.replace(old, new))
