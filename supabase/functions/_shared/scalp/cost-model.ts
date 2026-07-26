// Scalp cost / expected-value model (Stage 1 — pure, no side effects).
//
// Central rule agreed for the scalping pivot:
//   Enter ONLY when the probability-weighted expected net edge clears a margin.
//
//   expected_net_edge = p_win * expected_profit
//                     - p_loss * expected_loss
//                     - round_trip_cost           // fees, both sides
//                     - stress_slippage            // conservative, not raw book slippage
//
//   enter if expected_net_edge >= minimum_edge   (minimum_edge default 0.10%)
//
// NOTE: "target width - slippage - fees" is NOT expected value. A move that clears
// the target can still be negative EV once win-probability is applied. This module
// makes the probability-weighted form the single source of truth.
//
// All percentages are expressed as fractions (0.004 = 0.4%), all prices/notionals in quote currency.

export interface OrderbookLevel { price: number; size: number }

export interface StressSlippageConfig {
  // Multiplier applied to the raw simulated book slippage to account for
  // order cancellation, price drift and adverse selection right after a signal.
  stressFactor: number;        // default 1.15; raw book impact is already measured directly
  // Flat penalties (as fractions of price) for transport latency and partial fills.
  latencyPenalty: number;      // default 0.0001 (0.01%)
  partialFillPenalty: number;  // default 0.0001 (0.01%)
  // If the order would consume more than this fraction of visible depth, treat as unfillable.
  maxDepthConsumption: number; // default 0.60
}

export interface CostModelConfig {
  roundTripFeeFraction: number;  // fees for BOTH sides combined, e.g. 0.001 (0.10%)
  minimumEdge: number;           // e.g. 0.001 (0.10%)
  slippage: StressSlippageConfig;
}

export const DEFAULT_STRESS: StressSlippageConfig = {
  stressFactor: 1.15,
  latencyPenalty: 0.0001,
  partialFillPenalty: 0.0001,
  maxDepthConsumption: 0.60,
};

export const DEFAULT_COST_MODEL: CostModelConfig = {
  roundTripFeeFraction: 0.001,
  minimumEdge: 0.001,
  slippage: DEFAULT_STRESS,
};

/**
 * Walk one side of the book, filling `notional` (quote) against ascending asks
 * (for a buy). Returns the size-weighted average fill price and how much of the
 * visible depth the order would consume. If depth is insufficient, `fillable`
 * is false and the caller must skip the trade.
 */
export function simulateFill(
  levels: OrderbookLevel[],
  notional: number,
): { avgPrice: number; consumedFraction: number; fillable: boolean } {
  const clean = levels.filter((l) => l.price > 0 && l.size > 0);
  if (clean.length === 0 || notional <= 0) return { avgPrice: 0, consumedFraction: 1, fillable: false };
  const totalDepthQuote = clean.reduce((s, l) => s + l.price * l.size, 0);
  let remaining = notional;
  let spentQuote = 0;
  let filledQty = 0;
  for (const l of clean) {
    const levelQuote = l.price * l.size;
    const take = Math.min(remaining, levelQuote);
    filledQty += take / l.price;
    spentQuote += take;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  const fillable = remaining <= 1e-9 && filledQty > 0;
  const avgPrice = filledQty > 0 ? spentQuote / filledQty : 0;
  const consumedFraction = totalDepthQuote > 0 ? notional / totalDepthQuote : 1;
  return { avgPrice, consumedFraction, fillable };
}

/**
 * Conservative one-side slippage as a fraction of the reference (best) price.
 * Raw book slippage is stressed up and padded with latency / partial-fill penalties.
 * Returns { slippage, skip } — skip=true means depth is too thin to trade.
 */
export function stressSlippage(
  levels: OrderbookLevel[],
  notional: number,
  referencePrice: number,
  cfg: StressSlippageConfig = DEFAULT_STRESS,
): { slippage: number; skip: boolean; consumedFraction: number } {
  if (referencePrice <= 0) return { slippage: 1, skip: true, consumedFraction: 1 };
  const sim = simulateFill(levels, notional);
  if (!sim.fillable || sim.consumedFraction > cfg.maxDepthConsumption) {
    return { slippage: 1, skip: true, consumedFraction: sim.consumedFraction };
  }
  const rawSlippage = Math.max(0, (sim.avgPrice - referencePrice) / referencePrice);
  const stressed = rawSlippage * cfg.stressFactor + cfg.latencyPenalty + cfg.partialFillPenalty;
  return { slippage: stressed, skip: false, consumedFraction: sim.consumedFraction };
}

/** Conservative sell-side slippage below the best bid. */
export function stressSellSlippage(
  levels: OrderbookLevel[],
  notional: number,
  referencePrice: number,
  cfg: StressSlippageConfig = DEFAULT_STRESS,
): { slippage: number; skip: boolean; consumedFraction: number } {
  if (referencePrice <= 0) return { slippage: 1, skip: true, consumedFraction: 1 };
  const sim = simulateFill(levels, notional);
  if (!sim.fillable || sim.consumedFraction > cfg.maxDepthConsumption) {
    return { slippage: 1, skip: true, consumedFraction: sim.consumedFraction };
  }
  const rawSlippage = Math.max(0, (referencePrice - sim.avgPrice) / referencePrice);
  return {
    slippage: rawSlippage * cfg.stressFactor + cfg.latencyPenalty + cfg.partialFillPenalty,
    skip: false,
    consumedFraction: sim.consumedFraction,
  };
}

/**
 * Probability-weighted gross edge (before costs). Single source of truth for the
 * EV formula, reused by the scanner where the order notional (and thus precise
 * slippage) is not yet known.
 */
export function probabilityWeightedGross(
  pWin: number,
  expectedProfit: number,
  expectedLoss: number,
  resolveProbability = 1,
  timeoutReturn = 0,
): number {
  const pLoss = Math.max(0, 1 - pWin);
  // v5.3: a scalp does not always end at a barrier. With a finite maximum holding time
  // there is a third outcome — the time exit — which pays roughly nothing but still
  // costs a full round trip. v5.2.5 assumed pWin + pLoss = 1 with no timeout branch,
  // which overstated expected value on every symbol too slow to reach its target.
  //
  //   pTarget  = pWin        * resolveProbability
  //   pStop    = (1 - pWin)  * resolveProbability
  //   pTimeout = 1 - resolveProbability
  //
  // pWin is therefore the probability of hitting the target GIVEN the trade resolves.
  const resolve = Math.max(0, Math.min(1, resolveProbability));
  const barrier = (pWin * expectedProfit - pLoss * expectedLoss) * resolve;
  return barrier + (1 - resolve) * timeoutReturn;
}

/**
 * Provisional edge used at scan time: probability-weighted gross minus round-trip
 * fees only. Precise stressed slippage is applied later at order time (evaluateEdge),
 * once the order notional and live depth are known.
 */
export function provisionalNetEdge(
  pWin: number,
  expectedProfit: number,
  expectedLoss: number,
  roundTripFeeFraction: number = DEFAULT_COST_MODEL.roundTripFeeFraction,
  resolveProbability = 1,
  timeoutReturn = 0,
): number {
  return probabilityWeightedGross(pWin, expectedProfit, expectedLoss, resolveProbability, timeoutReturn) -
    roundTripFeeFraction;
}

export interface EdgeInputs {
  pWin: number;            // 0..1  probability the target is hit before the stop
  expectedProfit: number;  // fraction, e.g. 0.004  (target width)
  expectedLoss: number;    // fraction, e.g. 0.003  (stop width, positive number)
  askLevels: OrderbookLevel[]; // for entry slippage (buy side)
  bidLevels: OrderbookLevel[]; // for exit slippage (sell side)
  notional: number;        // planned order size in quote
  bestAsk: number;
  bestBid: number;
  /** v5.3: P(either barrier is touched before the max holding time). 1 = legacy behavior. */
  resolveProbability?: number;
  /** v5.3: expected return if the trade ends at the time exit instead of a barrier. */
  timeoutReturn?: number;
}

export interface EdgeResult {
  enter: boolean;
  expectedNetEdge: number;   // final probability-weighted edge after all costs
  roundTripCost: number;
  entrySlippage: number;
  exitSlippage: number;
  skipReason: string | null; // e.g. "thin_ask_depth", "thin_bid_depth", "edge_below_minimum"
}

/**
 * The single gate. Computes probability-weighted expected net edge including
 * BOTH-side stressed slippage and round-trip fees, and decides entry.
 */
export function evaluateEdge(inputs: EdgeInputs, cfg: CostModelConfig = DEFAULT_COST_MODEL): EdgeResult {
  const entry = stressSlippage(inputs.askLevels, inputs.notional, inputs.bestAsk, cfg.slippage);
  if (entry.skip) {
    return { enter: false, expectedNetEdge: -1, roundTripCost: cfg.roundTripFeeFraction, entrySlippage: entry.slippage, exitSlippage: 0, skipReason: "thin_ask_depth" };
  }
  // Exit is a sell: slippage is downward, measured as the fraction below best bid.
  const exit = stressSellSlippage(inputs.bidLevels, inputs.notional, inputs.bestBid, cfg.slippage);
  if (exit.skip) {
    return { enter: false, expectedNetEdge: -1, roundTripCost: cfg.roundTripFeeFraction, entrySlippage: entry.slippage, exitSlippage: 1, skipReason: "thin_bid_depth" };
  }
  const exitSlip = exit.slippage;

  const grossEdge = probabilityWeightedGross(
    inputs.pWin,
    inputs.expectedProfit,
    inputs.expectedLoss,
    inputs.resolveProbability ?? 1,
    inputs.timeoutReturn ?? 0,
  );
  const expectedNetEdge = grossEdge - cfg.roundTripFeeFraction - entry.slippage - exitSlip;

  return {
    enter: expectedNetEdge >= cfg.minimumEdge,
    expectedNetEdge,
    roundTripCost: cfg.roundTripFeeFraction,
    entrySlippage: entry.slippage,
    exitSlippage: exitSlip,
    skipReason: expectedNetEdge >= cfg.minimumEdge ? null : "edge_below_minimum",
  };
}
