// Scalp trade-rate controller (v5.11).
//
// THE TARGET
// ----------
// Roughly five entries per hour per exchange. Trade frequency is not an outcome to be
// hoped for, it is the control variable — the gate exists to serve the rate, not the other
// way round.
//
// WHY A CONTROLLER RATHER THAN A LOOSER CONSTANT
// ----------------------------------------------
// Every previous attempt set the EV threshold to a fixed number and let the trade rate be
// whatever fell out. It fell out at roughly one entry every two hours. Loosening the
// constant by hand would just move the failure: too tight and nothing trades, too loose and
// nothing is filtered, and neither setting knows which it is because the coefficients
// inside pWin have never been measured.
//
// Measuring the realized rate and steering toward the target closes that loop. The
// threshold becomes whatever produces five trades an hour, bounded.
//
// WHY SIZE IS THE RISK KNOB, NOT RATE
// -----------------------------------
// At 240 entries a day the arithmetic is brutal and symmetric:
//
//     edge = 0    ->  -3.2% per day  ->  about -62% in a month
//     edge = +10pp -> +3.2% per day  ->  about +157% in a month
//
// Frequency amplifies the sign of the edge; it does not create one. So rate is held at the
// target and SIZE carries the uncertainty: small while the edge is unmeasured, full once
// shadow outcomes confirm it. That way the samples needed to settle the question arrive at
// full speed while the capital exposed to the answer stays small.
//
// The one case where the controller stops pushing is a MEASURED negative edge. That is not
// caution — it is the measurement doing its job.
//
// Pure functions only — no I/O.

export interface RateControlConfig {
  /** Entries per hour, per exchange. */
  targetTradesPerHour: number;
  /** Rolling window used to measure the realized rate. */
  windowMinutes: number;
  /** Cap on threshold relaxation, as a multiple of round-trip cost. */
  maxRelaxationCostMultiple: number;
  /** Relaxation added per cycle when under target. */
  relaxationStep: number;
  /** Relaxation removed per cycle when at or above target. */
  tightenStep: number;
  /** Order size while the edge is still unmeasured. */
  unprovenSizeFraction: number;
  /** Resolved shadow samples required before size is allowed to reach full. */
  samplesForFullSize: number;
  /** Measured edge below this, with enough samples, stops the controller pushing. */
  negativeEdgeThreshold: number;
}

export const DEFAULT_RATE_CONTROL: RateControlConfig = {
  targetTradesPerHour: 5,
  windowMinutes: 60,
  maxRelaxationCostMultiple: 1.5,
  relaxationStep: 0.15,
  tightenStep: 0.25,
  unprovenSizeFraction: 0.35,
  samplesForFullSize: 400,
  negativeEdgeThreshold: 0,
};

export const RATE_CONTROL_BOUNDS: Record<string, { min: number; max: number }> = {
  targetTradesPerHour: { min: 0, max: 60 },
  windowMinutes: { min: 10, max: 1440 },
  maxRelaxationCostMultiple: { min: 0, max: 5 },
  relaxationStep: { min: 0.01, max: 1 },
  tightenStep: { min: 0.01, max: 1 },
  unprovenSizeFraction: { min: 0.05, max: 1 },
  samplesForFullSize: { min: 50, max: 20_000 },
  negativeEdgeThreshold: { min: -0.5, max: 0.1 },
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function resolveRateControlConfig(overrides: Partial<RateControlConfig> = {}): RateControlConfig {
  const merged: RateControlConfig = { ...DEFAULT_RATE_CONTROL, ...overrides };
  for (const key of Object.keys(RATE_CONTROL_BOUNDS)) {
    const bound = RATE_CONTROL_BOUNDS[key];
    const value = (merged as unknown as Record<string, number>)[key];
    (merged as unknown as Record<string, number>)[key] = Number.isFinite(value)
      ? clamp(value, bound.min, bound.max)
      : (DEFAULT_RATE_CONTROL as unknown as Record<string, number>)[key];
  }
  return merged;
}

export interface RateControlInput {
  /** Entries actually opened on this exchange inside the window. */
  entriesInWindow: number;
  /** Length of the window actually observed, in minutes. */
  observedMinutes: number;
  /** Relaxation currently in effect, as a multiple of round-trip cost. */
  currentRelaxation: number;
  /** Resolved shadow samples backing the edge measurement. */
  edgeSamples: number;
  /** Lower bound of the measured edge. null when nothing has been measured yet. */
  measuredEdgeLowerBound: number | null;
}

export interface RateControlDecision {
  /** Multiple of round-trip cost to subtract from the EV threshold. */
  relaxation: number;
  /** Multiplier applied to order size. */
  sizeFraction: number;
  observedRate: number;
  targetRate: number;
  /** True when a measured negative edge has stopped the controller. */
  edgeNegative: boolean;
  reason: string;
}

/**
 * Size as a function of evidence, not of nerve.
 *
 * Unmeasured edge means small size at full rate: the samples that settle the question
 * arrive quickly while little capital rides on the answer. Size grows with sample count
 * only once the measured edge is positive.
 */
export function sizeForEvidence(
  edgeSamples: number,
  measuredEdgeLowerBound: number | null,
  cfg: RateControlConfig = DEFAULT_RATE_CONTROL,
): number {
  if (measuredEdgeLowerBound == null || edgeSamples <= 0) return cfg.unprovenSizeFraction;
  if (measuredEdgeLowerBound <= cfg.negativeEdgeThreshold) return cfg.unprovenSizeFraction;
  const confidence = clamp(edgeSamples / cfg.samplesForFullSize, 0, 1);
  return clamp(cfg.unprovenSizeFraction + (1 - cfg.unprovenSizeFraction) * confidence, cfg.unprovenSizeFraction, 1);
}

export function evaluateRateControl(
  input: RateControlInput,
  cfg: RateControlConfig = DEFAULT_RATE_CONTROL,
): RateControlDecision {
  const minutes = Math.max(1, input.observedMinutes);
  const observedRate = input.entriesInWindow * 60 / minutes;
  const sizeFraction = sizeForEvidence(input.edgeSamples, input.measuredEdgeLowerBound, cfg);
  const edgeNegative = input.measuredEdgeLowerBound != null &&
    input.edgeSamples >= cfg.samplesForFullSize / 2 &&
    input.measuredEdgeLowerBound <= cfg.negativeEdgeThreshold;

  const base = { sizeFraction, observedRate, targetRate: cfg.targetTradesPerHour, edgeNegative };

  // A measured negative edge is the one condition that stops the controller. Pushing rate
  // into a signal that has been shown not to work is not persistence, it is paying to be
  // wrong faster.
  if (edgeNegative) {
    return { ...base, relaxation: 0, reason: "measured_edge_negative" };
  }
  if (cfg.targetTradesPerHour <= 0) {
    return { ...base, relaxation: 0, reason: "rate_target_disabled" };
  }

  if (observedRate < cfg.targetTradesPerHour) {
    const relaxation = clamp(
      input.currentRelaxation + cfg.relaxationStep,
      0,
      cfg.maxRelaxationCostMultiple,
    );
    const reason = relaxation >= cfg.maxRelaxationCostMultiple
      ? "below_target_at_max_relaxation"
      : "below_target_relaxing";
    return { ...base, relaxation, reason };
  }
  return {
    ...base,
    relaxation: clamp(input.currentRelaxation - cfg.tightenStep, 0, cfg.maxRelaxationCostMultiple),
    reason: "at_or_above_target_tightening",
  };
}

/**
 * The EV threshold after relaxation. Never negative: the controller can remove the margin
 * above cost, but it cannot make the engine accept a trade it expects to lose money on.
 */
export function relaxedMinimumEdge(
  baseMinimumEdge: number,
  relaxation: number,
  roundTripCost: number,
): number {
  return Math.max(0, baseMinimumEdge - Math.max(0, relaxation) * Math.max(0, roundTripCost));
}
