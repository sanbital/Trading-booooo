// Trading-booooo v5.12 — final scalp entry gate.
//
// Enforcement order:
//   1) loss/kill-switch/allocation safety
//   2) live depth and stressed execution costs
//   3) forecast validity and conservative EV/pWin/pFill lower bounds
//
// Throughput control is deliberately absent. Frequency may never weaken this gate.

import { evaluateEntryGate, type ScalpDayState, type ScalpSafetyConfig } from "./safety.ts";
import {
  type CostModelConfig,
  type OrderbookLevel,
  stressSellSlippage,
  stressSlippage,
} from "./cost-model.ts";
import {
  type CandidateEvaluation,
  evaluateCandidate,
  type GateConfig,
  SHADOW_CANDIDATE_GATE,
} from "./candidate-gate.ts";
import {
  buildBridgeOutcomeForecast,
  type ExpectedOrderType,
  type OutcomeForecast,
} from "./outcome-forecaster.ts";

export interface ScalpGateInput {
  capitalQuote: number;
  /** Capital committed by this order. Defaults to requestedNotional for spot. */
  requestedCapital?: number;
  /** Contract notional controlled by one unit of capital. Defaults to 1 for spot. */
  notionalPerCapital?: number;
  requestedNotional: number;
  day: ScalpDayState;
  pWin: number;
  targetPct: number;
  stopPct: number;
  askLevels: OrderbookLevel[];
  bidLevels: OrderbookLevel[];
  bestAsk: number;
  bestBid: number;
  resolveProbability?: number;
  /** Net timeout return. It must already include expected fees/slippage. */
  timeoutReturn?: number;
  timeoutPositiveProbability?: number;
  expectedHoldingMinutes?: number;
  expectedOrderType?: ExpectedOrderType;
  depthCoverageRatio?: number;
  spreadBps?: number;
  bookImbalance?: number;
  signalAgeMs?: number;
  forecast?: OutcomeForecast;
  forecastEffectiveSamples?: number;
  forecastIndependentBlocks?: number;
  forecastCalibrationReady?: boolean;
  modelVersion?: string;
  calibrationVersion?: string;
}

export interface ScalpGateResult {
  allow: boolean;
  notional: number;
  reason: string | null;
  expectedNetEdge: number | null;
  evLowerBound: number | null;
  pWinLowerBound: number | null;
  pFillLowerBound: number | null;
  rejectionReasons: string[];
  evaluation: CandidateEvaluation | null;
}

function mappedReason(reasons: string[]): string {
  const first = reasons[0] || "candidate_gate_rejected";
  if (first === "EV_LOWER_BOUND_NOT_POSITIVE") return "edge_below_minimum";
  if (first === "PWIN_LOWER_BOUND_BELOW_50_PERCENT") return "pwin_lower_bound_below_threshold";
  if (first === "PFILL_LOWER_BOUND_TOO_LOW") return "pfill_lower_bound_too_low";
  return first.toLowerCase();
}

export function scalpEntryDecision(
  input: ScalpGateInput,
  safetyCfg: ScalpSafetyConfig,
  costCfg: CostModelConfig,
  gateCfg: GateConfig = SHADOW_CANDIDATE_GATE,
): ScalpGateResult {
  const requestedCapital = Number.isFinite(input.requestedCapital)
    ? Math.max(0, Number(input.requestedCapital))
    : input.requestedNotional;
  const notionalPerCapital = Number.isFinite(input.notionalPerCapital)
    ? Math.max(1, Number(input.notionalPerCapital))
    : 1;
  const safety = evaluateEntryGate(
    { capitalQuote: input.capitalQuote, requestedNotional: requestedCapital, day: input.day },
    safetyCfg,
  );
  if (!safety.allow) {
    return {
      allow: false,
      notional: 0,
      reason: safety.haltReason,
      expectedNetEdge: null,
      evLowerBound: null,
      pWinLowerBound: null,
      pFillLowerBound: null,
      rejectionReasons: safety.haltReason ? [safety.haltReason] : [],
      evaluation: null,
    };
  }

  // Safety caps operate on managed capital (margin on futures), while depth and EV costs
  // operate on the contract notional presented to the market.
  const cappedNotional = Math.min(
    input.requestedNotional,
    safety.cappedNotional * notionalPerCapital,
  );

  const entry = stressSlippage(
    input.askLevels,
    cappedNotional,
    input.bestAsk,
    costCfg.slippage,
  );
  if (entry.skip) {
    return {
      allow: false,
      notional: cappedNotional,
      reason: "thin_ask_depth",
      expectedNetEdge: -1,
      evLowerBound: -1,
      pWinLowerBound: null,
      pFillLowerBound: null,
      rejectionReasons: ["THIN_ASK_DEPTH"],
      evaluation: null,
    };
  }
  const exit = stressSellSlippage(
    input.bidLevels,
    cappedNotional,
    input.bestBid,
    costCfg.slippage,
  );
  if (exit.skip) {
    return {
      allow: false,
      notional: cappedNotional,
      reason: "thin_bid_depth",
      expectedNetEdge: -1,
      evLowerBound: -1,
      pWinLowerBound: null,
      pFillLowerBound: null,
      rejectionReasons: ["THIN_BID_DEPTH"],
      evaluation: null,
    };
  }

  const feePerSide = Math.max(0, costCfg.roundTripFeeFraction) / 2;
  const timeoutReturnNet = Number.isFinite(input.timeoutReturn)
    ? Number(input.timeoutReturn)
    : -(costCfg.roundTripFeeFraction + entry.slippage + exit.slippage);
  const forecast = input.forecast ?? buildBridgeOutcomeForecast({
    conditionalTargetProbability: input.pWin,
    resolveProbability: input.resolveProbability ?? 1,
    timeoutPositiveProbability: input.timeoutPositiveProbability ?? 0,
    timeoutReturnNet,
    expectedHoldingMinutes: Math.max(1, input.expectedHoldingMinutes ?? 15),
    expectedOrderType: input.expectedOrderType ?? "IOC_LIMIT",
    depthCoverageRatio: input.depthCoverageRatio ?? 1,
    spreadBps: input.spreadBps ?? 0,
    bookImbalance: input.bookImbalance ?? 0,
    signalAgeMs: input.signalAgeMs ?? 0,
    effectiveSamples: input.forecastEffectiveSamples ?? 0,
    independentBlocks: input.forecastIndependentBlocks,
    calibrationReady: input.forecastCalibrationReady ?? false,
    modelVersion: input.modelVersion ?? "v5.12-bridge.1",
    calibrationVersion: input.calibrationVersion ?? "identity",
  });
  const evaluation = evaluateCandidate(
    {
      targetPct: input.targetPct,
      stopPct: input.stopPct,
      maxHoldingMinutes: Math.max(1, input.expectedHoldingMinutes ?? 15),
    },
    forecast,
    {
      entryFeeRate: feePerSide,
      targetExitFeeRate: feePerSide,
      stopExitFeeRate: feePerSide,
      entrySlippageRate: entry.slippage,
      targetExitSlippageRate: exit.slippage,
      stopExitSlippageRate: exit.slippage,
      unfilledMeasuredCostRate: 0,
    },
    { ...gateCfg, minEvBuffer: Math.max(gateCfg.minEvBuffer, costCfg.minimumEdge) },
  );
  return {
    allow: evaluation.accepted,
    notional: cappedNotional,
    reason: evaluation.accepted ? null : mappedReason(evaluation.rejectionReasons),
    expectedNetEdge: evaluation.evAttempt,
    evLowerBound: evaluation.evLowerBound,
    pWinLowerBound: evaluation.pWinLowerBound,
    pFillLowerBound: evaluation.pFillLowerBound,
    rejectionReasons: evaluation.rejectionReasons,
    evaluation,
  };
}
