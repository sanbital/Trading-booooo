from pathlib import Path

path = Path("scripts/apply_v717_final_exit_policy.py")
text = path.read_text(encoding="utf-8")
start = text.find("# Add guarded executable net return")
end = text.find("\n\npolicy_start =", start)
if start < 0 or end < 0:
    raise SystemExit("v7.1.7 guarded-return patch block not found")
replacement = r'''# Add guarded executable net return, then enforce the exact 60/180-second policy.
text, guarded_return_count = re.subn(
    r''' + "'''" + r'''(        const guardedNetProfitQuote = .*?policyUnrecoveredCost;)''' + "'''" + r''',
    r''' + "'''" + r'''\1
        const guardedNetReturnPct = policyUnrecoveredCost > 0
          ? guardedNetProfitQuote / policyUnrecoveredCost * 100
          : 0;''' + "'''" + r''',
    text,
    count=1,
    flags=re.S,
)
if guarded_return_count != 1:
    raise SystemExit(
        f"guarded executable return: expected exactly one match, found {guarded_return_count}"
    )'''
text = text[:start] + replacement + text[end:]
path.write_text(text, encoding="utf-8")
print("aligned v7.1.7 guarded-return insertion with v7.1.6 artifact")
