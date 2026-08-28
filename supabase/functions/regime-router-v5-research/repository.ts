import {
  BAR_MS,
  type Candidate,
  type FoldSplit,
  type MetricSummary,
  type RouterState,
  type UniverseMarket,
  V5_REVISION,
} from "./types.ts";

const RESEARCH_JOBS_TABLE = "v2_research_jobs";
const RESEARCH_RESULTS_TABLE = "v2_research_market_results";
const RESULT_CONFLICT_COLUMNS = "job_id,market,config_key,split";
const RESULT_BATCH_SIZE = 200;
const MINIMUM_LOOKBACK_DAYS = 120;
const MAXIMUM_SCHEMA_LOOKBACK_DAYS = 180;
const DAY_MS = 86_400_000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type TimeInput = string | number | Date;
type JsonObject = Record<string, unknown>;

export type V5JobStatus = "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
export type V5ResultSplit = Extract<FoldSplit, "TRAIN" | "VALIDATION" | "TEST">;
export type ResultFold = number | "ALL";

export interface ResearchRepositoryOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export interface V5ResearchJobRow {
  id: string;
  revision: string;
  venue: "binance_futures";
  bar_interval: "1h";
  lookback_days: number;
  window_start: string;
  window_end: string;
  status: V5JobStatus;
  cursor: number;
  total_markets: number;
  processed_markets: number;
  failed_markets: number;
  config: JsonObject;
  metrics: JsonObject;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateV5ResearchJobInput {
  markets: readonly UniverseMarket[];
  windowStart: TimeInput;
  windowEnd: TimeInput;
  lookbackDays?: number;
  config?: JsonObject;
  initialMetrics?: JsonObject;
}

/** Only progress fields are mutable. Identity, revision, window and config are immutable. */
export interface UpdateV5ResearchJobInput {
  status?: V5JobStatus;
  cursor?: number;
  processedMarkets?: number;
  failedMarkets?: number;
  metrics?: JsonObject;
  error?: string | null;
  startedAt?: TimeInput | null;
  completedAt?: TimeInput | null;
}

/** Exact aggregates which cannot be reconstructed from MetricSummary without trade rows. */
export interface V5MetricBreakdown {
  grossProfitBps: number;
  grossLossBps: number;
  medianNetBps: number;
  targetHits: number;
  stopHits: number;
  timeExits: number;
}

export interface V5MarketResultInput {
  market: string | UniverseMarket;
  candidate: Candidate;
  fold: ResultFold;
  split: V5ResultSplit;
  bars: number;
  firstBarTime: TimeInput | null;
  lastBarTime: TimeInput | null;
  metrics: MetricSummary;
  breakdown: V5MetricBreakdown;
  parameters?: JsonObject;
}

interface ResearchRestClient {
  now: () => Date;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

function environmentValue(name: string): string {
  const deno = (globalThis as unknown as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno;
  return String(deno?.env?.get?.(name) || "").trim();
}

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return parsed;
}

function positiveDuration(value: unknown, name: string): number {
  const parsed = positiveInteger(value, name, 120_000);
  if (parsed === 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function finiteNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite`);
  return parsed;
}

function isoTime(value: TimeInput, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is not a valid timestamp`);
  return date.toISOString();
}

function nullableIsoTime(value: TimeInput | null, name: string): string | null {
  return value === null ? null : isoTime(value, name);
}

function assertUuid(value: string, name: string): string {
  const normalized = String(value || "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  ) {
    throw new Error(`${name} must be a UUID`);
  }
  return normalized;
}

function createRestClient(options: ResearchRepositoryOptions): ResearchRestClient {
  const supabaseUrl = String(options.supabaseUrl || environmentValue("SUPABASE_URL"))
    .trim()
    .replace(/\/+$/, "");
  const serviceRoleKey = String(
    options.serviceRoleKey || environmentValue("SUPABASE_SERVICE_ROLE_KEY"),
  ).trim();
  if (!/^https?:\/\//i.test(supabaseUrl)) throw new Error("SUPABASE_URL is unavailable or invalid");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is unavailable");

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = positiveDuration(options.timeoutMs ?? 20_000, "timeoutMs");
  const now = options.now ?? (() => new Date());
  return {
    now,
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(`${supabaseUrl}/rest/v1/${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(init.headers || {}),
          },
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Research REST ${response.status}: ${text.slice(0, 600)}`);
        }
        return (text ? JSON.parse(text) : null) as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function assertV5Job(value: unknown): V5ResearchJobRow {
  const job = value as V5ResearchJobRow;
  if (!job || typeof job !== "object" || !job.id) throw new Error("V5 research job not found");
  if (job.revision !== V5_REVISION) {
    throw new Error(`Research job revision mismatch: expected ${V5_REVISION}, got ${job.revision}`);
  }
  if (job.venue !== "binance_futures") throw new Error("Research job venue mismatch");
  return job;
}

function normalizeUniverse(markets: readonly UniverseMarket[]): UniverseMarket[] {
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error("V5 research job requires a non-empty Binance perpetual universe");
  }
  const seen = new Set<string>();
  return markets.map((market, index) => {
    const symbol = String(market?.symbol || "").trim();
    const quoteAsset = String(market?.quoteAsset || "").trim();
    const marginAsset = String(market?.marginAsset || "").trim();
    if (!symbol || !quoteAsset || !marginAsset) {
      throw new Error(`Invalid universe market at index ${index}`);
    }
    if (seen.has(symbol)) throw new Error(`Duplicate universe market: ${symbol}`);
    seen.add(symbol);
    const onboardDate = market.onboardDate === null
      ? null
      : positiveInteger(market.onboardDate, `markets[${index}].onboardDate`);
    return { symbol, quoteAsset, marginAsset, onboardDate };
  });
}

/**
 * Inserts a brand-new job. There is deliberately no id/revision argument and no
 * ON CONFLICT clause, so an existing V3/V4/V5 job can never be reused.
 */
export async function createV5ResearchJob(
  input: CreateV5ResearchJobInput,
  options: ResearchRepositoryOptions = {},
): Promise<V5ResearchJobRow> {
  if (!input || typeof input !== "object") throw new Error("V5 job input is required");
  const unsafeInput = input as CreateV5ResearchJobInput & Record<string, unknown>;
  if (
    "id" in unsafeInput || "jobId" in unsafeInput || "job_id" in unsafeInput ||
    "revision" in unsafeInput
  ) {
    throw new Error("V5 job id and revision are generated and cannot be supplied");
  }

  const markets = normalizeUniverse(input.markets);
  const lookbackDays = positiveInteger(
    input.lookbackDays ?? MINIMUM_LOOKBACK_DAYS,
    "lookbackDays",
    MAXIMUM_SCHEMA_LOOKBACK_DAYS,
  );
  if (lookbackDays < MINIMUM_LOOKBACK_DAYS) {
    throw new Error(`V5 lookbackDays must be at least ${MINIMUM_LOOKBACK_DAYS}`);
  }
  const windowStart = isoTime(input.windowStart, "windowStart");
  const windowEnd = isoTime(input.windowEnd, "windowEnd");
  const windowStartMs = Date.parse(windowStart);
  const windowEndMs = Date.parse(windowEnd);
  if (windowStartMs % BAR_MS !== 0 || windowEndMs % BAR_MS !== 0) {
    throw new Error("V5 windowStart and windowEnd must be aligned to 15m bar opens");
  }
  if (windowEndMs < windowStartMs) throw new Error("windowEnd must not precede windowStart");
  if (windowEndMs - windowStartMs + BAR_MS < lookbackDays * DAY_MS) {
    throw new Error(`V5 research window must span the configured ${lookbackDays} days`);
  }

  const client = createRestClient(options);
  const rows = await client.request<V5ResearchJobRow[]>(RESEARCH_JOBS_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      revision: V5_REVISION,
      venue: "binance_futures",
      // The legacy table constraint permits only 1h. The real interval is locked in config.
      bar_interval: "1h",
      lookback_days: lookbackDays,
      window_start: windowStart,
      window_end: windowEnd,
      status: "PENDING",
      cursor: 0,
      total_markets: markets.length,
      processed_markets: 0,
      failed_markets: 0,
      config: {
        ...(input.config || {}),
        router_revision: V5_REVISION,
        actual_bar_interval: "15m",
        minimum_lookback_days: MINIMUM_LOOKBACK_DAYS,
        source: "BINANCE_USDM_ACTIVE_PERPETUAL_FULL_UNIVERSE",
        markets: markets.map((market) => market.symbol),
        universe: markets,
      },
      metrics: {
        ...(input.initialMetrics || {}),
        router_revision: V5_REVISION,
      },
    }),
  });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("V5 research job insert did not return exactly one row");
  }
  return assertV5Job(rows[0]);
}

export async function loadV5ResearchJob(
  jobId: string,
  options: ResearchRepositoryOptions = {},
): Promise<V5ResearchJobRow> {
  const id = assertUuid(jobId, "jobId");
  const client = createRestClient(options);
  const rows = await client.request<V5ResearchJobRow[]>(
    `${RESEARCH_JOBS_TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  if (!Array.isArray(rows) || !rows[0]) throw new Error("V5 research job not found");
  return assertV5Job(rows[0]);
}

export async function updateV5ResearchJob(
  jobId: string,
  update: UpdateV5ResearchJobInput,
  options: ResearchRepositoryOptions = {},
): Promise<V5ResearchJobRow> {
  const id = assertUuid(jobId, "jobId");
  const client = createRestClient(options);
  const existingRows = await client.request<V5ResearchJobRow[]>(
    `${RESEARCH_JOBS_TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  const existing = assertV5Job(existingRows?.[0]);
  const patch: JsonObject = { updated_at: client.now().toISOString() };
  if (update.status !== undefined) {
    if (!["PENDING", "RUNNING", "COMPLETE", "FAILED"].includes(update.status)) {
      throw new Error("Invalid V5 job status");
    }
    patch.status = update.status;
  }
  if (update.cursor !== undefined) patch.cursor = positiveInteger(update.cursor, "cursor");
  if (update.processedMarkets !== undefined) {
    patch.processed_markets = positiveInteger(update.processedMarkets, "processedMarkets");
  }
  if (update.failedMarkets !== undefined) {
    patch.failed_markets = positiveInteger(update.failedMarkets, "failedMarkets");
  }
  if (update.metrics !== undefined) {
    patch.metrics = { ...(existing.metrics || {}), ...update.metrics };
  }
  if (update.error !== undefined) {
    if (update.error !== null && typeof update.error !== "string") {
      throw new Error("error must be a string or null");
    }
    patch.error = update.error;
  }
  if (update.startedAt !== undefined) {
    patch.started_at = nullableIsoTime(update.startedAt, "startedAt");
  }
  if (update.completedAt !== undefined) {
    patch.completed_at = nullableIsoTime(update.completedAt, "completedAt");
  }

  const rows = await client.request<V5ResearchJobRow[]>(
    `${RESEARCH_JOBS_TABLE}?id=eq.${encodeURIComponent(id)}&revision=eq.${
      encodeURIComponent(V5_REVISION)
    }`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    },
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("V5 research job update lost its revision guard");
  }
  return assertV5Job(rows[0]);
}

function structuralRegime(state: RouterState): "BULL" | "RANGE" | "BEAR" | "DYNAMIC" {
  if (state === "BULL_TREND" || state === "BULL_DECELERATING") return "BULL";
  if (state === "RANGE_UP_CYCLE") return "RANGE";
  if (state === "BEAR_REBOUND" || state === "BEAR_REBREAK") return "BEAR";
  return "DYNAMIC";
}

export function v5ResultConfigKey(candidateName: string, fold: ResultFold): string {
  const name = String(candidateName || "").trim();
  if (!name) throw new Error("candidate.name is required");
  const foldKey = fold === "ALL" ? "ALL" : `FOLD_${positiveInteger(fold, "fold")}`;
  return `${V5_REVISION}::${name}::${foldKey}`;
}

function resultMarket(value: string | UniverseMarket): {
  symbol: string;
  metadata: UniverseMarket | null;
} {
  if (typeof value === "string") {
    const symbol = value.trim();
    if (!symbol) throw new Error("result market is required");
    return { symbol, metadata: null };
  }
  const [metadata] = normalizeUniverse([value]);
  return { symbol: metadata.symbol, metadata };
}

function assertRatio(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name);
  if (parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}

function buildResultRow(
  jobId: string,
  input: V5MarketResultInput,
  updatedAt: string,
): JsonObject {
  const { symbol, metadata } = resultMarket(input.market);
  const metrics = input.metrics;
  const breakdown = input.breakdown;
  const trades = positiveInteger(metrics.trades, "metrics.trades");
  const wins = positiveInteger(metrics.wins, "metrics.wins");
  const losses = positiveInteger(metrics.losses, "metrics.losses");
  if (wins + losses !== trades) throw new Error("metrics.wins + metrics.losses must equal trades");

  const targetHits = positiveInteger(breakdown.targetHits, "breakdown.targetHits");
  const stopHits = positiveInteger(breakdown.stopHits, "breakdown.stopHits");
  const timeExits = positiveInteger(breakdown.timeExits, "breakdown.timeExits");
  const maxHoldExits = positiveInteger(
    input.parameters?.max_hold_count ?? 0,
    "parameters.max_hold_count",
  );
  const categorizedExits = targetHits + stopHits + timeExits + maxHoldExits;
  if (categorizedExits > trades) {
    throw new Error("targetHits + stopHits + timeExits + maxHoldExits must not exceed trades");
  }
  const fold = input.fold === "ALL" ? "ALL" : positiveInteger(input.fold, "fold");
  const firstBarAt = input.firstBarTime === null
    ? null
    : isoTime(input.firstBarTime, "firstBarTime");
  const lastBarAt = input.lastBarTime === null ? null : isoTime(input.lastBarTime, "lastBarTime");
  if (firstBarAt && lastBarAt && Date.parse(lastBarAt) < Date.parse(firstBarAt)) {
    throw new Error("lastBarTime must not precede firstBarTime");
  }

  const profitFactor = metrics.profitFactor === null
    ? null
    : finiteNumber(metrics.profitFactor, "metrics.profitFactor");
  if (profitFactor !== null && profitFactor < 0) {
    throw new Error("metrics.profitFactor must not be negative");
  }
  const candidateName = String(input.candidate?.name || "").trim();
  if (!candidateName) throw new Error("candidate.name is required");
  const family = String(input.candidate?.family || "").trim();
  if (!family) throw new Error("candidate.family is required");

  if (!(["TRAIN", "VALIDATION", "TEST"] as string[]).includes(input.split)) {
    throw new Error("result split must be TRAIN, VALIDATION, or TEST");
  }
  if (input.candidate.side !== "LONG" && input.candidate.side !== "SHORT") {
    throw new Error("candidate.side must be LONG or SHORT");
  }
  const grossProfitBps = finiteNumber(breakdown.grossProfitBps, "breakdown.grossProfitBps");
  const grossLossBps = finiteNumber(breakdown.grossLossBps, "breakdown.grossLossBps");
  if (grossProfitBps < 0 || grossLossBps < 0) {
    throw new Error("gross profit and loss aggregates must be non-negative");
  }

  return {
    job_id: jobId,
    revision: V5_REVISION,
    venue: "binance_futures",
    market: symbol,
    config_key: v5ResultConfigKey(candidateName, input.fold),
    family,
    side: input.candidate.side,
    regime: structuralRegime(input.candidate.state),
    split: input.split,
    bars: positiveInteger(input.bars, "bars"),
    first_bar_at: firstBarAt,
    last_bar_at: lastBarAt,
    trades,
    wins,
    losses,
    win_rate: assertRatio(metrics.winRate, "metrics.winRate"),
    gross_profit_bps: grossProfitBps,
    gross_loss_bps: grossLossBps,
    net_bps: finiteNumber(metrics.netPnlBps, "metrics.netPnlBps"),
    stress_net_bps: finiteNumber(metrics.stressNetPnlBps, "metrics.stressNetPnlBps"),
    mean_net_bps: finiteNumber(metrics.averageReturnBps, "metrics.averageReturnBps"),
    median_net_bps: finiteNumber(breakdown.medianNetBps, "breakdown.medianNetBps"),
    profit_factor: profitFactor,
    max_drawdown_bps: finiteNumber(metrics.maxDrawdownBps, "metrics.maxDrawdownBps"),
    average_mfe_bps: finiteNumber(metrics.averageMfeBps, "metrics.averageMfeBps"),
    average_mae_bps: finiteNumber(metrics.averageMaeBps, "metrics.averageMaeBps"),
    average_hold_bars: finiteNumber(metrics.averageHoldBars, "metrics.averageHoldBars"),
    target_hits: targetHits,
    stop_hits: stopHits,
    time_exits: timeExits,
    parameters: {
      ...(input.parameters || {}),
      router_revision: V5_REVISION,
      candidate_name: candidateName,
      candidate_family: input.candidate.family,
      candidate_parameters: input.candidate.parameters,
      router_state: input.candidate.state,
      neighbor_group: input.candidate.neighborGroup,
      fold,
      market_metadata: metadata,
      gross_pnl_bps: finiteNumber(metrics.grossPnlBps, "metrics.grossPnlBps"),
      mfe_capture_ratio: metrics.mfeCaptureRatio === null
        ? null
        : finiteNumber(metrics.mfeCaptureRatio, "metrics.mfeCaptureRatio"),
      profit_giveback_bps: finiteNumber(
        metrics.profitGivebackBps,
        "metrics.profitGivebackBps",
      ),
      stop_hit_rate: assertRatio(metrics.stopHitRate, "metrics.stopHitRate"),
      target_hit_rate: assertRatio(metrics.targetHitRate, "metrics.targetHitRate"),
      time_stop_rate: assertRatio(metrics.timeStopRate, "metrics.timeStopRate"),
      regime_frequency: assertRatio(metrics.regimeFrequency, "metrics.regimeFrequency"),
      max_hold_count: maxHoldExits,
      other_exit_count: trades - categorizedExits,
    },
    updated_at: updatedAt,
  };
}

/**
 * Upserts only V5 results. The job is loaded and revision-checked first; the
 * V5 revision and fold are also embedded in config_key because revision is not
 * part of the legacy table primary key.
 */
export async function upsertV5MarketResults(
  jobId: string,
  results: readonly V5MarketResultInput[],
  options: ResearchRepositoryOptions = {},
): Promise<number> {
  const id = assertUuid(jobId, "jobId");
  const client = createRestClient(options);
  const jobs = await client.request<V5ResearchJobRow[]>(
    `${RESEARCH_JOBS_TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  assertV5Job(jobs?.[0]);
  if (!Array.isArray(results) || results.length === 0) return 0;

  const updatedAt = client.now().toISOString();
  const rows = results.map((result) => buildResultRow(id, result, updatedAt));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.job_id}\u0000${row.market}\u0000${row.config_key}\u0000${row.split}`;
    if (keys.has(key)) throw new Error(`Duplicate V5 result key in batch: ${row.config_key}`);
    keys.add(key);
  }

  for (let offset = 0; offset < rows.length; offset += RESULT_BATCH_SIZE) {
    await client.request<null>(
      `${RESEARCH_RESULTS_TABLE}?on_conflict=${encodeURIComponent(RESULT_CONFLICT_COLUMNS)}`,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(offset, offset + RESULT_BATCH_SIZE)),
      },
    );
  }
  return rows.length;
}
