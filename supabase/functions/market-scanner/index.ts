// Trading-booooo Market Scanner v6.1.0-HEAT — Supabase Edge Function
// Upbit KRW / Binance USDT universe scan -> multi-period analysis -> orderflow validation.
// Public market analysis. Private account/order execution is delegated to a fixed-IP gateway.

import {
  analyzePeriod,
  buildUniverse,
  type CandleRow,
  clamp,
  computeMicrostructure,
  ENGINE_VERSION,
  CALIBRATED_PARAMETERS,
  type FinalCandidate,
  finalizeCandidate,
  type MarketRow,
  type OrderbookSnapshot,
  type PeriodAnalysis,
  type PeriodDataset,
  type RiskConfig,
  selectShortlist,
  type TickerRow,
  type TimeframeMetrics,
  timeframeMetrics,
  type TradeRow,
  type UniverseRow,
} from "./engine.ts";
import { baseAsset, combineCandidates } from "./combined.ts";
import { ACTIVE_CALIBRATION_PROFILE } from "./calibration-profile.ts";
import { assessEventRisk } from "./event-risk.ts";
import { automationAllowed } from "../_shared/security.ts";
import { buildScanDiagnostics, websocketHealth, type ScanFunnel } from "../_shared/scalp/diagnostics.ts";
import {
  applyRuntimeRisk,
  loadRuntimeProfile,
  persistScan,
  type LearningParameters,
} from "./forward-learning.ts";
import {
  fetchFundingSnapshot,
  NEUTRAL_FUNDING,
  perpSymbolFor,
  scoreFunding,
  type FundingObservation,
} from "../_shared/lob/funding.ts";
import { rankMarketHeat, type MarketHeatScore, type MarketHeatTicker } from "../_shared/lob/market-heat.ts";


const UPBIT = "https://api.upbit.com";
const UPBIT_WEBSOCKET = "wss://api.upbit.com/websocket/v1";
const BINANCE = "https://api.binance.com";
const BINANCE_WEBSOCKET = "wss://stream.binance.com:9443/stream";
const MIN_BINANCE_TURNOVER_24H = 500_000;
const MIN_BINANCE_ACTIONABLE_TURNOVER_24H = 1_000_000;
const DEFAULT_DEEP_SCAN_LIMIT = 30;
const FINALIST_LIMIT = 8;
const BOOK_SAMPLE_COUNT = 4;
const BOOK_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_DYNAMIC_OBSERVATION_MS = 8_000;
const LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS = 10_000;
const MIN_DYNAMIC_OBSERVATION_MS = 8_000;
const MAX_DYNAMIC_OBSERVATION_MS = 12_000;
const MAX_DYNAMIC_BOOK_EVENTS = 1_200;
const MAX_DYNAMIC_TRADE_EVENTS = 2_500;
const CANDLE_BATCH_SIZE = 7;
const CANDLE_BATCH_INTERVAL_MS = 1050;
const BINANCE_CANDLE_BATCH_SIZE = 20;
const BINANCE_CANDLE_BATCH_INTERVAL_MS = 250;
const RESPONSE_CACHE_MS = 5_000;
const REQUEST_COOLDOWN_MS = 12_000;

let activeScan = false;
let lastScanStartedAt = 0;
let cachedResult: { expires: number; key: string; value: unknown } | null =
  null;
let marketCache: { expires: number; markets: MarketRow[] } | null = null;
let binanceMarketCache: {
  expires: number;
  markets: MarketRow[];
  ticks: Map<string, number>;
} | null = null;

type Exchange = "upbit" | "binance";
type ScanMode = Exchange | "combined";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finite(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function query(
  path: string,
  params: Record<string, string | number | boolean>,
): string {
  const url = new URL(path, UPBIT);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function binanceQuery(
  path: string,
  params: Record<string, string | number | boolean> = {},
): string {
  const url = new URL(path, BINANCE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchJson(
  url: string,
  timeoutMs = 10_000,
  attempts = 3,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (response.ok) return data;
      const record = data && typeof data === "object"
        ? data as Record<string, unknown>
        : null;
      const nestedError = record?.error && typeof record.error === "object"
        ? record.error as Record<string, unknown>
        : null;
      const message = String(
        nestedError?.message || record?.message || record?.msg ||
          `${response.status} ${response.statusText}`,
      );
      if (response.status === 429 && attempt < attempts - 1) {
        await sleep(1100 + attempt * 500);
        continue;
      }
      throw new Error(message);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function requestOrigin(request: Request): string {
  return (request.headers.get("origin") || "").trim().replace(/\/$/, "");
}

function originAllowed(request: Request): boolean {
  const origin = requestOrigin(request);
  return origin.length > 0 && allowedOrigins().includes(origin);
}

function corsHeaders(request: Request): HeadersInit {
  return {
    "Access-Control-Allow-Origin": originAllowed(request)
      ? requestOrigin(request)
      : "null",
    "Access-Control-Allow-Headers":
      "apikey, authorization, content-type, x-client-info, x-scan-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request),
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

function tokenAllowed(request: Request): boolean {
  const expected = (Deno.env.get("SCAN_ACCESS_TOKEN") || "").trim();
  const provided = (request.headers.get("x-scan-token") || "").trim();
  return expected.length >= 24 && provided.length > 0 &&
    constantTimeEqual(expected, provided);
}

function parseRisk(
  body: Record<string, unknown>,
  exchange: Exchange,
  runtime?: LearningParameters,
): RiskConfig {
  const binance = exchange === "binance";
  const automated = body.automation === true ||
    String(body.operator_mode || "").toUpperCase() === "AUTOMATED";
  return {
    capitalKrw: clamp(
      finite(
        binance ? body.capital_usdt ?? body.capital_quote : body.capital_krw,
        binance ? 500 : 500_000,
      ),
      binance ? 10 : 10_000,
      binance ? 10_000_000 : 10_000_000_000,
    ),
    quoteCurrency: binance ? "USDT" : "KRW",
    riskPct: clamp(finite(body.risk_pct, 1), 0.1, 2),
    feePerSidePct: clamp(
      finite(
        binance
          ? body.binance_fee_per_side_pct ?? body.fee_per_side_pct
          : body.upbit_fee_per_side_pct ?? body.fee_per_side_pct,
        binance ? 0.1 : 0.05,
      ),
      0,
      0.5,
    ),
    minNetRR: clamp(
      finite(body.min_net_rr, runtime?.minNetRR ?? CALIBRATED_PARAMETERS.minNetRR),
      1,
      5,
    ),
    maxStopPct: clamp(finite(body.max_stop_pct, 5), 0.5, 12),
    entrySlippageTicks: clamp(finite(body.entry_slippage_ticks, 0.5), 0, 5),
    exitSlippageTicks: clamp(finite(body.exit_slippage_ticks, 1), 0, 10),
    scoreThreshold: clamp(
      finite(body.score_threshold, runtime?.scoreThreshold ?? CALIBRATED_PARAMETERS.scoreThreshold),
      55,
      90,
    ),
    shortTargetAtrMult: clamp(
      finite(body.short_target_atr_mult, runtime?.shortTargetAtrMult ?? CALIBRATED_PARAMETERS.shortTargetAtrMult),
      1.2,
      5,
    ),
    stopAtrMult: clamp(
      finite(body.stop_atr_mult, runtime?.stopAtrMult ?? CALIBRATED_PARAMETERS.stopAtrMult),
      0.7,
      2.5,
    ),
    mediumTargetAtr4hMult: clamp(
      finite(body.medium_target_atr_4h_mult, runtime?.mediumTargetAtr4hMult ?? CALIBRATED_PARAMETERS.mediumTargetAtr4hMult),
      1.2,
      5,
    ),
    mediumTargetAtrDayMult: clamp(
      finite(body.medium_target_atr_day_mult, runtime?.mediumTargetAtrDayMult ?? CALIBRATED_PARAMETERS.mediumTargetAtrDayMult),
      0.7,
      3,
    ),
    operatorMode: automated ? "AUTOMATED" : "LOW_TOUCH",
    dailyCheckCount: automated ? 24 : clamp(finite(body.daily_check_count, 3), 2, 3),
    maxUnattendedHours: automated
      ? clamp(finite(body.max_unattended_hours, 24), 1, 72)
      : clamp(finite(body.max_unattended_hours, 10), 6, 12),
    minActionableHoldingHours: automated
      ? clamp(finite(body.min_actionable_holding_hours, 1), 1, 12)
      : clamp(finite(body.min_actionable_holding_hours, 6), 4, 12),
    recommendationValidMinutes: automated
      ? clamp(finite(body.recommendation_valid_minutes, 5), 1, 15)
      : clamp(finite(body.recommendation_valid_minutes, 15), 5, 30),
    requirePrecommittedExit: automated ? body.require_precommitted_exit !== false : true,
    minStructuralHeadroomNetPct: clamp(finite(body.min_structural_headroom_net_pct, runtime?.minStructuralHeadroomNetPct ?? 0.6), 0.6, 2.5),
    minCostMultiple: clamp(finite(body.min_cost_multiple, runtime?.minCostMultiple ?? 2), 2, 5),
    minTradePressure: clamp(finite(body.min_trade_pressure, runtime?.minTradePressure ?? -0.2), -0.2, 0.35),
    maxNegativeBookImbalance: clamp(finite(body.max_negative_book_imbalance, runtime?.maxNegativeBookImbalance ?? -0.4), -0.4, 0.2),
    minDepthCoverage: clamp(finite(body.min_depth_coverage, runtime?.minDepthCoverage ?? 1.5), 1.5, 8),
    maxSlippageBps: clamp(finite(body.max_slippage_bps, runtime?.maxSlippageBps ?? 20), 5, 20),
    maxSpreadBps: clamp(finite(body.max_spread_bps, runtime?.maxSpreadBps ?? 35), 10, 35),
    stopMinAtr4hMult: clamp(finite(body.stop_min_atr_4h_mult, runtime?.stopMinAtr4hMult ?? 1), 1, 2),
    stopMinAtr15mMult: clamp(finite(body.stop_min_atr_15m_mult, runtime?.stopMinAtr15mMult ?? 1.5), 1.5, 3),
    firstTargetAllocationPct: clamp(finite(body.first_target_allocation_pct, runtime?.firstTargetAllocationPct ?? 60), 50, 80),
    exitPolicy: ["FIXED_T1", "SCALE_OUT", "TRAIL_AFTER_T1"].includes(String(runtime?.exitPolicy))
      ? runtime?.exitPolicy
      : "SCALE_OUT",
    strategy: (() => {
      const value = String(body.strategy || Deno.env.get("TRADING_STRATEGY") || "LOB_SCALP").toUpperCase();
      return value === "TREND" ? "TREND" : value === "SCALP" ? "SCALP" : "LOB_SCALP";
    })(),
    scalpOverrides: (body.scalp_overrides && typeof body.scalp_overrides === "object") ? body.scalp_overrides as Record<string, number> : undefined,
    // v5.3: volatility-scaled barrier geometry knobs. Clamped by resolveGeometryConfig().
    geometryOverrides: (body.geometry_overrides && typeof body.geometry_overrides === "object") ? body.geometry_overrides as Record<string, number> : undefined,
  };
}

async function getMarkets(): Promise<MarketRow[]> {
  if (marketCache && marketCache.expires > Date.now()) {
    return marketCache.markets;
  }
  const rows = await fetchJson(query("/v1/market/all", { is_details: true }));
  const markets = (Array.isArray(rows) ? rows : []).filter((row: MarketRow) =>
    String(row.market).startsWith("KRW-")
  );
  marketCache = { expires: Date.now() + 15 * 60_000, markets };
  return markets;
}

async function getBinanceMarkets(): Promise<{
  markets: MarketRow[];
  ticks: Map<string, number>;
}> {
  if (binanceMarketCache && binanceMarketCache.expires > Date.now()) {
    return {
      markets: binanceMarketCache.markets,
      ticks: new Map(binanceMarketCache.ticks),
    };
  }
  const raw = await fetchJson(binanceQuery("/api/v3/exchangeInfo"));
  const symbols = raw && typeof raw === "object" &&
      Array.isArray((raw as Record<string, unknown>).symbols)
    ? (raw as { symbols: Array<Record<string, unknown>> }).symbols
    : [];
  const ticks = new Map<string, number>();
  const markets: MarketRow[] = [];
  for (const row of symbols) {
    const symbol = String(row.symbol || "").toUpperCase();
    if (
      !symbol || row.status !== "TRADING" || row.quoteAsset !== "USDT" ||
      row.isSpotTradingAllowed === false
    ) continue;
    const filters = Array.isArray(row.filters)
      ? row.filters as Array<Record<string, unknown>>
      : [];
    const priceFilter = filters.find((filter) =>
      filter.filterType === "PRICE_FILTER"
    );
    const tick = Number(priceFilter?.tickSize);
    if (Number.isFinite(tick) && tick > 0) ticks.set(symbol, tick);
    const base = String(row.baseAsset || symbol.replace(/USDT$/, ""));
    markets.push({
      market: symbol,
      korean_name: base,
      english_name: base,
      market_event: { warning: false, caution: {} },
    });
  }
  binanceMarketCache = {
    expires: Date.now() + 15 * 60_000,
    markets,
    ticks: new Map(ticks),
  };
  return { markets, ticks };
}

function normalizeBinanceTickers(raw: unknown): TickerRow[] {
  return (Array.isArray(raw) ? raw : []).map((value) => {
    const row = value as Record<string, unknown>;
    return {
      market: String(row.symbol || ""),
      trade_price: Number(row.lastPrice),
      opening_price: Number(row.openPrice),
      high_price: Number(row.highPrice),
      low_price: Number(row.lowPrice),
      signed_change_rate: Number(row.priceChangePercent) / 100,
      acc_trade_price_24h: Number(row.quoteVolume),
      trade_timestamp: Number(row.closeTime),
      trade_count: Number(row.count),
    };
  });
}

function normalizeBinanceCandles(raw: unknown): CandleRow[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    if (!Array.isArray(value) || value.length < 11) return [];
    return [{
      timestamp: Number(value[0]),
      candle_date_time_utc: new Date(Number(value[0])).toISOString(),
      opening_price: Number(value[1]),
      high_price: Number(value[2]),
      low_price: Number(value[3]),
      trade_price: Number(value[4]),
      candle_acc_trade_volume: Number(value[5]),
      candle_acc_trade_price: Number(value[7]),
    }];
  });
}

type CandleTask = {
  market: string;
  key: keyof PeriodDataset;
  path: string;
  count: number;
};

async function loadPeriodDatasets(
  shortlist: UniverseRow[],
  baseline15: Map<string, CandleRow[]>,
): Promise<Map<string, PeriodDataset>> {
  const datasets = new Map<string, PeriodDataset>();
  shortlist.forEach((row) =>
    datasets.set(row.market, {
      m5: [],
      m15: baseline15.get(row.market) || [],
      h4: [],
      day: [],
    })
  );
  const tasks: CandleTask[] = [];
  for (const row of shortlist) {
    tasks.push(
      {
        market: row.market,
        key: "m5",
        path: "/v1/candles/minutes/5",
        count: 144,
      },
      {
        market: row.market,
        key: "h4",
        path: "/v1/candles/minutes/240",
        count: 180,
      },
      { market: row.market, key: "day", path: "/v1/candles/days", count: 200 },
    );
  }

  for (let offset = 0; offset < tasks.length; offset += CANDLE_BATCH_SIZE) {
    const batch = tasks.slice(offset, offset + CANDLE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((task) =>
        fetchJson(
          query(task.path, { market: task.market, count: task.count }),
          10_000,
          2,
        )
      ),
    );
    settled.forEach((result, index) => {
      const task = batch[index];
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        datasets.get(task.market)![task.key] = result.value as CandleRow[];
      }
    });
    if (offset + CANDLE_BATCH_SIZE < tasks.length) {
      await sleep(CANDLE_BATCH_INTERVAL_MS);
    }
  }
  return datasets;
}

async function loadBaseline15(
  universe: UniverseRow[],
): Promise<Map<string, CandleRow[]>> {
  const output = new Map<string, CandleRow[]>();
  const tasks = universe.map((row) => ({
    market: row.market,
    url: query("/v1/candles/minutes/15", { market: row.market, count: 192 }),
  }));
  for (let offset = 0; offset < tasks.length; offset += CANDLE_BATCH_SIZE) {
    const batch = tasks.slice(offset, offset + CANDLE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((task) => fetchJson(task.url, 10_000, 2)),
    );
    settled.forEach((result, index) => {
      output.set(
        batch[index].market,
        result.status === "fulfilled" && Array.isArray(result.value)
          ? result.value as CandleRow[]
          : [],
      );
    });
    if (offset + CANDLE_BATCH_SIZE < tasks.length) {
      await sleep(CANDLE_BATCH_INTERVAL_MS);
    }
  }
  return output;
}

async function loadBinanceBaseline15(
  universe: UniverseRow[],
): Promise<Map<string, CandleRow[]>> {
  const output = new Map<string, CandleRow[]>();
  for (
    let offset = 0;
    offset < universe.length;
    offset += BINANCE_CANDLE_BATCH_SIZE
  ) {
    const batch = universe.slice(offset, offset + BINANCE_CANDLE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((row) =>
        fetchJson(
          binanceQuery("/api/v3/klines", {
            symbol: row.market,
            interval: "15m",
            limit: 192,
          }),
          10_000,
          2,
        )
      ),
    );
    settled.forEach((result, index) => {
      output.set(
        batch[index].market,
        result.status === "fulfilled"
          ? normalizeBinanceCandles(result.value)
          : [],
      );
    });
    if (offset + BINANCE_CANDLE_BATCH_SIZE < universe.length) {
      await sleep(BINANCE_CANDLE_BATCH_INTERVAL_MS);
    }
  }
  return output;
}

async function loadBinancePeriodDatasets(
  shortlist: UniverseRow[],
  baseline15: Map<string, CandleRow[]>,
): Promise<Map<string, PeriodDataset>> {
  const datasets = new Map<string, PeriodDataset>();
  shortlist.forEach((row) =>
    datasets.set(row.market, {
      m5: [],
      m15: baseline15.get(row.market) || [],
      h4: [],
      day: [],
    })
  );
  const tasks = shortlist.flatMap((row) => [
    { market: row.market, key: "m5" as const, interval: "5m", limit: 144 },
    { market: row.market, key: "h4" as const, interval: "4h", limit: 180 },
    { market: row.market, key: "day" as const, interval: "1d", limit: 200 },
  ]);
  for (
    let offset = 0;
    offset < tasks.length;
    offset += BINANCE_CANDLE_BATCH_SIZE
  ) {
    const batch = tasks.slice(offset, offset + BINANCE_CANDLE_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((task) =>
        fetchJson(
          binanceQuery("/api/v3/klines", {
            symbol: task.market,
            interval: task.interval,
            limit: task.limit,
          }),
          10_000,
          2,
        )
      ),
    );
    settled.forEach((result, index) => {
      const task = batch[index];
      if (result.status === "fulfilled") {
        datasets.get(task.market)![task.key] = normalizeBinanceCandles(
          result.value,
        );
      }
    });
    if (offset + BINANCE_CANDLE_BATCH_SIZE < tasks.length) {
      await sleep(BINANCE_CANDLE_BATCH_INTERVAL_MS);
    }
  }
  return datasets;
}

function prioritizeWithBaseline(
  eligible: UniverseRow[],
  baseline15: Map<string, CandleRow[]>,
): UniverseRow[] {
  return eligible.map((row) => {
    const metric = timeframeMetrics(baseline15.get(row.market) || []);
    const pullbackDistanceAtr = metric.atr14 && metric.ema21
      ? Math.abs(metric.close - metric.ema21) / metric.atr14
      : 99;
    const pullbackQuality = ["FULL_BULL", "BULL_PULLBACK", "RECOVERY"].includes(
        metric.trend_state,
      ) && pullbackDistanceAtr <= 1.2 &&
        Number(metric.rsi14) >= 45 && Number(metric.rsi14) <= 70
      ? 12
      : 0;
    const dataScore = metric.bars >= 80
      ? clamp(
        50 + metric.trend_signal * 24 + metric.momentum_signal * 10 +
          pullbackQuality + clamp((metric.volume_ratio - 1) * 6, -6, 6) -
          metric.overheat_score * 20,
        0,
        100,
      )
      : 0;
    return {
      ...row,
      initial_score: clamp(row.initial_score * 0.55 + dataScore * 0.45, 0, 100),
    };
  });
}

type MicroBundle = {
  snapshots: Map<string, OrderbookSnapshot[]>;
  trades: Map<string, TradeRow[]>;
  ticks: Map<string, number>;
  websocketMarkets: number;
  observationMs: number;
};

type DynamicStreamBundle = {
  snapshots: Map<string, OrderbookSnapshot[]>;
  trades: Map<string, TradeRow[]>;
};

function dynamicObservationMs(finalists: PeriodAnalysis[]): number {
  const configured = Deno.env.get("MICRO_OBSERVATION_MS");
  const hasLowLiquidityCandidate = finalists.some((item) => {
    const turnover = item.universe.turnover_24h_quote;
    const actionable = item.universe.min_actionable_turnover_24h;
    return turnover >= actionable && turnover < actionable * 2;
  });
  return Math.round(
    clamp(
      finite(
        configured,
        hasLowLiquidityCandidate
          ? LOW_LIQUIDITY_DYNAMIC_OBSERVATION_MS
          : DEFAULT_DYNAMIC_OBSERVATION_MS,
      ),
      MIN_DYNAMIC_OBSERVATION_MS,
      MAX_DYNAMIC_OBSERVATION_MS,
    ),
  );
}

function normalizeStreamMarket(value: unknown): string {
  return String(value || "").toUpperCase().replace(/\.(1|5|15|30)$/, "");
}

async function websocketText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (data instanceof Blob) return await data.text();
  return "";
}

function collectDynamicStream(
  markets: string[],
  observationMs: number,
): Promise<DynamicStreamBundle> {
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map(markets.map((market) => [market, [] as TradeRow[]]));
  if (!markets.length) return Promise.resolve({ snapshots, trades });
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(UPBIT_WEBSOCKET);
    socket.binaryType = "arraybuffer";
    let opened = false;
    let settled = false;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const connectionTimer = setTimeout(() => {
      if (!opened) finish(new Error("Upbit WebSocket connection timeout"));
    }, 8_000);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      if (observationTimer != null) clearTimeout(observationTimer);
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) socket.close(1000, "observation complete");
      } catch {
        // 연결 정리 실패는 이미 수집된 공개 시세 분석을 무효화하지 않는다.
      }
      if (error) reject(error);
      else resolve({ snapshots, trades });
    }

    socket.onopen = () => {
      opened = true;
      clearTimeout(connectionTimer);
      socket.send(JSON.stringify([
        { ticket: crypto.randomUUID() },
        { type: "orderbook", codes: markets.map((market) => `${market}.15`) },
        { type: "trade", codes: markets },
        { format: "DEFAULT" },
      ]));
      observationTimer = setTimeout(() => finish(), observationMs);
    };
    socket.onmessage = async (event) => {
      try {
        const text = await websocketText(event.data);
        if (!text) return;
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows) {
          const market = normalizeStreamMarket(row.code || row.market);
          if (!snapshots.has(market)) continue;
          if (row.type === "orderbook" && Array.isArray(row.orderbook_units)) {
            const bucket = snapshots.get(market)!;
            if (bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {
              bucket.push({ ...row, market } as OrderbookSnapshot);
            }
          } else if (row.type === "trade") {
            const bucket = trades.get(market)!;
            if (bucket.length < MAX_DYNAMIC_TRADE_EVENTS) {
              bucket.push({ ...row, market } as TradeRow);
            }
          }
        }
      } catch {
        // 개별 손상 프레임은 건너뛰고 관찰창 전체를 계속 수집한다.
      }
    };
    socket.onerror = () => {
      if (!opened) finish(new Error("Upbit WebSocket connection failed"));
    };
    socket.onclose = () => {
      if (!settled) {
        if (opened) finish();
        else finish(new Error("Upbit WebSocket closed before opening"));
      }
    };
  });
}

function binanceOrderbookSnapshot(
  market: string,
  row: Record<string, unknown>,
  receivedAt = Date.now(),
): OrderbookSnapshot | null {
  const bids = Array.isArray(row.bids) ? row.bids : [];
  const asks = Array.isArray(row.asks) ? row.asks : [];
  const length = Math.min(15, Math.max(bids.length, asks.length));
  if (!length) return null;
  const units = Array.from({ length }, (_, index) => {
    const bid = Array.isArray(bids[index]) ? bids[index] as unknown[] : [];
    const ask = Array.isArray(asks[index]) ? asks[index] as unknown[] : [];
    return {
      bid_price: Number(bid[0] || 0),
      bid_size: Number(bid[1] || 0),
      ask_price: Number(ask[0] || 0),
      ask_size: Number(ask[1] || 0),
    };
  }).filter((unit) => unit.bid_price > 0 && unit.ask_price > 0);
  return units.length
    ? {
      market,
      code: market,
      timestamp: Number(row.E || receivedAt),
      orderbook_units: units,
    }
    : null;
}

function binanceTradeRow(
  market: string,
  row: Record<string, unknown>,
): TradeRow | null {
  const price = Number(row.p);
  const volume = Number(row.q);
  if (!(price > 0) || !(volume > 0)) return null;
  return {
    market,
    code: market,
    timestamp: Number(row.T || row.E || Date.now()),
    trade_timestamp: Number(row.T || row.E || Date.now()),
    trade_price: price,
    trade_volume: volume,
    // buyer-maker=true means the aggressive side was a seller.
    ask_bid: row.m === true ? "ASK" : "BID",
    sequential_id: Number(row.t || 0),
  };
}

function collectBinanceDynamicStream(
  markets: string[],
  observationMs: number,
): Promise<DynamicStreamBundle> {
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map(markets.map((market) => [market, [] as TradeRow[]]));
  if (!markets.length) return Promise.resolve({ snapshots, trades });
  const streams = markets.flatMap((market) => [
    `${market.toLowerCase()}@depth20@100ms`,
    `${market.toLowerCase()}@trade`,
  ]).join("/");
  const url = `${BINANCE_WEBSOCKET}?streams=${streams}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let opened = false;
    let settled = false;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const connectionTimer = setTimeout(() => {
      if (!opened) finish(new Error("Binance WebSocket connection timeout"));
    }, 8_000);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      if (observationTimer != null) clearTimeout(observationTimer);
      try {
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) socket.close(1000, "observation complete");
      } catch {
        // 수집 종료 중 연결 정리 실패는 이미 받은 공개 데이터에 영향이 없다.
      }
      if (error) reject(error);
      else resolve({ snapshots, trades });
    }

    socket.onopen = () => {
      opened = true;
      clearTimeout(connectionTimer);
      observationTimer = setTimeout(() => finish(), observationMs);
    };
    socket.onmessage = async (event) => {
      try {
        const text = await websocketText(event.data);
        if (!text) return;
        const wrapper = JSON.parse(text) as Record<string, unknown>;
        const row = wrapper.data && typeof wrapper.data === "object"
          ? wrapper.data as Record<string, unknown>
          : wrapper;
        const stream = String(wrapper.stream || "");
        const symbol = String(row.s || stream.split("@")[0] || "")
          .toUpperCase();
        if (!snapshots.has(symbol)) return;
        if (stream.includes("@depth") || Array.isArray(row.bids)) {
          const snapshot = binanceOrderbookSnapshot(symbol, row);
          const bucket = snapshots.get(symbol)!;
          if (snapshot && bucket.length < MAX_DYNAMIC_BOOK_EVENTS) {
            bucket.push(snapshot);
          }
        } else if (stream.includes("@trade") || row.e === "trade") {
          const trade = binanceTradeRow(symbol, row);
          const bucket = trades.get(symbol)!;
          if (trade && bucket.length < MAX_DYNAMIC_TRADE_EVENTS) {
            bucket.push(trade);
          }
        }
      } catch {
        // 개별 손상 프레임만 건너뛴다.
      }
    };
    socket.onerror = () => {
      if (!opened) finish(new Error("Binance WebSocket connection failed"));
    };
    socket.onclose = () => {
      if (!settled) {
        if (opened) finish();
        else finish(new Error("Binance WebSocket closed before opening"));
      }
    };
  });
}

function fallbackTick(snapshots: OrderbookSnapshot[], price: number): number {
  const gaps: number[] = [];
  for (const snapshot of snapshots) {
    const units = snapshot.orderbook_units || [];
    for (let i = 1; i < units.length; i++) {
      const bidGap = Math.abs(
        Number(units[i - 1].bid_price) - Number(units[i].bid_price),
      );
      const askGap = Math.abs(
        Number(units[i].ask_price) - Number(units[i - 1].ask_price),
      );
      if (bidGap > 0) gaps.push(bidGap);
      if (askGap > 0) gaps.push(askGap);
    }
  }
  return gaps.length
    ? Math.min(...gaps)
    : Math.max(price * 0.00001, Number.EPSILON);
}

async function loadMicrostructure(
  finalists: PeriodAnalysis[],
  observationOverrideMs?: number,
): Promise<MicroBundle> {
  const markets = finalists.map((item) => item.universe.market);
  const marketList = markets.join(",");
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map<string, TradeRow[]>();
  const ticks = new Map<string, number>();
  const observationMs = observationOverrideMs == null
    ? dynamicObservationMs(finalists)
    : Math.round(clamp(observationOverrideMs, MIN_DYNAMIC_OBSERVATION_MS, MAX_DYNAMIC_OBSERVATION_MS));
  const dynamicPromise = optional(
    collectDynamicStream(markets, observationMs),
  );

  const tradePromise = Promise.all(
    markets.map(async (market) => {
      const rows = await optional(
        fetchJson(query("/v1/trades/ticks", { market, count: 500 }), 10_000, 2),
      );
      trades.set(market, Array.isArray(rows) ? rows : []);
    }),
  );
  const instrumentPromise = optional(
    fetchJson(
      query("/v1/orderbook/instruments", { markets: marketList }),
      10_000,
      2,
    ),
  );

  for (let sample = 0; sample < BOOK_SAMPLE_COUNT; sample++) {
    const rows = await optional(
      fetchJson(
        query("/v1/orderbook", { markets: marketList, count: 15 }),
        10_000,
        2,
      ),
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const market = String(row.market || "");
        if (snapshots.has(market)) {
          snapshots.get(market)!.push(row as OrderbookSnapshot);
        }
      }
    }
    if (sample < BOOK_SAMPLE_COUNT - 1) await sleep(BOOK_SAMPLE_INTERVAL_MS);
  }

  const instruments = await instrumentPromise;
  if (Array.isArray(instruments)) {
    for (const row of instruments) {
      const tick = Number(row.tick_size);
      if (String(row.market) && Number.isFinite(tick) && tick > 0) {
        ticks.set(String(row.market), tick);
      }
    }
  }
  await tradePromise;
  const dynamic = await dynamicPromise;
  let websocketMarkets = 0;
  if (dynamic) {
    for (const market of markets) {
      const streamedBooks = dynamic.snapshots.get(market) || [];
      const streamedTrades = dynamic.trades.get(market) || [];
      if (streamedBooks.length >= 2) {
        snapshots.set(market, streamedBooks);
        websocketMarkets++;
      }
      if (streamedTrades.length) {
        trades.set(market, [
          ...(trades.get(market) || []),
          ...streamedTrades,
        ]);
      }
    }
  }

  for (const finalist of finalists) {
    const market = finalist.universe.market;
    if (!ticks.has(market)) {
      ticks.set(
        market,
        fallbackTick(
          snapshots.get(market) || [],
          finalist.universe.current_price,
        ),
      );
    }
  }
  return { snapshots, trades, ticks, websocketMarkets, observationMs };
}

async function loadBinanceMicrostructure(
  finalists: PeriodAnalysis[],
  instrumentTicks: Map<string, number>,
  observationOverrideMs?: number,
): Promise<MicroBundle> {
  const markets = finalists.map((item) => item.universe.market);
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map<string, TradeRow[]>();
  const ticks = new Map(instrumentTicks);
  const observationMs = observationOverrideMs == null
    ? dynamicObservationMs(finalists)
    : Math.round(clamp(observationOverrideMs, MIN_DYNAMIC_OBSERVATION_MS, MAX_DYNAMIC_OBSERVATION_MS));
  const dynamicPromise = optional(
    collectBinanceDynamicStream(markets, observationMs),
  );

  await Promise.all(markets.map(async (market) => {
    const raw = await optional(
      fetchJson(
        binanceQuery("/api/v3/trades", { symbol: market, limit: 500 }),
        10_000,
        2,
      ),
    );
    const rows = (Array.isArray(raw) ? raw : []).flatMap((value) => {
      const source = value as Record<string, unknown>;
      return binanceTradeRow(market, {
        p: source.price,
        q: source.qty,
        T: source.time,
        t: source.id,
        m: source.isBuyerMaker,
      }) || [];
    });
    trades.set(market, rows);
  }));

  for (let sample = 0; sample < BOOK_SAMPLE_COUNT; sample++) {
    const settled = await Promise.allSettled(markets.map((market) =>
      fetchJson(
        binanceQuery("/api/v3/depth", { symbol: market, limit: 20 }),
        10_000,
        2,
      )
    ));
    settled.forEach((result, index) => {
      if (
        result.status !== "fulfilled" || !result.value ||
        typeof result.value !== "object"
      ) return;
      const snapshot = binanceOrderbookSnapshot(
        markets[index],
        result.value as Record<string, unknown>,
      );
      if (snapshot) snapshots.get(markets[index])!.push(snapshot);
    });
    if (sample < BOOK_SAMPLE_COUNT - 1) await sleep(BOOK_SAMPLE_INTERVAL_MS);
  }

  const dynamic = await dynamicPromise;
  let websocketMarkets = 0;
  if (dynamic) {
    for (const market of markets) {
      const streamedBooks = dynamic.snapshots.get(market) || [];
      const streamedTrades = dynamic.trades.get(market) || [];
      if (streamedBooks.length >= 2) {
        snapshots.set(market, streamedBooks);
        websocketMarkets++;
      }
      if (streamedTrades.length) {
        trades.set(market, [
          ...(trades.get(market) || []),
          ...streamedTrades,
        ]);
      }
    }
  }

  for (const finalist of finalists) {
    const market = finalist.universe.market;
    if (!ticks.has(market)) {
      ticks.set(
        market,
        fallbackTick(
          snapshots.get(market) || [],
          finalist.universe.current_price,
        ),
      );
    }
  }
  return { snapshots, trades, ticks, websocketMarkets, observationMs };
}

function summarizeExclusions(
  universe: UniverseRow[],
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of universe) {
    if (!row.excluded_reason) continue;
    counts.set(row.excluded_reason, (counts.get(row.excluded_reason) || 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

function periodRanking(item: PeriodAnalysis, rank: number) {
  return {
    rank,
    market: item.universe.market,
    korean_name: item.universe.korean_name,
    current_price: item.universe.current_price,
    change_24h_pct: item.universe.change_24h_pct,
    turnover_24h_krw: item.universe.turnover_24h_krw,
    turnover_24h_quote: item.universe.turnover_24h_quote,
    period_score: Number(item.period_score.toFixed(2)),
    preliminary_status: item.preliminary_status,
    trend: {
      m5: Number(item.timeframes.m5.trend_signal.toFixed(3)),
      m15: Number(item.timeframes.m15.trend_signal.toFixed(3)),
      h4: Number(item.timeframes.h4.trend_signal.toFixed(3)),
      day: Number(item.timeframes.day.trend_signal.toFixed(3)),
    },
  };
}


function heatTickerSnapshot(rows: TickerRow[], timestampMs: number): MarketHeatTicker[] {
  return rows.flatMap((row) => {
    const opening = finite(row.opening_price, finite(row.trade_price, 0));
    const high = finite(row.high_price, finite(row.trade_price, 0));
    const low = finite(row.low_price, finite(row.trade_price, 0));
    const price = finite(row.trade_price, 0);
    if (!row.market || !(price > 0)) return [];
    return [{
      market: String(row.market),
      timestampMs,
      price,
      turnover24hQuote: Math.max(0, finite(row.acc_trade_price_24h, 0)),
      tradeCount: finite(row.trade_count, Number.NaN),
      change24hPct: finite(row.signed_change_rate, 0) * 100,
      range24hPct: opening > 0 ? Math.max(0, (high - low) / opening * 100) : 0,
    }];
  });
}

async function sampleWholeMarketHeat(
  exchange: Exchange,
  firstRows: TickerRow[],
): Promise<{ latestRows: TickerRow[]; heat: MarketHeatScore[]; sampleCount: number; elapsedMs: number }> {
  const started = Date.now();
  const sampleCount = Math.round(clamp(finite(Deno.env.get("LOB_HEAT_SAMPLE_COUNT"), 3), 2, 5));
  const intervalMs = Math.round(clamp(finite(Deno.env.get("LOB_HEAT_SAMPLE_INTERVAL_MS"), 900), 400, 2000));
  const snapshots: MarketHeatTicker[][] = [heatTickerSnapshot(firstRows, Date.now())];
  let latestRows = firstRows;
  for (let sample = 1; sample < sampleCount; sample++) {
    await sleep(intervalMs);
    const raw = exchange === "binance"
      ? await fetchJson(binanceQuery("/api/v3/ticker/24hr"), 10_000, 2)
      : await fetchJson(query("/v1/ticker/all", { quote_currencies: "KRW" }), 10_000, 2);
    latestRows = exchange === "binance"
      ? normalizeBinanceTickers(raw)
      : Array.isArray(raw) ? raw as TickerRow[] : [];
    snapshots.push(heatTickerSnapshot(latestRows, Date.now()));
  }
  const heat = rankMarketHeat(snapshots, exchange === "binance"
    ? {
      minimumTurnover24hQuote: 100_000,
      referenceRecentNotionalPerSecond: 25_000,
      referenceTradeCountPerSecond: 8,
    }
    : {
      minimumTurnover24hQuote: 100_000_000,
      referenceRecentNotionalPerSecond: 15_000_000,
      referenceTradeCountPerSecond: 8,
    });
  return { latestRows, heat, sampleCount, elapsedMs: Date.now() - started };
}

/** Perp funding is auxiliary; it can be switched off without touching the trading path. */
function fundingEnabled(): boolean {
  return String(Deno.env.get("LOB_FUNDING_SIGNAL") ?? "true").toLowerCase() !== "false";
}

let previousFunding = new Map<string, FundingObservation>();

function neutralHeatTimeframe(price: number, trend: number): TimeframeMetrics {
  return {
    bars: 0,
    close: price,
    ema9: null,
    ema21: null,
    ema50: null,
    rsi14: null,
    atr14: null,
    atr_pct: null,
    macd_histogram: null,
    return_3_pct: 0,
    return_12_pct: 0,
    volume_ratio: 1,
    trend_signal: trend,
    momentum_signal: trend,
    trend_state: trend > 0.15 ? "RECOVERY" : trend < -0.15 ? "BEAR" : "MIXED",
    ema21_slope_pct: null,
    atr_normalized_return_12: null,
    overheat_score: 0,
    overextension_pct: null,
    recent_high: price,
    recent_low: price,
    support: null,
    resistance: null,
  };
}

function heatPeriod(row: UniverseRow): PeriodAnalysis {
  const trend = clamp(row.change_24h_pct / 100, -1, 1) * 0.25;
  const tf = neutralHeatTimeframe(row.current_price, trend);
  return {
    universe: row,
    timeframes: { m5: tf, m15: tf, h4: tf, day: tf },
    period_score: finite(row.market_heat_score, 0),
    trend_signal: trend,
    momentum_signal: trend,
    data_completeness: 0,
    preliminary_status: "CANDIDATE",
    positives: [
      `전 종목 실시간 거래대금 가속도 기준 Heat rank ${row.heat_rank ?? "N/A"}입니다.`,
      `최근 체결대금 속도 ${Math.round(finite(row.recent_notional_per_second, 0)).toLocaleString("en-US")} ${row.quote_currency}/s입니다.`,
    ],
    negatives: [],
    warnings: row.caution_labels.length
      ? [`거래소 경보 표시는 정보로만 유지합니다: ${row.caution_labels.join(", ")}`]
      : [],
  };
}

function clearLobEventRisk(market: string) {
  return {
    status: "CLEAR" as const,
    label: "LOB 경로 외부 이벤트 비차단",
    checked_at: new Date().toISOString(),
    symbol: market,
    provider_status: {},
    coverage_complete: false,
    volume_anomaly: false,
    volume_ratio_4h: 0,
    volume_ratio_day: 0,
    evidence: [],
    warnings: [],
  };
}

async function runLobHeatScan(
  risk: RiskConfig,
  exchange: Exchange,
  markets: MarketRow[],
  firstRows: TickerRow[],
  instrumentTicks: Map<string, number>,
  started: number,
) {
  const binance = exchange === "binance";
  const heatSample = await sampleWholeMarketHeat(exchange, firstRows);
  const universe = buildUniverse(
    markets,
    heatSample.latestRows,
    Date.now(),
    binance
      ? {
        quoteCurrency: "USDT",
        marketMatches: (market) => market.endsWith("USDT"),
        minTurnover24h: 0,
        minActionableTurnover24h: 100_000,
        liquidityLogFloor: 4.7,
      }
      : {
        minTurnover24h: 0,
        minActionableTurnover24h: 100_000_000,
        liquidityLogFloor: 7.7,
      },
  );
  const universeByMarket = new Map(universe.map((row) => [row.market, row]));
  const finalistLimit = Math.round(clamp(finite(Deno.env.get("LOB_HEAT_FINALIST_LIMIT"), 12), 4, 20));
  // v6.2: one call for every perpetual, taken alongside the heat sample. A per-symbol
  // request pattern would not fit a 12-second scan, and a late scan is worse than a scan
  // without this signal — so a failure here returns an empty map and everything downstream
  // resolves to neutral.
  const fundingNow = fundingEnabled()
    ? await fetchFundingSnapshot()
    : new Map<string, FundingObservation>();
  const heatRanked = heatSample.heat.flatMap((heat) => {
    const row = universeByMarket.get(heat.market);
    if (!row || !(row.current_price > 0) || row.freshness_seconds > 300) return [];
    const perp = perpSymbolFor(heat.market);
    const funding = perp
      ? scoreFunding(fundingNow.get(perp), previousFunding.get(perp))
      : NEUTRAL_FUNDING;
    return [{
      ...row,
      eligible: true,
      excluded_reason: null,
      heat_rank: heat.rank,
      market_heat_score: heat.heatScore,
      recent_notional_per_second: heat.recentNotionalPerSecond,
      notional_acceleration: heat.notionalAcceleration,
      trade_count_per_second: heat.tradeCountPerSecond,
      funding_premium_bps: funding.premiumBps,
      funding_attention: funding.attention,
      funding_edge: funding.edge,
    } as UniverseRow];
  });
  // Carried to the next scan so the premium *delta* is available. An isolate recycle simply
  // resets it, which yields a zero delta rather than a stale one.
  if (fundingNow.size) previousFunding = fundingNow;
  const selectedRows = heatRanked.slice(0, finalistLimit);
  const finalists = selectedRows.map(heatPeriod);
  const observationMs = Math.round(clamp(finite(Deno.env.get("LOB_OBSERVATION_MS"), 8_000), 8_000, 12_000));
  const microBundle = binance
    ? await loadBinanceMicrostructure(finalists, instrumentTicks, observationMs)
    : await loadMicrostructure(finalists, observationMs);
  const generatedAt = Date.now();
  const finalCandidates = finalists.map((period) => {
    const market = period.universe.market;
    const micro = computeMicrostructure(
      microBundle.snapshots.get(market) || [],
      microBundle.trades.get(market) || [],
      generatedAt,
      microBundle.ticks.get(market)!,
    );
    return finalizeCandidate(
      period,
      micro,
      microBundle.ticks.get(market)!,
      risk,
      clearLobEventRisk(market),
    );
  }).sort((left, right) => {
    if (left.decision === "BUY" && right.decision !== "BUY") return -1;
    if (left.decision !== "BUY" && right.decision === "BUY") return 1;
    const heatDelta = finite(right.lob?.market_heat_score, 0) - finite(left.lob?.market_heat_score, 0);
    if (Math.abs(heatDelta) > 1e-9) return heatDelta;
    return finite(right.lob?.ev_lower_bound_bps, -1e9) - finite(left.lob?.ev_lower_bound_bps, -1e9);
  });
  finalCandidates.forEach((candidate, index) => candidate.rank = index + 1);
  const recommendations = finalCandidates.filter((candidate) => candidate.decision === "BUY");
  const watchlist = finalCandidates.filter((candidate) => candidate.decision !== "BUY").slice(0, 8);
  const status = recommendations.length ? "BUY_CANDIDATES" : "NO_BUY";
  const scanEndMs = Date.now();
  const funnel: ScanFunnel = {
    total_instruments: markets.length,
    universe: universe.length,
    eligible: heatRanked.length,
    shortlist: selectedRows.length,
    analyzed: selectedRows.length,
    finalists: finalists.length,
    final_candidates: finalCandidates.length,
    buy: recommendations.length,
  };
  const diagnostics = buildScanDiagnostics({
    startedMs: started,
    endMs: scanEndMs,
    exchange,
    status,
    funnel,
    candidates: finalCandidates,
    websocket: websocketHealth(
      microBundle.snapshots,
      finalists.map((row) => row.universe.market),
      scanEndMs,
      microBundle.websocketMarkets,
      microBundle.observationMs,
    ),
  });
  return {
    scan_id: crypto.randomUUID(),
    status,
    diagnostics,
    headline: recommendations.length
      ? `${binance ? "바이낸스 USDT" : "업비트 KRW"} 전 종목 Heat 스캔에서 LOB 매수 후보 ${recommendations.length}개가 탐지됐습니다.`
      : `${binance ? "바이낸스 USDT" : "업비트 KRW"} 전 종목의 현재 자금 이동을 측정했으나 비용 차감 순EV가 양수인 LOB 진입은 없습니다.`,
    primary: recommendations[0] || null,
    recommendations,
    watchlist,
    finalists: finalCandidates,
    ranking: heatSample.heat.slice(0, 20).map((row) => ({
      rank: row.rank,
      market: row.market,
      korean_name: universeByMarket.get(row.market)?.korean_name || row.market,
      current_price: universeByMarket.get(row.market)?.current_price || 0,
      change_24h_pct: row.change24hPct,
      turnover_24h_krw: row.turnover24hQuote,
      turnover_24h_quote: row.turnover24hQuote,
      period_score: Number(row.heatScore.toFixed(2)),
      preliminary_status: "CANDIDATE" as const,
      trend: { m5: 0, m15: 0, h4: 0, day: 0 },
      market_heat_score: Number(row.heatScore.toFixed(2)),
      recent_notional_per_second: Number(row.recentNotionalPerSecond.toFixed(2)),
      notional_acceleration: Number(row.notionalAcceleration.toFixed(4)),
      trade_count_per_second: Number(row.tradeCountPerSecond.toFixed(2)),
    })),
    coverage: {
      exchange,
      exchange_label: binance ? "바이낸스 현물" : "업비트 현물",
      quote_currency: binance ? "USDT" : "KRW",
      listed_markets: universe.length,
      listed_krw_markets: universe.length,
      eligible_after_safety_filter: heatRanked.length,
      excluded_at_universe_stage: universe.length - heatRanked.length,
      period_screened_markets: 0,
      period_screened_complete: 0,
      deep_period_analyzed: 0,
      microstructure_finalists: finalCandidates.length,
      heat_engine: {
        mode: "WHOLE_MARKET_TICKER_DELTA",
        sample_count: heatSample.sampleCount,
        sample_elapsed_seconds: Number((heatSample.elapsedMs / 1000).toFixed(2)),
        ranked_markets: heatSample.heat.length,
        selected_for_lob: selectedRows.length,
      },
      dynamic_orderflow: {
        requested_observation_seconds: Number((microBundle.observationMs / 1000).toFixed(1)),
        websocket_markets: microBundle.websocketMarkets,
        sufficient_markets: finalCandidates.filter((candidate) => candidate.microstructure.dynamic.sufficient).length,
      },
      excluded_summary: [],
      periods: { heat: "전 종목 0.9초 간격 티커 누적거래대금 차분", lob: "상위 Heat 종목 8초 실시간 호가·체결" },
    },
    assumptions: {
      exchange,
      quote_market: binance ? "USDT" : "KRW",
      fee_per_side_pct: risk.feePerSidePct,
      capital_quote: risk.capitalKrw,
      capital_currency: binance ? "USDT" : "KRW",
      risk_per_trade_pct: risk.riskPct,
      strategy: "LOB_SCALP_HEAT_FIRST",
      trend_role: "AUXILIARY_ONLY",
      hard_economic_gate: "TARGET_NET_PROFIT_GT_0_AND_CONSERVATIVE_NET_EV_GT_0",
      automatic_order: risk.operatorMode === "AUTOMATED",
    },
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date(generatedAt).toISOString(),
      elapsed_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      exchange,
      quote_currency: binance ? "USDT" : "KRW",
      data_source: binance
        ? "BINANCE_ALL_TICKER_DELTA_PLUS_PUBLIC_LOB_WEBSOCKET"
        : "UPBIT_ALL_TICKER_DELTA_PLUS_PUBLIC_LOB_WEBSOCKET",
      auth_mode: "PRIVATE_FRAGMENT_TOKEN",
      auto_order: risk.operatorMode === "AUTOMATED",
    },
  };
}

async function runScan(risk: RiskConfig, exchange: Exchange) {
  const started = Date.now();
  const binance = exchange === "binance";
  let markets: MarketRow[];
  let tickerRows: TickerRow[];
  let instrumentTicks = new Map<string, number>();
  if (binance) {
    const [marketBundle, rawTickers] = await Promise.all([
      getBinanceMarkets(),
      fetchJson(binanceQuery("/api/v3/ticker/24hr")),
    ]);
    markets = marketBundle.markets;
    instrumentTicks = marketBundle.ticks;
    tickerRows = normalizeBinanceTickers(rawTickers);
  } else {
    const values = await Promise.all([
      getMarkets(),
      fetchJson(query("/v1/ticker/all", { quote_currencies: "KRW" })),
    ]);
    markets = values[0] as MarketRow[];
    tickerRows = Array.isArray(values[1]) ? values[1] as TickerRow[] : [];
  }
  if (String(risk.strategy) === "LOB_SCALP") {
    return await runLobHeatScan(risk, exchange, markets, tickerRows, instrumentTicks, started);
  }
  const universe = buildUniverse(
    markets,
    tickerRows,
    Date.now(),
    binance
      ? {
        quoteCurrency: "USDT",
        marketMatches: (market) => market.endsWith("USDT"),
        minTurnover24h: MIN_BINANCE_TURNOVER_24H,
        minActionableTurnover24h: MIN_BINANCE_ACTIONABLE_TURNOVER_24H,
        liquidityLogFloor: 5.7,
      }
      : {},
  );
  const scalpMode = risk.strategy === "SCALP" || risk.strategy === "LOB_SCALP";
  // Scalp scans a small top-liquidity set: trend is only a veto, so deep multi-timeframe
  // analysis over 30+ instruments is both unnecessary and the cause of WORKER_RESOURCE_LIMIT.
  const deepLimit = scalpMode
    // v5.7.2: 12 -> 16. With 6 capital slots per exchange the FUNNEL, not the capital,
    // became the throughput ceiling: only the finalists get a realtime orderbook read, so
    // a narrow funnel starves the slots. Still bounded at 20 because deep multi-timeframe
    // analysis over 30+ instruments is what trips WORKER_RESOURCE_LIMIT.
    ? Math.round(clamp(finite(Deno.env.get("SCALP_DEEP_SCAN_LIMIT"), risk.strategy === "LOB_SCALP" ? 24 : 16), 6, 30))
    : Math.round(
      clamp(
        finite(Deno.env.get("DEEP_SCAN_LIMIT"), DEFAULT_DEEP_SCAN_LIMIT),
        20,
        40,
      ),
    );
  const finalistLimit = scalpMode
    // v5.7.2: 6 -> 8 finalists get live orderbook + trade-flow analysis per exchange.
    ? Math.round(clamp(finite(Deno.env.get("SCALP_FINALIST_LIMIT"), risk.strategy === "LOB_SCALP" ? 16 : 8), 3, 20))
    : FINALIST_LIMIT;
  let eligible = risk.strategy === "LOB_SCALP"
    ? universe
      .filter((item) => item.current_price > 0 && item.freshness_seconds <= 15 * 60 &&
        item.turnover_24h_quote >= Math.min(item.min_actionable_turnover_24h, item.quote_currency === "KRW" ? 500_000_000 : 500_000))
      .map((item) => ({ ...item, eligible: true, excluded_reason: null }))
    : universe.filter((item) => item.eligible);
  if (scalpMode) {
    // v5.6: rank the scalp universe by SCALPABILITY, not by turnover.
    //
    // Ranking by 24h turnover selects the largest caps, whose short-horizon range is the
    // smallest relative to trading cost. That is how the live book ended up holding
    // KRW-ETH four times in eight hours: ETH's 30-minute move was 0.04-0.11% against a
    // 0.10% round trip. Direction was irrelevant — those trades could not clear costs.
    //
    // A barrier is only reachable inside a scalp horizon if the symbol actually travels
    // that far, and travel scales with volatility. Liquidity remains a hard floor (a wide
    // spread destroys the maker economics), but among liquid names the ordering must be
    // by movement.
    const cap = Math.round(clamp(finite(Deno.env.get("SCALP_UNIVERSE_CAP"), 40), deepLimit, 120));
    const liquidityFloorRatio = clamp(finite(Deno.env.get("SCALP_LIQUIDITY_FLOOR_RATIO"), 1), 0.2, 20);
    const liquid = eligible.filter((item) =>
      finite(item.turnover_24h_quote, 0) >= finite(item.min_actionable_turnover_24h, 0) * liquidityFloorRatio
    );
    const pool = liquid.length >= deepLimit ? liquid : eligible;
    // day_range_pct is the 24h high-low range and is available before any candle fetch,
    // so it costs nothing at this stage. Turnover only breaks ties.
    eligible = [...pool]
      .sort((a, b) => {
        const rangeDelta = finite(b.day_range_pct, 0) - finite(a.day_range_pct, 0);
        if (Math.abs(rangeDelta) > 1e-9) return rangeDelta;
        return finite(b.turnover_24h_quote, 0) - finite(a.turnover_24h_quote, 0);
      })
      .slice(0, cap);
  }
  const baseline15 = binance
    ? await loadBinanceBaseline15(eligible)
    : await loadBaseline15(eligible);
  const prioritized = prioritizeWithBaseline(eligible, baseline15);
  const shortlist = selectShortlist(prioritized, deepLimit);
  const datasets = binance
    ? await loadBinancePeriodDatasets(shortlist, baseline15)
    : await loadPeriodDatasets(shortlist, baseline15);
  const periods = shortlist
    .map((row) =>
      analyzePeriod(
        row,
        datasets.get(row.market) || { m5: [], m15: [], h4: [], day: [] },
      )
    )
    .sort((a, b) => b.period_score - a.period_score);

  // LOB_SCALP does not allow trend status to determine which books receive the realtime
  // observation budget. The pre-rank is only an activity proxy; the authoritative rank is
  // computed from websocket book/trade events after the observation window.
  const lobPrefilterScore = (item: PeriodAnalysis): number => {
    const turnoverRatio = finite(item.universe.turnover_24h_quote, 0) /
      Math.max(1, finite(item.universe.min_actionable_turnover_24h, 1));
    return Math.log1p(Math.max(0, turnoverRatio)) * 25 +
      clamp(finite(item.timeframes.m5.volume_ratio, 0), 0, 8) * 8 +
      clamp(finite(item.timeframes.m5.atr_pct, 0), 0, 5) * 6 +
      clamp(finite(item.universe.day_range_pct, 0), 0, 30) * 1.5 -
      clamp(finite(item.universe.freshness_seconds, 0), 0, 300) * 0.03;
  };
  const candidatePool = risk.strategy === "LOB_SCALP"
    ? [...periods].sort((a, b) => lobPrefilterScore(b) - lobPrefilterScore(a))
    : [
      ...periods.filter((item) => item.preliminary_status === "CANDIDATE"),
      ...periods.filter((item) => item.preliminary_status !== "CANDIDATE"),
    ];
  const finalists = [
    ...new Map(candidatePool.map((item) => [item.universe.market, item]))
      .values(),
  ]
    .slice(0, finalistLimit);
  const [microBundle, eventRiskRows] = await Promise.all([
    binance
      ? loadBinanceMicrostructure(finalists, instrumentTicks)
      : loadMicrostructure(finalists),
    Promise.all(finalists.map(async (period) => [period.universe.market, await assessEventRisk(period)] as const)),
  ]);
  const eventRiskMap = new Map(eventRiskRows);
  const generatedAt = Date.now();
  const finalCandidates: FinalCandidate[] = finalists
    .map((period) => {
      const market = period.universe.market;
      const micro = computeMicrostructure(
        microBundle.snapshots.get(market) || [],
        microBundle.trades.get(market) || [],
        generatedAt,
        microBundle.ticks.get(market)!,
      );
      return finalizeCandidate(
        period,
        micro,
        microBundle.ticks.get(market)!,
        risk,
        eventRiskMap.get(market),
      );
    })
    .sort((a, b) => {
      if (a.decision === "BUY" && b.decision !== "BUY") return -1;
      if (a.decision !== "BUY" && b.decision === "BUY") return 1;
      if (risk.strategy === "LOB_SCALP") {
        const hot = finite(b.lob?.hotness_score, 0) - finite(a.lob?.hotness_score, 0);
        if (Math.abs(hot) > 1e-9) return hot;
        return finite(b.lob?.ev_lower_bound_bps, -1e9) - finite(a.lob?.ev_lower_bound_bps, -1e9);
      }
      return b.score - a.score;
    });
  finalCandidates.forEach((candidate, index) => candidate.rank = index + 1);
  const recommendations = finalCandidates.filter((item) =>
    item.decision === "BUY"
  ).slice(0, risk.strategy === "LOB_SCALP" ? finalistLimit : 3);
  const watchlist = finalCandidates.filter((item) => item.decision !== "BUY")
    .slice(0, 5);
  const status = recommendations.length ? "BUY_CANDIDATES" : "NO_BUY";

  const scanEndMs = Date.now();
  const funnel: ScanFunnel = {
    total_instruments: markets.length,
    universe: universe.length,
    eligible: eligible.length,
    shortlist: shortlist.length,
    analyzed: periods.length,
    finalists: finalists.length,
    final_candidates: finalCandidates.length,
    buy: recommendations.length,
  };
  const diagnostics = buildScanDiagnostics({
    startedMs: started,
    endMs: scanEndMs,
    exchange,
    status,
    funnel,
    candidates: finalCandidates,
    websocket: websocketHealth(
      microBundle.snapshots,
      finalists.map((f) => f.universe.market),
      scanEndMs,
      microBundle.websocketMarkets,
      microBundle.observationMs,
    ),
  });

  return {
    scan_id: crypto.randomUUID(),
    status,
    diagnostics,
    headline: recommendations.length
      ? `${
        binance ? "바이낸스 USDT" : "업비트 KRW"
      } 현물에서 현재 매수 강제조건을 통과한 후보 ${recommendations.length}개가 탐지됐습니다.`
      : `${
        binance ? "바이낸스 USDT" : "업비트 KRW"
      } 현물에서 현재 모든 강제조건을 통과한 매수 후보가 없습니다.`,
    primary: recommendations[0] || null,
    recommendations,
    watchlist,
    finalists: finalCandidates,
    ranking: periods.slice(0, 20).map((item, index) =>
      periodRanking(item, index + 1)
    ),
    coverage: {
      exchange,
      exchange_label: binance ? "바이낸스 현물" : "업비트 현물",
      quote_currency: binance ? "USDT" : "KRW",
      listed_markets: universe.length,
      listed_krw_markets: universe.length,
      eligible_after_safety_filter: eligible.length,
      excluded_at_universe_stage:
        universe.filter((item) => !item.eligible).length,
      period_screened_markets: eligible.length,
      period_screened_complete:
        [...baseline15.values()].filter((rows) => rows.length >= 80).length,
      deep_period_analyzed: periods.length,
      microstructure_finalists: finalCandidates.length,
      dynamic_orderflow: {
        requested_observation_seconds: Number(
          (microBundle.observationMs / 1000).toFixed(1),
        ),
        websocket_markets: microBundle.websocketMarkets,
        sufficient_markets:
          finalCandidates.filter((candidate) =>
            candidate.microstructure.dynamic.sufficient
          ).length,
      },
      excluded_summary: summarizeExclusions(universe),
      periods: {
        "5m": "최근 12시간(144봉)",
        "15m": "최근 48시간(192봉)",
        "4h": "최근 30일(180봉)",
        "1d": "최근 200일(200봉)",
      },
    },
    assumptions: {
      exchange,
      quote_market: binance ? "USDT" : "KRW",
      fee_per_side_pct: risk.feePerSidePct,
      capital_quote: risk.capitalKrw,
      capital_currency: binance ? "USDT" : "KRW",
      risk_per_trade_pct: risk.riskPct,
      min_net_rr: risk.minNetRR,
      max_net_stop_pct: risk.maxStopPct,
      score_threshold: risk.scoreThreshold,
      short_target_atr_mult: risk.shortTargetAtrMult,
      stop_atr_mult: risk.stopAtrMult,
      medium_target_atr_4h_mult: risk.mediumTargetAtr4hMult,
      medium_target_atr_day_mult: risk.mediumTargetAtrDayMult,
      dynamic_observation_seconds: Number(
        (microBundle.observationMs / 1000).toFixed(1),
      ),
      dynamic_orderflow_note:
        "공개 호가에는 주문자·개별 주문 ID·숨은 잔량이 없어 스푸핑·아이스버그를 확정하지 않고 의심 패턴으로만 판정합니다.",
      automatic_order: risk.operatorMode === "AUTOMATED",
      model_note:
        "목표가·손절가·보유기간은 현재까지의 공개 시세 패턴에 근거한 조건부 추정이며 미래 가격을 보장하지 않습니다.",
      confidence_note:
        "신뢰도는 상승 확률이 아니라 기간 데이터 완성도·동적 표본 품질·구조적 지지저항·호가 깊이를 합산한 판정 품질 지표입니다.",
      calibration_profile: {
        source: ACTIVE_CALIBRATION_PROFILE.source,
        promoted: ACTIVE_CALIBRATION_PROFILE.promoted,
        samples: ACTIVE_CALIBRATION_PROFILE.samples,
        markets: ACTIVE_CALIBRATION_PROFILE.markets,
        generated_at: ACTIVE_CALIBRATION_PROFILE.generatedAt,
      },
      forecast_note:
        "예상 상승률은 목표가를 그대로 복사하지 않고 동일 점수구간의 백테스트 MFE와 목표 선도달률로 축소·보정합니다. 충분한 교정 표본이 없으면 보수적 사전값을 표시합니다.",
    },
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date(generatedAt).toISOString(),
      elapsed_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      exchange,
      quote_currency: binance ? "USDT" : "KRW",
      data_source: binance
        ? "BINANCE_PUBLIC_SPOT_REST_API_AND_WEBSOCKET"
        : "UPBIT_PUBLIC_QUOTATION_API_AND_WEBSOCKET",
      auth_mode: "PRIVATE_FRAGMENT_TOKEN",
      auto_order: risk.operatorMode === "AUTOMATED",
    },
  };
}

type SingleScanResult = Awaited<ReturnType<typeof runScan>>;

function combinedRanking(
  upbit: SingleScanResult | null,
  binance: SingleScanResult | null,
) {
  return [
    ...(upbit?.ranking || []).map((row) => ({
      ...row,
      exchange: "upbit" as const,
      exchange_label: "업비트",
      quote_currency: "KRW" as const,
      base_asset: baseAsset(row.market, "upbit"),
    })),
    ...(binance?.ranking || []).map((row) => ({
      ...row,
      exchange: "binance" as const,
      exchange_label: "바이낸스",
      quote_currency: "USDT" as const,
      base_asset: baseAsset(row.market, "binance"),
    })),
  ].sort((left, right) => right.period_score - left.period_score)
    .slice(0, 20)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function runCombinedScan(
  upbitRisk: RiskConfig,
  binanceRisk: RiskConfig,
) {
  const started = Date.now();
  const [upbitSettled, binanceSettled] = await Promise.allSettled([
    runScan(upbitRisk, "upbit"),
    runScan(binanceRisk, "binance"),
  ]);
  const upbit = upbitSettled.status === "fulfilled" ? upbitSettled.value : null;
  const binance = binanceSettled.status === "fulfilled"
    ? binanceSettled.value
    : null;
  if (!upbit && !binance) {
    const left = upbitSettled.status === "rejected"
      ? String(upbitSettled.reason)
      : "unknown";
    const right = binanceSettled.status === "rejected"
      ? String(binanceSettled.reason)
      : "unknown";
    throw new Error(
      `두 거래소 스캔이 모두 실패했습니다. Upbit: ${left} / Binance: ${right}`,
    );
  }

  const finalists = combineCandidates(
    upbit?.finalists || [],
    binance?.finalists || [],
    20,
  );
  const recommendations = finalists.filter((candidate) =>
    candidate.decision === "BUY" && candidate.trade_plan.actionable &&
    !candidate.cross_exchange.conflict
  );
  const watchlist = finalists.filter((candidate) =>
    candidate.decision !== "BUY"
  );
  const generatedAt = Date.now();
  const scanErrors = [
    upbitSettled.status === "rejected"
      ? { exchange: "upbit", message: String(upbitSettled.reason) }
      : null,
    binanceSettled.status === "rejected"
      ? { exchange: "binance", message: String(binanceSettled.reason) }
      : null,
  ].filter(Boolean);
  const status = recommendations.length ? "BUY_CANDIDATES" : "NO_BUY";
  const listed = (upbit?.coverage.listed_markets || 0) +
    (binance?.coverage.listed_markets || 0);
  const eligible = (upbit?.coverage.eligible_after_safety_filter || 0) +
    (binance?.coverage.eligible_after_safety_filter || 0);
  const deep = (upbit?.coverage.deep_period_analyzed || 0) +
    (binance?.coverage.deep_period_analyzed || 0);
  const micro = (upbit?.coverage.microstructure_finalists || 0) +
    (binance?.coverage.microstructure_finalists || 0);
  const dynamicUpbit = upbit?.coverage.dynamic_orderflow;
  const dynamicBinance = binance?.coverage.dynamic_orderflow;

  return {
    scan_id: crypto.randomUUID(),
    status,
    headline: recommendations.length
      ? `업비트·바이낸스 동시 점검 결과, 현재 매수 강제조건을 통과한 통합 LOB 후보 ${recommendations.length}개가 탐지됐습니다.`
      : finalists.length
      ? `업비트·바이낸스 동시 점검 결과, 현재가 매수 후보는 없으며 조건부 관찰 Top ${finalists.length}개를 제시합니다.`
      : "업비트·바이낸스 동시 점검 결과, 안전하게 제시할 통합 후보가 없습니다.",
    primary: recommendations[0] || null,
    recommendations,
    watchlist,
    finalists,
    ranking: combinedRanking(upbit, binance),
    coverage: {
      exchange: "combined",
      exchange_label: "업비트 + 바이낸스 통합",
      quote_currency: "MIXED",
      listed_markets: listed,
      listed_krw_markets: listed,
      eligible_after_safety_filter: eligible,
      excluded_at_universe_stage:
        (upbit?.coverage.excluded_at_universe_stage || 0) +
        (binance?.coverage.excluded_at_universe_stage || 0),
      period_screened_markets: (upbit?.coverage.period_screened_markets || 0) +
        (binance?.coverage.period_screened_markets || 0),
      period_screened_complete:
        (upbit?.coverage.period_screened_complete || 0) +
        (binance?.coverage.period_screened_complete || 0),
      deep_period_analyzed: deep,
      microstructure_finalists: micro,
      combined_finalists: finalists.length,
      dynamic_orderflow: {
        requested_observation_seconds: Math.max(
          dynamicUpbit?.requested_observation_seconds || 0,
          dynamicBinance?.requested_observation_seconds || 0,
        ),
        websocket_markets: (dynamicUpbit?.websocket_markets || 0) +
          (dynamicBinance?.websocket_markets || 0),
        sufficient_markets: (dynamicUpbit?.sufficient_markets || 0) +
          (dynamicBinance?.sufficient_markets || 0),
      },
      excluded_summary: [
        ...(upbit?.coverage.excluded_summary || []).map((item) => ({
          reason: `[업비트] ${item.reason}`,
          count: item.count,
        })),
        ...(binance?.coverage.excluded_summary || []).map((item) => ({
          reason: `[바이낸스] ${item.reason}`,
          count: item.count,
        })),
      ],
      exchanges: {
        upbit: upbit?.coverage || null,
        binance: binance?.coverage || null,
      },
      periods: {
        "5m": "최근 12시간(144봉)",
        "15m": "최근 48시간(192봉)",
        "4h": "최근 30일(180봉)",
        "1d": "최근 200일(200봉)",
      },
    },
    assumptions: {
      exchange: "combined",
      upbit: upbit?.assumptions || null,
      binance: binance?.assumptions || null,
      risk_per_trade_pct: upbitRisk.riskPct,
      automatic_order: upbitRisk.operatorMode === "AUTOMATED",
      calibration_profile: {
        source: ACTIVE_CALIBRATION_PROFILE.source,
        promoted: ACTIVE_CALIBRATION_PROFILE.promoted,
        samples: ACTIVE_CALIBRATION_PROFILE.samples,
        markets: ACTIVE_CALIBRATION_PROFILE.markets,
        generated_at: ACTIVE_CALIBRATION_PROFILE.generatedAt,
      },
      cross_exchange_rule:
        "동일 기초자산은 한 자리만 사용하며, 다른 거래소에서 AVOID 또는 동적 호가 위험이 나오면 BUY를 WAIT로 강등합니다.",
      model_note:
        "통합 순위는 거래소별 엔진 점수와 교차거래소 방향 일치를 이용하지만, 서로 다른 통화의 가격·거래대금은 직접 합산하지 않습니다.",
    },
    exchange_errors: scanErrors,
    exchanges: { upbit, binance },
    diagnostics: { upbit: upbit?.diagnostics ?? null, binance: binance?.diagnostics ?? null },
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date(generatedAt).toISOString(),
      elapsed_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      exchange: "combined",
      quote_currency: "MIXED",
      data_source: "UPBIT_AND_BINANCE_PUBLIC_SPOT_REST_API_AND_WEBSOCKET",
      auth_mode: "PRIVATE_FRAGMENT_TOKEN",
      auto_order: upbitRisk.operatorMode === "AUTOMATED",
    },
  };
}

Deno.serve(async (request: Request) => {
  const automatedRequest = automationAllowed(request);
  if (request.method === "OPTIONS") {
    if (!automatedRequest && !originAllowed(request)) {
      return new Response("origin not allowed", {
        status: 403,
        headers: corsHeaders(request),
      });
    }
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (!automatedRequest && !originAllowed(request)) {
    return json(request, { error: "허용되지 않은 접속 주소입니다." }, 403);
  }
  if (request.method !== "POST") {
    return json(request, { error: "POST 요청만 지원합니다." }, 405);
  }
  if (!(Deno.env.get("SCAN_ACCESS_TOKEN") || "").trim()) {
    return json(request, {
      error: "서버의 SCAN_ACCESS_TOKEN이 설정되지 않았습니다.",
    }, 500);
  }
  if (!automatedRequest && !tokenAllowed(request)) {
    return json(request, { error: "개인 접속 URL이 올바르지 않습니다." }, 401);
  }

  const rawBody: unknown = await request.json().catch(() => ({}));
  const body: Record<string, unknown> = rawBody &&
      typeof rawBody === "object" && !Array.isArray(rawBody)
    ? rawBody as Record<string, unknown>
    : {};
  if (String(body.action || "scan") !== "scan") {
    return json(request, { error: "지원하지 않는 action입니다." }, 400);
  }
  const requestedMode = String(body.exchange || "combined").toLowerCase();
  const scanMode: ScanMode = requestedMode === "binance"
    ? "binance"
    : ["combined", "both", "all"].includes(requestedMode)
    ? "combined"
    : "upbit";
  const codeDefaults: LearningParameters = {
    scoreThreshold: CALIBRATED_PARAMETERS.scoreThreshold,
    minNetRR: CALIBRATED_PARAMETERS.minNetRR,
    shortTargetAtrMult: CALIBRATED_PARAMETERS.shortTargetAtrMult,
    stopAtrMult: CALIBRATED_PARAMETERS.stopAtrMult,
    mediumTargetAtr4hMult: CALIBRATED_PARAMETERS.mediumTargetAtr4hMult,
    mediumTargetAtrDayMult: CALIBRATED_PARAMETERS.mediumTargetAtrDayMult,
    minStructuralHeadroomNetPct: 0.6,
    minCostMultiple: 2,
    minTradePressure: -0.2,
    maxNegativeBookImbalance: -0.4,
    minDepthCoverage: 1.5,
    maxSlippageBps: 20,
    maxSpreadBps: 35,
    stopMinAtr4hMult: 1,
    stopMinAtr15mMult: 1.5,
    firstTargetAllocationPct: 60,
    exitPolicy: "SCALE_OUT",
  };
  const runtimeProfile = await loadRuntimeProfile(codeDefaults);
  const upbitRisk = applyRuntimeRisk(parseRisk(body, "upbit", runtimeProfile.parameters), runtimeProfile, codeDefaults);
  const binanceRisk = applyRuntimeRisk(parseRisk(body, "binance", runtimeProfile.parameters), runtimeProfile, codeDefaults);
  const cacheKey = JSON.stringify({ scanMode, upbitRisk, binanceRisk, profileVersion: runtimeProfile.version });
  const now = Date.now();
  if (
    cachedResult && cachedResult.expires > now && cachedResult.key === cacheKey
  ) {
    return json(request, { ...cachedResult.value as object, cached: true });
  }
  if (activeScan) {
    return json(request, {
      error: "이미 전체 시장 스캔이 진행 중입니다. 잠시 후 다시 시도하세요.",
    }, 409);
  }
  if (now - lastScanStartedAt < REQUEST_COOLDOWN_MS) {
    const retry = Math.ceil(
      (REQUEST_COOLDOWN_MS - (now - lastScanStartedAt)) / 1000,
    );
    return json(request, {
      error: `연속 호출 제한입니다. ${retry}초 후 다시 시도하세요.`,
    }, 429);
  }

  activeScan = true;
  lastScanStartedAt = now;
  try {
    const result = scanMode === "combined"
      ? await runCombinedScan(upbitRisk, binanceRisk)
      : await runScan(
        scanMode === "upbit" ? upbitRisk : binanceRisk,
        scanMode,
      );
    const persistence = await persistScan(result, runtimeProfile, { upbit: upbitRisk, binance: binanceRisk }).catch((error) => ({
      stored: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }));
    // v6.3.1: a swallowed catch is how a broken scan can look healthy for half an hour.
    if (!persistence.stored) {
      console.error(`[market-scanner] scan not persisted: ${persistence.reason || "unknown"}`);
    }
    const enriched = {
      ...result,
      learning: {
        mode: "BACKGROUND_FORWARD_AUTO_CALIBRATION",
        profile_version: runtimeProfile.version,
        profile_source: runtimeProfile.source,
        profile_samples: runtimeProfile.samples,
        validation_samples: runtimeProfile.validationSamples,
        weekly_guardrails: codeDefaults,
        active_parameters: runtimeProfile.parameters,
        operator_profile: upbitRisk.operatorMode === "AUTOMATED"
          ? { scan_interval_minutes: 5, monitor_interval_seconds: 15, mode: "AUTOMATED", max_unattended_hours: 24 }
          : { daily_checks: "2_3", mode: "LOW_TOUCH", max_unattended_hours: 10 },
        scan_persisted: persistence.stored,
        persistence_note: persistence.reason || null,
      },
    };
    cachedResult = {
      expires: Date.now() + RESPONSE_CACHE_MS,
      key: cacheKey,
      value: enriched,
    };
    return json(request, enriched);
  } catch (error) {
    console.error("market scan failed", error);
    return json(request, {
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  } finally {
    activeScan = false;
  }
});
