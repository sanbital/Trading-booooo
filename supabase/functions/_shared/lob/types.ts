// Trading-booooo v6.0.0 — LOB_SCALP domain types.
// Fractions use decimal form unless a field explicitly ends with Bps/Pct.

export type LobPatternName =
  | "ABSORPTION_REVERSAL"
  | "QUEUE_DEPLETION_BREAKOUT"
  | "SWEEP_RECLAIM"
  | "OFI_CONTINUATION"
  | "REPLENISHMENT_ICEBERG";

export type LobDecisionState = "BUY" | "WAIT" | "AVOID";

export interface LobFeatureVector {
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
  spoofLikeScore: number;
  askAbsorptionScore: number;
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
}

export interface LobEntryConfig {
  minSamples: number;
  maxBookAgeMs: number;
  maxSpreadBps: number;
  minHotnessScore: number;
  minPrimaryPatternConfidence: number;
  minNetProfitBps: number;
  minEvBps: number;
  maxTargetBps: number;
  minTargetBps: number;
  minStopBps: number;
  maxStopBps: number;
  maxHoldingSeconds: number;
  absoluteMaxHoldingSeconds: number;
  uncertaintyHaircut: number;
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
  targetBps: number;
  stopBps: number;
  targetReturnNetBps: number;
  stopReturnNetBps: number;
  timeoutReturnNetBps: number;
  evNetBps: number;
  evLowerBoundBps: number;
  maxHoldingSeconds: number;
  reasons: string[];
  features: LobFeatureVector;
}
