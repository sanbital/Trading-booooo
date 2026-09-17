/**
 * Position sizing under a loss budget (brief section 6).
 *
 * Replaces the fixed 40 USDT margin / 120 USDT notional path that
 * v10-lane-executor hardcodes as `const MARGIN=40,LEV=3,NOTIONAL=MARGIN*LEV`.
 * That path sizes by capital, so the loss it takes when the stop fills is
 * whatever the stop distance happens to be -- on a 38 USDT account, a 120 USDT
 * notional with a 4% stop is a 12% account loss per trade.  Here the loss comes
 * first and the quantity is derived from it.
 *
 * The plan is a function of quantity, not a constant:
 *   - entry VWAP worsens as the order eats the book,
 *   - so does the stop-exit VWAP,
 *   - fees scale with notional,
 * so the planned loss is superlinear in q and cannot be extrapolated from a
 * small probe.  Section 6 requires a step-wise search; `solveQuantity` does a
 * monotone binary search over step multiples and then re-verifies the winner
 * from scratch, so the returned quantity is always one that passed the full
 * check at its own size.
 *
 * Nothing here talks to an exchange or a database.  It is a pure function so
 * the replay, the shadow and the live executor size identically.
 */

import { Dec, dec, ZERO } from "./decimal.mjs";

export const RISK_BUDGET_VERSION = "BOO-RISK-BUDGET-1";

export const SKIP_MIN_NOTIONAL = "MIN_NOTIONAL_EXCEEDS_RISK_BUDGET";

/**
 * Walk one side of the book for `quantity`, returning the fill VWAP.
 *
 * `levels` is [[price, size], ...] best-first.  Returns `null` when the book
 * cannot fill the quantity -- the caller must treat that as "this size is not
 * executable", never as "use the last price we saw".
 */
/** @param {any} levels @param {any} quantity @returns {any} */
export function walkBook(levels, quantity) {
  const q = dec(quantity);
  if (!q.isPos()) return null;
  let remaining = q;
  let cost = ZERO;
  let depth = 0;
  for (const level of levels ?? []) {
    const price = dec(level[0]);
    const size = dec(level[1]);
    if (!price.isPos() || !size.isPos()) continue;
    depth += 1;
    const take = size.min(remaining);
    cost = cost.add(take.mul(price));
    remaining = remaining.sub(take);
    if (!remaining.isPos()) {
      return { vwap: cost.div(q), notional: cost, levelsConsumed: depth, exhausted: false };
    }
  }
  return null; // insufficient depth
}

/**
 * Planned loss for a candidate quantity, in quote currency.
 *
 * planned = q * (entryVwap - stopExitPrice)
 *         + entry fee + stop-exit fee
 *         + conservative funding carry
 *
 * Fees use the ACCOUNT's own commission rates (section 7 forbids the 0.0005
 * documentation constant).  `takerFeeRate`/`stopFeeRate` are fractions.
 * Funding is a signed cost: a positive `expectedFundingCost` is money paid out.
 * An expected funding RECEIPT is floored at zero here -- section 6 forbids
 * treating anticipated funding income as budget that lets you size up.
 */
/** @param {any} args @returns {any} */
export function plannedLoss({
  quantity,
  entryVwap,
  stopExitPrice,
  takerFeeRate,
  stopFeeRate,
  expectedFundingCost = 0,
}) {
  const q = dec(quantity);
  const entry = dec(entryVwap);
  const exit = dec(stopExitPrice);
  const priceLoss = q.mul(entry.sub(exit));
  const entryFee = q.mul(entry).mul(dec(takerFeeRate));
  const exitFee = q.mul(exit).mul(dec(stopFeeRate));
  const funding = dec(expectedFundingCost).max(ZERO);
  return {
    total: priceLoss.add(entryFee).add(exitFee).add(funding),
    priceLoss,
    entryFee,
    exitFee,
    funding,
  };
}

/**
 * Evaluate one candidate quantity completely. Returns `{ok, reasons, plan}`.
 *
 * Every constraint from section 6 is checked here, at this quantity, with this
 * quantity's own VWAPs -- no constraint is carried over from another size.
 */
/** @param {any} quantity @param {any} ctx @returns {any} */
export function evaluateQuantity(quantity, ctx) {
  const {
    policy,
    equity,
    bookAsks,
    bookBids,
    structuralStop,
    stopSlippageFrac,
    takerFeeRate,
    stopFeeRate,
    expectedFundingCost,
    filters,
    reservedRisk,
    openGrossNotional,
    availableMargin,
    leverage,
    dailyRemaining,
    weeklyRemaining,
  } = ctx;

  const q = dec(quantity);
  const reasons = [];
  if (!q.isPos()) return { ok: false, reasons: ["QUANTITY_NOT_POSITIVE"], plan: null };

  // Exchange quantity filters.
  if (q.lt(filters.minQty)) reasons.push("BELOW_MIN_QTY");
  if (filters.maxQty && q.gt(filters.maxQty)) reasons.push("ABOVE_MAX_QTY");
  if (!q.eq(q.floorStep(filters.stepSize))) reasons.push("NOT_ON_STEP_SIZE");

  // Entry VWAP at this size, from real depth.
  const entryWalk = walkBook(bookAsks, q);
  if (!entryWalk) return { ok: false, reasons: [...reasons, "INSUFFICIENT_ASK_DEPTH"], plan: null };

  // Stop-exit VWAP at this size. The stop is a structural price, but the fill
  // is worse than the trigger: walk the bid side for the size, then apply the
  // configured adverse allowance, then take whichever is worse. A stop is not
  // a guarantee (section 6) -- this only makes the PLAN honest, it does not
  // promise the fill.
  const stop = dec(structuralStop);
  const bidWalk = walkBook(bookBids, q);
  const slipped = stop.mul(dec(1).sub(dec(stopSlippageFrac)));
  const stopExit = bidWalk ? slipped.min(bidWalk.vwap.mul(dec(1).sub(dec(stopSlippageFrac)))) : slipped;
  if (stopExit.gte(entryWalk.vwap)) {
    return { ok: false, reasons: [...reasons, "STOP_NOT_BELOW_ENTRY"], plan: null };
  }

  // Notional filter uses the real filled notional, not q * last price.
  const notional = entryWalk.notional;
  if (filters.minNotional && notional.lt(filters.minNotional)) reasons.push("BELOW_MIN_NOTIONAL");

  const loss = plannedLoss({
    quantity: q,
    entryVwap: entryWalk.vwap,
    stopExitPrice: stopExit,
    takerFeeRate,
    stopFeeRate,
    expectedFundingCost,
  });

  const E = dec(equity);
  const tradeBudget = E.mul(policy.riskPerTradeFrac);
  if (loss.total.gt(tradeBudget)) reasons.push("EXCEEDS_TRADE_RISK_BUDGET");

  // Residual risk across open positions AND unfilled reservations.
  const totalOpenRisk = dec(reservedRisk).add(loss.total);
  if (totalOpenRisk.gt(E.mul(policy.maxTotalOpenRiskFrac))) reasons.push("EXCEEDS_TOTAL_OPEN_RISK");

  // Day/week remaining budget.
  if (loss.total.gt(dec(dailyRemaining))) reasons.push("EXCEEDS_DAILY_REMAINING");
  if (loss.total.gt(dec(weeklyRemaining))) reasons.push("EXCEEDS_WEEKLY_REMAINING");

  // Gross notional exposure.
  const gross = dec(openGrossNotional).add(notional);
  if (gross.gt(E.mul(policy.maxGrossNotionalToEquity))) reasons.push("EXCEEDS_GROSS_NOTIONAL");

  // Margin. Leverage is used HERE and only here: it converts notional into the
  // margin the order consumes. It never multiplies the P&L, which is already
  // fully expressed by q * price movement (section 6).
  const lev = dec(leverage);
  if (!lev.isPos()) return { ok: false, reasons: [...reasons, "LEVERAGE_INVALID"], plan: null };
  const margin = notional.div(lev);
  if (margin.gt(dec(availableMargin))) reasons.push("INSUFFICIENT_AVAILABLE_MARGIN");

  return {
    ok: reasons.length === 0,
    reasons,
    plan: {
      quantity: q,
      entryVwap: entryWalk.vwap,
      notional,
      margin,
      stopPrice: stop,
      stopExitPrice: stopExit,
      plannedLoss: loss.total,
      lossBreakdown: loss,
      tradeBudget,
      levelsConsumed: entryWalk.levelsConsumed,
    },
  };
}

/**
 * Find the largest admissible quantity, or SKIP.
 *
 * Binary search over step multiples is valid because every constraint above is
 * monotone non-decreasing in q: planned loss, notional, margin and consumed
 * depth all grow with size, and none of them shrinks. The one non-monotone
 * constraint is BELOW_MIN_QTY / BELOW_MIN_NOTIONAL, which bounds the search
 * from below rather than above, so it is handled by checking the floor first.
 *
 * The result is re-evaluated at its own size before being returned, so a
 * quantity is never emitted on the strength of a neighbouring size's check.
 */
/** @param {any} ctx @returns {any} */
export function solveQuantity(ctx) {
  const { filters, maxSearchSteps = 4096 } = ctx;
  const step = dec(filters.stepSize);

  // Smallest quantity the exchange will accept at all.
  let floorQty = dec(filters.minQty).ceilStep(step);
  if (!floorQty.isPos()) floorQty = step;
  if (filters.minNotional) {
    // Lift the floor to clear minNotional using the best ask; the real check
    // below re-derives notional from the actual walk.
    const best = (ctx.bookAsks ?? [])[0];
    if (best) {
      const need = dec(filters.minNotional).div(dec(best[0])).ceilStep(step);
      if (need.gt(floorQty)) floorQty = need;
    }
  }

  const atFloor = evaluateQuantity(floorQty, ctx);
  if (!atFloor.ok) {
    // The minimum tradable size already breaks a budget. Section 6: this is a
    // SKIP. It is never fixed by rounding the quantity down (it is already at
    // the floor), by moving the stop closer, or by raising the risk limit.
    const budgetBreach = atFloor.reasons.some((r) =>
      r === "EXCEEDS_TRADE_RISK_BUDGET" || r === "EXCEEDS_TOTAL_OPEN_RISK" ||
      r === "EXCEEDS_DAILY_REMAINING" || r === "EXCEEDS_WEEKLY_REMAINING"
    );
    return {
      decision: "SKIP",
      reason: budgetBreach ? SKIP_MIN_NOTIONAL : (atFloor.reasons[0] ?? "MIN_SIZE_NOT_ADMISSIBLE"),
      reasons: atFloor.reasons,
      plan: atFloor.plan,
      version: RISK_BUDGET_VERSION,
    };
  }

  // Grow: find an upper bound that fails, doubling from the floor.
  let lo = floorQty; // known good
  let hi = null; // known bad
  let mult = 2n;
  for (let i = 0; i < 64; i++) {
    const cand = floorQty.mul(dec(mult)).floorStep(step);
    if (cand.lte(lo)) break;
    const stepsFromFloor = Number(cand.sub(floorQty).div(step).toFixed(0));
    if (stepsFromFloor > maxSearchSteps) {
      hi = cand;
      break;
    }
    const r = evaluateQuantity(cand, ctx);
    if (r.ok) {
      lo = cand;
      mult *= 2n;
    } else {
      hi = cand;
      break;
    }
  }

  if (hi) {
    // Binary search the boundary on the step lattice.
    let loSteps = BigInt(lo.div(step).toFixed(0));
    let hiSteps = BigInt(hi.div(step).toFixed(0));
    let guard = 0;
    while (hiSteps - loSteps > 1n && guard++ < 128) {
      const midSteps = (loSteps + hiSteps) / 2n;
      const cand = step.mul(dec(midSteps));
      if (evaluateQuantity(cand, ctx).ok) loSteps = midSteps;
      else hiSteps = midSteps;
    }
    lo = step.mul(dec(loSteps));
  }

  // Re-verify the winner at its own size from scratch.
  const final = evaluateQuantity(lo, ctx);
  if (!final.ok) {
    return {
      decision: "SKIP",
      reason: final.reasons[0] ?? "FINAL_VERIFY_FAILED",
      reasons: final.reasons,
      plan: final.plan,
      version: RISK_BUDGET_VERSION,
    };
  }
  return {
    decision: "ENTER",
    reason: null,
    reasons: [],
    plan: final.plan,
    version: RISK_BUDGET_VERSION,
  };
}

/**
 * Align a structural stop to the tick lattice, then recompute risk from the
 * ALIGNED price (section 5-3).  For a long, the stop moves DOWN to the next
 * tick so alignment can only widen the stop, never secretly tighten it.
 */
export function alignStopForLong(rawStop, tickSize) {
  return dec(rawStop).floorStep(tickSize);
}

/**
 * Cap a BUY limit price to the tick lattice by rounding DOWN (section 5-1), so
 * the allowed-entry ceiling is never exceeded by the rounding itself.
 */
export function alignBuyLimit(rawPrice, tickSize) {
  return dec(rawPrice).floorStep(tickSize);
}
