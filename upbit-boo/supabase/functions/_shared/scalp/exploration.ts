// Scalp exploration budget (v5.10).
//
// THE PROBLEM
// -----------
// The EV gate rejects a candidate when
//
//     pWin x target - (1-pWin) x stop - cost  <  threshold
//
// and pWin is `neutralWinRate + signalEdge`, where signalEdge comes from weights chosen by
// hand — 0.18 on imbalance, 0.12 on trade pressure, 0.08 on stability, 0.10 on breakout.
// Those numbers have never been measured against an outcome.
//
// So the gate rejects candidates using an expected value computed from unmeasured
// coefficients. If the coefficients are wrong the gate is filtering on noise, and being
// strict with a noisy filter is not caution — it is arbitrary. It has no more
// justification than being loose with it, and it has one extra cost: with no trades there
// are no outcomes, with no outcomes there is no calibration, and the coefficients stay
// unmeasured forever. The system talks itself out of the only activity that could tell it
// whether it is right.
//
// WHAT THIS DOES
// --------------
// Spends a bounded, explicit budget on trades taken for their INFORMATION value: a capped
// number per day, sized down, drawn from the best available candidates, that bypass the EV
// threshold and nothing else.
//
// Safety is untouched. Kill switch, daily loss limit, order-book depth, spread, exchange
// minimums and the operator's allocation all still apply — exploration overrides exactly
// one check, the one built on unmeasured numbers.
//
// The worst case is bounded and small: if the signal has no edge at all, an exploration
// trade loses the round trip. At a third of normal size that is on the order of a few
// hundred won each, against samples that include execution — which shadow replay cannot
// provide.
//
// Pure functions only — no I/O.

export interface ExplorationConfig {
  /** Exploration entries permitted per day. 0 disables the budget entirely. */
  maxPerDay: number;
  /** Exploration entries permitted per scan cycle, so the budget is not spent in one burst. */
  maxPerScan: number;
  /** Size multiplier applied to an exploration entry. */
  sizeFraction: number;
  /**
   * Floor on expected net edge, as a multiple of round-trip cost.
   *
   * Exploration buys information, not lottery tickets. A candidate whose expected value is
   * far below zero is not an uncertain read — it is a bad one, and paying to confirm that
   * teaches nothing the model does not already claim.
   */
  minEdgeCostMultiple: number;
}

export const DEFAULT_EXPLORATION: ExplorationConfig = {
  maxPerDay: 40,
  maxPerScan: 1,
  sizeFraction: 0.33,
  minEdgeCostMultiple: -1,
};

export const EXPLORATION_BOUNDS: Record<string, { min: number; max: number }> = {
  maxPerDay: { min: 0, max: 500 },
  maxPerScan: { min: 0, max: 10 },
  sizeFraction: { min: 0.05, max: 1 },
  minEdgeCostMultiple: { min: -5, max: 0 },
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function resolveExplorationConfig(overrides: Partial<ExplorationConfig> = {}): ExplorationConfig {
  const merged: ExplorationConfig = { ...DEFAULT_EXPLORATION, ...overrides };
  for (const key of Object.keys(EXPLORATION_BOUNDS)) {
    const bound = EXPLORATION_BOUNDS[key];
    const value = (merged as unknown as Record<string, number>)[key];
    (merged as unknown as Record<string, number>)[key] = Number.isFinite(value)
      ? clamp(value, bound.min, bound.max)
      : (DEFAULT_EXPLORATION as unknown as Record<string, number>)[key];
  }
  return merged;
}

/** The only gate reason exploration may override. Everything else is a real constraint. */
export const OVERRIDABLE_BLOCK_REASON = "edge_below_minimum";

export interface ExplorationInput {
  /** Why the normal gate refused this candidate. */
  blockReason: string | null;
  /** Expected net edge the gate computed, after all costs. */
  expectedNetEdge: number | null;
  /** Round-trip cost used in that computation. */
  roundTripCost: number;
  usedToday: number;
  usedThisScan: number;
}

export interface ExplorationDecision {
  explore: boolean;
  reason: string;
  /** Multiplier to apply to the order size. 1 when not exploring. */
  sizeFraction: number;
}

/**
 * Decide whether to spend budget on a candidate the EV gate refused.
 *
 * Returns explore=false for every reason other than a marginal expected value, including
 * thin depth, a halted account and a kill switch. Those are facts about the market or the
 * operator's instructions; only the threshold rests on unmeasured coefficients.
 */
export function evaluateExploration(
  input: ExplorationInput,
  cfg: ExplorationConfig = DEFAULT_EXPLORATION,
): ExplorationDecision {
  const no = (reason: string): ExplorationDecision => ({ explore: false, reason, sizeFraction: 1 });

  if (cfg.maxPerDay <= 0 || cfg.maxPerScan <= 0) return no("exploration_disabled");
  if (input.blockReason !== OVERRIDABLE_BLOCK_REASON) return no(`not_overridable:${input.blockReason ?? "none"}`);
  if (input.usedToday >= cfg.maxPerDay) return no("daily_budget_spent");
  if (input.usedThisScan >= cfg.maxPerScan) return no("scan_budget_spent");

  const edge = input.expectedNetEdge;
  if (edge == null || !Number.isFinite(edge)) return no("edge_unknown");
  const floor = cfg.minEdgeCostMultiple * Math.max(0, input.roundTripCost);
  if (edge < floor) return no("edge_below_exploration_floor");

  return { explore: true, reason: "exploring", sizeFraction: cfg.sizeFraction };
}

export interface ExplorationCostEstimate {
  tradesPerDay: number;
  /** Worst case: the signal has no edge and every exploration trade loses the round trip. */
  worstCaseDailyLossFraction: number;
  samplesPerDay: number;
}

/**
 * What the budget costs if the signal turns out to be worthless, as a fraction of total
 * capital. Stated explicitly because "trade in order to learn" is only defensible when the
 * tuition is known in advance.
 */
export function estimateExplorationCost(
  cfg: ExplorationConfig,
  roundTripCost: number,
  slots: number,
): ExplorationCostEstimate {
  const perTrade = roundTripCost * cfg.sizeFraction / Math.max(1, slots);
  return {
    tradesPerDay: cfg.maxPerDay,
    worstCaseDailyLossFraction: perTrade * cfg.maxPerDay,
    samplesPerDay: cfg.maxPerDay,
  };
}
