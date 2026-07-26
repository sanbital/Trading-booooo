// Scalp entry gate (Stage 4 — composition of Stage-1 safety + precise EV).
//
// This is the FINAL gate before a live scalp order. Order of enforcement:
//   1) safety rails (kill switch and approved daily-loss halt) plus operator allocation
//      boundary -> evaluateEntryGate
//   2) precise stressed-slippage EV on the allocation-controlled notional with live depth
//      -> evaluateEdge
// Both must pass. The safety rails run FIRST, on purpose: a halted account never
// reaches the order-sizing/EV path.

import { evaluateEntryGate, type ScalpDayState, type ScalpSafetyConfig } from "./safety.ts";
import { evaluateEdge, type CostModelConfig, type OrderbookLevel } from "./cost-model.ts";

export interface ScalpGateInput {
  capitalQuote: number;
  requestedNotional: number;
  day: ScalpDayState;
  pWin: number;
  targetPct: number;
  stopPct: number;
  askLevels: OrderbookLevel[];
  bidLevels: OrderbookLevel[];
  bestAsk: number;
  bestBid: number;
  /** v5.3: P(a barrier resolves before the max holding time). Omit for legacy behavior. */
  resolveProbability?: number;
  /** v5.3: expected return when the trade ends at the time exit. */
  timeoutReturn?: number;
}

export interface ScalpGateResult {
  allow: boolean;
  notional: number;        // allocation-controlled notional to order (0 when blocked)
  reason: string | null;   // halt/skip reason for logging
  expectedNetEdge: number | null;
}

export function scalpEntryDecision(
  input: ScalpGateInput,
  safetyCfg: ScalpSafetyConfig,
  costCfg: CostModelConfig,
): ScalpGateResult {
  // 1) Safety rails + operator allocation boundary.
  const safety = evaluateEntryGate(
    { capitalQuote: input.capitalQuote, requestedNotional: input.requestedNotional, day: input.day },
    safetyCfg,
  );
  if (!safety.allow) {
    return { allow: false, notional: 0, reason: safety.haltReason, expectedNetEdge: null };
  }

  // 2) Precise EV on the allocation-controlled notional with live depth.
  const edge = evaluateEdge(
    {
      pWin: input.pWin,
      expectedProfit: input.targetPct,
      expectedLoss: input.stopPct,
      askLevels: input.askLevels,
      bidLevels: input.bidLevels,
      notional: safety.cappedNotional,
      bestAsk: input.bestAsk,
      bestBid: input.bestBid,
      resolveProbability: input.resolveProbability ?? 1,
      timeoutReturn: input.timeoutReturn ?? 0,
    },
    costCfg,
  );
  if (!edge.enter) {
    return { allow: false, notional: safety.cappedNotional, reason: edge.skipReason, expectedNetEdge: edge.expectedNetEdge };
  }

  return { allow: true, notional: safety.cappedNotional, reason: null, expectedNetEdge: edge.expectedNetEdge };
}
