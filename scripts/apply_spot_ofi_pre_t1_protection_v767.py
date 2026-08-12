from pathlib import Path
import subprocess

# Keep the original rollout patch immutable and repair only the call-site assumptions that
# differed from current main. This wrapper fails closed if any expected patch-script text
# has drifted, then executes the repaired patch in the checked-out workspace.
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


# The current engine passes a precomputed safetyRequested variable rather than repeating
# the quoteDecision expression at the policy call site.
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

# Spot wraps the executable expected profit through finite() before passing it to policy.
script_replace(
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),\\n            safetyRequested,\\n          });'",
    "spot old call",
)
script_replace(
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested: quoteDecision.action !== \"NONE\",\\n          });'",
    "'            heldSeconds,\\n            executableNetAllowed: executableQuote.allowed,\\n            expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),\\n            preT1ProfitProtectionHit: preT1ProtectionHit,\\n            safetyRequested,\\n          });'",
    "spot new call",
)

# One resting-order allow-list fragment legitimately appears twice. The original script
# replaces the first and then explicitly replaces the second, so allow the first helper
# call to proceed when the old fragment has multiple matches.
script_replace(
    "    if count != 1:\n        raise SystemExit(f\"{label}: expected exactly 1 old match, found {count}\")\n    return text.replace(old, new, 1)",
    "    if count < 1:\n        raise SystemExit(f\"{label}: expected at least 1 old match, found {count}\")\n    return text.replace(old, new, 1)",
    "duplicate-safe replace helper",
)

compiled = compile(source, SCRIPT_PATH, "exec")
exec(compiled, {"__name__": "__main__", "__file__": str(Path(SCRIPT_PATH).resolve())})
