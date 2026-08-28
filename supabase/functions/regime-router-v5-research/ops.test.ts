import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRollingFolds,
  type CandidateFoldMetric,
  DAY_MS,
  evaluateCandidateValidation,
  V5_FOLD_POLICY,
} from "./folds.ts";
import {
  type CreateV5ResearchJobInput,
  type UpdateV5ResearchJobInput,
  type V5MarketResultInput,
  type V5ResearchJobRow,
} from "./repository.ts";
import {
  applyProductionReviewGates,
  assignedToShard,
  backtestRollupV5,
  backtestShardV5,
  breadthShardV5,
  buildFiveMinutePointMap,
  categorizeExitReasons,
  type CompactStructuralSeries,
  decodeFloat32,
  encodeFloat32,
  finalizeChunkV5,
  finalizeV5,
  marketHistoryDisposition,
  packStructuralSeries,
  startV5,
  statusV5,
  unpackStructuralSeries,
  V5_BACKTEST_ROLLUP_SHARDS,
  V5_BACKTEST_SHARDS,
  V5_BREADTH_SHARDS,
  V5_CHECKPOINTS_PER_ROLLUP,
  V5_MARKET_WARMUP_BARS,
  V5_PRODUCTION_REVIEW_RISK_GATE,
  V5_TIME_CHUNK_BARS,
  V5_TIME_CHUNKS,
} from "./ops.ts";
import {
  CANDIDATE_REGISTRY_HASH_INPUT,
  candidates,
  V5_CANDIDATE_REGISTRY_REVISION,
} from "./strategies.ts";
import { createStructuralAccumulator, type StructuralSnapshot } from "./structural.ts";
import {
  type Bar,
  BAR_MS,
  FIVE_MINUTE_MS,
  type StructuralPoint,
  type UniverseMarket,
  V5_REVISION,
} from "./types.ts";

function structural(time: number, offset: number): StructuralPoint {
  return {
    time,
    regime: offset ? "BEAR" : "BULL",
    positiveBreadth6h: 0.6 - offset * 0.2,
    negativeBreadth6h: 0.3 + offset * 0.2,
    positiveBreadth24h: 0.62 - offset * 0.2,
    negativeBreadth24h: 0.28 + offset * 0.2,
    meanReturn6h: 0.01 - offset * 0.02,
    meanReturn24h: 0.02 - offset * 0.04,
    medianReturn6h: 0.009 - offset * 0.018,
    medianReturn24h: 0.018 - offset * 0.036,
    emaBullShare: 0.64 - offset * 0.3,
    emaBearShare: 0.25 + offset * 0.4,
    trendPersistence: 0.4 - offset * 0.8,
    lowAdxShare: 0.2,
    meanReversionShare: 0.3,
    volatilityPercentile: 0.5,
    extremeMoverShare: 0.02,
    breadthVelocity: 0.01 - offset * 0.02,
    breadthAcceleration: 0.002 - offset * 0.004,
    btc6h: 0.01,
    btc24h: 0.02,
    eth6h: 0.008,
    eth24h: 0.016,
    sol6h: 0.012,
    sol24h: 0.024,
    bullScore: 0.7 - offset * 0.3,
    bearScore: 0.2 + offset * 0.5,
    rangeScore: 0.3,
    validMarkets: 520,
  };
}

function fiveMinuteBars(count = 32): Bar[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.1 + (index % 3 === 0 ? 0.04 : 0);
    return {
      time: start + index * FIVE_MINUTE_MS,
      open: close - 0.03,
      high: close + 0.08,
      low: close - 0.09,
      close,
      volume: 1_000 + index * 10,
      quoteVolume: close * (1_000 + index * 10),
    };
  });
}

function continuousBars(start: number, count: number, intervalMs: number): Bar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * intervalMs,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
    quoteVolume: 100_000,
  }));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const TEST_SOURCE_SHA = "a".repeat(40);
const TEST_IMPLEMENTATION_SHA256 = "b".repeat(64);
const TEST_RUNTIME_IDENTITY = () => ({
  sourceSha: TEST_SOURCE_SHA,
  implementationSha256: TEST_IMPLEMENTATION_SHA256,
});

async function assertRejectsWith(
  operation: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(expectedMessage),
      `expected rejection containing ${expectedMessage}, received ${message}`,
    );
    return;
  }
  throw new Error(`expected rejection containing ${expectedMessage}`);
}

function replaceCompactFeature(
  series: CompactStructuralSeries,
  featureName: string,
  value: number,
): CompactStructuralSeries {
  const featureIndex = series.featureOrder.indexOf(featureName);
  if (featureIndex < 0) throw new Error(`missing compact feature ${featureName}`);
  const values = Array.from(
    decodeFloat32(series.featuresF32Base64, series.gridLength * series.featureOrder.length),
  );
  values[featureIndex] = value;
  return { ...series, featuresF32Base64: encodeFloat32(values) };
}

Deno.test("V5 compact structural series round-trips all features and local 30m breadth", async () => {
  const start = Date.UTC(2026, 0, 1);
  const points = [structural(start, 0), structural(start + BAR_MS, 1)];
  const compact = await packStructuralSeries(
    points,
    [0.51, 0.48],
    [0.02, -0.03],
    start,
    "a".repeat(64),
  );
  const unpacked = unpackStructuralSeries(compact);

  assertEquals(unpacked.points.map((point) => point.regime), ["BULL", "BEAR"]);
  assertEquals(unpacked.points.map((point) => point.time), [start, start + BAR_MS]);
  assertAlmostEquals(unpacked.points[0].positiveBreadth6h, 0.6, 1e-6);
  assertAlmostEquals(unpacked.points[1].breadthVelocity, -0.01, 1e-6);
  assertAlmostEquals(unpacked.localBreadth30[0], 0.51, 1e-6);
  assertAlmostEquals(unpacked.localBreadthVelocity30[1], -0.03, 1e-6);
});

Deno.test("V5 compact structural decoder rejects unknown regime codes and non-finite Float32", async () => {
  const start = Date.UTC(2026, 0, 1);
  const compact = await packStructuralSeries(
    [structural(start, 0)],
    [0.51],
    [0.02],
    start,
    "a".repeat(64),
  );

  for (const code of ["X", "b", " "]) {
    await assertRejectsWith(
      async () => unpackStructuralSeries({ ...compact, regimeCodes: code }),
      "unsupported or malformed compact structural series",
    );
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assertRejectsWith(
      async () => decodeFloat32(encodeFloat32([value]), 1),
      "must be finite",
    );
  }
  await assertRejectsWith(
    async () => unpackStructuralSeries(replaceCompactFeature(compact, "meanReturn6h", Number.NaN)),
    "must be finite",
  );
  await assertRejectsWith(
    async () =>
      unpackStructuralSeries({
        ...compact,
        localBreadth30F32Base64: encodeFloat32([Number.NaN]),
      }),
    "must be finite",
  );
  await assertRejectsWith(
    async () =>
      unpackStructuralSeries({
        ...compact,
        localBreadthVelocity30F32Base64: encodeFloat32([Number.POSITIVE_INFINITY]),
      }),
    "must be finite",
  );
});

Deno.test("V5 compact structural decoder rejects semantically impossible feature ranges", async () => {
  const start = Date.UTC(2026, 0, 1);
  const compact = await packStructuralSeries(
    [structural(start, 0)],
    [0.51],
    [0.02],
    start,
    "a".repeat(64),
  );
  const invalidFeatures = [
    ["positiveBreadth6h", 1.01],
    ["trendPersistence", -1.01],
    ["breadthVelocity", 2.01],
    ["breadthAcceleration", -4.01],
    ["meanReturn24h", -1.01],
    ["btc6h", 1_000_001],
    ["bullScore", 1.01],
    ["validMarkets", 520.5],
    ["validMarkets", V5_BACKTEST_SHARDS + 1],
  ] as const;
  for (const [feature, value] of invalidFeatures) {
    await assertRejectsWith(
      async () => unpackStructuralSeries(replaceCompactFeature(compact, feature, value)),
      `compact structural feature ${feature}[0] is outside its safe range`,
    );
  }
  await assertRejectsWith(
    async () =>
      unpackStructuralSeries({
        ...compact,
        localBreadth30F32Base64: encodeFloat32([1.01]),
      }),
    "compact local breadth 30m[0] is outside its safe range",
  );
  await assertRejectsWith(
    async () =>
      unpackStructuralSeries({
        ...compact,
        localBreadthVelocity30F32Base64: encodeFloat32([-1.01]),
      }),
    "compact local breadth velocity 30m[0] is outside its safe range",
  );
});

Deno.test("V5 actual 5m features are causal and unaffected by a future child", () => {
  const bars = fiveMinuteBars();
  const targetTime = bars[26].time;
  const before = buildFiveMinutePointMap(bars).get(targetTime);
  assert(before, "expected warmed-up 5m point");

  const changedFuture = bars.map((bar) => ({ ...bar }));
  const future = changedFuture.at(-1)!;
  future.open = 180;
  future.high = 202;
  future.low = 179;
  future.close = 200;
  future.quoteVolume = future.close * future.volume;
  const after = buildFiveMinutePointMap(changedFuture).get(targetTime);

  assertEquals(after, before);
  assertEquals(before.time, targetTime);
  assert(Number.isFinite(before.ret3Atr));
  assert(Number.isFinite(before.rsiSlope));
  assert(Number.isFinite(before.stochK));
});

Deno.test("start_v5 freezes a new 120d, 100/600-shard, four-fold full-universe job", async () => {
  const now = new Date(Date.UTC(2026, 7, 28, 8, 7));
  const markets: UniverseMarket[] = Array.from({ length: V5_BACKTEST_SHARDS }, (_, index) => ({
    symbol: `M${String(index).padStart(3, "0")}USDT`,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    // The final contract listed in the current, not-yet-completed 15m bucket.
    // It remains in the frozen universe with zero expected historical bars.
    onboardDate: index === V5_BACKTEST_SHARDS - 1 ? now.getTime() - 60_000 : Date.UTC(2020, 0, 1),
  }));
  const capture: { value: CreateV5ResearchJobInput | null } = { value: null };
  const fakeJob: V5ResearchJobRow = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: V5_REVISION,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: 120,
    window_start: "2026-01-01T00:00:00.000Z",
    window_end: "2026-05-01T00:00:00.000Z",
    status: "PENDING",
    cursor: 0,
    total_markets: markets.length,
    processed_markets: 0,
    failed_markets: 0,
    config: {},
    metrics: {},
    error: null,
    started_at: null,
    completed_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const sourceSha = TEST_SOURCE_SHA;
  const result = await startV5({
    source_sha: sourceSha,
    implementation_sha256: TEST_IMPLEMENTATION_SHA256,
  }, {
    now: () => now,
    listMarkets: async () => markets,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    createJob: async (input) => {
      capture.value = input;
      return fakeJob;
    },
  });

  assert(capture.value);
  const captured = capture.value;
  const start = new Date(captured.windowStart).getTime();
  const endInclusive = new Date(captured.windowEnd).getTime();
  assertEquals(endInclusive - start + BAR_MS, V5_FOLD_POLICY.lookbackDays * DAY_MS);
  assertEquals(captured.lookbackDays, 120);
  assertEquals(captured.markets.length, V5_BACKTEST_SHARDS);
  assertEquals(captured.config?.breadth_shard_count, V5_BREADTH_SHARDS);
  assertEquals(captured.config?.breadth_time_chunks, V5_TIME_CHUNKS);
  assertEquals(captured.config?.structural_finalize_chunk_count, V5_TIME_CHUNKS);
  assertEquals(captured.config?.backtest_shard_count, V5_BACKTEST_SHARDS);
  assertEquals(captured.config?.backtest_rollup_shard_count, V5_BACKTEST_ROLLUP_SHARDS);
  assertEquals(captured.config?.checkpoints_per_rollup, V5_CHECKPOINTS_PER_ROLLUP);
  assertEquals((captured.config?.folds as unknown[]).length, 4);
  assertEquals(captured.config?.candidate_count, 19);
  assertEquals(captured.config?.source_sha, sourceSha);
  assertEquals(captured.config?.implementation_sha256, TEST_IMPLEMENTATION_SHA256);
  assertEquals(captured.config?.universe_policy, "CURRENT_ACTIVE_PERPETUAL_SNAPSHOT_AT_JOB_START");
  assertEquals(captured.config?.universe_snapshot_at, now.toISOString());
  assertEquals(captured.config?.includes_historically_delisted_contracts, false);
  assertEquals(captured.config?.research_only, true);
  assertEquals(captured.config?.production_connected, false);
  assertEquals(result.job_id, fakeJob.id);
  assertEquals(result.source_sha, sourceSha);
  assertEquals(result.implementation_sha256, TEST_IMPLEMENTATION_SHA256);
  assertEquals(result.universe_policy, "CURRENT_ACTIVE_PERPETUAL_SNAPSHOT_AT_JOB_START");
  assertEquals(result.includes_historically_delisted_contracts, false);
  assertEquals(result.structural_finalize_chunks, V5_TIME_CHUNKS);
  assertEquals(result.backtest_rollup_shards, V5_BACKTEST_ROLLUP_SHARDS);
  assertEquals(result.checkpoints_per_rollup, V5_CHECKPOINTS_PER_ROLLUP);
});

Deno.test("start_v5 rejects universe 601 because one-market shard memory is capped at 600", async () => {
  const markets: UniverseMarket[] = Array.from(
    { length: V5_BACKTEST_SHARDS + 1 },
    (_, index) => ({
      symbol: `M${String(index).padStart(3, "0")}USDT`,
      quoteAsset: "USDT",
      marginAsset: "USDT",
      onboardDate: Date.UTC(2020, 0, 1),
    }),
  );
  await assertRejectsWith(
    () =>
      startV5({
        source_sha: TEST_SOURCE_SHA,
        implementation_sha256: TEST_IMPLEMENTATION_SHA256,
      }, {
        listMarkets: async () => markets,
        runtimeIdentity: TEST_RUNTIME_IDENTITY,
      }),
    "601 exceeds 600 one-market backtest shards",
  );
});

Deno.test("V5 runtime identity is stamped, exact, and fail-closed", async () => {
  await assertRejectsWith(
    () =>
      startV5({
        source_sha: TEST_SOURCE_SHA,
        implementation_sha256: TEST_IMPLEMENTATION_SHA256,
      }),
    "runtime source SHA is unstamped",
  );
  await assertRejectsWith(
    () =>
      startV5({
        source_sha: "c".repeat(40),
        implementation_sha256: TEST_IMPLEMENTATION_SHA256,
      }, { runtimeIdentity: TEST_RUNTIME_IDENTITY }),
    "source_sha does not match the stamped runtime",
  );
  await assertRejectsWith(
    () =>
      startV5({
        source_sha: TEST_SOURCE_SHA,
        implementation_sha256: "d".repeat(64),
      }, { runtimeIdentity: TEST_RUNTIME_IDENTITY }),
    "implementation_sha256 does not match the stamped runtime",
  );
});

function finalizedSnapshot(time: number, universeCount: number): StructuralSnapshot {
  const {
    regime: _regime,
    breadthVelocity: _breadthVelocity,
    breadthAcceleration: _breadthAcceleration,
    bullScore: _bullScore,
    bearScore: _bearScore,
    rangeScore: _rangeScore,
    ...snapshot
  } = structural(time, 0);
  return {
    ...snapshot,
    validMarkets: universeCount,
    expectedMarkets: universeCount,
    majorCoverage: 3,
  };
}

function structuralPhaseJob(
  id: string,
  universe: UniverseMarket[],
  start: number,
  registryHash: string,
): V5ResearchJobRow {
  const endExclusive = start + V5_FOLD_POLICY.lookbackDays * DAY_MS;
  const now = new Date(endExclusive).toISOString();
  return {
    id,
    revision: V5_REVISION,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: V5_FOLD_POLICY.lookbackDays,
    window_start: new Date(start).toISOString(),
    window_end: new Date(endExclusive - BAR_MS).toISOString(),
    status: "RUNNING",
    cursor: 0,
    total_markets: universe.length,
    processed_markets: 0,
    failed_markets: 0,
    config: {
      universe,
      grid_start_ms: start,
      grid_end_ms: endExclusive - BAR_MS,
      window_end_exclusive_ms: endExclusive,
      grid_length: V5_FOLD_POLICY.lookbackDays * DAY_MS / BAR_MS,
      breadth_shard_count: V5_BREADTH_SHARDS,
      breadth_time_chunk_bars: V5_TIME_CHUNK_BARS,
      breadth_time_chunks: V5_TIME_CHUNKS,
      structural_finalize_chunk_count: V5_TIME_CHUNKS,
      folds: buildRollingFolds(start, endExclusive),
      candidate_registry_revision: V5_CANDIDATE_REGISTRY_REVISION,
      candidate_registry_sha256: registryHash,
      source_sha: TEST_SOURCE_SHA,
      implementation_sha256: TEST_IMPLEMENTATION_SHA256,
    },
    metrics: { phase: "STRUCTURAL_BREADTH_V5" },
    error: null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}

function structuralPartialRows(
  universe: UniverseMarket[],
  start: number,
  chunk: number,
): Record<string, unknown>[] {
  const chunkStart = chunk * V5_TIME_CHUNK_BARS;
  return Array.from({ length: V5_BREADTH_SHARDS }, (_, shard) => {
    const assigned = assignedToShard(universe, shard, V5_BREADTH_SHARDS)
      .map((market) => market.symbol);
    return {
      market: `__V5_STRUCTURAL_SHARD_${String(shard).padStart(3, "0")}__`,
      config_key: `${V5_REVISION}::STRUCTURAL_PARTIAL::CHUNK_${String(chunk).padStart(2, "0")}`,
      parameters: {
        schema_version: 1,
        router_revision: V5_REVISION,
        shard_index: shard,
        shard_count: V5_BREADTH_SHARDS,
        chunk_index: chunk,
        chunk_start_index: chunkStart,
        chunk_bars: V5_TIME_CHUNK_BARS,
        assigned_markets: assigned,
        successful_markets: assigned,
        failed_markets: [],
        accumulators: Array.from(
          { length: V5_TIME_CHUNK_BARS },
          (_, offset) =>
            createStructuralAccumulator(
              start + (chunkStart + offset) * BAR_MS,
              assigned.length,
            ),
        ),
        local_valid_30: new Array<number>(V5_TIME_CHUNK_BARS).fill(assigned.length),
        local_positive_30: new Array<number>(V5_TIME_CHUNK_BARS).fill(
          shard % 2 === 0 ? assigned.length : 0,
        ),
        generated_at: new Date(start).toISOString(),
      },
    };
  });
}

async function structuralFinalizedRows(
  universe: UniverseMarket[],
  start: number,
): Promise<Record<string, unknown>[]> {
  const universeHash = await sha256(JSON.stringify(universe.map((market) => market.symbol)));
  return Array.from({ length: V5_TIME_CHUNKS }, (_, chunk) => {
    const chunkStart = chunk * V5_TIME_CHUNK_BARS;
    const firstTime = start + chunkStart * BAR_MS;
    return {
      market: `__V5_STRUCTURAL_FINALIZED_CHUNK_${String(chunk).padStart(2, "0")}__`,
      config_key: `${V5_REVISION}::STRUCTURAL_FINALIZED_CHUNK`,
      parameters: {
        schema_version: 1,
        router_revision: V5_REVISION,
        chunk_index: chunk,
        chunk_count: V5_TIME_CHUNKS,
        chunk_start_index: chunkStart,
        chunk_bars: V5_TIME_CHUNK_BARS,
        first_time_ms: firstTime,
        last_time_ms: firstTime + (V5_TIME_CHUNK_BARS - 1) * BAR_MS,
        breadth_shard_count: V5_BREADTH_SHARDS,
        source_partial_rows: V5_BREADTH_SHARDS,
        universe_count: universe.length,
        universe_symbols_sha256: universeHash,
        snapshots: Array.from(
          { length: V5_TIME_CHUNK_BARS },
          (_, offset) => finalizedSnapshot(firstTime + offset * BAR_MS, universe.length),
        ),
        local_breadth_30: new Array<number>(V5_TIME_CHUNK_BARS).fill(0.5),
        generated_at: new Date(start).toISOString(),
      },
    };
  });
}

Deno.test("breadth shard retries are idempotent only in STRUCTURAL_BREADTH_V5", async () => {
  const start = Date.UTC(2026, 0, 1);
  const endExclusive = start + V5_FOLD_POLICY.lookbackDays * DAY_MS;
  const onboardDate = endExclusive - DAY_MS;
  const universe: UniverseMarket[] = [{
    symbol: "NEWBREADTHUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate,
  }];
  const job = structuralPhaseJob(
    "12121212-1212-4212-8212-121212121212",
    universe,
    start,
    "a".repeat(64),
  );
  const writes: Record<string, unknown>[] = [];
  let fetches = 0;
  const rawStore = {
    select: async (_path: string): Promise<unknown[]> => [],
    upsert: async (row: Record<string, unknown>): Promise<void> => {
      writes.push(structuredClone(row));
    },
    exactCount: async (_query: string): Promise<number> => 0,
  };
  const request = {
    job_id: job.id,
    shard_index: 0,
    shard_count: V5_BREADTH_SHARDS,
  };
  const overrides = (loadedJob: V5ResearchJobRow = job) => ({
    now: () => new Date(endExclusive),
    loadJob: async () => loadedJob,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    fetch15m: async () => {
      fetches++;
      return continuousBars(onboardDate, DAY_MS / BAR_MS, BAR_MS);
    },
    rawStore,
  });

  const first = await breadthShardV5(request, overrides());
  const retry = await breadthShardV5(request, overrides());
  assertEquals(retry, first);
  assertEquals(fetches, 2);
  assertEquals(writes.length, 2 * V5_TIME_CHUNKS);
  assertEquals(writes.slice(V5_TIME_CHUNKS), writes.slice(0, V5_TIME_CHUNKS));

  const completeJob: V5ResearchJobRow = {
    ...job,
    status: "COMPLETE",
    metrics: { ...job.metrics },
    completed_at: new Date(endExclusive).toISOString(),
  };
  await assertRejectsWith(
    () => breadthShardV5(request, overrides(completeJob)),
    "breadth_shard_v5 requires STRUCTURAL_BREADTH_V5 phase",
  );
  await assertRejectsWith(
    () =>
      breadthShardV5(
        request,
        overrides({
          ...job,
          metrics: { ...job.metrics, phase: "BACKTEST_V5" },
        }),
      ),
    "breadth_shard_v5 requires STRUCTURAL_BREADTH_V5 phase",
  );
  assertEquals(fetches, 2);
  assertEquals(writes.length, 2 * V5_TIME_CHUNKS);
});

Deno.test("finalize_chunk_v5 pages one exact chunk and writes an accumulator-free idempotent sentinel", async () => {
  const start = Date.UTC(2026, 0, 1);
  const universe: UniverseMarket[] = Array.from({ length: V5_BREADTH_SHARDS }, (_, index) => ({
    symbol: `M${String(index).padStart(3, "0")}USDT`,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: Date.UTC(2020, 0, 1),
  }));
  const job = structuralPhaseJob(
    "44444444-4444-4444-8444-444444444444",
    universe,
    start,
    "a".repeat(64),
  );
  const partialRows = structuralPartialRows(universe, start, 0);
  const pageOffsets: number[] = [];
  const upserts: Record<string, unknown>[] = [];
  let exactPartialRows = V5_BREADTH_SHARDS;
  const overrides = {
    now: () => new Date(start),
    loadJob: async () => job,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    rawStore: {
      select: async (path: string) => {
        const parsed = new URL(`https://example.test/${path}`);
        const offset = Number(parsed.searchParams.get("offset"));
        const limit = Number(parsed.searchParams.get("limit"));
        pageOffsets.push(offset);
        return partialRows.slice(offset, offset + limit);
      },
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(structuredClone(row));
      },
      exactCount: async () => exactPartialRows,
    },
  };
  const request = {
    job_id: job.id,
    chunk_index: 0,
    chunk_count: V5_TIME_CHUNKS,
  };
  const first = await finalizeChunkV5(request, overrides);
  const second = await finalizeChunkV5(request, overrides);
  assertEquals(first, second);
  assertEquals(first.partial_rows, V5_BREADTH_SHARDS);
  assertEquals(first.structural_snapshots, V5_TIME_CHUNK_BARS);
  assertEquals(first.raw_accumulators_in_finalized_chunk, false);
  assertEquals(
    pageOffsets,
    [
      ...Array.from({ length: 10 }, (_, index) => index * 10),
      ...Array.from({ length: 10 }, (_, index) => index * 10),
    ],
  );
  assertEquals(upserts.length, 2);
  assertEquals(upserts[0].market, "__V5_STRUCTURAL_FINALIZED_CHUNK_00__");
  assertEquals(upserts[0].family, "STRUCTURAL_FINALIZED_CHUNK_V5");
  assertEquals(upserts[0].config_key, `${V5_REVISION}::STRUCTURAL_FINALIZED_CHUNK`);
  const finalized = upserts[0].parameters as Record<string, unknown>;
  assertEquals("accumulators" in finalized, false);
  assertEquals((finalized.snapshots as unknown[]).length, V5_TIME_CHUNK_BARS);
  assertEquals((finalized.local_breadth_30 as number[])[0], 0.5);

  exactPartialRows = V5_BREADTH_SHARDS - 1;
  await assertRejectsWith(
    () => finalizeChunkV5(request, overrides),
    "partial rows 99/100",
  );
  exactPartialRows = V5_BREADTH_SHARDS;
  const firstParameters = partialRows[0].parameters as Record<string, unknown>;
  firstParameters.failed_markets = [{ market: universe[0].symbol, error: "fixture failure" }];
  await assertRejectsWith(
    () => finalizeChunkV5(request, overrides),
    "identity mismatch",
  );
  firstParameters.failed_markets = [];
  (job.config as Record<string, unknown>).implementation_sha256 = "c".repeat(64);
  await assertRejectsWith(
    () => finalizeChunkV5(request, overrides),
    "job implementation SHA-256 does not match the current runtime",
  );
});

Deno.test("finalize_v5 requires all finalized chunks in exact chronological identity order", async () => {
  const start = Date.UTC(2026, 0, 1);
  const universe: UniverseMarket[] = [{
    symbol: "BTCUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: Date.UTC(2020, 0, 1),
  }];
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const job = structuralPhaseJob(
    "55555555-5555-4555-8555-555555555555",
    universe,
    start,
    registryHash,
  );
  const rows = await structuralFinalizedRows(universe, start);
  let exactRows = V5_TIME_CHUNKS;
  let selectedRows = rows;
  let updateMetrics: Record<string, unknown> | undefined;
  const overrides = {
    now: () => new Date(start + 120 * DAY_MS),
    loadJob: async () => job,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    updateJob: async (_jobId: string, update: { metrics?: Record<string, unknown> }) => {
      updateMetrics = update.metrics;
      return { ...job, metrics: { ...job.metrics, ...update.metrics } };
    },
    rawStore: {
      select: async () => selectedRows,
      upsert: async () => {},
      exactCount: async () => exactRows,
    },
  };
  const result = await finalizeV5({ job_id: job.id }, overrides);
  assertEquals(result.structural_points, 120 * DAY_MS / BAR_MS);
  assertEquals(result.finalized_chunk_rows, V5_TIME_CHUNKS);
  assertEquals(result.raw_accumulators_in_job_metrics, false);
  assertEquals(updateMetrics?.phase, "BACKTEST_V5");
  assertEquals(updateMetrics?.finalized_chunk_rows, V5_TIME_CHUNKS);
  assertEquals(
    (updateMetrics?.structural_series as { gridLength: number }).gridLength,
    120 * DAY_MS / BAR_MS,
  );

  exactRows = V5_TIME_CHUNKS - 1;
  await assertRejectsWith(
    () => finalizeV5({ job_id: job.id }, overrides),
    "finalized structural chunk rows 11/12",
  );
  exactRows = V5_TIME_CHUNKS;
  selectedRows = [rows[1], rows[0], ...rows.slice(2)];
  await assertRejectsWith(
    () => finalizeV5({ job_id: job.id }, overrides),
    "row order mismatch",
  );
  selectedRows = rows;
  const chunkParameters = rows[3].parameters as Record<string, unknown>;
  chunkParameters.chunk_start_index = 1;
  await assertRejectsWith(
    () => finalizeV5({ job_id: job.id }, overrides),
    "malformed V5 finalized structural chunk 3",
  );
});

Deno.test("finalize_v5 compares JSONB-reordered fold objects by value", async () => {
  const start = Date.UTC(2026, 0, 1);
  const endExclusive = start + V5_FOLD_POLICY.lookbackDays * DAY_MS;
  const universe: UniverseMarket[] = [{
    symbol: "BTCUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: Date.UTC(2020, 0, 1),
  }];
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const job = structuralPhaseJob(
    "89898989-8989-4989-8989-898989898989",
    universe,
    start,
    registryHash,
  );
  const expectedFolds = buildRollingFolds(start, endExclusive);
  const jsonbReorderedFolds = expectedFolds.map((fold) => ({
    id: fold.id,
    testEnd: fold.testEnd,
    trainEnd: fold.trainEnd,
    testStart: fold.testStart,
    trainStart: fold.trainStart,
    embargoBars: fold.embargoBars,
    validationEnd: fold.validationEnd,
    validationStart: fold.validationStart,
  }));
  assert(
    JSON.stringify(jsonbReorderedFolds) !== JSON.stringify(expectedFolds),
    "fixture must model a jsonb object-key reorder",
  );
  (job.config as Record<string, unknown>).folds = jsonbReorderedFolds;
  const rows = await structuralFinalizedRows(universe, start);
  const overrides = {
    now: () => new Date(endExclusive),
    loadJob: async () => job,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    updateJob: async (_jobId: string, update: UpdateV5ResearchJobInput) => ({
      ...job,
      status: update.status ?? job.status,
      metrics: { ...job.metrics, ...(update.metrics || {}) },
    }),
    rawStore: {
      select: async () => rows,
      upsert: async () => {},
      exactCount: async () => V5_TIME_CHUNKS,
    },
  };

  const result = await finalizeV5({ job_id: job.id }, overrides);
  assertEquals(result.structural_points, V5_FOLD_POLICY.lookbackDays * DAY_MS / BAR_MS);

  jsonbReorderedFolds[0].testEnd += BAR_MS;
  await assertRejectsWith(
    () => finalizeV5({ job_id: job.id }, overrides),
    "configured rolling folds do not match the frozen grid",
  );
});

Deno.test("finalize_v5 lost-response retries revalidate and never mutate finalized jobs", async () => {
  const start = Date.UTC(2026, 0, 1);
  const universe: UniverseMarket[] = [{
    symbol: "BTCUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: Date.UTC(2020, 0, 1),
  }];
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  let currentJob = structuralPhaseJob(
    "66666666-6666-4666-8666-666666666666",
    universe,
    start,
    registryHash,
  );
  const rows = await structuralFinalizedRows(universe, start);
  let finalizedRowCount = V5_TIME_CHUNKS;
  let selectCalls = 0;
  let updateCalls = 0;
  const now = new Date(start + V5_FOLD_POLICY.lookbackDays * DAY_MS);
  const overrides = {
    now: () => now,
    loadJob: async () => structuredClone(currentJob),
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    updateJob: async (_jobId: string, update: UpdateV5ResearchJobInput) => {
      updateCalls++;
      let startedAt = currentJob.started_at;
      if (update.startedAt !== undefined) {
        startedAt = update.startedAt === null
          ? null
          : update.startedAt instanceof Date
          ? update.startedAt.toISOString()
          : new Date(update.startedAt).toISOString();
      }
      currentJob = {
        ...currentJob,
        status: update.status ?? currentJob.status,
        started_at: startedAt,
        error: update.error === undefined ? currentJob.error : update.error,
        metrics: { ...currentJob.metrics, ...(update.metrics || {}) },
      };
      return structuredClone(currentJob);
    },
    rawStore: {
      select: async () => {
        selectCalls++;
        return rows;
      },
      upsert: async () => {},
      exactCount: async () => finalizedRowCount,
    },
  };

  // Model a response that was lost after updateJob committed BACKTEST_V5.
  const first = await finalizeV5({ job_id: currentJob.id }, overrides);
  const persistedFolds = currentJob.metrics.folds as ReturnType<typeof buildRollingFolds>;
  currentJob = {
    ...currentJob,
    metrics: {
      ...currentJob.metrics,
      folds: persistedFolds.map((fold) => ({
        id: fold.id,
        testEnd: fold.testEnd,
        trainEnd: fold.trainEnd,
        testStart: fold.testStart,
        trainStart: fold.trainStart,
        embargoBars: fold.embargoBars,
        validationEnd: fold.validationEnd,
        validationStart: fold.validationStart,
      })),
    },
  };
  const committedAfterFirst = structuredClone(currentJob);
  const retry = await finalizeV5({ job_id: currentJob.id }, overrides);
  assertEquals(retry, first);
  assertEquals(currentJob, committedAfterFirst);
  assertEquals(updateCalls, 1);
  assertEquals(selectCalls, 1);

  currentJob = {
    ...currentJob,
    status: "COMPLETE",
    metrics: { ...currentJob.metrics, phase: "COMPLETE_V5" },
  };
  const completedBeforeRetry = structuredClone(currentJob);
  const completedRetry = await finalizeV5({ job_id: currentJob.id }, overrides);
  assertEquals(completedRetry, first);
  assertEquals(currentJob, completedBeforeRetry);
  assertEquals(updateCalls, 1);
  assertEquals(selectCalls, 1);

  const validCompact = currentJob.metrics.structural_series as Record<string, unknown>;
  currentJob = {
    ...currentJob,
    metrics: {
      ...currentJob.metrics,
      structural_series: { ...validCompact, registryHash: "f".repeat(64) },
    },
  };
  await assertRejectsWith(
    () => finalizeV5({ job_id: currentJob.id }, overrides),
    "persisted compact structural identity mismatch",
  );
  currentJob = {
    ...currentJob,
    metrics: { ...currentJob.metrics, structural_series: validCompact },
  };

  const validFolds = currentJob.metrics.folds;
  currentJob = {
    ...currentJob,
    metrics: { ...currentJob.metrics, folds: [] },
  };
  await assertRejectsWith(
    () => finalizeV5({ job_id: currentJob.id }, overrides),
    "persisted structural finalization metadata is malformed or mixed",
  );
  currentJob = {
    ...currentJob,
    metrics: { ...currentJob.metrics, folds: validFolds },
  };

  finalizedRowCount = V5_TIME_CHUNKS - 1;
  await assertRejectsWith(
    () => finalizeV5({ job_id: currentJob.id }, overrides),
    "finalized structural chunk rows 11/12",
  );
});

Deno.test("V5 production review fails closed when final fold TEST loses edge", () => {
  const metrics: CandidateFoldMetric[] = [];
  for (const candidate of ["A", "B"]) {
    for (let fold = 1; fold <= 4; fold++) {
      metrics.push(
        {
          candidate,
          neighborGroup: "G",
          fold,
          split: "TRAIN",
          trades: 50,
          profitFactor: 1.2,
          stressNetPnlBps: 100,
        },
        {
          candidate,
          neighborGroup: "G",
          fold,
          split: "VALIDATION",
          trades: 20,
          profitFactor: 1.1,
          stressNetPnlBps: 30,
        },
        {
          candidate,
          neighborGroup: "G",
          fold,
          split: "TEST",
          trades: 20,
          profitFactor: candidate === "A" && fold === 4 ? 0.9 : 1.1,
          stressNetPnlBps: candidate === "A" && fold === 4 ? -5 : 20,
        },
      );
    }
  }
  const reports = evaluateCandidateValidation(metrics);
  const allPass = new Map([
    ["A", true],
    ["B", true],
  ]);
  const quality = new Map([
    ["A", { pass: true, failures: [] }],
    ["B", { pass: true, failures: [] }],
  ]);
  const gated = applyProductionReviewGates(reports, allPass, quality, quality);
  const a = gated.find((report) => report.candidate === "A")!;
  const b = gated.find((report) => report.candidate === "B")!;

  assertEquals(a.selectionEligible, true);
  assertEquals(a.historicalTestPass, false);
  assertEquals(a.productionReviewEligible, false);
  assertEquals(b.productionReviewEligible, true);
  assertEquals(a.testUsedForSelection, false);
});

Deno.test("600 logical backtest shards cover the universe once with at most one market each", () => {
  const markets = Array.from({ length: 567 }, (_, index) => `M${index}`);
  const assigned = Array.from(
    { length: V5_BACKTEST_SHARDS },
    (_, shard) => assignedToShard(markets, shard, V5_BACKTEST_SHARDS),
  );
  assert(assigned.every((shard) => shard.length <= 1));
  assertEquals(assigned.flat(), markets);
});

Deno.test("60 backtest rollups cover all logical checkpoints in fixed groups of ten", () => {
  const shardGroups = Array.from({ length: V5_BACKTEST_ROLLUP_SHARDS }, (_, rollup) =>
    Array.from(
      { length: V5_CHECKPOINTS_PER_ROLLUP },
      (_, index) => rollup * V5_CHECKPOINTS_PER_ROLLUP + index,
    ));
  assertEquals(V5_CHECKPOINTS_PER_ROLLUP, 10);
  assertEquals(shardGroups.flat(), Array.from({ length: V5_BACKTEST_SHARDS }, (_, index) => index));
});

Deno.test("exit categorization treats trailing, time, max-hold, and other exits distinctly", () => {
  assertEquals(
    categorizeExitReasons({
      TARGET: 1,
      STOP: 1,
      STOP_GAP: 1,
      TRAIL_CLOSE_EXIT: 1,
      TIME_STOP: 1,
      MAX_HOLD: 1,
      REGIME_EXIT: 1,
    }, 7),
    {
      targetHits: 1,
      stopHits: 3,
      timeExits: 1,
      maxHoldExits: 1,
      otherExits: 1,
    },
  );
});

Deno.test("history disposition requires the complete frozen tail, not merely seven days", () => {
  const end = Date.UTC(2026, 7, 28);
  const start = end - 120 * DAY_MS;
  const fullWindowBars = (end - start) / BAR_MS;
  assertEquals(
    marketHistoryDisposition(end - 6 * DAY_MS, start, end, 0),
    "ZERO_TRADES_WARMUP",
  );
  assertEquals(
    marketHistoryDisposition(end + FIVE_MINUTE_MS, start, end, 0),
    "ZERO_TRADES_WARMUP",
  );
  assertEquals(
    marketHistoryDisposition(
      end - 7 * DAY_MS,
      start,
      end,
      V5_MARKET_WARMUP_BARS - 1,
    ),
    "DATA_FAILURE",
  );
  assertEquals(
    marketHistoryDisposition(null, start, end, V5_MARKET_WARMUP_BARS),
    "DATA_FAILURE",
  );
  assertEquals(
    marketHistoryDisposition(null, start, end, fullWindowBars),
    "SIMULATE",
  );
  assertEquals(
    marketHistoryDisposition(end - 30 * DAY_MS, start, end, 30 * DAY_MS / BAR_MS),
    "SIMULATE",
  );
});

Deno.test("backtest shard fails closed when one required 5m tail child is missing", async () => {
  const start = Date.UTC(2026, 0, 1);
  const endExclusive = start + 120 * DAY_MS;
  const endInclusive = endExclusive - BAR_MS;
  const gridLength = 120 * DAY_MS / BAR_MS;
  const onboardDate = endExclusive - 8 * DAY_MS;
  const market: UniverseMarket = {
    symbol: "EIGHTDAYUSDT",
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate,
  };
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const compact = await packStructuralSeries(
    Array.from(
      { length: gridLength },
      (_, index) => structural(start + index * BAR_MS, 0),
    ),
    new Array<number>(gridLength).fill(0.5),
    new Array<number>(gridLength).fill(0),
    start,
    registryHash,
  );
  const now = new Date(endExclusive);
  const job: V5ResearchJobRow = {
    id: "88888888-8888-4888-8888-888888888888",
    revision: V5_REVISION,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: 120,
    window_start: new Date(start).toISOString(),
    window_end: new Date(endInclusive).toISOString(),
    status: "RUNNING",
    cursor: 0,
    total_markets: 1,
    processed_markets: 0,
    failed_markets: 0,
    config: {
      universe: [market],
      grid_start_ms: start,
      grid_end_ms: endInclusive,
      window_end_exclusive_ms: endExclusive,
      grid_length: gridLength,
      backtest_shard_count: V5_BACKTEST_SHARDS,
      candidate_registry_sha256: registryHash,
      source_sha: TEST_SOURCE_SHA,
      implementation_sha256: TEST_IMPLEMENTATION_SHA256,
    },
    metrics: { phase: "BACKTEST_V5", structural_series: compact },
    error: null,
    started_at: now.toISOString(),
    completed_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const fifteenMinuteCount = (endExclusive - onboardDate) / BAR_MS;
  const fiveMinuteCount = (endExclusive - onboardDate) / FIVE_MINUTE_MS;
  const checkpoints: Record<string, unknown>[] = [];
  let resultWrites = 0;
  const result = await backtestShardV5({
    job_id: job.id,
    shard_index: 0,
    shard_count: V5_BACKTEST_SHARDS,
  }, {
    now: () => now,
    loadJob: async () => job,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    fetch15m: async () => continuousBars(onboardDate, fifteenMinuteCount, BAR_MS),
    fetch5m: async () => continuousBars(onboardDate, fiveMinuteCount - 1, FIVE_MINUTE_MS),
    upsertResults: async () => {
      resultWrites++;
      return 0;
    },
    rawStore: {
      select: async () => [],
      upsert: async (row) => {
        checkpoints.push(structuredClone(row));
      },
      exactCount: async () => 0,
    },
  });

  assertEquals(result.ok, false);
  assertEquals(resultWrites, 0);
  assertEquals(checkpoints.length, 1);
  const failures = result.failed_markets as Array<{ market: string; error: string }>;
  assertEquals(failures.length, 1);
  assert(failures[0].error.includes("incomplete 5m coverage"));
});

Deno.test("new-listing shard/rollup retries are idempotent and COMPLETE phase is immutable", async () => {
  const start = Date.UTC(2026, 0, 1);
  const endExclusive = start + 120 * DAY_MS;
  const endInclusive = endExclusive - BAR_MS;
  const gridLength = 120 * DAY_MS / BAR_MS;
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const points = Array.from(
    { length: gridLength },
    (_, index) => structural(start + index * BAR_MS, 0),
  );
  const compact = await packStructuralSeries(
    points,
    new Array<number>(gridLength).fill(0.5),
    new Array<number>(gridLength).fill(0),
    start,
    registryHash,
  );
  const universe: UniverseMarket[] = Array.from({ length: 10 }, (_, index) => ({
    symbol: `NEW${index}USDT`,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: endExclusive - DAY_MS,
  }));
  const now = new Date(endExclusive);
  const job: V5ResearchJobRow = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: V5_REVISION,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: 120,
    window_start: new Date(start).toISOString(),
    window_end: new Date(endInclusive).toISOString(),
    status: "RUNNING",
    cursor: 0,
    total_markets: universe.length,
    processed_markets: 0,
    failed_markets: 0,
    config: {
      universe,
      grid_start_ms: start,
      grid_end_ms: endInclusive,
      window_end_exclusive_ms: endExclusive,
      grid_length: gridLength,
      backtest_shard_count: V5_BACKTEST_SHARDS,
      backtest_rollup_shard_count: V5_BACKTEST_ROLLUP_SHARDS,
      checkpoints_per_rollup: V5_CHECKPOINTS_PER_ROLLUP,
      candidate_registry_sha256: registryHash,
      source_sha: TEST_SOURCE_SHA,
      implementation_sha256: TEST_IMPLEMENTATION_SHA256,
    },
    metrics: { phase: "BACKTEST_V5", structural_series: compact },
    error: null,
    started_at: now.toISOString(),
    completed_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const rawRows: Record<string, unknown>[] = [];
  const resultRows: V5MarketResultInput[][] = [];
  let fetchCalls = 0;
  const rawStore = {
    select: async (_path: string): Promise<unknown[]> => [],
    upsert: async (row: Record<string, unknown>): Promise<void> => {
      rawRows.push(structuredClone(row));
    },
    exactCount: async (_query: string): Promise<number> => 0,
  };
  const shardRequest = {
    job_id: job.id,
    shard_index: 0,
    shard_count: V5_BACKTEST_SHARDS,
  };
  const shardOverrides = (loadedJob: V5ResearchJobRow = job) => ({
    now: () => now,
    loadJob: async () => loadedJob,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    fetch15m: async () => {
      fetchCalls++;
      return [];
    },
    fetch5m: async () => {
      fetchCalls++;
      return [];
    },
    upsertResults: async (_jobId: string, rows: readonly V5MarketResultInput[]) => {
      resultRows.push([...rows]);
      return rows.length;
    },
    rawStore,
  });
  const shardResult = await backtestShardV5(shardRequest, shardOverrides());
  const shardRetry = await backtestShardV5(shardRequest, shardOverrides());
  assertEquals(shardResult.ok, true);
  assertEquals(shardRetry, shardResult);
  assertEquals(fetchCalls, 0);
  assertEquals(resultRows[0].length, 19 * 4 * 3);
  assertEquals(resultRows[1], resultRows[0]);
  assert(resultRows[0].every((row) => row.metrics.trades === 0));
  assert(
    resultRows[0].every((row) =>
      row.parameters?.data_eligibility === "NEW_LISTING_7D_WARMUP_ZERO_TRADES"
    ),
  );

  const checkpointWrites = rawRows.filter((row) => row.family === "BACKTEST_CHECKPOINT_V5");
  assertEquals(checkpointWrites.length, 2);
  assertEquals(checkpointWrites[1], checkpointWrites[0]);
  const firstCheckpoint = checkpointWrites[0];
  const checkpointRows = Array.from({ length: V5_CHECKPOINTS_PER_ROLLUP }, (_, shard) => {
    const row = structuredClone(firstCheckpoint);
    row.market = `__V5_BACKTEST_SHARD_${String(shard).padStart(3, "0")}__`;
    const parameters = row.parameters as Record<string, unknown>;
    parameters.shard_index = shard;
    parameters.assigned_markets = [universe[shard].symbol];
    parameters.successful_markets = [universe[shard].symbol];
    return row;
  });
  rawStore.select = async () => checkpointRows;
  const rollupRequest = {
    job_id: job.id,
    rollup_index: 0,
    rollup_count: V5_BACKTEST_ROLLUP_SHARDS,
  };
  const rollupOverrides = (loadedJob: V5ResearchJobRow = job) => ({
    now: () => now,
    loadJob: async () => loadedJob,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    rawStore,
  });
  const rollupResult = await backtestRollupV5(rollupRequest, rollupOverrides());
  const rollupRetry = await backtestRollupV5(rollupRequest, rollupOverrides());
  assertEquals(rollupResult.ok, true);
  assertEquals(rollupRetry, rollupResult);
  assertEquals(rollupResult.checkpoint_shards, V5_CHECKPOINTS_PER_ROLLUP);
  const rollupWrites = rawRows.filter((row) => row.family === "BACKTEST_ROLLUP_V5");
  assertEquals(rollupWrites.length, 2);
  assertEquals(rollupWrites[1], rollupWrites[0]);
  const rollupRow = rollupWrites[0];
  const rollup = rollupRow.parameters as Record<string, unknown>;
  assertEquals(rollup.shard_indices, Array.from({ length: 10 }, (_, index) => index));
  assertEquals((rollup.assigned_markets as unknown[]).length, 10);
  assertEquals(rollup.result_rows, 10 * 19 * 4 * 3);
  assertEquals((rollup.aggregates as unknown[]).length, 19 * 4 * 3);

  const completeJob: V5ResearchJobRow = {
    ...job,
    status: "COMPLETE",
    metrics: { ...job.metrics },
    completed_at: now.toISOString(),
  };
  const wrongPhaseJob: V5ResearchJobRow = {
    ...job,
    metrics: { ...job.metrics, phase: "COMPLETE_V5" },
  };
  const writesBeforeCompleteRetries = rawRows.length;
  const resultWritesBeforeCompleteRetries = resultRows.length;
  await assertRejectsWith(
    () => backtestShardV5(shardRequest, shardOverrides(completeJob)),
    "backtest_shard_v5 requires RUNNING BACKTEST_V5 phase",
  );
  await assertRejectsWith(
    () => backtestRollupV5(rollupRequest, rollupOverrides(completeJob)),
    "backtest_rollup_v5 requires RUNNING BACKTEST_V5 phase",
  );
  await assertRejectsWith(
    () => backtestShardV5(shardRequest, shardOverrides(wrongPhaseJob)),
    "backtest_shard_v5 requires RUNNING BACKTEST_V5 phase",
  );
  await assertRejectsWith(
    () => backtestRollupV5(rollupRequest, rollupOverrides(wrongPhaseJob)),
    "backtest_rollup_v5 requires RUNNING BACKTEST_V5 phase",
  );
  await assertRejectsWith(
    () =>
      breadthShardV5({
        job_id: job.id,
        shard_index: 0,
        shard_count: V5_BREADTH_SHARDS,
      }, {
        loadJob: async () => completeJob,
        runtimeIdentity: TEST_RUNTIME_IDENTITY,
        rawStore,
      }),
    "breadth_shard_v5 requires STRUCTURAL_BREADTH_V5 phase",
  );
  assertEquals(rawRows.length, writesBeforeCompleteRetries);
  assertEquals(resultRows.length, resultWritesBeforeCompleteRetries);
});

Deno.test("status pages all sixty bounded rollups and verifies the exact frozen universe", async () => {
  const start = Date.UTC(2026, 0, 1);
  const endExclusive = start + 120 * DAY_MS;
  const endInclusive = endExclusive - BAR_MS;
  const gridLength = 120 * DAY_MS / BAR_MS;
  const registryHash = await sha256(CANDIDATE_REGISTRY_HASH_INPUT);
  const frozenCandidates = candidates();
  const folds = buildRollingFolds(start, endExclusive);
  const jsonbReorderedFolds = folds.map((fold) => ({
    id: fold.id,
    testEnd: fold.testEnd,
    trainEnd: fold.trainEnd,
    testStart: fold.testStart,
    trainStart: fold.trainStart,
    embargoBars: fold.embargoBars,
    validationEnd: fold.validationEnd,
    validationStart: fold.validationStart,
  }));
  const jsonbReorderedRiskGate = {
    minimumMfeCapture: V5_PRODUCTION_REVIEW_RISK_GATE.minimumMfeCapture,
    minimumStressToMdd: V5_PRODUCTION_REVIEW_RISK_GATE.minimumStressToMdd,
    maximumGivebackToMfe: V5_PRODUCTION_REVIEW_RISK_GATE.maximumGivebackToMfe,
    minimumUniqueSignalDays: {
      TRAIN: V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.TRAIN,
      FINAL_TEST: V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.FINAL_TEST,
      VALIDATION: V5_PRODUCTION_REVIEW_RISK_GATE.minimumUniqueSignalDays.VALIDATION,
    },
    minimumProfitableTimeChunks: V5_PRODUCTION_REVIEW_RISK_GATE.minimumProfitableTimeChunks,
    maximumPositiveTimeChunkShare: V5_PRODUCTION_REVIEW_RISK_GATE.maximumPositiveTimeChunkShare,
  };
  assert(JSON.stringify(jsonbReorderedFolds) !== JSON.stringify(folds));
  assert(
    JSON.stringify(jsonbReorderedRiskGate) !==
      JSON.stringify(V5_PRODUCTION_REVIEW_RISK_GATE),
  );
  const universe: UniverseMarket[] = Array.from({ length: 500 }, (_, index) => ({
    symbol: `M${String(index).padStart(3, "0")}USDT`,
    quoteAsset: "USDT",
    marginAsset: "USDT",
    onboardDate: Date.UTC(2020, 0, 1),
  }));
  const compact = await packStructuralSeries(
    Array.from({ length: gridLength }, (_, index) => structural(start + index * BAR_MS, 0)),
    new Array<number>(gridLength).fill(0.5),
    new Array<number>(gridLength).fill(0),
    start,
    registryHash,
  );
  const job: V5ResearchJobRow = {
    id: "33333333-3333-4333-8333-333333333333",
    revision: V5_REVISION,
    venue: "binance_futures",
    bar_interval: "1h",
    lookback_days: 120,
    window_start: new Date(start).toISOString(),
    window_end: new Date(endInclusive).toISOString(),
    status: "RUNNING",
    cursor: 0,
    total_markets: universe.length,
    processed_markets: 0,
    failed_markets: 0,
    config: {
      universe,
      grid_start_ms: start,
      grid_end_ms: endInclusive,
      window_end_exclusive_ms: endExclusive,
      grid_length: gridLength,
      source_sha: "a".repeat(40),
      implementation_sha256: TEST_IMPLEMENTATION_SHA256,
      candidate_count: frozenCandidates.length,
      candidate_registry_sha256: registryHash,
      breadth_shard_count: V5_BREADTH_SHARDS,
      breadth_time_chunks: V5_TIME_CHUNKS,
      structural_finalize_chunk_count: V5_TIME_CHUNKS,
      backtest_shard_count: V5_BACKTEST_SHARDS,
      backtest_rollup_shard_count: V5_BACKTEST_ROLLUP_SHARDS,
      checkpoints_per_rollup: V5_CHECKPOINTS_PER_ROLLUP,
      production_review_risk_gate: jsonbReorderedRiskGate,
      folds: jsonbReorderedFolds,
    },
    metrics: { phase: "BACKTEST_V5", structural_series: compact },
    error: null,
    started_at: new Date(start).toISOString(),
    completed_at: null,
    created_at: new Date(start).toISOString(),
    updated_at: new Date(start).toISOString(),
  };
  const zeroAggregates = frozenCandidates.flatMap((candidate) =>
    folds.flatMap((fold) =>
      (["TRAIN", "VALIDATION", "TEST"] as const).map((split) => ({
        candidate: candidate.name,
        family: candidate.family,
        state: candidate.state,
        neighbor_group: candidate.neighborGroup,
        fold: fold.id,
        split,
        eligible_bars: 0,
        regime_bars: 0,
        trades: 0,
        wins: 0,
        gross_pnl_bps: 0,
        net_pnl_bps: 0,
        stress_net_pnl_bps: 0,
        net_profit_bps: 0,
        net_loss_bps: 0,
        mfe_sum_bps: 0,
        mae_sum_bps: 0,
        capture_sum: 0,
        capture_count: 0,
        giveback_sum_bps: 0,
        hold_sum_bars: 0,
        exit_reason_counts: {},
        signal_day_indices: [],
        exit_net_by_grid_index: [],
        time_chunk_net_bps: new Array<number>(V5_TIME_CHUNKS).fill(0),
      }))
    )
  );
  const rollupRows = Array.from({ length: V5_BACKTEST_ROLLUP_SHARDS }, (_, rollup) => {
    const shardIndices = Array.from(
      { length: V5_CHECKPOINTS_PER_ROLLUP },
      (_, index) => rollup * V5_CHECKPOINTS_PER_ROLLUP + index,
    );
    const assigned = shardIndices.flatMap((shard) =>
      assignedToShard(universe, shard, V5_BACKTEST_SHARDS).map((market) => market.symbol)
    ).sort();
    return {
      market: `__V5_BACKTEST_ROLLUP_${String(rollup).padStart(3, "0")}__`,
      config_key: `${V5_REVISION}::BACKTEST_ROLLUP`,
      parameters: {
        schema_version: 1,
        router_revision: V5_REVISION,
        rollup_index: rollup,
        rollup_count: V5_BACKTEST_ROLLUP_SHARDS,
        checkpoints_per_rollup: V5_CHECKPOINTS_PER_ROLLUP,
        shard_indices: shardIndices,
        assigned_markets: assigned,
        successful_markets: assigned,
        failed_markets: [],
        candidate_count: frozenCandidates.length,
        fold_count: folds.length,
        split_count: 3,
        result_rows: assigned.length * zeroAggregates.length,
        expected_result_rows: assigned.length * zeroAggregates.length,
        aggregates: zeroAggregates,
        generated_at: new Date(endExclusive).toISOString(),
      },
    };
  });
  const pageOffsets: number[] = [];
  const expectedRows = universe.length * frozenCandidates.length * folds.length * 3;
  let updated = false;
  const status = await statusV5({ job_id: job.id }, {
    now: () => new Date(endExclusive),
    loadJob: async () => job,
    runtimeIdentity: TEST_RUNTIME_IDENTITY,
    updateJob: async (_jobId, update) => {
      updated = update.status === "COMPLETE";
      return { ...job, status: "COMPLETE" };
    },
    rawStore: {
      select: async (path) => {
        const parsed = new URL(`https://example.test/${path}`);
        const offset = Number(parsed.searchParams.get("offset"));
        const limit = Number(parsed.searchParams.get("limit"));
        pageOffsets.push(offset);
        return rollupRows.slice(offset, offset + limit);
      },
      upsert: async () => {},
      exactCount: async (query) => {
        const decoded = decodeURIComponent(query);
        if (decoded.includes("family=eq.STRUCTURAL_PARTIAL_V5")) {
          return V5_BREADTH_SHARDS * V5_TIME_CHUNKS;
        }
        if (decoded.includes("family=eq.STRUCTURAL_FINALIZED_CHUNK_V5")) {
          return V5_TIME_CHUNKS;
        }
        if (decoded.includes("family=eq.BACKTEST_CHECKPOINT_V5")) {
          return V5_BACKTEST_SHARDS;
        }
        if (decoded.includes("family=eq.BACKTEST_ROLLUP_V5")) {
          return V5_BACKTEST_ROLLUP_SHARDS;
        }
        if (decoded.includes("split=eq.")) {
          return universe.length * frozenCandidates.length * folds.length;
        }
        if (decoded.includes("::FOLD_")) {
          return universe.length * frozenCandidates.length * 3;
        }
        if (decoded.includes("config_key=like.")) {
          return universe.length * folds.length * 3;
        }
        return expectedRows;
      },
    },
  });
  assertEquals(status.complete, true);
  assertEquals(status.checkpoint_rows, V5_BACKTEST_SHARDS);
  assertEquals(status.structural_finalized_chunk_rows, V5_TIME_CHUNKS);
  assertEquals(status.checkpoint_shards, V5_BACKTEST_SHARDS);
  assertEquals(status.backtest_rollup_rows, V5_BACKTEST_ROLLUP_SHARDS);
  assertEquals(status.backtest_rollup_shards, V5_BACKTEST_ROLLUP_SHARDS);
  assertEquals(status.checkpoint_markets, universe.length);
  assertEquals(status.checkpoint_failures, 0);
  assertEquals(status.mismatches, []);
  assertEquals(pageOffsets, [0, 10, 20, 30, 40, 50]);
  assertEquals(updated, true);
});
