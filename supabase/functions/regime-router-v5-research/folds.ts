import { BAR_MS, type FoldDefinition, type FoldSplit } from "./types.ts";

export const DAY_MS = 86_400_000;

export const V5_FOLD_POLICY = Object.freeze({
  lookbackDays: 120,
  foldCount: 4,
  foldOffsetDays: 15,
  trainDays: 45,
  embargoDays: 1,
  validationDays: 14,
  testDays: 14,
  minimumTrades: Object.freeze({ TRAIN: 40, VALIDATION: 15, TEST: 15 }),
  minimumProfitFactor: 1,
  minimumStressNetPnlBps: 0,
  minimumNeighborhoodCandidates: 2,
  minimumPassingNeighbors: 1,
  minimumNeighborhoodPassRate: 0.5,
});

export const FINAL_HISTORICAL_TEST_LABEL =
  "RESEARCH_ONLY_FINAL_HISTORICAL_TEST_NOT_USED_FOR_SELECTION";

export type EvaluationSplit = "TRAIN" | "VALIDATION" | "TEST";
export type SelectionSplit = Exclude<EvaluationSplit, "TEST">;

export interface CandidateFoldMetric {
  candidate: string;
  neighborGroup: string;
  fold: number;
  split: EvaluationSplit;
  trades: number;
  profitFactor: number | null;
  stressNetPnlBps: number;
}

export interface CandidateFoldGate {
  fold: number;
  trainPass: boolean;
  validationPass: boolean;
  selectionPass: boolean;
  testSampleSufficient: boolean;
  testPass: boolean;
  neighborhoodCandidateCount: number;
  passingNeighborCount: number;
  neighborhoodPassRate: number;
  neighborhoodRobust: boolean;
  selectionFailures: string[];
  historicalTestFailures: string[];
}

export interface CandidateValidationReport {
  candidate: string;
  neighborGroup: string;
  selectionEligible: boolean;
  selectionScore: number | null;
  foldGates: CandidateFoldGate[];
  historicalTestSufficient: boolean;
  historicalTestPass: boolean;
  productionReviewEligible: boolean;
  finalHistoricalTestFold: number;
  finalHistoricalTestLabel: typeof FINAL_HISTORICAL_TEST_LABEL;
  testUsedForSelection: false;
}

export interface ValidationGateOptions {
  foldCount: number;
  minimumTrainTrades: number;
  minimumValidationTrades: number;
  minimumTestTrades: number;
  minimumProfitFactor: number;
  minimumStressNetPnlBps: number;
  minimumNeighborhoodCandidates: number;
  minimumPassingNeighbors: number;
  minimumNeighborhoodPassRate: number;
}

export const DEFAULT_VALIDATION_GATE_OPTIONS: Readonly<ValidationGateOptions> = Object.freeze({
  foldCount: V5_FOLD_POLICY.foldCount,
  minimumTrainTrades: V5_FOLD_POLICY.minimumTrades.TRAIN,
  minimumValidationTrades: V5_FOLD_POLICY.minimumTrades.VALIDATION,
  minimumTestTrades: V5_FOLD_POLICY.minimumTrades.TEST,
  minimumProfitFactor: V5_FOLD_POLICY.minimumProfitFactor,
  minimumStressNetPnlBps: V5_FOLD_POLICY.minimumStressNetPnlBps,
  minimumNeighborhoodCandidates: V5_FOLD_POLICY.minimumNeighborhoodCandidates,
  minimumPassingNeighbors: V5_FOLD_POLICY.minimumPassingNeighbors,
  minimumNeighborhoodPassRate: V5_FOLD_POLICY.minimumNeighborhoodPassRate,
});

export interface CompletenessExpectation {
  markets: number;
  candidates: number;
  folds: number;
  splits: number;
  rows: number;
}

export interface CompletenessObservation {
  markets: number;
  candidates: number;
  folds: number;
  splits: number;
  rows: number;
}

function assertAlignedTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value % BAR_MS !== 0) {
    throw new Error(`${name} must be a non-negative 15-minute aligned timestamp`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

/**
 * Builds four overlapping folds inside one 120-day, end-exclusive research window.
 *
 * Every fold is 75 days long:
 * 45d TRAIN -> 1d embargo -> 14d VALIDATION -> 1d embargo -> 14d TEST.
 * Fold starts move forward by 15 days, so fold four ends exactly at day 120.
 */
export function buildRollingFolds(
  windowStart: number,
  windowEndExclusive: number,
): FoldDefinition[] {
  assertAlignedTime(windowStart, "windowStart");
  assertAlignedTime(windowEndExclusive, "windowEndExclusive");
  const expectedSpan = V5_FOLD_POLICY.lookbackDays * DAY_MS;
  if (windowEndExclusive - windowStart !== expectedSpan) {
    throw new Error(`V5 research window must be exactly ${V5_FOLD_POLICY.lookbackDays} days`);
  }

  const folds: FoldDefinition[] = [];
  for (let index = 0; index < V5_FOLD_POLICY.foldCount; index++) {
    const trainStart = windowStart + index * V5_FOLD_POLICY.foldOffsetDays * DAY_MS;
    const trainEnd = trainStart + V5_FOLD_POLICY.trainDays * DAY_MS;
    const validationStart = trainEnd + V5_FOLD_POLICY.embargoDays * DAY_MS;
    const validationEnd = validationStart + V5_FOLD_POLICY.validationDays * DAY_MS;
    const testStart = validationEnd + V5_FOLD_POLICY.embargoDays * DAY_MS;
    const testEnd = testStart + V5_FOLD_POLICY.testDays * DAY_MS;
    folds.push({
      id: index + 1,
      trainStart,
      trainEnd,
      validationStart,
      validationEnd,
      testStart,
      testEnd,
      embargoBars: V5_FOLD_POLICY.embargoDays * DAY_MS / BAR_MS,
    });
  }

  if (folds.at(-1)?.testEnd !== windowEndExclusive) {
    throw new Error("rolling-fold geometry does not cover the configured 120-day window");
  }
  return folds;
}

export function buildRollingFoldsEndingAt(windowEndExclusive: number): FoldDefinition[] {
  return buildRollingFolds(
    windowEndExclusive - V5_FOLD_POLICY.lookbackDays * DAY_MS,
    windowEndExclusive,
  );
}

/** All interval ends are exclusive. The two embargo windows intentionally return EMBARGO. */
export function splitForFold(time: number, fold: FoldDefinition): FoldSplit {
  if (!Number.isFinite(time)) return "OUTSIDE";
  if (time >= fold.trainStart && time < fold.trainEnd) return "TRAIN";
  if (time >= fold.trainEnd && time < fold.validationStart) return "EMBARGO";
  if (time >= fold.validationStart && time < fold.validationEnd) return "VALIDATION";
  if (time >= fold.validationEnd && time < fold.testStart) return "EMBARGO";
  if (time >= fold.testStart && time < fold.testEnd) return "TEST";
  return "OUTSIDE";
}

function passMetric(
  metric: CandidateFoldMetric | undefined,
  minimumTrades: number,
  options: Readonly<ValidationGateOptions>,
): boolean {
  return !!metric && metric.trades >= minimumTrades && metric.profitFactor !== null &&
    Number.isFinite(metric.profitFactor) &&
    metric.profitFactor > options.minimumProfitFactor &&
    Number.isFinite(metric.stressNetPnlBps) &&
    metric.stressNetPnlBps > options.minimumStressNetPnlBps;
}

function metricKey(candidate: string, fold: number, split: EvaluationSplit): string {
  return `${candidate}\u0000${fold}\u0000${split}`;
}

function validateMetric(metric: CandidateFoldMetric, foldCount: number): void {
  if (!metric.candidate.trim()) throw new Error("candidate must not be empty");
  if (!metric.neighborGroup.trim()) throw new Error("neighborGroup must not be empty");
  if (!Number.isSafeInteger(metric.fold) || metric.fold < 1 || metric.fold > foldCount) {
    throw new Error(`invalid fold for ${metric.candidate}: ${metric.fold}`);
  }
  if (!Number.isSafeInteger(metric.trades) || metric.trades < 0) {
    throw new Error(`invalid trade count for ${metric.candidate}`);
  }
  if (metric.profitFactor !== null && !Number.isFinite(metric.profitFactor)) {
    throw new Error(`invalid profit factor for ${metric.candidate}`);
  }
  if (!Number.isFinite(metric.stressNetPnlBps)) {
    throw new Error(`invalid stress PnL for ${metric.candidate}`);
  }
}

function minimumSelectionStressPerTrade(
  candidate: string,
  byKey: ReadonlyMap<string, CandidateFoldMetric>,
  foldCount: number,
): number | null {
  let minimum = Infinity;
  for (let fold = 1; fold <= foldCount; fold++) {
    for (const split of ["TRAIN", "VALIDATION"] as const) {
      const metric = byKey.get(metricKey(candidate, fold, split));
      if (!metric || metric.trades <= 0) return null;
      minimum = Math.min(minimum, metric.stressNetPnlBps / metric.trades);
    }
  }
  return Number.isFinite(minimum) ? minimum : null;
}

/**
 * Evaluates and ranks research candidates without reading TEST performance.
 * Folds 1-3 TEST are diagnostic because the 15-day fold offset makes them overlap
 * later validation windows. Fold 4 TEST is the only final OOS adoption gate, and
 * it is evaluated only as a post-selection production-review field.
 */
export function evaluateCandidateValidation(
  metrics: readonly CandidateFoldMetric[],
  overrides: Partial<ValidationGateOptions> = {},
): CandidateValidationReport[] {
  const options: Readonly<ValidationGateOptions> = {
    ...DEFAULT_VALIDATION_GATE_OPTIONS,
    ...overrides,
  };
  assertPositiveInteger(options.foldCount, "foldCount");
  assertPositiveInteger(options.minimumTrainTrades, "minimumTrainTrades");
  assertPositiveInteger(options.minimumValidationTrades, "minimumValidationTrades");
  assertPositiveInteger(options.minimumTestTrades, "minimumTestTrades");
  assertPositiveInteger(options.minimumNeighborhoodCandidates, "minimumNeighborhoodCandidates");
  if (
    !Number.isSafeInteger(options.minimumPassingNeighbors) || options.minimumPassingNeighbors < 0
  ) {
    throw new Error("minimumPassingNeighbors must be a non-negative safe integer");
  }
  if (!(options.minimumNeighborhoodPassRate > 0 && options.minimumNeighborhoodPassRate <= 1)) {
    throw new Error("minimumNeighborhoodPassRate must be in (0, 1]");
  }

  const byKey = new Map<string, CandidateFoldMetric>();
  const candidateGroups = new Map<string, string>();
  const groupCandidates = new Map<string, Set<string>>();
  for (const metric of metrics) {
    validateMetric(metric, options.foldCount);
    const previousGroup = candidateGroups.get(metric.candidate);
    if (previousGroup && previousGroup !== metric.neighborGroup) {
      throw new Error(`candidate ${metric.candidate} has inconsistent neighborGroup`);
    }
    candidateGroups.set(metric.candidate, metric.neighborGroup);
    const candidates = groupCandidates.get(metric.neighborGroup) ?? new Set<string>();
    candidates.add(metric.candidate);
    groupCandidates.set(metric.neighborGroup, candidates);
    const key = metricKey(metric.candidate, metric.fold, metric.split);
    if (byKey.has(key)) throw new Error(`duplicate candidate/fold/split metric: ${key}`);
    byKey.set(key, metric);
  }

  const basePass = new Map<string, boolean>();
  for (const candidate of candidateGroups.keys()) {
    for (let fold = 1; fold <= options.foldCount; fold++) {
      const train = byKey.get(metricKey(candidate, fold, "TRAIN"));
      const validation = byKey.get(metricKey(candidate, fold, "VALIDATION"));
      const pass = passMetric(train, options.minimumTrainTrades, options) &&
        passMetric(validation, options.minimumValidationTrades, options);
      basePass.set(`${candidate}\u0000${fold}`, pass);
    }
  }

  const reports: CandidateValidationReport[] = [];
  for (const [candidate, neighborGroup] of candidateGroups) {
    const neighbors = [...(groupCandidates.get(neighborGroup) ?? [])];
    const foldGates: CandidateFoldGate[] = [];
    for (let fold = 1; fold <= options.foldCount; fold++) {
      const train = byKey.get(metricKey(candidate, fold, "TRAIN"));
      const validation = byKey.get(metricKey(candidate, fold, "VALIDATION"));
      const test = byKey.get(metricKey(candidate, fold, "TEST"));
      const trainPass = passMetric(train, options.minimumTrainTrades, options);
      const validationPass = passMetric(
        validation,
        options.minimumValidationTrades,
        options,
      );
      const testSampleSufficient = !!test && test.trades >= options.minimumTestTrades;
      const testPass = passMetric(test, options.minimumTestTrades, options);
      const passingCandidates = neighbors.filter((name) =>
        basePass.get(`${name}\u0000${fold}`) === true
      );
      const passingNeighborCount = passingCandidates.filter((name) => name !== candidate).length;
      const neighborhoodPassRate = neighbors.length > 0
        ? passingCandidates.length / neighbors.length
        : 0;
      const neighborhoodRobust = neighbors.length >= options.minimumNeighborhoodCandidates &&
        passingNeighborCount >= options.minimumPassingNeighbors &&
        neighborhoodPassRate >= options.minimumNeighborhoodPassRate;
      const selectionFailures: string[] = [];
      if (!trainPass) selectionFailures.push("TRAIN_GATE_FAILED");
      if (!validationPass) selectionFailures.push("VALIDATION_GATE_FAILED");
      if (!neighborhoodRobust) selectionFailures.push("NEIGHBORHOOD_ROBUSTNESS_FAILED");
      const historicalTestFailures: string[] = [];
      if (!testSampleSufficient) historicalTestFailures.push("TEST_SAMPLE_BELOW_15");
      if (
        !test || test.profitFactor === null ||
        !Number.isFinite(test.profitFactor) ||
        test.profitFactor <= options.minimumProfitFactor
      ) {
        historicalTestFailures.push("TEST_PROFIT_FACTOR_NOT_ABOVE_1");
      }
      if (
        !test || !Number.isFinite(test.stressNetPnlBps) ||
        test.stressNetPnlBps <= options.minimumStressNetPnlBps
      ) {
        historicalTestFailures.push("TEST_STRESS_NOT_POSITIVE");
      }
      foldGates.push({
        fold,
        trainPass,
        validationPass,
        selectionPass: trainPass && validationPass && neighborhoodRobust,
        testSampleSufficient,
        testPass,
        neighborhoodCandidateCount: neighbors.length,
        passingNeighborCount,
        neighborhoodPassRate,
        neighborhoodRobust,
        selectionFailures,
        historicalTestFailures,
      });
    }

    const selectionEligible = foldGates.length === options.foldCount &&
      foldGates.every((fold) => fold.selectionPass);
    const finalHistoricalTest = foldGates.find((fold) => fold.fold === options.foldCount);
    const historicalTestPass = finalHistoricalTest?.testPass === true;
    reports.push({
      candidate,
      neighborGroup,
      selectionEligible,
      selectionScore: selectionEligible
        ? minimumSelectionStressPerTrade(candidate, byKey, options.foldCount)
        : null,
      foldGates,
      historicalTestSufficient: foldGates.every((fold) => fold.testSampleSufficient),
      historicalTestPass,
      productionReviewEligible: selectionEligible && historicalTestPass,
      finalHistoricalTestFold: options.foldCount,
      finalHistoricalTestLabel: FINAL_HISTORICAL_TEST_LABEL,
      testUsedForSelection: false,
    });
  }

  return reports.sort((left, right) => {
    if (left.selectionEligible !== right.selectionEligible) {
      return left.selectionEligible ? -1 : 1;
    }
    const leftScore = left.selectionScore ?? -Infinity;
    const rightScore = right.selectionScore ?? -Infinity;
    return rightScore - leftScore || left.candidate.localeCompare(right.candidate);
  });
}

export function selectedCandidates(
  metrics: readonly CandidateFoldMetric[],
  overrides: Partial<ValidationGateOptions> = {},
): CandidateValidationReport[] {
  return evaluateCandidateValidation(metrics, overrides).filter((report) =>
    report.selectionEligible
  );
}

export function expectedMetricCompleteness(
  markets: number,
  candidates: number,
  folds = V5_FOLD_POLICY.foldCount,
): CompletenessExpectation {
  assertPositiveInteger(markets, "markets");
  assertPositiveInteger(candidates, "candidates");
  assertPositiveInteger(folds, "folds");
  const splits = 3;
  const rows = markets * candidates * folds * splits;
  if (!Number.isSafeInteger(rows)) throw new Error("expected row count exceeds safe integer range");
  return { markets, candidates, folds, splits, rows };
}

export function assertMetricCompleteness(
  observation: CompletenessObservation,
  expectation: CompletenessExpectation,
): void {
  const keys = ["markets", "candidates", "folds", "splits", "rows"] as const;
  const mismatches = keys.filter((key) => observation[key] !== expectation[key]);
  if (mismatches.length > 0) {
    const details = mismatches.map((key) =>
      `${key}=${observation[key]} expected=${expectation[key]}`
    ).join(", ");
    throw new Error(`incomplete V5 metric matrix: ${details}`);
  }
}
