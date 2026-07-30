// Trading-booooo v7.0.0-TOP10-LOB-ONLY — LOB_SCALP domain types.
// Fractions use decimal form unless a field explicitly ends with Bps/Pct.

export type LobPatternName =
  | "ABSORPTION_REVERSAL"
  | "QUEUE_DEPLETION_BREAKOUT"
  | "SWEEP_RECLAIM"
  | "OFI_CONTINUATION"
  | "MOMENTUM_CONTINUATION"
  | "REPLENISHMENT_ICEBERG";

export type LobDecisionState = "BUY" | "WAIT" | "AVOID";

import type { LobTrapAssessment, LobTrapConfig } from "./traps.ts";

export interface LobFeatureVector {
  universeMode?: "TOP10_24H_GAINERS_LOB_ONLY";
  gainerRank?: number;
  samples: number;
  observationMs: number;
  bookAgeMs: number | null;
  spreadBps: number | null;
  bookImbalance: number;
  imbalanceStability: number;
  tradePressureFast: number;
  tradeCount: number;
  buyNotional: number;
  sellNotional: number;
  averageTradeNotional: number | null;
  bookUpdateRate: number;
  tradeArrivalRate: number;
  aggressiveNotionalPerSecond: number;
  micropriceDeviationBps: number;
  bidDepthQuote: number;
  askDepthQuote: number;
  depthRatio: number;
  /** Bid-side spoof (허매수): resting bids cancelled rather than executed. 0..1 */
  spoofLikeScore: number;
  /** Ask-side spoof (허매도): resting asks cancelled rather than executed. 0..1 */
  askSpoofScore: number;
  askAbsorptionScore: number;
  /** Refilled / executed quantity at ask walls. The iceberg-ceiling measure. */
  askRefillRatio: number;
  bidAbsorptionScore: number;
  breakoutScore: number;
  sweepReclaimScore: number;
  ofiPersistence: number;
  persistentBidWall: boolean;
  persistentAskWall: boolean;
  dynamicStatus: string;
  dataQuality: number;
  turnover24hQuote: number;
  minActionableTurnover24h: number;
  trendContext: number;
  marketHeatScore: number;
  recentNotionalPerSecond: number;
  notionalAcceleration: number;
  tradeCountPerSecond: number;
  notionalTrend?: number;
  tradeSpeedTrend?: number;
  tradeArrivalTrend?: number;
  /** |net displacement| / path length over the observation window. 1 = trend, ~0 = chop. */
  pathEfficiency: number;
  /** Share of consecutive mid-price steps that reverse direction. 0..1 */
  reversalRate: number;
  /** Median adverse excursion in bps for a long opened at a random point in the window. */
  noiseBandBps: number;
  /** Top-of-book size changes per second. */
  quoteFlickerRate: number;
  /** Perp mark-to-index premium in bps. 0 when no perpetual exists for this asset. */
  fundingPremiumBps: number;
  /** 0..1 leveraged-attention proxy from perp premium magnitude and change. */
  fundingAttention: number;
  /** Bounded additive edge from perp positioning. Never a veto. */
  fundingEdge: number;
}

export interface LobPatternSignal {
  name: LobPatternName;
  direction: "LONG";
  confidence: number;
  primary: boolean;
  evidence: string[];
  invalidations: string[];
}

export interface HotSymbolScore {
  activityScore: number;
  tradabilityScore: number;
  hotnessScore: number;
  components: Record<string, number>;
}

export interface LobCostEstimate {
  roundTripFeeBps: number;
  entrySlippageBps: number;
  targetExitSlippageBps: number;
  stopExitSlippageBps: number;
  spreadBps: number;
  /**
   * v6.5: adverse price movement expected while the order is in flight, in bps.
   *
   * Before v6.5 this was a flat 1bp buried in the scalp cost model and absent from the LOB
   * path entirely — the strategy with the shortest horizon in the system was the one that
   * did not price its own execution delay. It is now measured per exchange from
   * `trading_latency_samples` and scaled by the symbol's volatility. Optional so the
   * module stays usable before any measurement exists.
   */
  latencyPenaltyBps?: number;
  /**
   * Confirmed optimism in prior entry-time EV forecasts, measured as realized net bps minus
   * the forecast lower bound. This is an EV-level correction, not a fabricated fee.
   */
  forecastBiasPenaltyBps?: number;
}

export interface LobEntryConfig {
  minSamples: number;
  /** Minimum wall-clock coverage of the live order-book/tape observation. */
  minObservationMs: number;
  maxBookAgeMs: number;
  maxSpreadBps: number;
  minHotnessScore: number;
  minPrimaryPatternConfidence: number;
  minNetProfitBps: number;
  minEvBps: number;
  /** Maximum noise-aware gross stop / target ratio used as an auditable warning. */
  maxStopToTargetRatio: number;
  /** Minimum fee-adjusted target reward / fee-adjusted stop loss used as a warning. */
  minNetRewardRiskRatio: number;
  maxTargetBps: number;
  minTargetBps: number;
  minStopBps: number;
  maxStopBps: number;
  maxHoldingSeconds: number;
  absoluteMaxHoldingSeconds: number;
  uncertaintyHaircut: number;
  /** Trap thresholds. See traps.ts. */
  trap: Partial<LobTrapConfig>;
  /** Traps demoted from veto to penalty because measurement showed they earn nothing. */
  disabledVetoes: string[];
  /** Learned per-pattern correction to pTarget. 1 = no correction. */
  patternProbabilityMultiplier: number;
  /** Realized maker-entry fill rate for this exchange. */
  measuredMakerFillRate: number;
  /** Number of maker-entry attempts behind measuredMakerFillRate. */
  makerFillSamples: number;
  /** Samples at which measured fill rate and the book model receive equal weight. */
  makerFillPriorStrength: number;
  /**
   * Per-market stop floor learned from profitable trades' adverse excursion.
   * The entry path recalculates EV after applying it; it is never a bypass.
   */
  learnedStopFloorBps: number;
}

export interface LobEntryDecision {
  decision: LobDecisionState;
  pattern: LobPatternName | null;
  patterns: LobPatternSignal[];
  hotness: HotSymbolScore;
  pTarget: number;
  pStop: number;
  pTimeout: number;
  pFill: number;
  rawPFill: number;
  fillCalibrationWeight: number;
  targetBps: number;
  stopBps: number;
  targetReturnNetBps: number;
  stopReturnNetBps: number;
  timeoutReturnNetBps: number;
  stopToTargetRatio: number;
  netRewardRiskRatio: number;
  minimumTargetNetProfitBps: number;
  minimumVerifiedEvBps: number;
  /** EV conditional on the maker entry actually filling. */
  conditionalEvNetBps: number;
  conditionalEvLowerBoundBps: number;
  /** Order-attempt EV after fill probability; used for capital scheduling, not bias fitting. */
  attemptEvNetBps: number;
  attemptEvLowerBoundBps: number;
  /** Backward-compatible aliases: conditional EV in v6.10. */
  evNetBps: number;
  evLowerBoundBps: number;
  forecastBiasPenaltyBps: number;
  maxHoldingSeconds: number;
  reasons: string[];
  warnings: string[];
  features: LobFeatureVector;
  traps: LobTrapAssessment;
  /** Stop actually used after the book's own noise band was taken into account. */
  noiseAdjustedStopBps: number;
}
