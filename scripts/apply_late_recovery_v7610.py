from pathlib import Path

INDEX = Path("supabase/functions/market-autotrader/index.ts")
POLICY = Path("supabase/functions/market-autotrader/late-recovery-policy.ts")
TEST = Path("supabase/functions/market-autotrader/late-recovery-policy.test.ts")

source = INDEX.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source match, found {count}")
    source = source.replace(old, new, 1)


# 1) Import the isolated late-recovery policy. Existing spot/futures policy modules remain
# authoritative; the new gate is only consulted after they return NONE.
replace_once(
    '''} from "./futures-exit-policy.ts";
import { buildTradingHeartbeatPatch, type TradingHeartbeatPatch } from "./heartbeat.ts";
''',
    '''} from "./futures-exit-policy.ts";
import {
  LATE_RECOVERY_THRESHOLDS,
  lateRecoveryDecision,
  updatePost180RunningTrough,
} from "./late-recovery-policy.ts";
import { buildTradingHeartbeatPatch, type TradingHeartbeatPatch } from "./heartbeat.ts";
''',
    "late-recovery import",
)

# 2) Teach the shared exit executor about the two new terminal reasons. Net-positive exits
# keep the existing order-time FOK re-quote; drawdown-recovery exits intentionally use the
# ordinary full market-exit path because accepting the recovered loss is the policy goal.
replace_once(
    '''  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";
  const recoveryNetPositive = decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT";
  const staleRecoveryNetPositive = decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
    decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M";
  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||
    staleRecoveryNetPositive;
''',
    '''  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";
  const recoveryNetPositive = decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT";
  const lateRecoveryNetPositive = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT";
  const lateRecoveryDrawdown = decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT";
  const staleRecoveryNetPositive = decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
    decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M";
  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||
    lateRecoveryNetPositive || staleRecoveryNetPositive;
''',
    "applyExit late-recovery flags",
)
replace_once(
    '''    staleRecoveryNetPositive || recoveryNetPositive || action === "EMERGENCY";
''',
    '''    staleRecoveryNetPositive || recoveryNetPositive || lateRecoveryNetPositive ||
    lateRecoveryDrawdown || action === "EMERGENCY";
''',
    "full-liquidation allow list",
)
replace_once(
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_BLOCKED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_BLOCKED"
        : "POSITIVE_NET_AFTER_180S_BLOCKED",
''',
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_BLOCKED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_BLOCKED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_BLOCKED"
        : "POSITIVE_NET_AFTER_180S_BLOCKED",
''',
    "order-time positive-net blocked event",
)
replace_once(
    '''      reason: staleRecoveryNetPositive
        ? "180m recovery net-positive order-time recheck blocked; position retained"
        : recoveryNetPositive
        ? "recovery net-positive order-time recheck blocked; position retained"
        : "positive-net order-time recheck blocked; position retained",
''',
    '''      reason: staleRecoveryNetPositive
        ? "180m recovery net-positive order-time recheck blocked; position retained"
        : lateRecoveryNetPositive
        ? "late-recovery net-positive order-time recheck blocked; position retained"
        : recoveryNetPositive
        ? "recovery net-positive order-time recheck blocked; position retained"
        : "positive-net order-time recheck blocked; position retained",
''',
    "order-time positive-net retained reason",
)
replace_once(
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : positiveNetAfter180
        ? "POSITIVE_NET_AFTER_180S_FOK_NOT_FILLED"
''',
    '''      staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : positiveNetAfter180
        ? "POSITIVE_NET_AFTER_180S_FOK_NOT_FILLED"
''',
    "positive-net no-fill telemetry",
)
replace_once(
    '''    const breachReason = staleRecoveryNetPositive
      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : recoveryNetPositive
      ? "RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : positiveNetAfter180
      ? "POSITIVE_NET_AFTER_180S_GUARD_BREACH"
''',
    '''    const breachReason = staleRecoveryNetPositive
      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : lateRecoveryNetPositive
      ? "LATE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : recoveryNetPositive
      ? "RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : positiveNetAfter180
      ? "POSITIVE_NET_AFTER_180S_GUARD_BREACH"
''',
    "positive-net guard breach telemetry",
)
replace_once(
    '''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||
      decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
''',
    '''    (decisionReason === "POSITIVE_NET_AFTER_180S" ||
      decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
      decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT" ||
      decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT" ||
''',
    "terminal late-recovery close reason",
)

# 3) Preserve the 600-second hard ceiling on BOTH LOB spot and futures. The current hotfix
# explicitly excluded futures even though the configured invariant is venue-independent.
replace_once(
    '''        if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "HALF_HOLD_ABSOLUTE_TIMEOUT",
            signalValid: false,
          } as any;
          console.error(
            `[HARD_EXIT_INVARIANT] ${exchange}:${position.market} held=${heldSeconds}s ` +
              `limit=${absoluteMaxHoldingSeconds}s -> full exit`,
          );
        }
''',
    '''        if ((lobMode || futuresLane) && heldSeconds >= absoluteMaxHoldingSeconds) {
          const absoluteTimeoutReason = futuresLane
            ? "POST180_MAX_HOLD_TIMEOUT"
            : "HALF_HOLD_ABSOLUTE_TIMEOUT";
          decision = {
            action: "STOP",
            fraction: 1,
            reason: absoluteTimeoutReason,
            signalValid: false,
          } as any;
          console.error(
            `[HARD_EXIT_INVARIANT] ${exchange}:${position.market} held=${heldSeconds}s ` +
              `limit=${absoluteMaxHoldingSeconds}s reason=${absoluteTimeoutReason} -> full exit`,
          );
        }
''',
    "cross-venue 600-second hard timeout",
)

# 4) Track a dedicated, NEVER-RESET post-180 trough. Do not reuse the shadow reclaim
# state's lowest_price because that state machine intentionally resets its low after a
# failed reclaim. Existing positions bootstrap conservatively from the recent shadow window.
anchor = '''        const positionLeverageValue = positionLeverage(position);
        let recoveryMode = futuresLane && position.metadata?.recovery_exit?.enabled === true;
'''
insert = '''        const priorLateRecovery = position.metadata?.late_recovery || {};
        const priorLateRecoveryTrough = Math.max(
          0,
          finite(priorLateRecovery.post180_running_trough_price),
        );
        const recentShadowTrough = Array.isArray(position.metadata?.lob_post180_shadow_history)
          ? position.metadata.lob_post180_shadow_history.reduce((low: number, sample: any) => {
            const samplePrice = Math.max(0, finite(sample?.price));
            return samplePrice > 0 ? Math.min(low, samplePrice) : low;
          }, Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;
        const bootstrapPost180Trough = priorLateRecoveryTrough > 0
          ? priorLateRecoveryTrough
          : Number.isFinite(recentShadowTrough)
          ? Math.min(current, recentShadowTrough)
          : current;
        const post180RunningTrough = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds
          ? updatePost180RunningTrough(bootstrapPost180Trough, current)
          : 0;
        const lateRecoveryTrackingStartedNow = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds &&
          !priorLateRecovery.tracking_started_at;
        const lateRecoveryActivatedNow = heldSeconds >= LATE_RECOVERY_THRESHOLDS.startSeconds &&
          !priorLateRecovery.activated_at;
        const lateRecoveryTroughChanged = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds &&
          (priorLateRecoveryTrough <= 0 ||
            post180RunningTrough <
              priorLateRecoveryTrough - Math.max(1e-12, priorLateRecoveryTrough * 1e-10));

        const positionLeverageValue = positionLeverage(position);
        let recoveryMode = futuresLane && position.metadata?.recovery_exit?.enabled === true;
'''
replace_once(anchor, insert, "persistent post-180 trough state")

# 5) The new gate is strictly supplemental: it sees the split-policy result and can act
# only when every existing owner returned NONE. Earned residual winners are excluded.
anchor = '''        const watchIso = Number.isFinite(watchStartedMs)
          ? new Date(watchStartedMs).toISOString()
          : null;
'''
insert = '''        const executableDepthSufficient = policyQuantity > 0 &&
          executableQuote.executableVwap > 0 &&
          finite(executableQuote.visibleExecutableQuantity) +
              Math.max(1e-12, policyQuantity * 1e-8) >= policyQuantity;
        const lateRecovery = lateRecoveryDecision({
          heldSeconds,
          absoluteMaxHoldingSeconds,
          residualStage: !hasTradableHalf,
          existingAction: decision.action,
          entryPrice,
          runningTroughPrice: post180RunningTrough,
          executablePrice: executableExitPrice,
          executableDepthSufficient,
          executableNetAllowed: executableQuote.allowed,
          expectedNetProfitQuote: guardedNetProfitQuote,
        });
        if (lateRecovery.action === "STOP") {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: lateRecovery.reason,
          } as any;
          if (!priorLateRecovery.triggered_at) {
            await event(
              "LATE_RECOVERY_EXIT_TRIGGERED",
              `${exchange}:${position.market} ${lateRecovery.reason}`,
              {
                held_seconds: heldSeconds,
                entry_price: entryPrice,
                post180_running_trough_price: post180RunningTrough,
                executable_price: executableExitPrice,
                recovery_ratio: lateRecovery.recoveryRatio,
                threshold_ratio: LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
                expected_net_profit_quote: guardedNetProfitQuote,
                executable_net_allowed: executableQuote.allowed,
                executable_depth_sufficient: executableDepthSufficient,
                existing_policy_action_preserved: false,
              },
              { cycleId, positionId: position.id, level: "INFO" },
            );
          }
        }
        const lateRecoveryMetadataChanged = lateRecoveryTrackingStartedNow ||
          lateRecoveryActivatedNow || lateRecoveryTroughChanged || lateRecovery.action === "STOP";

        const watchIso = Number.isFinite(watchStartedMs)
          ? new Date(watchStartedMs).toISOString()
          : null;
'''
replace_once(anchor, insert, "supplemental late-recovery decision")

# 6) Persist enough state to prove behavior in production without a schema migration.
replace_once(
    '''        if (watchChanged || recoveryLatchedNow || decision.action !== "NONE") {
''',
    '''        if (
          watchChanged || recoveryLatchedNow || lateRecoveryMetadataChanged ||
          decision.action !== "NONE"
        ) {
''',
    "late-recovery metadata write condition",
)
replace_once(
    '''                bb_exit_watch_started_at: watchIso,
                bb_last_minute_gate: freshMinuteGate,
                // RECOVERY is a permanent pre-T1 mission state. It is latched once, at the
''',
    '''                bb_exit_watch_started_at: watchIso,
                bb_last_minute_gate: freshMinuteGate,
                ...(heldSeconds >= LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds
                  ? {
                    late_recovery: {
                      ...(priorLateRecovery || {}),
                      revision: "7.6.10-LATE-RECOVERY-460-R33",
                      tracking_started_at: priorLateRecovery.tracking_started_at || measuredAt,
                      post180_running_trough_price: post180RunningTrough,
                      start_seconds: LATE_RECOVERY_THRESHOLDS.startSeconds,
                      drawdown_recovery_ratio_threshold:
                        LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
                      activated_at: heldSeconds >= LATE_RECOVERY_THRESHOLDS.startSeconds
                        ? priorLateRecovery.activated_at || measuredAt
                        : priorLateRecovery.activated_at || null,
                      last_recovery_ratio: lateRecovery.recoveryRatio,
                      last_executable_price: executableExitPrice,
                      last_expected_net_profit_quote: guardedNetProfitQuote,
                      last_executable_depth_sufficient: executableDepthSufficient,
                      last_decision: lateRecovery.reason,
                      triggered_at: lateRecovery.action === "STOP"
                        ? priorLateRecovery.triggered_at || measuredAt
                        : priorLateRecovery.triggered_at || null,
                      checked_at: measuredAt,
                    },
                  }
                  : {}),
                // RECOVERY is a permanent pre-T1 mission state. It is latched once, at the
''',
    "late-recovery metadata payload",
)

# 7) A resting TP cancellation must not erase the new decision on its generic recheck.
replace_once(
    '''          decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||
''',
    '''          decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "LATE_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "LATE_RECOVERY_DRAWDOWN_33_EXIT" ||
          decision.reason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||
''',
    "resting-TP late-recovery allow list",
)

# New policy module is intentionally pure and tiny. It cannot place orders or mutate state.
POLICY.write_text('''// Trading-booooo — isolated late-recovery exit policy.\n//\n// This module is deliberately side-effect free. Existing STOP / profit-protection / split\n// policies remain authoritative; callers may consult this only after those owners return\n// NONE. The post-180 trough is persisted by the caller and must never reset on reclaim.\n\nexport const LATE_RECOVERY_THRESHOLDS = {\n  troughTrackingStartSeconds: 180,\n  startSeconds: 460,\n  drawdownRecoveryRatio: 0.33,\n} as const;\n\nexport type LateRecoveryReason =\n  | "LATE_RECOVERY_NET_POSITIVE_EXIT"\n  | "LATE_RECOVERY_DRAWDOWN_33_EXIT"\n  | "LATE_RECOVERY_EXISTING_DECISION_PRESERVED"\n  | "LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED"\n  | "LATE_RECOVERY_INACTIVE"\n  | "LATE_RECOVERY_AWAITING_RECOVERY";\n\nexport type LateRecoveryDecision = {\n  action: "STOP" | "NONE";\n  fraction: number;\n  reason: LateRecoveryReason;\n  recoveryRatio: number | null;\n};\n\nfunction finite(value: unknown, fallback = 0): number {\n  const parsed = Number(value);\n  return Number.isFinite(parsed) ? parsed : fallback;\n}\n\nexport function updatePost180RunningTrough(\n  previousTroughPrice: unknown,\n  observedPrice: unknown,\n): number {\n  const previous = finite(previousTroughPrice);\n  const observed = finite(observedPrice);\n  if (!(observed > 0)) return previous > 0 ? previous : 0;\n  if (!(previous > 0)) return observed;\n  return Math.min(previous, observed);\n}\n\nexport function lateRecoveryDecision(input: {\n  heldSeconds: number;\n  absoluteMaxHoldingSeconds: number;\n  residualStage: boolean;\n  existingAction: string;\n  entryPrice: number;\n  runningTroughPrice: number;\n  executablePrice: number;\n  executableDepthSufficient: boolean;\n  executableNetAllowed: boolean;\n  expectedNetProfitQuote: number;\n}): LateRecoveryDecision {\n  const none = (reason: LateRecoveryReason, recoveryRatio: number | null = null) => ({\n    action: "NONE" as const,\n    fraction: 0,\n    reason,\n    recoveryRatio,\n  });\n\n  if (String(input.existingAction || "NONE") !== "NONE") {\n    return none("LATE_RECOVERY_EXISTING_DECISION_PRESERVED");\n  }\n  if (input.residualStage) return none("LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED");\n\n  const heldSeconds = Math.max(0, finite(input.heldSeconds));\n  const absoluteMaxHoldingSeconds = Math.max(1, finite(input.absoluteMaxHoldingSeconds, 600));\n  if (\n    heldSeconds < LATE_RECOVERY_THRESHOLDS.startSeconds ||\n    heldSeconds >= absoluteMaxHoldingSeconds\n  ) {\n    return none("LATE_RECOVERY_INACTIVE");\n  }\n\n  const expectedNetProfitQuote = finite(input.expectedNetProfitQuote, Number.NEGATIVE_INFINITY);\n  if (input.executableNetAllowed && expectedNetProfitQuote >= 0) {\n    return {\n      action: "STOP",\n      fraction: 1,\n      reason: "LATE_RECOVERY_NET_POSITIVE_EXIT",\n      recoveryRatio: null,\n    };\n  }\n\n  const entryPrice = finite(input.entryPrice);\n  const troughPrice = finite(input.runningTroughPrice);\n  const executablePrice = finite(input.executablePrice);\n  const drawdown = entryPrice - troughPrice;\n  if (\n    !input.executableDepthSufficient || !(entryPrice > 0) || !(troughPrice > 0) ||\n    !(executablePrice > 0) || !(drawdown > 0)\n  ) {\n    return none("LATE_RECOVERY_AWAITING_RECOVERY");\n  }\n\n  const recoveryRatio = (executablePrice - troughPrice) / drawdown;\n  if (\n    expectedNetProfitQuote < 0 &&\n    recoveryRatio >= LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio\n  ) {\n    return {\n      action: "STOP",\n      fraction: 1,\n      reason: "LATE_RECOVERY_DRAWDOWN_33_EXIT",\n      recoveryRatio,\n    };\n  }\n  return none("LATE_RECOVERY_AWAITING_RECOVERY", recoveryRatio);\n}\n''')

TEST.write_text('''import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";\nimport {\n  LATE_RECOVERY_THRESHOLDS,\n  lateRecoveryDecision,\n  updatePost180RunningTrough,\n} from "./late-recovery-policy.ts";\n\nfunction decide(overrides: Record<string, unknown> = {}) {\n  return lateRecoveryDecision({\n    heldSeconds: 460,\n    absoluteMaxHoldingSeconds: 600,\n    residualStage: false,\n    existingAction: "NONE",\n    entryPrice: 100,\n    runningTroughPrice: 97,\n    executablePrice: 97.5,\n    executableDepthSufficient: true,\n    executableNetAllowed: false,\n    expectedNetProfitQuote: -1,\n    ...overrides,\n  } as any);\n}\n\nDeno.test("late recovery thresholds preserve 180 tracking, 460 activation and 33 percent recovery", () => {\n  assertEquals(LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds, 180);\n  assertEquals(LATE_RECOVERY_THRESHOLDS.startSeconds, 460);\n  assertEquals(LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio, 0.33);\n});\n\nDeno.test("post-180 trough never resets upward", () => {\n  assertEquals(updatePost180RunningTrough(97, 98), 97);\n  assertEquals(updatePost180RunningTrough(97, 96.5), 96.5);\n  assertEquals(updatePost180RunningTrough(0, 98), 98);\n});\n\nDeno.test("existing safety or profit decision always wins", () => {\n  const result = decide({\n    existingAction: "STOP",\n    executableNetAllowed: true,\n    expectedNetProfitQuote: 10,\n    executablePrice: 101,\n  });\n  assertEquals(result.action, "NONE");\n  assertEquals(result.reason, "LATE_RECOVERY_EXISTING_DECISION_PRESERVED");\n});\n\nDeno.test("earned residual winner is never demoted into late recovery", () => {\n  const result = decide({ residualStage: true, executablePrice: 99.5 });\n  assertEquals(result.action, "NONE");\n  assertEquals(result.reason, "LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED");\n});\n\nDeno.test("late recovery cannot fire before 460 seconds", () => {\n  const result = decide({\n    heldSeconds: 459.999,\n    executableNetAllowed: true,\n    expectedNetProfitQuote: 1,\n  });\n  assertEquals(result.action, "NONE");\n  assertEquals(result.reason, "LATE_RECOVERY_INACTIVE");\n});\n\nDeno.test("600 second hard timeout keeps ownership at the boundary", () => {\n  const result = decide({\n    heldSeconds: 600,\n    executableNetAllowed: true,\n    expectedNetProfitQuote: 1,\n  });\n  assertEquals(result.action, "NONE");\n  assertEquals(result.reason, "LATE_RECOVERY_INACTIVE");\n});\n\nDeno.test("executable non-negative net exits the whole pre-T1 position after 460s", () => {\n  const result = decide({\n    heldSeconds: 460,\n    executableNetAllowed: true,\n    expectedNetProfitQuote: 0,\n    executablePrice: 100.1,\n  });\n  assertEquals(result.action, "STOP");\n  assertEquals(result.fraction, 1);\n  assertEquals(result.reason, "LATE_RECOVERY_NET_POSITIVE_EXIT");\n});\n\nDeno.test("one-third drawdown recovery exits while net remains negative", () => {\n  const result = decide({\n    entryPrice: 100,\n    runningTroughPrice: 97,\n    executablePrice: 98,\n    expectedNetProfitQuote: -0.1,\n  });\n  assertEquals(result.action, "STOP");\n  assertEquals(result.reason, "LATE_RECOVERY_DRAWDOWN_33_EXIT");\n  assertEquals(Math.round((result.recoveryRatio || 0) * 1000), 333);\n});\n\nDeno.test("recovery below 33 percent keeps holding", () => {\n  const result = decide({\n    entryPrice: 100,\n    runningTroughPrice: 97,\n    executablePrice: 97.98,\n    expectedNetProfitQuote: -0.1,\n  });\n  assertEquals(result.action, "NONE");\n  assertEquals(result.reason, "LATE_RECOVERY_AWAITING_RECOVERY");\n});\n\nDeno.test("drawdown recovery requires full executable depth", () => {\n  const result = decide({\n    entryPrice: 100,\n    runningTroughPrice: 97,\n    executablePrice: 99,\n    executableDepthSufficient: false,\n    expectedNetProfitQuote: -0.1,\n  });\n  assertEquals(result.action, "NONE");\n});\n\nDeno.test("invalid denominator cannot trigger a recovery exit", () => {\n  const result = decide({\n    entryPrice: 100,\n    runningTroughPrice: 100,\n    executablePrice: 100.5,\n    expectedNetProfitQuote: -0.1,\n  });\n  assertEquals(result.action, "NONE");\n});\n''')

# Static integration assertions. Any source drift aborts before tests/deploy.
assert 'LATE_RECOVERY_THRESHOLDS' in source
assert 'lateRecoveryDecision({' in source
assert 'revision: "7.6.10-LATE-RECOVERY-460-R33"' in source
assert 'reason: lateRecovery.reason' in source
assert 'decision.reason === "LATE_RECOVERY_NET_POSITIVE_EXIT"' in source
assert 'decision.reason === "LATE_RECOVERY_DRAWDOWN_33_EXIT"' in source
assert 'lateRecoveryNetPositive ||' in source
assert 'lateRecoveryDrawdown || action === "EMERGENCY"' in source
assert 'if ((lobMode || futuresLane) && heldSeconds >= absoluteMaxHoldingSeconds)' in source
assert '? "POST180_MAX_HOLD_TIMEOUT"' in source
assert 'const VERSION = "7.6.0-BINANCE-FUTURES";' in source

INDEX.write_text(source)
print("late recovery 460s / 33% patch applied; existing exit owners preserved")
