/**
 * Strategy evaluation and promotion rule (brief section 8).
 *
 * Pure. Takes closed trades, returns the metrics section 8 requires and a
 * promotion verdict. Two properties matter more than any individual metric:
 *
 *   1. "표본 부족은 표본 부족입니다." A thin sample yields INSUFFICIENT_SAMPLE,
 *      never a flattering point estimate. A strategy that took zero trades is
 *      not a lossless improvement -- it is no evidence at all.
 *   2. Uncertainty is computed on DAY BLOCKS, not on individual trades. Trades
 *      on the same day share a market shock, so treating them as independent
 *      samples shrinks the interval until almost anything looks significant.
 *      Section 8 asks for block-level uncertainty for exactly this reason.
 */

import { Dec, dec, sum, ZERO } from "./decimal.mjs";

export const EVALUATION_VERSION = "BOO-EVALUATION-1";

/** Promotion needs at least this much before a number is worth reading. */
export const MIN_TRADES = 30;
export const MIN_INDEPENDENT_PERIODS = 5;

/**
 * @param {any} trades closed trades
 * @param {any} [opts]
 * @returns {any}
 */
export function evaluate(trades, opts = {}) {
  const {
    minTrades = MIN_TRADES,
    minIndependentPeriods = MIN_INDEPENDENT_PERIODS,
    bootstrapSamples = 2000,
    confidence = 0.95,
    seed = 12345,
  } = opts;

  const rows = (trades ?? [])
    .filter((t) => t && t.net_pnl !== null && t.net_pnl !== undefined)
    .map((t) => ({
      symbol: String(t.symbol ?? ""),
      day: String(t.exit_at ?? t.entry_at ?? "").slice(0, 10),
      net: dec(t.net_pnl),
      gross: t.gross_pnl === undefined || t.gross_pnl === null ? null : dec(t.gross_pnl),
      fees: t.fees === undefined || t.fees === null ? null : dec(t.fees),
      funding: t.funding === undefined || t.funding === null ? null : dec(t.funding),
      r: t.r_multiple === undefined || t.r_multiple === null ? null : dec(t.r_multiple),
      reason: String(t.strategy_exit_reason ?? "UNKNOWN"),
      route: String(t.execution_exit_route ?? "UNKNOWN"),
    }));

  const n = rows.length;
  const days = [...new Set(rows.map((x) => x.day))].filter(Boolean).sort();

  if (n === 0) {
    return {
      version: EVALUATION_VERSION,
      trades: 0,
      independentPeriods: 0,
      // A strategy with no trades is unevaluated, not safe.
      verdict: "INSUFFICIENT_SAMPLE",
      verdictDetail: "0 trades: no evidence either way",
      netExpectancyLowerBound: null,
      metrics: null,
    };
  }

  const wins = rows.filter((x) => x.net.isPos());
  const losses = rows.filter((x) => !x.net.isPos());
  const totalNet = sum(rows.map((x) => x.net));
  const grossProfit = sum(wins.map((x) => x.net));
  const grossLoss = sum(losses.map((x) => x.net)).abs();

  const meanNet = totalNet.div(dec(n));
  const avgWin = wins.length ? sum(wins.map((x) => x.net)).div(dec(wins.length)) : ZERO;
  const avgLoss = losses.length ? sum(losses.map((x) => x.net)).div(dec(losses.length)) : ZERO;

  const rTrades = rows.filter((x) => x.r !== null);
  const meanR = rTrades.length ? sum(rTrades.map((x) => x.r)).div(dec(rTrades.length)) : null;

  // Cost share: what fraction of gross edge the costs consumed. Reported only
  // when gross and fees are both known -- never inferred from net.
  const costed = rows.filter((x) => x.gross !== null && x.fees !== null);
  const grossSum = costed.length ? sum(costed.map((x) => x.gross)) : null;
  const feeSum = costed.length ? sum(costed.map((x) => x.fees)) : null;
  const fundingSum = costed.length ? sum(costed.map((x) => x.funding ?? ZERO)) : null;

  // Equity curve and max drawdown, in trade order. There are no deposits or
  // withdrawals in a shadow book, so no flow adjustment is needed here; a live
  // evaluation MUST subtract them before computing this.
  let equity = ZERO, peak = ZERO, maxDD = ZERO;
  for (const t of rows) {
    equity = equity.add(t.net);
    if (equity.gt(peak)) peak = equity;
    const dd = peak.sub(equity);
    if (dd.gt(maxDD)) maxDD = dd;
  }

  // Worst day and longest losing streak.
  const byDay = new Map();
  for (const t of rows) byDay.set(t.day, (byDay.get(t.day) ?? ZERO).add(t.net));
  let worstDay = ZERO, worstDayAt = null;
  for (const [d, v] of byDay) if (v.lt(worstDay)) { worstDay = v; worstDayAt = d; }
  let streak = 0, worstStreak = 0;
  for (const t of rows) {
    streak = t.net.isPos() ? 0 : streak + 1;
    if (streak > worstStreak) worstStreak = streak;
  }

  // Concentration: how much of the total profit one symbol / one day carries.
  const bySymbol = new Map();
  for (const t of rows) bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? ZERO).add(t.net));
  const topSymbol = [...bySymbol.entries()].sort((a, b) => b[1].cmp(a[1]))[0] ?? null;
  const topDay = [...byDay.entries()].sort((a, b) => b[1].cmp(a[1]))[0] ?? null;

  const exitMix = {};
  for (const t of rows) exitMix[t.reason] = (exitMix[t.reason] ?? 0) + 1;
  const routeMix = {};
  for (const t of rows) routeMix[t.route] = (routeMix[t.route] ?? 0) + 1;

  // Block bootstrap over DAYS.
  const lower = dayBlockBootstrapLowerBound(rows, days, {
    samples: bootstrapSamples,
    confidence,
    seed,
  });

  const metrics = {
    trades: n,
    independentPeriods: days.length,
    winRate: n ? wins.length / n : 0,
    wins: wins.length,
    losses: losses.length,
    netTotal: totalNet,
    netExpectancyPerTrade: meanNet,
    avgWin,
    avgLoss,
    profitFactor: grossLoss.isZero() ? null : grossProfit.div(grossLoss),
    meanR,
    maxDrawdown: maxDD,
    worstDay,
    worstDayAt,
    worstLosingStreak: worstStreak,
    grossTotal: grossSum,
    feeTotal: feeSum,
    fundingTotal: fundingSum,
    // Costs as a share of gross edge; null when gross is unknown rather than
    // back-solved from net (which would double-count).
    costShareOfGross: grossSum && !grossSum.isZero() ? feeSum.div(grossSum.abs()) : null,
    topSymbol: topSymbol ? { symbol: topSymbol[0], net: topSymbol[1] } : null,
    topDay: topDay ? { day: topDay[0], net: topDay[1] } : null,
    profitConcentrationSymbol: topSymbol && totalNet.isPos()
      ? topSymbol[1].div(totalNet)
      : null,
    exitReasonMix: exitMix,
    executionRouteMix: routeMix,
  };

  // Promotion. Sample adequacy is checked BEFORE the point estimate, so a thin
  // but flattering sample cannot be promoted on the strength of its mean.
  let verdict, verdictDetail;
  if (n < minTrades || days.length < minIndependentPeriods) {
    verdict = "INSUFFICIENT_SAMPLE";
    verdictDetail =
      `${n} trades over ${days.length} independent day(s); ` +
      `need >= ${minTrades} trades and >= ${minIndependentPeriods} days`;
  } else if (lower === null) {
    verdict = "INSUFFICIENT_SAMPLE";
    verdictDetail = "block bootstrap could not be computed";
  } else if (lower.gt(ZERO)) {
    verdict = "PROMOTE";
    verdictDetail = `day-block ${confidence * 100}% lower bound ${lower} > 0`;
  } else {
    verdict = "REJECT";
    verdictDetail = `day-block ${confidence * 100}% lower bound ${lower} <= 0`;
  }

  return {
    version: EVALUATION_VERSION,
    trades: n,
    independentPeriods: days.length,
    verdict,
    verdictDetail,
    netExpectancyLowerBound: lower,
    metrics,
  };
}

/**
 * One-sided lower confidence bound on mean net P&L per trade, resampling whole
 * DAYS with replacement.
 *
 * Deterministic: a seeded LCG, so the same input always yields the same bound
 * and an approval can be re-derived by anyone.
 */
export function dayBlockBootstrapLowerBound(rows, days, { samples = 2000, confidence = 0.95, seed = 1 } = {}) {
  if (!rows.length || !days.length) return null;
  const blocks = days.map((d) => rows.filter((r) => r.day === d));
  if (blocks.some((b) => b.length === 0)) return null;

  let state = seed >>> 0;
  const rand = () => {
    // Numerical Recipes LCG; adequate for resampling and fully reproducible.
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const means = [];
  for (let s = 0; s < samples; s++) {
    let total = ZERO, count = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(rand() * blocks.length)];
      for (const t of block) {
        total = total.add(t.net);
        count += 1;
      }
    }
    if (count > 0) means.push(total.div(dec(count)));
  }
  if (!means.length) return null;
  means.sort((a, b) => a.cmp(b));
  const idx = Math.max(0, Math.min(means.length - 1, Math.floor((1 - confidence) * means.length)));
  return means[idx];
}

/**
 * Compare policy variants A–E on the SAME candidates, timestamps, costs and
 * risk basis (section 8).
 *
 * Returns per-variant metrics plus explicit `comparable` flags. A variant whose
 * trades came from a different candidate set or a different cost model is NOT
 * comparable, and saying so is the point: an absolute loss reduction under a
 * different risk basis is not evidence of a better strategy.
 */
export function compareVariants(variants, opts = {}) {
  const out = [];
  const basisOf = (v) => `${v.costModelVersion ?? "?"}|${v.riskBasis ?? "?"}|${v.candidateSetHash ?? "?"}`;
  const bases = new Set((variants ?? []).map(basisOf));
  const comparable = bases.size === 1;

  for (const v of variants ?? []) {
    out.push({
      id: v.id,
      label: v.label ?? v.id,
      basis: basisOf(v),
      comparable,
      evaluation: evaluate(v.trades, opts),
    });
  }
  return {
    version: EVALUATION_VERSION,
    comparable,
    // Stated rather than assumed, so a table cannot silently mix bases.
    incomparableReason: comparable
      ? null
      : `variants span ${bases.size} different cost/risk/candidate bases: ${[...bases].join(" ; ")}`,
    variants: out,
  };
}
