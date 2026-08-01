from pathlib import Path


PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


OLD_VERSION = "7.1.9-POST180-RECOVERY-SHADOW"
NEW_VERSION = "7.2.0-POST180-MINUS2-HARD-STOP"

if f'const VERSION = "{NEW_VERSION}";' in text:
    print("v7.2.0 post-180 minus-2 hard stop already applied")
    raise SystemExit(0)

replace_once(
    f'const VERSION = "{OLD_VERSION}";',
    f'const VERSION = "{NEW_VERSION}";',
    "engine version",
)

# Keep the post-180 positive-net exit and all pre-180 behavior unchanged.
# Only tighten the terminal post-180 executable-net hard stop from -3% to -2%.
replace_once(
    "guardedNetReturnPct <= -3",
    "guardedNetReturnPct <= -2",
    "post-180 executable-net hard-stop threshold",
)

reason_count = text.count("HARD_STOP_MINUS_3_AFTER_180S")
if reason_count < 1:
    raise SystemExit("post-180 minus-3 reason: expected at least one match")
text = text.replace(
    "HARD_STOP_MINUS_3_AFTER_180S",
    "HARD_STOP_MINUS_2_AFTER_180S",
)

# Update human-readable policy markers where present without touching unrelated
# risk settings or pre-180 reversal logic.
text = text.replace(
    "EXECUTABLE_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_3PCT",
    "EXECUTABLE_NET_POSITIVE_OR_DRAWDOWN_LTE_MINUS_2PCT",
)
text = text.replace("hard_stop_return_pct: -3", "hard_stop_return_pct: -2")
text = text.replace("hard_stop_return_pct: -3.0", "hard_stop_return_pct: -2.0")

PATH.write_text(text, encoding="utf-8")

required = [
    f'const VERSION = "{NEW_VERSION}";',
    "POSITIVE_NET_AFTER_180S",
    "HARD_STOP_MINUS_2_AFTER_180S",
    "guardedNetReturnPct <= -2",
    "lob_post180_recovery_shadow",
    'mode: "SHADOW_ONLY"',
]
forbidden = [
    "HARD_STOP_MINUS_3_AFTER_180S",
    "guardedNetReturnPct <= -3",
]
missing = [item for item in required if item not in text]
remaining = [item for item in forbidden if item in text]
if missing or remaining:
    raise SystemExit(
        "v7.2.0 validation failed; missing=" + ", ".join(missing) +
        "; remaining=" + ", ".join(remaining)
    )
for item in required:
    print("PASS:", item)
