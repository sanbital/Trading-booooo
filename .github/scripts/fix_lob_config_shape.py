from pathlib import Path

path = Path("supabase/functions/market-autotrader/index.ts")
text = path.read_text()
old = """      overrides: {
        fixedTargetBps: fixedPlanTargetBps,
        fixedStopBps: fixedPlanStopBps,
        fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,
      },"""
new = """      fixedTargetBps: fixedPlanTargetBps,
      fixedStopBps: fixedPlanStopBps,
      fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,"""

if old in text:
    path.write_text(text.replace(old, new))
elif new not in text:
    raise SystemExit("market-autotrader LOB fixed-plan configuration shape was not found")
