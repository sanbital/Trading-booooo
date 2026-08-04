// Trading-booooo v7.4.0-STATISTICAL-FEATURE-EVIDENCE — evidence-to-authority mapping.
//
// `feature-significance.ts` answers "what did the data show". This module answers the only
// question the trading path cares about: which recorded variables are allowed to change a
// live decision, and how far.
//
// Three authority levels, in increasing order:
//
//   NONE      — informational. May appear in logs and the dashboard. May not order, filter
//               or size anything.
//   TIE_BREAK — may order candidates that are otherwise equal. Ordering never removes a
//               candidate and never moves a threshold, so an unconfirmed signal costs
//               nothing if it turns out to be noise.
//   GATE      — may harden an admission threshold or scale position size.
//
// The default for every feature is NONE. Authority is granted by measurement, not by how
// plausible the variable sounds: EV, hotness score and pattern confidence are all things this
// engine computes carefully and none of them had earned GATE authority in the live review.
//
// Two rules are structural rather than statistical, and no amount of evidence relaxes them:
//
//   1. A POST_ENTRY variable can never hold authority above NONE. MFE and MAE were the only
//      significant variables in the review precisely because they are recorded after the
//      fill. Acting on them at entry time is not a strong signal, it is lookahead.
//   2. Authority is per venue cohort. Evidence earned on Binance grants nothing on Upbit.

import type {
  EvidenceCohortReport,
  FeatureEvidence,
  FeatureFamily,
} from "./feature-significance.ts";

export type FeatureAuthority = "NONE" | "TIE_BREAK" | "GATE";

export type AdmissionReason =
  | "MEASURED_SIGNIFICANT"
  | "UNCORRECTED_SIGNAL_ONLY"
  | "POST_ENTRY_PATH_VARIABLE"
  | "NOT_MEASURED"
  | "INSUFFICIENT_SAMPLES"
  | "UNSTABLE_UNDER_LEAVE_ONE_OUT"
  | "OUTCOME_CLASSES_UNBALANCED"
  | "FDR_NOT_SIGNIFICANT"
  | "DEGENERATE_FEATURE";

export interface FeatureAdmission {
  key: string;
  family: FeatureFamily;
  authority: FeatureAuthority;
  reason: AdmissionReason;
  rho: number | null;
  q: number | null;
  samples: number;
}

/**
 * The minimum a caller needs to ask "may this feature act".
 *
 * Read helpers take this rather than the full policy so that a config object carrying only
 * the authority map — the shape the runtime actually passes around — can be consulted
 * without dragging the whole report through every type signature.
 */
export interface FeatureAdmissionView {
  cohort?: string;
  admissions: Array<{ key: string; authority: FeatureAuthority; rho?: number | null }>;
}

export interface FeatureAdmissionPolicy extends FeatureAdmissionView {
  schemaVersion: 1;
  cohort: string;
  generatedAtMs: number;
  samples: number;
  wins: number;
  losses: number;
  admissions: FeatureAdmission[];
  /** Keys at GATE authority. Empty is the expected state until evidence accumulates. */
  gateFeatures: string[];
  /** Keys at TIE_BREAK authority — watched, ordered on, never gated on. */
  tieBreakFeatures: string[];
  notes: string[];
}

export interface AdmissionConfig {
  /** Minimum usable trades in the cohort before any feature may reach GATE. */
  minCohortSamples: number;
  /**
   * Minimum count of each outcome class. Twenty trades with three winners cannot support a
   * threshold change in either direction: the minority class carries the entire estimate.
   */
  minOutcomeClassCount: number;
  /** A GATE feature must clear this |rho| as well as its q-value. */
  minAbsoluteRho: number;
}

export const DEFAULT_ADMISSION_CONFIG: AdmissionConfig = {
  minCohortSamples: 30,
  minOutcomeClassCount: 8,
  minAbsoluteRho: 0.30,
};

const AUTHORITY_RANK: Record<FeatureAuthority, number> = { NONE: 0, TIE_BREAK: 1, GATE: 2 };

function admit(
  evidence: FeatureEvidence,
  cohortSamples: number,
  wins: number,
  losses: number,
  config: AdmissionConfig,
): FeatureAdmission {
  const base = {
    key: evidence.key,
    family: evidence.family,
    rho: evidence.rho,
    q: evidence.q,
    samples: evidence.samples,
  };
  if (evidence.causality === "POST_ENTRY") {
    return { ...base, authority: "NONE", reason: "POST_ENTRY_PATH_VARIABLE" };
  }
  if (evidence.verdict === "DEGENERATE") {
    return { ...base, authority: "NONE", reason: "DEGENERATE_FEATURE" };
  }
  if (evidence.rho == null || evidence.rawP == null) {
    return { ...base, authority: "NONE", reason: "NOT_MEASURED" };
  }
  if (evidence.verdict === "CANDIDATE") {
    return { ...base, authority: "TIE_BREAK", reason: "UNCORRECTED_SIGNAL_ONLY" };
  }
  if (evidence.verdict !== "SIGNIFICANT") {
    return {
      ...base,
      authority: "NONE",
      reason: evidence.samples < config.minCohortSamples
        ? "INSUFFICIENT_SAMPLES"
        : "FDR_NOT_SIGNIFICANT",
    };
  }
  if (!evidence.signStable) {
    return { ...base, authority: "TIE_BREAK", reason: "UNSTABLE_UNDER_LEAVE_ONE_OUT" };
  }
  if (cohortSamples < config.minCohortSamples) {
    return { ...base, authority: "TIE_BREAK", reason: "INSUFFICIENT_SAMPLES" };
  }
  if (Math.min(wins, losses) < config.minOutcomeClassCount) {
    return { ...base, authority: "TIE_BREAK", reason: "OUTCOME_CLASSES_UNBALANCED" };
  }
  if (Math.abs(evidence.rho) < config.minAbsoluteRho) {
    return { ...base, authority: "TIE_BREAK", reason: "UNCORRECTED_SIGNAL_ONLY" };
  }
  return { ...base, authority: "GATE", reason: "MEASURED_SIGNIFICANT" };
}

/**
 * Build the admission policy for one cohort.
 *
 * Only the realized-return target grants authority. A feature that predicts MFE or MAE is
 * genuinely interesting — it is the pre-entry handle on the path variables that the live
 * review said was missing — but excursion is not profit, and a feature has to be shown
 * against the money before it may gate.
 */
export function buildFeatureAdmissionPolicy(
  report: EvidenceCohortReport,
  overrides: Partial<AdmissionConfig> = {},
): FeatureAdmissionPolicy {
  const config = { ...DEFAULT_ADMISSION_CONFIG, ...overrides };
  const losses = report.samples - report.wins;
  const admissions = report.features
    .filter((evidence) => evidence.target === "netBps")
    .map((evidence) => admit(evidence, report.samples, report.wins, losses, config))
    .sort((left, right) =>
      AUTHORITY_RANK[right.authority] - AUTHORITY_RANK[left.authority] ||
      (right.q == null ? -1 : left.q == null ? 1 : left.q - right.q) ||
      left.key.localeCompare(right.key)
    );
  const notes = [...report.notes];
  const pathSignificant = report.features.filter((evidence) =>
    evidence.causality === "POST_ENTRY" && evidence.target === "netBps" &&
    evidence.verdict === "SIGNIFICANT"
  );
  if (pathSignificant.length) {
    notes.push(
      `PATH_VARIABLES_SIGNIFICANT_BUT_UNUSABLE: ${
        pathSignificant.map((row) => row.key).join(", ")
      } describe a trade after entry and hold no admission authority`,
    );
  }
  const excursionPredictors = report.features.filter((evidence) =>
    evidence.causality === "PRE_ENTRY" &&
    (evidence.target === "mfeBps" || evidence.target === "maeBps") &&
    evidence.verdict === "SIGNIFICANT"
  );
  if (excursionPredictors.length) {
    notes.push(
      `PRE_ENTRY_EXCURSION_PREDICTORS: ${
        [...new Set(excursionPredictors.map((row) => `${row.key}->${row.target}`))].join(", ")
      } predict excursion; still unproven against realized return`,
    );
  }
  return {
    schemaVersion: 1,
    cohort: report.cohort,
    generatedAtMs: report.generatedAtMs,
    samples: report.samples,
    wins: report.wins,
    losses,
    admissions,
    gateFeatures: admissions.filter((row) => row.authority === "GATE").map((row) => row.key),
    tieBreakFeatures: admissions
      .filter((row) => row.authority === "TIE_BREAK")
      .map((row) => row.key),
    notes,
  };
}

/** Authority for one feature. Anything unmeasured or absent is NONE, never a guess. */
export function featureAuthority(
  policy: FeatureAdmissionView | null | undefined,
  key: string,
): FeatureAuthority {
  if (!policy) return "NONE";
  return policy.admissions.find((row) => row.key === key)?.authority ?? "NONE";
}

/** True only when live measurement has earned this feature the right to move a threshold. */
export function mayHardenGate(
  policy: FeatureAdmissionView | null | undefined,
  key: string,
): boolean {
  return featureAuthority(policy, key) === "GATE";
}

/** True when the feature may order otherwise-equal candidates. GATE implies TIE_BREAK. */
export function mayBreakTies(
  policy: FeatureAdmissionView | null | undefined,
  key: string,
): boolean {
  return AUTHORITY_RANK[featureAuthority(policy, key)] >= AUTHORITY_RANK.TIE_BREAK;
}

/**
 * Resolve the policy for the venue a candidate would trade on.
 *
 * A missing cohort returns null rather than falling back to another venue's policy, so an
 * exchange with no evidence of its own inherits no authority from one that has some.
 */
export function policyForCohort(
  policies: FeatureAdmissionPolicy[] | null | undefined,
  exchange: string,
): FeatureAdmissionPolicy | null {
  if (!policies?.length) return null;
  const wanted = String(exchange || "").toLowerCase();
  return policies.find((policy) => policy.cohort.toLowerCase() === wanted) ?? null;
}

/**
 * Bounded evidence-weighted multiplier for a feature-driven threshold.
 *
 * A GATE feature does not get to move a limit by an arbitrary amount just because it cleared
 * significance. The adjustment scales with |rho| and is clamped, so the first feature to
 * ever earn authority still lands inside a range an operator reviewed in advance.
 */
export function evidenceScaledAdjustment(
  policy: FeatureAdmissionView | null | undefined,
  key: string,
  maxAdjustment: number,
): number {
  if (!mayHardenGate(policy, key)) return 0;
  const rho = policy?.admissions.find((row) => row.key === key)?.rho ?? 0;
  const strength = Math.min(1, Math.abs(rho ?? 0));
  const bound = Math.abs(maxAdjustment);
  return Math.max(-bound, Math.min(bound, maxAdjustment * strength));
}
