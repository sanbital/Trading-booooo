from pathlib import Path

root = Path(__file__).resolve().parents[1]
entry = root / "supabase/functions/_shared/lob/entry.ts"
marker = "COMPOSITE-PRESSURE-V1"

if marker in entry.read_text():
    print("7.3.7-15S-TOP10-COMPOSITE-PRESSURE source already applied")
else:
    patcher = Path(__file__).with_name("apply_top10_15s_composite_pressure_v3.py")
    exec(compile(patcher.read_text(), str(patcher), "exec"))
