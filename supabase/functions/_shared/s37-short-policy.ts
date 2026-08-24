import type { P10ExitDecision } from "./p10-policy.ts";

export const S37_SHORT_STRATEGY_KEY = "S37_I46_FIXED_1R_BTC24_BEAR";
export const S37_SHORT_REVISION = "S37-LIVE-1.0.0";

export const S37_SHORT_CONFIG = Object.freeze({
  stopAtr: 1.5,
  targetR: 1.0,
  maxEntryGapAtr: 0.5,
  maxInitialRiskPct: 5.0,
  maxHoldBars: 96,
});

const finite = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export function isS37SignalEvidence(evidence: unknown): boolean {
  const row = evidence && typeof evidence === "object" ? evidence as Record<string, unknown> : {};
  return row.entry_strategy_key === S37_SHORT_STRATEGY_KEY &&
    row.entry_strategy_revision === S37_SHORT_REVISION;
}
export function planS37ShortEntry(referenceClose: number, atr14: number, entryPrice: number) {
  const risk = S37_SHORT_CONFIG.stopAtr * finite(atr14);
  const gapAtr = atr14 > 0 ? Math.abs(entryPrice - referenceClose) / atr14 : Infinity;
  const riskPct = entryPrice > 0 ? risk / entryPrice * 100 : Infinity;
  const allowed = referenceClose > 0 && atr14 > 0 && entryPrice > 0 &&
    gapAtr <= S37_SHORT_CONFIG.maxEntryGapAtr &&
    riskPct <= S37_SHORT_CONFIG.maxInitialRiskPct;
  return {
    allowed,
    reason: allowed
      ? null
      : gapAtr > S37_SHORT_CONFIG.maxEntryGapAtr
      ? `entry gap ${gapAtr.toFixed(4)} ATR exceeds ${S37_SHORT_CONFIG.maxEntryGapAtr}`
      : riskPct > S37_SHORT_CONFIG.maxInitialRiskPct
      ? `initial stop risk ${riskPct.toFixed(4)}% exceeds ${S37_SHORT_CONFIG.maxInitialRiskPct}%`
      : "invalid S37 entry plan",
    side: "SHORT" as const,
    entryPrice,
    initialRisk: risk,
    riskPct,
    stopPrice: entryPrice + risk,
    partialTarget: entryPrice - S37_SHORT_CONFIG.targetR * risk,
    finalTarget: entryPrice - S37_SHORT_CONFIG.targetR * risk,
  };
}

export function evaluateS37ShortExit(input: {
  entryPrice: number;
  initialRisk: number;
  currentStop: number;
  executablePrice: number;
  openedAtMs: number;
  nowMs: number;
  lastPolicyBarTime: number;
  latestCompletedBarTime?: number | null;
}): P10ExitDecision {
  const policyBarTime = Math.max(
    finite(input.lastPolicyBarTime),
    finite(input.latestCompletedBarTime),
  );
  // Stop-first is intentional and matches the research engine's same-bar collision rule.
  if (input.executablePrice >= input.currentStop) {
    return {
      action: "STOP",
      reason: "S37_STOP_1P5_ATR",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  const target = input.entryPrice - S37_SHORT_CONFIG.targetR * input.initialRisk;
  if (input.executablePrice <= target) {
    return {
      action: "TARGET_2",
      reason: "S37_FIXED_1R",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  if (input.nowMs - input.openedAtMs >= S37_SHORT_CONFIG.maxHoldBars * 3_600_000) {
    return {
      action: "TIME",
      reason: "S37_MAX_HOLD_96H",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  return {
    action: "NONE",
    reason: null,
    fraction: 0,
    nextStop: input.currentStop,
    policyBarTime,
  };
}
