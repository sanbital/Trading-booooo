from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")

replacements = [
    (
        '      if (lobMode && !settings.emergency_liquidation && heldSeconds >= 180) {\n'
        '        // The sole post-180 sell authority is the executable-depth override below.\n'
        '        decision = { action: "NONE", fraction: 0, reason: "lob:post-180-await-executable-net" };\n'
        '      }',
        '      if (\n'
        '        lobMode && !settings.emergency_liquidation && heldSeconds >= 180 &&\n'
        '        !(finite(position.stop_price) > 0 && current <= finite(position.stop_price))\n'
        '      ) {\n'
        '        // After 180 seconds, ordinary exits still use executable-net policy. A real\n'
        '        // scanner-derived stop remains authoritative at every position age.\n'
        '        decision = { action: "NONE", fraction: 0, reason: "lob:post-180-await-executable-net" };\n'
        '      }',
    ),
    (
        '        if (heldSeconds < 180) {\n'
        '          if (plannedStopRequested) {\n'
        '            decision = {\n'
        '              action: "STOP",\n'
        '              fraction: 1,\n'
        '              reason: "lob:STOP_HIT",\n'
        '            };\n'
        '          } else if (targetRequested) {',
        '        if (plannedStopRequested) {\n'
        '          decision = {\n'
        '            action: "STOP",\n'
        '            fraction: 1,\n'
        '            reason: "lob:STOP_HIT",\n'
        '          };\n'
        '        } else if (heldSeconds < 180) {\n'
        '          if (targetRequested) {',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:120]!r}")
    text = text.replace(old, new, 1)

PATH.write_text(text, encoding="utf-8")
print(f"patched {PATH}")
