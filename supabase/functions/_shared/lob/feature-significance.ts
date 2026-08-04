// Trading-booooo v7.4.0-STATISTICAL-FEATURE-EVIDENCE
//
// In-repo replacement for one-off external significance analysis.
//
// A 24-hour live review found that none of the eight variables recorded at entry time —
// p_target, EV lower bound, hotness score, pattern confidence, net reward:risk, expected
// cost, target width, stop width — had a defensible relationship with realized return once
// the family was corrected for multiple testing. Only MFE and MAE were significant, and both
// are recorded *after* the position is open, so neither can select a trade.
//
// The problem that review exposed is not which knob to turn. It is that the codebase had no
// way to ask the question at all, so every threshold change rested on an eyeballed table.
// This module makes the test itself a first-class, reproducible part of the system:
//
//   - Spearman rank correlation, because the samples are small and the return tail is fat.
//     No normality is assumed anywhere.
//   - A deterministic permutation p-value, so the reported significance does not depend on
//     an asymptotic approximation that a 20-row sample cannot support.
//   - Benjamini-Hochberg FDR *within each declared family*, because testing fifty features
//     and reporting the best raw p-value manufactures signal out of noise.
//   - Leave-one-out sensitivity, because one lucky trade can carry a whole correlation.
//   - A structural pre-entry / post-entry split. A post-entry path variable is barred from
//     ever becoming entry evidence regardless of how significant it is.
//
// Cohorts are never pooled. Binance and Upbit differ in fee schedule, tick geometry and
// quote unit; a pooled correlation across them measures the venue mix, not the feature.

/** A variable known before the order is sent, versus one only knowable afterwards. */
export type FeatureCausality = "PRE_ENTRY" | "POST_ENTRY";

/**
 * Multiple-testing families. FDR correction applies inside a family, never across families:
 * the eight deliberate entry knobs are one hypothesis set, the wide microstructure sweep is
 * another, and mixing them would let the sweep's width dilute the knobs' q-values.
 */
export type FeatureFamily = "ENTRY_INTENT" | "ENTRY_MICROSTRUCTURE" | "TRADE_PATH";

export type EvidenceVerdict =
  | "SIGNIFICANT"
  | "CANDIDATE"
  | "NOT_SIGNIFICANT"
  | "INSUFFICIENT_SAMPLES"
  | "DEGENERATE";

export type EvidenceTarget = "netBps" | "mfeBps" | "maeBps";

export interface TradeEvidenceSample {
  exchange: string;
  market: string;
  pattern: string;
  closedAtMs: number;
  openedAtMs: number | null;
  netBps: number;
  profitable: boolean;
  targetHit: boolean;
  heldSeconds: number;
  mfeBps: number;
  maeBps: number;
  snapshot: Record<string, unknown>;
}

export interface FeatureEvidence {
  key: string;
  family: FeatureFamily;
  causality: FeatureCausality;
  target: EvidenceTarget;
  /** Pairs where both the feature and the target were finite. */
  samples: number;
  rho: number | null;
  rawP: number | null;
  /** Benjamini-Hochberg adjusted p-value within (target, family). */
  q: number | null;
  permutationIterations: number;
  permutationExact: boolean;
  looMinRho: number | null;
  looMaxRho: number | null;
  /** True when every leave-one-out refit keeps the sign of rho. */
  signStable: boolean;
  verdict: EvidenceVerdict;
}

export interface GroupEvidence {
  key: string;
  leftLabel: string;
  rightLabel: string;
  leftSamples: number;
  rightSamples: number;
  leftMean: number;
  rightMean: number;
  leftMedian: number;
  rightMedian: number;
  u: number | null;
  rawP: number | null;
  permutationIterations: number;
  verdict: EvidenceVerdict;
}

export interface EvidenceCohortReport {
  cohort: string;
  generatedAtMs: number;
  samples: number;
  wins: number;
  winRate: number;
  observationHours: number;
  distinctMarkets: number;
  alpha: number;
  minSamples: number;
  features: FeatureEvidence[];
  groups: GroupEvidence[];
  notes: string[];
}

export interface EvidenceConfig {
  /** FDR level. A feature is significant only at q < alpha. */
  alpha: number;
  /** Below this pair count a feature is reported but never called significant. */
  minSamples: number;
  permutationIterations: number;
  /** Cap on the data-driven microstructure family so one wide sweep cannot dominate. */
  maxMicrostructureFeatures: number;
  /** A microstructure key must be present on at least this share of rows to be tested. */
  minFeatureCoverage: number;
  nowMs: number;
}

export const DEFAULT_EVIDENCE_CONFIG: EvidenceConfig = {
  alpha: 0.05,
  minSamples: 30,
  permutationIterations: 10_000,
  maxMicrostructureFeatures: 60,
  minFeatureCoverage: 0.8,
  nowMs: 0,
};

function finite(value: unknown, fallback = Number.NaN): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pick(source: Record<string, unknown> | null | undefined, ...keys: string[]): number {
  if (!source) return Number.NaN;
  for (const key of keys) {
    const value = finite(source[key]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function nested(
  snapshot: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = snapshot[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

// ---------------------------------------------------------------------------
// Rank statistics
// ---------------------------------------------------------------------------

/**
 * Midrank transform. Ties share the average of the positions they occupy, which is what
 * keeps Spearman and Mann-Whitney valid on discrete features such as gainer rank or a
 * bounded confidence score that repeats exact values.
 */
export function averageRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end++;
    const shared = (start + end) / 2 + 1;
    for (let index = start; index <= end; index++) ranks[order[index].index] = shared;
    start = end + 1;
  }
  return ranks;
}

function pearson(left: number[], right: number[]): number {
  const n = left.length;
  if (n < 3 || right.length !== n) return Number.NaN;
  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < n; index++) {
    sumLeft += left[index];
    sumRight += right[index];
  }
  const meanLeft = sumLeft / n;
  const meanRight = sumRight / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < n; index++) {
    const deltaLeft = left[index] - meanLeft;
    const deltaRight = right[index] - meanRight;
    covariance += deltaLeft * deltaRight;
    varianceLeft += deltaLeft * deltaLeft;
    varianceRight += deltaRight * deltaRight;
  }
  if (varianceLeft <= 0 || varianceRight <= 0) return Number.NaN;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/** Spearman rho. NaN when either side is constant, which is a degenerate test, not a zero. */
export function spearmanRho(left: number[], right: number[]): number {
  if (left.length !== right.length) return Number.NaN;
  return pearson(averageRanks(left), averageRanks(right));
}

/**
 * Deterministic PRNG. The seed is derived from the data itself, so re-running calibration
 * over an unchanged window reproduces the same p-value. A wall-clock or random seed would
 * make every hourly run disagree slightly with the last and invite threshold shopping.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedFrom(values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const scaled = Math.round(value * 1e6);
    hash ^= scaled & 0xffffffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function permuteInPlace(values: number[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const held = values[index];
    values[index] = values[swap];
    values[swap] = held;
  }
}

function enumeratePermutations(size: number, visit: (order: number[]) => void): void {
  const order = Array.from({ length: size }, (_, index) => index);
  const counters = new Array<number>(size).fill(0);
  visit(order);
  let index = 0;
  while (index < size) {
    if (counters[index] < index) {
      const swap = index % 2 === 0 ? 0 : counters[index];
      const held = order[swap];
      order[swap] = order[index];
      order[index] = held;
      visit(order);
      counters[index]++;
      index = 0;
    } else {
      counters[index] = 0;
      index++;
    }
  }
}

export interface PermutationResult {
  rho: number;
  p: number;
  iterations: number;
  exact: boolean;
}

/**
 * Two-sided permutation test for Spearman rho.
 *
 * Ranks are computed once and only the label assignment is shuffled, so a permutation costs
 * O(n). Small samples are enumerated exactly; larger ones use a fixed deterministic Monte
 * Carlo budget. The (1 + hits) / (1 + iterations) form never reports p = 0, which would
 * otherwise claim more certainty than a finite resample can support.
 */
export function spearmanPermutationTest(
  left: number[],
  right: number[],
  iterations = DEFAULT_EVIDENCE_CONFIG.permutationIterations,
): PermutationResult {
  const n = left.length;
  if (n < 3 || right.length !== n) {
    return { rho: Number.NaN, p: Number.NaN, iterations: 0, exact: false };
  }
  const rankLeft = averageRanks(left);
  const rankRight = averageRanks(right);
  const observed = pearson(rankLeft, rankRight);
  if (!Number.isFinite(observed)) {
    return { rho: Number.NaN, p: Number.NaN, iterations: 0, exact: false };
  }
  const magnitude = Math.abs(observed) - 1e-12;

  if (n <= 8) {
    let total = 0;
    let atLeastAsExtreme = 0;
    const shuffled = new Array<number>(n);
    enumeratePermutations(n, (order) => {
      for (let index = 0; index < n; index++) shuffled[index] = rankRight[order[index]];
      const candidate = pearson(rankLeft, shuffled);
      total++;
      if (Number.isFinite(candidate) && Math.abs(candidate) >= magnitude) atLeastAsExtreme++;
    });
    return { rho: observed, p: total ? atLeastAsExtreme / total : 1, iterations: total, exact: true };
  }

  const budget = Math.max(1000, Math.floor(iterations));
  const random = mulberry32(seedFrom([...rankLeft, ...rankRight, n]));
  const shuffled = rankRight.slice();
  let atLeastAsExtreme = 0;
  for (let round = 0; round < budget; round++) {
    permuteInPlace(shuffled, random);
    const candidate = pearson(rankLeft, shuffled);
    if (Number.isFinite(candidate) && Math.abs(candidate) >= magnitude) atLeastAsExtreme++;
  }
  return {
    rho: observed,
    p: (1 + atLeastAsExtreme) / (1 + budget),
    iterations: budget,
    exact: false,
  };
}

export interface LeaveOneOutRange {
  min: number | null;
  max: number | null;
  signStable: boolean;
}

/**
 * Refit rho with each observation removed in turn.
 *
 * A correlation whose sign flips when one of twenty trades is dropped is an artifact of that
 * trade, not a property of the feature, and must not be allowed to move a live threshold.
 */
export function leaveOneOutRhoRange(left: number[], right: number[]): LeaveOneOutRange {
  const n = left.length;
  if (n < 5 || right.length !== n) return { min: null, max: null, signStable: false };
  const observed = spearmanRho(left, right);
  if (!Number.isFinite(observed)) return { min: null, max: null, signStable: false };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let stable = true;
  for (let skip = 0; skip < n; skip++) {
    const subsetLeft: number[] = [];
    const subsetRight: number[] = [];
    for (let index = 0; index < n; index++) {
      if (index === skip) continue;
      subsetLeft.push(left[index]);
      subsetRight.push(right[index]);
    }
    const value = spearmanRho(subsetLeft, subsetRight);
    if (!Number.isFinite(value)) {
      stable = false;
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (Math.sign(value) !== Math.sign(observed)) stable = false;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: null, max: null, signStable: false };
  }
  return { min, max, signStable: stable };
}

/**
 * Benjamini-Hochberg step-up FDR. Returns adjusted p-values aligned with the input order.
 *
 * Non-finite entries are passed through as null: a degenerate test has no p-value to adjust
 * and must not consume a rank position, which would otherwise make the surviving tests look
 * more significant than the family size justifies.
 */
export function benjaminiHochberg(pValues: Array<number | null>): Array<number | null> {
  const testable = pValues
    .map((value, index) => ({ value: value == null ? Number.NaN : value, index }))
    .filter((row) => Number.isFinite(row.value));
  const total = testable.length;
  const adjusted = new Array<number | null>(pValues.length).fill(null);
  if (!total) return adjusted;
  testable.sort((left, right) => left.value - right.value);
  let running = 1;
  for (let position = total - 1; position >= 0; position--) {
    const raw = testable[position].value * total / (position + 1);
    running = Math.min(running, raw);
    adjusted[testable[position].index] = Math.min(1, Math.max(0, running));
  }
  return adjusted;
}

export interface MannWhitneyResult {
  u: number;
  leftRankSum: number;
  p: number;
  iterations: number;
}

/**
 * Mann-Whitney U with a permutation p-value.
 *
 * The normal approximation is unreliable at the group sizes this system produces — a
 * seven-trade re-entry cohort against a thirteen-trade first-entry cohort — so labels are
 * resampled instead.
 */
export function mannWhitneyU(
  left: number[],
  right: number[],
  iterations = DEFAULT_EVIDENCE_CONFIG.permutationIterations,
): MannWhitneyResult {
  const leftCount = left.length;
  const rightCount = right.length;
  if (leftCount < 2 || rightCount < 2) {
    return { u: Number.NaN, leftRankSum: Number.NaN, p: Number.NaN, iterations: 0 };
  }
  const pooled = [...left, ...right];
  const ranks = averageRanks(pooled);
  const statistic = (assignment: number[]): number => {
    let sum = 0;
    for (let index = 0; index < leftCount; index++) sum += assignment[index];
    return sum - leftCount * (leftCount + 1) / 2;
  };
  const observedRankSum = ranks.slice(0, leftCount).reduce((sum, value) => sum + value, 0);
  const observedU = statistic(ranks);
  const centre = leftCount * rightCount / 2;
  const magnitude = Math.abs(observedU - centre) - 1e-12;

  const budget = Math.max(1000, Math.floor(iterations));
  const random = mulberry32(seedFrom([...ranks, leftCount, rightCount]));
  const shuffled = ranks.slice();
  let atLeastAsExtreme = 0;
  for (let round = 0; round < budget; round++) {
    permuteInPlace(shuffled, random);
    if (Math.abs(statistic(shuffled) - centre) >= magnitude) atLeastAsExtreme++;
  }
  return {
    u: observedU,
    leftRankSum: observedRankSum,
    p: (1 + atLeastAsExtreme) / (1 + budget),
    iterations: budget,
  };
}

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

export interface EvidenceFeatureSpec {
  key: string;
  family: FeatureFamily;
  causality: FeatureCausality;
  read: (sample: TradeEvidenceSample) => number;
}

/**
 * The eight variables the entry decision is actually written in terms of.
 *
 * They are listed explicitly rather than swept out of the snapshot because this family is a
 * standing hypothesis set: it must keep the same membership from run to run for the q-values
 * to be comparable over time.
 */
export const ENTRY_INTENT_FEATURES: EvidenceFeatureSpec[] = [
  {
    key: "p_target",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => pick(sample.snapshot, "p_target", "pWin", "neutral_win_rate"),
  },
  {
    key: "ev_lower_bound_bps",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) =>
      pick(
        sample.snapshot,
        "conditional_ev_lower_bound_bps",
        "ev_lower_bound_bps",
        "conditional_ev_net_bps",
        "ev_net_bps",
      ),
  },
  {
    key: "hotness_score",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => {
      const direct = pick(sample.snapshot, "hotness_score", "score");
      if (Number.isFinite(direct)) return direct;
      return pick(nested(sample.snapshot, "hotness"), "hotnessScore");
    },
  },
  {
    key: "confidence",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => pick(sample.snapshot, "confidence", "pattern_confidence"),
  },
  {
    key: "net_reward_risk_ratio",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => {
      const direct = pick(sample.snapshot, "net_reward_risk_ratio", "net_rr");
      if (Number.isFinite(direct)) return direct;
      const target = pick(sample.snapshot, "target_return_net_bps", "target_bps");
      const stop = pick(sample.snapshot, "noise_adjusted_stop_bps", "stop_bps");
      return Number.isFinite(target) && Number.isFinite(stop) && stop > 0 ? target / stop : NaN;
    },
  },
  {
    key: "expected_cost_bps",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) =>
      pick(sample.snapshot, "expected_cost_bps", "round_trip_cost_bps", "total_cost_bps"),
  },
  {
    key: "target_bps",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => pick(sample.snapshot, "target_bps"),
  },
  {
    key: "stop_bps",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    read: (sample) => pick(sample.snapshot, "noise_adjusted_stop_bps", "stop_bps"),
  },
];

/**
 * Path variables. They are measured because they describe how a trade behaved, and they are
 * declared POST_ENTRY because nothing that is only knowable after the fill can choose one.
 *
 * MFE and MAE correlate strongly with realized return by construction — a trade that went
 * far in your favour tends to close in profit. Reporting that as an entry finding is the
 * exact error this classification exists to make structurally impossible.
 */
export const TRADE_PATH_FEATURES: EvidenceFeatureSpec[] = [
  {
    key: "mfe_bps",
    family: "TRADE_PATH",
    causality: "POST_ENTRY",
    read: (sample) => sample.mfeBps,
  },
  {
    key: "mae_bps",
    family: "TRADE_PATH",
    causality: "POST_ENTRY",
    read: (sample) => sample.maeBps,
  },
  {
    key: "held_seconds",
    family: "TRADE_PATH",
    causality: "POST_ENTRY",
    read: (sample) => sample.heldSeconds,
  },
];

const MICROSTRUCTURE_EXCLUDED = new Set([
  "samples",
  "observationMs",
  "bookAgeMs",
  "m1CompletedBars",
]);

/**
 * Data-driven pre-entry microstructure family.
 *
 * The recorded book/tape/candle vector is the only place a pre-entry predictor of MFE or MAE
 * can come from, and it grows as the engine gains features, so the family is discovered from
 * the data rather than hand-listed. Coverage and size caps keep the correction honest:
 * a key present on a handful of rows would otherwise be tested on a different sample than
 * the rest of its family.
 */
export function discoverMicrostructureFeatures(
  samples: TradeEvidenceSample[],
  config: EvidenceConfig = DEFAULT_EVIDENCE_CONFIG,
): EvidenceFeatureSpec[] {
  const coverage = new Map<string, number>();
  for (const sample of samples) {
    const features = nested(sample.snapshot, "features") ??
      nested(nested(sample.snapshot, "scanned_lob") ?? {}, "features");
    if (!features) continue;
    for (const [key, value] of Object.entries(features)) {
      if (MICROSTRUCTURE_EXCLUDED.has(key)) continue;
      const numeric = typeof value === "boolean" ? Number(value) : finite(value);
      if (!Number.isFinite(numeric)) continue;
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
  }
  const required = Math.ceil(Math.max(0, Math.min(1, config.minFeatureCoverage)) * samples.length);
  return [...coverage.entries()]
    .filter(([, count]) => count >= Math.max(3, required))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(0, config.maxMicrostructureFeatures))
    .map(([key]) => ({
      key: `features.${key}`,
      family: "ENTRY_MICROSTRUCTURE" as const,
      causality: "PRE_ENTRY" as const,
      read: (sample: TradeEvidenceSample) => {
        const features = nested(sample.snapshot, "features") ??
          nested(nested(sample.snapshot, "scanned_lob") ?? {}, "features");
        const value = features?.[key];
        return typeof value === "boolean" ? Number(value) : finite(value);
      },
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

// ---------------------------------------------------------------------------
// Report construction
// ---------------------------------------------------------------------------

function targetValue(sample: TradeEvidenceSample, target: EvidenceTarget): number {
  if (target === "mfeBps") return sample.mfeBps;
  if (target === "maeBps") return sample.maeBps;
  return sample.netBps;
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function testFeature(
  spec: EvidenceFeatureSpec,
  samples: TradeEvidenceSample[],
  target: EvidenceTarget,
  config: EvidenceConfig,
): FeatureEvidence {
  const featureValues: number[] = [];
  const targetValues: number[] = [];
  for (const sample of samples) {
    const feature = spec.read(sample);
    const outcome = targetValue(sample, target);
    if (!Number.isFinite(feature) || !Number.isFinite(outcome)) continue;
    featureValues.push(feature);
    targetValues.push(outcome);
  }
  const pairs = featureValues.length;
  const base: FeatureEvidence = {
    key: spec.key,
    family: spec.family,
    causality: spec.causality,
    target,
    samples: pairs,
    rho: null,
    rawP: null,
    q: null,
    permutationIterations: 0,
    permutationExact: false,
    looMinRho: null,
    looMaxRho: null,
    signStable: false,
    verdict: "INSUFFICIENT_SAMPLES",
  };
  if (pairs < 3) return base;
  const test = spearmanPermutationTest(featureValues, targetValues, config.permutationIterations);
  if (!Number.isFinite(test.rho)) return { ...base, verdict: "DEGENERATE" };
  const loo = leaveOneOutRhoRange(featureValues, targetValues);
  return {
    ...base,
    rho: test.rho,
    rawP: test.p,
    permutationIterations: test.iterations,
    permutationExact: test.exact,
    looMinRho: loo.min,
    looMaxRho: loo.max,
    signStable: loo.signStable,
    verdict: "NOT_SIGNIFICANT",
  };
}

/**
 * Assign a verdict once q-values exist.
 *
 * SIGNIFICANT requires the corrected q, a sample floor and leave-one-out sign stability
 * together. CANDIDATE is the honest label for the p_target case in the live review: the raw
 * test passes and the correlation survives dropping any single trade, but the family
 * correction does not clear, so it is worth watching and not worth trading on.
 */
function verdictFor(evidence: FeatureEvidence, config: EvidenceConfig): EvidenceVerdict {
  if (evidence.verdict === "DEGENERATE") return "DEGENERATE";
  if (evidence.rho == null || evidence.rawP == null) return "INSUFFICIENT_SAMPLES";
  if (evidence.samples < config.minSamples) {
    return evidence.rawP < config.alpha && evidence.signStable
      ? "CANDIDATE"
      : "INSUFFICIENT_SAMPLES";
  }
  if (evidence.q != null && evidence.q < config.alpha && evidence.signStable) return "SIGNIFICANT";
  if (evidence.rawP < config.alpha) return "CANDIDATE";
  return "NOT_SIGNIFICANT";
}

function applyFdrWithinFamilies(
  evidence: FeatureEvidence[],
  config: EvidenceConfig,
): FeatureEvidence[] {
  const groups = new Map<string, FeatureEvidence[]>();
  for (const row of evidence) {
    const key = `${row.target}|${row.family}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    const adjusted = benjaminiHochberg(bucket.map((row) => row.rawP));
    bucket.forEach((row, index) => {
      row.q = adjusted[index];
    });
  }
  for (const row of evidence) row.verdict = verdictFor(row, config);
  return evidence;
}

/**
 * Re-entry contrast: trades opened on a market this cohort had already traded and closed,
 * versus that market's first entry in the window.
 *
 * The live review observed a worse mean on re-entries and could not separate it from noise
 * at seven observations. The test is kept in the report so the claim is either eventually
 * earned or eventually dropped, rather than quietly becoming folklore.
 */
export function analyzeReentryEffect(
  samples: TradeEvidenceSample[],
  config: EvidenceConfig = DEFAULT_EVIDENCE_CONFIG,
): GroupEvidence {
  const ordered = samples
    .filter((sample) => Number.isFinite(sample.netBps))
    .slice()
    .sort((left, right) => left.closedAtMs - right.closedAtMs);
  const seen = new Set<string>();
  const first: number[] = [];
  const repeat: number[] = [];
  for (const sample of ordered) {
    const key = `${sample.exchange.toLowerCase()}:${sample.market.toUpperCase()}`;
    (seen.has(key) ? repeat : first).push(sample.netBps);
    seen.add(key);
  }
  const base: GroupEvidence = {
    key: "reentry_vs_first_entry",
    leftLabel: "FIRST_ENTRY",
    rightLabel: "REENTRY",
    leftSamples: first.length,
    rightSamples: repeat.length,
    leftMean: mean(first),
    rightMean: mean(repeat),
    leftMedian: median(first),
    rightMedian: median(repeat),
    u: null,
    rawP: null,
    permutationIterations: 0,
    verdict: "INSUFFICIENT_SAMPLES",
  };
  if (first.length < 2 || repeat.length < 2) return base;
  const test = mannWhitneyU(first, repeat, config.permutationIterations);
  if (!Number.isFinite(test.p)) return base;
  const enough = first.length + repeat.length >= config.minSamples;
  return {
    ...base,
    u: test.u,
    rawP: test.p,
    permutationIterations: test.iterations,
    verdict: test.p < config.alpha
      ? (enough ? "SIGNIFICANT" : "CANDIDATE")
      : enough
      ? "NOT_SIGNIFICANT"
      : "INSUFFICIENT_SAMPLES",
  };
}

/**
 * Full evidence report for one venue cohort.
 *
 * Three question sets run against the same rows:
 *   1. do the entry knobs explain realized return,
 *   2. does any pre-entry microstructure feature explain realized return,
 *   3. does any pre-entry microstructure feature explain the excursion path (MFE and MAE),
 *      which is the only route by which the strong path correlations could ever become
 *      something the engine can act on before sending an order.
 *
 * Path variables are additionally regressed on return purely so the report states plainly
 * what they are: a description of the trade, not a selector for it.
 */
export function analyzeCohortEvidence(
  cohort: string,
  samples: TradeEvidenceSample[],
  overrides: Partial<EvidenceConfig> = {},
): EvidenceCohortReport {
  const config: EvidenceConfig = { ...DEFAULT_EVIDENCE_CONFIG, ...overrides };
  const usable = samples.filter((sample) => Number.isFinite(sample.netBps));
  const microstructure = discoverMicrostructureFeatures(usable, config);
  const evidence: FeatureEvidence[] = [];
  for (const spec of [...ENTRY_INTENT_FEATURES, ...microstructure, ...TRADE_PATH_FEATURES]) {
    evidence.push(testFeature(spec, usable, "netBps", config));
  }
  for (const spec of [...ENTRY_INTENT_FEATURES, ...microstructure]) {
    evidence.push(testFeature(spec, usable, "mfeBps", config));
    evidence.push(testFeature(spec, usable, "maeBps", config));
  }
  applyFdrWithinFamilies(evidence, config);

  const wins = usable.filter((sample) => sample.profitable).length;
  const closedTimes = usable.map((sample) => sample.closedAtMs).filter(Number.isFinite);
  const observationHours = closedTimes.length >= 2
    ? (Math.max(...closedTimes) - Math.min(...closedTimes)) / 3_600_000
    : 0;
  const notes: string[] = [];
  if (usable.length < config.minSamples) {
    notes.push(
      `SAMPLE_BELOW_SIGNIFICANCE_FLOOR: ${usable.length} of ${config.minSamples} required`,
    );
  }
  if (wins < 8 || usable.length - wins < 8) {
    notes.push(
      "OUTCOME_CLASSES_UNBALANCED: win/loss counts cannot support multivariate or logistic fits",
    );
  }
  const admissible = evidence.filter((row) =>
    row.causality === "PRE_ENTRY" && row.target === "netBps" && row.verdict === "SIGNIFICANT"
  );
  if (!admissible.length) {
    notes.push("NO_PRE_ENTRY_FEATURE_SEPARATES_OUTCOMES: entry thresholds stay operator-set");
  }

  return {
    cohort,
    generatedAtMs: config.nowMs || Date.now(),
    samples: usable.length,
    wins,
    winRate: usable.length ? wins / usable.length : 0,
    observationHours,
    distinctMarkets: new Set(usable.map((sample) => sample.market.toUpperCase())).size,
    alpha: config.alpha,
    minSamples: config.minSamples,
    features: evidence.sort((left, right) =>
      left.target.localeCompare(right.target) ||
      left.family.localeCompare(right.family) ||
      (right.rho == null ? -1 : left.rho == null ? 1 : Math.abs(right.rho) - Math.abs(left.rho)) ||
      left.key.localeCompare(right.key)
    ),
    groups: [analyzeReentryEffect(usable, config)],
    notes,
  };
}

/**
 * Split by venue and analyze each cohort separately.
 *
 * Pooling is not offered as an option. Different fee schedules, tick sizes and quote units
 * mean a pooled rank correlation partly measures which venue a trade landed on, and the
 * smaller venue's handful of rows cannot be rescued by borrowing the larger one's sample.
 */
export function analyzeTradeEvidence(
  samples: TradeEvidenceSample[],
  overrides: Partial<EvidenceConfig> = {},
): EvidenceCohortReport[] {
  const cohorts = new Map<string, TradeEvidenceSample[]>();
  for (const sample of samples) {
    const key = String(sample.exchange || "unknown").toLowerCase();
    const bucket = cohorts.get(key) ?? [];
    bucket.push(sample);
    cohorts.set(key, bucket);
  }
  return [...cohorts.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([cohort, rows]) => analyzeCohortEvidence(cohort, rows, overrides));
}

/** Parse a `lob_online_outcomes` row into an evidence sample. */
export function outcomeRowToEvidenceSample(
  row: Record<string, unknown>,
): TradeEvidenceSample | null {
  const netBps = finite(row.net_bps);
  if (!Number.isFinite(netBps)) return null;
  const snapshot = row.entry_snapshot && typeof row.entry_snapshot === "object"
    ? row.entry_snapshot as Record<string, unknown>
    : null;
  if (!snapshot) return null;
  const closedAtMs = Date.parse(String(row.closed_at ?? ""));
  if (!Number.isFinite(closedAtMs)) return null;
  const openedAtMs = Date.parse(String(row.opened_at ?? ""));
  return {
    exchange: String(row.exchange ?? "unknown").toLowerCase(),
    market: String(row.market ?? "").toUpperCase(),
    pattern: String(row.pattern ?? ""),
    closedAtMs,
    openedAtMs: Number.isFinite(openedAtMs) ? openedAtMs : null,
    netBps,
    profitable: row.profitable == null ? netBps > 0 : Boolean(row.profitable),
    targetHit: Boolean(row.target_hit),
    heldSeconds: Math.max(0, finite(row.held_seconds, 0)),
    mfeBps: Math.max(0, finite(row.mfe_bps, 0)),
    maeBps: Math.max(0, finite(row.mae_bps, 0)),
    snapshot,
  };
}
