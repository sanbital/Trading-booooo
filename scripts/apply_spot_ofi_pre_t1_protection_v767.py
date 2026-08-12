from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "supabase/functions/market-autotrader/index.ts"
SPOT = ROOT / "supabase/functions/market-autotrader/spot-exit-policy.ts"
FUTURES = ROOT / "supabase/functions/market-autotrader/futures-exit-policy.ts"
SPOT_TEST = ROOT / "supabase/functions/market-autotrader/spot-exit-policy.test.ts"
FUTURES_TEST = ROOT / "supabase/functions/market-autotrader/futures-exit-policy.test.ts"
GUARDS = ROOT / "supabase/functions/market-autotrader/live-guards.ts"
GUARDS_TEST = ROOT / "supabase/functions/market-autotrader/live-guards.test.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 old match, found {count}")
    return text.replace(old, new, 1)


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise SystemExit(f"{label}: missing expected text: {needle}")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


# Pure guards make the exchange split and positive-floor invariant independently testable.
write(
    GUARDS,
    '''import type { Exchange } from "./core.ts";
import type { LobPatternName } from "../_shared/lob/types.ts";

/**
 * Live-fill evidence: standalone momentum loses on both Binance lanes, while standalone
 * OFI loses on spot but the verified futures sample is still positive and too small to
 * justify a futures ban. Keep the venue split explicit so a future global default cannot
 * silently disable the futures lane.
 */
export function liveBlockedLobPatterns(exchange: Exchange): LobPatternName[] {
  return exchange === "binance"
    ? ["MOMENTUM_CONTINUATION", "OFI_CONTINUATION"]
    : ["MOMENTUM_CONTINUATION"];
}

export type PreT1ProfitProtectionInput = {
  hasTradableHalf: boolean;
  entryPrice: number;
  executableExitPrice: number;
  protectedStopPrice: number;
};

/**
 * Pre-T1 profit protection may liquidate the position only after a real positive floor
 * has been earned. Historical metadata can contain below-entry protective stops, which
 * must never become a new loss exit merely because the field exists.
 */
export function preT1ProfitProtectionHit(input: PreT1ProfitProtectionInput): boolean {
  const entry = Number(input.entryPrice);
  const exit = Number(input.executableExitPrice);
  const protectedStop = Number(input.protectedStopPrice);
  return input.hasTradableHalf === true &&
    Number.isFinite(entry) && entry > 0 &&
    Number.isFinite(exit) && exit > 0 &&
    Number.isFinite(protectedStop) && protectedStop > entry &&
    exit <= protectedStop;
}
''',
)

write(
    GUARDS_TEST,
    '''import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";

Deno.test("spot blocks standalone OFI while futures keeps it available", () => {
  assertEquals(liveBlockedLobPatterns("binance"), [
    "MOMENTUM_CONTINUATION",
    "OFI_CONTINUATION",
  ]);
  assertEquals(liveBlockedLobPatterns("binance_futures"), ["MOMENTUM_CONTINUATION"]);
  assertEquals(liveBlockedLobPatterns("upbit"), ["MOMENTUM_CONTINUATION"]);
});

Deno.test("pre-T1 protection only triggers on an earned positive floor", () => {
  assertEquals(preT1ProfitProtectionHit({
    hasTradableHalf: true,
    entryPrice: 100,
    executableExitPrice: 101.5,
    protectedStopPrice: 102,
  }), true);
  assertEquals(preT1ProfitProtectionHit({
    hasTradableHalf: true,
    entryPrice: 100,
    executableExitPrice: 98,
    protectedStopPrice: 99,
  }), false);
  assertEquals(preT1ProfitProtectionHit({
    hasTradableHalf: false,
    entryPrice: 100,
    executableExitPrice: 101.5,
    protectedStopPrice: 102,
  }), false);
});
''',
)

index = INDEX.read_text(encoding="utf-8")
index = replace_once(
    index,
    'import { loadMinuteEntryGate } from "../_shared/lob/minute-entry-market.ts";\n',
    'import { loadMinuteEntryGate } from "../_shared/lob/minute-entry-market.ts";\nimport { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";\n',
    "index guard import",
)

# The first live gate and the final pre-order gate must share the same venue-specific block.
index = replace_once(
    index,
    '      fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,\n    };\n    const decision = evaluateLobEntry(features, lobExecutionCosts, lobExecutionGate);',
    '      fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,\n      blockedPatterns: liveBlockedLobPatterns(exchange),\n    };\n    const decision = evaluateLobEntry(features, lobExecutionCosts, lobExecutionGate);',
    "initial live LOB blockedPatterns",
)
index = replace_once(
    index,
    '    requireMinuteEntryGate: boolean;\n    trap?: Partial<LobTrapConfig>;\n',
    '    requireMinuteEntryGate: boolean;\n    blockedPatterns?: LobPatternName[];\n    trap?: Partial<LobTrapConfig>;\n',
    "preorder options blockedPatterns type",
)
index = replace_once(
    index,
    '    requireMinuteEntryGate: options.requireMinuteEntryGate,\n    trap: options.trap || {},\n',
    '    requireMinuteEntryGate: options.requireMinuteEntryGate,\n    blockedPatterns: options.blockedPatterns,\n    trap: options.trap || {},\n',
    "preorder evaluator blockedPatterns",
)
index = replace_once(
    index,
    '      minNetRewardRiskRatio: lobExecutionGate.minNetRewardRiskRatio,\n      requireMinuteEntryGate: true,\n    };',
    '      minNetRewardRiskRatio: lobExecutionGate.minNetRewardRiskRatio,\n      requireMinuteEntryGate: true,\n      blockedPatterns: liveBlockedLobPatterns(exchange),\n    };',
    "preorder context blockedPatterns",
)

# Convert already-computed protection metadata into an executable pre-T1 guard only when
# that stop is strictly above entry. Existing first-TP rules retain precedence in policies.
index = replace_once(
    index,
    '        const hasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >\n          residualTolerance;\n\n        const positionLeverageValue = positionLeverage(position);',
    '        const hasTradableHalf = finite(position.remaining_quantity) - protectedHoldQuantity >\n          residualTolerance;\n        const preT1ProtectedStopPrice = Math.max(\n          0,\n          finite((position as any).metadata?.profit_protection?.protected_stop_price),\n        );\n        const preT1ProtectionHit = preT1ProfitProtectionHit({\n          hasTradableHalf,\n          entryPrice,\n          executableExitPrice,\n          protectedStopPrice: preT1ProtectedStopPrice,\n        });\n\n        const positionLeverageValue = positionLeverage(position);',
    "pre-T1 protection calculation",
)
index = replace_once(
    index,
    '            heldSeconds,\n            safetyRequested: quoteDecision.action !== "NONE",\n          });',
    '            heldSeconds,\n            preT1ProfitProtectionHit: preT1ProtectionHit,\n            safetyRequested: quoteDecision.action !== "NONE",\n          });',
    "futures policy pre-T1 flag",
)
index = replace_once(
    index,
    '            heldSeconds,\n            executableNetAllowed: executableQuote.allowed,\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\n            safetyRequested: quoteDecision.action !== "NONE",\n          });',
    '            heldSeconds,\n            executableNetAllowed: executableQuote.allowed,\n            expectedNetProfitQuote: executableQuote.expectedNetProfitQuote,\n            preT1ProfitProtectionHit: preT1ProtectionHit,\n            safetyRequested: quoteDecision.action !== "NONE",\n          });',
    "spot policy pre-T1 flag",
)

# Full-liquidation and resting-TP cancellation guards must recognize the two new reasons.
index = replace_once(
    index,
    '  const fullLiquidationExit = decisionReason === "HALF_HOLD_STOP_LOSS_4" ||\n    decisionReason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||',
    '  const fullLiquidationExit = decisionReason === "HALF_HOLD_STOP_LOSS_4" ||\n    decisionReason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||\n    decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||\n    decisionReason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||',
    "full liquidation allow list",
)
index = replace_once(
    index,
    '          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||',
    '          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||\n          decision.reason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||',
    "resting TP cancellation allow list",
)
# The same list appears in a nearby resting-order confirmation branch. Keep both synchronized.
old_confirm = '          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||'
new_confirm = '          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||\n          decision.reason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||\n          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||'
if old_confirm in index:
    index = index.replace(old_confirm, new_confirm, 1)

write(INDEX, index)

spot = SPOT.read_text(encoding="utf-8")
spot = replace_once(
    spot,
    '  safetyRequested?: boolean;\n};',
    '  /** True only when the engine has an earned above-entry protected stop and price hit it. */\n  preT1ProfitProtectionHit?: boolean;\n  safetyRequested?: boolean;\n};',
    "spot policy input",
)
spot = replace_once(
    spot,
    '  if (input.grossReturnPct <= t.firstStopLossPct) {',
    '  if (input.preT1ProfitProtectionHit === true) {\n    return {\n      action: "STOP",\n      fraction: 1,\n      reason: "PRE_T1_PROFIT_PROTECTION_EXIT",\n    };\n  }\n  if (input.grossReturnPct <= t.firstStopLossPct) {',
    "spot pre-T1 policy",
)
write(SPOT, spot)

futures = FUTURES.read_text(encoding="utf-8")
futures = replace_once(
    futures,
    '  | "FUTURES_HALF_STOP_LOSS_ROE_12"\n',
    '  | "FUTURES_HALF_STOP_LOSS_ROE_12"\n  | "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT"\n',
    "futures reason union",
)
futures = replace_once(
    futures,
    '  heldSeconds: number;\n  /** A non-price safety request',
    '  heldSeconds: number;\n  /** True only when the engine has an earned above-entry protected stop and price hit it. */\n  preT1ProfitProtectionHit?: boolean;\n  /** A non-price safety request',
    "futures policy input",
)
futures = replace_once(
    futures,
    '  if (roePct <= thresholds.firstStopLossRoePct) {',
    '  if (input.preT1ProfitProtectionHit === true) {\n    return {\n      ...base,\n      action: "STOP",\n      fraction: 1,\n      reason: "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT",\n    };\n  }\n  if (roePct <= thresholds.firstStopLossRoePct) {',
    "futures pre-T1 policy",
)
futures = replace_once(
    futures,
    '  "FUTURES_HALF_STOP_LOSS_ROE_12",\n  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",',
    '  "FUTURES_HALF_STOP_LOSS_ROE_12",\n  "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT",\n  "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT",',
    "futures approved reasons",
)
write(FUTURES, futures)

spot_test = SPOT_TEST.read_text(encoding="utf-8")
spot_test = replace_once(
    spot_test,
    '    safetyRequested: false,\n',
    '    preT1ProfitProtectionHit: false,\n    safetyRequested: false,\n',
    "spot test default",
)
if 'spot pre-T1 earned profit floor closes 100%' not in spot_test:
    spot_test += '''\nDeno.test("spot pre-T1 earned profit floor closes 100%", () => {\n  const d = decide({ grossReturnPct: 2, peakGrossReturnPct: 3, preT1ProfitProtectionHit: true });\n  assertEquals(d.action, "STOP");\n  assertEquals(d.fraction, 1);\n  assertEquals(d.reason, "PRE_T1_PROFIT_PROTECTION_EXIT");\n});\n\nDeno.test("spot +5 target keeps precedence over pre-T1 protection", () => {\n  const d = decide({ grossReturnPct: 5.2, preT1ProfitProtectionHit: true });\n  assertEquals(d.fraction, 0.5);\n  assertEquals(d.reason, "HALF_HOLD_TAKE_PROFIT_5");\n});\n'''
write(SPOT_TEST, spot_test)

futures_test = FUTURES_TEST.read_text(encoding="utf-8")
futures_test = replace_once(
    futures_test,
    '    heldSeconds: 0,\n    safetyRequested: false,\n',
    '    heldSeconds: 0,\n    preT1ProfitProtectionHit: false,\n    safetyRequested: false,\n',
    "futures test default",
)
if 'futures pre-T1 earned profit floor closes 100%' not in futures_test:
    futures_test += '''\nDeno.test("futures pre-T1 earned profit floor closes 100%", () => {\n  const d = decide({ grossReturnPct: 2.5, peakGrossReturnPct: 3, preT1ProfitProtectionHit: true });\n  assertEquals(d.action, "STOP");\n  assertEquals(d.fraction, 1);\n  assertEquals(d.reason, "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT");\n});\n\nDeno.test("futures +15% ROE target keeps precedence over pre-T1 protection", () => {\n  const d = decide({ grossReturnPct: 5.1, preT1ProfitProtectionHit: true });\n  assertEquals(d.fraction, 0.5);\n  assertEquals(d.reason, "FUTURES_HALF_TAKE_PROFIT_ROE_15");\n});\n'''
write(FUTURES_TEST, futures_test)

# Final patch-level invariants. These deliberately fail the workflow before any deploy if a
# later code change makes the patch ambiguous or changes an operator-authorized threshold.
for path, needle, label in [
    (INDEX, 'blockedPatterns: liveBlockedLobPatterns(exchange)', 'spot/futures venue block wired'),
    (INDEX, 'preT1ProfitProtectionHit: preT1ProtectionHit', 'pre-T1 flag wired'),
    (SPOT, 'firstTakeProfitPct: 5', 'spot TP unchanged'),
    (SPOT, 'firstStopLossPct: -4', 'spot stop unchanged'),
    (FUTURES, 'firstTakeProfitRoePct: 15', 'futures TP unchanged'),
    (FUTURES, 'firstStopLossRoePct: -12', 'futures stop unchanged'),
    (FUTURES, 'FUTURES_MIN_ENTRY_MARGIN_USDT = 50', 'futures minimum margin unchanged'),
    (FUTURES, 'DEFAULT_FUTURES_LEVERAGE = 3', 'futures leverage unchanged'),
]:
    require(path.read_text(encoding='utf-8'), needle, label)

print('v7.6.7 spot OFI + pre-T1 profit protection patch applied')
