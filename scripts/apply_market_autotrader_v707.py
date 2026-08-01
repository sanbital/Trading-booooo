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


# Idempotent: a workflow-generated commit runs this script once more.
if 'const VERSION = "7.1.6-FINAL-EXIT-POLICY";' in text:
    print("v7.1.6 patch already applied")
    raise SystemExit(0)

replace_once(
    'const VERSION = "7.1.4-VOLATILITY-AWARE-EXIT";',
    'const VERSION = "7.1.6-FINAL-EXIT-POLICY";',
    "version",
)

# LOB positions must never place a resting sell at entry. Such an exchange-side order
# could fill during the mandatory first-minute lock before the monitor can intervene.
place_match = re.search(
    r"async function placeRestingTakeProfit\((?s:.{0,800}?)\)\s*\{\n",
    text,
)
if not place_match:
    raise SystemExit("placeRestingTakeProfit declaration not found")
place_decl = place_match.group(0)
text = text[: place_match.end()] + (
    '  if (isLobStrategy((settings as any).strategy)) return position;\n'
) + text[place_match.end() :]

# Cancel any legacy LOB resting TP already present, then keep the ordinary resting-TP
# lifecycle only for non-LOB strategies.
old_resting = '''      if (restingTpEnabled(settings, position)) {
        position = await syncRestingTakeProfit(position, cycleId);
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) {
          actions.push({
            exchange,
            market: position.market,
            action: "TARGET_1",
            reason: "resting take-profit filled",
          });
          continue;
        }
      }
      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
'''
new_resting = '''      const scalpMode = isScalpStrategy((settings as any).strategy);
      const lobMode = isLobStrategy((settings as any).strategy);
      if (lobMode && restingTpIdentifier(position)) {
        const cancelled = await cancelRestingTakeProfit(position, cycleId);
        position = cancelled.position;
        if (!cancelled.ok) {
          actions.push({
            exchange,
            market: position.market,
            action: "NONE",
            reason: "LOB resting sell cancellation unconfirmed; all new exits deferred",
          });
          continue;
        }
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) continue;
      }
      if (!lobMode && restingTpEnabled(settings, position)) {
        position = await syncRestingTakeProfit(position, cycleId);
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) {
          actions.push({
            exchange,
            market: position.market,
            action: "TARGET_1",
            reason: "resting take-profit filled",
          });
          continue;
        }
      }
'''
replace_once(old_resting, new_resting, "resting TP monitor gate")

# Replace the old continuous timer with the approved rolling persistence model:
# clear reversal = 24 bad seconds in 30 + final 10 seconds bad;
# ambiguous invalidation = 40 bad seconds in 50 + final 14 seconds bad;
# eight seconds of normalization clears the accumulated history.
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

# Persist every rolling sample; the prior implementation only wrote when the simple
# streak changed, which is not enough for a 30/50-second rolling window.
text, count = re.subn(
    r"        const softMetadataChanged =(?s:.*?)\n        if \(softMetadataChanged\) \{",
    "        const softMetadataChanged = true;\n        if (softMetadataChanged) {",
    text,
    count=1,
)
if count != 1:
    raise SystemExit(f"softMetadataChanged replacement: found {count}")
replace_once(
    '''                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_profile_version:''',
    '''                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_history: softHistory,
                lob_soft_exit_recovery_started_at: Number.isFinite(recoveryStartedAtMs)
                  ? new Date(recoveryStartedAtMs).toISOString()
                  : null,
                lob_soft_exit_profile_version:''',
    "soft metadata",
)

# Executable net return is measured from a guarded bid estimate after both-side costs.
replace_once(
    '''        const guardedNetProfitQuote = guardedExitPrice * policyQuantity * (1 - policyFeeRate) -
          policyEntryCost;
        const drawdownPct = lobEntryPrice > 0 ? (current / lobEntryPrice - 1) * 100 : 0;''',
    '''        const guardedNetProfitQuote = guardedExitPrice * policyQuantity * (1 - policyFeeRate) -
          policyEntryCost;
        const guardedNetReturnPct = policyEntryCost > 0
          ? guardedNetProfitQuote / policyEntryCost * 100
          : 0;
        const drawdownPct = lobEntryPrice > 0 ? (current / lobEntryPrice - 1) * 100 : 0;''',
    "guarded return",
)

policy_start = text.find("        if (heldSeconds < 60) {")
policy_end = text.find("        } else if (guardedNetProfitQuote > 0) {", policy_start)
if policy_start < 0 or policy_end < 0:
    raise SystemExit("final policy branch markers not found")
new_policy = '''        if (heldSeconds < 60) {
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
text = text[:policy_start] + new_policy + text[policy_end:]
text = text.replace(
    '        } else if (guardedNetProfitQuote > 0) {\n          decision = {\n            action: "TARGET_1",\n            fraction: 1,\n            reason: "lob:post-180-guarded-net-positive",\n          };',
    '        } else if (guardedNetProfitQuote > 0) {\n          decision = {\n            action: "TARGET_1",\n            fraction: 1,\n            reason: "POSITIVE_NET_AFTER_180S",\n          };',
    1,
)
replace_once(
    '        } else if (drawdownPct <= -3) {',
    '        } else if (guardedNetReturnPct <= -3) {',
    "hard-stop basis",
)
replace_once(
    '            reason: "lob:post-180-minus-3pct-stop",',
    '            reason: "HARD_STOP_MINUS_3_AFTER_180S",',
    "hard-stop reason",
)
replace_once(
    '                  revision: "7.1.4-VOLATILITY-AWARE-EXIT",',
    '                  revision: "7.1.6-FINAL-EXIT-POLICY",',
    "policy revision",
)
replace_once(
    '''                  guarded_net_profit_quote: guardedNetProfitQuote,
                  drawdown_pct: drawdownPct,''',
    '''                  guarded_net_profit_quote: guardedNetProfitQuote,
                  guarded_net_return_pct: guardedNetReturnPct,
                  drawdown_pct: drawdownPct,''',
    "policy telemetry",
)

# Absolute centralized lock, including emergency/timeout/TP/trail paths that bypass the
# ordinary non-emergency LOB override. Only the exchange user can manually sell in minute 1.
lock_marker = '      if (decision.action === "NONE") continue;\n'
lock_code = '''      if (lobMode && heldSeconds < 60 && decision.action !== "NONE") {
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
'''
replace_once(lock_marker, lock_code, "central exit lock")

PATH.write_text(text, encoding="utf-8")
print("Applied v7.1.6 final LOB exit policy")
