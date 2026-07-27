// Trading-booooo v6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION
//
// Bounded policy evolution for LOB_SCALP.
//
// The bot is allowed to evolve only inside this reviewed schema. It may select among
// evidence sizing, latency protection and EV de-biasing variants, but it may not generate
// source code, add indicators, relax loss rails or bypass the live promotion contract.

export type LobAdaptivePolicyFamily =
  | "BALANCED"
  | "QUALITY_WEIGHTED"
  | "LATENCY_GUARDED"
  | "EV_DEBIASED";

export interface LobAdaptivePolicyDefinition {
  schemaVersion: 1;
  family: LobAdaptivePolicyFamily;
  evidenceSizing: {
    unprovenFloorFraction: number;
    insufficientStatusCap: number;
    lowQualityCap: number;
    dataQualityForFullSize: number;
    featureSamplesForFullSize: number;
    marketSamplesForFullSize: number;
    patternSamplesForFullSize: number;
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
}

export const DEFAULT_LOB_ADAPTIVE_POLICY: LobAdaptivePolicyDefinition = {
  schemaVersion: 1,
  family: "BALANCED",
  evidenceSizing: {
    unprovenFloorFraction: 0.35,
    insufficientStatusCap: 0.55,
    lowQualityCap: 0.40,
    dataQualityForFullSize: 0.75,
    featureSamplesForFullSize: 60,
    marketSamplesForFullSize: 40,
    patternSamplesForFullSize: 100,
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
  const latency = raw?.latency || {} as Partial<LobAdaptivePolicyDefinition["latency"]>;
  const evBias = raw?.evBias || {} as Partial<LobAdaptivePolicyDefinition["evBias"]>;
  const family = ["BALANCED", "QUALITY_WEIGHTED", "LATENCY_GUARDED", "EV_DEBIASED"]
    .includes(String(raw?.family))
    ? raw!.family as LobAdaptivePolicyFamily
    : base.family;

  return {
    schemaVersion: 1,
    family,
    evidenceSizing: {
      unprovenFloorFraction: clamp(
        finite(evidence.unprovenFloorFraction, base.evidenceSizing.unprovenFloorFraction),
        0.10,
        0.60,
      ),
      insufficientStatusCap: clamp(
        finite(evidence.insufficientStatusCap, base.evidenceSizing.insufficientStatusCap),
        0.20,
        0.75,
      ),
      lowQualityCap: clamp(
        finite(evidence.lowQualityCap, base.evidenceSizing.lowQualityCap),
        0.15,
        0.60,
      ),
      dataQualityForFullSize: clamp(
        finite(evidence.dataQualityForFullSize, base.evidenceSizing.dataQualityForFullSize),
        0.50,
        0.95,
      ),
      featureSamplesForFullSize: positiveInt(
        evidence.featureSamplesForFullSize,
        base.evidenceSizing.featureSamplesForFullSize,
        20,
        500,
      ),
      marketSamplesForFullSize: positiveInt(
        evidence.marketSamplesForFullSize,
        base.evidenceSizing.marketSamplesForFullSize,
        10,
        1000,
      ),
      patternSamplesForFullSize: positiveInt(
        evidence.patternSamplesForFullSize,
        base.evidenceSizing.patternSamplesForFullSize,
        20,
        2000,
      ),
    },
    latency: {
      assumedP95Ms: positiveInt(latency.assumedP95Ms, base.latency.assumedP95Ms, 250, 5000),
      unmeasuredFloorBps: clamp(
        finite(latency.unmeasuredFloorBps, base.latency.unmeasuredFloorBps),
        0.25,
        5,
      ),
      penaltyMultiplier: clamp(
        finite(latency.penaltyMultiplier, base.latency.penaltyMultiplier),
        0.75,
        1.75,
      ),
    },
    evBias: {
      penaltyMultiplier: clamp(
        finite(evBias.penaltyMultiplier, base.evBias.penaltyMultiplier),
        0.75,
        1.50,
      ),
      maxPenaltyBps: clamp(
        finite(evBias.maxPenaltyBps, base.evBias.maxPenaltyBps),
        5,
        50,
      ),
    },
  };
}

/**
 * Propose one bounded challenger family from measured operating diagnostics.
 *
 * Priority is deliberate: an unmeasured/breached execution path is corrected before model
 * optimism, and label/feature quality is corrected before any attempt to increase turnover.
 */
export function proposeLobAdaptivePolicy(
  diagnostics: LobAdaptiveDiagnostics,
): LobAdaptivePolicyDefinition {
  const base = normalizeLobAdaptivePolicy(DEFAULT_LOB_ADAPTIVE_POLICY);
  if (!diagnostics.latencyMeasured || diagnostics.latencySloBreached) {
    return normalizeLobAdaptivePolicy({
      ...base,
      family: "LATENCY_GUARDED",
      latency: {
        assumedP95Ms: 2000,
        unmeasuredFloorBps: 1.5,
        penaltyMultiplier: 1.20,
      },
    });
  }
  if (finite(diagnostics.evBiasPenaltyBps, 0) >= 3) {
    return normalizeLobAdaptivePolicy({
      ...base,
      family: "EV_DEBIASED",
      evBias: {
        penaltyMultiplier: 1.20,
        maxPenaltyBps: 35,
      },
    });
  }
  if (clamp(finite(diagnostics.insufficientDataShare, 0), 0, 1) >= 0.30) {
    return normalizeLobAdaptivePolicy({
      ...base,
      family: "QUALITY_WEIGHTED",
      evidenceSizing: {
        ...base.evidenceSizing,
        insufficientStatusCap: 0.45,
        lowQualityCap: 0.30,
        dataQualityForFullSize: 0.82,
        featureSamplesForFullSize: 80,
      },
    });
  }
  return base;
}
