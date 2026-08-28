import { type Bar, BAR_MS, FIVE_MINUTE_MS, type UniverseMarket } from "./types.ts";

export const BINANCE_USDM_BASE_URL = "https://fapi.binance.com";
export const MINIMUM_RESEARCH_LOOKBACK_DAYS = 120;
export const BINANCE_REQUEST_MIN_INTERVAL_MS = 175;

const DAY_MS = 86_400_000;
const DEFAULT_PAGE_LIMIT = 1_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_ERROR_BODY_CHARS = 500;

// One queue per Edge Function isolate. It sequences request *starts* without
// holding the queue for the response, so 15m, 5m, universe and retry traffic
// all share the same weight-safe cadence while network I/O may still overlap.
let requestStartQueue: Promise<void> = Promise.resolve();
let lastRequestStart = Number.NEGATIVE_INFINITY;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BinanceHttpOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  sleepFn?: (milliseconds: number) => Promise<void>;
  /**
   * Custom-fetch pacing for deterministic tests. The injected-fetch default is
   * zero; global production fetch is always clamped to at least 175ms.
   */
  requestPaceMs?: number;
}

/**
 * `startTime` and `endTime` are inclusive kline open-time bounds and must be
 * aligned to the requested interval. `asOfTime` is the research observation
 * time; a kline whose Binance close time is not before it is never returned.
 */
export interface ClosedKlineRequest extends BinanceHttpOptions {
  startTime?: number;
  endTime?: number;
  asOfTime?: number;
  lookbackDays?: number;
  pageLimit?: number;
  maxPages?: number;
}

export interface ClosedFiveMinuteKlineRequest extends BinanceHttpOptions {
  startTime: number;
  endTime?: number;
  asOfTime?: number;
  pageLimit?: number;
  maxPages?: number;
}

interface ParsedKline {
  bar: Bar;
  closeTime: number;
}

class BinanceHttpError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number;

  constructor(
    message: string,
    retryable: boolean,
    retryAfterMs = 0,
  ) {
    super(message);
    this.name = "BinanceHttpError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function finiteInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

function positiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = finiteInteger(value, name);
  if (parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = String(value || BINANCE_USDM_BASE_URL).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Binance baseUrl must use http or https");
  return baseUrl;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestPaceMilliseconds(options: BinanceHttpOptions): number {
  const configured = options.requestPaceMs === undefined
    ? undefined
    : finiteInteger(options.requestPaceMs, "requestPaceMs");
  if (configured !== undefined && (configured < 0 || configured > 60_000)) {
    throw new Error("requestPaceMs must be between 0 and 60000");
  }
  return options.fetchFn
    ? configured ?? 0
    : Math.max(BINANCE_REQUEST_MIN_INTERVAL_MS, configured ?? 0);
}

async function startPacedRequest<T>(
  minimumIntervalMs: number,
  start: () => Promise<T>,
): Promise<T> {
  if (minimumIntervalMs === 0) return start();

  let release!: () => void;
  const predecessor = requestStartQueue;
  requestStartQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  let pending: Promise<T>;
  try {
    // Timers are permitted to wake slightly early. Recheck the monotonic clock
    // until the full interval has elapsed before releasing the next starter.
    while (true) {
      const remaining = minimumIntervalMs - (performance.now() - lastRequestStart);
      if (remaining <= 0) break;
      await defaultSleep(remaining);
    }
    pending = start();
  } finally {
    // Record after invoking fetch (including a synchronous start failure): the
    // next attempt is separated from the actual start, not queue admission.
    lastRequestStart = performance.now();
    release();
  }
  return pending;
}

function retryAfterMilliseconds(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

async function fetchJson(path: string, options: BinanceHttpOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const requestPaceMs = requestPaceMilliseconds(options);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
    10,
  );
  const initialRetryDelayMs = positiveInteger(
    options.initialRetryDelayMs ?? 400,
    "initialRetryDelayMs",
    30_000,
  );
  const sleepFn = options.sleepFn ?? defaultSleep;
  let lastError: unknown = new Error("Binance request failed");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await startPacedRequest(requestPaceMs, () => {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetchFn(`${baseUrl}${path}`, {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": "trading-booooo-regime-router-v5-research/1.0",
          },
        });
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 418 || response.status === 429 ||
          response.status >= 500;
        throw new BinanceHttpError(
          `Binance HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
          retryable,
          retryAfterMilliseconds(response),
        );
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        throw new BinanceHttpError("Binance returned invalid JSON", false);
      }
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof BinanceHttpError) || error.retryable;
      if (!retryable || attempt + 1 >= maxAttempts) throw error;

      const exponentialDelay = Math.min(20_000, initialRetryDelayMs * 2 ** attempt);
      const retryAfter = error instanceof BinanceHttpError ? error.retryAfterMs : 0;
      await sleepFn(Math.max(exponentialDelay, retryAfter));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw lastError;
}

function parseOnboardDate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Returns every active standard PERPETUAL listed by USDⓈ-M exchangeInfo. */
export async function listActivePerpetualMarkets(
  options: BinanceHttpOptions = {},
): Promise<UniverseMarket[]> {
  const payload = await fetchJson("/fapi/v1/exchangeInfo", options);
  const symbols = (payload as { symbols?: unknown })?.symbols;
  if (!Array.isArray(symbols)) throw new Error("Binance exchangeInfo omitted symbols");

  const markets = new Map<string, UniverseMarket>();
  for (const value of symbols) {
    const row = value as Record<string, unknown>;
    if (row?.status !== "TRADING" || row?.contractType !== "PERPETUAL") continue;

    const symbol = String(row.symbol || "").trim();
    const quoteAsset = String(row.quoteAsset || "").trim();
    const marginAsset = String(row.marginAsset || "").trim();
    if (!symbol || !quoteAsset || !marginAsset) {
      throw new Error("Active Binance perpetual is missing symbol, quoteAsset, or marginAsset");
    }
    if (markets.has(symbol)) throw new Error(`Duplicate active Binance perpetual: ${symbol}`);

    markets.set(symbol, {
      symbol,
      quoteAsset,
      marginAsset,
      onboardDate: parseOnboardDate(row.onboardDate),
    });
  }
  return [...markets.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function parseKline(value: unknown, page: number, rowIndex: number): ParsedKline {
  if (!Array.isArray(value) || value.length < 8) {
    throw new Error(`Malformed Binance kline at page ${page}, row ${rowIndex}`);
  }
  const parsed = value.slice(0, 8).map(Number);
  const [time, open, high, low, close, volume, closeTime, quoteVolume] = parsed;
  if (
    !Number.isSafeInteger(time) || !Number.isSafeInteger(closeTime) ||
    ![open, high, low, close, volume, quoteVolume].every(Number.isFinite) ||
    open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || quoteVolume < 0 ||
    high < Math.max(open, close, low) || low > Math.min(open, close, high) || closeTime < time
  ) {
    throw new Error(`Invalid Binance kline at page ${page}, row ${rowIndex}`);
  }
  return {
    bar: { time, open, high, low, close, volume, quoteVolume },
    closeTime,
  };
}

function assertAligned(timestamp: number, intervalMs: number, name: string): void {
  if (timestamp % intervalMs !== 0) {
    throw new Error(`${name} must be aligned to the ${intervalMs / 60_000}m interval`);
  }
}

function symbolOf(market: string | UniverseMarket): string {
  const symbol = typeof market === "string" ? market.trim() : String(market?.symbol || "").trim();
  if (!symbol) throw new Error("Binance market symbol is required");
  return symbol;
}

function onboardDateOf(market: string | UniverseMarket): number | null {
  if (typeof market === "string" || market.onboardDate === null) return null;
  return finiteInteger(market.onboardDate, "market.onboardDate");
}

/**
 * Returns the first complete exchange interval bucket that V5 requires for a
 * market.  An in-window listing may have an incomplete bucket containing its
 * onboard timestamp, so that bucket is deliberately not required: coverage
 * begins at the first aligned bucket at or after `onboardDate`.
 */
export function firstRequiredKlineOpen(
  requestedStart: number,
  intervalMs: number,
  onboardDate: number | null,
): number {
  const start = finiteInteger(requestedStart, "requestedStart");
  const interval = positiveInteger(intervalMs, "intervalMs");
  assertAligned(start, interval, "requestedStart");
  if (onboardDate === null) return start;
  const onboard = finiteInteger(onboardDate, "onboardDate");
  if (onboard <= start) return start;
  return Math.ceil(onboard / interval) * interval;
}

/**
 * Fail-closed coverage assertion used both by the real Binance adapter and by
 * V5 orchestration after dependency-injected fetches.  The returned series
 * must contain every aligned bucket from the causal required start through the
 * frozen tail.  No bar before an in-window contract's first complete bucket is
 * required.
 */
export function assertExpectedClosedBarCoverage(
  bars: readonly Bar[],
  intervalMs: number,
  requestedStart: number,
  requestedEnd: number,
  onboardDate: number | null,
  market: string,
): void {
  const interval = positiveInteger(intervalMs, "intervalMs");
  const start = finiteInteger(requestedStart, "requestedStart");
  const end = finiteInteger(requestedEnd, "requestedEnd");
  assertAligned(start, interval, "requestedStart");
  assertAligned(end, interval, "requestedEnd");
  if (end < start) throw new Error("requestedEnd must not precede requestedStart");
  const requiredStart = firstRequiredKlineOpen(start, interval, onboardDate);
  const expectedBars = requiredStart > end ? 0 : (end - requiredStart) / interval + 1;
  if (!Number.isSafeInteger(expectedBars)) {
    throw new Error(`${market} expected coverage is not interval-aligned`);
  }
  if (bars.length !== expectedBars) {
    throw new Error(
      `${market} incomplete ${interval / 60_000}m coverage: ` +
        `${bars.length}/${expectedBars} bars required from ${requiredStart} through ${end}`,
    );
  }
  for (let index = 0; index < bars.length; index++) {
    const expectedTime = requiredStart + index * interval;
    if (bars[index].time !== expectedTime) {
      throw new Error(
        `${market} incomplete ${interval / 60_000}m coverage at ${expectedTime}: ` +
          `received ${bars[index].time}`,
      );
    }
  }
}

async function fetchClosedBars(
  market: string | UniverseMarket,
  interval: "15m" | "5m",
  intervalMs: number,
  startTime: number,
  endTime: number,
  asOfTime: number,
  options: ClosedKlineRequest,
): Promise<Bar[]> {
  const symbol = symbolOf(market);
  assertAligned(startTime, intervalMs, "startTime");
  assertAligned(endTime, intervalMs, "endTime");
  if (endTime < startTime) throw new Error("endTime must not precede startTime");

  const pageLimit = positiveInteger(options.pageLimit ?? DEFAULT_PAGE_LIMIT, "pageLimit", 1_500);
  const requestedBars = Math.floor((endTime - startTime) / intervalMs) + 1;
  const minimumPages = Math.ceil(requestedBars / pageLimit);
  const maxPages = positiveInteger(options.maxPages ?? minimumPages + 2, "maxPages", 1_000);
  if (maxPages < minimumPages) {
    throw new Error(`maxPages ${maxPages} cannot cover the requested ${requestedBars} bars`);
  }

  const barsByTime = new Map<number, Bar>();
  const queryEndTime = Math.min(asOfTime - 1, endTime + intervalMs - 1);
  let cursor = startTime;
  let page = 0;
  let reachedNaturalEnd = false;

  while (cursor <= endTime && page < maxPages) {
    const query = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursor),
      endTime: String(queryEndTime),
      limit: String(pageLimit),
    });
    const payload = await fetchJson(`/fapi/v1/klines?${query.toString()}`, options);
    if (!Array.isArray(payload)) throw new Error("Binance klines response was not an array");
    if (payload.length === 0) {
      reachedNaturalEnd = true;
      break;
    }

    const parsed = payload.map((value, rowIndex) => parseKline(value, page, rowIndex));
    for (let index = 1; index < parsed.length; index++) {
      if (parsed[index].bar.time <= parsed[index - 1].bar.time) {
        throw new Error(`Binance klines are not strictly ordered on page ${page}`);
      }
    }

    for (const item of parsed) {
      const { bar, closeTime } = item;
      if (
        bar.time < startTime || bar.time > endTime || closeTime >= asOfTime ||
        closeTime > queryEndTime
      ) continue;
      const existing = barsByTime.get(bar.time);
      if (existing && JSON.stringify(existing) !== JSON.stringify(bar)) {
        throw new Error(`Conflicting duplicate Binance kline at ${bar.time}`);
      }
      barsByTime.set(bar.time, bar);
    }

    const nextCursor = parsed[parsed.length - 1].bar.time + intervalMs;
    if (nextCursor <= cursor) throw new Error("Binance kline pagination did not advance");
    cursor = nextCursor;
    page++;
    if (payload.length < pageLimit || cursor > endTime) {
      reachedNaturalEnd = true;
      break;
    }
  }

  if (!reachedNaturalEnd && cursor <= endTime) {
    throw new Error(
      `Binance kline pagination cap reached for ${symbol}: ${page}/${maxPages} pages`,
    );
  }
  const onboardDate = onboardDateOf(market);
  const requiredStart = firstRequiredKlineOpen(startTime, intervalMs, onboardDate);
  // Binance may return the partial bucket containing an unaligned onboardDate.
  // It is real data, but V5 excludes it so every retained bar represents one
  // complete interval after listing and the required series has one identity.
  const bars = [...barsByTime.values()]
    .filter((bar) => bar.time >= requiredStart)
    .sort((left, right) => left.time - right.time);
  assertExpectedClosedBarCoverage(
    bars,
    intervalMs,
    startTime,
    endTime,
    onboardDate,
    symbol,
  );
  return bars;
}

/**
 * Fetches actual Binance 15-minute klines over a requested window of at least
 * 120 days. Recently listed markets return the complete causal tail beginning
 * at their first full aligned interval after onboarding.
 */
export async function fetchClosed15mBars(
  market: string | UniverseMarket,
  options: ClosedKlineRequest = {},
): Promise<Bar[]> {
  const asOfTime = finiteInteger(options.asOfTime ?? Date.now(), "asOfTime");
  const latestClosedOpen = Math.floor(asOfTime / BAR_MS) * BAR_MS - BAR_MS;
  const requestedEnd = options.endTime === undefined
    ? latestClosedOpen
    : finiteInteger(options.endTime, "endTime");
  assertAligned(requestedEnd, BAR_MS, "endTime");
  const endTime = Math.min(requestedEnd, latestClosedOpen);

  const lookbackDays = positiveInteger(
    options.lookbackDays ?? MINIMUM_RESEARCH_LOOKBACK_DAYS,
    "lookbackDays",
    3650,
  );
  if (lookbackDays < MINIMUM_RESEARCH_LOOKBACK_DAYS) {
    throw new Error(
      `15m research lookback must be at least ${MINIMUM_RESEARCH_LOOKBACK_DAYS} days`,
    );
  }
  const defaultStart = endTime - lookbackDays * DAY_MS + BAR_MS;
  const startTime = options.startTime === undefined
    ? defaultStart
    : finiteInteger(options.startTime, "startTime");
  assertAligned(startTime, BAR_MS, "startTime");

  const requestedSpan = endTime - startTime + BAR_MS;
  if (requestedSpan < MINIMUM_RESEARCH_LOOKBACK_DAYS * DAY_MS) {
    throw new Error(
      `15m research window must span at least ${MINIMUM_RESEARCH_LOOKBACK_DAYS} days`,
    );
  }
  return fetchClosedBars(market, "15m", BAR_MS, startTime, endTime, asOfTime, options);
}

/** Fetches real 5-minute klines directly from Binance; it never resamples 15m data. */
export async function fetchClosed5mBars(
  market: string | UniverseMarket,
  options: ClosedFiveMinuteKlineRequest,
): Promise<Bar[]> {
  const asOfTime = finiteInteger(options.asOfTime ?? Date.now(), "asOfTime");
  const latestClosedOpen = Math.floor(asOfTime / FIVE_MINUTE_MS) * FIVE_MINUTE_MS -
    FIVE_MINUTE_MS;
  const startTime = finiteInteger(options.startTime, "startTime");
  const requestedEnd = options.endTime === undefined
    ? latestClosedOpen
    : finiteInteger(options.endTime, "endTime");
  assertAligned(requestedEnd, FIVE_MINUTE_MS, "endTime");
  const endTime = Math.min(requestedEnd, latestClosedOpen);
  return fetchClosedBars(
    market,
    "5m",
    FIVE_MINUTE_MS,
    startTime,
    endTime,
    asOfTime,
    options,
  );
}
