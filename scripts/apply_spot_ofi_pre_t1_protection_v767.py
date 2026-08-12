from pathlib import Path
import subprocess

BASE_COMMIT = "6b56712172ff4334499033734fa8018ac51783f9"
SCRIPT_PATH = "scripts/apply_spot_ofi_pre_t1_protection_v767.py"
source = subprocess.check_output(
    ["git", "show", f"{BASE_COMMIT}:{SCRIPT_PATH}"],
    text=True,
)


def script_replace(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"wrapper {label}: expected 1 match, found {count}")
    source = source.replace(old, new, 1)


script_replace(
    "'            heldSeconds,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            safetyRequested,\\n          });'",
    "futures old call",
)
script_replace(
    "'            heldSeconds,\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested,\\n          });'",
    "futures new call",
)
script_replace(
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),\\n            safetyRequested,\\n          }) as any;'",
    "spot old call",
)
script_replace(
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested,\\n          }) as any;'",
    "spot new call",
)
script_replace(
    "    if count != 1:\n        raise SystemExit(f\"{label}: expected exactly 1 old match, found {count}\")\n    return text.replace(old, new, 1)",
    "    if count < 1:\n        raise SystemExit(f\"{label}: expected at least 1 old match, found {count}\")\n    return text.replace(old, new, 1)",
    "duplicate-safe replace helper",
)

compiled = compile(source, SCRIPT_PATH, "exec")
try:
    exec(compiled, {"__name__": "__main__", "__file__": str(Path(SCRIPT_PATH).resolve())})
except BaseException as exc:
    message = str(exc).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::error file={SCRIPT_PATH},line=1::{type(exc).__name__}: {message}")
    raise
