import { scoreHotSymbol } from "./hot-symbol.ts";
import { MINUTE_ENTRY_GATE_VERSION } from "./minute-entry-gate.ts";
import { detectLobPatterns } from "./patterns.ts";
import { assessLobTraps, DEFAULT_LOB_TRAP_CONFIG } from "./traps.ts";
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

// Operator policy for the high-turnover LOB scalp route.
// The 5% account-protection boundary is an emergency exit owned by the autotrader. It must
// never be used as the ordinary planned loss in scanner reward/risk arithmetic.
const OPERATOR_MIN_TARGET_NET_PROFIT_BPS = 20;
const OPERATOR_MIN_NET_REWARD_RISK_RATIO = 0.25;
const OPERATOR_MAX_STOP_TO_TARGET_RATIO = 4;
const PLANNED_SCALP_STOP_MAX_BPS = 200;
const LEGACY_EMERGENCY_STOP_BPS = 500;
const ECONOMIC_GATE_EPSILON = 1e-9;
/** Continuation families that lost money on live fills; overridable via LobEntryConfig. */
const DEFAULT_BLOCKED_LOB_PATTERNS = ["OFI_CONTINUATION", "MOMENTUM_CONTINUATION"];
/** Worst 24h-gainer rank admitted by default; overridable via LobEntryConfig. */
const DEFAULT_MAX_GAINER_RANK = 3;

export const DEFAULT_LOB_ENTRY_CONFIG: LobEntryConfig = {
  minSamples: 4,
  // Every candidate must be judged from a full 50-second live book/tape window.
  minObservationMs: 50_000,
  maxBookAgeMs: 5_000,
  maxSpreadBps: 60,
  minHotnessScore: 0,
  minPrimaryPatternConfidence: 0,
  minNetProfitBps: OPERATOR_MIN_TARGET_NET_PROFIT_BPS,
  minEvBps: 0,
  maxStopToTargetRatio: OPERATOR_MAX_STOP_TO_TARGET_RATIO,
  minNetRewardRiskRatio: OPERATOR_MIN_NET_REWARD_RISK_RATIO,
  minTargetBps: 12,
  maxTargetBps: 80,
  minStopBps: 6,
  // This remains the absolute emergency boundary. Planned scalp stops are capped separately.
  maxStopBps: LEGACY_EMERGENCY_STOP_BPS,
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
    probability: clamp(
      raw * (1 - weight) + clamp(measuredRate, 0.01, 0.99) * weight,
      0.05,
      0.99,
    ),
    weight,
  };
}

export type LobEntryRiskAssessment = {
  reasons: string[];
  warnings: string[];
  adverseFlowSignals: string[];
  positiveVotes: number;
  flowScore: number;
  bidSpoofThreshold: number;
  askSpoofThreshold: number;
};

/**
 * Admission policy for the failure modes observed in live Top-10 entries.
 *
 * The execution contract is fail-closed: negative aggressive flow and either-side spoof
 * warnings reject a BUY on their own. The same function is used at scan evaluation and at
 * both order-time rechecks so those conditions cannot become informational on one path.
 */
export function assessLobEntryRisk(
  features: LobFeatureVector,
  trapOverrides: LobEntryConfig["trap"] = {},
): LobEntryRiskAssessment {
  const trapCfg = { ...DEFAULT_LOB_TRAP_CONFIG, ...trapOverrides };
  const reasons: string[] = [];
  const warnings: string[] = [];
  const status = String(features.dynamicStatus || "INSUFFICIENT").toUpperCase();
  const pressure = clamp(finite(features.tradePressureFast), -1, 1);
  const micropriceBps = finite(features.micropriceDeviationBps);
  const microprice = clamp(micropriceBps / 8, -1, 1);
  const imbalance = clamp(finite(features.bookImbalance), -1, 1);
  const ofi = clamp(finite(features.ofiPersistence), 0, 1);
  const bidSpoof = clamp(finite(features.spoofLikeScore), 0, 1);
  const askSpoof = clamp(finite(features.askSpoofScore), 0, 1);
  const bidSpoofDetected = bidSpoof >= trapCfg.bidSpoofScore;
  const askSpoofDetected = askSpoof >= trapCfg.askSpoofScore;
  const supportBreakdown = status.includes("SUPPORT_BREAKDOWN");
  const dynamicInsufficient = status.includes("INSUFFICIENT") ||
    clamp(finite(features.dataQuality), 0, 1) < trapCfg.minDataQuality;

  const adverseFlowSignals = [
    finite(features.tradeSpeedTrend) <= -0.20 ? "TRADE_SPEED_DECLINING" : null,
    finite(features.notionalTrend) <= -0.20 ? "FLOW_NOTIONAL_DECLINING" : null,
    pressure < 0 ? "SELL_PRESSURE_DOMINANT" : null,
    micropriceBps < 0 ? "MICROPRICE_BEARISH" : null,
  ].filter((value): value is string => value !== null);

  if (dynamicInsufficient) reasons.push("LOB_DYNAMIC_EVIDENCE_INSUFFICIENT");
  if (supportBreakdown) reasons.push("SUPPORT_BREAKDOWN_RISK");
  if (pressure < 0) reasons.push("NEGATIVE_TRADE_PRESSURE");
  if (bidSpoofDetected || askSpoofDetected) reasons.push("SPOOF_WARNING");
  if (bidSpoofDetected && askSpoofDetected) reasons.push("TWO_SIDED_SPOOF_RISK");

  // A very strong disappearing bid needs one confirming weak-flow sign. At the normal
  // threshold two independent signs are required, avoiding a broad decay-only veto.
  const severeBidSpoofThreshold = Math.max(0.90, trapCfg.bidSpoofScore);
  const bidSpoofConfirmed =
    (bidSpoof >= severeBidSpoofThreshold && adverseFlowSignals.length >= 1) ||
    (bidSpoofDetected && adverseFlowSignals.length >= 2);
  if (bidSpoofConfirmed) reasons.push("BID_SPOOF_CONFIRMED_BY_WEAK_FLOW");

  if (askSpoofDetected && !bidSpoofDetected && !supportBreakdown) {
    warnings.push("ASK_SPOOF");
  }
  if (bidSpoofDetected && adverseFlowSignals.length > 0) {
    warnings.push(`BID_SPOOF_ADVERSE_FLOW_${adverseFlowSignals.length}`);
  }

  // A wall that is already disappearing cannot vote for its own reliability. Ask spoof
  // may remain a bullish vote only while neither side is in a blocking spoof/support pair.
  const persistentBidVote = features.persistentBidWall && !bidSpoofDetected;
  const askSpoofVote = askSpoof >= 0.45 && !bidSpoofDetected && !supportBreakdown;
  const positiveVotes = [
    pressure >= 0.04,
    microprice >= -0.03,
    imbalance >= -0.12,
    ofi >= 0.12,
    persistentBidVote,
    askSpoofVote,
  ].filter(Boolean).length;
  const flowScore = pressure * 0.42 + microprice * 0.24 + imbalance * 0.20 + ofi * 0.14;
  const arrival = Math.max(0, finite(features.tradeArrivalRate));
  if (!(arrival > 0 && positiveVotes >= 3 && flowScore >= -0.015)) {
    reasons.push("LOB_FLOW_NOT_BUYABLE_NOW");
  }

  return {
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    adverseFlowSignals,
    positiveVotes,
    flowScore,
    bidSpoofThreshold: trapCfg.bidSpoofScore,
    askSpoofThreshold: trapCfg.askSpoofScore,
  };
}

/**
 * Pure Top-10 order-book entry gate.
 *
 * Entry permission here is current order-book/tape only. EV, candles and broad market
 * direction remain informational, while execution safety and reward/risk stay mandatory.
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
  // Current operator policy is authoritative even when an old scanner/runtime profile
  // still sends the former 1.5 RR floor or the 5% emergency boundary as a fixed stop.
  cfg.minObservationMs = 50_000;
  cfg.minEvBps = 0;
  cfg.minNetProfitBps = Math.max(
    OPERATOR_MIN_TARGET_NET_PROFIT_BPS,
    finite(cfg.minNetProfitBps, OPERATOR_MIN_TARGET_NET_PROFIT_BPS),
  );
  cfg.maxStopToTargetRatio = OPERATOR_MAX_STOP_TO_TARGET_RATIO;
  cfg.minNetRewardRiskRatio = Math.min(
    OPERATOR_MIN_NET_REWARD_RISK_RATIO,
    Math.max(0, finite(cfg.minNetRewardRiskRatio, OPERATOR_MIN_NET_REWARD_RISK_RATIO)),
  );
  cfg.minPrimaryPatternConfidence = 0;
  cfg.minHotnessScore = 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const hotness = scoreHotSymbol(features);
  const patterns = detectLobPatterns(features);
  const primary = patterns.find((pattern) => pattern.primary) ?? patterns[0] ?? null;

  // Continuation patterns buy after the move is already paid for, and 72h of live fills
  // priced that: MOMENTUM_CONTINUATION won 20% of 24 trades and OFI_CONTINUATION averaged
  // -30bp over 30, while the absorption/reversal families stayed positive. Blocked by
  // default and reopened through settings rather than deleted, so the decision stays
  // visible and reversible.
  const blockedPatterns = Array.isArray(cfg.blockedPatterns)
    ? cfg.blockedPatterns.map((name) => String(name).toUpperCase())
    : DEFAULT_BLOCKED_LOB_PATTERNS;
  if (primary?.name && blockedPatterns.includes(String(primary.name).toUpperCase())) {
    reasons.push(`LOB_PATTERN_BLOCKED_${primary.name}`);
  }

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
  const targetFloorBps = Math.max(cfg.minTargetBps, targetCostBps + cfg.minNetProfitBps);
  const targetBps = clamp(
    Math.max(rawFixedTargetBps, targetFloorBps),
    cfg.minTargetBps,
    cfg.maxTargetBps,
  );

  const usableFixedStopBps = rawFixedStopBps > 0 &&
      rawFixedStopBps < LEGACY_EMERGENCY_STOP_BPS
    ? rawFixedStopBps
    : 0;
  if (rawFixedStopBps >= LEGACY_EMERGENCY_STOP_BPS) {
    warnings.push("LEGACY_EMERGENCY_STOP_IGNORED_FOR_PLANNED_RISK");
  }

  const trapCfg = { ...DEFAULT_LOB_TRAP_CONFIG, ...(cfg.trap || {}) };
  const provisionalStopBps = Math.max(cfg.minStopBps, usableFixedStopBps);
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
  const plannedStopCeilingBps = Math.max(
    cfg.minStopBps,
    Math.min(cfg.maxStopBps, trapCfg.maxViableStopBps, PLANNED_SCALP_STOP_MAX_BPS),
  );
  const dynamicStopFloorBps = Math.max(
    cfg.minStopBps,
    traps.requiredStopBps,
    Math.max(0, finite(features.spreadBps)) * 2,
    Math.max(0, finite(cfg.learnedStopFloorBps)),
  );
  const stopBps = clamp(
    Math.max(usableFixedStopBps, dynamicStopFloorBps),
    cfg.minStopBps,
    plannedStopCeilingBps,
  );
  if (traps.requiredStopBps > plannedStopCeilingBps) {
    reasons.push("STOP_TO_TARGET_RATIO_FAILED");
    warnings.push("LOB_NOISE_REQUIRES_NON_SCALP_STOP");
  }
  // v7.3.0: the trap assessment is an entry authority, not a log line. Vetoing hazards
  // (허매수 BID_SPOOF, 양방향 조작 ASK_SPOOF, 재충전 매도벽 ASK_ICEBERG, 손절이 노이즈에
  // 잡히는 CHOP_NO_VIABLE_STOP) block the entry outright. Non-vetoing hazards keep their
  // diagnostic warning and instead shrink the edge this book is allowed to claim.
  // assessLobTraps already refuses to veto on an unreliable window, so a thin sample
  // degrades to "unknown", never to "clean".
  for (const trap of traps.traps) {
    if (trap.veto) reasons.push(`LOB_TRAP_${trap.name}`);
    else warnings.push(`LOB_DIAGNOSTIC_${trap.name}`);
  }

  // Operator-added 1m entry gate. It is opt-in at the shared-library level so legacy
  // research fixtures remain valid, but both production admission stages set it to true.
  if (cfg.requireMinuteEntryGate === true) {
    const k = Number(features.m1StochK);
    const d = Number(features.m1StochD);
    if (
      features.m1GateVersion !== MINUTE_ENTRY_GATE_VERSION ||
      features.m1DataAvailable !== true
    ) {
      reasons.push("M1_CANDLE_DATA_UNAVAILABLE");
    } else if (
      Math.max(0, Math.floor(Number(features.m1CompletedBars) || 0)) < 18 ||
      !Number.isFinite(k) || !Number.isFinite(d)
    ) {
      reasons.push("M1_CANDLE_DATA_INSUFFICIENT");
    } else {
      if (features.m1PreviousBullish !== true) {
        reasons.push("M1_PREVIOUS_CANDLE_NOT_BULLISH");
      }
      if (!(k > d)) reasons.push("M1_STOCH_K_NOT_ABOVE_D");
    }
  }

  // Structural and execution checks only.
  const maxGainerRank = clamp(
    Math.floor(finite(cfg.maxGainerRank, DEFAULT_MAX_GAINER_RANK)) || DEFAULT_MAX_GAINER_RANK,
    1,
    10,
  );
  if (
    features.universeMode !== "TOP10_24H_GAINERS_LOB_ONLY" ||
    !(finite(features.gainerRank) >= 1 && finite(features.gainerRank) <= maxGainerRank)
  ) reasons.push("OUTSIDE_24H_GAINER_TOP10");
  if (features.samples < cfg.minSamples) reasons.push("INSUFFICIENT_LOB_SAMPLES");
  if (features.observationMs < 50_000) reasons.push("INSUFFICIENT_50S_OBSERVATION");
  if (features.bookAgeMs == null || features.bookAgeMs > cfg.maxBookAgeMs) {
    reasons.push("STALE_ORDERBOOK");
  }
  if (features.spreadBps == null || features.spreadBps > cfg.maxSpreadBps) {
    reasons.push("SPREAD_TOO_WIDE");
  }
  if (
    !(features.bidDepthQuote > 0) || !(features.askDepthQuote > 0) || !(features.depthRatio > 0)
  ) {
    reasons.push("UNEXECUTABLE_ORDERBOOK_DEPTH");
  }

  // Present-tense LOB judgement. Negative flow and spoof warnings fail closed; EV,
  // candles and broad market direction remain informational and cannot veto an entry.
  const risk = assessLobEntryRisk(features, cfg.trap);
  reasons.push(...risk.reasons);
  warnings.push(...risk.warnings);
  const flowScore = risk.flowScore;

  const rawPFill = clamp(
    0.35 + hotness.tradabilityScore / 100 * 0.45 +
      clamp(features.depthRatio / 3, 0, 1) * 0.15 -
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
  // A non-vetoing hazard does not make the book bearish; it makes the book less legible.
  // So it shrinks the edge claimed over a coin flip rather than scaling the probability
  // itself, which would wrongly assert a downward view.
  const pTarget = clamp(0.50 + flowScore * 0.25 * traps.confidenceMultiplier, 0.20, 0.85);
  const pStop = clamp(1 - pTarget, 0.10, 0.75);
  const pTimeout = 0;
  const targetReturnNetBps = targetBps - targetCostBps;
  const stopReturnNetBps = -(stopBps + stopCostBps);
  const stopToTargetRatio = targetBps > 0 ? stopBps / targetBps : Number.POSITIVE_INFINITY;
  const netRewardRiskRatio = Math.abs(stopReturnNetBps) > 0
    ? Math.max(0, targetReturnNetBps) / Math.abs(stopReturnNetBps)
    : 0;
  if (targetReturnNetBps + ECONOMIC_GATE_EPSILON < cfg.minNetProfitBps) {
    reasons.push("REWARD_RISK_FAILED");
    warnings.push("TARGET_NET_PROFIT_TOO_LOW");
  }
  if (stopToTargetRatio > cfg.maxStopToTargetRatio + ECONOMIC_GATE_EPSILON) {
    reasons.push("STOP_TO_TARGET_RATIO_FAILED");
  }
  if (netRewardRiskRatio + ECONOMIC_GATE_EPSILON < cfg.minNetRewardRiskRatio) {
    reasons.push("REWARD_RISK_FAILED");
  }
  const informationalEv = pTarget * targetReturnNetBps + pStop * stopReturnNetBps;
  const uniqueReasons = [...new Set(reasons)];
  const decision = uniqueReasons.length === 0 ? "BUY" : "WAIT";

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
    stopToTargetRatio,
    netRewardRiskRatio,
    minimumTargetNetProfitBps: cfg.minNetProfitBps,
    minimumVerifiedEvBps: 0,
    conditionalEvNetBps: informationalEv,
    conditionalEvLowerBoundBps: informationalEv,
    attemptEvNetBps: informationalEv * fillCalibration.probability,
    attemptEvLowerBoundBps: informationalEv * fillCalibration.probability,
    evNetBps: informationalEv,
    evLowerBoundBps: informationalEv,
    forecastBiasPenaltyBps: 0,
    maxHoldingSeconds: 180,
    reasons: uniqueReasons,
    warnings: [...new Set(warnings)],
    features,
    traps,
    noiseAdjustedStopBps: stopBps,
  };
}

/** Barrier-neutral probability retained for reporting only. */
export function neutralWinRateOf(targetBps: number, stopBps: number): number {
  return targetBps + stopBps > 0 ? stopBps / (targetBps + stopBps) : 0.5;
}
