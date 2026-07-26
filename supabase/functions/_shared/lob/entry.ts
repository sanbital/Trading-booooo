import { scoreHotSymbol } from "./hot-symbol.ts";
import { detectLobPatterns } from "./patterns.ts";
import type {
  LobCostEstimate,
  LobEntryConfig,
  LobEntryDecision,
  LobFeatureVector,
} from "./types.ts";

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

export const DEFAULT_LOB_ENTRY_CONFIG: LobEntryConfig = {
  minSamples: 8,
  maxBookAgeMs: 2500,
  maxSpreadBps: 30,
  minHotnessScore: 25,
  minPrimaryPatternConfidence: 0.48,
  minNetProfitBps: 0.5,
  minEvBps: 0.01,
  minTargetBps: 8,
  maxTargetBps: 120,
  minStopBps: 6,
  maxStopBps: 500, // user's absolute per-trade ceiling is enforced separately at 5%
  maxHoldingSeconds: 180,
  absoluteMaxHoldingSeconds: 300,
  uncertaintyHaircut: 0.08,
};

/**
 * LOB-only entry decision. pWin and pFill are diagnostics/ranking inputs, not independent
 * hard gates. The economic hard gate is net EV > 0 after fees and expected slippage.
 */
export function evaluateLobEntry(
  features: LobFeatureVector,
  costs: LobCostEstimate,
  overrides: Partial<LobEntryConfig> = {},
): LobEntryDecision {
  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };
  const reasons: string[] = [];
  const hotness = scoreHotSymbol(features);
  const patterns = detectLobPatterns(features);
  const primary = patterns.find((p) => p.primary && p.confidence >= cfg.minPrimaryPatternConfidence) || null;

  if (features.samples < cfg.minSamples) reasons.push("INSUFFICIENT_LOB_SAMPLES");
  if (features.bookAgeMs == null || features.bookAgeMs > cfg.maxBookAgeMs) reasons.push("STALE_ORDERBOOK");
  if (features.spreadBps == null || features.spreadBps > cfg.maxSpreadBps) reasons.push("SPREAD_TOO_WIDE");
  if (features.spoofLikeScore >= 0.85) reasons.push("SPOOF_LIKE_BOOK");
  if (hotness.hotnessScore < cfg.minHotnessScore) reasons.push("BOOK_NOT_HOT_ENOUGH");
  if (!primary) reasons.push("NO_PRIMARY_LOB_PATTERN");

  const patternConfidence = primary?.confidence ?? 0;
  const activity = hotness.activityScore / 100;
  const trendAssist = clamp(features.trendContext, -1, 1) * 0.025; // auxiliary only; never a veto
  const rawTargetProbability = 0.34 + patternConfidence * 0.34 + activity * 0.13 +
    clamp(features.ofiPersistence, 0, 1) * 0.08 + trendAssist;
  const resolveProbability = clamp(
    0.45 + activity * 0.25 + patternConfidence * 0.20 + clamp(features.tradeArrivalRate / 10, 0, 1) * 0.10,
    0.25,
    0.97,
  );
  const pTarget = Math.min(resolveProbability, clamp(rawTargetProbability, 0.18, 0.82));
  const pTimeout = 1 - resolveProbability;
  const pStop = resolveProbability - pTarget;
  const pFill = clamp(
    0.30 + hotness.tradabilityScore / 100 * 0.48 + clamp(features.depthRatio / 3, 0, 1) * 0.12 -
      clamp((features.spreadBps || 0) / 50, 0, 1) * 0.10,
    0.05,
    0.99,
  );

  const totalTargetCostBps = Math.max(0, costs.roundTripFeeBps + costs.entrySlippageBps + costs.targetExitSlippageBps);
  const totalStopCostBps = Math.max(0, costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps);
  const movementBps = 6 + patternConfidence * 62 + activity * 26 +
    Math.abs(features.micropriceDeviationBps) * 0.8 + Math.max(0, features.spreadBps || 0) * 0.35;
  const targetBps = clamp(
    Math.max(cfg.minTargetBps, totalTargetCostBps + cfg.minNetProfitBps, movementBps),
    cfg.minTargetBps,
    cfg.maxTargetBps,
  );
  const stopBps = clamp(
    Math.max(cfg.minStopBps, targetBps * (0.55 + (1 - patternConfidence) * 0.35)),
    cfg.minStopBps,
    cfg.maxStopBps,
  );
  const targetReturnNetBps = targetBps - totalTargetCostBps;
  const stopReturnNetBps = -(stopBps + totalStopCostBps);
  const timeoutReturnNetBps = -(costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps) * 0.75;
  const evNetBps = pFill * (
    pTarget * targetReturnNetBps + pStop * stopReturnNetBps + pTimeout * timeoutReturnNetBps
  );

  // A light, deterministic uncertainty haircut avoids pretending the point estimate is exact
  // while preserving the user's instruction not to add unrelated statistical entry gates.
  const conservativePTarget = clamp(pTarget - cfg.uncertaintyHaircut, 0, 1);
  const redistributed = Math.max(0, resolveProbability - conservativePTarget);
  const evLowerBoundBps = pFill * (
    conservativePTarget * targetReturnNetBps + redistributed * stopReturnNetBps +
      pTimeout * timeoutReturnNetBps
  );

  if (!(targetReturnNetBps > 0)) reasons.push("TARGET_NET_PROFIT_NOT_POSITIVE");
  if (!(evLowerBoundBps > cfg.minEvBps)) reasons.push("NET_EV_NOT_POSITIVE");

  const technicalBlock = reasons.some((r) => [
    "INSUFFICIENT_LOB_SAMPLES",
    "STALE_ORDERBOOK",
    "SPREAD_TOO_WIDE",
    "SPOOF_LIKE_BOOK",
  ].includes(r));
  const decision = reasons.length === 0 ? "BUY" : technicalBlock ? "AVOID" : "WAIT";

  return {
    decision,
    pattern: primary?.name ?? null,
    patterns,
    hotness,
    pTarget,
    pStop,
    pTimeout,
    pFill,
    targetBps,
    stopBps,
    targetReturnNetBps,
    stopReturnNetBps,
    timeoutReturnNetBps,
    evNetBps,
    evLowerBoundBps,
    maxHoldingSeconds: Math.min(cfg.absoluteMaxHoldingSeconds, Math.max(1, cfg.maxHoldingSeconds)),
    reasons,
    features,
  };
}
