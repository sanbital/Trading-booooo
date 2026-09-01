/**
 * V10 regime-specific exit policy registry.
 *
 * Research identity:
 * - BULL/RANGE are selected from V10_REGIME_SPECIFIC_EXITS_R7_20260831.
 * - BEAR is retained for shadow counterfactuals only because no BEAR candidate
 *   passed the final neighbourhood/plateau gate through R8.
 *
 * The SHA is over the canonical JSON specification committed beside this file.
 */

export type V10Lane = "BULL" | "RANGE" | "BEAR";

export type V10ExitFamily =
  | "PARTIAL_CONTINUATION"
  | "FULL_STATE_TARGET"
  | "STATE_RECOVERY";

export interface V10ExitPolicy {
  readonly lane: V10Lane;
  readonly key: string;
  readonly family: V10ExitFamily;
  readonly researchRevision: string;
  readonly validated: boolean;
  readonly liveEligible: boolean;
  readonly shadowOnly: boolean;
  readonly maxHoldHours: number;
  readonly t1Roe?: number;
  readonly t1Fraction?: number;
  readonly residualFloorRoe?: number;
  readonly trailArmRoe?: number;
  readonly trailGivebackRoe?: number;
  readonly targetBbImprovement?: number;
  readonly failureAfterHours?: number;
  readonly failureMaxReturn?: number;
  readonly failureMaxBbImprovement?: number;
  readonly researchMetrics: {
    readonly trades: number;
    readonly meanNetBps: number;
    readonly profitFactor: number;
    readonly maxDrawdownBps: number;
    readonly expectancyRetention: number;
    readonly drawdownImprovementPct: number;
    readonly worstYearMeanBps: number;
    readonly positiveYears: number;
    readonly positiveHalfYears: number;
    readonly neighbourPassShare: number;
    readonly finalEligible: boolean;
  };
}

export const V10_EXIT_ENGINE_REVISION = "V10-LANES-EXIT-RUNTIME-1.1.0";
export const V10_EXIT_SPEC_SHA256 =
  "1aa96472956500b17e27d8b923a1dd883643a728b74c5f096d8f780a27307c4b";
export const V10_EXIT_BAR_INTERVAL_MINUTES = 15;
export const V10_EXIT_BAR_INTERVAL_MS = V10_EXIT_BAR_INTERVAL_MINUTES * 60_000;
export const V10_EXIT_DEFAULT_LEVERAGE = 3;
export const V10_EXIT_STOP_FILL_HAIRCUT = 0.0005;

/**
 * This first deployment is intentionally compiled without exchange-order
 * routing. The state machine and shadow executor can be deployed and observed,
 * but cannot submit, amend or cancel a Binance order.
 */
export const V10_EXIT_LIVE_ORDER_ROUTING_COMPILED = false;

export const V10_EXIT_POLICIES: Readonly<Record<V10Lane, V10ExitPolicy>> = {
  BULL: {
    lane: "BULL",
    key: "BULL_R7_SP_T22P5_Q0P30_F0_G6P75__RT110",
    family: "PARTIAL_CONTINUATION",
    researchRevision: "V10_REGIME_SPECIFIC_EXITS_R7_20260831",
    validated: true,
    liveEligible: true,
    shadowOnly: false,
    maxHoldHours: 12,
    t1Roe: 22.5,
    t1Fraction: 0.30,
    residualFloorRoe: 0,
    trailGivebackRoe: 6.75,
    researchMetrics: {
      trades: 673,
      meanNetBps: 86.188,
      profitFactor: 1.8811,
      maxDrawdownBps: -7343.0,
      expectancyRetention: 0.9312,
      drawdownImprovementPct: 11.068,
      worstYearMeanBps: 67.825,
      positiveYears: 6,
      positiveHalfYears: 10,
      neighbourPassShare: 0.75,
      finalEligible: true,
    },
  },
  RANGE: {
    lane: "RANGE",
    key: "RANGE_R7_STATE_T1P00_A18_G0P75__RT110",
    family: "FULL_STATE_TARGET",
    researchRevision: "V10_REGIME_SPECIFIC_EXITS_R7_20260831",
    validated: true,
    liveEligible: true,
    shadowOnly: false,
    maxHoldHours: 6,
    targetBbImprovement: 1.0,
    trailArmRoe: 18,
    trailGivebackRoe: 0.75,
    researchMetrics: {
      trades: 984,
      meanNetBps: 75.892,
      profitFactor: 1.9335,
      maxDrawdownBps: -5220.3,
      expectancyRetention: 0.8947,
      drawdownImprovementPct: 4.077,
      worstYearMeanBps: 13.599,
      positiveYears: 6,
      positiveHalfYears: 11,
      neighbourPassShare: 1.0,
      finalEligible: true,
    },
  },
  BEAR: {
    lane: "BEAR",
    key: "BEAR_R8_STATE_T1P76_R0P0200_B0P40__RT110",
    family: "STATE_RECOVERY",
    researchRevision: "V10_REGIME_SPECIFIC_EXITS_R8_20260831",
    validated: false,
    liveEligible: false,
    shadowOnly: true,
    maxHoldHours: 24,
    targetBbImprovement: 1.76,
    failureAfterHours: 4,
    failureMaxReturn: -0.02,
    failureMaxBbImprovement: 0.4,
    researchMetrics: {
      trades: 161,
      meanNetBps: 289.578,
      profitFactor: 3.1418,
      maxDrawdownBps: -3474.8,
      expectancyRetention: 0.8164,
      drawdownImprovementPct: 30.226,
      worstYearMeanBps: 25.121,
      positiveYears: 6,
      positiveHalfYears: 10,
      neighbourPassShare: 0.6667,
      finalEligible: false,
    },
  },
} as const;

export function getV10ExitPolicy(lane: V10Lane): V10ExitPolicy {
  return V10_EXIT_POLICIES[lane];
}

export function isV10LaneLiveEligible(lane: V10Lane): boolean {
  const policy = getV10ExitPolicy(lane);
  return policy.validated && policy.liveEligible && !policy.shadowOnly;
}
