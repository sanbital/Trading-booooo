from pathlib import Path

PATH = Path("supabase/functions/market-autotrader/index.ts")
text = PATH.read_text()


def replace_exact(old: str, new: str, expected: int = 1) -> None:
    global text
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} matches, got {count}: {old[:160]!r}")
    text = text.replace(old, new)


replace_exact(
    '''  futuresEntryMinimums,\n  futuresSplitExitDecision,\n  normalizeFuturesLeverage,\n''',
    '''  futuresEntryMinimums,\n  futuresRecoveryState,\n  futuresSplitExitDecision,\n  normalizeFuturesLeverage,\n''',
)

# The generic LOB 180-second hold override must not own Futures. Futures uses its own
# 180-second mission-state transition instead.
replace_exact(
    '''        lobMode && !settings.emergency_liquidation && heldSeconds >= 180 &&\n''',
    '''        lobMode && !futuresLane && !settings.emergency_liquidation && heldSeconds >= 180 &&\n''',
)

# Generic LOB soft exits and generic scalp hold exits are spot owners. Futures has a single
# leverage-aware state-machine owner so these paths cannot preempt RECOVERY or winner trailing.
replace_exact(
    '''        lobMode && decision.action === "NONE" &&\n        !settings.emergency_liquidation\n''',
    '''        lobMode && !futuresLane && decision.action === "NONE" &&\n        !settings.emergency_liquidation\n''',
)
replace_exact(
    '''      } else if (scalpMode && decision.action === "NONE" && !settings.emergency_liquidation) {\n''',
    '''      } else if (\n        scalpMode && !futuresLane && decision.action === "NONE" &&\n        !settings.emergency_liquidation\n      ) {\n''',
)
replace_exact(
    '''      if (isScalpStrategy((settings as any).strategy) && position.average_entry_price > 0) {\n''',
    '''      if (\n        !futuresLane && isScalpStrategy((settings as any).strategy) &&\n        position.average_entry_price > 0\n      ) {\n''',
)

replace_exact(
    '''          ? "FUTURES-PROTECTED-TRAIL-ROE15-SL12-FLOOR9-TRAIL4P5-RECOVERY180M-V2"\n''',
    '''          ? "FUTURES-ROE15-SL12-RECOVERY3M-FLOOR9-TRAIL4P5-GIVEBACK180M-V3"\n''',
)

# Futures winners are intentionally allowed to run. The generic ten-minute LOB timeout is
# a spot/LOB safety owner and must not terminate the Futures state machine.
replace_exact(
    '''        if (lobMode && heldSeconds >= absoluteMaxHoldingSeconds) {\n''',
    '''        if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds) {\n''',
)

old_futures = '''        const positionLeverageValue = positionLeverage(position);\n        let recoveryMode = futuresLane && position.metadata?.recovery_exit?.enabled === true;\n        let futuresAudit: JsonRecord | null = null;\n        let recoveryLatchedNow = false;\n\n        if (requestedAction === "STOP") {\n          // Preserve the upstream safety decision exactly. In particular, STOP_HIT and\n          // HALF_HOLD_ABSOLUTE_TIMEOUT must reach the executable-exit layer unchanged.\n          console.warn(\n            `[HARD_EXIT_INVARIANT] preserving ${requestedReason || "STOP"} for ` +\n              `${exchange}:${position.market}`,\n          );\n        } else if (futuresLane) {\n          // The futures residual rule is stated about the REMAINING half's own return, so\n          // it is priced against the remainder's own principal. The whole-position quote\n          // above still governs the spot lane and stays untouched.\n          const residualPrincipalQuote = Math.max(0, policyQuantity * entryPrice);\n          const residualQuote = quoteExecutableNetExit({\n            bids: liveBids,\n            requestedQuantity: policyQuantity,\n            availableQuantity: position.is_paper\n              ? policyQuantity\n              : accountQuantity(portfolios[exchange], position.base_asset, true),\n            quantityStep: finite(position.quantity_step, 0.00000001),\n            buyPrincipalQuote: residualPrincipalQuote,\n            alreadyPaidFeesQuote: residualPrincipalQuote * policyFeeRate,\n            priorSellProceedsQuote: 0,\n            sellFeeRate: policyFeeRate,\n            slippageSafetyRate: post180SlippageSafetyRate(settings),\n          });\n          // Protected trailing replaces the legacy negative-to-positive recovery latch.\n          recoveryLatchedNow = false;\n          recoveryMode = false;\n          const futuresDecision = futuresSplitExitDecision({\n            residualStage: !hasTradableHalf,\n            recoveryMode,\n            leverage: positionLeverageValue,\n            grossReturnPct,\n            peakGrossReturnPct,\n            netReturnPct: residualNetReturnPct,\n            executableNetAllowed: residualQuote.allowed,\n            expectedNetProfitQuote: finite(residualQuote.expectedNetProfitQuote),\n            heldSeconds,\n            preT1ProfitProtectionHit: preT1ProtectionHit,\n            safetyRequested,\n          });\n          decision = {\n            action: futuresDecision.action,\n            fraction: futuresDecision.fraction,\n            reason: futuresDecision.reason,\n          } as any;\n          futuresAudit = {\n            leverage: futuresDecision.leverage,\n            roe_pct: futuresDecision.roePct,\n            net_roe_pct: futuresDecision.netRoePct,\n            price_return_pct: grossReturnPct,\n            thresholds: FUTURES_SPLIT_EXIT_THRESHOLDS,\n            residual_stage: !hasTradableHalf,\n            residual_executable_net_allowed: residualQuote.allowed,\n            residual_expected_net_profit_quote:\n              Number.isFinite(residualQuote.expectedNetProfitQuote)\n                ? residualQuote.expectedNetProfitQuote\n                : null,\n            residual_principal_quote: residualPrincipalQuote,\n          };\n        } else {\n'''

new_futures = '''        const positionLeverageValue = positionLeverage(position);\n        let recoveryMode = futuresLane && position.metadata?.recovery_exit?.enabled === true;\n        let futuresAudit: JsonRecord | null = null;\n        let recoveryLatchedNow = false;\n\n        if (requestedAction === "STOP") {\n          // Preserve only true upstream safety decisions. Generic LOB/scalp time and soft\n          // exits are excluded from Futures above, so a Futures STOP here is the planned\n          // leverage-aware hard stop, reconciliation/emergency handling, or equivalent.\n          console.warn(\n            `[HARD_EXIT_INVARIANT] preserving ${requestedReason || "STOP"} for ` +\n              `${exchange}:${position.market}`,\n          );\n        } else if (futuresLane) {\n          const residualStage = !hasTradableHalf;\n          // Residual winners use their own remaining-leg economics. Pre-T1 NORMAL/RECOVERY\n          // decisions use the WHOLE position economics, including already-paid fees and any\n          // prior proceeds, because the operator rule is about recovering the whole trade.\n          const residualPrincipalQuote = Math.max(0, policyQuantity * entryPrice);\n          const residualQuote = quoteExecutableNetExit({\n            bids: liveBids,\n            requestedQuantity: policyQuantity,\n            availableQuantity: position.is_paper\n              ? policyQuantity\n              : accountQuantity(portfolios[exchange], position.base_asset, true),\n            quantityStep: finite(position.quantity_step, 0.00000001),\n            buyPrincipalQuote: residualPrincipalQuote,\n            alreadyPaidFeesQuote: residualPrincipalQuote * policyFeeRate,\n            priorSellProceedsQuote: 0,\n            sellFeeRate: policyFeeRate,\n            slippageSafetyRate: post180SlippageSafetyRate(settings),\n          });\n          const recoveryState = futuresRecoveryState({\n            residualStage,\n            alreadyLatched: recoveryMode,\n            heldSeconds,\n            netReturnPct: guardedNetReturnPct,\n          });\n          recoveryMode = recoveryState.enabled;\n          recoveryLatchedNow = recoveryState.newlyLatched;\n\n          const futuresNetReturnPct = residualStage\n            ? residualNetReturnPct\n            : guardedNetReturnPct;\n          const futuresExecutableNetAllowed = residualStage\n            ? residualQuote.allowed\n            : executableQuote.allowed;\n          const futuresExpectedNetProfitQuote = residualStage\n            ? finite(residualQuote.expectedNetProfitQuote)\n            : guardedNetProfitQuote;\n          const futuresDecision = futuresSplitExitDecision({\n            residualStage,\n            recoveryMode,\n            leverage: positionLeverageValue,\n            grossReturnPct,\n            peakGrossReturnPct,\n            netReturnPct: futuresNetReturnPct,\n            executableNetAllowed: futuresExecutableNetAllowed,\n            expectedNetProfitQuote: futuresExpectedNetProfitQuote,\n            heldSeconds,\n            preT1ProfitProtectionHit: preT1ProtectionHit,\n            safetyRequested,\n          });\n          decision = {\n            action: futuresDecision.action,\n            fraction: futuresDecision.fraction,\n            reason: futuresDecision.reason,\n          } as any;\n          futuresAudit = {\n            leverage: futuresDecision.leverage,\n            roe_pct: futuresDecision.roePct,\n            net_roe_pct: futuresDecision.netRoePct,\n            price_return_pct: grossReturnPct,\n            thresholds: FUTURES_SPLIT_EXIT_THRESHOLDS,\n            residual_stage: residualStage,\n            recovery_mode: recoveryMode,\n            recovery_latched_now: recoveryLatchedNow,\n            whole_position_net_return_pct: guardedNetReturnPct,\n            whole_position_executable_net_allowed: executableQuote.allowed,\n            whole_position_expected_net_profit_quote: guardedNetProfitQuote,\n            residual_executable_net_allowed: residualQuote.allowed,\n            residual_expected_net_profit_quote:\n              Number.isFinite(residualQuote.expectedNetProfitQuote)\n                ? residualQuote.expectedNetProfitQuote\n                : null,\n            residual_principal_quote: residualPrincipalQuote,\n          };\n        } else {\n'''
replace_exact(old_futures, new_futures)

old_recovery_meta = '''                // The futures residual rule is a latch, not a live comparison: once the\n                // remainder has been seen underwater it leaves at the flip to positive,\n                // however long that takes. Persist it the tick it engages.\n                ...(recoveryLatchedNow\n                  ? {\n                    recovery_exit: {\n                      ...(position.metadata?.recovery_exit || {}),\n                      enabled: true,\n                      revision: VERSION,\n                      entered_at: new Date(nowMs).toISOString(),\n                      trigger_reason: "FUTURES_RESIDUAL_NEGATIVE_RETURN",\n                      exit_rule: "RESIDUAL_NET_PNL_GT_0",\n                      leverage: positionLeverageValue,\n                      residual_net_return_pct_at_latch: residualNetReturnPct,\n                      percentage_residual_thresholds_disabled: true,\n                    },\n                  }\n                  : {}),\n'''
new_recovery_meta = '''                // RECOVERY is a permanent pre-T1 mission state. It is latched once, at the\n                // first observation at/after 180s whose WHOLE-position executable net is\n                // non-positive, and remains set until the position closes.\n                ...(recoveryLatchedNow\n                  ? {\n                    recovery_exit: {\n                      ...(position.metadata?.recovery_exit || {}),\n                      enabled: true,\n                      state: "RECOVERY",\n                      revision: VERSION,\n                      entered_at: new Date(nowMs).toISOString(),\n                      trigger_reason: "FUTURES_3M_NET_NONPOSITIVE",\n                      exit_rule: "FULL_POSITION_EXECUTABLE_NET_PNL_GT_0",\n                      leverage: positionLeverageValue,\n                      held_seconds_at_latch: heldSeconds,\n                      net_return_pct_at_latch: guardedNetReturnPct,\n                      net_profit_quote_at_latch: guardedNetProfitQuote,\n                      permanent_until_exit: true,\n                    },\n                  }\n                  : {}),\n'''
replace_exact(old_recovery_meta, new_recovery_meta)

# New Futures semantic reasons must survive resting-order cancellation and continue through
# the centralized order path.
replace_exact(
    '''          decision.reason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||\n''',
    '''          decision.reason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||\n          decision.reason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||\n''',
)

# Dedicated 180m giveback reason is a full liquidation, not a split exit.
replace_exact(
    '''    decisionReason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n    decisionReason === "RESIDUAL_PROTECTED_TRAIL_EXIT" ||\n''',
    '''    decisionReason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n    decisionReason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||\n    decisionReason === "RESIDUAL_PROTECTED_TRAIL_EXIT" ||\n''',
)

PATH.write_text(text)
print("patched futures 3m recovery state machine into index.ts")
