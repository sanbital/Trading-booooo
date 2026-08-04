// One definition of the LOB admission gate, shared by the scanner's first-pass BUY
// judgement and the autotrader's pre-order recheck.
//
// The two stages used to build this config separately. The scanner passed the operator's
// minNetRR straight through and derived maxStopToTargetRatio as its reciprocal, while the
// executor floored the ratio at 1.5 and read maxStopToTargetRatio from its own setting.
// Lower the operator value below 1.5 and the stages disagree: the scanner writes a BUY
// candidate the executor then refuses, so the run produces stored BUY rows and no trades,
// with nothing in between saying why.
//
// Any future knob belongs here rather than at a call site.
//
// v7.4.0 — thresholds written in terms of a predictive feature are now evidence-gated.
// `minEvBps` used to be pinned to zero by a comment saying EV had no measured relationship
// to outcome, which was true but unenforceable: nothing stopped the next edit from raising
// it again. It is now resolved from the measured admission map, so an EV floor exists
// exactly when live data has earned one and disappears when the evidence does.

import { type FeatureAdmissionView, mayHardenGate } from "./feature-admission.ts";

export interface LobGateInputs {
  /** Operator reward:risk floor, from trading_settings. */
  minNetRewardRiskRatio?: number;
  /** Operator stop:target ceiling, from trading_settings. */
  maxStopToTargetRatio?: number;
  maxGainerRank?: number;
  maxBookAgeMs?: number;
  maxSpreadBps?: number;
  minNetProfitBps?: number;
  /**
   * Operator's requested EV floor. It applies only while `ev_lower_bound_bps` holds GATE
   * authority for this venue; otherwise it is recorded and ignored.
   */
  minEvBps?: number;
  /** Measured feature authority for the venue being gated. Absent means nothing is gated. */
  featureAdmission?: FeatureAdmissionView | null;
}

export interface LobGateConfig {
  minEvBps: number;
  minNetProfitBps: number;
  minNetRewardRiskRatio: number;
  maxStopToTargetRatio: number;
  maxGainerRank: number;
  maxBookAgeMs: number;
  maxSpreadBps: number;
}

/** Absolute reward:risk floor. An operator may raise it; nothing may lower it. */
export const LOB_MIN_NET_REWARD_RISK_RATIO = 1.5;
export const LOB_MAX_NET_REWARD_RISK_RATIO = 5;
export const LOB_MIN_STOP_TO_TARGET_RATIO = 0.75;
export const LOB_MAX_STOP_TO_TARGET_RATIO = 5;
export const LOB_DEFAULT_MAX_GAINER_RANK = 10;
/**
 * Ceiling on an evidence-gated EV floor. The first feature ever to clear significance still
 * lands inside a range reviewed in advance, rather than inheriting whatever the settings row
 * happened to hold at the moment the evidence arrived.
 */
export const LOB_MAX_EVIDENCE_GATED_EV_BPS = 5;

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function buildLobGateConfig(
  input: LobGateInputs,
  defaults: { maxSpreadBps: number },
): LobGateConfig {
  return {
    // EV gates only while measurement says it separates outcomes. With no admission map, or
    // with EV below GATE authority, it stays informational on both sides.
    minEvBps: mayHardenGate(input.featureAdmission, "ev_lower_bound_bps")
      ? clamp(finite(input.minEvBps, 0), 0, LOB_MAX_EVIDENCE_GATED_EV_BPS)
      : 0,
    minNetProfitBps: Math.max(0, finite(input.minNetProfitBps, 0)),
    minNetRewardRiskRatio: clamp(
      Math.max(
        LOB_MIN_NET_REWARD_RISK_RATIO,
        finite(input.minNetRewardRiskRatio, LOB_MIN_NET_REWARD_RISK_RATIO),
      ),
      LOB_MIN_NET_REWARD_RISK_RATIO,
      LOB_MAX_NET_REWARD_RISK_RATIO,
    ),
    maxStopToTargetRatio: clamp(
      finite(input.maxStopToTargetRatio, 1.35),
      LOB_MIN_STOP_TO_TARGET_RATIO,
      LOB_MAX_STOP_TO_TARGET_RATIO,
    ),
    maxGainerRank: Math.round(
      clamp(finite(input.maxGainerRank, LOB_DEFAULT_MAX_GAINER_RANK), 1, 10),
    ),
    maxBookAgeMs: Math.max(250, finite(input.maxBookAgeMs, 2500)),
    maxSpreadBps: Math.max(1, finite(input.maxSpreadBps, defaults.maxSpreadBps)),
  };
}
