#!/usr/bin/env python3
from pathlib import Path

path = Path('supabase/functions/market-autotrader/index.ts')
text = path.read_text()

replacements = [
(
'''  const lateRecoveryDrawdown = decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT";\n  const staleRecoveryNetPositive = decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||\n    decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M";\n  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||\n    staleRecoveryNetPositive;''',
'''  const lateRecoveryDrawdown = decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT";\n  // Upbit v7.6.16: a pre-T1 economic floor is only protection if the order-time book can\n  // still execute the whole position above fee-net breakeven. Route this venue-specific\n  // reason through the same fresh-depth FOK guard used by positive-net recovery exits.\n  const upbitPreT1ProfitProtection = position.exchange === "upbit" &&\n    decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT";\n  const staleRecoveryNetPositive = decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||\n    decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M";\n  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||\n    staleRecoveryNetPositive || upbitPreT1ProfitProtection;'''
),
(
'''      staleRecoveryNetPositive\n        ? "STALE_RECOVERY_NET_POSITIVE_BLOCKED"\n        : lateRecoveryNetPositive\n        ? "LATE_RECOVERY_NET_POSITIVE_BLOCKED"\n        : recoveryNetPositive\n        ? "RECOVERY_NET_POSITIVE_BLOCKED"\n        : "POSITIVE_NET_AFTER_180S_BLOCKED",''',
'''      upbitPreT1ProfitProtection\n        ? "UPBIT_PRE_T1_PROFIT_PROTECTION_BLOCKED"\n        : staleRecoveryNetPositive\n        ? "STALE_RECOVERY_NET_POSITIVE_BLOCKED"\n        : lateRecoveryNetPositive\n        ? "LATE_RECOVERY_NET_POSITIVE_BLOCKED"\n        : recoveryNetPositive\n        ? "RECOVERY_NET_POSITIVE_BLOCKED"\n        : "POSITIVE_NET_AFTER_180S_BLOCKED",'''
),
(
'''      reason: staleRecoveryNetPositive\n        ? "180m recovery net-positive order-time recheck blocked; position retained"\n        : lateRecoveryNetPositive\n        ? "late-recovery net-positive order-time recheck blocked; position retained"\n        : recoveryNetPositive\n        ? "recovery net-positive order-time recheck blocked; position retained"\n        : "positive-net order-time recheck blocked; position retained",''',
'''      reason: upbitPreT1ProfitProtection\n        ? "Upbit pre-T1 protection order-time positive-net recheck blocked; position retained"\n        : staleRecoveryNetPositive\n        ? "180m recovery net-positive order-time recheck blocked; position retained"\n        : lateRecoveryNetPositive\n        ? "late-recovery net-positive order-time recheck blocked; position retained"\n        : recoveryNetPositive\n        ? "recovery net-positive order-time recheck blocked; position retained"\n        : "positive-net order-time recheck blocked; position retained",'''
),
(
'''      staleRecoveryNetPositive\n        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"\n        : lateRecoveryDrawdown''',
'''      upbitPreT1ProfitProtection\n        ? "UPBIT_PRE_T1_PROFIT_PROTECTION_FOK_NOT_FILLED"\n        : staleRecoveryNetPositive\n        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"\n        : lateRecoveryDrawdown'''
),
(
'''    const breachReason = staleRecoveryNetPositive\n      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"\n      : lateRecoveryNetPositive''',
'''    const breachReason = upbitPreT1ProfitProtection\n      ? "UPBIT_PRE_T1_PROFIT_PROTECTION_GUARD_BREACH"\n      : staleRecoveryNetPositive\n      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"\n      : lateRecoveryNetPositive'''
),
(
'''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||\n      decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||''',
'''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||\n      decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||\n      decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||'''
),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:100]!r}')
    text = text.replace(old, new, 1)

required = [
    'const upbitPreT1ProfitProtection = position.exchange === "upbit"',
    'UPBIT_PRE_T1_PROFIT_PROTECTION_BLOCKED',
    'UPBIT_PRE_T1_PROFIT_PROTECTION_FOK_NOT_FILLED',
    'UPBIT_PRE_T1_PROFIT_PROTECTION_GUARD_BREACH',
    'decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT"',
]
for needle in required:
    if needle not in text:
        raise SystemExit(f'missing invariant: {needle}')

path.write_text(text)
