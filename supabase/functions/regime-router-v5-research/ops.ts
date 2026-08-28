import {
  assertExpectedClosedBarCoverage,
  fetchClosed15mBars,
  fetchClosed5mBars,
  firstRequiredKlineOpen,
  listActivePerpetualMarkets,
} from "./binance.ts";
import {
  assertMetricCompleteness,
  buildRollingFolds,
  type CandidateFoldMetric,
  type CandidateValidationReport,
  DAY_MS,
  evaluateCandidateValidation,
  expectedMetricCompleteness,
  splitForFold,
  V5_FOLD_POLICY,
} from "./folds.ts";
import { prepareBars, rollingPercentileRanks } from "./indicators.ts";
import { summarizeTrades } from "./metrics.ts";
import {
  createV5ResearchJob,
  loadV5ResearchJob,
  type ResearchRepositoryOptions,
  updateV5ResearchJob,
  upsertV5MarketResults,
  type V5MarketResultInput,
  type V5ResearchJobRow,
} from "./repository.ts";
import { simulateCandidate } from "./simulator.ts";
import {
  CANDIDATE_REGISTRY_HASH_INPUT,
  candidates,
  V5_CANDIDATE_REGISTRY_REVISION,
} from "./strategies.ts";
import {
  accumulateStructuralObservation,
  classifyStructuralSeries,
  createStructuralAccumulator,
  finalizeStructuralAccumulator,
  mergeStructuralAccumulators,
  type StructuralAccumulator,
  type StructuralMarketObservation,
  type StructuralSnapshot,
} from "./structural.ts";
import {
  type Bar,
  BAR_MS,
  BASE_COST_BPS,
  type Candidate,
  FIVE_MINUTE_MS,
  type FiveMinutePoint,
  type FoldDefinition,
  type PreparedBar,
  STRESS_COST_BPS,
  type StructuralPoint,
  type StructuralRegime,
  type UniverseMarket,
  V5_BUILD_SOURCE_SHA,
  V5_IMPLEMENTATION_SHA256,
  V5_REVISION,
  type V5Trade,
} from "./types.ts";

export const V5_BREADTH_SHARDS = 100;
export const V5_BACKTEST_SHARDS = 600;
export const V5_TIME_CHUNK_BARS = 10 * 24 * 4;
export const V5_TIME_CHUNKS = V5_FOLD_POLICY.lookbackDays / 10;
export const V5_MINIMUM_ACTIVE_MARKETS = 500;
export const V5_BACKTEST_ROLLUP_SHARDS = 60;
export const V5_CHECKPOINTS_PER_ROLLUP = V5_BACKTEST_SHARDS / V5_BACKTEST_ROLLUP_SHARDS;
export const V5_MARKET_WARMUP_BARS = 7 * DAY_MS / BAR_MS;

const RESULT_TABLE = "v2_research_market_results";
const RESULT_CONFLICT_COLUMNS = "job_id,market,config_key,split";
const FIVE_MINUTE_WARMUP_BARS = 24;
const BREADTH_CONCURRENCY = 1;
const STATUS_COUNT_CONCURRENCY = 4;

export const V5_PRODUCTION_REVIEW_RISK_GATE = Object.freeze({
  minimumStressToMdd: 0.25,
  minimumMfeCapture: 0.20,
  maximumGivebackToMfe: 0.80,
  minimumUniqueSignalDays: Object.freeze({ TRAIN: 10, VALIDATION: 5, FINAL_TEST: 5 }),
  maximumPositiveTimeChunkShare: 0.60,
  minimumProfitableTimeChunks: 2,
});

const STRUCTURAL_FEATURES = [
  "positiveBreadth6h",
  "negativeBreadth6h",
  "positiveBreadth24h",
  "negativeBreadth24h",
  "meanReturn6h",
  "meanReturn24h",
  "medianReturn6h",
  "medianReturn24h",
  "emaBullShare",
  "emaBearShare",
  "trendPersistence",
  "lowAdxShare",
  "meanReversionShare",
  "volatilityPercentile",
  "extremeMoverShare",
  "breadthVelocity",
  "breadthAcceleration",
  "btc6h",
  "btc24h",
  "eth6h",
  "eth24h",
  "sol6h",
  "sol24h",
  "bullScore",
  "bearScore",
  "rangeScore",
  "validMarkets",
] as const satisfies readonly (Exclude<keyof StructuralPoint, "time" | "regime">)[];

type StructuralFeatureName = (typeof STRUCTURAL_FEATURES)[number];

interface CompactNumericBounds {
  minimum: number;
  maximum: number;
  integer?: boolean;
}

// Returns originate from strictly-positive Binance klines, so -1 is their
// mathematical lower bound. They have no finite mathematical upper bound; the
// deliberately enormous 1,000,000 cap is only a corruption guard and is far
// outside any plausible completed 6h/24h market move.
const COMPACT_RETURN_BOUNDS = Object.freeze({ minimum: -1, maximum: 1_000_000 });
const COMPACT_SHARE_BOUNDS = Object.freeze({ minimum: 0, maximum: 1 });
const COMPACT_LOCAL_BREADTH_VELOCITY_BOUNDS = Object.freeze({ minimum: -1, maximum: 1 });
const COMPACT_STRUCTURAL_FEATURE_BOUNDS: Readonly<
  Record<StructuralFeatureName, CompactNumericBounds>
> = Object.freeze({
  positiveBreadth6h: COMPACT_SHARE_BOUNDS,
  negativeBreadth6h: COMPACT_SHARE_BOUNDS,
  positiveBreadth24h: COMPACT_SHARE_BOUNDS,
  negativeBreadth24h: COMPACT_SHARE_BOUNDS,
  meanReturn6h: COMPACT_RETURN_BOUNDS,
  meanReturn24h: COMPACT_RETURN_BOUNDS,
  medianReturn6h: COMPACT_RETURN_BOUNDS,
  medianReturn24h: COMPACT_RETURN_BOUNDS,
  emaBullShare: COMPACT_SHARE_BOUNDS,
  emaBearShare: COMPACT_SHARE_BOUNDS,
  trendPersistence: { minimum: -1, maximum: 1 },
  lowAdxShare: COMPACT_SHARE_BOUNDS,
  meanReversionShare: COMPACT_SHARE_BOUNDS,
  volatilityPercentile: COMPACT_SHARE_BOUNDS,
  extremeMoverShare: COMPACT_SHARE_BOUNDS,
  // Direction is in [-1, 1], so its first and second differences are bounded.
  breadthVelocity: { minimum: -2, maximum: 2 },
  breadthAcceleration: { minimum: -4, maximum: 4 },
  btc6h: COMPACT_RETURN_BOUNDS,
  btc24h: COMPACT_RETURN_BOUNDS,
  eth6h: COMPACT_RETURN_BOUNDS,
  eth24h: COMPACT_RETURN_BOUNDS,
  sol6h: COMPACT_RETURN_BOUNDS,
  sol24h: COMPACT_RETURN_BOUNDS,
  bullScore: COMPACT_SHARE_BOUNDS,
  bearScore: COMPACT_SHARE_BOUNDS,
  rangeScore: COMPACT_SHARE_BOUNDS,
  validMarkets: { minimum: 0, maximum: V5_BACKTEST_SHARDS, integer: true },
});

const STRUCTURAL_SNAPSHOT_FIELDS = [
  "time",
  "positiveBreadth6h",
  "negativeBreadth6h",
  "positiveBreadth24h",
  "negativeBreadth24h",
  "meanReturn6h",
  "meanReturn24h",
  "medianReturn6h",
  "medianReturn24h",
  "emaBullShare",
  "emaBearShare",
  "trendPersistence",
  "lowAdxShare",
  "meanReversionShare",
  "volatilityPercentile",
  "extremeMoverShare",
  "btc6h",
  "btc24h",
  "eth6h",
  "eth24h",
  "sol6h",
  "sol24h",
  "validMarkets",
  "expectedMarkets",
  "majorCoverage",
] as const satisfies readonly (keyof StructuralSnapshot)[];

const SORTED_STRUCTURAL_SNAPSHOT_FIELDS = [...STRUCTURAL_SNAPSHOT_FIELDS].sort();

type JsonObject = Record<string, unknown>;

export interface CompactStructuralSeries {
  schemaVersion: 1;
  gridStartMs: number;
  gridLength: number;
  featureOrder: readonly string[];
  featuresF32Base64: string;
  regimeCodes: string;
  localBreadth30F32Base64: string;
  localBreadthVelocity30F32Base64: string;
  registryHash: string;
}

interface StructuralPartialParameters {
  schema_version: 1;
  router_revision: typeof V5_REVISION;
  shard_index: number;
  shard_count: number;
  chunk_index: number;
  chunk_start_index: number;
  chunk_bars: number;
  assigned_markets: string[];
  successful_markets: string[];
  failed_markets: Array<{ market: string; error: string }>;
  accumulators: StructuralAccumulator[];
  local_valid_30: number[];
  local_positive_30: number[];
  generated_at: string;
}

interface StructuralFinalizedChunkParameters {
  schema_version: 1;
  router_revision: typeof V5_REVISION;
  chunk_index: number;
  chunk_count: number;
  chunk_start_index: number;
  chunk_bars: number;
  first_time_ms: number;
  last_time_ms: number;
  breadth_shard_count: number;
  source_partial_rows: number;
  universe_count: number;
  universe_symbols_sha256: string;
  snapshots: StructuralSnapshot[];
  local_breadth_30: number[];
  generated_at: string;
}

interface BacktestCheckpointParameters {
  schema_version: 1;
  router_revision: typeof V5_REVISION;
  shard_index: number;
  shard_count: number;
  assigned_markets: string[];
  successful_markets: string[];
  failed_markets: Array<{ market: string; error: string }>;
  candidate_count: number;
  fold_count: number;
  split_count: 3;
  result_rows: number;
  expected_result_rows: number;
  aggregates: ShardAggregate[];
  completed_at: string;
}

interface BacktestRollupParameters {
  schema_version: 1;
  router_revision: typeof V5_REVISION;
  rollup_index: number;
  rollup_count: number;
  checkpoints_per_rollup: number;
  shard_indices: number[];
  assigned_markets: string[];
  successful_markets: string[];
  failed_markets: Array<{ market: string; error: string }>;
  candidate_count: number;
  fold_count: number;
  split_count: 3;
  result_rows: number;
  expected_result_rows: number;
  aggregates: ShardAggregate[];
  generated_at: string;
}

interface ShardAggregate {
  candidate: string;
  family: Candidate["family"];
  state: Candidate["state"];
  neighbor_group: string;
  fold: number;
  split: V5Trade["split"];
  eligible_bars: number;
  regime_bars: number;
  trades: number;
  wins: number;
  gross_pnl_bps: number;
  net_pnl_bps: number;
  stress_net_pnl_bps: number;
  net_profit_bps: number;
  net_loss_bps: number;
  mfe_sum_bps: number;
  mae_sum_bps: number;
  capture_sum: number;
  capture_count: number;
  giveback_sum_bps: number;
  hold_sum_bars: number;
  exit_reason_counts: Record<string, number>;
  signal_day_indices: number[];
  exit_net_by_grid_index: Array<[number, number]>;
  time_chunk_net_bps: number[];
}

interface MarketBacktestOutput {
  rows: V5MarketResultInput[];
  aggregates: ShardAggregate[];
}

export type ProductionReviewReport = CandidateValidationReport & {
  concentrationPass: boolean;
  riskQualityPass: boolean;
  riskQualityFailures: string[];
  uniqueOccurrencePass: boolean;
  uniqueOccurrenceFailures: string[];
  productionReviewEligible: boolean;
  testUsedForSelection: false;
};

interface RawResultRow {
  market: string;
  config_key: string;
  parameters: JsonObject;
}

interface RawResearchStore {
  select(path: string): Promise<unknown[]>;
  upsert(row: JsonObject): Promise<void>;
  exactCount(query: string): Promise<number>;
}

export interface V5OpsDependencies {
  now: () => Date;
  listMarkets: typeof listActivePerpetualMarkets;
  fetch15m: typeof fetchClosed15mBars;
  fetch5m: typeof fetchClosed5mBars;
  createJob: typeof createV5ResearchJob;
  loadJob: typeof loadV5ResearchJob;
  updateJob: typeof updateV5ResearchJob;
  upsertResults: typeof upsertV5MarketResults;
  rawStore: RawResearchStore;
  repositoryOptions: ResearchRepositoryOptions;
  runtimeIdentity: () => V5RuntimeIdentity;
}

export interface V5RuntimeIdentity {
  sourceSha: string;
  implementationSha256: string;
}

function env(name: string): string {
  return String(Deno.env.get(name) || "").trim();
}

function serviceHeaders(extra: HeadersInit = {}): Headers {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY unavailable");
  const headers = new Headers(extra);
  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("accept", "application/json");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

async function researchRestResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const base = env("SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("SUPABASE_URL unavailable");
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders(init.headers),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`V5 research REST ${response.status}: ${body.slice(0, 600)}`);
  }
  return response;
}

const defaultRawStore: RawResearchStore = {
  async select(path) {
    const response = await researchRestResponse(path);
    const body = await response.text();
    return body ? JSON.parse(body) : [];
  },
  async upsert(row) {
    const path = `${RESULT_TABLE}?on_conflict=${encodeURIComponent(RESULT_CONFLICT_COLUMNS)}`;
    await researchRestResponse(path, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([row]),
    });
  },
  async exactCount(query) {
    const response = await researchRestResponse(`${RESULT_TABLE}?${query}`, {
      method: "GET",
      headers: { Prefer: "count=exact", Range: "0-0" },
    });
    await response.body?.cancel();
    const contentRange = response.headers.get("content-range") || "";
    const match = contentRange.match(/\/(\d+)$/);
    if (!match) throw new Error(`V5 exact count missing Content-Range: ${contentRange}`);
    return Number(match[1]);
  },
};

const DEFAULT_DEPENDENCIES: V5OpsDependencies = {
  now: () => new Date(),
  listMarkets: listActivePerpetualMarkets,
  fetch15m: fetchClosed15mBars,
  fetch5m: fetchClosed5mBars,
  createJob: createV5ResearchJob,
  loadJob: loadV5ResearchJob,
  updateJob: updateV5ResearchJob,
  upsertResults: upsertV5MarketResults,
  rawStore: defaultRawStore,
  repositoryOptions: {},
  runtimeIdentity: () => ({
    sourceSha: V5_BUILD_SOURCE_SHA,
    implementationSha256: V5_IMPLEMENTATION_SHA256,
  }),
};

function dependencies(overrides: Partial<V5OpsDependencies>): V5OpsDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function finiteInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function jobConfig(job: V5ResearchJobRow): JsonObject {
  return object(job.config, "job.config");
}

function jobMetrics(job: V5ResearchJobRow): JsonObject {
  return object(job.metrics, "job.metrics");
}

function stampedRuntimeIdentity(deps: V5OpsDependencies): V5RuntimeIdentity {
  const identity = deps.runtimeIdentity();
  const sourceSha = String(identity?.sourceSha || "").trim().toLowerCase();
  const implementationSha256 = String(identity?.implementationSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("V5 runtime source SHA is unstamped or invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(implementationSha256)) {
    throw new Error("V5 runtime implementation SHA-256 is unstamped or invalid");
  }
  return { sourceSha, implementationSha256 };
}

function assertJobRuntimeIdentity(
  job: V5ResearchJobRow,
  identity: V5RuntimeIdentity,
): JsonObject {
  if (job.revision !== V5_REVISION) {
    throw new Error("V5 job revision does not match the current runtime");
  }
  const config = jobConfig(job);
  if (String(config.source_sha || "").trim().toLowerCase() !== identity.sourceSha) {
    throw new Error("V5 job source SHA does not match the current runtime");
  }
  if (
    String(config.implementation_sha256 || "").trim().toLowerCase() !==
      identity.implementationSha256
  ) {
    throw new Error("V5 job implementation SHA-256 does not match the current runtime");
  }
  return config;
}

function asNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite`);
  return parsed;
}

function universeFromJob(job: V5ResearchJobRow): UniverseMarket[] {
  const config = jobConfig(job);
  const universe = config.universe;
  if (!Array.isArray(universe) || universe.length !== job.total_markets) {
    throw new Error("V5 job universe is missing or does not match total_markets");
  }
  return universe.map((value, index) => {
    const row = object(value, `job.config.universe[${index}]`);
    const symbol = String(row.symbol || "").trim();
    const quoteAsset = String(row.quoteAsset || "").trim();
    const marginAsset = String(row.marginAsset || "").trim();
    const onboardDate = row.onboardDate === null || row.onboardDate === undefined
      ? null
      : finiteInteger(
        row.onboardDate,
        `universe[${index}].onboardDate`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    if (!symbol || !quoteAsset || !marginAsset) throw new Error(`invalid universe market ${index}`);
    return { symbol, quoteAsset, marginAsset, onboardDate };
  });
}

function gridGeometry(job: V5ResearchJobRow): {
  start: number;
  endInclusive: number;
  endExclusive: number;
  length: number;
} {
  const config = jobConfig(job);
  const start = asNumber(config.grid_start_ms, "grid_start_ms");
  const endInclusive = asNumber(config.grid_end_ms, "grid_end_ms");
  const endExclusive = asNumber(config.window_end_exclusive_ms, "window_end_exclusive_ms");
  const length = finiteInteger(config.grid_length, "grid_length", 1, 100_000);
  if (
    start % BAR_MS !== 0 || endInclusive % BAR_MS !== 0 || endExclusive % BAR_MS !== 0 ||
    endInclusive !== endExclusive - BAR_MS || length !== (endExclusive - start) / BAR_MS ||
    length !== V5_FOLD_POLICY.lookbackDays * DAY_MS / BAR_MS
  ) throw new Error("V5 job grid geometry is invalid");
  return { start, endInclusive, endExclusive, length };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeFloat32(values: readonly number[]): string {
  const encoded = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) encoded[index] = values[index];
  return bytesToBase64(new Uint8Array(encoded.buffer));
}

export function decodeFloat32(value: string, expectedLength: number): Float32Array {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    throw new Error("compact Float32 expected length must be a non-negative safe integer");
  }
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== expectedLength * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `compact Float32 length mismatch: ${bytes.byteLength} bytes, expected ${
        expectedLength * Float32Array.BYTES_PER_ELEMENT
      }`,
    );
  }
  const copy = bytes.slice();
  const decoded = new Float32Array(copy.buffer, copy.byteOffset, expectedLength);
  for (let index = 0; index < decoded.length; index++) {
    if (!Number.isFinite(decoded[index])) {
      throw new Error(`compact Float32 value ${index} must be finite`);
    }
  }
  return decoded;
}

function assertCompactNumericBounds(
  value: number,
  bounds: CompactNumericBounds,
  label: string,
): void {
  if (
    value < bounds.minimum || value > bounds.maximum ||
    (bounds.integer === true && !Number.isInteger(value))
  ) {
    throw new Error(
      `${label} is outside its safe range [${bounds.minimum}, ${bounds.maximum}]`,
    );
  }
}

function regimeCode(regime: StructuralRegime): string {
  if (regime === "BULL") return "B";
  if (regime === "RANGE") return "R";
  if (regime === "BEAR") return "S";
  return "U";
}

function regimeFromCode(code: string): StructuralRegime {
  if (code === "B") return "BULL";
  if (code === "R") return "RANGE";
  if (code === "S") return "BEAR";
  if (code === "U") return "UNKNOWN";
  throw new Error(`unsupported compact structural regime code ${code}`);
}

export async function packStructuralSeries(
  points: readonly StructuralPoint[],
  localBreadth30: readonly number[],
  localBreadthVelocity30: readonly number[],
  gridStartMs: number,
  registryHash: string,
): Promise<CompactStructuralSeries> {
  if (
    points.length !== localBreadth30.length || points.length !== localBreadthVelocity30.length
  ) throw new Error("compact structural inputs must be aligned");
  const flattened = new Float32Array(points.length * STRUCTURAL_FEATURES.length);
  for (let index = 0; index < points.length; index++) {
    if (points[index].time !== gridStartMs + index * BAR_MS) {
      throw new Error(`structural point ${index} is not aligned to the V5 grid`);
    }
    for (let feature = 0; feature < STRUCTURAL_FEATURES.length; feature++) {
      flattened[index * STRUCTURAL_FEATURES.length + feature] = Number(
        points[index][STRUCTURAL_FEATURES[feature]],
      );
    }
  }
  const payload: CompactStructuralSeries = {
    schemaVersion: 1,
    gridStartMs,
    gridLength: points.length,
    featureOrder: [...STRUCTURAL_FEATURES],
    featuresF32Base64: bytesToBase64(new Uint8Array(flattened.buffer)),
    regimeCodes: points.map((point) => regimeCode(point.regime)).join(""),
    localBreadth30F32Base64: encodeFloat32(localBreadth30),
    localBreadthVelocity30F32Base64: encodeFloat32(localBreadthVelocity30),
    registryHash,
  };
  return payload;
}

export function unpackStructuralSeries(series: CompactStructuralSeries): {
  points: StructuralPoint[];
  localBreadth30: Float32Array;
  localBreadthVelocity30: Float32Array;
} {
  if (
    series?.schemaVersion !== 1 || !Number.isSafeInteger(series.gridStartMs) ||
    !Number.isSafeInteger(series.gridLength) || series.gridLength < 0 ||
    typeof series.regimeCodes !== "string" || !/^[BRSU]*$/.test(series.regimeCodes) ||
    series.featureOrder?.join("\u0000") !==
      STRUCTURAL_FEATURES.join("\u0000") ||
    series.regimeCodes.length !== series.gridLength
  ) throw new Error("unsupported or malformed compact structural series");
  const flat = decodeFloat32(
    series.featuresF32Base64,
    series.gridLength * STRUCTURAL_FEATURES.length,
  );
  const points: StructuralPoint[] = [];
  for (let index = 0; index < series.gridLength; index++) {
    const numeric: Record<string, number> = {};
    for (let feature = 0; feature < STRUCTURAL_FEATURES.length; feature++) {
      const featureName = STRUCTURAL_FEATURES[feature];
      const value = flat[index * STRUCTURAL_FEATURES.length + feature];
      assertCompactNumericBounds(
        value,
        COMPACT_STRUCTURAL_FEATURE_BOUNDS[featureName],
        `compact structural feature ${featureName}[${index}]`,
      );
      numeric[featureName] = value;
    }
    points.push({
      time: series.gridStartMs + index * BAR_MS,
      regime: regimeFromCode(series.regimeCodes[index]),
      ...(numeric as Omit<StructuralPoint, "time" | "regime">),
    });
  }
  const localBreadth30 = decodeFloat32(
    series.localBreadth30F32Base64,
    series.gridLength,
  );
  const localBreadthVelocity30 = decodeFloat32(
    series.localBreadthVelocity30F32Base64,
    series.gridLength,
  );
  for (let index = 0; index < series.gridLength; index++) {
    assertCompactNumericBounds(
      localBreadth30[index],
      COMPACT_SHARE_BOUNDS,
      `compact local breadth 30m[${index}]`,
    );
    // Local breadth velocity is the difference of two values in [0, 1].
    assertCompactNumericBounds(
      localBreadthVelocity30[index],
      COMPACT_LOCAL_BREADTH_VELOCITY_BOUNDS,
      `compact local breadth velocity 30m[${index}]`,
    );
  }
  return {
    points,
    localBreadth30,
    localBreadthVelocity30,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function assignedToShard<T>(
  values: readonly T[],
  shardIndex: number,
  shardCount: number,
): T[] {
  finiteInteger(shardCount, "shardCount", 1, 10_000);
  finiteInteger(shardIndex, "shardIndex", 0, shardCount - 1);
  return values.filter((_, index) => index % shardCount === shardIndex);
}

function structuralPartialKey(chunk: number): string {
  return `${V5_REVISION}::STRUCTURAL_PARTIAL::CHUNK_${String(chunk).padStart(2, "0")}`;
}

function breadthShardMarket(shard: number): string {
  return `__V5_STRUCTURAL_SHARD_${String(shard).padStart(3, "0")}__`;
}

function structuralFinalizedChunkKey(): string {
  return `${V5_REVISION}::STRUCTURAL_FINALIZED_CHUNK`;
}

function structuralFinalizedChunkMarket(chunk: number): string {
  return `__V5_STRUCTURAL_FINALIZED_CHUNK_${String(chunk).padStart(2, "0")}__`;
}

function backtestCheckpointKey(): string {
  return `${V5_REVISION}::BACKTEST_CHECKPOINT`;
}

function backtestShardMarket(shard: number): string {
  return `__V5_BACKTEST_SHARD_${String(shard).padStart(3, "0")}__`;
}

function backtestRollupKey(): string {
  return `${V5_REVISION}::BACKTEST_ROLLUP`;
}

function backtestRollupMarket(rollup: number): string {
  return `__V5_BACKTEST_ROLLUP_${String(rollup).padStart(3, "0")}__`;
}

function sentinelResultRow(
  job: V5ResearchJobRow,
  market: string,
  configKey: string,
  family: string,
  bars: number,
  firstBarTime: number | null,
  lastBarTime: number | null,
  parameters: JsonObject,
  now: Date,
): JsonObject {
  return {
    job_id: job.id,
    revision: V5_REVISION,
    venue: "binance_futures",
    market,
    config_key: configKey,
    family,
    side: "BOTH",
    regime: "DYNAMIC",
    split: "TRAIN",
    bars,
    first_bar_at: firstBarTime === null ? null : new Date(firstBarTime).toISOString(),
    last_bar_at: lastBarTime === null ? null : new Date(lastBarTime).toISOString(),
    trades: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    gross_profit_bps: 0,
    gross_loss_bps: 0,
    net_bps: 0,
    stress_net_bps: 0,
    mean_net_bps: 0,
    median_net_bps: 0,
    profit_factor: null,
    max_drawdown_bps: 0,
    average_mfe_bps: 0,
    average_mae_bps: 0,
    average_hold_bars: 0,
    target_hits: 0,
    stop_hits: 0,
    time_exits: 0,
    parameters,
    updated_at: now.toISOString(),
  };
}

function candidateFamilyRegime(candidate: Candidate): Exclude<StructuralRegime, "UNKNOWN"> {
  if (candidate.family === "RANGE_CYCLE") return "RANGE";
  if (candidate.family === "BEAR_REBREAK") return "BEAR";
  return "BULL";
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function categorizeExitReasons(
  reasons: Readonly<Record<string, number>>,
  totalTrades: number,
): {
  targetHits: number;
  stopHits: number;
  timeExits: number;
  maxHoldExits: number;
  otherExits: number;
} {
  const targetHits = reasons.TARGET ?? 0;
  const stopHits = (reasons.STOP ?? 0) + (reasons.STOP_GAP ?? 0) +
    (reasons.TRAIL_CLOSE_EXIT ?? 0);
  // MAX_HOLD is a holding-horizon exit, not the BEAR fast TIME_STOP rule.
  const timeExits = reasons.TIME_STOP ?? 0;
  const maxHoldExits = reasons.MAX_HOLD ?? 0;
  const categorized = targetHits + stopHits + timeExits + maxHoldExits;
  if (categorized > totalTrades) {
    throw new Error("categorized exit counts exceed total trades");
  }
  return {
    targetHits,
    stopHits,
    timeExits,
    maxHoldExits,
    otherExits: totalTrades - categorized,
  };
}

function breakdown(trades: readonly V5Trade[]): V5MarketResultInput["breakdown"] {
  const net = trades.map((trade) => trade.netBps);
  const categorized = categorizeExitReasons(exitReasonCounts(trades), trades.length);
  return {
    grossProfitBps: net.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
    grossLossBps: Math.abs(
      net.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
    ),
    medianNetBps: median(net),
    targetHits: categorized.targetHits,
    stopHits: categorized.stopHits,
    timeExits: categorized.timeExits,
  };
}

function exitReasonCounts(trades: readonly V5Trade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of trades) counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1;
  return counts;
}

function tradeAggregate(
  candidate: Candidate,
  fold: FoldDefinition,
  split: V5Trade["split"],
  trades: readonly V5Trade[],
  eligibleBars: number,
  regimeBars: number,
  gridStart: number,
): ShardAggregate {
  const exitDeltas = new Map<number, number>();
  const timeChunks = new Array<number>(V5_TIME_CHUNKS).fill(0);
  let captureSum = 0;
  let captureCount = 0;
  for (const trade of trades) {
    const gridIndex = Math.round((trade.exitTime - gridStart) / BAR_MS);
    exitDeltas.set(gridIndex, (exitDeltas.get(gridIndex) ?? 0) + trade.netBps);
    const chunk = Math.max(
      0,
      Math.min(V5_TIME_CHUNKS - 1, Math.floor(gridIndex / V5_TIME_CHUNK_BARS)),
    );
    timeChunks[chunk] += trade.netBps;
    if (trade.mfeCapture !== null && Number.isFinite(trade.mfeCapture)) {
      captureSum += trade.mfeCapture;
      captureCount++;
    }
  }
  return {
    candidate: candidate.name,
    family: candidate.family,
    state: candidate.state,
    neighbor_group: candidate.neighborGroup,
    fold: fold.id,
    split,
    eligible_bars: eligibleBars,
    regime_bars: regimeBars,
    trades: trades.length,
    wins: trades.filter((trade) => trade.netBps > 0).length,
    gross_pnl_bps: trades.reduce((sum, trade) => sum + trade.grossBps, 0),
    net_pnl_bps: trades.reduce((sum, trade) => sum + trade.netBps, 0),
    stress_net_pnl_bps: trades.reduce((sum, trade) => sum + trade.stressNetBps, 0),
    net_profit_bps: trades.filter((trade) => trade.netBps > 0)
      .reduce((sum, trade) => sum + trade.netBps, 0),
    net_loss_bps: Math.abs(
      trades.filter((trade) => trade.netBps < 0)
        .reduce((sum, trade) => sum + trade.netBps, 0),
    ),
    mfe_sum_bps: trades.reduce((sum, trade) => sum + trade.mfeBps, 0),
    mae_sum_bps: trades.reduce((sum, trade) => sum + trade.maeBps, 0),
    capture_sum: captureSum,
    capture_count: captureCount,
    giveback_sum_bps: trades.reduce((sum, trade) => sum + trade.givebackBps, 0),
    hold_sum_bars: trades.reduce((sum, trade) => sum + trade.holdBars, 0),
    exit_reason_counts: exitReasonCounts(trades),
    signal_day_indices: [
      ...new Set(trades.map((trade) => Math.floor((trade.signalTime - gridStart) / DAY_MS))),
    ].sort((left, right) => left - right),
    exit_net_by_grid_index: [...exitDeltas.entries()].sort((left, right) => left[0] - right[0]),
    time_chunk_net_bps: timeChunks,
  };
}

function candidateResultRows(
  market: UniverseMarket,
  prepared: readonly PreparedBar[],
  structural: readonly StructuralPoint[],
  localBreadth: readonly number[],
  localBreadthVelocity: readonly number[],
  fiveMinute: readonly (FiveMinutePoint | null)[],
  folds: readonly FoldDefinition[],
  frozenCandidates: readonly Candidate[],
  registryHash: string,
  gridStart: number,
): MarketBacktestOutput {
  const rows: V5MarketResultInput[] = [];
  const aggregates: ShardAggregate[] = [];
  for (const candidate of frozenCandidates) {
    const expectedRegime = candidateFamilyRegime(candidate);
    for (const fold of folds) {
      const trades = simulateCandidate({
        market: market.symbol,
        bars: prepared,
        structural,
        localBreadth,
        localBreadthVelocity,
        fiveMinute,
        candidate,
        fold,
        baseCostBps: BASE_COST_BPS,
        stressCostBps: STRESS_COST_BPS,
      });
      for (const split of ["TRAIN", "VALIDATION", "TEST"] as const) {
        const splitTrades = trades.filter((trade) => trade.split === split);
        const eligible = prepared.reduce(
          (count, bar) => count + (splitForFold(bar.time, fold) === split ? 1 : 0),
          0,
        );
        const regimeBars = prepared.reduce(
          (count, bar, index) =>
            count + (splitForFold(bar.time, fold) === split &&
                structural[index].regime === expectedRegime
              ? 1
              : 0),
          0,
        );
        const splitBars = prepared.filter((bar) => splitForFold(bar.time, fold) === split);
        const summary = summarizeTrades(splitTrades, {
          eligibleBars: eligible,
          regimeBars,
        });
        const reasons = exitReasonCounts(splitTrades);
        const categorized = categorizeExitReasons(reasons, splitTrades.length);
        rows.push({
          market,
          candidate,
          fold: fold.id,
          split,
          bars: splitBars.length,
          firstBarTime: splitBars[0]?.time ?? null,
          lastBarTime: splitBars.at(-1)?.time ?? null,
          metrics: summary,
          breakdown: breakdown(splitTrades),
          parameters: {
            registry_revision: V5_CANDIDATE_REGISTRY_REVISION,
            registry_sha256: registryHash,
            five_minute_source: "BINANCE_ACTUAL_COMPLETED_5M_LAST_CHILD",
            local_breadth_source: "FULL_UNIVERSE_COMPLETED_30M_RETURN",
            base_cost_bps: BASE_COST_BPS,
            stress_cost_bps: STRESS_COST_BPS,
            exit_reason_counts: reasons,
            max_hold_count: categorized.maxHoldExits,
            other_exit_count: categorized.otherExits,
          },
        });
        aggregates.push(tradeAggregate(
          candidate,
          fold,
          split,
          splitTrades,
          eligible,
          regimeBars,
          gridStart,
        ));
      }
    }
  }
  return { rows, aggregates };
}

function aggregateKey(aggregate: Pick<ShardAggregate, "candidate" | "fold" | "split">): string {
  return `${aggregate.candidate}\u0000${aggregate.fold}\u0000${aggregate.split}`;
}

function seedAggregateMatrix(
  frozenCandidates: readonly Candidate[],
  folds: readonly FoldDefinition[],
  gridStart: number,
): Map<string, ShardAggregate> {
  const seeded = new Map<string, ShardAggregate>();
  for (const candidate of frozenCandidates) {
    for (const fold of folds) {
      for (const split of ["TRAIN", "VALIDATION", "TEST"] as const) {
        const empty = tradeAggregate(candidate, fold, split, [], 0, 0, gridStart);
        seeded.set(aggregateKey(empty), empty);
      }
    }
  }
  return seeded;
}

function assertAggregateMatrix(
  values: readonly ShardAggregate[],
  expected: ReadonlyMap<string, ShardAggregate>,
  label: string,
): void {
  if (values.length !== expected.size) {
    throw new Error(`${label} aggregate matrix ${values.length}/${expected.size}`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    const key = aggregateKey(value);
    const identity = expected.get(key);
    if (
      !identity || seen.has(key) || value.family !== identity.family ||
      value.state !== identity.state || value.neighbor_group !== identity.neighbor_group ||
      !Array.isArray(value.signal_day_indices) ||
      !Array.isArray(value.exit_net_by_grid_index) ||
      !Array.isArray(value.time_chunk_net_bps) ||
      value.time_chunk_net_bps.length !== V5_TIME_CHUNKS ||
      !value.exit_reason_counts || typeof value.exit_reason_counts !== "object"
    ) throw new Error(`${label} has malformed or duplicate aggregate ${key}`);
    seen.add(key);
  }
}

function mergeShardAggregate(
  target: Map<string, ShardAggregate>,
  incoming: ShardAggregate,
): void {
  const key = aggregateKey(incoming);
  const existing = target.get(key);
  if (!existing) {
    target.set(key, structuredClone(incoming));
    return;
  }
  const numericKeys = [
    "eligible_bars",
    "regime_bars",
    "trades",
    "wins",
    "gross_pnl_bps",
    "net_pnl_bps",
    "stress_net_pnl_bps",
    "net_profit_bps",
    "net_loss_bps",
    "mfe_sum_bps",
    "mae_sum_bps",
    "capture_sum",
    "capture_count",
    "giveback_sum_bps",
    "hold_sum_bars",
  ] as const;
  for (const field of numericKeys) existing[field] += incoming[field];
  for (const [reason, count] of Object.entries(incoming.exit_reason_counts)) {
    existing.exit_reason_counts[reason] = (existing.exit_reason_counts[reason] ?? 0) + count;
  }
  existing.signal_day_indices = [
    ...new Set([
      ...existing.signal_day_indices,
      ...incoming.signal_day_indices,
    ]),
  ].sort((left, right) => left - right);
  const exits = new Map(existing.exit_net_by_grid_index);
  for (const [index, delta] of incoming.exit_net_by_grid_index) {
    exits.set(index, (exits.get(index) ?? 0) + delta);
  }
  existing.exit_net_by_grid_index = [...exits.entries()].sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < V5_TIME_CHUNKS; index++) {
    existing.time_chunk_net_bps[index] += incoming.time_chunk_net_bps[index] ?? 0;
  }
}

function equalNotionalSignalMaxDrawdown(exitDeltas: readonly [number, number][]): number {
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const [, delta] of [...exitDeltas].sort((left, right) => left[0] - right[0])) {
    equity += delta;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak - equity);
  }
  return maximumDrawdown;
}

function fullMarketMetric(aggregate: ShardAggregate): JsonObject {
  const count = aggregate.trades;
  const categorized = categorizeExitReasons(aggregate.exit_reason_counts, count);
  const positiveChunks = aggregate.time_chunk_net_bps.map((value) => Math.max(0, value));
  const positiveChunkTotal = positiveChunks.reduce((sum, value) => sum + value, 0);
  const topPositiveChunkShare = positiveChunkTotal > 0
    ? Math.max(...positiveChunks) / positiveChunkTotal
    : 0;
  return {
    candidate: aggregate.candidate,
    family: aggregate.family,
    state: aggregate.state,
    neighbor_group: aggregate.neighbor_group,
    fold: aggregate.fold,
    split: aggregate.split,
    trades: count,
    wins: aggregate.wins,
    losses: count - aggregate.wins,
    win_rate: count ? aggregate.wins / count : 0,
    gross_pnl_bps: aggregate.gross_pnl_bps,
    net_pnl_bps: aggregate.net_pnl_bps,
    stress_net_pnl_bps: aggregate.stress_net_pnl_bps,
    profit_factor: aggregate.net_loss_bps > 0
      ? aggregate.net_profit_bps / aggregate.net_loss_bps
      : null,
    average_return_bps: count ? aggregate.net_pnl_bps / count : 0,
    equal_notional_signal_mdd_bps: equalNotionalSignalMaxDrawdown(
      aggregate.exit_net_by_grid_index,
    ),
    allocation_assumption: "EQUAL_NOTIONAL_PER_SIGNAL_NO_CAPITAL_OR_CONCURRENCY_CAP",
    average_mfe_bps: count ? aggregate.mfe_sum_bps / count : 0,
    average_mae_bps: count ? aggregate.mae_sum_bps / count : 0,
    mfe_capture_ratio: aggregate.capture_count
      ? aggregate.capture_sum / aggregate.capture_count
      : null,
    profit_giveback_bps: count ? aggregate.giveback_sum_bps / count : 0,
    average_hold_bars: count ? aggregate.hold_sum_bars / count : 0,
    stop_hit_rate: count ? categorized.stopHits / count : 0,
    target_hit_rate: count ? categorized.targetHits / count : 0,
    time_stop_rate: count ? categorized.timeExits / count : 0,
    max_hold_count: categorized.maxHoldExits,
    other_exit_count: categorized.otherExits,
    unique_signal_days: aggregate.signal_day_indices.length,
    unique_exit_bars: aggregate.exit_net_by_grid_index.length,
    exit_reason_counts: aggregate.exit_reason_counts,
    regime_frequency: aggregate.eligible_bars ? aggregate.regime_bars / aggregate.eligible_bars : 0,
    time_chunk_net_bps: aggregate.time_chunk_net_bps,
    profitable_time_chunks: aggregate.time_chunk_net_bps.filter((value) => value > 0).length,
    top_positive_time_chunk_share: topPositiveChunkShare,
    concentration_pass: positiveChunkTotal <= 0 ||
      (topPositiveChunkShare <= V5_PRODUCTION_REVIEW_RISK_GATE.maximumPositiveTimeChunkShare &&
        aggregate.time_chunk_net_bps.filter((value) => value > 0).length >=
          V5_PRODUCTION_REVIEW_RISK_GATE.minimumProfitableTimeChunks),
  };
}

interface PostSelectionGate {
  pass: boolean;
  failures: string[];
}

export function applyProductionReviewGates(
  reports: readonly CandidateValidationReport[],
  concentrationByCandidate: ReadonlyMap<string, boolean>,
  riskQualityByCandidate: ReadonlyMap<string, PostSelectionGate>,
  occurrenceByCandidate: ReadonlyMap<string, PostSelectionGate>,
): ProductionReviewReport[] {
  return reports.map((report) => {
    const concentrationPass = concentrationByCandidate.get(report.candidate) ?? false;
    const riskQuality = riskQualityByCandidate.get(report.candidate) ?? {
      pass: false,
      failures: ["RISK_QUALITY_METRICS_MISSING"],
    };
    const occurrence = occurrenceByCandidate.get(report.candidate) ?? {
      pass: false,
      failures: ["UNIQUE_OCCURRENCE_METRICS_MISSING"],
    };
    return {
      ...report,
      concentrationPass,
      riskQualityPass: riskQuality.pass,
      riskQualityFailures: riskQuality.failures,
      uniqueOccurrencePass: occurrence.pass,
      uniqueOccurrenceFailures: occurrence.failures,
      productionReviewEligible: report.productionReviewEligible && concentrationPass &&
        riskQuality.pass && occurrence.pass,
      testUsedForSelection: false,
    } as ProductionReviewReport;
  });
}

function assertContinuousBars(bars: readonly Bar[], intervalMs: number, market: string): void {
  for (let index = 1; index < bars.length; index++) {
    if (bars[index].time !== bars[index - 1].time + intervalMs) {
      throw new Error(`${market} has a ${intervalMs / 60_000}m kline gap at ${bars[index].time}`);
    }
  }
}

/** Builds only true 5m features; no 15m proxy or future child is accepted. */
export function buildFiveMinutePointMap(bars: readonly Bar[]): Map<number, FiveMinutePoint> {
  assertContinuousBars(bars, FIVE_MINUTE_MS, "5m series");
  const output = new Map<number, FiveMinutePoint>();
  if (!bars.length) return output;
  const closes = bars.map((bar) => bar.close);
  const alpha = 2 / 21;
  const ema = new Array<number>(bars.length);
  const rsi = new Array<number>(bars.length).fill(50);
  const atr = new Array<number>(bars.length);
  ema[0] = closes[0];
  atr[0] = bars[0].high - bars[0].low;
  let averageGain = 0;
  let averageLoss = 0;
  let priorVolumeSum = 0;
  const priorVolumes: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let index = 0; index < bars.length; index++) {
    const current = bars[index];
    if (index > 0) {
      ema[index] = alpha * current.close + (1 - alpha) * ema[index - 1];
      const trueRange = Math.max(
        current.high - current.low,
        Math.abs(current.high - bars[index - 1].close),
        Math.abs(current.low - bars[index - 1].close),
      );
      atr[index] = (atr[index - 1] * 13 + trueRange) / 14;
      const change = current.close - bars[index - 1].close;
      gains.push(Math.max(0, change));
      losses.push(Math.max(0, -change));
      if (gains.length <= 14) {
        averageGain = gains.reduce((sum, value) => sum + value, 0) / gains.length;
        averageLoss = losses.reduce((sum, value) => sum + value, 0) / losses.length;
      } else {
        averageGain = (averageGain * 13 + gains.at(-1)!) / 14;
        averageLoss = (averageLoss * 13 + losses.at(-1)!) / 14;
      }
      rsi[index] = averageLoss === 0
        ? (averageGain > 0 ? 100 : 50)
        : 100 - 100 / (1 + averageGain / averageLoss);
    }

    const volumeMean = priorVolumes.length ? priorVolumeSum / priorVolumes.length : current.volume;
    const volumeRatio = volumeMean > 0 ? current.volume / volumeMean : 0;
    priorVolumes.push(Math.max(0, current.volume));
    priorVolumeSum += Math.max(0, current.volume);
    if (priorVolumes.length > 20) priorVolumeSum -= priorVolumes.shift()!;

    const stochStart = Math.max(0, index - 13);
    let high14 = -Infinity;
    let low14 = Infinity;
    for (let cursor = stochStart; cursor <= index; cursor++) {
      high14 = Math.max(high14, bars[cursor].high);
      low14 = Math.min(low14, bars[cursor].low);
    }
    const stochK = high14 > low14 ? 100 * (current.close - low14) / (high14 - low14) : 50;
    let stochSum = 0;
    let stochCount = 0;
    for (let cursor = Math.max(0, index - 2); cursor <= index; cursor++) {
      let high = -Infinity;
      let low = Infinity;
      for (let lookback = Math.max(0, cursor - 13); lookback <= cursor; lookback++) {
        high = Math.max(high, bars[lookback].high);
        low = Math.min(low, bars[lookback].low);
      }
      stochSum += high > low ? 100 * (bars[cursor].close - low) / (high - low) : 50;
      stochCount++;
    }

    if (index < FIVE_MINUTE_WARMUP_BARS) continue;
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let cursor = index - 8; cursor < index; cursor++) {
      priorHigh = Math.max(priorHigh, bars[cursor].high);
      priorLow = Math.min(priorLow, bars[cursor].low);
    }
    output.set(current.time, {
      time: current.time,
      ret3Atr: atr[index] > 0 ? (current.close - bars[index - 3].close) / atr[index] : 0,
      rsiSlope: rsi[index] - rsi[index - 2],
      stochK,
      stochD: stochSum / stochCount,
      ema20SlopeAtr: atr[index] > 0 ? (ema[index] - ema[index - 4]) / atr[index] : 0,
      volumeRatio,
      breakout: current.close > priorHigh,
      rebreak: current.close < priorLow,
    });
  }
  return output;
}

function trendPersistence(prepared: readonly PreparedBar[]): number[] {
  const output = new Array<number>(prepared.length).fill(0);
  const queue: number[] = [];
  let sum = 0;
  for (let index = 0; index < prepared.length; index++) {
    const bar = prepared[index];
    const direction = bar.close > bar.ema20 && bar.ema20SlopeAtr > 0
      ? 1
      : bar.close < bar.ema20 && bar.ema20SlopeAtr < 0
      ? -1
      : 0;
    queue.push(direction);
    sum += direction;
    if (queue.length > 24) sum -= queue.shift()!;
    output[index] = sum / queue.length;
  }
  return output;
}

/** Causal 24h frequency with which completed bars move closer to VWAP/day-open anchors. */
function meanReversionFrequency(prepared: readonly PreparedBar[]): number[] {
  const output = new Array<number>(prepared.length).fill(0);
  const events: number[] = [];
  let eventSum = 0;
  for (let index = 0; index < prepared.length; index++) {
    const currentDistance = Math.min(
      Math.abs(prepared[index].vwapDeviationAtr),
      Math.abs(prepared[index].dayOpenDeviationAtr),
    );
    const priorDistance = index > 0
      ? Math.min(
        Math.abs(prepared[index - 1].vwapDeviationAtr),
        Math.abs(prepared[index - 1].dayOpenDeviationAtr),
      )
      : currentDistance;
    const event = index > 0 && priorDistance >= 0.25 && currentDistance < priorDistance ? 1 : 0;
    events.push(event);
    eventSum += event;
    if (events.length > 96) eventSum -= events.shift()!;
    output[index] = eventSum / Math.max(1, events.length);
  }
  return output;
}

function structuralObservation(
  market: UniverseMarket,
  prepared: readonly PreparedBar[],
  index: number,
  adxRanks: readonly number[],
  persistence: readonly number[],
  reversionFrequency: readonly number[],
): StructuralMarketObservation | null {
  const bar = prepared[index];
  if (!Number.isFinite(bar.ret6h) || !Number.isFinite(bar.ret24h) || !(bar.atr > 0)) return null;
  const separationAtr = Math.abs(bar.ema20 - bar.ema50) / bar.atr;
  const emaStructure = separationAtr <= 0.10 ? "FLAT" : bar.ema20 > bar.ema50 ? "BULL" : "BEAR";
  return {
    time: bar.time,
    symbol: market.symbol,
    return6h: bar.ret6h,
    return24h: bar.ret24h,
    emaStructure,
    trendPersistence: persistence[index],
    adxPercentile: adxRanks[index],
    meanReverting: reversionFrequency[index] >= 0.35,
    volatilityPercentile: bar.atrPercentile7d,
    extremeMover: Math.abs(bar.ret24h) >= 0.20,
  };
}

export async function startV5(
  body: JsonObject = {},
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  for (const prohibited of ["job_id", "jobId", "id", "revision"]) {
    if (prohibited in body) throw new Error("start_v5 always creates a new immutable V5 job");
  }
  if (
    body.lookback_days !== undefined && Number(body.lookback_days) !== V5_FOLD_POLICY.lookbackDays
  ) {
    throw new Error(`start_v5 lookback_days is frozen at ${V5_FOLD_POLICY.lookbackDays}`);
  }
  const deps = dependencies(overrides);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const sourceSha = String(body.source_sha || "").trim().toLowerCase();
  const implementationSha256 = String(body.implementation_sha256 || "").trim().toLowerCase();
  if (sourceSha !== runtimeIdentity.sourceSha) {
    throw new Error("start_v5 source_sha does not match the stamped runtime");
  }
  if (implementationSha256 !== runtimeIdentity.implementationSha256) {
    throw new Error("start_v5 implementation_sha256 does not match the stamped runtime");
  }
  const markets = await deps.listMarkets();
  if (markets.length < V5_MINIMUM_ACTIVE_MARKETS) {
    throw new Error(
      `full Binance USDⓈ-M active perpetual universe unexpectedly small: ${markets.length}`,
    );
  }
  if (markets.length > V5_BACKTEST_SHARDS) {
    throw new Error(
      `full Binance USDⓈ-M active perpetual universe ${markets.length} exceeds ` +
        `${V5_BACKTEST_SHARDS} one-market backtest shards`,
    );
  }
  const nowMs = deps.now().getTime();
  const futureOnboard = markets.find((market) =>
    market.onboardDate !== null && market.onboardDate > nowMs
  );
  if (futureOnboard) {
    throw new Error(
      `${futureOnboard.symbol} onboardDate is after the start_v5 observation time`,
    );
  }
  const endExclusive = Math.floor(nowMs / BAR_MS) * BAR_MS;
  const start = endExclusive - V5_FOLD_POLICY.lookbackDays * DAY_MS;
  const endInclusive = endExclusive - BAR_MS;
  const folds = buildRollingFolds(start, endExclusive);
  const frozenCandidates = candidates();
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const gridLength = (endExclusive - start) / BAR_MS;
  const job = await deps.createJob({
    markets,
    windowStart: start,
    windowEnd: endInclusive,
    lookbackDays: V5_FOLD_POLICY.lookbackDays,
    config: {
      grid_start_ms: start,
      grid_end_ms: endInclusive,
      window_end_exclusive_ms: endExclusive,
      grid_length: gridLength,
      breadth_shard_count: V5_BREADTH_SHARDS,
      breadth_time_chunk_bars: V5_TIME_CHUNK_BARS,
      breadth_time_chunks: V5_TIME_CHUNKS,
      structural_finalize_chunk_count: V5_TIME_CHUNKS,
      backtest_shard_count: V5_BACKTEST_SHARDS,
      backtest_rollup_shard_count: V5_BACKTEST_ROLLUP_SHARDS,
      checkpoints_per_rollup: V5_CHECKPOINTS_PER_ROLLUP,
      base_cost_bps: BASE_COST_BPS,
      stress_cost_bps: STRESS_COST_BPS,
      folds,
      fold_policy: V5_FOLD_POLICY,
      candidate_registry_revision: V5_CANDIDATE_REGISTRY_REVISION,
      candidate_registry_sha256: registryHash,
      source_sha: sourceSha,
      implementation_sha256: implementationSha256,
      candidate_names: frozenCandidates.map((candidate) => candidate.name),
      candidate_count: frozenCandidates.length,
      production_review_risk_gate: V5_PRODUCTION_REVIEW_RISK_GATE,
      universe_policy: "CURRENT_ACTIVE_PERPETUAL_SNAPSHOT_AT_JOB_START",
      universe_snapshot_at: new Date(nowMs).toISOString(),
      includes_historically_delisted_contracts: false,
      research_only: true,
      production_connected: false,
      source: "BINANCE_USDM_ACTIVE_PERPETUAL_FULL_UNIVERSE_ACTUAL_15M_AND_5M",
    },
    initialMetrics: {
      phase: "STRUCTURAL_BREADTH_V5",
      expected_breadth_partial_rows: V5_BREADTH_SHARDS * V5_TIME_CHUNKS,
      expected_finalized_chunk_rows: V5_TIME_CHUNKS,
      expected_result_rows: markets.length * frozenCandidates.length * folds.length * 3,
      test_used_for_selection: false,
    },
  }, deps.repositoryOptions);
  return {
    ok: true,
    action: "start_v5",
    revision: V5_REVISION,
    source_sha: sourceSha,
    implementation_sha256: implementationSha256,
    job_id: job.id,
    total_markets: markets.length,
    lookback_days: V5_FOLD_POLICY.lookbackDays,
    grid_length: gridLength,
    folds: folds.length,
    candidates: frozenCandidates.length,
    breadth_shards: V5_BREADTH_SHARDS,
    breadth_time_chunks: V5_TIME_CHUNKS,
    structural_finalize_chunks: V5_TIME_CHUNKS,
    backtest_shards: V5_BACKTEST_SHARDS,
    backtest_rollup_shards: V5_BACKTEST_ROLLUP_SHARDS,
    checkpoints_per_rollup: V5_CHECKPOINTS_PER_ROLLUP,
    universe_policy: "CURRENT_ACTIVE_PERPETUAL_SNAPSHOT_AT_JOB_START",
    includes_historically_delisted_contracts: false,
    research_only: true,
  };
}

export async function breadthShardV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  assertStructuralFinalizationPhase(job, "breadth_shard_v5");
  const expectedShardCount = finiteInteger(
    config.breadth_shard_count,
    "breadth_shard_count",
    1,
    1_000,
  );
  const shardCount = finiteInteger(
    body.shard_count ?? expectedShardCount,
    "shard_count",
    1,
    1_000,
  );
  if (shardCount !== expectedShardCount || shardCount !== V5_BREADTH_SHARDS) {
    throw new Error(`breadth_shard_v5 requires exactly ${V5_BREADTH_SHARDS} shards`);
  }
  const shard = finiteInteger(body.shard_index, "shard_index", 0, shardCount - 1);
  const universe = universeFromJob(job);
  const assigned = assignedToShard(universe, shard, shardCount);
  const geometry = gridGeometry(job);
  const accumulators = Array.from(
    { length: geometry.length },
    (_, index) => createStructuralAccumulator(geometry.start + index * BAR_MS, 0),
  );
  const localValid30 = new Array<number>(geometry.length).fill(0);
  const localPositive30 = new Array<number>(geometry.length).fill(0);

  for (const market of assigned) {
    const firstExpected = market.onboardDate === null
      ? 0
      : Math.max(0, Math.ceil((market.onboardDate - geometry.start) / BAR_MS));
    for (let index = firstExpected; index < geometry.length; index++) {
      accumulators[index].expectedMarkets += 1;
    }
  }

  const successful: string[] = [];
  const failed: Array<{ market: string; error: string }> = [];
  await mapConcurrent(assigned, BREADTH_CONCURRENCY, async (market) => {
    try {
      const bars = await deps.fetch15m(market, {
        startTime: geometry.start,
        endTime: geometry.endInclusive,
        asOfTime: geometry.endExclusive,
        lookbackDays: V5_FOLD_POLICY.lookbackDays,
      });
      assertExpectedClosedBarCoverage(
        bars,
        BAR_MS,
        geometry.start,
        geometry.endInclusive,
        market.onboardDate,
        market.symbol,
      );
      const prepared = prepareBars(bars);
      const adxRanks = rollingPercentileRanks(prepared.map((bar) => bar.adx));
      const persistence = trendPersistence(prepared);
      const reversionFrequency = meanReversionFrequency(prepared);
      for (let index = 0; index < prepared.length; index++) {
        const bar = prepared[index];
        const gridIndex = (bar.time - geometry.start) / BAR_MS;
        if (!Number.isInteger(gridIndex) || gridIndex < 0 || gridIndex >= geometry.length) continue;
        if (Number.isFinite(bar.ret2)) {
          localValid30[gridIndex] += 1;
          if (bar.ret2 > 0) localPositive30[gridIndex] += 1;
        }
        const observation = structuralObservation(
          market,
          prepared,
          index,
          adxRanks,
          persistence,
          reversionFrequency,
        );
        if (observation) accumulateStructuralObservation(accumulators[gridIndex], observation);
      }
      successful.push(market.symbol);
    } catch (error) {
      failed.push({
        market: market.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  successful.sort();
  failed.sort((left, right) => left.market.localeCompare(right.market));

  for (let chunk = 0; chunk < V5_TIME_CHUNKS; chunk++) {
    const offset = chunk * V5_TIME_CHUNK_BARS;
    const count = Math.min(V5_TIME_CHUNK_BARS, geometry.length - offset);
    const params: StructuralPartialParameters = {
      schema_version: 1,
      router_revision: V5_REVISION,
      shard_index: shard,
      shard_count: shardCount,
      chunk_index: chunk,
      chunk_start_index: offset,
      chunk_bars: count,
      assigned_markets: assigned.map((market) => market.symbol),
      successful_markets: successful,
      failed_markets: failed,
      accumulators: accumulators.slice(offset, offset + count),
      local_valid_30: localValid30.slice(offset, offset + count),
      local_positive_30: localPositive30.slice(offset, offset + count),
      generated_at: deps.now().toISOString(),
    };
    await deps.rawStore.upsert(sentinelResultRow(
      job,
      breadthShardMarket(shard),
      structuralPartialKey(chunk),
      "STRUCTURAL_PARTIAL_V5",
      count,
      geometry.start + offset * BAR_MS,
      geometry.start + (offset + count - 1) * BAR_MS,
      params as unknown as JsonObject,
      deps.now(),
    ));
  }
  return {
    ok: failed.length === 0,
    action: "breadth_shard_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    shard_index: shard,
    shard_count: shardCount,
    assigned_markets: assigned.length,
    successful_markets: successful.length,
    failed_markets: failed,
    partial_rows: V5_TIME_CHUNKS,
  };
}

function parsePartial(value: unknown, expectedChunk: number): StructuralPartialParameters {
  const params = object(
    value,
    "structural partial parameters",
  ) as unknown as StructuralPartialParameters;
  if (
    params.schema_version !== 1 || params.router_revision !== V5_REVISION ||
    params.chunk_index !== expectedChunk || params.shard_count !== V5_BREADTH_SHARDS ||
    !Array.isArray(params.assigned_markets) || !Array.isArray(params.successful_markets) ||
    !Array.isArray(params.failed_markets) ||
    !Array.isArray(params.accumulators) || !Array.isArray(params.local_valid_30) ||
    !Array.isArray(params.local_positive_30) || params.accumulators.length !== params.chunk_bars ||
    params.local_valid_30.length !== params.chunk_bars ||
    params.local_positive_30.length !== params.chunk_bars
  ) throw new Error(`malformed V5 structural partial for chunk ${expectedChunk}`);
  return params;
}

function structuralChunkGeometry(
  geometry: ReturnType<typeof gridGeometry>,
  chunk: number,
): { startIndex: number; bars: number; firstTime: number; lastTime: number } {
  const startIndex = chunk * V5_TIME_CHUNK_BARS;
  const bars = Math.min(V5_TIME_CHUNK_BARS, geometry.length - startIndex);
  if (bars <= 0) throw new Error(`V5 structural chunk ${chunk} is outside the grid`);
  const firstTime = geometry.start + startIndex * BAR_MS;
  return {
    startIndex,
    bars,
    firstTime,
    lastTime: firstTime + (bars - 1) * BAR_MS,
  };
}

function assertStructuralFinalizationPhase(job: V5ResearchJobRow, action: string): void {
  const phase = jobMetrics(job).phase;
  if (
    phase !== "STRUCTURAL_BREADTH_V5" ||
    (job.status !== "PENDING" && job.status !== "RUNNING")
  ) {
    throw new Error(`${action} requires STRUCTURAL_BREADTH_V5 phase`);
  }
}

function assertBacktestWritePhase(job: V5ResearchJobRow, action: string): void {
  if (jobMetrics(job).phase !== "BACKTEST_V5" || job.status !== "RUNNING") {
    throw new Error(`${action} requires RUNNING BACKTEST_V5 phase`);
  }
}

type StructuralRegimeCounts = Record<StructuralRegime, number>;

function structuralRegimeCounts(points: readonly StructuralPoint[]): StructuralRegimeCounts {
  const counts: StructuralRegimeCounts = { BULL: 0, RANGE: 0, BEAR: 0, UNKNOWN: 0 };
  for (const point of points) counts[point.regime]++;
  return counts;
}

function assertStoredStructuralRegimeCounts(
  value: unknown,
  expected: StructuralRegimeCounts,
): void {
  const stored = object(value, "job.metrics.structural_regime_counts");
  const expectedKeys = ["BEAR", "BULL", "RANGE", "UNKNOWN"];
  if (JSON.stringify(Object.keys(stored).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("V5 stored structural regime-count schema is invalid");
  }
  for (const regime of expectedKeys as StructuralRegime[]) {
    if (!Number.isSafeInteger(stored[regime]) || stored[regime] !== expected[regime]) {
      throw new Error(`V5 stored structural regime count mismatch for ${regime}`);
    }
  }
}

function finalizedV5Response(
  job: V5ResearchJobRow,
  runtimeIdentity: V5RuntimeIdentity,
  compact: CompactStructuralSeries,
  regimeCounts: StructuralRegimeCounts,
  folds: readonly FoldDefinition[],
  finalizedChunkRows: number,
): JsonObject {
  return {
    ok: true,
    action: "finalize_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    structural_points: compact.gridLength,
    regime_counts: regimeCounts,
    folds: folds.length,
    compact_schema: compact.schemaVersion,
    finalized_chunk_rows: finalizedChunkRows,
    raw_accumulators_in_job_metrics: false,
  };
}

function structuralPartialCountQuery(jobId: string, chunk: number): string {
  return `job_id=eq.${encodeURIComponent(jobId)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(structuralPartialKey(chunk))}` +
    "&family=eq.STRUCTURAL_PARTIAL_V5&select=job_id";
}

function structuralFinalizedChunkCountQuery(jobId: string): string {
  return `job_id=eq.${encodeURIComponent(jobId)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(structuralFinalizedChunkKey())}` +
    "&family=eq.STRUCTURAL_FINALIZED_CHUNK_V5&select=job_id";
}

function assertLocalBreadthCounts(valid: unknown, positive: unknown, label: string): {
  valid: number;
  positive: number;
} {
  const validCount = Number(valid);
  const positiveCount = Number(positive);
  if (
    !Number.isSafeInteger(validCount) || !Number.isSafeInteger(positiveCount) || validCount < 0 ||
    positiveCount < 0 || positiveCount > validCount
  ) throw new Error(`${label} has malformed local 30m breadth counts`);
  return { valid: validCount, positive: positiveCount };
}

function parseFinalizedChunk(
  value: unknown,
  expectedChunk: number,
  expectedUniverseCount: number,
  expectedUniverseHash: string,
  geometry: ReturnType<typeof gridGeometry>,
): StructuralFinalizedChunkParameters {
  const paramsObject = object(value, "structural finalized chunk parameters");
  if ("accumulators" in paramsObject) {
    throw new Error(`V5 finalized structural chunk ${expectedChunk} contains raw accumulators`);
  }
  const params = paramsObject as unknown as StructuralFinalizedChunkParameters;
  const chunkGeometry = structuralChunkGeometry(geometry, expectedChunk);
  if (
    params.schema_version !== 1 || params.router_revision !== V5_REVISION ||
    params.chunk_index !== expectedChunk || params.chunk_count !== V5_TIME_CHUNKS ||
    params.chunk_start_index !== chunkGeometry.startIndex ||
    params.chunk_bars !== chunkGeometry.bars || params.first_time_ms !== chunkGeometry.firstTime ||
    params.last_time_ms !== chunkGeometry.lastTime ||
    params.breadth_shard_count !== V5_BREADTH_SHARDS ||
    params.source_partial_rows !== V5_BREADTH_SHARDS ||
    params.universe_count !== expectedUniverseCount ||
    params.universe_symbols_sha256 !== expectedUniverseHash ||
    !Array.isArray(params.snapshots) || params.snapshots.length !== chunkGeometry.bars ||
    !Array.isArray(params.local_breadth_30) ||
    params.local_breadth_30.length !== chunkGeometry.bars
  ) throw new Error(`malformed V5 finalized structural chunk ${expectedChunk}`);
  for (let offset = 0; offset < chunkGeometry.bars; offset++) {
    const snapshot = object(
      params.snapshots[offset],
      `finalized chunk ${expectedChunk} snapshot ${offset}`,
    );
    if (
      JSON.stringify(Object.keys(snapshot).sort()) !==
        JSON.stringify(SORTED_STRUCTURAL_SNAPSHOT_FIELDS)
    ) {
      throw new Error(
        `V5 finalized structural chunk ${expectedChunk} snapshot ${offset} schema mismatch`,
      );
    }
    const expectedTime = chunkGeometry.firstTime + offset * BAR_MS;
    if (snapshot.time !== expectedTime) {
      throw new Error(`V5 finalized structural chunk ${expectedChunk} snapshot order mismatch`);
    }
    for (const [field, value] of Object.entries(snapshot)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `V5 finalized structural chunk ${expectedChunk} snapshot ${offset}.${field} is invalid`,
        );
      }
    }
    const expectedMarkets = Number(snapshot.expectedMarkets);
    const validMarkets = Number(snapshot.validMarkets);
    const majorCoverage = Number(snapshot.majorCoverage);
    if (
      !Number.isSafeInteger(expectedMarkets) || expectedMarkets < 0 ||
      expectedMarkets > expectedUniverseCount ||
      !Number.isSafeInteger(validMarkets) || validMarkets < 0 ||
      validMarkets > expectedMarkets ||
      !Number.isSafeInteger(majorCoverage) || majorCoverage < 0 || majorCoverage > 3
    ) {
      throw new Error(
        `V5 finalized structural chunk ${expectedChunk} snapshot ${offset} coverage is invalid`,
      );
    }
    const localBreadth = params.local_breadth_30[offset];
    if (!Number.isFinite(localBreadth) || localBreadth < 0 || localBreadth > 1) {
      throw new Error(`V5 finalized structural chunk ${expectedChunk} local breadth is invalid`);
    }
  }
  return params;
}

export async function finalizeChunkV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  assertStructuralFinalizationPhase(job, "finalize_chunk_v5");
  const configuredChunkCount = finiteInteger(
    config.structural_finalize_chunk_count,
    "structural_finalize_chunk_count",
    1,
    1_000,
  );
  const chunkCount = finiteInteger(
    body.chunk_count ?? configuredChunkCount,
    "chunk_count",
    1,
    1_000,
  );
  if (
    configuredChunkCount !== V5_TIME_CHUNKS || chunkCount !== configuredChunkCount ||
    Number(config.breadth_time_chunks) !== V5_TIME_CHUNKS ||
    Number(config.breadth_time_chunk_bars) !== V5_TIME_CHUNK_BARS ||
    Number(config.breadth_shard_count) !== V5_BREADTH_SHARDS
  ) throw new Error(`finalize_chunk_v5 requires exactly ${V5_TIME_CHUNKS} chunks`);
  const chunk = finiteInteger(body.chunk_index, "chunk_index", 0, chunkCount - 1);
  const geometry = gridGeometry(job);
  const chunkGeometry = structuralChunkGeometry(geometry, chunk);
  const universe = universeFromJob(job);
  const partialRows = await deps.rawStore.exactCount(structuralPartialCountQuery(job.id, chunk));
  if (partialRows !== V5_BREADTH_SHARDS) {
    throw new Error(
      `V5 structural chunk ${chunk} partial rows ${partialRows}/${V5_BREADTH_SHARDS}`,
    );
  }

  const key = structuralPartialKey(chunk);
  const path = `${RESULT_TABLE}?job_id=eq.${encodeURIComponent(job.id)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(key)}` +
    "&family=eq.STRUCTURAL_PARTIAL_V5" +
    "&select=market,config_key,parameters&order=market.asc";
  const mergedAccumulators = Array.from(
    { length: chunkGeometry.bars },
    (_, offset) => createStructuralAccumulator(chunkGeometry.firstTime + offset * BAR_MS, 0),
  );
  const mergedValid30 = new Array<number>(chunkGeometry.bars).fill(0);
  const mergedPositive30 = new Array<number>(chunkGeometry.bars).fill(0);
  const seenShards = new Set<number>();
  const pageSize = 10;
  for (let pageOffset = 0; pageOffset < V5_BREADTH_SHARDS; pageOffset += pageSize) {
    const rows = await deps.rawStore.select(
      `${path}&limit=${pageSize}&offset=${pageOffset}`,
    ) as RawResultRow[];
    const expectedPageRows = Math.min(pageSize, V5_BREADTH_SHARDS - pageOffset);
    if (rows.length !== expectedPageRows) {
      throw new Error(
        `V5 structural chunk ${chunk} page ${pageOffset} incomplete ` +
          `${rows.length}/${expectedPageRows}`,
      );
    }
    const pageAccumulators = Array.from(
      { length: chunkGeometry.bars },
      (_, offset) => createStructuralAccumulator(chunkGeometry.firstTime + offset * BAR_MS, 0),
    );
    const pageValid30 = new Array<number>(chunkGeometry.bars).fill(0);
    const pagePositive30 = new Array<number>(chunkGeometry.bars).fill(0);
    for (const row of rows) {
      const partial = parsePartial(row.parameters, chunk);
      const shard = finiteInteger(
        partial.shard_index,
        "structural partial shard_index",
        0,
        V5_BREADTH_SHARDS - 1,
      );
      const expectedAssigned = assignedToShard(universe, shard, V5_BREADTH_SHARDS)
        .map((market) => market.symbol);
      if (
        seenShards.has(shard) || row.config_key !== key ||
        row.market !== breadthShardMarket(shard) ||
        partial.chunk_start_index !== chunkGeometry.startIndex ||
        partial.chunk_bars !== chunkGeometry.bars ||
        JSON.stringify(partial.assigned_markets) !== JSON.stringify(expectedAssigned) ||
        partial.failed_markets.length !== 0 ||
        JSON.stringify(partial.successful_markets) !== JSON.stringify(expectedAssigned)
      ) throw new Error(`V5 structural chunk ${chunk} shard ${shard} identity mismatch`);
      seenShards.add(shard);
      for (let offset = 0; offset < chunkGeometry.bars; offset++) {
        pageAccumulators[offset] = mergeStructuralAccumulators(
          pageAccumulators[offset],
          partial.accumulators[offset],
        );
        const local = assertLocalBreadthCounts(
          partial.local_valid_30[offset],
          partial.local_positive_30[offset],
          `V5 structural chunk ${chunk} shard ${shard} offset ${offset}`,
        );
        pageValid30[offset] += local.valid;
        pagePositive30[offset] += local.positive;
      }
    }
    for (let offset = 0; offset < chunkGeometry.bars; offset++) {
      mergedAccumulators[offset] = mergeStructuralAccumulators(
        mergedAccumulators[offset],
        pageAccumulators[offset],
      );
      mergedValid30[offset] += pageValid30[offset];
      mergedPositive30[offset] += pagePositive30[offset];
    }
  }
  if (seenShards.size !== V5_BREADTH_SHARDS) {
    throw new Error(`V5 structural chunk ${chunk} has incomplete shard identity`);
  }
  const snapshots = mergedAccumulators.map((accumulator) =>
    finalizeStructuralAccumulator(accumulator)
  );
  const localBreadth30 = mergedValid30.map((valid, offset) =>
    valid > 0 ? mergedPositive30[offset] / valid : 0.5
  );
  const universeHash = await sha256(JSON.stringify(universe.map((market) => market.symbol)));
  const params: StructuralFinalizedChunkParameters = {
    schema_version: 1,
    router_revision: V5_REVISION,
    chunk_index: chunk,
    chunk_count: chunkCount,
    chunk_start_index: chunkGeometry.startIndex,
    chunk_bars: chunkGeometry.bars,
    first_time_ms: chunkGeometry.firstTime,
    last_time_ms: chunkGeometry.lastTime,
    breadth_shard_count: V5_BREADTH_SHARDS,
    source_partial_rows: partialRows,
    universe_count: universe.length,
    universe_symbols_sha256: universeHash,
    snapshots,
    local_breadth_30: localBreadth30,
    generated_at: deps.now().toISOString(),
  };
  await deps.rawStore.upsert(sentinelResultRow(
    job,
    structuralFinalizedChunkMarket(chunk),
    structuralFinalizedChunkKey(),
    "STRUCTURAL_FINALIZED_CHUNK_V5",
    chunkGeometry.bars,
    chunkGeometry.firstTime,
    chunkGeometry.lastTime,
    params as unknown as JsonObject,
    deps.now(),
  ));
  return {
    ok: true,
    action: "finalize_chunk_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    chunk_index: chunk,
    chunk_count: chunkCount,
    partial_rows: partialRows,
    structural_snapshots: snapshots.length,
    raw_accumulators_in_finalized_chunk: false,
  };
}

export async function finalizeV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  const metrics = jobMetrics(job);
  const phase = String(metrics.phase || "");
  if (
    phase !== "STRUCTURAL_BREADTH_V5" && phase !== "BACKTEST_V5" && phase !== "COMPLETE_V5"
  ) {
    throw new Error("finalize_v5 requires STRUCTURAL_BREADTH_V5 or an already finalized V5 phase");
  }
  const geometry = gridGeometry(job);
  const universe = universeFromJob(job);
  const registryHash = String(config.candidate_registry_sha256 || "");
  if (!/^[0-9a-f]{64}$/.test(registryHash)) throw new Error("V5 registry hash is missing");
  const expectedRegistryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  if (
    registryHash !== expectedRegistryHash ||
    config.candidate_registry_revision !== V5_CANDIDATE_REGISTRY_REVISION
  ) {
    throw new Error("V5 candidate registry identity does not match the current runtime");
  }
  const folds = buildRollingFolds(geometry.start, geometry.endExclusive);
  if (JSON.stringify(config.folds) !== JSON.stringify(folds)) {
    throw new Error("V5 configured rolling folds do not match the frozen grid");
  }
  if (
    Number(config.structural_finalize_chunk_count) !== V5_TIME_CHUNKS ||
    Number(config.breadth_time_chunks) !== V5_TIME_CHUNKS ||
    Number(config.breadth_time_chunk_bars) !== V5_TIME_CHUNK_BARS ||
    Number(config.breadth_shard_count) !== V5_BREADTH_SHARDS
  ) throw new Error("V5 structural finalization config mismatch");
  const finalizedChunkRows = await deps.rawStore.exactCount(
    structuralFinalizedChunkCountQuery(job.id),
  );
  if (finalizedChunkRows !== V5_TIME_CHUNKS) {
    throw new Error(
      `V5 finalized structural chunk rows ${finalizedChunkRows}/${V5_TIME_CHUNKS}`,
    );
  }

  // A successful database update can outlive a lost HTTP response. Retrying must
  // return the same finalize contract without rebuilding or mutating anything,
  // but only after all persisted identities and compact payloads pass again.
  if (phase === "BACKTEST_V5" || phase === "COMPLETE_V5") {
    if (
      (phase === "BACKTEST_V5" && job.status !== "RUNNING") ||
      (phase === "COMPLETE_V5" && job.status !== "COMPLETE")
    ) {
      throw new Error(`V5 finalized phase ${phase} is inconsistent with job status ${job.status}`);
    }
    if (
      "accumulators" in metrics ||
      Number(metrics.breadth_partial_rows) !== V5_BREADTH_SHARDS * V5_TIME_CHUNKS ||
      Number(metrics.finalized_chunk_rows) !== finalizedChunkRows ||
      metrics.test_used_for_selection !== false ||
      !Number.isFinite(Date.parse(String(metrics.finalized_at || ""))) ||
      JSON.stringify(metrics.folds) !== JSON.stringify(folds)
    ) {
      throw new Error("V5 persisted structural finalization metadata is malformed or mixed");
    }
    const compactObject = object(metrics.structural_series, "job.metrics.structural_series");
    const compactKeys = [
      "featureOrder",
      "featuresF32Base64",
      "gridLength",
      "gridStartMs",
      "localBreadth30F32Base64",
      "localBreadthVelocity30F32Base64",
      "regimeCodes",
      "registryHash",
      "schemaVersion",
    ];
    if (JSON.stringify(Object.keys(compactObject).sort()) !== JSON.stringify(compactKeys)) {
      throw new Error("V5 persisted compact structural schema is malformed or mixed");
    }
    const compact = compactObject as unknown as CompactStructuralSeries;
    if (
      compact.schemaVersion !== 1 || compact.gridStartMs !== geometry.start ||
      compact.gridLength !== geometry.length || compact.registryHash !== registryHash
    ) {
      throw new Error("V5 persisted compact structural identity mismatch");
    }
    const unpacked = unpackStructuralSeries(compact);
    if (
      unpacked.points.length !== geometry.length ||
      unpacked.points.at(-1)?.time !== geometry.endInclusive
    ) {
      throw new Error("V5 persisted compact structural geometry mismatch");
    }
    const regimeCounts = structuralRegimeCounts(unpacked.points);
    assertStoredStructuralRegimeCounts(metrics.structural_regime_counts, regimeCounts);
    return finalizedV5Response(
      job,
      runtimeIdentity,
      compact,
      regimeCounts,
      folds,
      finalizedChunkRows,
    );
  }

  const finalizedPath = `${RESULT_TABLE}?job_id=eq.${encodeURIComponent(job.id)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(structuralFinalizedChunkKey())}` +
    "&family=eq.STRUCTURAL_FINALIZED_CHUNK_V5" +
    "&select=market,config_key,parameters&order=market.asc";
  const rows = await deps.rawStore.select(
    `${finalizedPath}&limit=${V5_TIME_CHUNKS}&offset=0`,
  ) as RawResultRow[];
  if (rows.length !== V5_TIME_CHUNKS) {
    throw new Error(`V5 finalized structural payload rows ${rows.length}/${V5_TIME_CHUNKS}`);
  }
  const universeHash = await sha256(JSON.stringify(universe.map((market) => market.symbol)));
  const snapshots: StructuralSnapshot[] = [];
  const localBreadth30: number[] = [];
  for (let chunk = 0; chunk < V5_TIME_CHUNKS; chunk++) {
    const row = rows[chunk];
    if (
      row.config_key !== structuralFinalizedChunkKey() ||
      row.market !== structuralFinalizedChunkMarket(chunk)
    ) throw new Error(`V5 finalized structural chunk ${chunk} row order mismatch`);
    const finalized = parseFinalizedChunk(
      row.parameters,
      chunk,
      universe.length,
      universeHash,
      geometry,
    );
    snapshots.push(...finalized.snapshots);
    localBreadth30.push(...finalized.local_breadth_30);
  }
  if (snapshots.length !== geometry.length) {
    throw new Error(`V5 finalized structural length ${snapshots.length}/${geometry.length}`);
  }
  const structural = classifyStructuralSeries(snapshots);
  const localBreadthVelocity30 = localBreadth30.map((value, index) => {
    const prior = index >= 2 ? localBreadth30[index - 2] : value;
    return value - prior;
  });
  const compact = await packStructuralSeries(
    structural,
    localBreadth30,
    localBreadthVelocity30,
    geometry.start,
    registryHash,
  );
  const regimeCounts = structuralRegimeCounts(structural);
  await deps.updateJob(job.id, {
    status: "RUNNING",
    startedAt: job.started_at ?? deps.now(),
    error: null,
    metrics: {
      phase: "BACKTEST_V5",
      structural_series: compact,
      structural_regime_counts: regimeCounts,
      folds,
      breadth_partial_rows: V5_BREADTH_SHARDS * V5_TIME_CHUNKS,
      finalized_chunk_rows: finalizedChunkRows,
      finalized_at: deps.now().toISOString(),
      test_used_for_selection: false,
    },
  }, deps.repositoryOptions);
  return finalizedV5Response(
    job,
    runtimeIdentity,
    compact,
    regimeCounts,
    folds,
    finalizedChunkRows,
  );
}

function compactFromJob(job: V5ResearchJobRow): CompactStructuralSeries {
  const metrics = jobMetrics(job);
  return object(
    metrics.structural_series,
    "job.metrics.structural_series",
  ) as unknown as CompactStructuralSeries;
}

function alignMarketInputs(
  prepared: readonly PreparedBar[],
  unpacked: ReturnType<typeof unpackStructuralSeries>,
  fiveMinuteMap: ReadonlyMap<number, FiveMinutePoint>,
): {
  structural: StructuralPoint[];
  localBreadth: number[];
  localBreadthVelocity: number[];
  fiveMinute: Array<FiveMinutePoint | null>;
} {
  const structural: StructuralPoint[] = [];
  const localBreadth: number[] = [];
  const localBreadthVelocity: number[] = [];
  const fiveMinute: Array<FiveMinutePoint | null> = [];
  if (!unpacked.points.length) throw new Error("V5 structural series is empty");
  const start = unpacked.points[0].time;
  for (const bar of prepared) {
    const index = (bar.time - start) / BAR_MS;
    if (!Number.isInteger(index) || index < 0 || index >= unpacked.points.length) {
      throw new Error(`market bar ${bar.time} is outside the V5 structural grid`);
    }
    structural.push(unpacked.points[index]);
    localBreadth.push(unpacked.localBreadth30[index]);
    localBreadthVelocity.push(unpacked.localBreadthVelocity30[index]);
    // A completed 15m bar [t,t+15m) can only use its final completed 5m child at t+10m.
    fiveMinute.push(fiveMinuteMap.get(bar.time + BAR_MS - FIVE_MINUTE_MS) ?? null);
  }
  return { structural, localBreadth, localBreadthVelocity, fiveMinute };
}

export type MarketHistoryDisposition = "SIMULATE" | "ZERO_TRADES_WARMUP" | "DATA_FAILURE";

/**
 * Newly listed contracts remain in the frozen full-market universe, including
 * a contract onboarded in the current incomplete 15m bucket, but cannot form
 * seven-day dynamic percentiles. Every eligible older/unknown listing must
 * cover its entire causal frozen tail; seven days alone is never sufficient.
 */
export function marketHistoryDisposition(
  onboardDate: number | null,
  startInclusive: number,
  endExclusive: number,
  preparedBars: number,
): MarketHistoryDisposition {
  if (onboardDate !== null && endExclusive - onboardDate < 7 * DAY_MS) {
    return "ZERO_TRADES_WARMUP";
  }
  const requiredStart = firstRequiredKlineOpen(startInclusive, BAR_MS, onboardDate);
  const requiredBars = Math.max(0, (endExclusive - requiredStart) / BAR_MS);
  if (!Number.isSafeInteger(requiredBars)) {
    throw new Error("market history window is not aligned to 15m intervals");
  }
  return preparedBars === requiredBars ? "SIMULATE" : "DATA_FAILURE";
}

export async function backtestShardV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  assertBacktestWritePhase(job, "backtest_shard_v5");
  const expectedShardCount = finiteInteger(
    config.backtest_shard_count,
    "backtest_shard_count",
    1,
    2_000,
  );
  const shardCount = finiteInteger(
    body.shard_count ?? expectedShardCount,
    "shard_count",
    1,
    2_000,
  );
  if (shardCount !== expectedShardCount || shardCount !== V5_BACKTEST_SHARDS) {
    throw new Error(`backtest_shard_v5 requires exactly ${V5_BACKTEST_SHARDS} shards`);
  }
  const shard = finiteInteger(body.shard_index, "shard_index", 0, shardCount - 1);
  const universe = universeFromJob(job);
  const assigned = assignedToShard(universe, shard, shardCount);
  const geometry = gridGeometry(job);
  const folds = buildRollingFolds(geometry.start, geometry.endExclusive);
  const frozenCandidates = candidates();
  const registryHash = String(config.candidate_registry_sha256 || "");
  const compact = compactFromJob(job);
  if (compact.registryHash !== registryHash) throw new Error("V5 compact registry hash mismatch");
  const unpacked = unpackStructuralSeries(compact);
  const successful: string[] = [];
  const failed: Array<{ market: string; error: string }> = [];
  const shardAggregates = seedAggregateMatrix(frozenCandidates, folds, geometry.start);
  // Logical shard count intentionally exceeds the expected universe so every
  // Edge invocation handles at most one market. Empty shards still persist the
  // complete zero-valued aggregate matrix for deterministic status checks.
  let resultRows = 0;

  // One market at a time bounds 120d 5m memory; each completed market is immediately checkpointed.
  for (const market of assigned) {
    try {
      const initialDisposition = marketHistoryDisposition(
        market.onboardDate,
        geometry.start,
        geometry.endExclusive,
        0,
      );
      if (initialDisposition === "ZERO_TRADES_WARMUP") {
        const output = candidateResultRows(
          market,
          [],
          [],
          [],
          [],
          [],
          folds,
          frozenCandidates,
          registryHash,
          geometry.start,
        );
        for (const row of output.rows) {
          row.parameters = {
            ...row.parameters,
            data_eligibility: "NEW_LISTING_7D_WARMUP_ZERO_TRADES",
            onboard_date_ms: market.onboardDate,
            required_warmup_bars: V5_MARKET_WARMUP_BARS,
          };
        }
        await deps.upsertResults(job.id, output.rows, deps.repositoryOptions);
        for (const aggregate of output.aggregates) mergeShardAggregate(shardAggregates, aggregate);
        resultRows += output.rows.length;
        successful.push(market.symbol);
        continue;
      }
      // Fetch sequentially to keep each Edge invocation to one Binance page
      // stream; GitHub orchestration additionally caps cross-invocation parallelism.
      const bars15 = await deps.fetch15m(market, {
        startTime: geometry.start,
        endTime: geometry.endInclusive,
        asOfTime: geometry.endExclusive,
        lookbackDays: V5_FOLD_POLICY.lookbackDays,
      });
      assertExpectedClosedBarCoverage(
        bars15,
        BAR_MS,
        geometry.start,
        geometry.endInclusive,
        market.onboardDate,
        market.symbol,
      );
      const prepared = prepareBars(bars15);
      if (
        marketHistoryDisposition(
          market.onboardDate,
          geometry.start,
          geometry.endExclusive,
          prepared.length,
        ) !==
          "SIMULATE"
      ) {
        throw new Error(
          `${market.symbol} is not eligible for complete 15m frozen-tail history ` +
            `(${prepared.length} prepared bars)`,
        );
      }
      const bars5 = await deps.fetch5m(market, {
        startTime: geometry.start,
        endTime: geometry.endInclusive + BAR_MS - FIVE_MINUTE_MS,
        asOfTime: geometry.endExclusive,
      });
      assertExpectedClosedBarCoverage(
        bars5,
        FIVE_MINUTE_MS,
        geometry.start,
        geometry.endInclusive + BAR_MS - FIVE_MINUTE_MS,
        market.onboardDate,
        market.symbol,
      );
      const fiveMinuteMap = buildFiveMinutePointMap(bars5);
      const aligned = alignMarketInputs(prepared, unpacked, fiveMinuteMap);
      const output = candidateResultRows(
        market,
        prepared,
        aligned.structural,
        aligned.localBreadth,
        aligned.localBreadthVelocity,
        aligned.fiveMinute,
        folds,
        frozenCandidates,
        registryHash,
        geometry.start,
      );
      const expectedRows = frozenCandidates.length * folds.length * 3;
      if (output.rows.length !== expectedRows || output.aggregates.length !== expectedRows) {
        throw new Error(
          `${market.symbol} result matrix ${output.rows.length}/${output.aggregates.length}/${expectedRows}`,
        );
      }
      await deps.upsertResults(job.id, output.rows, deps.repositoryOptions);
      for (const aggregate of output.aggregates) mergeShardAggregate(shardAggregates, aggregate);
      resultRows += output.rows.length;
      successful.push(market.symbol);
    } catch (error) {
      failed.push({
        market: market.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const checkpoint: BacktestCheckpointParameters = {
    schema_version: 1,
    router_revision: V5_REVISION,
    shard_index: shard,
    shard_count: shardCount,
    assigned_markets: assigned.map((market) => market.symbol),
    successful_markets: successful,
    failed_markets: failed,
    candidate_count: frozenCandidates.length,
    fold_count: folds.length,
    split_count: 3,
    result_rows: resultRows,
    expected_result_rows: assigned.length * frozenCandidates.length * folds.length * 3,
    aggregates: [...shardAggregates.values()].sort((left, right) =>
      left.candidate.localeCompare(right.candidate) || left.fold - right.fold ||
      left.split.localeCompare(right.split)
    ),
    completed_at: deps.now().toISOString(),
  };
  await deps.rawStore.upsert(sentinelResultRow(
    job,
    backtestShardMarket(shard),
    backtestCheckpointKey(),
    "BACKTEST_CHECKPOINT_V5",
    0,
    null,
    null,
    checkpoint as unknown as JsonObject,
    deps.now(),
  ));
  return {
    ok: failed.length === 0,
    action: "backtest_shard_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    shard_index: shard,
    shard_count: shardCount,
    assigned_markets: assigned.length,
    successful_markets: successful.length,
    failed_markets: failed,
    result_rows: resultRows,
  };
}

export async function backtestRollupV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  assertBacktestWritePhase(job, "backtest_rollup_v5");
  const geometry = gridGeometry(job);
  const universe = universeFromJob(job);
  const rollupCount = finiteInteger(
    config.backtest_rollup_shard_count,
    "backtest_rollup_shard_count",
    1,
    1_000,
  );
  const checkpointsPerRollup = finiteInteger(
    config.checkpoints_per_rollup,
    "checkpoints_per_rollup",
    1,
    1_000,
  );
  if (
    rollupCount !== V5_BACKTEST_ROLLUP_SHARDS ||
    checkpointsPerRollup !== V5_CHECKPOINTS_PER_ROLLUP ||
    rollupCount * checkpointsPerRollup !== V5_BACKTEST_SHARDS
  ) throw new Error("V5 backtest rollup geometry is invalid");
  const requestedRollupCount = finiteInteger(
    body.rollup_count ?? rollupCount,
    "rollup_count",
    1,
    1_000,
  );
  if (requestedRollupCount !== rollupCount) {
    throw new Error(`backtest_rollup_v5 requires exactly ${rollupCount} rollups`);
  }
  const rollup = finiteInteger(body.rollup_index, "rollup_index", 0, rollupCount - 1);
  const offset = rollup * checkpointsPerRollup;
  const checkpointPath = `${RESULT_TABLE}?job_id=eq.${encodeURIComponent(job.id)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(backtestCheckpointKey())}` +
    `&select=market,config_key,parameters&order=market.asc&limit=${checkpointsPerRollup}` +
    `&offset=${offset}`;
  const rows = await deps.rawStore.select(checkpointPath) as RawResultRow[];
  if (rows.length !== checkpointsPerRollup) {
    throw new Error(
      `V5 rollup ${rollup} checkpoint page incomplete ${rows.length}/${checkpointsPerRollup}`,
    );
  }
  const frozenCandidates = candidates();
  const folds = buildRollingFolds(geometry.start, geometry.endExclusive);
  const aggregates = seedAggregateMatrix(frozenCandidates, folds, geometry.start);
  const aggregateGroups = aggregates.size;
  const shardIndices: number[] = [];
  const assignedMarkets: string[] = [];
  const successfulMarkets: string[] = [];
  const failedMarkets: Array<{ market: string; error: string }> = [];
  let resultRows = 0;
  let expectedResultRows = 0;
  for (const row of rows) {
    const checkpoint = object(
      row.parameters,
      "backtest checkpoint",
    ) as unknown as BacktestCheckpointParameters;
    const checkpointShard = finiteInteger(
      checkpoint.shard_index,
      "checkpoint.shard_index",
      0,
      V5_BACKTEST_SHARDS - 1,
    );
    if (
      checkpoint.schema_version !== 1 || checkpoint.router_revision !== V5_REVISION ||
      checkpoint.shard_count !== V5_BACKTEST_SHARDS ||
      row.config_key !== backtestCheckpointKey() ||
      row.market !== backtestShardMarket(checkpointShard) ||
      checkpoint.candidate_count !== frozenCandidates.length ||
      checkpoint.fold_count !== folds.length || checkpoint.split_count !== 3 ||
      !Array.isArray(checkpoint.assigned_markets) ||
      !Array.isArray(checkpoint.successful_markets) ||
      !Array.isArray(checkpoint.failed_markets) || !Array.isArray(checkpoint.aggregates)
    ) throw new Error(`malformed checkpoint in V5 rollup ${rollup}`);
    const expectedAssigned = assignedToShard(universe, checkpointShard, V5_BACKTEST_SHARDS)
      .map((market) => market.symbol);
    if (JSON.stringify(checkpoint.assigned_markets) !== JSON.stringify(expectedAssigned)) {
      throw new Error(`checkpoint ${checkpointShard} frozen-universe assignment mismatch`);
    }
    const failedSymbols = checkpoint.failed_markets.map((failure) => failure.market);
    const completedSymbols = [...checkpoint.successful_markets, ...failedSymbols].sort();
    if (
      new Set(completedSymbols).size !== completedSymbols.length ||
      JSON.stringify(completedSymbols) !== JSON.stringify([...expectedAssigned].sort()) ||
      (checkpoint.failed_markets.length === 0 &&
        JSON.stringify(checkpoint.successful_markets) !== JSON.stringify(expectedAssigned))
    ) throw new Error(`checkpoint ${checkpointShard} completion identity mismatch`);
    const expectedCheckpointRows = expectedAssigned.length * aggregateGroups;
    const successfulCheckpointRows = checkpoint.successful_markets.length * aggregateGroups;
    if (
      checkpoint.expected_result_rows !== expectedCheckpointRows ||
      checkpoint.result_rows !== successfulCheckpointRows
    ) throw new Error(`checkpoint ${checkpointShard} result-row count mismatch`);
    assertAggregateMatrix(checkpoint.aggregates, aggregates, `checkpoint ${checkpointShard}`);
    shardIndices.push(checkpointShard);
    assignedMarkets.push(...checkpoint.assigned_markets);
    successfulMarkets.push(...checkpoint.successful_markets);
    failedMarkets.push(...checkpoint.failed_markets);
    resultRows += checkpoint.result_rows;
    expectedResultRows += checkpoint.expected_result_rows;
    for (const aggregate of checkpoint.aggregates) mergeShardAggregate(aggregates, aggregate);
  }
  const expectedShardIndices = Array.from(
    { length: checkpointsPerRollup },
    (_, index) => offset + index,
  );
  shardIndices.sort((left, right) => left - right);
  if (JSON.stringify(shardIndices) !== JSON.stringify(expectedShardIndices)) {
    throw new Error(`V5 rollup ${rollup} checkpoint identity mismatch`);
  }
  const params: BacktestRollupParameters = {
    schema_version: 1,
    router_revision: V5_REVISION,
    rollup_index: rollup,
    rollup_count: rollupCount,
    checkpoints_per_rollup: checkpointsPerRollup,
    shard_indices: shardIndices,
    assigned_markets: [...new Set(assignedMarkets)].sort(),
    successful_markets: [...new Set(successfulMarkets)].sort(),
    failed_markets: failedMarkets.sort((left, right) => left.market.localeCompare(right.market)),
    candidate_count: frozenCandidates.length,
    fold_count: folds.length,
    split_count: 3,
    result_rows: resultRows,
    expected_result_rows: expectedResultRows,
    aggregates: [...aggregates.values()].sort((left, right) =>
      left.candidate.localeCompare(right.candidate) || left.fold - right.fold ||
      left.split.localeCompare(right.split)
    ),
    generated_at: deps.now().toISOString(),
  };
  await deps.rawStore.upsert(sentinelResultRow(
    job,
    backtestRollupMarket(rollup),
    backtestRollupKey(),
    "BACKTEST_ROLLUP_V5",
    0,
    null,
    null,
    params as unknown as JsonObject,
    deps.now(),
  ));
  return {
    ok: failedMarkets.length === 0,
    action: "backtest_rollup_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    rollup_index: rollup,
    rollup_count: rollupCount,
    checkpoint_shards: shardIndices.length,
    assigned_markets: params.assigned_markets.length,
    successful_markets: params.successful_markets.length,
    failed_markets: failedMarkets,
    aggregate_groups: params.aggregates.length,
  };
}

function countQuery(jobId: string, extra = ""): string {
  const candidateFamilies = [
    "DONCHIAN_BREAKOUT",
    "MOMENTUM_ACCELERATION",
    "COMPRESSION_BREAKOUT",
    "RANGE_CYCLE",
    "BEAR_REBREAK",
  ].join(",");
  return `job_id=eq.${encodeURIComponent(jobId)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&family=in.(${candidateFamilies})${extra}&select=job_id`;
}

export async function statusV5(
  body: JsonObject,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const deps = dependencies(overrides);
  const job = await deps.loadJob(String(body.job_id || ""), deps.repositoryOptions);
  const runtimeIdentity = stampedRuntimeIdentity(deps);
  const config = assertJobRuntimeIdentity(job, runtimeIdentity);
  const universe = universeFromJob(job);
  const geometry = gridGeometry(job);
  const frozenCandidates = candidates();
  const expected = expectedMetricCompleteness(
    universe.length,
    frozenCandidates.length,
    V5_FOLD_POLICY.foldCount,
  );
  const mismatches: string[] = [];
  if (job.revision !== V5_REVISION) mismatches.push("revision");
  if (universe.length !== job.total_markets) mismatches.push("markets");
  if (universe.length < V5_MINIMUM_ACTIVE_MARKETS) mismatches.push("minimum_500_markets");
  if (Number(config.candidate_count) !== frozenCandidates.length) {
    mismatches.push("candidate_count");
  }
  if (!/^[0-9a-f]{40}$/.test(String(config.source_sha || ""))) mismatches.push("source_sha");
  if (Number(config.breadth_shard_count) !== V5_BREADTH_SHARDS) mismatches.push("breadth_shards");
  if (Number(config.breadth_time_chunks) !== V5_TIME_CHUNKS) mismatches.push("time_chunks");
  if (Number(config.structural_finalize_chunk_count) !== V5_TIME_CHUNKS) {
    mismatches.push("structural_finalize_chunks");
  }
  if (Number(config.backtest_shard_count) !== V5_BACKTEST_SHARDS) {
    mismatches.push("backtest_shards");
  }
  if (Number(config.backtest_rollup_shard_count) !== V5_BACKTEST_ROLLUP_SHARDS) {
    mismatches.push("backtest_rollup_shards");
  }
  if (Number(config.checkpoints_per_rollup) !== V5_CHECKPOINTS_PER_ROLLUP) {
    mismatches.push("checkpoints_per_rollup");
  }
  if (
    JSON.stringify(config.production_review_risk_gate) !==
      JSON.stringify(V5_PRODUCTION_REVIEW_RISK_GATE)
  ) mismatches.push("production_review_risk_gate");
  if (geometry.length !== V5_FOLD_POLICY.lookbackDays * DAY_MS / BAR_MS) mismatches.push("grid");
  const expectedRegistryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  if (config.candidate_registry_sha256 !== expectedRegistryHash) mismatches.push("registry_hash");
  try {
    const configuredFolds = config.folds as FoldDefinition[];
    const expectedFolds = buildRollingFolds(geometry.start, geometry.endExclusive);
    if (JSON.stringify(configuredFolds) !== JSON.stringify(expectedFolds)) mismatches.push("folds");
    const compact = compactFromJob(job);
    if (
      compact.gridLength !== geometry.length || compact.gridStartMs !== geometry.start ||
      compact.registryHash !== expectedRegistryHash
    ) mismatches.push("compact_structural_series");
    unpackStructuralSeries(compact);
  } catch {
    mismatches.push("compact_structural_series");
  }

  const partialRows = await deps.rawStore.exactCount(
    `job_id=eq.${encodeURIComponent(job.id)}` +
      `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
      "&family=eq.STRUCTURAL_PARTIAL_V5&select=job_id",
  );
  if (partialRows !== V5_BREADTH_SHARDS * V5_TIME_CHUNKS) mismatches.push("structural_partials");
  const finalizedChunkRows = await deps.rawStore.exactCount(
    structuralFinalizedChunkCountQuery(job.id),
  );
  if (finalizedChunkRows !== V5_TIME_CHUNKS) mismatches.push("structural_finalized_chunks");

  // Count the 600 raw checkpoint rows without selecting their large JSON
  // parameters. Only the 60 bounded rollups are parsed below.
  const checkpointRowCount = await deps.rawStore.exactCount(
    `job_id=eq.${encodeURIComponent(job.id)}` +
      `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
      `&config_key=eq.${encodeURIComponent(backtestCheckpointKey())}` +
      "&family=eq.BACKTEST_CHECKPOINT_V5&select=job_id",
  );
  if (checkpointRowCount !== V5_BACKTEST_SHARDS) mismatches.push("checkpoint_rows");
  const rollupRowCount = await deps.rawStore.exactCount(
    `job_id=eq.${encodeURIComponent(job.id)}` +
      `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
      `&config_key=eq.${encodeURIComponent(backtestRollupKey())}` +
      "&family=eq.BACKTEST_ROLLUP_V5&select=job_id",
  );
  if (rollupRowCount !== V5_BACKTEST_ROLLUP_SHARDS) mismatches.push("backtest_rollup_rows");
  const rollupPath = `${RESULT_TABLE}?job_id=eq.${encodeURIComponent(job.id)}` +
    `&revision=eq.${encodeURIComponent(V5_REVISION)}` +
    `&config_key=eq.${encodeURIComponent(backtestRollupKey())}` +
    "&family=eq.BACKTEST_ROLLUP_V5" +
    "&select=market,config_key,parameters&order=market.asc";
  const folds = buildRollingFolds(geometry.start, geometry.endExclusive);
  const expectedAggregateMatrix = seedAggregateMatrix(frozenCandidates, folds, geometry.start);
  const aggregateGroups = expectedAggregateMatrix.size;
  const allAggregates = seedAggregateMatrix(frozenCandidates, folds, geometry.start);
  const rollupIndices = new Set<number>();
  const checkpointShards = new Set<number>();
  const checkpointMarkets = new Set<string>();
  const assignedMarketOccurrences: string[] = [];
  const successfulMarketOccurrences: string[] = [];
  let checkpointFailures = 0;
  let rollupResultRows = 0;
  let rollupExpectedResultRows = 0;
  const rollupPageSize = 10;
  for (let pageOffset = 0; pageOffset < V5_BACKTEST_ROLLUP_SHARDS; pageOffset += rollupPageSize) {
    const page = await deps.rawStore.select(
      `${rollupPath}&limit=${rollupPageSize}&offset=${pageOffset}`,
    ) as RawResultRow[];
    const expectedPageRows = Math.min(
      rollupPageSize,
      V5_BACKTEST_ROLLUP_SHARDS - pageOffset,
    );
    if (page.length !== expectedPageRows) {
      mismatches.push(`backtest_rollup_payload_page_${pageOffset}`);
    }
    for (const row of page) {
      try {
        const rollup = object(
          row.parameters,
          "backtest rollup",
        ) as unknown as BacktestRollupParameters;
        const rollupIndex = finiteInteger(
          rollup.rollup_index,
          "rollup.rollup_index",
          0,
          V5_BACKTEST_ROLLUP_SHARDS - 1,
        );
        const expectedShardIndices = Array.from(
          { length: V5_CHECKPOINTS_PER_ROLLUP },
          (_, index) => rollupIndex * V5_CHECKPOINTS_PER_ROLLUP + index,
        );
        const expectedAssigned = expectedShardIndices.flatMap((shard) =>
          assignedToShard(universe, shard, V5_BACKTEST_SHARDS).map((market) => market.symbol)
        ).sort();
        if (
          rollup.schema_version !== 1 || rollup.router_revision !== V5_REVISION ||
          rollup.rollup_count !== V5_BACKTEST_ROLLUP_SHARDS ||
          rollup.checkpoints_per_rollup !== V5_CHECKPOINTS_PER_ROLLUP ||
          row.config_key !== backtestRollupKey() ||
          row.market !== backtestRollupMarket(rollupIndex) ||
          rollup.candidate_count !== frozenCandidates.length ||
          rollup.fold_count !== folds.length || rollup.split_count !== 3 ||
          !Array.isArray(rollup.shard_indices) || !Array.isArray(rollup.assigned_markets) ||
          !Array.isArray(rollup.successful_markets) || !Array.isArray(rollup.failed_markets) ||
          !Array.isArray(rollup.aggregates) ||
          JSON.stringify(rollup.shard_indices) !== JSON.stringify(expectedShardIndices) ||
          JSON.stringify([...rollup.assigned_markets].sort()) !== JSON.stringify(expectedAssigned)
        ) throw new Error(`malformed backtest rollup ${rollupIndex}`);
        const failedSymbols = rollup.failed_markets.map((failure) => failure.market);
        const completedSymbols = [...rollup.successful_markets, ...failedSymbols].sort();
        if (
          new Set(completedSymbols).size !== completedSymbols.length ||
          JSON.stringify(completedSymbols) !== JSON.stringify(expectedAssigned) ||
          rollup.expected_result_rows !== expectedAssigned.length * aggregateGroups ||
          rollup.result_rows !== rollup.successful_markets.length * aggregateGroups
        ) throw new Error(`backtest rollup ${rollupIndex} completion mismatch`);
        assertAggregateMatrix(
          rollup.aggregates,
          expectedAggregateMatrix,
          `backtest rollup ${rollupIndex}`,
        );
        rollupIndices.add(rollupIndex);
        for (const shard of rollup.shard_indices) checkpointShards.add(shard);
        assignedMarketOccurrences.push(...rollup.assigned_markets);
        successfulMarketOccurrences.push(...rollup.successful_markets);
        checkpointFailures += rollup.failed_markets.length;
        for (const market of rollup.successful_markets) checkpointMarkets.add(market);
        rollupResultRows += rollup.result_rows;
        rollupExpectedResultRows += rollup.expected_result_rows;
        for (const aggregate of rollup.aggregates) mergeShardAggregate(allAggregates, aggregate);
      } catch (error) {
        mismatches.push(
          `backtest_rollup_invalid:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (rollupIndices.size !== V5_BACKTEST_ROLLUP_SHARDS) mismatches.push("backtest_rollup_indices");
  if (checkpointShards.size !== V5_BACKTEST_SHARDS) mismatches.push("checkpoint_shards");
  if (
    assignedMarketOccurrences.length !== universe.length ||
    new Set(assignedMarketOccurrences).size !== universe.length
  ) mismatches.push("checkpoint_assigned_market_duplicates");
  if (
    successfulMarketOccurrences.length !== universe.length ||
    new Set(successfulMarketOccurrences).size !== universe.length
  ) mismatches.push("checkpoint_successful_market_duplicates");
  if (
    checkpointMarkets.size !== universe.length || checkpointFailures > 0 ||
    rollupResultRows !== expected.rows || rollupExpectedResultRows !== expected.rows
  ) {
    mismatches.push("checkpoint_markets");
  }
  const expectedMarketSymbols = universe.map((market) => market.symbol).sort();
  const checkpointMarketSymbols = [...checkpointMarkets].sort();
  if (JSON.stringify(checkpointMarketSymbols) !== JSON.stringify(expectedMarketSymbols)) {
    mismatches.push("checkpoint_universe_identity");
  }

  const totalRows = await deps.rawStore.exactCount(countQuery(job.id));
  const splitCountsEntries = await mapConcurrent(
    ["TRAIN", "VALIDATION", "TEST"] as const,
    STATUS_COUNT_CONCURRENCY,
    async (split) =>
      [
        split,
        await deps.rawStore.exactCount(countQuery(job.id, `&split=eq.${split}`)),
      ] as const,
  );
  const splitCounts = Object.fromEntries(splitCountsEntries) as Record<string, number>;
  const foldCountsEntries = await mapConcurrent(
    [1, 2, 3, 4],
    STATUS_COUNT_CONCURRENCY,
    async (fold) =>
      [
        String(fold),
        await deps.rawStore.exactCount(
          countQuery(
            job.id,
            `&config_key=like.${encodeURIComponent(`${V5_REVISION}::*::FOLD_${fold}`)}`,
          ),
        ),
      ] as const,
  );
  const foldCounts = Object.fromEntries(foldCountsEntries) as Record<string, number>;
  const candidateCountsEntries = await mapConcurrent(
    frozenCandidates,
    STATUS_COUNT_CONCURRENCY,
    async (candidate) =>
      [
        candidate.name,
        await deps.rawStore.exactCount(
          countQuery(
            job.id,
            `&config_key=like.${encodeURIComponent(`${V5_REVISION}::${candidate.name}::*`)}`,
          ),
        ),
      ] as const,
  );
  const candidateCounts = Object.fromEntries(candidateCountsEntries) as Record<string, number>;
  const observed = {
    markets: checkpointMarkets.size,
    candidates: Object.values(candidateCounts).filter((count) => count > 0).length,
    folds: Object.values(foldCounts).filter((count) => count > 0).length,
    splits: Object.values(splitCounts).filter((count) => count > 0).length,
    rows: totalRows,
  };
  try {
    assertMetricCompleteness(observed, expected);
  } catch (error) {
    mismatches.push(error instanceof Error ? error.message : String(error));
  }
  const expectedPerSplit = universe.length * frozenCandidates.length * V5_FOLD_POLICY.foldCount;
  for (const [split, count] of Object.entries(splitCounts)) {
    if (count !== expectedPerSplit) mismatches.push(`split_${split}`);
  }
  const expectedPerFold = universe.length * frozenCandidates.length * 3;
  for (const [fold, count] of Object.entries(foldCounts)) {
    if (count !== expectedPerFold) mismatches.push(`fold_${fold}`);
  }
  const expectedPerCandidate = universe.length * V5_FOLD_POLICY.foldCount * 3;
  for (const [candidate, count] of Object.entries(candidateCounts)) {
    if (count !== expectedPerCandidate) mismatches.push(`candidate_${candidate}`);
  }
  const expectedAggregateGroups = frozenCandidates.length * V5_FOLD_POLICY.foldCount * 3;
  if (allAggregates.size !== expectedAggregateGroups) mismatches.push("aggregate_groups");
  const fullMarketMetrics = [...allAggregates.values()]
    .sort((left, right) =>
      left.candidate.localeCompare(right.candidate) || left.fold - right.fold ||
      left.split.localeCompare(right.split)
    )
    .map(fullMarketMetric);
  const validationInputs: CandidateFoldMetric[] = [...allAggregates.values()].map((aggregate) => ({
    candidate: aggregate.candidate,
    neighborGroup: aggregate.neighbor_group,
    fold: aggregate.fold,
    split: aggregate.split,
    trades: aggregate.trades,
    profitFactor: aggregate.net_loss_bps > 0
      ? aggregate.net_profit_bps / aggregate.net_loss_bps
      : null,
    stressNetPnlBps: aggregate.stress_net_pnl_bps,
  }));
  const validationReports = evaluateCandidateValidation(validationInputs);
  const concentrationByCandidate = new Map<string, boolean>();
  const riskQualityByCandidate = new Map<string, PostSelectionGate>();
  const occurrenceByCandidate = new Map<string, PostSelectionGate>();
  for (const aggregate of allAggregates.values()) {
    const finalTest = aggregate.split === "TEST" && aggregate.fold === V5_FOLD_POLICY.foldCount;
    const selectionSplit = aggregate.split === "TRAIN" || aggregate.split === "VALIDATION";
    if (!selectionSplit && !finalTest) continue;
    const positive = aggregate.time_chunk_net_bps.map((value) => Math.max(0, value));
    const totalPositive = positive.reduce((sum, value) => sum + value, 0);
    const profitableChunks = positive.filter((value) => value > 0).length;
    const pass = totalPositive <= 0 ||
      (Math.max(...positive) / totalPositive <=
          V5_PRODUCTION_REVIEW_RISK_GATE.maximumPositiveTimeChunkShare &&
        profitableChunks >= V5_PRODUCTION_REVIEW_RISK_GATE.minimumProfitableTimeChunks);
    concentrationByCandidate.set(
      aggregate.candidate,
      (concentrationByCandidate.get(aggregate.candidate) ?? true) && pass,
    );

    const riskFailures: string[] = [];
    const segment = `F${aggregate.fold}_${aggregate.split}`;
    const drawdown = equalNotionalSignalMaxDrawdown(aggregate.exit_net_by_grid_index);
    const stressToMdd = drawdown > 0
      ? aggregate.stress_net_pnl_bps / drawdown
      : aggregate.stress_net_pnl_bps > 0
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
    const capture = aggregate.capture_count
      ? aggregate.capture_sum / aggregate.capture_count
      : null;
    const averageMfe = aggregate.trades ? aggregate.mfe_sum_bps / aggregate.trades : 0;
    const averageGiveback = aggregate.trades ? aggregate.giveback_sum_bps / aggregate.trades : 0;
    if (!(stressToMdd >= V5_PRODUCTION_REVIEW_RISK_GATE.minimumStressToMdd)) {
      riskFailures.push(`${segment}_STRESS_TO_MDD_BELOW_0_25`);
    }
    if (capture === null || capture < V5_PRODUCTION_REVIEW_RISK_GATE.minimumMfeCapture) {
      riskFailures.push(`${segment}_MFE_CAPTURE_BELOW_0_20`);
    }
    if (
      !(averageMfe > 0) ||
      averageGiveback > V5_PRODUCTION_REVIEW_RISK_GATE.maximumGivebackToMfe * averageMfe
    ) {
      riskFailures.push(`${segment}_GIVEBACK_ABOVE_0_80_MFE`);
    }
    const existingRisk = riskQualityByCandidate.get(aggregate.candidate) ?? {
      pass: true,
      failures: [],
    };
    existingRisk.failures.push(...riskFailures);
    existingRisk.pass = existingRisk.pass && riskFailures.length === 0;
    riskQualityByCandidate.set(aggregate.candidate, existingRisk);

    const minimumDays = aggregate.split === "TRAIN"
      ? V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.TRAIN
      : aggregate.split === "VALIDATION"
      ? V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.VALIDATION
      : V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.FINAL_TEST;
    const occurrenceFailure = aggregate.signal_day_indices.length >= minimumDays
      ? []
      : [`${segment}_UNIQUE_SIGNAL_DAYS_BELOW_${minimumDays}`];
    const existingOccurrence = occurrenceByCandidate.get(aggregate.candidate) ?? {
      pass: true,
      failures: [],
    };
    existingOccurrence.failures.push(...occurrenceFailure);
    existingOccurrence.pass = existingOccurrence.pass && occurrenceFailure.length === 0;
    occurrenceByCandidate.set(aggregate.candidate, existingOccurrence);
  }
  const productionReviewReports = applyProductionReviewGates(
    validationReports,
    concentrationByCandidate,
    riskQualityByCandidate,
    occurrenceByCandidate,
  );
  const uniqueMismatches = [...new Set(mismatches)];
  const complete = uniqueMismatches.length === 0;
  if (complete && job.status !== "COMPLETE") {
    await deps.updateJob(job.id, {
      status: "COMPLETE",
      cursor: universe.length,
      processedMarkets: universe.length,
      failedMarkets: 0,
      completedAt: deps.now(),
      error: null,
      metrics: {
        phase: "COMPLETE_V5",
        completed_at: deps.now().toISOString(),
        observed_metric_matrix: observed,
        full_market_fold_metrics: fullMarketMetrics,
        validation_reports: productionReviewReports,
        robust_candidates: productionReviewReports.filter((report) =>
          report.productionReviewEligible
        ).map((report) => report.candidate),
        no_robust_edge_found: !productionReviewReports.some((report) =>
          report.productionReviewEligible
        ),
        checkpoint_rows: checkpointRowCount,
        backtest_rollup_rows: rollupRowCount,
        finalized_chunk_rows: finalizedChunkRows,
        equal_notional_signal_mdd_method:
          "EQUAL_NOTIONAL_EXIT_TIME_NET_DELTA_MERGE_ACROSS_ALL_MARKETS",
        allocation_assumption: "EQUAL_NOTIONAL_PER_SIGNAL_NO_CAPITAL_OR_CONCURRENCY_CAP",
        concentration_window_days: 10,
        test_used_for_selection: false,
      },
    }, deps.repositoryOptions);
  }
  const response: JsonObject = {
    ok: complete,
    action: "status_v5",
    revision: V5_REVISION,
    source_sha: runtimeIdentity.sourceSha,
    implementation_sha256: runtimeIdentity.implementationSha256,
    job_id: job.id,
    status: complete ? "COMPLETE" : job.status,
    complete,
    expected,
    observed,
    structural_partial_rows: partialRows,
    structural_finalized_chunk_rows: finalizedChunkRows,
    checkpoint_rows: checkpointRowCount,
    checkpoint_shards: checkpointShards.size,
    backtest_rollup_rows: rollupRowCount,
    backtest_rollup_shards: rollupIndices.size,
    checkpoint_markets: checkpointMarkets.size,
    checkpoint_failures: checkpointFailures,
    split_rows: splitCounts,
    fold_rows: foldCounts,
    candidate_rows: candidateCounts,
    full_market_fold_metrics: fullMarketMetrics,
    validation_reports: productionReviewReports,
    mismatches: uniqueMismatches,
    research_only: true,
    production_connected: false,
  };
  if (!complete && body.assert_complete !== false) {
    throw new Error(`V5 research job is incomplete: ${uniqueMismatches.join(", ")}`);
  }
  return response;
}

export async function dispatchV5Action(
  bodyValue: unknown,
  overrides: Partial<V5OpsDependencies> = {},
): Promise<JsonObject> {
  const body = object(bodyValue, "request body");
  const action = String(body.action || "").trim();
  if (action === "start_v5") return await startV5(body, overrides);
  if (action === "breadth_shard_v5") return await breadthShardV5(body, overrides);
  if (action === "finalize_chunk_v5") return await finalizeChunkV5(body, overrides);
  if (action === "finalize_v5") return await finalizeV5(body, overrides);
  if (action === "backtest_shard_v5") return await backtestShardV5(body, overrides);
  if (action === "backtest_rollup_v5") return await backtestRollupV5(body, overrides);
  if (action === "status_v5") return await statusV5(body, overrides);
  throw new Error("unsupported V5 research action");
}
