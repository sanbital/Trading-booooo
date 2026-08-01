import type { LobFeatureVector } from "./types.ts";

export type LobPreOrderRecheck = {
  passed: boolean;
  reasons: string[];
  decision: string;
  checkedAt: string;
  bestBid: number;
  bestAsk: number;
  spreadBps: number | null;
  bidDepthQuote: number;
  askDepthQuote: number;
  tradePressureFast: number;
  micropriceDeviationBps: number;
  features: LobFeatureVector;
};

/** A collapsing bid between two passing snapshots needs current bearish tape confirmation. */
export function assessLobPreOrderPair(
  first: LobPreOrderRecheck,
  second: LobPreOrderRecheck,
): { passed: boolean; reasons: string[] } {
  const reasons = [...first.reasons, ...second.reasons];
  const bidDepthCollapsed = first.bidDepthQuote > 0 &&
    second.bidDepthQuote / first.bidDepthQuote < 0.65;
  const currentFlowAdverse = second.tradePressureFast < 0 ||
    second.micropriceDeviationBps < 0;
  if (bidDepthCollapsed && currentFlowAdverse) {
    reasons.push("PREORDER_SUPPORT_EVAPORATION_CONFIRMED");
  }
  const uniqueReasons = [...new Set(reasons)];
  return { passed: uniqueReasons.length === 0, reasons: uniqueReasons };
}
