import { scoreHotSymbol } from "./hot-symbol.ts";
import { detectLobPatterns } from "./patterns.ts";
import { assessLobTraps, type LobTrapName } from "./traps.ts";
import { evaluateEntryPayoff } from "./payoff-governor.ts";
import { resolveLobUncertaintyHaircut } from "./uncertainty.ts";
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
  maxStopToTargetRatio: 1.35,
  minNetRewardRiskRatio: 0.80,
  minTargetBps: 12,
  // A 180-second scalp cannot use the old 120bp swing-like ceiling. Verified live trades had
  // a 5.3bp median MFE and only 19.6% ever printed 40bp, while the old target averaged 75bp.
  maxTargetBps: 60,
  minStopBps: 6,
  maxStopBps: 500, // user's absolute per-trade ceiling is enforced separately at 5%
  maxHoldingSeconds: 180,
  absoluteMaxHoldingSeconds: 300,
  uncertaintyHaircut: 0.25,
  trap: {},
  disabledVetoes: [],
  patternProbabilityMultiplier: 1,
  measuredMakerFillRate: 0,
  makerFillSamples: 0,
  makerFillPriorStrength: 60,
  learnedStopFloorBps: 0,
};

/** Largest amount coherent order-flow evidence may move probability off pure geometry. */
const MAX_SIGNAL_EDGE = 0.24;

/**
 * Shrink the book-derived fill probability toward the exchange's realized maker fill rate.
 */
export function calibrateMakerFillProbability(
  rawProbability: number,
  measuredRate: number,
  samples: number,
  priorStrength = 60,
): { probability: number; weight: number } {
  const raw = clamp(rawProbability, 0.05, 0.99);
  const n = Math.max(0, Number.isFinite(samples) ? samples : 0);
  if (!(n > 0) || !Number.isFinite(measuredRate)) {
    return { probability: raw, weight: 0 };
  }
  const prior = Math.max(1, Number.isFinite(priorStrength) ? priorStrength : 60);
  const weight = n / (n + prior);
  const probability = raw * (1 - weight) + clamp(measuredRate, 0.01, 0.99) * weight;
  return { probability: clamp(probability, 0.05, 0.99), weight };
}

/**
 * LOB-only entry decision.
 *
 * v6.12.4 fixes three live-measured defects:
 *
 * 1. Target geometry used `abs(microprice)`, so a sharply bearish microprice increased the
 *    LONG target. Geometry now uses only directionally favourable evidence and is capped for
 *    the 180-second horizon.
 * 2. Activity previously added directly to LONG probability. Activity now controls whether
 *    the bracket resolves inside the horizon; signed tape/book evidence controls direction.
 * 3. `pTarget = min(resolveProbability, conditionalTargetShare)` confused an unconditional
 *    probability with a conditional share. The correct decomposition is
 *    `pTarget = pResolve * p(Target | resolved)` and likewise for the stop.
 *
 * The economic hard gate remains fee-net EV > 0 after slippage, latency and forecast bias.
 */
export function evaluateLobEntry(
  features: LobFeatureVector,
  costs: LobCostEstimate,
  overrides: Partial<LobEntryConfig> = {},
): LobEntryDecision {
  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };
  const reasons: string[] = [];
  const warnings: string[] = [];
  const hotness = scoreHotSymbol(features);
  const rawPatterns = detectLobPatterns(features);

  const latencyBps = Math.max(
    0,
    Number.isFinite(costs.latencyPenaltyBps as number) ? costs.latencyPenaltyBps as number : 0,
  );
  const totalTargetCostBps = Math.max(
    0,
    costs.roundTripFeeBps + costs.entrySlippageBps + costs.targetExitSlippageBps + latencyBps,
  );
  const totalStopCostBps = Math.max(
    0,
    costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps + latencyBps * 2,
  );

  const provisionalPatternConfidence = rawPatterns[0]?.confidence ?? 0;
  const provisionalActivity = hotness.activityScore / 100;
  const positivePressure = clamp(features.tradePressureFast, 0, 1);
  const positiveMicroprice = clamp(features.micropriceDeviationBps / 8, 0, 1);
  const positiveBook = clamp(features.bookImbalance, 0, 1);
  const directionalConsensus = (positivePressure + positiveMicroprice + positiveBook) / 3;

  // Live MFE shows a 75bp average target was unreachable for this horizon. Use an executable
  // 30–50bp family for ordinary strong books, while costs can still raise the gross floor.
  const movementBps = 10 + provisionalPatternConfidence * 22 +
    clamp(features.dataQuality, 0, 1) * 10 + directionalConsensus * 10 +
    provisionalActivity * 6 + clamp(features.ofiPersistence, 0, 1) * 4 +
    Math.max(0, features.spreadBps || 0) * 0.15;
  const targetBps = clamp(
    Math.max(cfg.minTargetBps, totalTargetCostBps + cfg.minNetProfitBps, movementBps),
    cfg.minTargetBps,
    cfg.maxTargetBps,
  );
  // The old 55–90% stop/target ratio made average losses too large for a fee-heavy scalp.
  // Confidence now earns a tighter planned stop, while noise, costs and learned winner MAE may
  // widen it below. The database additionally enforces tick-executable geometry.
  const provisionalStopBps = clamp(
    Math.max(cfg.minStopBps, targetBps * (0.38 + (1 - provisionalPatternConfidence) * 0.22)),
    cfg.minStopBps,
    cfg.maxStopBps,
  );

  const traps = assessLobTraps(
    {
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
    },
    provisionalStopBps,
    cfg.trap,
  );

  const microstructureStopFloorBps = Math.max(
    cfg.minStopBps,
    Math.max(0, costs.spreadBps) * 2,
    totalStopCostBps * 1.25,
    Math.max(0, cfg.learnedStopFloorBps),
  );
  const stopBps = clamp(
    Math.max(provisionalStopBps, traps.requiredStopBps, microstructureStopFloorBps),
    cfg.minStopBps,
    cfg.maxStopBps,
  );

  const disabled = new Set(cfg.disabledVetoes as LobTrapName[]);
  const activeVetoes = traps.vetoes.filter((name) => !disabled.has(name));
  const patterns = rawPatterns.map((pattern) => ({
    ...pattern,
    confidence: clamp(pattern.confidence * traps.confidenceMultiplier, 0, 1),
  })).sort((left, right) => right.confidence - left.confidence);
  const primary =
    patterns.find((p) => p.primary && p.confidence >= cfg.minPrimaryPatternConfidence) || null;

  if (features.samples < cfg.minSamples) reasons.push("INSUFFICIENT_LOB_SAMPLES");
  if (features.bookAgeMs == null || features.bookAgeMs > cfg.maxBookAgeMs) {
    reasons.push("STALE_ORDERBOOK");
  }
  if (features.spreadBps == null || features.spreadBps > cfg.maxSpreadBps) {
    reasons.push("SPREAD_TOO_WIDE");
  }
  for (const name of activeVetoes) reasons.push(`TRAP_${name}`);
  if (hotness.hotnessScore < cfg.minHotnessScore) reasons.push("BOOK_NOT_HOT_ENOUGH");
  if (!primary) reasons.push("NO_PRIMARY_LOB_PATTERN");

  const patternConfidence = primary?.confidence ?? 0;
  const activity = hotness.activityScore / 100;
  const signedPressure = clamp(features.tradePressureFast, -1, 1);
  const signedMicroprice = clamp(features.micropriceDeviationBps / 8, -1, 1);
  const signedBook = clamp(features.bookImbalance, -1, 1);
  const signedOfi = clamp(features.ofiPersistence, 0, 1) * (signedPressure >= 0 ? 1 : -1);
  const qualityEdge = (clamp(features.dataQuality, 0, 1) - 0.35) * 0.05;
  const trendAssist = clamp(features.trendContext, -1, 1) * 0.02;

  // Geometry is arithmetic; the signal contributes only a bounded, signed displacement.
  const neutralWinRate = targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;
  const rawSignalEdge = (patternConfidence - 0.45) * 0.20 + signedPressure * 0.08 +
    signedMicroprice * 0.05 + signedBook * 0.05 + signedOfi * 0.04 + qualityEdge +
    trendAssist + clamp(features.fundingEdge, -0.03, 0.03);
  const signalEdge = clamp(
    rawSignalEdge * clamp(cfg.patternProbabilityMultiplier, 0.3, 2) * traps.confidenceMultiplier,
    -MAX_SIGNAL_EDGE,
    MAX_SIGNAL_EDGE,
  );

  // Activity determines whether either barrier resolves during the 180-second horizon. It no
  // longer creates a bullish directional edge merely because the tape is busy.
  const resolveProbability = clamp(
    0.40 + activity * 0.22 + patternConfidence * 0.18 +
      clamp(features.tradeArrivalRate / 10, 0, 1) * 0.08 +
      clamp(features.dataQuality, 0, 1) * 0.12,
    0.25,
    0.95,
  );
  const conditionalTargetShare = clamp(neutralWinRate + signalEdge, 0.05, 0.92);
  const pTarget = resolveProbability * conditionalTargetShare;
  const pStop = resolveProbability * (1 - conditionalTargetShare);
  const pTimeout = 1 - resolveProbability;

  const rawPFill = clamp(
    0.30 + hotness.tradabilityScore / 100 * 0.48 + clamp(features.depthRatio / 3, 0, 1) * 0.12 -
      clamp((features.spreadBps || 0) / 50, 0, 1) * 0.10,
    0.05,
    0.99,
  );
  const fillCalibration = calibrateMakerFillProbability(
    rawPFill,
    cfg.measuredMakerFillRate,
    cfg.makerFillSamples,
    cfg.makerFillPriorStrength,
  );
  const pFill = fillCalibration.probability;

  const targetReturnNetBps = targetBps - totalTargetCostBps;
  const stopReturnNetBps = -(stopBps + totalStopCostBps);
  const payoff = evaluateEntryPayoff({
    targetBps,
    stopBps,
    targetReturnNetBps,
    stopReturnNetBps,
    minNetProfitBps: cfg.minNetProfitBps,
    maxStopToTargetRatio: cfg.maxStopToTargetRatio,
    minNetRewardRiskRatio: cfg.minNetRewardRiskRatio,
  });
  const timeoutReturnNetBps = -(
    costs.roundTripFeeBps + costs.entrySlippageBps + costs.stopExitSlippageBps +
    Math.max(0, Number(costs.latencyPenaltyBps || 0))
  );
  const forecastBiasPenaltyBps = Math.max(
    0,
    Number.isFinite(costs.forecastBiasPenaltyBps as number)
      ? costs.forecastBiasPenaltyBps as number
      : 0,
  );
  const conditionalEvNetBps =
    pTarget * targetReturnNetBps + pStop * stopReturnNetBps + pTimeout * timeoutReturnNetBps -
    forecastBiasPenaltyBps;
  const attemptEvNetBps = pFill * conditionalEvNetBps;
  const evNetBps = conditionalEvNetBps;

  const uncertainty = resolveLobUncertaintyHaircut(
    features,
    clamp(cfg.uncertaintyHaircut, 0, 0.9),
  );
  const conservativeEdge = signalEdge * (1 - uncertainty.haircut);
  if (uncertainty.tier !== "BASE") {
    warnings.push(`EVIDENCE_UNCERTAINTY_${uncertainty.tier}`);
  }
  const conservativeConditionalTargetShare = clamp(
    neutralWinRate + conservativeEdge,
    0.02,
    0.92,
  );
  const conservativePTarget = resolveProbability * conservativeConditionalTargetShare;
  const conservativePStop = resolveProbability * (1 - conservativeConditionalTargetShare);
  const conditionalEvLowerBoundBps =
    conservativePTarget * targetReturnNetBps + conservativePStop * stopReturnNetBps +
    pTimeout * timeoutReturnNetBps - forecastBiasPenaltyBps;
  const attemptEvLowerBoundBps = pFill * conditionalEvLowerBoundBps;
  const evLowerBoundBps = conditionalEvLowerBoundBps;

  for (const reason of payoff.reasons) reasons.push(reason);
  for (const warning of payoff.warnings) warnings.push(warning);
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
    rawPFill,
    fillCalibrationWeight: fillCalibration.weight,
    targetBps,
    stopBps,
    targetReturnNetBps,
    stopReturnNetBps,
    timeoutReturnNetBps,
    stopToTargetRatio: payoff.stopToTargetRatio,
    netRewardRiskRatio: payoff.netRewardRiskRatio,
    minimumTargetNetProfitBps: cfg.minNetProfitBps,
    minimumVerifiedEvBps: cfg.minEvBps,
    conditionalEvNetBps,
    conditionalEvLowerBoundBps,
    attemptEvNetBps,
    attemptEvLowerBoundBps,
    evNetBps,
    evLowerBoundBps,
    forecastBiasPenaltyBps,
    maxHoldingSeconds: Math.min(cfg.absoluteMaxHoldingSeconds, Math.max(1, cfg.maxHoldingSeconds)),
    reasons,
    warnings,
    features,
    traps,
    noiseAdjustedStopBps: stopBps,
  };
}

/** Exposed so callers can record what the barriers implied, alongside the model's belief. */
export function neutralWinRateOf(targetBps: number, stopBps: number): number {
  return targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;
}
