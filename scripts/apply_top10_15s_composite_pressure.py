from pathlib import Path

patcher = Path(__file__).with_name("apply_top10_15s_composite_pressure_v3.py")
exec(compile(patcher.read_text(), str(patcher), "exec"))
