from pathlib import Path

path = Path("scripts/apply_v716_target_balance_hotfix.py")
text = path.read_text(encoding="utf-8")

old_primary = r'''      const lobEntryNotional = lobEntryPrice \* lobRemainingQuantity;\n      const lobExitNotional = current \* lobRemainingQuantity;\n      const lobNetProfitQuote = lobExitNotional \* \(1 - lobFeeRate\) -\n        lobEntryNotional \* \(1 \+ lobFeeRate\);'''
new_primary = r'''      const lobEntryNotional = lobEntryPrice \* lobRemainingQuantity;\n      const lobExitNotional = current \* lobRemainingQuantity;\n      const lobEntryFeeRate = exchange === \"upbit\" \? lobFeeRate : 0;\n      const lobNetProfitQuote = lobExitNotional \* \(1 - lobFeeRate\) -\n        lobEntryNotional \* \(1 \+ lobEntryFeeRate\);'''

old_policy = r'''        const policyEntryCost = lobEntryPrice \* policyQuantity \* \(1 \+ policyFeeRate\);\n        const guardedNetProfitQuote = ([^;]+?) -\n          policyEntryCost;'''
new_policy = r'''        const policyEntryCost = lobEntryPrice \* policyQuantity \*\n          \(1 \+ policyEntryFeeRate\);\n        const guardedNetProfitQuote = ([^;]+?) -\n          policyEntryCost;'''

for label, old, new in (
    ("primary post-180 exact cost", old_primary, new_primary),
    ("final policy exact cost", old_policy, new_policy),
):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one source pattern, found {count}")
    text = text.replace(old, new, 1)

old_replacement = r'''    ''' + "'''" + r'''        const policyUnrecoveredCost = exactUnrecoveredPositionCost(position);
        const guardedNetProfitQuote = \1 - policyUnrecoveredCost;''' + "'''" + r''','''
new_replacement = r'''    r''' + "'''" + r'''        const policyUnrecoveredCost = exactUnrecoveredPositionCost(position);
        const guardedNetProfitQuote = \g<1> - policyUnrecoveredCost;''' + "'''" + r''','''
count = text.count(old_replacement)
if count != 1:
    raise SystemExit(f"v7.1.6 captured-expression replacement: expected one marker, found {count}")
text = text.replace(old_replacement, new_replacement, 1)

path.write_text(text, encoding="utf-8")
print("aligned v7.1.6 patch patterns with v7.1.5 artifact")
