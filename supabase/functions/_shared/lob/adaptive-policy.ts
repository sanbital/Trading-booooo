// Trading-booooo v6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE
//
// Bounded, auditable policy evolution for LOB_SCALP. The learner may select only from this
// reviewed schema. It cannot generate source code, relax operator loss rails, alter exchange
// permissions, or promote evidence whose fee/residual accounting is not verified.

export type LobAdaptivePolicyFamily =
  | "BALANCED"
  | "QUALITY_WEIGHTED"
  | "LATENCY_GUARDED"
  | "EV_DEBIASED";

export interface LobAdaptivePolicyDefinition {
  schemaVersion: 2;
  family: LobAdaptivePolicyFamily;
  evidenceSizing: {
    unprovenFloorFraction: number;
    insufficientStatusCap: number;
    lowQualityCap: number;
    dataQualityForFullSize: number;
    featureSamplesForFullSize: number;
    marketSamplesForFullSize: number;
    patternSamplesForFullSize: number;
    /** Parent evidence may help a new market but may never make it full-size alone. */
    parentEvidenceCap: number;
    /** Old samples lose sizing authority even when their raw count remains high. */
    evidenceHalfLifeHours: number;
  };
  exploration: {
    /** Daily loss budget for low-evidence trades as a fraction of managed capital. */
    dailyLossBudgetFraction: number;
    maxConcurrentLowEvidence: number;
  };
  latency: {
    assumedP95Ms: number;
    unmeasuredFloorBps: number;
    penaltyMultiplier: number;
  };
  evBias: {
    penaltyMultiplier: number;
    maxPenaltyBps: number;
  };
}

export interface LobAdaptiveDiagnostics {
  latencyMeasured: boolean;
  latencySloBreached: boolean;
  evBiasPenaltyBps: number;
  insufficientDataShare: number;
  currentFamily?: LobAdaptivePolicyFamily | null;
  /** Monotone proposal sequence, persisted by the calibration job. */
  proposalRound?: number;
}

export const DEFAULT_LOB_ADAPTIVE_POLICY: LobAdaptivePolicyDefinition = {
  schemaVersion: 2,
  family: "BALANCED",
  evidenceSizing: {
    unprovenFloorFraction: 0.35,
    insufficientStatusCap: 0.55,
    lowQualityCap: 0.40,
    dataQualityForFullSize: 0.75,
    featureSamplesForFullSize: 60,
    marketSamplesForFullSize: 40,
    patternSamplesForFullSize: 100,
    parentEvidenceCap: 0.75,
    evidenceHalfLifeHours: 168,
  },
  exploration: {
    dailyLossBudgetFraction: 0.003,
    maxConcurrentLowEvidence: 1,
  },
  latency: {
    assumedP95Ms: 1500,
    unmeasuredFloorBps: 1,
    penaltyMultiplier: 1,
  },
  evBias: {
    penaltyMultiplier: 1,
    maxPenaltyBps: 30,
  },
};

function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}
function positiveInt(value: unknown, fallback: number, low: number, high: number): number {
  return Math.round(clamp(finite(value, fallback), low, high));
}

export function normalizeLobAdaptivePolicy(
  raw: Partial<LobAdaptivePolicyDefinition> | null | undefined,
): LobAdaptivePolicyDefinition {
  const base = DEFAULT_LOB_ADAPTIVE_POLICY;
  const evidence = raw?.evidenceSizing || {} as Partial<LobAdaptivePolicyDefinition["evidenceSizing"]>;
  const exploration = raw?.exploration || {} as Partial<LobAdaptivePolicyDefinition["exploration"]>;
  const latency = raw?.latency || {} as Partial<LobAdaptivePolicyDefinition["latency"]>;
  const evBias = raw?.evBias || {} as Partial<LobAdaptivePolicyDefinition["evBias"]>;
  const family = ["BALANCED", "QUALITY_WEIGHTED", "LATENCY_GUARDED", "EV_DEBIASED"]
    .includes(String(raw?.family))
    ? raw!.family as LobAdaptivePolicyFamily
    : base.family;
  return {
    schemaVersion: 2,
    family,
    evidenceSizing: {
      unprovenFloorFraction: clamp(finite(evidence.unprovenFloorFraction, base.evidenceSizing.unprovenFloorFraction), 0.10, 0.60),
      insufficientStatusCap: clamp(finite(evidence.insufficientStatusCap, base.evidenceSizing.insufficientStatusCap), 0.20, 0.75),
      lowQualityCap: clamp(finite(evidence.lowQualityCap, base.evidenceSizing.lowQualityCap), 0.15, 0.60),
      dataQualityForFullSize: clamp(finite(evidence.dataQualityForFullSize, base.evidenceSizing.dataQualityForFullSize), 0.50, 0.95),
      featureSamplesForFullSize: positiveInt(evidence.featureSamplesForFullSize, base.evidenceSizing.featureSamplesForFullSize, 20, 500),
      marketSamplesForFullSize: positiveInt(evidence.marketSamplesForFullSize, base.evidenceSizing.marketSamplesForFullSize, 10, 1000),
      patternSamplesForFullSize: positiveInt(evidence.patternSamplesForFullSize, base.evidenceSizing.patternSamplesForFullSize, 20, 2000),
      parentEvidenceCap: clamp(finite(evidence.parentEvidenceCap, base.evidenceSizing.parentEvidenceCap), 0.40, 0.90),
      evidenceHalfLifeHours: positiveInt(evidence.evidenceHalfLifeHours, base.evidenceSizing.evidenceHalfLifeHours, 24, 24 * 90),
    },
    exploration: {
      dailyLossBudgetFraction: clamp(finite(exploration.dailyLossBudgetFraction, base.exploration.dailyLossBudgetFraction), 0.0005, 0.02),
      maxConcurrentLowEvidence: positiveInt(exploration.maxConcurrentLowEvidence, base.exploration.maxConcurrentLowEvidence, 1, 3),
    },
    latency: {
      assumedP95Ms: positiveInt(latency.assumedP95Ms, base.latency.assumedP95Ms, 250, 5000),
      unmeasuredFloorBps: clamp(finite(latency.unmeasuredFloorBps, base.latency.unmeasuredFloorBps), 0.25, 5),
      penaltyMultiplier: clamp(finite(latency.penaltyMultiplier, base.latency.penaltyMultiplier), 0.75, 1.75),
    },
    evBias: {
      penaltyMultiplier: clamp(finite(evBias.penaltyMultiplier, base.evBias.penaltyMultiplier), 0.75, 1.50),
      maxPenaltyBps: clamp(finite(evBias.maxPenaltyBps, base.evBias.maxPenaltyBps), 5, 50),
    },
  };
}

function policyForFamily(family: LobAdaptivePolicyFamily): LobAdaptivePolicyDefinition {
  const base = normalizeLobAdaptivePolicy(DEFAULT_LOB_ADAPTIVE_POLICY);
  if (family === "LATENCY_GUARDED") return normalizeLobAdaptivePolicy({
    ...base,
    family,
    latency: { assumedP95Ms: 2000, unmeasuredFloorBps: 1.5, penaltyMultiplier: 1.20 },
  });
  if (family === "EV_DEBIASED") return normalizeLobAdaptivePolicy({
    ...base,
    family,
    evBias: { penaltyMultiplier: 1.20, maxPenaltyBps: 35 },
  });
  if (family === "QUALITY_WEIGHTED") return normalizeLobAdaptivePolicy({
    ...base,
    family,
    evidenceSizing: {
      ...base.evidenceSizing,
      insufficientStatusCap: 0.45,
      lowQualityCap: 0.30,
      dataQualityForFullSize: 0.82,
      featureSamplesForFullSize: 80,
    },
    exploration: { dailyLossBudgetFraction: 0.002, maxConcurrentLowEvidence: 1 },
  });
  return base;
}

/**
 * Deterministic bounded challenger rotation. Diagnostics rank the relevant families, while
 * proposalRound rotates ties and prevents the system from proposing LATENCY_GUARDED forever
 * merely because latency is still unmeasured. Safety is preserved because every family uses
 * the same hard accounting, loss and promotion contracts.
 */
export function proposeLobAdaptivePolicy(
  diagnostics: LobAdaptiveDiagnostics,
): LobAdaptivePolicyDefinition {
  const scores: Array<{ family: LobAdaptivePolicyFamily; score: number }> = [
    {
      family: "LATENCY_GUARDED",
      score: (!diagnostics.latencyMeasured ? 2 : 0) + (diagnostics.latencySloBreached ? 3 : 0),
    },
    { family: "EV_DEBIASED", score: clamp(finite(diagnostics.evBiasPenaltyBps, 0) / 3, 0, 4) },
    { family: "QUALITY_WEIGHTED", score: clamp(finite(diagnostics.insufficientDataShare, 0), 0, 1) * 4 },
    { family: "BALANCED", score: 0.25 },
  ].sort((a, b) => b.score - a.score || a.family.localeCompare(b.family));
  const current = diagnostics.currentFamily || null;
  const round = Math.max(0, Math.floor(finite(diagnostics.proposalRound, 0)));
  const viable = scores.filter((row) => row.score >= Math.max(0.25, scores[0].score * 0.40));
  const start = round % viable.length;
  for (let offset = 0; offset < viable.length; offset++) {
    const family = viable[(start + offset) % viable.length].family;
    if (viable.length === 1 || family !== current) return policyForFamily(family);
  }
  return policyForFamily(scores[0].family);
}
