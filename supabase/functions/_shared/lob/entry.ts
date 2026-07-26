import { scoreHotSymbol } from "./hot-symbol.ts";
import { detectLobPatterns } from "./patterns.ts";
import { assessLobTraps, type LobTrapName } from "./traps.ts";
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
  minSamples: 4,
  maxBookAgeMs: 5000,
  maxSpreadBps: 60,
  minHotnessScore: 0,
  minPrimaryPatternConfidence: 0.32,
  minNetProfitBps: 0.01,
  minEvBps: 0,
  minTargetBps: 8,
  maxTargetBps: 120,
  minStopBps: 6,
  maxStopBps: 500, // user's absolute per-trade ceiling is enforced separately at 5%
  maxHoldingSeconds: 180,
  absoluteMaxHoldingSeconds: 300,
  uncertaintyHaircut: 0.08,
  trap: {},
  disabledVetoes: [],
  patternProbabilityMultiplier: 1,
};

/** Largest amount the signal is ever allowed to move the probability off pure geometry. */
const MAX_SIGNAL_EDGE = 0.18;

/**
 * LOB-only entry decision.
 *
 * v6.2 corrects the structural error inherited from v6.0: `pTarget` was built from
 * `0.34 + patternConfidence * 0.34 + ...` and the barrier widths were computed afterwards
 * and never fed back into it. Widening the target therefore raised expected value for free,
 * which is the same defect that pulled the previous scalp model toward swing horizons and
 * was fixed there in v5.7. Here the probability starts from the arithmetic the barriers
 * force -- a long with target T and stop S resolves at the target S/(T+S) of the time under
 * a driftless random walk -- and the signal may only add a bounded edge on top.
 *
 * The economic hard gate remains net EV > 0 after real fees and expected slippage.
 */
export function evaluateLobEntry(
  features: LobFeatureVector,
  costs: LobCostEstimate,
  overrides: Partial<LobEntryConfig> = {},
): LobEntryDecision {
  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };
  const reasons: string[] = [];
  const hotness = scoreHotSymbol(features);
  const rawPatterns = detectLobPatterns(features);

  const totalTargetCostBps = Math.max(0, costs.roundTripFeeBps + costs.entrySlippageBps + costs.targetExitSlippageBps);
  const totalStopCostBps = Math.max(0, costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps);

  // Provisional geometry, used only to ask the trap module whether this book's own noise
  // can accommodate the stop the model would otherwise have chosen.
  const provisionalPatternConfidence = rawPatterns[0]?.confidence ?? 0;
  const provisionalActivity = hotness.activityScore / 100;
  const movementBps = 6 + provisionalPatternConfidence * 62 + provisionalActivity * 26 +
    Math.abs(features.micropriceDeviationBps) * 0.8 + Math.max(0, features.spreadBps || 0) * 0.35;
  const targetBps = clamp(
    Math.max(cfg.minTargetBps, totalTargetCostBps + cfg.minNetProfitBps, movementBps),
    cfg.minTargetBps,
    cfg.maxTargetBps,
  );
  const provisionalStopBps = clamp(
    Math.max(cfg.minStopBps, targetBps * (0.55 + (1 - provisionalPatternConfidence) * 0.35)),
    cfg.minStopBps,
    cfg.maxStopBps,
  );

  const traps = assessLobTraps({
    askAbsorptionScore: features.askAbsorptionScore,
    askRefillRatio: features.askRefillRatio,
    bidSpoofScore: features.spoofLikeScore,
    askSpoofScore: features.askSpoofScore,
    pathEfficiency: features.pathEfficiency,
    reversalRate: features.reversalRate,
    noiseBandBps: features.noiseBandBps,
    quoteFlickerRate: features.quoteFlickerRate,
    tradeArrivalRate: features.tradeArrivalRate,
    dataQuality: features.dataQuality,
  }, provisionalStopBps, cfg.trap);

  // A stop inside the book's own noise band is not a risk control, it is a coin flip with a
  // fee attached. Widen it instead of pretending, and let the EV gate reject the trade if
  // the wider stop no longer pays.
  const stopBps = clamp(
    Math.max(provisionalStopBps, traps.requiredStopBps),
    cfg.minStopBps,
    cfg.maxStopBps,
  );

  const disabled = new Set(cfg.disabledVetoes as LobTrapName[]);
  const activeVetoes = traps.vetoes.filter((name) => !disabled.has(name));

  const patterns = rawPatterns.map((pattern) => ({
    ...pattern,
    confidence: clamp(pattern.confidence * traps.confidenceMultiplier, 0, 1),
  })).sort((left, right) => right.confidence - left.confidence);
  const primary = patterns.find((p) => p.primary && p.confidence >= cfg.minPrimaryPatternConfidence) || null;

  if (features.samples < cfg.minSamples) reasons.push("INSUFFICIENT_LOB_SAMPLES");
  if (features.bookAgeMs == null || features.bookAgeMs > cfg.maxBookAgeMs) reasons.push("STALE_ORDERBOOK");
  if (features.spreadBps == null || features.spreadBps > cfg.maxSpreadBps) reasons.push("SPREAD_TOO_WIDE");
  for (const name of activeVetoes) reasons.push(`TRAP_${name}`);
  if (hotness.hotnessScore < cfg.minHotnessScore) reasons.push("BOOK_NOT_HOT_ENOUGH");
  if (!primary) reasons.push("NO_PRIMARY_LOB_PATTERN");

  const patternConfidence = primary?.confidence ?? 0;
  const activity = hotness.activityScore / 100;
  const trendAssist = clamp(features.trendContext, -1, 1) * 0.02; // auxiliary only; never a veto

  // Geometry first. This term cannot be wrong -- it is arithmetic, not a belief.
  const neutralWinRate = targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;

  // The signal may only add a bounded edge, and the learned multiplier scales the edge
  // rather than the probability, so a miscalibrated pattern can never drag the estimate
  // below what the barriers themselves guarantee.
  // Perp positioning enters here and only here: as one bounded term inside the signal edge,
  // subject to the same MAX_SIGNAL_EDGE cap and the same learned multiplier as everything
  // else. It cannot create a trade on its own and it cannot block one.
  const rawSignalEdge = (patternConfidence - 0.35) * 0.24 + activity * 0.09 +
    clamp(features.ofiPersistence, 0, 1) * 0.05 + trendAssist +
    clamp(features.fundingEdge, -0.03, 0.03);
  const signalEdge = clamp(
    rawSignalEdge * clamp(cfg.patternProbabilityMultiplier, 0.3, 2) * traps.confidenceMultiplier,
    -MAX_SIGNAL_EDGE,
    MAX_SIGNAL_EDGE,
  );

  const resolveProbability = clamp(
    0.45 + activity * 0.25 + patternConfidence * 0.20 + clamp(features.tradeArrivalRate / 10, 0, 1) * 0.10,
    0.25,
    0.97,
  );
  const pTarget = Math.min(resolveProbability, clamp(neutralWinRate + signalEdge, 0.05, 0.92));
  const pTimeout = 1 - resolveProbability;
  const pStop = Math.max(0, resolveProbability - pTarget);
  const pFill = clamp(
    0.30 + hotness.tradabilityScore / 100 * 0.48 + clamp(features.depthRatio / 3, 0, 1) * 0.12 -
      clamp((features.spreadBps || 0) / 50, 0, 1) * 0.10,
    0.05,
    0.99,
  );

  const targetReturnNetBps = targetBps - totalTargetCostBps;
  const stopReturnNetBps = -(stopBps + totalStopCostBps);
  const timeoutReturnNetBps = -(costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps) * 0.75;
  const evNetBps = pFill * (
    pTarget * targetReturnNetBps + pStop * stopReturnNetBps + pTimeout * timeoutReturnNetBps
  );

  // The haircut is applied to the signal edge, not to the geometric term, for the same
  // reason: uncertainty lives in the model's beliefs, not in the arithmetic.
  const conservativeEdge = signalEdge - cfg.uncertaintyHaircut;
  const conservativePTarget = Math.min(
    resolveProbability,
    clamp(neutralWinRate + conservativeEdge, 0.02, 0.92),
  );
  const conservativePStop = Math.max(0, resolveProbability - conservativePTarget);
  const evLowerBoundBps = pFill * (
    conservativePTarget * targetReturnNetBps + conservativePStop * stopReturnNetBps +
      pTimeout * timeoutReturnNetBps
  );

  if (!(targetReturnNetBps > 0)) reasons.push("TARGET_NET_PROFIT_NOT_POSITIVE");
  if (!(evLowerBoundBps > cfg.minEvBps)) reasons.push("NET_EV_NOT_POSITIVE");

  const technicalBlock = reasons.some((r) =>
    r.startsWith("TRAP_") || [
      "INSUFFICIENT_LOB_SAMPLES",
      "STALE_ORDERBOOK",
      "SPREAD_TOO_WIDE",
    ].includes(r)
  );
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
    traps,
    noiseAdjustedStopBps: stopBps,
  };
}

/** Exposed so callers can record what the barriers implied, alongside the model's belief. */
export function neutralWinRateOf(targetBps: number, stopBps: number): number {
  return targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;
}
