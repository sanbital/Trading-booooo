from pathlib import Path

p = Path("supabase/functions/market-autotrader/futures-lane.test.ts")
text = p.read_text()
old = '  assert(STATE_MACHINE_MIGRATION.includes("p_action=\'TARGET_1\'"));\n'
if old not in text:
    raise SystemExit("semantic T1 migration assertion not found")
p.write_text(text.replace(old, ""))
print("removed incorrect migration-local TARGET_1 assertion; DB RPC is verified separately")
