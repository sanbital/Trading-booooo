// Scalp shadow evaluation (v5.9).
//
// THE PROBLEM THIS SOLVES
// -----------------------
// The calibration loop learned only from positions that actually filled. At the observed
// rate — roughly one live entry every two hours — reaching its 200-sample threshold takes
// about seventeen days, and that assumes entries keep coming. In practice the loop never
// starts, so `edgeBudget` stays a guess, the barrier width derived from it stays wrong,
// and the gate keeps rejecting candidates. The system cannot correct itself out of the
// condition that is stopping it from trading.
//
// Meanwhile the scanner already writes EVERY finalist to `scanner_candidates`, not just
// the ones that pass. At eight finalists per exchange on a sixty-second scan that is about
// 960 rows an hour against 0.5 real fills — roughly 1900x the evidence, already on disk
// and unread.
//
// WHAT THIS MEASURES
// ------------------
// For each scored candidate, replay the price path that followed and ask which barrier it
// would have touched first. That yields the one number the whole design rests on:
//
//     delta = realized target-first rate  -  neutral rate S/(T+S)
//
// `edgeBudget` IS this quantity. Until now it was assumed at 0.10 with no way to check it.
// Measuring it turns barrier sizing from a guess into a fitted parameter — and because
// width is 2C/delta, a correctly measured delta is what lets the gate open.
//
// Shadow outcomes deliberately exclude execution effects: no fill risk, no slippage, no
// maker queue. That is the point. They isolate whether the SIGNAL predicts direction,
// which is exactly what pWin claims and what edgeBudget parameterizes. Execution quality
// is measured separately, from real fills.
//
// Pure functions only — no I/O.

export interface Candle {
  /** Bar open time, epoch ms. */
  ts: number;
  high: number;
  low: number;
  close: number;
}

export type BarrierOutcome = "TARGET" | "STOP" | "TIMEOUT";

export interface ShadowResult {
  outcome: BarrierOutcome;
  /** Bars elapsed before resolution; null when it timed out. */
  barsToResolve: number | null;
  /** Return at the point of resolution, or at the last bar for a timeout. */
  realizedReturn: number;
}

/**
 * Replay a barrier pair over a candle path.
 *
 * When a single bar spans both barriers the outcome is recorded as STOP. Intrabar order is
 * unknowable from OHLC, and assuming the favourable leg would inflate exactly the quantity
 * this module exists to measure honestly.
 */
export function resolveBarrierOutcome(
  candles: Candle[],
  entryPrice: number,
  targetPct: number,
  stopPct: number,
  maxBars = Number.POSITIVE_INFINITY,
): ShadowResult {
  if (!(entryPrice > 0) || !candles.length) {
    return { outcome: "TIMEOUT", barsToResolve: null, realizedReturn: 0 };
  }
  const target = entryPrice * (1 + targetPct);
  const stop = entryPrice * (1 - stopPct);
  const limit = Math.min(candles.length, maxBars);

  for (let i = 0; i < limit; i++) {
    const bar = candles[i];
    const hitStop = bar.low <= stop;
    const hitTarget = bar.high >= target;
    if (hitStop) return { outcome: "STOP", barsToResolve: i + 1, realizedReturn: -stopPct };
    if (hitTarget) return { outcome: "TARGET", barsToResolve: i + 1, realizedReturn: targetPct };
  }
  const last = candles[Math.max(0, limit - 1)];
  return {
    outcome: "TIMEOUT",
    barsToResolve: null,
    realizedReturn: last ? (last.close - entryPrice) / entryPrice : 0,
  };
}

export interface ShadowSample {
  /** Neutral, no-alpha probability implied by this candidate's barriers: S/(T+S). */
  neutralWinRate: number;
  /** Excess probability the microstructure model claimed at scan time. */
  signalEdge: number;
  outcome: BarrierOutcome;
}

export interface EdgeMeasurement {
  /** Candidates whose barriers actually resolved. */
  resolved: number;
  /** Candidates evaluated, including timeouts. */
  total: number;
  resolveRate: number;
  /** Share of resolved candidates that reached the target first. */
  realizedWinRate: number;
  /** Mean neutral rate across the same candidates. */
  neutralWinRate: number;
  /** THE measured quantity: realized minus neutral. This is what edgeBudget means. */
  measuredEdge: number;
  /** Standard error of measuredEdge. */
  standardError: number;
  /** Lower bound of the 95% interval — used so a lucky sample cannot widen the gate. */
  edgeLowerBound: number;
  /** Mean edge the model predicted, for comparison against what was delivered. */
  predictedEdge: number;
}

export function measureEdge(samples: ShadowSample[]): EdgeMeasurement {
  const total = samples.length;
  const resolvedSamples = samples.filter((s) => s.outcome !== "TIMEOUT");
  const resolved = resolvedSamples.length;
  if (resolved === 0) {
    return {
      resolved: 0,
      total,
      resolveRate: 0,
      realizedWinRate: 0,
      neutralWinRate: 0,
      measuredEdge: 0,
      standardError: Number.POSITIVE_INFINITY,
      edgeLowerBound: 0,
      predictedEdge: 0,
    };
  }
  const wins = resolvedSamples.filter((s) => s.outcome === "TARGET").length;
  const realizedWinRate = wins / resolved;
  const neutralWinRate = resolvedSamples.reduce((t, s) => t + s.neutralWinRate, 0) / resolved;
  const predictedEdge = resolvedSamples.reduce((t, s) => t + s.signalEdge, 0) / resolved;
  const measuredEdge = realizedWinRate - neutralWinRate;
  // Binomial standard error on the realized rate.
  const standardError = Math.sqrt(Math.max(1e-12, realizedWinRate * (1 - realizedWinRate) / resolved));
  return {
    resolved,
    total,
    resolveRate: resolved / Math.max(1, total),
    realizedWinRate,
    neutralWinRate,
    measuredEdge,
    standardError,
    edgeLowerBound: measuredEdge - 1.96 * standardError,
    predictedEdge,
  };
}

export interface EdgeBudgetProposalConfig {
  /** Minimum resolved shadow samples before any change is proposed. */
  minSamples: number;
  /** Sample count at which the measurement carries half the weight against the incumbent. */
  priorStrength: number;
  /** Hard bounds, mirroring GEOMETRY_BOUNDS.edgeBudget. */
  minEdgeBudget: number;
  maxEdgeBudget: number;
  /** Relative change below which the proposal is not worth applying. */
  minRelativeChange: number;
}

export const DEFAULT_EDGE_PROPOSAL: EdgeBudgetProposalConfig = {
  minSamples: 200,
  priorStrength: 400,
  minEdgeBudget: 0.02,
  maxEdgeBudget: 0.30,
  minRelativeChange: 0.10,
};

export interface EdgeBudgetProposal {
  apply: boolean;
  reason: string;
  current: number;
  proposed: number;
  measurement: EdgeMeasurement;
}

/**
 * Turn a measurement into a new `edgeBudget`, conservatively.
 *
 * Uses the LOWER bound of the interval, not the point estimate. edgeBudget sets barrier
 * width as 2C/delta, so overstating delta narrows the barriers and quietly demands an edge
 * the signal does not have — the same failure mode as the original hand-picked 0.10, just
 * arrived at with more steps. Understating it only costs some turnover.
 */
export function proposeEdgeBudget(
  measurement: EdgeMeasurement,
  currentEdgeBudget: number,
  cfg: EdgeBudgetProposalConfig = DEFAULT_EDGE_PROPOSAL,
): EdgeBudgetProposal {
  const base = { current: currentEdgeBudget, proposed: currentEdgeBudget, measurement };
  if (measurement.resolved < cfg.minSamples) {
    return { apply: false, reason: `insufficient_samples:${measurement.resolved}/${cfg.minSamples}`, ...base };
  }
  const evidence = Math.max(0, measurement.edgeLowerBound);
  // Shrink toward the incumbent so a single window cannot swing the whole geometry.
  const w = measurement.resolved / (measurement.resolved + cfg.priorStrength);
  const blended = currentEdgeBudget + (evidence - currentEdgeBudget) * w;
  const proposed = Math.max(cfg.minEdgeBudget, Math.min(cfg.maxEdgeBudget, blended));
  const relative = Math.abs(proposed - currentEdgeBudget) / Math.max(1e-9, currentEdgeBudget);
  if (relative < cfg.minRelativeChange) {
    return { apply: false, reason: "no_material_change", ...base, proposed };
  }
  return { apply: true, reason: "measured", ...base, proposed };
}
