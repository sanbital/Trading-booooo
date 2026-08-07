from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text()
original = text

old_version = 'const VERSION = "7.5.1-RESIDUAL-TP50-SL10";'
new_version = 'const VERSION = "7.5.2-RESIDUAL-TP10-SL4";'
if old_version in text:
    text = text.replace(old_version, new_version, 1)
elif new_version not in text:
    raise SystemExit("market-autotrader VERSION anchor not found")

replacements = [
    (
        'const BURST_POLICY_VERSION = "HALF-HOLD-RESIDUAL-TP50-SL10-V2";',
        'const BURST_POLICY_VERSION = "HALF-HOLD-RESIDUAL-TP10-SL4-V3";',
    ),
    (
        '// Once that tranche is gone, the remaining inventory exits in full only when its\n'
        '// executable return reaches +50% or -10%. Time and signal exits remain disabled.',
        '// Once that tranche is gone, the remaining inventory exits in full only when its\n'
        '// executable return reaches +10% or -4%. Time and signal exits remain disabled.',
    ),
    ('decisionReason === "RESIDUAL_TAKE_PROFIT_50"', 'decisionReason === "RESIDUAL_TAKE_PROFIT_10"'),
    ('decisionReason === "RESIDUAL_STOP_LOSS_10"', 'decisionReason === "RESIDUAL_STOP_LOSS_4"'),
    ('decision.reason === "RESIDUAL_TAKE_PROFIT_50"', 'decision.reason === "RESIDUAL_TAKE_PROFIT_10"'),
    ('decision.reason === "RESIDUAL_STOP_LOSS_10"', 'decision.reason === "RESIDUAL_STOP_LOSS_4"'),
    ('if (residualNetReturnPct >= 50) {', 'if (residualNetReturnPct >= 10) {'),
    ('reason: "RESIDUAL_TAKE_PROFIT_50",', 'reason: "RESIDUAL_TAKE_PROFIT_10",'),
    ('} else if (residualNetReturnPct <= -10) {', '} else if (residualNetReturnPct <= -4) {'),
    ('reason: "RESIDUAL_STOP_LOSS_10",', 'reason: "RESIDUAL_STOP_LOSS_4",'),
    ('reason: "RESIDUAL_AWAITING_TP50_OR_SL10",', 'reason: "RESIDUAL_AWAITING_TP10_OR_SL4",'),
]

for old, new in replacements:
    if old in text:
        text = text.replace(old, new)
    elif new not in text:
        raise SystemExit(f"required anchor not found: {old}")

# Do not leave any active old residual threshold reason or policy marker behind.
for forbidden in [
    'RESIDUAL_TAKE_PROFIT_50',
    'RESIDUAL_STOP_LOSS_10',
    'RESIDUAL_AWAITING_TP50_OR_SL10',
    'HALF-HOLD-RESIDUAL-TP50-SL10-V2',
]:
    if forbidden in text:
        raise SystemExit(f"legacy residual marker still present: {forbidden}")

required = [
    new_version,
    'const BURST_POLICY_VERSION = "HALF-HOLD-RESIDUAL-TP10-SL4-V3";',
    'if (residualNetReturnPct >= 10) {',
    'reason: "RESIDUAL_TAKE_PROFIT_10",',
    '} else if (residualNetReturnPct <= -4) {',
    'reason: "RESIDUAL_STOP_LOSS_4",',
    'reason: "RESIDUAL_AWAITING_TP10_OR_SL4",',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f"required marker missing after patch: {marker}")

if text == original:
    print("Residual TP10/SL4 patch already applied")
else:
    PATH.write_text(text)
    print("Applied v7.5.2 residual TP10/SL4 patch")
