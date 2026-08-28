import type { StructuralPoint, StructuralRegime } from "./types.ts";

export type EmaStructure = "BULL" | "FLAT" | "BEAR";
export type MajorSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";

/**
 * One completed-bar, per-market observation. Percentiles must be calculated from
 * that market's current and earlier completed bars before this object is built.
 */
export interface StructuralMarketObservation {
  time: number;
  symbol: string;
  return6h: number;
  return24h: number;
  emaStructure: EmaStructure;
  trendPersistence: number;
  adxPercentile: number;
  meanReverting: boolean;
  volatilityPercentile: number;
  extremeMover: boolean;
}

interface MajorReturn {
  return6h: number;
  return24h: number;
}

/**
 * JSON-safe, mergeable state for one timestamp. expectedMarkets is the number
 * assigned to this shard; merging disjoint shards adds those counts.
 */
export interface StructuralAccumulator {
  schemaVersion: 1;
  time: number;
  expectedMarkets: number;
  validMarkets: number;
  positive6h: number;
  negative6h: number;
  positive24h: number;
  negative24h: number;
  emaBull: number;
  emaBear: number;
  trendPersistenceSum: number;
  lowAdx: number;
  meanReverting: number;
  volatilityPercentileSum: number;
  extremeMovers: number;
  returns6h: number[];
  returns24h: number[];
  majorReturns: Partial<Record<MajorSymbol, MajorReturn>>;
}

export type StructuralSnapshot =
  & Omit<
    StructuralPoint,
    | "regime"
    | "breadthVelocity"
    | "breadthAcceleration"
    | "bullScore"
    | "bearScore"
    | "rangeScore"
  >
  & {
    expectedMarkets: number;
    majorCoverage: number;
  };

export interface StructuralClassifierOptions {
  rollingLookbackBars?: number;
  minHistoryBars?: number;
  minValidMarkets?: number;
  minUniverseCoverage?: number;
  minMajorCoverage?: number;
  breadthVelocityBars?: number;
  breadthAccelerationBars?: number;
  confirmationWindowBars?: number;
  confirmationBars?: number;
  minDirectionalScore?: number;
  minRangeScore?: number;
  candidateMargin?: number;
  switchMargin?: number;
  maxAmbiguousBars?: number;
  extremeScorePenalty?: number;
}

interface ResolvedStructuralOptions {
  rollingLookbackBars: number;
  minHistoryBars: number;
  minValidMarkets: number;
  minUniverseCoverage: number;
  minMajorCoverage: number;
  breadthVelocityBars: number;
  breadthAccelerationBars: number;
  confirmationWindowBars: number;
  confirmationBars: number;
  minDirectionalScore: number;
  minRangeScore: number;
  candidateMargin: number;
  switchMargin: number;
  maxAmbiguousBars: number;
  extremeScorePenalty: number;
}

export const DEFAULT_STRUCTURAL_OPTIONS: Readonly<ResolvedStructuralOptions> = Object.freeze({
  rollingLookbackBars: 28 * 24 * 4,
  minHistoryBars: 7 * 24 * 4,
  minValidMarkets: 50,
  minUniverseCoverage: 0.5,
  minMajorCoverage: 2,
  breadthVelocityBars: 24, // six hours on the 15m research grid
  breadthAccelerationBars: 24,
  confirmationWindowBars: 4,
  confirmationBars: 3,
  minDirectionalScore: 0.56,
  minRangeScore: 0.54,
  candidateMargin: 0.025,
  switchMargin: 0.045,
  maxAmbiguousBars: 8,
  extremeScorePenalty: 0.08,
});

const MAJOR_SYMBOLS = new Set<MajorSymbol>(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const LOW_ADX_PERCENTILE = 0.3;

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function integerAtLeast(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.round(finite(value ?? fallback, fallback)));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = clamp(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function robustStats(values: number[]): { mean: number; median: number } {
  if (!values.length) return { mean: 0, median: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const low = quantileSorted(sorted, 0.01);
  const high = quantileSorted(sorted, 0.99);
  return {
    mean: average(sorted.map((value) => clamp(value, low, high))),
    median: quantileSorted(sorted, 0.5),
  };
}

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function createStructuralAccumulator(
  time: number,
  expectedMarkets = 0,
): StructuralAccumulator {
  if (!Number.isFinite(time)) throw new Error("structural accumulator time must be finite");
  return {
    schemaVersion: 1,
    time,
    expectedMarkets: Math.max(0, Math.round(finite(expectedMarkets))),
    validMarkets: 0,
    positive6h: 0,
    negative6h: 0,
    positive24h: 0,
    negative24h: 0,
    emaBull: 0,
    emaBear: 0,
    trendPersistenceSum: 0,
    lowAdx: 0,
    meanReverting: 0,
    volatilityPercentileSum: 0,
    extremeMovers: 0,
    returns6h: [],
    returns24h: [],
    majorReturns: {},
  };
}

/** Adds a valid market and returns true; malformed market values are ignored. */
export function accumulateStructuralObservation(
  accumulator: StructuralAccumulator,
  observation: StructuralMarketObservation,
): boolean {
  if (observation.time !== accumulator.time) {
    throw new Error(`structural observation time ${observation.time} != ${accumulator.time}`);
  }
  if (!Number.isFinite(observation.return6h) || !Number.isFinite(observation.return24h)) {
    return false;
  }

  accumulator.validMarkets += 1;
  accumulator.returns6h.push(observation.return6h);
  accumulator.returns24h.push(observation.return24h);
  if (observation.return6h > 0) accumulator.positive6h += 1;
  if (observation.return6h < 0) accumulator.negative6h += 1;
  if (observation.return24h > 0) accumulator.positive24h += 1;
  if (observation.return24h < 0) accumulator.negative24h += 1;
  if (observation.emaStructure === "BULL") accumulator.emaBull += 1;
  if (observation.emaStructure === "BEAR") accumulator.emaBear += 1;
  accumulator.trendPersistenceSum += clamp(finite(observation.trendPersistence), -1, 1);
  if (clamp(finite(observation.adxPercentile, 0.5)) <= LOW_ADX_PERCENTILE) {
    accumulator.lowAdx += 1;
  }
  if (observation.meanReverting) accumulator.meanReverting += 1;
  accumulator.volatilityPercentileSum += clamp(
    finite(observation.volatilityPercentile, 0.5),
  );
  if (observation.extremeMover) accumulator.extremeMovers += 1;

  const symbol = normalizedSymbol(observation.symbol);
  if (MAJOR_SYMBOLS.has(symbol as MajorSymbol)) {
    accumulator.majorReturns[symbol as MajorSymbol] = {
      return6h: observation.return6h,
      return24h: observation.return24h,
    };
  }
  return true;
}

/** Merges disjoint shards without changing either input. */
export function mergeStructuralAccumulators(
  left: StructuralAccumulator,
  right: StructuralAccumulator,
): StructuralAccumulator {
  if (left.schemaVersion !== 1 || right.schemaVersion !== 1) {
    throw new Error("unsupported structural accumulator schema");
  }
  if (left.time !== right.time) {
    throw new Error(`cannot merge structural times ${left.time} and ${right.time}`);
  }
  const majorReturns = { ...left.majorReturns };
  for (const symbol of MAJOR_SYMBOLS) {
    const incoming = right.majorReturns[symbol];
    if (!incoming) continue;
    const existing = majorReturns[symbol];
    if (
      existing &&
      (existing.return6h !== incoming.return6h || existing.return24h !== incoming.return24h)
    ) {
      throw new Error(`overlapping structural shards disagree for ${symbol}`);
    }
    majorReturns[symbol] = { ...incoming };
  }
  return {
    schemaVersion: 1,
    time: left.time,
    expectedMarkets: left.expectedMarkets + right.expectedMarkets,
    validMarkets: left.validMarkets + right.validMarkets,
    positive6h: left.positive6h + right.positive6h,
    negative6h: left.negative6h + right.negative6h,
    positive24h: left.positive24h + right.positive24h,
    negative24h: left.negative24h + right.negative24h,
    emaBull: left.emaBull + right.emaBull,
    emaBear: left.emaBear + right.emaBear,
    trendPersistenceSum: left.trendPersistenceSum + right.trendPersistenceSum,
    lowAdx: left.lowAdx + right.lowAdx,
    meanReverting: left.meanReverting + right.meanReverting,
    volatilityPercentileSum: left.volatilityPercentileSum + right.volatilityPercentileSum,
    extremeMovers: left.extremeMovers + right.extremeMovers,
    returns6h: [...left.returns6h, ...right.returns6h],
    returns24h: [...left.returns24h, ...right.returns24h],
    majorReturns,
  };
}

export function finalizeStructuralAccumulator(
  accumulator: StructuralAccumulator,
): StructuralSnapshot {
  const denominator = Math.max(1, accumulator.validMarkets);
  const sixHour = robustStats(accumulator.returns6h);
  const twentyFourHour = robustStats(accumulator.returns24h);
  const btc = accumulator.majorReturns.BTCUSDT;
  const eth = accumulator.majorReturns.ETHUSDT;
  const sol = accumulator.majorReturns.SOLUSDT;
  const majorCoverage = [btc, eth, sol].filter(Boolean).length;
  return {
    time: accumulator.time,
    positiveBreadth6h: accumulator.positive6h / denominator,
    negativeBreadth6h: accumulator.negative6h / denominator,
    positiveBreadth24h: accumulator.positive24h / denominator,
    negativeBreadth24h: accumulator.negative24h / denominator,
    meanReturn6h: sixHour.mean,
    meanReturn24h: twentyFourHour.mean,
    medianReturn6h: sixHour.median,
    medianReturn24h: twentyFourHour.median,
    emaBullShare: accumulator.emaBull / denominator,
    emaBearShare: accumulator.emaBear / denominator,
    trendPersistence: accumulator.trendPersistenceSum / denominator,
    lowAdxShare: accumulator.lowAdx / denominator,
    meanReversionShare: accumulator.meanReverting / denominator,
    volatilityPercentile: accumulator.volatilityPercentileSum / denominator,
    extremeMoverShare: accumulator.extremeMovers / denominator,
    btc6h: btc?.return6h ?? 0,
    btc24h: btc?.return24h ?? 0,
    eth6h: eth?.return6h ?? 0,
    eth24h: eth?.return24h ?? 0,
    sol6h: sol?.return6h ?? 0,
    sol24h: sol?.return24h ?? 0,
    validMarkets: accumulator.validMarkets,
    expectedMarkets: accumulator.expectedMarkets,
    majorCoverage,
  };
}

interface RankNode {
  value: number;
  priority: number;
  count: number;
  size: number;
  left: RankNode | null;
  right: RankNode | null;
}

function rankSize(node: RankNode | null): number {
  return node?.size ?? 0;
}

function refreshRankNode(node: RankNode): RankNode {
  node.size = node.count + rankSize(node.left) + rankSize(node.right);
  return node;
}

function rotateRankRight(root: RankNode): RankNode {
  const nextRoot = root.left;
  if (!nextRoot) return root;
  root.left = nextRoot.right;
  nextRoot.right = refreshRankNode(root);
  return refreshRankNode(nextRoot);
}

function rotateRankLeft(root: RankNode): RankNode {
  const nextRoot = root.right;
  if (!nextRoot) return root;
  root.right = nextRoot.left;
  nextRoot.left = refreshRankNode(root);
  return refreshRankNode(nextRoot);
}

function insertRankNode(
  root: RankNode | null,
  value: number,
  priority: number,
): RankNode {
  if (!root) {
    return { value, priority, count: 1, size: 1, left: null, right: null };
  }
  if (value === root.value) {
    root.count += 1;
    return refreshRankNode(root);
  }
  if (value < root.value) {
    root.left = insertRankNode(root.left, value, priority);
    if (root.left.priority < root.priority) root = rotateRankRight(root);
  } else {
    root.right = insertRankNode(root.right, value, priority);
    if (root.right.priority < root.priority) root = rotateRankLeft(root);
  }
  return refreshRankNode(root);
}

function mergeRankNodes(left: RankNode | null, right: RankNode | null): RankNode | null {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) {
    left.right = mergeRankNodes(left.right, right);
    return refreshRankNode(left);
  }
  right.left = mergeRankNodes(left, right.left);
  return refreshRankNode(right);
}

function removeRankNode(root: RankNode | null, value: number): RankNode | null {
  if (!root) throw new Error("rolling percentile window is inconsistent");
  if (value === root.value) {
    if (root.count > 1) {
      root.count -= 1;
      return refreshRankNode(root);
    }
    return mergeRankNodes(root.left, root.right);
  }
  if (value < root.value) root.left = removeRankNode(root.left, value);
  else root.right = removeRankNode(root.right, value);
  return refreshRankNode(root);
}

function rankBelow(root: RankNode | null, value: number): number {
  let count = 0;
  let cursor = root;
  while (cursor) {
    if (value <= cursor.value) {
      cursor = cursor.left;
    } else {
      count += rankSize(cursor.left) + cursor.count;
      cursor = cursor.right;
    }
  }
  return count;
}

function rankEqual(root: RankNode | null, value: number): number {
  let cursor = root;
  while (cursor) {
    if (value === cursor.value) return cursor.count;
    cursor = value < cursor.value ? cursor.left : cursor.right;
  }
  return 0;
}

/**
 * Percentile rank against prior values only. The current value enters the
 * window after its rank is calculated, so future edits cannot alter the past.
 */
export function causalRollingPercentile(
  values: number[],
  rollingLookbackBars: number,
  minHistoryBars: number,
): number[] {
  const lookback = integerAtLeast(rollingLookbackBars, 2, 2);
  const minimum = Math.min(lookback, integerAtLeast(minHistoryBars, 1, 1));
  let root: RankNode | null = null;
  let windowSize = 0;
  let priorityState = 0x9e3779b9;
  const nextPriority = (): number => {
    priorityState ^= priorityState << 13;
    priorityState ^= priorityState >>> 17;
    priorityState ^= priorityState << 5;
    return priorityState >>> 0;
  };
  const result = new Array<number>(values.length).fill(0.5);
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (Number.isFinite(current) && windowSize >= minimum) {
      result[index] = (rankBelow(root, current) + rankEqual(root, current) * 0.5) /
        windowSize;
    }
    if (Number.isFinite(current)) {
      root = insertRankNode(root, current, nextPriority());
      windowSize += 1;
    }
    const expiredIndex = index - lookback;
    if (expiredIndex >= 0 && Number.isFinite(values[expiredIndex])) {
      root = removeRankNode(root, values[expiredIndex]);
      windowSize -= 1;
    }
  }
  return result;
}

function resolveOptions(options: StructuralClassifierOptions): ResolvedStructuralOptions {
  const rollingLookbackBars = integerAtLeast(
    options.rollingLookbackBars,
    DEFAULT_STRUCTURAL_OPTIONS.rollingLookbackBars,
    2,
  );
  const confirmationWindowBars = integerAtLeast(
    options.confirmationWindowBars,
    DEFAULT_STRUCTURAL_OPTIONS.confirmationWindowBars,
    1,
  );
  return {
    rollingLookbackBars,
    minHistoryBars: Math.min(
      rollingLookbackBars,
      integerAtLeast(
        options.minHistoryBars,
        DEFAULT_STRUCTURAL_OPTIONS.minHistoryBars,
        1,
      ),
    ),
    minValidMarkets: integerAtLeast(
      options.minValidMarkets,
      DEFAULT_STRUCTURAL_OPTIONS.minValidMarkets,
      1,
    ),
    minUniverseCoverage: clamp(
      finite(options.minUniverseCoverage ?? DEFAULT_STRUCTURAL_OPTIONS.minUniverseCoverage),
    ),
    minMajorCoverage: Math.min(
      3,
      integerAtLeast(
        options.minMajorCoverage,
        DEFAULT_STRUCTURAL_OPTIONS.minMajorCoverage,
        0,
      ),
    ),
    breadthVelocityBars: integerAtLeast(
      options.breadthVelocityBars,
      DEFAULT_STRUCTURAL_OPTIONS.breadthVelocityBars,
      1,
    ),
    breadthAccelerationBars: integerAtLeast(
      options.breadthAccelerationBars,
      DEFAULT_STRUCTURAL_OPTIONS.breadthAccelerationBars,
      1,
    ),
    confirmationWindowBars,
    confirmationBars: Math.min(
      confirmationWindowBars,
      integerAtLeast(
        options.confirmationBars,
        DEFAULT_STRUCTURAL_OPTIONS.confirmationBars,
        1,
      ),
    ),
    minDirectionalScore: clamp(
      finite(options.minDirectionalScore ?? DEFAULT_STRUCTURAL_OPTIONS.minDirectionalScore),
    ),
    minRangeScore: clamp(
      finite(options.minRangeScore ?? DEFAULT_STRUCTURAL_OPTIONS.minRangeScore),
    ),
    candidateMargin: clamp(
      finite(options.candidateMargin ?? DEFAULT_STRUCTURAL_OPTIONS.candidateMargin),
    ),
    switchMargin: clamp(
      finite(options.switchMargin ?? DEFAULT_STRUCTURAL_OPTIONS.switchMargin),
    ),
    maxAmbiguousBars: integerAtLeast(
      options.maxAmbiguousBars,
      DEFAULT_STRUCTURAL_OPTIONS.maxAmbiguousBars,
      0,
    ),
    extremeScorePenalty: clamp(
      finite(options.extremeScorePenalty ?? DEFAULT_STRUCTURAL_OPTIONS.extremeScorePenalty),
    ),
  };
}

interface FeatureRanks {
  [key: string]: number[];
}

function ranksFor(
  snapshots: StructuralSnapshot[],
  dynamics: { breadthVelocity: number[]; breadthAcceleration: number[] },
  options: ResolvedStructuralOptions,
  coverageValid: boolean[],
): FeatureRanks {
  const featureValues: Record<string, number[]> = {
    positiveBreadth6h: snapshots.map((point) => point.positiveBreadth6h),
    negativeBreadth6h: snapshots.map((point) => point.negativeBreadth6h),
    positiveBreadth24h: snapshots.map((point) => point.positiveBreadth24h),
    negativeBreadth24h: snapshots.map((point) => point.negativeBreadth24h),
    meanReturn6h: snapshots.map((point) => point.meanReturn6h),
    meanReturn24h: snapshots.map((point) => point.meanReturn24h),
    medianReturn6h: snapshots.map((point) => point.medianReturn6h),
    medianReturn24h: snapshots.map((point) => point.medianReturn24h),
    emaBullShare: snapshots.map((point) => point.emaBullShare),
    emaBearShare: snapshots.map((point) => point.emaBearShare),
    trendPersistence: snapshots.map((point) => point.trendPersistence),
    volatilityPercentile: snapshots.map((point) => point.volatilityPercentile),
    extremeMoverShare: snapshots.map((point) => point.extremeMoverShare),
    breadthVelocity: dynamics.breadthVelocity,
    breadthAcceleration: dynamics.breadthAcceleration,
    btc6h: snapshots.map((point) => point.btc6h),
    btc24h: snapshots.map((point) => point.btc24h),
    eth6h: snapshots.map((point) => point.eth6h),
    eth24h: snapshots.map((point) => point.eth24h),
    sol6h: snapshots.map((point) => point.sol6h),
    sol24h: snapshots.map((point) => point.sol24h),
    breadthImbalance: snapshots.map((point) =>
      average([
        Math.abs(point.positiveBreadth6h - point.negativeBreadth6h),
        Math.abs(point.positiveBreadth24h - point.negativeBreadth24h),
      ])
    ),
    returnMagnitude: snapshots.map((point) =>
      average([
        Math.abs(point.meanReturn6h),
        Math.abs(point.meanReturn24h),
        Math.abs(point.medianReturn6h),
        Math.abs(point.medianReturn24h),
      ])
    ),
    emaImbalance: snapshots.map((point) => Math.abs(point.emaBullShare - point.emaBearShare)),
    trendMagnitude: snapshots.map((point) => Math.abs(point.trendPersistence)),
    majorMagnitude: snapshots.map((point) =>
      average([
        Math.abs(point.btc6h),
        Math.abs(point.btc24h),
        Math.abs(point.eth6h),
        Math.abs(point.eth24h),
        Math.abs(point.sol6h),
        Math.abs(point.sol24h),
      ])
    ),
    breadthDynamicsMagnitude: dynamics.breadthVelocity.map((velocity, index) =>
      Math.abs(velocity) + Math.abs(dynamics.breadthAcceleration[index])
    ),
    lowAdxShare: snapshots.map((point) => point.lowAdxShare),
    meanReversionShare: snapshots.map((point) => point.meanReversionShare),
  };
  return Object.fromEntries(
    Object.entries(featureValues).map(([name, values]) => {
      const validValues = values.map((value, index) => coverageValid[index] ? value : Number.NaN);
      return [
        name,
        causalRollingPercentile(
          validValues,
          options.rollingLookbackBars,
          options.minHistoryBars,
        ),
      ];
    }),
  );
}

function weightedScore(parts: Array<[number, number]>): number {
  const weight = parts.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  if (!(weight > 0)) return 0;
  return clamp(parts.reduce((sum, [value, itemWeight]) => sum + value * itemWeight, 0) / weight);
}

function percentileAndLevel(percentile: number, level: number): number {
  return clamp(percentile * 0.68 + clamp(level) * 0.32);
}

function scoreAt(
  point: StructuralSnapshot,
  ranks: FeatureRanks,
  index: number,
  options: ResolvedStructuralOptions,
): { bullScore: number; bearScore: number; rangeScore: number } {
  const bullBreadth6 = average([
    ranks.positiveBreadth6h[index],
    1 - ranks.negativeBreadth6h[index],
  ]);
  const bullBreadth24 = average([
    ranks.positiveBreadth24h[index],
    1 - ranks.negativeBreadth24h[index],
  ]);
  const bearBreadth6 = average([
    ranks.negativeBreadth6h[index],
    1 - ranks.positiveBreadth6h[index],
  ]);
  const bearBreadth24 = average([
    ranks.negativeBreadth24h[index],
    1 - ranks.positiveBreadth24h[index],
  ]);
  const bullReturn6 = average([ranks.meanReturn6h[index], ranks.medianReturn6h[index]]);
  const bullReturn24 = average([
    ranks.meanReturn24h[index],
    ranks.medianReturn24h[index],
  ]);
  const bearReturn6 = 1 - bullReturn6;
  const bearReturn24 = 1 - bullReturn24;
  const bullEma = average([ranks.emaBullShare[index], 1 - ranks.emaBearShare[index]]);
  const bearEma = average([ranks.emaBearShare[index], 1 - ranks.emaBullShare[index]]);
  const bullMajors6 = average([ranks.btc6h[index], ranks.eth6h[index], ranks.sol6h[index]]);
  const bullMajors24 = average([
    ranks.btc24h[index],
    ranks.eth24h[index],
    ranks.sol24h[index],
  ]);
  const bearMajors6 = 1 - bullMajors6;
  const bearMajors24 = 1 - bullMajors24;
  const bullDirection = average([bullBreadth24, bullReturn24, bullMajors24]);
  const bearDirection = average([bearBreadth24, bearReturn24, bearMajors24]);
  const volatilityRank = ranks.volatilityPercentile[index];
  const bullVolatilityAlignment = clamp(0.5 + (bullDirection - 0.5) * volatilityRank);
  const bearVolatilityAlignment = clamp(0.5 + (bearDirection - 0.5) * volatilityRank);

  let bullScore = weightedScore([
    [percentileAndLevel(bullBreadth24, point.positiveBreadth24h), 0.17],
    [bullReturn24, 0.14],
    [percentileAndLevel(bullBreadth6, point.positiveBreadth6h), 0.12],
    [bullReturn6, 0.09],
    [percentileAndLevel(bullEma, point.emaBullShare), 0.12],
    [
      percentileAndLevel(ranks.trendPersistence[index], (point.trendPersistence + 1) / 2),
      0.10,
    ],
    [bullMajors24, 0.09],
    [bullMajors6, 0.05],
    [ranks.breadthVelocity[index], 0.05],
    [ranks.breadthAcceleration[index], 0.03],
    [bullVolatilityAlignment, 0.04],
  ]);
  let bearScore = weightedScore([
    [percentileAndLevel(bearBreadth24, point.negativeBreadth24h), 0.17],
    [bearReturn24, 0.14],
    [percentileAndLevel(bearBreadth6, point.negativeBreadth6h), 0.12],
    [bearReturn6, 0.09],
    [percentileAndLevel(bearEma, point.emaBearShare), 0.12],
    [
      percentileAndLevel(1 - ranks.trendPersistence[index], (1 - point.trendPersistence) / 2),
      0.10,
    ],
    [bearMajors24, 0.09],
    [bearMajors6, 0.05],
    [1 - ranks.breadthVelocity[index], 0.05],
    [1 - ranks.breadthAcceleration[index], 0.03],
    [bearVolatilityAlignment, 0.04],
  ]);
  const extremePenalty = 1 -
    ranks.extremeMoverShare[index] * options.extremeScorePenalty;
  bullScore = clamp(bullScore * extremePenalty);
  bearScore = clamp(bearScore * extremePenalty);

  const breadthBalanceLevel = 1 - average([
    Math.abs(point.positiveBreadth6h - point.negativeBreadth6h),
    Math.abs(point.positiveBreadth24h - point.negativeBreadth24h),
  ]);
  const emaBalanceLevel = 1 - Math.abs(point.emaBullShare - point.emaBearShare);
  const rangeScore = weightedScore([
    [percentileAndLevel(1 - ranks.breadthImbalance[index], breadthBalanceLevel), 0.17],
    [1 - ranks.returnMagnitude[index], 0.16],
    [percentileAndLevel(1 - ranks.emaImbalance[index], emaBalanceLevel), 0.12],
    [percentileAndLevel(ranks.lowAdxShare[index], point.lowAdxShare), 0.14],
    [percentileAndLevel(ranks.meanReversionShare[index], point.meanReversionShare), 0.14],
    [
      percentileAndLevel(1 - ranks.trendMagnitude[index], 1 - Math.abs(point.trendPersistence)),
      0.09,
    ],
    [percentileAndLevel(1 - volatilityRank, 1 - point.volatilityPercentile), 0.06],
    [
      percentileAndLevel(1 - ranks.extremeMoverShare[index], 1 - point.extremeMoverShare),
      0.04,
    ],
    [1 - ranks.majorMagnitude[index], 0.04],
    [1 - ranks.breadthDynamicsMagnitude[index], 0.04],
  ]);
  return { bullScore, bearScore, rangeScore };
}

function calculateDynamics(
  snapshots: StructuralSnapshot[],
  options: ResolvedStructuralOptions,
): { breadthVelocity: number[]; breadthAcceleration: number[] } {
  const direction = snapshots.map((point) =>
    (point.positiveBreadth6h - point.negativeBreadth6h) * 0.65 +
    (point.positiveBreadth24h - point.negativeBreadth24h) * 0.35
  );
  const breadthVelocity = direction.map((value, index) =>
    index >= options.breadthVelocityBars
      ? value - direction[index - options.breadthVelocityBars]
      : 0
  );
  const breadthAcceleration = breadthVelocity.map((value, index) =>
    index >= options.breadthAccelerationBars
      ? value - breadthVelocity[index - options.breadthAccelerationBars]
      : 0
  );
  return { breadthVelocity, breadthAcceleration };
}

function semanticDirection(point: StructuralSnapshot): "BULL" | "BEAR" | "MIXED" {
  const major24 = average([point.btc24h, point.eth24h, point.sol24h]);
  const bull = point.positiveBreadth24h > point.negativeBreadth24h &&
    point.medianReturn24h > 0 && point.meanReturn24h > 0 && major24 >= 0;
  const bear = point.negativeBreadth24h > point.positiveBreadth24h &&
    point.medianReturn24h < 0 && point.meanReturn24h < 0 && major24 <= 0;
  return bull ? "BULL" : bear ? "BEAR" : "MIXED";
}

function candidateAt(
  point: StructuralSnapshot,
  score: { bullScore: number; bearScore: number; rangeScore: number },
  options: ResolvedStructuralOptions,
): StructuralRegime {
  const direction = semanticDirection(point);
  if (
    direction === "BULL" && score.bullScore >= options.minDirectionalScore &&
    score.bullScore >= score.bearScore + options.candidateMargin &&
    score.bullScore >= score.rangeScore + options.candidateMargin
  ) {
    return "BULL";
  }
  if (
    direction === "BEAR" && score.bearScore >= options.minDirectionalScore &&
    score.bearScore >= score.bullScore + options.candidateMargin &&
    score.bearScore >= score.rangeScore + options.candidateMargin
  ) {
    return "BEAR";
  }
  if (score.rangeScore >= options.minRangeScore) return "RANGE";
  return "UNKNOWN";
}

function scoreFor(
  regime: Exclude<StructuralRegime, "UNKNOWN">,
  score: { bullScore: number; bearScore: number; rangeScore: number },
): number {
  return regime === "BULL"
    ? score.bullScore
    : regime === "BEAR"
    ? score.bearScore
    : score.rangeScore;
}

function confirmed(
  candidates: StructuralRegime[],
  index: number,
  candidate: Exclude<StructuralRegime, "UNKNOWN">,
  options: ResolvedStructuralOptions,
): boolean {
  let count = 0;
  for (
    let cursor = Math.max(0, index - options.confirmationWindowBars + 1);
    cursor <= index;
    cursor += 1
  ) {
    if (candidates[cursor] === candidate) count += 1;
  }
  return count >= options.confirmationBars;
}

function assertChronological(snapshots: StructuralSnapshot[]): void {
  for (let index = 1; index < snapshots.length; index += 1) {
    if (!(snapshots[index].time > snapshots[index - 1].time)) {
      throw new Error("structural snapshots must be strictly chronological");
    }
  }
}

function validHistoryAt(
  coverageValid: boolean[],
  lookbackBars: number,
  minHistoryBars: number,
): boolean[] {
  const result = new Array<boolean>(coverageValid.length).fill(false);
  let count = 0;
  for (let index = 0; index < coverageValid.length; index += 1) {
    result[index] = count >= minHistoryBars;
    if (coverageValid[index]) count += 1;
    const expiredIndex = index - lookbackBars;
    if (expiredIndex >= 0 && coverageValid[expiredIndex]) count -= 1;
  }
  return result;
}

/**
 * Classifies the series in one forward pass. Scores at i use a percentile
 * distribution ending at i-1; breadth dynamics and hysteresis use i and earlier.
 */
export function classifyStructuralSeries(
  snapshots: StructuralSnapshot[],
  suppliedOptions: StructuralClassifierOptions = {},
): StructuralPoint[] {
  assertChronological(snapshots);
  if (!snapshots.length) return [];
  const options = resolveOptions(suppliedOptions);
  const coverageValid = snapshots.map((point) => {
    const coverage = point.expectedMarkets > 0 ? point.validMarkets / point.expectedMarkets : 0;
    return point.validMarkets >= options.minValidMarkets &&
      coverage >= options.minUniverseCoverage && point.majorCoverage >= options.minMajorCoverage;
  });
  const historyValid = validHistoryAt(
    coverageValid,
    options.rollingLookbackBars,
    options.minHistoryBars,
  );
  const dynamics = calculateDynamics(snapshots, options);
  const ranks = ranksFor(snapshots, dynamics, options, coverageValid);
  const scores = snapshots.map((point, index) => scoreAt(point, ranks, index, options));
  const ready = coverageValid.map((valid, index) => valid && historyValid[index]);
  const candidates = snapshots.map((point, index) =>
    ready[index] ? candidateAt(point, scores[index], options) : "UNKNOWN"
  );

  const regimes = new Array<StructuralRegime>(snapshots.length).fill("UNKNOWN");
  let stable: StructuralRegime = "UNKNOWN";
  let ambiguousBars = 0;
  for (let index = 0; index < snapshots.length; index += 1) {
    if (!ready[index]) {
      stable = "UNKNOWN";
      ambiguousBars = 0;
      regimes[index] = stable;
      continue;
    }
    const candidate = candidates[index];
    if (candidate === "UNKNOWN") {
      ambiguousBars += 1;
      if (ambiguousBars > options.maxAmbiguousBars) stable = "UNKNOWN";
      regimes[index] = stable;
      continue;
    }
    if (stable === "UNKNOWN") {
      if (confirmed(candidates, index, candidate, options)) {
        stable = candidate;
        ambiguousBars = 0;
      }
      regimes[index] = stable;
      continue;
    }
    if (candidate === stable) {
      ambiguousBars = 0;
      regimes[index] = stable;
      continue;
    }
    let switched = false;
    if (confirmed(candidates, index, candidate, options)) {
      const challenger = scoreFor(candidate, scores[index]);
      const incumbent = scoreFor(stable, scores[index]);
      if (challenger >= incumbent + options.switchMargin) {
        stable = candidate;
        ambiguousBars = 0;
        switched = true;
      }
    }
    if (!switched) {
      // A persistent semantic challenger that clears candidateMargin but not the
      // larger switchMargin must not leave the incumbent latched forever.
      ambiguousBars += 1;
      if (ambiguousBars > options.maxAmbiguousBars) {
        stable = "UNKNOWN";
        ambiguousBars = 0;
      }
    }
    regimes[index] = stable;
  }

  return snapshots.map((point, index) => ({
    time: point.time,
    regime: regimes[index],
    positiveBreadth6h: point.positiveBreadth6h,
    negativeBreadth6h: point.negativeBreadth6h,
    positiveBreadth24h: point.positiveBreadth24h,
    negativeBreadth24h: point.negativeBreadth24h,
    meanReturn6h: point.meanReturn6h,
    meanReturn24h: point.meanReturn24h,
    medianReturn6h: point.medianReturn6h,
    medianReturn24h: point.medianReturn24h,
    emaBullShare: point.emaBullShare,
    emaBearShare: point.emaBearShare,
    trendPersistence: point.trendPersistence,
    lowAdxShare: point.lowAdxShare,
    meanReversionShare: point.meanReversionShare,
    volatilityPercentile: point.volatilityPercentile,
    extremeMoverShare: point.extremeMoverShare,
    breadthVelocity: dynamics.breadthVelocity[index],
    breadthAcceleration: dynamics.breadthAcceleration[index],
    btc6h: point.btc6h,
    btc24h: point.btc24h,
    eth6h: point.eth6h,
    eth24h: point.eth24h,
    sol6h: point.sol6h,
    sol24h: point.sol24h,
    bullScore: scores[index].bullScore,
    bearScore: scores[index].bearScore,
    rangeScore: scores[index].rangeScore,
    validMarkets: point.validMarkets,
  }));
}
