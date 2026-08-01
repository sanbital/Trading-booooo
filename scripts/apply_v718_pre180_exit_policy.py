from pathlib import Path


PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


NEW_VERSION = "7.1.8-PRE180-TARGET-REVERSAL"
if f'const VERSION = "{NEW_VERSION}";' in text:
    print("v7.1.8 pre-180 exit policy already applied")
    raise SystemExit(0)

replace_once(
    'const VERSION = "7.1.7-FINAL-EXIT-POLICY";',
    f'const VERSION = "{NEW_VERSION}";',
    "engine version",
)

# Reversal evidence begins at entry. Before 180 seconds, a protected target or one
# of the two explicitly qualified rolling LOB reversals may exit the position.
replace_once(
    "        const softWindowEligible = heldSeconds >= 60 && heldSeconds < 180;",
    "        const softWindowEligible = heldSeconds < 180;",
    "pre-180 reversal observation window",
)
replace_once(
    "        const earliestSoftStart = Number.isFinite(openedAt) ? openedAt + 60_000 : nowMs;",
    "        const earliestSoftStart = Number.isFinite(openedAt) ? openedAt : nowMs;",
    "reversal history start",
)

old_policy = '''        if (heldSeconds < 60) {
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "EXIT_BLOCKED_MIN_HOLD",
          };
        } else if (heldSeconds < 180) {
          if (reversalRequested && reversalQualified) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: requestedReason,
            };
          } else {
            decision = {
              action: "NONE",
              fraction: 0,
              reason: "lob:60-180-hold-unless-qualified-reversal",
            };
          }
'''
new_policy = '''        if (heldSeconds < 180) {
          if (targetRequested) {
            decision = {
              action: "TARGET_1",
              fraction: 1,
              reason: "lob:pre-180-target",
            };
          } else if (reversalRequested && reversalQualified) {
            decision = {
              action: "STOP",
              fraction: 1,
              reason: requestedReason,
            };
          } else {
            decision = {
              action: "NONE",
              fraction: 0,
              reason: "lob:pre-180-hold-unless-target-or-qualified-reversal",
            };
          }
'''
replace_once(old_policy, new_policy, "pre-180 target and reversal policy")

old_central_lock = '''      if (lobMode && heldSeconds < 60 && decision.action !== "NONE") {
        await event(
          "EXIT_BLOCKED_MIN_HOLD",
          `${exchange}:${position.market} automatic exit blocked during first 60 seconds`,
          {
            held_seconds: heldSeconds,
            blocked_action: decision.action,
            blocked_reason: (decision as any).reason || null,
            current_price: current,
          },
          { cycleId, positionId: position.id, level: "INFO" },
        );
        decision = { action: "NONE", fraction: 0, reason: "EXIT_BLOCKED_MIN_HOLD" } as any;
      }
'''
new_central_guard = '''      if (lobMode && heldSeconds < 180 && decision.action !== "NONE") {
        const approvedPre180Target = decision.action === "TARGET_1" ||
          decision.action === "TARGET_2";
        const approvedPre180Reversal = decision.action === "STOP" &&
          ((decision as any).reason === "lob:SIGNAL_REVERSAL" ||
            (decision as any).reason === "lob:LOB_INVALIDATION") &&
          Boolean(position.metadata?.lob_soft_exit_qualified);
        if (!approvedPre180Target && !approvedPre180Reversal) {
          await event(
            "EXIT_BLOCKED_PRE180_POLICY",
            `${exchange}:${position.market} exit was not an approved target or qualified reversal`,
            {
              held_seconds: heldSeconds,
              blocked_action: decision.action,
              blocked_reason: (decision as any).reason || null,
              current_price: current,
            },
            { cycleId, positionId: position.id, level: "WARNING" },
          );
          decision = {
            action: "NONE",
            fraction: 0,
            reason: "EXIT_BLOCKED_PRE180_POLICY",
          } as any;
        }
      }
'''
replace_once(old_central_lock, new_central_guard, "pre-180 exit safety guard")

text = text.replace("7.1.7-FINAL-EXIT-POLICY", NEW_VERSION)
PATH.write_text(text, encoding="utf-8")

required = [
    f'const VERSION = "{NEW_VERSION}";',
    "const softWindowEligible = heldSeconds < 180;",
    'reason: "lob:pre-180-target"',
    'reason: "lob:pre-180-hold-unless-target-or-qualified-reversal"',
    "EXIT_BLOCKED_PRE180_POLICY",
    "POSITIVE_NET_AFTER_180S",
    "HARD_STOP_MINUS_3_AFTER_180S",
    "guardedNetReturnPct <= -3",
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("v7.1.8 validation failed: " + ", ".join(missing))
if "EXIT_BLOCKED_MIN_HOLD" in text:
    raise SystemExit("v7.1.8 validation failed: obsolete first-minute lock remains")
for item in required:
    print("PASS:", item)
