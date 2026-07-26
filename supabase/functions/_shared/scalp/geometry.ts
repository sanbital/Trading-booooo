// Scalp barrier geometry (v5.3 — volatility-scaled targets and horizon).
//
// WHY THIS MODULE EXISTS
// ----------------------
// v5.2.5 used a FIXED target of +0.60% and a fixed stop of -0.30% for every symbol on
// both exchanges. That is unsound for two independent reasons:
//
//   1) Cost. For a barrier pair (T, S) the neutral (no-alpha) probability of touching
//      the target first is S/(T+S). With T=0.60% / S=0.30% the neutral win rate is
//      33.3%, and clearing round-trip cost C plus the minimum edge m requires
//
//          p_required = (C + m + S) / (T + S)
//
//      which on Upbit (C ~= 0.19%) is 65.6% and on Binance (C ~= 0.29%) is 76.7%.
//      The signal model in signal.ts tops out around 0.67 in realistic conditions,
//      so almost nothing could ever pass — and anything that did pass was mispriced.
//
//      Rearranged, the requirement is an EXCESS win rate over neutral of
//
//          delta_required = (C + m) / (T + S)
//
//      i.e. the only way to lower the bar without inventing alpha is to widen T + S.
//
//   2) Dispersion. Short-horizon volatility across the top-40 turnover names differs by
//      3-5x. A fixed 0.60% target is a 3-sigma event on a quiet major and intra-noise on
//      a fast alt. The same number cannot be right for both.
//
// WHAT THIS MODULE DOES
// ---------------------
// Given a per-bar volatility estimate it returns (targetPct, stopPct, horizonMinutes)
// such that:
//   - T + S is wide enough that the required excess win rate is within `edgeBudget`
//     (the excess win rate the operator believes the signal can actually deliver),
//   - and T is also scaled to the symbol's own volatility, so the barrier means the
//     same thing on a quiet major and a fast alt,
//   - and the holding horizon is stretched to the time the symbol actually needs to
//     travel that far, instead of a flat 30 minutes.
//
// It also returns `resolveProbability`: the probability the position reaches EITHER
// barrier before the horizon expires. v5.2.5's EV formula assumed every trade ends at
// a barrier, which silently overstated expected value on slow symbols. cost-model.ts
// now consumes this.
//
// Pure functions only — no I/O, no side effects.

export interface ScalpGeometryConfig {
  /** Round-trip exchange fees as a fraction (Upbit 0.001, Binance 0.002 / 0.0015 with BNB). */
  roundTripFeeFraction: number;
  /** Assumed both-side stressed slippage, as a fraction. Precise slippage is still
   *  computed against the live book at order time; this is only for barrier sizing. */
  slippageAllowance: number;
  /** Required net edge after all costs. */
  minimumEdge: number;
  /**
   * The excess win rate (over the neutral S/(T+S)) that the signal is assumed to
   * deliver. This is the single most important knob in the system: it sets how wide
   * the barriers must be. LOWER value => WIDER barriers => easier to clear costs.
   * 0.10 = "the signal is worth 10 percentage points of win rate".
   */
  edgeBudget: number;
  /** Target : stop ratio. 2.0 => T = 2S. */
  rewardRiskRatio: number;
  /** Target expressed as a multiple of the horizon sigma, before the cost floor. */
  targetSigmaMult: number;
  /** ATR is a mean range, not a standard deviation. sigma ~= ATR * this. */
  atrToSigma: number;
  /** Minutes per volatility bar (ATR is measured on 5m candles). */
  barMinutes: number;
  /** Horizon used to size the volatility-scaled target before the feasibility stretch. */
  baseHorizonMinutes: number;
  minHorizonMinutes: number;
  maxHorizonMinutes: number;
  minTargetPct: number;
  maxTargetPct: number;
  minStopPct: number;
  maxStopPct: number;
  /** Shape constant of the barrier-resolution model. Higher => more optimistic. */
  resolveShape: number;
}

export const DEFAULT_SCALP_GEOMETRY: ScalpGeometryConfig = {
  roundTripFeeFraction: 0.001,
  slippageAllowance: 0.0009,
  minimumEdge: 0.001,
  edgeBudget: 0.10,
  rewardRiskRatio: 2.0,
  targetSigmaMult: 0.90,
  atrToSigma: 0.625,
  barMinutes: 5,
  baseHorizonMinutes: 120,
  minHorizonMinutes: 20,
  maxHorizonMinutes: 240,
  minTargetPct: 0.004,
  maxTargetPct: 0.040,
  minStopPct: 0.002,
  maxStopPct: 0.020,
  resolveShape: 1.4,
};

export const GEOMETRY_BOUNDS: Record<string, { min: number; max: number }> = {
  edgeBudget: { min: 0.02, max: 0.30 },
  rewardRiskRatio: { min: 1.0, max: 4.0 },
  targetSigmaMult: { min: 0.30, max: 3.0 },
  atrToSigma: { min: 0.30, max: 1.0 },
  baseHorizonMinutes: { min: 15, max: 480 },
  minHorizonMinutes: { min: 5, max: 240 },
  maxHorizonMinutes: { min: 20, max: 720 },
  minTargetPct: { min: 0.001, max: 0.02 },
  maxTargetPct: { min: 0.005, max: 0.10 },
  minStopPct: { min: 0.0005, max: 0.01 },
  maxStopPct: { min: 0.002, max: 0.05 },
  resolveShape: { min: 0.5, max: 3.0 },
  slippageAllowance: { min: 0, max: 0.01 },
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function resolveGeometryConfig(
  overrides: Partial<ScalpGeometryConfig> = {},
): ScalpGeometryConfig {
  const merged: ScalpGeometryConfig = { ...DEFAULT_SCALP_GEOMETRY, ...overrides };
  for (const key of Object.keys(GEOMETRY_BOUNDS)) {
    const bound = GEOMETRY_BOUNDS[key];
    const value = (merged as unknown as Record<string, number>)[key];
    (merged as unknown as Record<string, number>)[key] = Number.isFinite(value)
      ? clamp(value, bound.min, bound.max)
      : (DEFAULT_SCALP_GEOMETRY as unknown as Record<string, number>)[key];
  }
  if (merged.maxHorizonMinutes < merged.minHorizonMinutes) {
    merged.maxHorizonMinutes = merged.minHorizonMinutes;
  }
  if (merged.maxTargetPct < merged.minTargetPct) merged.maxTargetPct = merged.minTargetPct;
  if (merged.maxStopPct < merged.minStopPct) merged.maxStopPct = merged.minStopPct;
  return merged;
}

export interface ScalpGeometry {
  targetPct: number;
  stopPct: number;
  horizonMinutes: number;
  /** Per-bar sigma actually used (fraction of price). */
  sigmaBar: number;
  /** Expected absolute move over the full horizon (fraction of price). */
  sigmaHorizon: number;
  /** Target floor imposed purely by cost + edge budget. */
  costFloorTarget: number;
  /** Target implied purely by the symbol's volatility. */
  volatilityTarget: number;
  /** Which of the two bound the result. */
  bindingConstraint: "COST_FLOOR" | "VOLATILITY" | "MAX_TARGET";
  /** Excess win rate this geometry requires to clear all costs plus the minimum edge. */
  requiredExcessWinRate: number;
  /** Neutral (no-alpha) probability of touching the target first. */
  neutralWinRate: number;
  /** P(either barrier is touched before the horizon expires). */
  resolveProbability: number;
  /** Bars the symbol needs, at its own volatility, to travel `targetPct`. */
  barsToTarget: number;
  /** False when even maxHorizonMinutes is not enough for the target to be reachable. */
  horizonSufficient: boolean;
}

/**
 * Convert an ATR percentage (as reported by the scanner, e.g. 0.25 for 0.25%) on
 * `barMinutes` candles into a per-bar sigma expressed as a price fraction.
 * Returns null when the input is unusable, so the caller can fall back explicitly
 * rather than silently trading a made-up volatility.
 */
export function sigmaFromAtrPct(
  atrPct: number | null | undefined,
  cfg: ScalpGeometryConfig = DEFAULT_SCALP_GEOMETRY,
): number | null {
  if (atrPct == null || !Number.isFinite(atrPct) || atrPct <= 0) return null;
  const sigma = (atrPct / 100) * cfg.atrToSigma;
  return sigma > 0 ? sigma : null;
}

/**
 * Probability that a driftless walk with per-bar sigma touches one of two barriers
 * at distances T (up) and S (down) within `bars` bars.
 *
 * Exact first-passage results for a two-sided barrier are not closed-form in a useful
 * way here, so this uses the standard scaling approximation: resolution probability is
 * governed by (expected move over the horizon) / (mean barrier distance), squared.
 * The shape constant is calibratable via `resolveShape` and the whole quantity is
 * logged per trade so it can be replaced with an empirical fit once samples exist.
 */
export function barrierResolveProbability(
  sigmaBar: number,
  bars: number,
  targetPct: number,
  stopPct: number,
  cfg: ScalpGeometryConfig = DEFAULT_SCALP_GEOMETRY,
): number {
  if (!(sigmaBar > 0) || !(bars > 0)) return 0;
  const meanBarrier = (targetPct + stopPct) / 2;
  if (!(meanBarrier > 0)) return 0;
  const horizonMove = sigmaBar * Math.sqrt(bars);
  const ratio = horizonMove / meanBarrier;
  return clamp(1 - Math.exp(-cfg.resolveShape * ratio * ratio), 0.01, 0.995);
}

/**
 * The minimum T + S that keeps the required excess win rate inside `edgeBudget`.
 *
 *     delta_required = (C + m) / (T + S) <= edgeBudget
 *  => T + S >= (C + m) / edgeBudget
 */
export function costFloorWidth(cfg: ScalpGeometryConfig): number {
  const cost = cfg.roundTripFeeFraction + cfg.slippageAllowance;
  return (cost + cfg.minimumEdge) / cfg.edgeBudget;
}

export function resolveScalpGeometry(
  sigmaBar: number | null,
  cfg: ScalpGeometryConfig = DEFAULT_SCALP_GEOMETRY,
): ScalpGeometry {
  const rr = cfg.rewardRiskRatio;
  const floorWidth = costFloorWidth(cfg);
  const costFloorTarget = floorWidth * rr / (1 + rr);

  // Without a usable volatility estimate, fall back to the cost floor alone and the
  // base horizon. resolveProbability then reports 0 so the EV gate blocks the trade
  // rather than pricing it off a guessed sigma.
  if (!(sigmaBar != null && sigmaBar > 0)) {
    const targetPct = clamp(costFloorTarget, cfg.minTargetPct, cfg.maxTargetPct);
    const stopPct = clamp(targetPct / rr, cfg.minStopPct, cfg.maxStopPct);
    return {
      targetPct,
      stopPct,
      horizonMinutes: cfg.baseHorizonMinutes,
      sigmaBar: 0,
      sigmaHorizon: 0,
      costFloorTarget,
      volatilityTarget: 0,
      bindingConstraint: "COST_FLOOR",
      requiredExcessWinRate: (cfg.roundTripFeeFraction + cfg.slippageAllowance + cfg.minimumEdge) /
        (targetPct + stopPct),
      neutralWinRate: stopPct / (targetPct + stopPct),
      resolveProbability: 0,
      barsToTarget: Number.POSITIVE_INFINITY,
      horizonSufficient: false,
    };
  }

  const baseBars = cfg.baseHorizonMinutes / cfg.barMinutes;
  const volatilityTarget = cfg.targetSigmaMult * sigmaBar * Math.sqrt(baseBars);

  const rawTarget = Math.max(costFloorTarget, volatilityTarget);
  const targetPct = clamp(rawTarget, cfg.minTargetPct, cfg.maxTargetPct);
  const stopPct = clamp(targetPct / rr, cfg.minStopPct, cfg.maxStopPct);

  const bindingConstraint: ScalpGeometry["bindingConstraint"] = rawTarget > cfg.maxTargetPct
    ? "MAX_TARGET"
    : volatilityTarget >= costFloorTarget
    ? "VOLATILITY"
    : "COST_FLOOR";

  // Bars this symbol needs, at its own volatility, to cover `targetPct`.
  //   targetPct = targetSigmaMult * sigmaBar * sqrt(bars)  =>  bars = (target / (mult*sigma))^2
  const barsToTarget = Math.pow(targetPct / (cfg.targetSigmaMult * sigmaBar), 2);
  const neededMinutes = barsToTarget * cfg.barMinutes;
  const horizonMinutes = clamp(neededMinutes, cfg.minHorizonMinutes, cfg.maxHorizonMinutes);
  const horizonSufficient = neededMinutes <= cfg.maxHorizonMinutes + 1e-9;

  const allottedBars = horizonMinutes / cfg.barMinutes;
  const resolveProbability = barrierResolveProbability(sigmaBar, allottedBars, targetPct, stopPct, cfg);

  return {
    targetPct,
    stopPct,
    horizonMinutes,
    sigmaBar,
    sigmaHorizon: sigmaBar * Math.sqrt(allottedBars),
    costFloorTarget,
    volatilityTarget,
    bindingConstraint,
    requiredExcessWinRate: (cfg.roundTripFeeFraction + cfg.slippageAllowance + cfg.minimumEdge) /
      (targetPct + stopPct),
    neutralWinRate: stopPct / (targetPct + stopPct),
    resolveProbability,
    barsToTarget,
    horizonSufficient,
  };
}
