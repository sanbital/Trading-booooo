// Trading-booooo Market Scanner v2.2.0 — Supabase Edge Function
// Upbit KRW / Binance USDT universe scan -> multi-period analysis -> orderflow validation.
// Read-only public market data. No account lookup, order creation, cancellation, or API keys.

import {
  analyzePeriod,
  buildUniverse,
  type CandleRow,
  clamp,
  computeMicrostructure,
  ENGINE_VERSION,
  type FinalCandidate,
  finalizeCandidate,
  type MarketRow,
  type OrderbookSnapshot,
  type PeriodAnalysis,
  type PeriodDataset,
  type RiskConfig,
  selectShortlist,
  type TickerRow,
  timeframeMetrics,
  type TradeRow,
  type UniverseRow,
} from "./engine.ts";

const UPBIT = "https://api.upbit.com";
const UPBIT_WEBSOCKET = "wss://api.upbit.com/websocket/v1";
const BINANCE = "https://api.binance.com";
const BINANCE_WEBSOCKET = "wss://stream.binance.com:9443/stream";
const MIN_BINANCE_TURNOVER_24H = 500_000;
const MIN_BINANCE_ACTIONABLE_TURNOVER_24H = 1_000_000;
const DEFAULT_DEEP_SCAN_LIMIT = 30;
const FINALIST_LIMIT = 8;
const BOOK_SAMPLE_COUNT = 4;
const BOOK_SAMPLE_INTERVAL_MS = 600;
const DEFAULT_DYNAMIC_OBSERVATION_MS = 18_000;
const MIN_DYNAMIC_OBSERVATION_MS = 12_000;
const MAX_DYNAMIC_OBSERVATION_MS = 30_000;
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
): RiskConfig {
  const binance = exchange === "binance";
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
      finite(body.fee_per_side_pct, binance ? 0.1 : 0.05),
      0,
      0.5,
    ),
    minNetRR: clamp(finite(body.min_net_rr, 1.5), 1, 5),
    maxStopPct: clamp(finite(body.max_stop_pct, 5), 0.5, 12),
    entrySlippageTicks: clamp(finite(body.entry_slippage_ticks, 0.5), 0, 5),
    exitSlippageTicks: clamp(finite(body.exit_slippage_ticks, 1), 0, 10),
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
        count: 72,
      },
      {
        market: row.market,
        key: "h4",
        path: "/v1/candles/minutes/240",
        count: 90,
      },
      { market: row.market, key: "day", path: "/v1/candles/days", count: 60 },
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
    url: query("/v1/candles/minutes/15", { market: row.market, count: 96 }),
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
            limit: 96,
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
    { market: row.market, key: "m5" as const, interval: "5m", limit: 72 },
    { market: row.market, key: "h4" as const, interval: "4h", limit: 90 },
    { market: row.market, key: "day" as const, interval: "1d", limit: 60 },
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
    const dataScore = metric.bars >= 60
      ? clamp(
        50 + metric.trend_signal * 27 + metric.momentum_signal * 15 +
          clamp((metric.volume_ratio - 1) * 8, -8, 8),
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

function dynamicObservationMs(): number {
  return Math.round(
    clamp(
      finite(
        Deno.env.get("MICRO_OBSERVATION_MS"),
        DEFAULT_DYNAMIC_OBSERVATION_MS,
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
): Promise<MicroBundle> {
  const markets = finalists.map((item) => item.universe.market);
  const marketList = markets.join(",");
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map<string, TradeRow[]>();
  const ticks = new Map<string, number>();
  const observationMs = dynamicObservationMs();
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
): Promise<MicroBundle> {
  const markets = finalists.map((item) => item.universe.market);
  const snapshots = new Map(
    markets.map((market) => [market, [] as OrderbookSnapshot[]]),
  );
  const trades = new Map<string, TradeRow[]>();
  const ticks = new Map(instrumentTicks);
  const observationMs = dynamicObservationMs();
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
  const deepLimit = Math.round(
    clamp(
      finite(Deno.env.get("DEEP_SCAN_LIMIT"), DEFAULT_DEEP_SCAN_LIMIT),
      20,
      40,
    ),
  );
  const eligible = universe.filter((item) => item.eligible);
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

  const candidatePool = [
    ...periods.filter((item) => item.preliminary_status === "CANDIDATE"),
    ...periods.filter((item) => item.preliminary_status !== "CANDIDATE"),
  ];
  const finalists = [
    ...new Map(candidatePool.map((item) => [item.universe.market, item]))
      .values(),
  ]
    .slice(0, FINALIST_LIMIT);
  const microBundle = binance
    ? await loadBinanceMicrostructure(finalists, instrumentTicks)
    : await loadMicrostructure(finalists);
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
      );
    })
    .sort((a, b) => {
      if (a.decision === "BUY" && b.decision !== "BUY") return -1;
      if (a.decision !== "BUY" && b.decision === "BUY") return 1;
      return b.score - a.score;
    });
  finalCandidates.forEach((candidate, index) => candidate.rank = index + 1);
  const recommendations = finalCandidates.filter((item) =>
    item.decision === "BUY"
  ).slice(0, 3);
  const watchlist = finalCandidates.filter((item) => item.decision !== "BUY")
    .slice(0, 5);
  const status = recommendations.length ? "BUY_CANDIDATES" : "NO_BUY";

  return {
    scan_id: crypto.randomUUID(),
    status,
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
        [...baseline15.values()].filter((rows) => rows.length >= 60).length,
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
        "5m": "최근 6시간(72봉)",
        "15m": "최근 24시간(96봉)",
        "4h": "최근 15일(90봉)",
        "1d": "최근 60일(60봉)",
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
      dynamic_observation_seconds: Number(
        (microBundle.observationMs / 1000).toFixed(1),
      ),
      dynamic_orderflow_note:
        "공개 호가에는 주문자·개별 주문 ID·숨은 잔량이 없어 스푸핑·아이스버그를 확정하지 않고 의심 패턴으로만 판정합니다.",
      automatic_order: false,
      model_note:
        "목표가·손절가·보유기간은 현재까지의 공개 시세 패턴에 근거한 조건부 추정이며 미래 가격을 보장하지 않습니다.",
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
      auto_order: false,
    },
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    if (!originAllowed(request)) {
      return new Response("origin not allowed", {
        status: 403,
        headers: corsHeaders(request),
      });
    }
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (!originAllowed(request)) {
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
  if (!tokenAllowed(request)) {
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
  const exchange: Exchange = String(body.exchange || "upbit").toLowerCase() ===
      "binance"
    ? "binance"
    : "upbit";
  const risk = parseRisk(body, exchange);
  const cacheKey = JSON.stringify({ exchange, risk });
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
    const result = await runScan(risk, exchange);
    cachedResult = {
      expires: Date.now() + RESPONSE_CACHE_MS,
      key: cacheKey,
      value: result,
    };
    return json(request, result);
  } catch (error) {
    console.error("market scan failed", error);
    return json(request, {
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  } finally {
    activeScan = false;
  }
});
