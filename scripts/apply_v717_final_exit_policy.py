from pathlib import Path
import re

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text(encoding="utf-8")


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


def regex_once(pattern: str, replacement: str, label: str) -> None:
    global text
    text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")


if 'const VERSION = "7.1.7-FINAL-EXIT-POLICY";' in text:
    print("v7.1.7 final exit policy already applied")
    raise SystemExit(0)

replace_once(
    'const VERSION = "7.1.6-PROTECTED-TARGET-BALANCE-RECONCILE";',
    'const VERSION = "7.1.7-FINAL-EXIT-POLICY";',
    "engine version",
)

# LOB positions never use an exchange-resting take-profit. This guarantees that no
# bot-created sell can fill during the mandatory first-minute lock.
regex_once(
    r'''function restingTpEnabled\(settings: TradingSettings, position: Position\): boolean \{.*?\n\}''',
    '''function restingTpEnabled(settings: TradingSettings, position: Position): boolean {
  const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
  const heldSeconds = Number.isFinite(openedAt)
    ? Math.max(0, (Date.now() - openedAt) / 1000)
    : 0;
  return isScalpStrategy((settings as any).strategy) &&
    !isLobStrategy((settings as any).strategy) &&
    (settings as any).scalp_resting_tp === true &&
    !position.is_paper &&
    heldSeconds >= 60;
}''',
    "disable resting TP for LOB",
)

# Cancel any legacy LOB resting order before evaluating another exit.
replace_once(
    '''      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
''',
    '''      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
      if (lobMode && restingTpIdentifier(position)) {
        const cancelled = await cancelRestingTakeProfit(position, cycleId);
        position = cancelled.position;
        if (!cancelled.ok) {
          actions.push({
            exchange,
            market: position.market,
            action: "NONE",
            reason: "LOB resting sell cancellation unconfirmed; exit deferred",
          });
          continue;
        }
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) continue;
      }
''',
    "cancel legacy LOB resting sell",
)

# Start reversal history only after 60 seconds. Clear reversal requires at least
# 24 bad seconds inside 30 seconds and a final 10-second bad tail. Ambiguous
# invalidation requires 40 bad seconds inside 50 seconds and a final 14-second tail.
soft_start = text.find("        const softReason = exit.nextSoftReason;")
soft_end = text.find("        const softMetadataChanged =", soft_start)
if soft_start < 0 or soft_end < 0:
    raise SystemExit("soft-exit block markers not found")
new_soft = '''        const rawSoftReason = exit.nextSoftReason;
        const nowMs = Date.now();
        const monitorIntervalSeconds = clamp(
          finite((settings as any).monitor_interval_seconds, 2),
          1,
          10,
        );
        const softWindowEligible = heldSeconds >= 60 && heldSeconds < 180;
        const earliestSoftStart = Number.isFinite(openedAt) ? openedAt + 60_000 : nowMs;
        const priorHistory = Array.isArray(position.metadata?.lob_soft_exit_history)
          ? position.metadata.lob_soft_exit_history
          : [];
        let softHistory = priorHistory
          .map((sample: any) => ({
            at: finite(sample?.at),
            reason: sample?.reason === "SIGNAL_REVERSAL" || sample?.reason === "LOB_INVALIDATION"
              ? sample.reason
              : null,
          }))
          .filter((sample: any) =>
            sample.at >= earliestSoftStart && sample.at >= nowMs - 55_000 && sample.at <= nowMs
          );
        let recoveryStartedAtMs = Date.parse(
          String(position.metadata?.lob_soft_exit_recovery_started_at || ""),
        );
        if (!softWindowEligible) {
          softHistory = [];
          recoveryStartedAtMs = Number.NaN;
        } else {
          softHistory.push({ at: nowMs, reason: rawSoftReason });
          softHistory = softHistory.slice(-80);
          if (rawSoftReason === null) {
            if (!Number.isFinite(recoveryStartedAtMs)) recoveryStartedAtMs = nowMs;
            if (nowMs - recoveryStartedAtMs >= 8_000) softHistory = [];
          } else {
            recoveryStartedAtMs = Number.NaN;
          }
        }
        const qualifiesSoftWindow = (
          reason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION",
          windowSeconds: number,
          requiredBadSeconds: number,
          tailSeconds: number,
        ): boolean => {
          const samples = softHistory.filter((sample: any) =>
            sample.at >= nowMs - windowSeconds * 1000
          );
          const badRequired = Math.ceil(requiredBadSeconds / monitorIntervalSeconds);
          const tailRequired = Math.ceil(tailSeconds / monitorIntervalSeconds);
          const badCount = samples.filter((sample: any) => sample.reason === reason).length;
          const tail = samples.slice(-tailRequired);
          return badCount >= badRequired && tail.length >= tailRequired &&
            tail.every((sample: any) => sample.reason === reason);
        };
        const clearReversalQualified = softWindowEligible && qualifiesSoftWindow(
          "SIGNAL_REVERSAL",
          30,
          24,
          10,
        );
        const ambiguousReversalQualified = softWindowEligible && qualifiesSoftWindow(
          "LOB_INVALIDATION",
          50,
          40,
          14,
        );
        const softReason = softWindowEligible ? rawSoftReason : null;
        const softRequiredSeconds = softReason === "SIGNAL_REVERSAL"
          ? 30
          : softReason === "LOB_INVALIDATION"
          ? 50
          : 0;
        const softExitQualified = softReason === "SIGNAL_REVERSAL"
          ? clearReversalQualified
          : softReason === "LOB_INVALIDATION"
          ? ambiguousReversalQualified
          : false;
        const matchingSoftSamples = softReason
          ? softHistory.filter((sample: any) => sample.reason === softReason)
          : [];
        const softStartedAtMs = matchingSoftSamples.length
          ? finite(matchingSoftSamples[0].at)
          : Number.NaN;
        const softSignalAgeSeconds = Number.isFinite(softStartedAtMs)
          ? Math.max(0, (nowMs - softStartedAtMs) / 1000)
          : 0;
        const softStartedAtIso = Number.isFinite(softStartedAtMs)
          ? new Date(softStartedAtMs).toISOString()
          : null;
'''
text = text[:soft_start] + new_soft + text[soft_end:]

regex_once(
    r'''        const softMetadataChanged =.*?\n        if \(softMetadataChanged\) \{''',
    '''        const softMetadataChanged = true;
        if (softMetadataChanged) {''',
    "persist rolling soft-exit history",
)
replace_once(
    '''                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_profile_version:''',
    '''                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_history: softHistory,
                lob_soft_exit_recovery_started_at: Number.isFinite(recoveryStartedAtMs)
                  ? new Date(recoveryStartedAtMs).toISOString()
                  : null,
                lob_soft_exit_profile_version:''',
    "soft-exit telemetry",
)

# Add guarded executable net return, then enforce the exact 60/180-second policy.
policy_cost_marker = '''        const guardedNetProfitQuote = guardedExitPrice * policyQuantity *
            (1 - policyFeeRate) -
          policyEntryCost;'''
replace_once(
    policy_cost_marker,
    policy_cost_marker + '''
        const guardedNetReturnPct = policyEntryCost > 0
          ? guardedNetProfitQuote / policyEntryCost * 100
          : 0;''',
    "guarded executable return",
)

policy_start = text.find("        if (heldSeconds < 60) {")
policy_post180 = text.find("        } else if (guardedNetProfitQuote > 0) {", policy_start)
if policy_start < 0 or policy_post180 < 0:
    raise SystemExit("final policy branch markers not found")
text = text[:policy_start] + '''        if (heldSeconds < 60) {
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
''' + text[policy_post180:]

replace_once(
    '''        } else if (guardedNetProfitQuote > 0) {
          decision = {
            action: "TARGET_1",
            fraction: 1,
            reason: "lob:post-180-guarded-net-positive",
          };''',
    '''        } else if (guardedNetProfitQuote > 0) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "POSITIVE_NET_AFTER_180S",
          };''',
    "post-180 positive-net market exit",
)
replace_once(
    '        } else if (drawdownPct <= -3) {',
    '        } else if (guardedNetReturnPct <= -3) {',
    "post-180 hard-stop basis",
)
replace_once(
    '            reason: "lob:post-180-minus-3pct-stop",',
    '            reason: "HARD_STOP_MINUS_3_AFTER_180S",',
    "post-180 hard-stop reason",
)

# Central lock catches emergency, timeout, target, trail, rotation, and any future path.
replace_once(
    '      if (decision.action === "NONE") continue;\n',
    '''      if (lobMode && heldSeconds < 60 && decision.action !== "NONE") {
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
      if (decision.action === "NONE") continue;
''',
    "central first-minute exit lock",
)

# Preserve the semantic close reason even though both terminal exits deliberately use
# the market-sell STOP execution path.
replace_once(
    '''  return finalized;
}

function clearedReconciliationMetadata''',
    '''  if (
    finalized?.closed &&
    (decisionReason === "POSITIVE_NET_AFTER_180S" ||
      decisionReason === "HARD_STOP_MINUS_3_AFTER_180S")
  ) {
    const corrected = (await patch("trading_positions", `id=eq.${position.id}`, {
      close_reason: decisionReason,
      metadata: {
        ...(finalized.position?.metadata || position.metadata || {}),
        terminal_exit_reason: decisionReason,
      },
    }))[0] || finalized.position;
    finalized = { ...finalized, position: corrected };
  }
  return finalized;
}

function clearedReconciliationMetadata''',
    "terminal close reason",
)

text = text.replace(
    "7.1.6-PROTECTED-TARGET-BALANCE-RECONCILE",
    "7.1.7-FINAL-EXIT-POLICY",
)

PATH.write_text(text, encoding="utf-8")

required = [
    'const VERSION = "7.1.7-FINAL-EXIT-POLICY";',
    'EXIT_BLOCKED_MIN_HOLD',
    'POSITIVE_NET_AFTER_180S',
    'HARD_STOP_MINUS_3_AFTER_180S',
    'lob_soft_exit_history',
    'guardedNetReturnPct <= -3',
    '!isLobStrategy((settings as any).strategy)',
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("v7.1.7 validation failed: " + ", ".join(missing))
for item in required:
    print("PASS:", item)
