from pathlib import Path

OLD_RELEASE = "7.1.0-LOB-45S-180-300-RISK20"
RELEASE = "7.1.1-LOB-45S-PROFIT-OR-5PCT"


def replace_required(path: str, old: str, new: str, minimum: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count >= minimum:
        p.write_text(text.replace(old, new))
        return
    if new in text:
        return
    raise SystemExit(f"{path}: marker not found: {old[:160]!r}")


def replace_optional(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old in text:
        p.write_text(text.replace(old, new))


scanner = "supabase/functions/market-scanner/index.ts"
replace_required(scanner, f"Market Scanner v{OLD_RELEASE}", f"Market Scanner v{RELEASE}")

engine = "supabase/functions/market-scanner/engine.ts"
replace_required(engine, f"Market Scanner v{OLD_RELEASE}", f"Market Scanner v{RELEASE}")
replace_required(engine, f'ENGINE_VERSION = "{OLD_RELEASE}"', f'ENGINE_VERSION = "{RELEASE}"')
replace_required(
    engine,
    'finiteOr((risk.scalpOverrides || {}).maxHoldingSeconds, 300), 1, 300',
    'finiteOr((risk.scalpOverrides || {}).maxHoldingSeconds, 180), 1, 300',
)
replace_required(engine, "absoluteMaxHoldingSeconds: 300,", "absoluteMaxHoldingSeconds: 180,")

entry = "supabase/functions/_shared/lob/entry.ts"
replace_optional(
    entry,
    "// Ordinary 300-second LOB events remain capped at 60bp. The separately identified momentum",
    "// The first 180 seconds are the expected resolution window; they are not a forced exit deadline.",
)
replace_required(entry, "maxHoldingSeconds: 300,", "maxHoldingSeconds: 180,")

core = "supabase/functions/market-autotrader/core.ts"
replace_required(
    core,
    "// v7.1: the approved holding deadline is always a hard exit boundary, including SCALP.\n"
    "  // Losses may not be extended beyond the signal's 180/300-second lifetime.",
    "// v7.1.1: LOB_SCALP passes allowTimeExit=false. The 180-second value is a\n"
    "  // review horizon, never a forced liquidation deadline.",
)

autotrader = "supabase/functions/market-autotrader/index.ts"
replace_required(autotrader, f"Trading-booooo v{OLD_RELEASE}", f"Trading-booooo v{RELEASE}")
replace_required(autotrader, f'const VERSION = "{OLD_RELEASE}"', f'const VERSION = "{RELEASE}"')
replace_required(
    autotrader,
    'strategy_revision: "7.0.7-LOB-SCAN-PLAN-LOCK",',
    f'strategy_revision: "{RELEASE}",',
)
replace_required(
    autotrader,
    'finite((settings as any).lob_max_holding_seconds, 300)',
    'finite((settings as any).lob_max_holding_seconds, 180)',
    minimum=2,
)
replace_required(
    autotrader,
    'finite(position.metadata?.lob_signal?.max_holding_seconds, 300)',
    'finite(position.metadata?.lob_signal?.max_holding_seconds, 180)',
)
replace_required(
    autotrader,
    "    const stopPct = Math.min(0.05, decision.stopBps / 10000);\n"
    "    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, \"down\");",
    "    // The model stop remains available for entry EV, but execution uses the user's\n"
    "    // single hard-loss boundary. No tighter LOB stop may liquidate a losing position.\n"
    "    const stopPct = 0.05;\n"
    "    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, \"down\");",
)
replace_required(
    autotrader,
    "    if (decision.decision !== \"BUY\") {\n"
    "      await event(\n"
    "        \"LOB_CANDIDATE_DISCARD\",",
    "    // v7.1.1: FIXED_PLAN_STOP_INVALIDATED was a scanner/autotrader contract mismatch.\n"
    "    // Ignore that code only when it is the sole blocker and the live recheck still has\n"
    "    // a primary pattern, positive conditional EV and positive fee-net target.\n"
    "    const effectiveRecheckReasons = decision.reasons.filter((reason) =>\n"
    "      reason !== \"FIXED_PLAN_STOP_INVALIDATED\"\n"
    "    );\n"
    "    const fixedPlanCompatibilityEntry = decision.decision !== \"BUY\" &&\n"
    "      effectiveRecheckReasons.length === 0 &&\n"
    "      Boolean(decision.pattern) &&\n"
    "      decision.conditionalEvNetBps > 0 &&\n"
    "      decision.targetReturnNetBps > 0;\n"
    "    if (decision.decision !== \"BUY\" && !fixedPlanCompatibilityEntry) {\n"
    "      await event(\n"
    "        \"LOB_CANDIDATE_DISCARD\",",
)
replace_required(
    autotrader,
    "      const scalpMode = isScalpStrategy((settings as any).strategy);\n"
    "      // v5.12: TIMEOUT is one of the modelled barrier outcomes. Live edge may close the\n"
    "      // position earlier, but the approved strategy profile always enforces max_holding_at.\n"
    "      let decision = decideExit(\n"
    "        position,\n"
    "        current,\n"
    "        Date.now(),\n"
    "        settings.emergency_liquidation,\n"
    "        true,\n"
    "      );",
    "      const scalpMode = isScalpStrategy((settings as any).strategy);\n"
    "      const lobMode = isLobStrategy((settings as any).strategy);\n"
    "      const lobEntryPrice = finite(position.average_entry_price);\n"
    "      // Fee-aware positive exit floor: round-trip fees plus a 2bp execution buffer.\n"
    "      const lobProfitFloorPrice = lobEntryPrice > 0\n"
    "        ? lobEntryPrice * (1 + (FEE_PCT[exchange] * 2 + 0.02) / 100)\n"
    "        : Number.POSITIVE_INFINITY;\n"
    "      // The 180-second LOB horizon is a review point, not a timeout.\n"
    "      let decision = decideExit(\n"
    "        position,\n"
    "        current,\n"
    "        Date.now(),\n"
    "        settings.emergency_liquidation,\n"
    "        !lobMode,\n"
    "      );\n"
    "      // LOB losses may only close at the explicit -5% boundary. Target/trail/other\n"
    "      // ordinary exits are accepted only after estimated round-trip costs are recovered.\n"
    "      if (lobMode && decision.action !== \"NONE\" && !settings.emergency_liquidation) {\n"
    "        const hardStopHit = lobEntryPrice > 0 && current <= lobEntryPrice * 0.95;\n"
    "        const profitReady = current >= lobProfitFloorPrice;\n"
    "        if (!hardStopHit && !profitReady) {\n"
    "          decision = { action: \"NONE\", fraction: 0, reason: \"lob hold until profit or -5%\" };\n"
    "        }\n"
    "      }",
)
replace_required(
    autotrader,
    "        decision.action === \"NONE\" && position.metadata?.rotation_displaced_at &&\n"
    "        !settings.emergency_liquidation",
    "        decision.action === \"NONE\" && position.metadata?.rotation_displaced_at &&\n"
    "        !settings.emergency_liquidation && !lobMode",
)
replace_required(
    autotrader,
    "        isLobStrategy((settings as any).strategy) && decision.action === \"NONE\" &&",
    "        lobMode && decision.action === \"NONE\" &&",
)
replace_required(
    autotrader,
    "        if (exit.exit) {\n"
    "          decision = {",
    "        const lobExitSafetyReason = exit.reason === \"RISK_EMERGENCY\" ||\n"
    "          exit.reason === \"RECONCILIATION_FAILURE\" ||\n"
    "          exit.reason === \"STOP_HIT\";\n"
    "        const lobExitProfitReady = current >= lobProfitFloorPrice;\n"
    "        if (exit.exit && (lobExitSafetyReason || lobExitProfitReady)) {\n"
    "          decision = {",
)

exit_path = Path("supabase/functions/_shared/lob/exit.ts")
exit_path.write_text('''// Trading-booooo v7.1.1 — LOB exit policy: profit opportunity or -5% hard stop.\n// The 180-second horizon is informational only and never forces a losing exit.\n\nexport type LobExitReason =\n  | "RISK_EMERGENCY"\n  | "RECONCILIATION_FAILURE"\n  | "STOP_HIT"\n  | "LOB_INVALIDATION"\n  | "SIGNAL_REVERSAL"\n  | "TARGET_HIT"\n  | "TIMEOUT"\n  | "HOLD";\n\nexport interface LobExitInput {\n  emergency: boolean;\n  reconciliationFailed: boolean;\n  currentPrice: number;\n  stopPrice: number;\n  targetPrice: number;\n  heldSeconds: number;\n  maxHoldingSeconds: number;\n  bookImbalance: number;\n  tradePressure: number;\n  micropriceDeviationBps: number;\n  spreadBps: number;\n  maxSpreadBps: number;\n  bidDepthRatio: number;\n  minBidDepthRatio: number;\n  dynamicStatus?: string;\n  previousSoftReason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;\n  softSignalStreak?: number;\n  softExitConfirmations?: number;\n  softExitGraceSeconds?: number;\n}\n\nexport interface LobExitDecision {\n  exit: boolean;\n  reason: LobExitReason;\n  priority: number;\n  nextSoftReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;\n  nextSoftSignalStreak: number;\n  severeSoftSignal: boolean;\n}\n\nfunction hold(input: {\n  reason?: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null;\n  streak?: number;\n  severe?: boolean;\n} = {}): LobExitDecision {\n  return {\n    exit: false,\n    reason: "HOLD",\n    priority: 0,\n    nextSoftReason: input.reason ?? null,\n    nextSoftSignalStreak: Math.max(0, Math.floor(Number(input.streak) || 0)),\n    severeSoftSignal: Boolean(input.severe),\n  };\n}\n\nexport function evaluateLobExit(input: LobExitInput): LobExitDecision {\n  const hard = (reason: LobExitReason, priority: number): LobExitDecision => ({\n    exit: true,\n    reason,\n    priority,\n    nextSoftReason: null,\n    nextSoftSignalStreak: 0,\n    severeSoftSignal: false,\n  });\n\n  if (input.emergency) return hard("RISK_EMERGENCY", 100);\n  if (input.reconciliationFailed) return hard("RECONCILIATION_FAILURE", 95);\n  if (Number.isFinite(input.stopPrice) && input.stopPrice > 0 && input.currentPrice <= input.stopPrice) {\n    return hard("STOP_HIT", 90);\n  }\n  if (Number.isFinite(input.targetPrice) && input.targetPrice > 0 && input.currentPrice >= input.targetPrice) {\n    return hard("TARGET_HIT", 85);\n  }\n\n  const invalidStatus = new Set([\n    "SUPPORT_BREAKDOWN_RISK",\n    "SPOOF_LIKE_RISK",\n    "ASK_ABSORPTION_RISK",\n  ]);\n  const invalidated = invalidStatus.has(String(input.dynamicStatus || "")) ||\n    input.spreadBps > input.maxSpreadBps ||\n    input.bidDepthRatio < input.minBidDepthRatio;\n  const reversed = input.bookImbalance <= -0.20 &&\n    input.tradePressure <= -0.20 &&\n    input.micropriceDeviationBps < 0;\n  const softReason: "LOB_INVALIDATION" | "SIGNAL_REVERSAL" | null = invalidated\n    ? "LOB_INVALIDATION"\n    : reversed\n    ? "SIGNAL_REVERSAL"\n    : null;\n\n  if (softReason) {\n    const nextStreak = input.previousSoftReason === softReason\n      ? Math.max(0, Math.floor(Number(input.softSignalStreak) || 0)) + 1\n      : 1;\n    const confirmations = Math.max(1, Math.floor(Number(input.softExitConfirmations) || 2));\n    const graceSeconds = Math.max(0, Number(input.softExitGraceSeconds) || 15);\n    const severe = input.spreadBps > input.maxSpreadBps * 2 ||\n      input.bidDepthRatio < input.minBidDepthRatio * 0.25 ||\n      (input.bookImbalance <= -0.65 && input.tradePressure <= -0.65 && input.micropriceDeviationBps < 0);\n    if (severe || (input.heldSeconds >= graceSeconds && nextStreak >= confirmations)) {\n      return hard(softReason, severe ? 82 : 78);\n    }\n    return hold({ reason: softReason, streak: nextStreak, severe });\n  }\n\n  // Deliberately no TIMEOUT branch. Continue holding after 180 seconds until a fee-net\n  // profitable exit is available or the configured -5% hard stop is reached.\n  return hold();\n}\n''')

migration = Path("supabase/migrations/20260731033000_scalp_v7_1_0_risk_and_holding.sql")
migration.write_text("""do $$\nbegin\n  if to_regclass('public.trading_settings') is null then return; end if;\n  update public.trading_settings\n  set scalp_daily_loss_pct = 20,\n      scalp_max_single_loss_pct = 5,\n      lob_observation_window_ms = 45000,\n      lob_max_holding_seconds = 180,\n      lob_absolute_max_holding_seconds = 180,\n      lob_momentum_max_holding_seconds = 180,\n      lob_rotation_enabled = false,\n      version = coalesce(version, 0) + 1,\n      updated_at = now()\n  where id = 1;\nend $$;\n""")

checks = {
    scanner: [f"Market Scanner v{RELEASE}", "REQUIRED_PER_MARKET_OBSERVATION_MS = 45_000"],
    engine: [f'ENGINE_VERSION = "{RELEASE}"', "maxHoldingSeconds, 180", "absoluteMaxHoldingSeconds: 180"],
    entry: ["minObservationMs: 45_000", "maxHoldingSeconds: 180"],
    autotrader: [
        f'const VERSION = "{RELEASE}"',
        "const lobMode = isLobStrategy",
        "!lobMode,",
        "lob hold until profit or -5%",
        "fixedPlanCompatibilityEntry",
        "const stopPct = 0.05",
        "lobExitProfitReady",
    ],
    core: ["LOB_SCALP passes allowTimeExit=false"],
    str(exit_path): ["Deliberately no TIMEOUT branch", "return hold();"],
}
for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"{path}: missing verification marker {needle!r}")
