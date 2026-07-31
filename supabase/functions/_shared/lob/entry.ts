import { scoreHotSymbol } from "./hot-symbol.ts";
import { detectLobPatterns } from "./patterns.ts";
import { assessLobTraps } from "./traps.ts";
import type {
  LobCostEstimate,
  LobEntryConfig,
  LobEntryDecision,
  LobFeatureVector,
} from "./types.ts";

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_LOB_ENTRY_CONFIG: LobEntryConfig = {
  minSamples: 4,
  // Every candidate must be judged from a full 50-second live book/tape window.
  minObservationMs: 50_000,
  maxBookAgeMs: 5_000,
  maxSpreadBps: 60,
  minHotnessScore: 0,
  minPrimaryPatternConfidence: 0,
  minNetProfitBps: 0,
  minEvBps: 0,
  maxStopToTargetRatio: 100,
  minNetRewardRiskRatio: 0,
  minTargetBps: 12,
  maxTargetBps: 80,
  minStopBps: 6,
  maxStopBps: 500,
  // 180 seconds changes exit behaviour. It is not a forced holding deadline.
  maxHoldingSeconds: 180,
  absoluteMaxHoldingSeconds: 0,
  uncertaintyHaircut: 0,
  trap: {},
  disabledVetoes: [
    "ASK_ICEBERG",
    "BID_SPOOF",
    "ASK_SPOOF",
    "CHOP_NO_VIABLE_STOP",
    "QUOTE_FLICKER",
  ],
  patternProbabilityMultiplier: 1,
  measuredMakerFillRate: 0,
  makerFillSamples: 0,
  makerFillPriorStrength: 60,
  learnedStopFloorBps: 0,
};

/**
 * Shrink a raw maker-fill estimate toward measured execution history.
 * This is retained only for execution diagnostics and never blocks BUY.
 */
export function calibrateMakerFillProbability(
  rawProbability: number,
  measuredRate: number,
  samples: number,
  priorStrength = 60,
): { probability: number; weight: number } {
  const raw = clamp(rawProbability, 0.05, 0.99);
  const n = Math.max(0, finite(samples));
  if (!(n > 0) || !Number.isFinite(measuredRate)) {
    return { probability: raw, weight: 0 };
  }
  const prior = Math.max(1, finite(priorStrength, 60));
  const weight = n / (n + prior);
  return {
    probability: clamp(raw * (1 - weight) + clamp(measuredRate, 0.01, 0.99) * weight, 0.05, 0.99),
    weight,
  };
}

/**
 * Pure Top-10 order-book entry gate.
 *
 * BUY is decided only from the current 50-second order book and tape. EV, market regime,
 * candle trend, learned pattern profitability, cross-exchange disagreement and payoff
 * geometry are not admission gates. Operational validity, freshness, spread and executable
 * depth remain because an order cannot be placed safely without them.
 */
export function evaluateLobEntry(
  features: LobFeatureVector,
  costs: LobCostEstimate,
  overrides: Partial<LobEntryConfig> = {},
): LobEntryDecision {
  const cfg = { ...DEFAULT_LOB_ENTRY_CONFIG, ...overrides };
  // User policy is authoritative even when an old runtime profile still contains stricter values.
  cfg.minObservationMs = 50_000;
  cfg.minEvBps = 0;
  cfg.minNetProfitBps = 0;
  cfg.minPrimaryPatternConfidence = 0;
  cfg.minHotnessScore = 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const hotness = scoreHotSymbol(features);
  const patterns = detectLobPatterns(features);
  const primary = patterns.find((pattern) => pattern.primary) ?? patterns[0] ?? null;

  const rawFixedTargetBps = finite(cfg.fixedTargetBps, 0);
  const rawFixedStopBps = finite(cfg.fixedStopBps, 0);
  const targetCostBps = Math.max(
    0,
    finite(costs.roundTripFeeBps) + finite(costs.entrySlippageBps) +
      finite(costs.targetExitSlippageBps) + finite(costs.latencyPenaltyBps),
  );
  const stopCostBps = Math.max(
    0,
    finite(costs.roundTripFeeBps) + finite(costs.entrySlippageBps) +
      finite(costs.stopExitSlippageBps) + finite(costs.latencyPenaltyBps) * 2,
  );
  const targetBps = rawFixedTargetBps > 0
    ? rawFixedTargetBps
    : clamp(Math.max(cfg.minTargetBps, targetCostBps + 2), cfg.minTargetBps, cfg.maxTargetBps);
  // The actual absolute loss boundary is -5% in the autotrader exit path.
  const stopBps = rawFixedStopBps > 0
    ? rawFixedStopBps
    : 500;

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
    stopBps,
    cfg.trap,
  );
  for (const trap of traps.traps) warnings.push(`LOB_DIAGNOSTIC_${trap.name}`);

  // Structural and execution checks only.
  if (
    features.universeMode !== "TOP10_24H_GAINERS_LOB_ONLY" ||
    !(finite(features.gainerRank) >= 1 && finite(features.gainerRank) <= 10)
  ) reasons.push("OUTSIDE_24H_GAINER_TOP10");
  if (features.samples < cfg.minSamples) reasons.push("INSUFFICIENT_LOB_SAMPLES");
  if (features.observationMs < 50_000) reasons.push("INSUFFICIENT_50S_OBSERVATION");
  if (features.bookAgeMs == null || features.bookAgeMs > cfg.maxBookAgeMs) reasons.push("STALE_ORDERBOOK");
  if (features.spreadBps == null || features.spreadBps > cfg.maxSpreadBps) reasons.push("SPREAD_TOO_WIDE");
  if (!(features.bidDepthQuote > 0) || !(features.askDepthQuote > 0) || !(features.depthRatio > 0)) {
    reasons.push("UNEXECUTABLE_ORDERBOOK_DEPTH");
  }

  // Present-tense order-book/tape judgement. This intentionally does not depend on the
  // broader market direction, so a falling market can still produce a valid scalp entry.
  const pressure = clamp(finite(features.tradePressureFast), -1, 1);
  const microprice = clamp(finite(features.micropriceDeviationBps) / 8, -1, 1);
  const imbalance = clamp(finite(features.bookImbalance), -1, 1);
  const ofi = clamp(finite(features.ofiPersistence), 0, 1);
  const arrival = Math.max(0, finite(features.tradeArrivalRate));
  const flowScore = pressure * 0.42 + microprice * 0.24 + imbalance * 0.20 + ofi * 0.14;
  const positiveVotes = [
    pressure >= 0.04,
    microprice >= -0.03,
    imbalance >= -0.12,
    ofi >= 0.12,
    features.persistentBidWall,
    features.askSpoofScore >= 0.45,
  ].filter(Boolean).length;
  const orderBookGood = arrival > 0 && positiveVotes >= 3 && flowScore >= -0.015;
  if (!orderBookGood) reasons.push("LOB_FLOW_NOT_BUYABLE_NOW");

  const rawPFill = clamp(
    0.35 + hotness.tradabilityScore / 100 * 0.45 + clamp(features.depthRatio / 3, 0, 1) * 0.15 -
      clamp(finite(features.spreadBps) / Math.max(1, cfg.maxSpreadBps), 0, 1) * 0.10,
    0.05,
    0.99,
  );
  const fillCalibration = calibrateMakerFillProbability(
    rawPFill,
    cfg.measuredMakerFillRate,
    cfg.makerFillSamples,
    cfg.makerFillPriorStrength,
  );
  const pTarget = clamp(0.50 + flowScore * 0.25, 0.20, 0.85);
  const pStop = clamp(1 - pTarget, 0.10, 0.75);
  const pTimeout = 0;
  const targetReturnNetBps = targetBps - targetCostBps;
  const stopReturnNetBps = -(stopBps + stopCostBps);
  const informationalEv = pTarget * targetReturnNetBps + pStop * stopReturnNetBps;
  const decision = reasons.length === 0 ? "BUY" : "WAIT";

  warnings.push("EV_INFORMATIONAL_ONLY");
  warnings.push("PATTERN_INFORMATIONAL_ONLY");
  warnings.push("MARKET_REGIME_IGNORED");

  return {
    decision,
    pattern: primary?.name ?? null,
    patterns,
    hotness,
    pTarget,
    pStop,
    pTimeout,
    pFill: fillCalibration.probability,
    rawPFill,
    fillCalibrationWeight: fillCalibration.weight,
    targetBps,
    stopBps,
    targetReturnNetBps,
    stopReturnNetBps,
    timeoutReturnNetBps: 0,
    stopToTargetRatio: targetBps > 0 ? stopBps / targetBps : 0,
    netRewardRiskRatio: Math.abs(stopReturnNetBps) > 0
      ? Math.max(0, targetReturnNetBps) / Math.abs(stopReturnNetBps)
      : 0,
    minimumTargetNetProfitBps: 0,
    minimumVerifiedEvBps: 0,
    conditionalEvNetBps: informationalEv,
    conditionalEvLowerBoundBps: informationalEv,
    attemptEvNetBps: informationalEv * fillCalibration.probability,
    attemptEvLowerBoundBps: informationalEv * fillCalibration.probability,
    evNetBps: informationalEv,
    evLowerBoundBps: informationalEv,
    forecastBiasPenaltyBps: 0,
    maxHoldingSeconds: 180,
    reasons,
    warnings,
    features,
    traps,
    noiseAdjustedStopBps: stopBps,
  };
}

/** Barrier-neutral probability retained for reporting only. */
export function neutralWinRateOf(targetBps: number, stopBps: number): number {
  return targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;
}
