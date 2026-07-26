// Trading-booooo v5.12 — throughput controller.
//
// Non-negotiable invariant: trade-rate control may change capacity (slots, scan breadth,
// evaluation cadence and shadow-label volume), but it may NEVER reduce EV, win-rate,
// fill-rate, liquidity, exposure or loss-limit gates.

export interface RateControlConfig {
  /** Filled entries per hour, per exchange. A target, never a reason to weaken quality. */
  targetTradesPerHour: number;
  windowMinutes: number;
  minSlots: number;
  maxSlots: number;
  targetUtilization: number;
  minScanUniverse: number;
  maxScanUniverse: number;
  minEvaluationIntervalSeconds: number;
  maxEvaluationIntervalSeconds: number;
  slotStep: number;
  scanUniverseStep: number;
  evaluationStepSeconds: number;
  unprovenSizeFraction: number;
  samplesForFullSize: number;
  negativeEdgeThreshold: number;
}

export const DEFAULT_RATE_CONTROL: RateControlConfig = {
  targetTradesPerHour: 5,
  windowMinutes: 60,
  minSlots: 2,
  maxSlots: 12,
  targetUtilization: 0.70,
  minScanUniverse: 30,
  maxScanUniverse: 240,
  minEvaluationIntervalSeconds: 30,
  maxEvaluationIntervalSeconds: 300,
  slotStep: 1,
  scanUniverseStep: 20,
  evaluationStepSeconds: 15,
  unprovenSizeFraction: 0.35,
  samplesForFullSize: 400,
  negativeEdgeThreshold: 0,
};

export const RATE_CONTROL_BOUNDS: Record<keyof RateControlConfig, { min: number; max: number }> = {
  targetTradesPerHour: { min: 0, max: 60 },
  windowMinutes: { min: 10, max: 1440 },
  minSlots: { min: 1, max: 20 },
  maxSlots: { min: 1, max: 20 },
  targetUtilization: { min: 0.1, max: 0.95 },
  minScanUniverse: { min: 10, max: 1000 },
  maxScanUniverse: { min: 10, max: 1000 },
  minEvaluationIntervalSeconds: { min: 15, max: 3600 },
  maxEvaluationIntervalSeconds: { min: 15, max: 3600 },
  slotStep: { min: 1, max: 5 },
  scanUniverseStep: { min: 1, max: 200 },
  evaluationStepSeconds: { min: 1, max: 300 },
  unprovenSizeFraction: { min: 0.05, max: 1 },
  samplesForFullSize: { min: 50, max: 20_000 },
  negativeEdgeThreshold: { min: -0.5, max: 0.1 },
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
}

export function resolveRateControlConfig(overrides: Partial<RateControlConfig> = {}): RateControlConfig {
  const merged = { ...DEFAULT_RATE_CONTROL, ...overrides } as RateControlConfig;
  for (const key of Object.keys(RATE_CONTROL_BOUNDS) as Array<keyof RateControlConfig>) {
    const bound = RATE_CONTROL_BOUNDS[key];
    merged[key] = clamp(Number(merged[key]), bound.min, bound.max) as never;
  }
  if (merged.maxSlots < merged.minSlots) merged.maxSlots = merged.minSlots;
  if (merged.maxScanUniverse < merged.minScanUniverse) merged.maxScanUniverse = merged.minScanUniverse;
  if (merged.maxEvaluationIntervalSeconds < merged.minEvaluationIntervalSeconds) {
    merged.maxEvaluationIntervalSeconds = merged.minEvaluationIntervalSeconds;
  }
  return merged;
}

export interface RateControlInput {
  entriesInWindow: number;
  observedMinutes: number;
  currentSlots: number;
  currentScanUniverse: number;
  currentEvaluationIntervalSeconds: number;
  averageHoldingMinutes: number;
  /** Conservative fill probability. Used only to calculate required attempts/capacity. */
  pFillLowerBound: number;
  edgeSamples: number;
  measuredEdgeLowerBound: number | null;
  /** Kept for wire compatibility with v5.11; ignored and always reset to zero. */
  currentRelaxation?: number;
}

export interface RateControlDecision {
  /** Always zero. v5.12 forbids threshold relaxation. */
  relaxation: 0;
  sizeFraction: number;
  observedRate: number;
  targetRate: number;
  edgeNegative: boolean;
  desiredSlots: number;
  scanUniverse: number;
  evaluationIntervalSeconds: number;
  attemptsRequiredPerHour: number;
  estimatedFilledCapacityPerHour: number;
  reason: string;
}

export function calculateDesiredSlots(
  targetFilledEntriesPerHour: number,
  averageHoldingMinutes: number,
  targetUtilization: number,
  minSlots: number,
  maxSlots: number,
): number {
  const raw = Math.max(0, targetFilledEntriesPerHour) *
    (Math.max(1, averageHoldingMinutes) / 60) /
    Math.max(targetUtilization, 0.1);
  return Math.min(maxSlots, Math.max(minSlots, Math.ceil(raw)));
}

/** Size can grow only with positive lower-bound evidence, never merely with sample count. */
export function sizeForEvidence(
  edgeSamples: number,
  measuredEdgeLowerBound: number | null,
  cfg: RateControlConfig = DEFAULT_RATE_CONTROL,
): number {
  if (measuredEdgeLowerBound == null || edgeSamples <= 0) return cfg.unprovenSizeFraction;
  if (measuredEdgeLowerBound <= cfg.negativeEdgeThreshold) return cfg.unprovenSizeFraction;
  const confidence = clamp(edgeSamples / cfg.samplesForFullSize, 0, 1);
  return clamp(
    cfg.unprovenSizeFraction + (1 - cfg.unprovenSizeFraction) * confidence,
    cfg.unprovenSizeFraction,
    1,
  );
}

export function evaluateRateControl(
  input: RateControlInput,
  cfg: RateControlConfig = DEFAULT_RATE_CONTROL,
): RateControlDecision {
  const minutes = Math.max(1, input.observedMinutes);
  const observedRate = Math.max(0, input.entriesInWindow) * 60 / minutes;
  const sizeFraction = sizeForEvidence(input.edgeSamples, input.measuredEdgeLowerBound, cfg);
  const edgeNegative = input.measuredEdgeLowerBound != null &&
    input.edgeSamples >= cfg.samplesForFullSize / 2 &&
    input.measuredEdgeLowerBound <= cfg.negativeEdgeThreshold;
  const fill = clamp(input.pFillLowerBound, 0.01, 1);
  const attemptsRequiredPerHour = cfg.targetTradesPerHour <= 0 ? 0 : cfg.targetTradesPerHour / fill;
  const formulaSlots = calculateDesiredSlots(
    cfg.targetTradesPerHour,
    input.averageHoldingMinutes,
    cfg.targetUtilization,
    cfg.minSlots,
    cfg.maxSlots,
  );

  let desiredSlots = clamp(Math.round(input.currentSlots), cfg.minSlots, cfg.maxSlots);
  let scanUniverse = clamp(Math.round(input.currentScanUniverse), cfg.minScanUniverse, cfg.maxScanUniverse);
  let evaluationIntervalSeconds = clamp(
    Math.round(input.currentEvaluationIntervalSeconds),
    cfg.minEvaluationIntervalSeconds,
    cfg.maxEvaluationIntervalSeconds,
  );
  let reason = "capacity_stable";

  if (edgeNegative) {
    // Capacity is not pushed into a measured negative signal. Quality gates still decide
    // every candidate and size remains at the unproven fraction.
    reason = "measured_edge_negative_capacity_frozen";
  } else if (cfg.targetTradesPerHour <= 0) {
    reason = "rate_target_disabled";
  } else if (observedRate < cfg.targetTradesPerHour) {
    desiredSlots = Math.min(cfg.maxSlots, Math.max(formulaSlots, desiredSlots + cfg.slotStep));
    scanUniverse = Math.min(cfg.maxScanUniverse, scanUniverse + cfg.scanUniverseStep);
    evaluationIntervalSeconds = Math.max(
      cfg.minEvaluationIntervalSeconds,
      evaluationIntervalSeconds - cfg.evaluationStepSeconds,
    );
    reason = desiredSlots >= cfg.maxSlots && scanUniverse >= cfg.maxScanUniverse &&
        evaluationIntervalSeconds <= cfg.minEvaluationIntervalSeconds
      ? "below_target_at_capacity_limit"
      : "below_target_increasing_capacity";
  } else {
    // Reduce only obvious excess capacity; never below the formula-derived slot need.
    desiredSlots = Math.max(formulaSlots, cfg.minSlots, desiredSlots - cfg.slotStep);
    scanUniverse = Math.max(cfg.minScanUniverse, scanUniverse - cfg.scanUniverseStep);
    evaluationIntervalSeconds = Math.min(
      cfg.maxEvaluationIntervalSeconds,
      evaluationIntervalSeconds + cfg.evaluationStepSeconds,
    );
    reason = "at_or_above_target_releasing_capacity";
  }

  const estimatedFilledCapacityPerHour = desiredSlots * 60 /
    Math.max(1, input.averageHoldingMinutes) * cfg.targetUtilization;
  return {
    relaxation: 0,
    sizeFraction,
    observedRate,
    targetRate: cfg.targetTradesPerHour,
    edgeNegative,
    desiredSlots,
    scanUniverse,
    evaluationIntervalSeconds,
    attemptsRequiredPerHour,
    estimatedFilledCapacityPerHour,
    reason,
  };
}

/** @deprecated v5.12 never relaxes EV thresholds. Kept to make stale callers fail safe. */
export function relaxedMinimumEdge(
  baseMinimumEdge: number,
  _relaxation: number,
  _roundTripCost: number,
): number {
  return Math.max(0, baseMinimumEdge);
}
