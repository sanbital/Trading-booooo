from pathlib import Path


PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


OLD_VERSION = "7.2.0-POST180-MINUS2-HARD-STOP"
NEW_VERSION = "7.2.2-LOB-ENTRY-RISK-GATES"

if f'const VERSION = "{NEW_VERSION}";' in text:
    print("v7.2.2 LOB entry risk gates already applied")
    raise SystemExit(0)

replace_once(
    f'const VERSION = "{OLD_VERSION}";',
    f'const VERSION = "{NEW_VERSION}";',
    "engine version",
)
replace_once(
    'strategy_revision: "7.1.9-POST180-RECOVERY-SHADOW",',
    f'strategy_revision: "{NEW_VERSION}",',
    "entry strategy revision",
)

PATH.write_text(text, encoding="utf-8")

required = [
    f'const VERSION = "{NEW_VERSION}";',
    f'strategy_revision: "{NEW_VERSION}",',
    "evaluateLobPreOrderRecheck(",
    "assessLobPreOrderPair(",
    "LOB_PREORDER_RECHECK_BLOCK",
    "HARD_STOP_MINUS_2_AFTER_180S",
    "guardedNetReturnPct <= -2",
    "lob_post180_recovery_shadow",
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("v7.2.2 validation failed: " + ", ".join(missing))
for item in required:
    print("PASS:", item)
