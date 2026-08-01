from pathlib import Path

path = Path("scripts/apply_v717_final_exit_policy.py")
text = path.read_text(encoding="utf-8")
old = '''policy_cost_marker = \'\'\'        const guardedNetProfitQuote = guardedExitPrice * policyQuantity *
            (1 - policyFeeRate) -
          policyEntryCost;\'\'\''''
new = '''policy_cost_marker = \'\'\'        const guardedNetProfitQuote = guardedExitPrice * policyQuantity *
            (1 - policyFeeRate) -
          policyUnrecoveredCost;\'\'\''''
count = text.count(old)
if count != 1:
    raise SystemExit(f"v7.1.7 guarded cost compatibility: expected one marker, found {count}")
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("aligned v7.1.7 guarded-cost marker with v7.1.6 artifact")
