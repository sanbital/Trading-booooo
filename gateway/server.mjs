import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns";
import { pathToFileURL } from "node:url";

// Trading-booooo v8.0.0-P10-DONCHIAN-SLOW4R static-egress order gateway.
//
// It exposes spot account/order primitives plus the Binance USDⓈ-M futures primitives the
// futures lane needs: account/positions, order create/read/cancel, and the per-symbol
// leverage setting. There are still no withdrawal, transfer, cross-wallet transfer or
// API-key management routes. Futures intent is explicit and mechanically checked: only
// BUY/LONG/OPEN, SELL/LONG/CLOSE, SELL/SHORT/OPEN and BUY/SHORT/CLOSE are accepted.
dns.setDefaultResultOrder("ipv4first");

const VERSION = "8.0.0-P10-DONCHIAN-SLOW4R";
// Keep exactly one audited rollback revision during the cutover. This prevents a gateway
// rollout from stopping the still-running engine and preserves an immediate code rollback;
// arbitrary or older revisions remain rejected.
const ROLLBACK_ENGINE_VERSION = "7.6.0-BINANCE-FUTURES";
const ACCEPTED_ENGINE_VERSIONS = new Set([VERSION, ROLLBACK_ENGINE_VERSION]);
const PORT = integerEnv("PORT", 8080, 1, 65535);
const UPBIT_BASE = env("UPBIT_BASE_URL", "https://api.upbit.com").replace(/\/$/, "");
const BINANCE_BASE = env("BINANCE_BASE_URL", "https://api.binance.com").replace(/\/$/, "");
const BINANCE_FUTURES_BASE = env("BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com")
  .replace(/\/$/, "");
const UPBIT_ACCESS_KEY = env("UPBIT_ACCESS_KEY");
const UPBIT_SECRET_KEY = env("UPBIT_SECRET_KEY");
const BINANCE_API_KEY = env("BINANCE_API_KEY");
const BINANCE_SECRET_KEY = env("BINANCE_SECRET_KEY");
const SHARED_SECRET = env("GATEWAY_SHARED_SECRET");
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const SCHEDULER_ENABLED = boolEnv("SCHEDULER_ENABLED", true);
const SCAN_INTERVAL_MS = integerEnv("AUTO_SCAN_INTERVAL_SECONDS", 12, 8, 3600) * 1000;
const COLD_START_SCAN_MS = integerEnv("LOB_COLD_START_SCAN_SECONDS", 3, 1, 120) * 1000;
const MONITOR_INTERVAL_MS = integerEnv("AUTO_MONITOR_INTERVAL_SECONDS", 2, 1, 300) * 1000;
// v5.10.1: 60 -> 180 seconds.
//
// The timestamp is stamped when the caller builds the request and checked when it lands.
// A Supabase Edge isolate can be suspended or delayed in between, and at 60 seconds that
// produced intermittent `401 expired gateway request` — five in fifty minutes, each one a
// lost scan cycle. Replay protection does not depend on this window: the nonce cache does
// that job and holds each nonce for twice the tolerance, so widening it costs nothing.
const REQUEST_TOLERANCE_MS = integerEnv("GATEWAY_REQUEST_TOLERANCE_SECONDS", 180, 10, 600) * 1000;
// Monetary exposure is controlled by the dashboard allocation settings in the autotrader.
// The gateway validates order shape and exchange rules but adds no hidden monetary cap.
const BOT_IDENTIFIER_PREFIX = "tb-";

const nonceCache = new Map();
const rateState = {
  upbit: { groups: new Map(), dailyKey: kstDate(), dailyBuy: 0 },
  binance: { groups: new Map(), dailyKey: utcDate(), dailyBuy: 0 },
  binance_futures: { groups: new Map(), dailyKey: utcDate(), dailyBuy: 0 },
};
const schedulerState = {
  startedAt: new Date().toISOString(),
  egressIpv4: null,
  scanRunning: false,
  monitorRunning: false,
  lastScanAt: null,
  lastMonitorAt: null,
  lastScanResult: null,
  lastMonitorResult: null,
  lastError: null,
};
let binanceTimeOffsetMs = 0;
let lastBinanceTimeSyncAt = 0;
// Per-symbol leverage the gateway has already confirmed with the exchange this process
// lifetime. Binance rejects nothing when leverage is re-sent, but the call is signed and
// rate limited, so it is sent once per symbol and whenever the requested value changes.
const futuresLeverageApplied = new Map();
let futuresDualPositionSide = null;

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}
function boolEnv(name, fallback) {
  const value = env(name);
  return value ? ["1", "true", "yes", "on"].includes(value.toLowerCase()) : fallback;
}
function numberEnv(name, fallback, min, max) {
  const value = Number(env(name));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function integerEnv(name, fallback, min, max) {
  return Math.round(numberEnv(name, fallback, min, max));
}
function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function utcDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function decimal(value, maxDecimals = 16) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("invalid decimal value");
  return n.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
}
function stepPrecision(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(16, Math.max(0, Number(text.split("e-")[1]) || 0));
  return Math.min(16, Math.max(0, (text.split(".")[1] || "").replace(/0+$/, "").length));
}
function floorStep(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!(v > 0 && s > 0)) return 0;
  const precision = stepPrecision(s);
  return Number((Math.floor((v + s * 1e-9) / s) * s).toFixed(precision));
}
function formatStep(value, step) {
  const floored = floorStep(value, step);
  if (!(floored > 0)) return "0";
  return floored.toFixed(stepPrecision(step));
}
function pairs(object = {}) {
  const result = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const arrayKey = key.endsWith("[]") ? key : `${key}[]`;
      for (const item of value) result.push([arrayKey, String(item)]);
    } else result.push([key, String(value)]);
  }
  return result;
}
function rawQueryString(object = {}) {
  return pairs(object).map(([key, value]) => `${key}=${value}`).join("&");
}
function encodedQueryString(object = {}) {
  return pairs(object).map(([key, value]) =>
    `${encodeURIComponent(key).replace(/%5B%5D/g, "[]")}=${encodeURIComponent(value)}`
  ).join("&");
}
function binanceQueryString(object = {}) {
  return Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function createUpbitJwt(parameters = {}) {
  if (!UPBIT_ACCESS_KEY || !UPBIT_SECRET_KEY) {
    throw Object.assign(new Error("UPBIT_ACCESS_KEY/UPBIT_SECRET_KEY are not configured"), {
      status: 503,
      code: "UPBIT_KEYS_MISSING",
    });
  }
  const payload = { access_key: UPBIT_ACCESS_KEY, nonce: crypto.randomUUID() };
  const raw = rawQueryString(parameters);
  if (raw) {
    payload.query_hash = crypto.createHash("sha512").update(raw, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const h = base64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const p = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha512", UPBIT_SECRET_KEY).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
function createBinanceSignature(queryString) {
  if (!BINANCE_SECRET_KEY) {
    throw Object.assign(new Error("BINANCE_SECRET_KEY is not configured"), {
      status: 503,
      code: "BINANCE_KEYS_MISSING",
    });
  }
  return crypto.createHmac("sha256", BINANCE_SECRET_KEY).update(queryString).digest("hex");
}

function pruneNonces(now = Date.now()) {
  for (const [nonce, expiry] of nonceCache.entries()) if (expiry <= now) nonceCache.delete(nonce);
}
function verifyGatewayRequest(req, rawBody) {
  if (!SHARED_SECRET || SHARED_SECRET.length < 32) {
    return { ok: false, status: 503, error: "gateway secret is not configured" };
  }
  const timestamp = req.headers["x-gateway-ts"];
  const nonce = req.headers["x-gateway-nonce"];
  const signature = req.headers["x-gateway-signature"];
  if (!timestamp || !nonce || !signature) {
    return { ok: false, status: 401, error: "missing signed gateway headers" };
  }
  const ts = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REQUEST_TOLERANCE_MS) {
    return { ok: false, status: 401, error: "expired gateway request" };
  }
  pruneNonces(now);
  if (nonceCache.has(String(nonce))) {
    return { ok: false, status: 409, error: "replayed gateway request" };
  }
  const expected = crypto.createHmac("sha256", SHARED_SECRET).update(
    `${timestamp}\n${nonce}\n${rawBody}`,
  ).digest("hex");
  if (!safeEqual(expected, signature)) {
    return { ok: false, status: 401, error: "invalid gateway signature" };
  }
  nonceCache.set(String(nonce), now + REQUEST_TOLERANCE_MS * 2);
  return { ok: true };
}
function upbitRateGroup(method, path, isPublic = false) {
  if (isPublic) {
    if (path.includes("/ticker")) return "ticker";
    if (path.includes("/orderbook")) return "orderbook";
    if (path.includes("/candles/")) return "candle";
    if (path.includes("/trades/")) return "trade";
    if (path.includes("/market")) return "market";
    return "quotation";
  }
  if (method === "POST" && path === "/v1/orders") return "order";
  if (method === "POST" && path === "/v1/orders/test") return "order-test";
  return "exchange-default";
}
function localRateLimit(exchange, group) {
  if (exchange === "upbit") {
    if (group === "order" || group === "order-test") return 7; // official 8/s, keep one request headroom
    if (["ticker", "orderbook", "candle", "trade", "market", "quotation"].includes(group)) return 9; // official 10/s
    return 25; // exchange.default is 30/s
  }
  return 12;
}
function guardRate(exchange, group = "default") {
  const state = rateState[exchange];
  const second = Math.floor(Date.now() / 1000);
  const current = state.groups.get(group) || { second: 0, count: 0 };
  if (current.second !== second) {
    current.second = second;
    current.count = 0;
  }
  current.count++;
  state.groups.set(group, current);
  const max = localRateLimit(exchange, group);
  if (current.count > max) {
    throw Object.assign(new Error(`local ${exchange} ${group} rate guard exceeded`), {
      status: 429,
      code: "LOCAL_RATE_GUARD",
    });
  }
}
function refreshDailyCounter(exchange) {
  const state = rateState[exchange];
  const today = exchange === "upbit" ? kstDate() : utcDate();
  if (state.dailyKey !== today) {
    state.dailyKey = today;
    state.dailyBuy = 0;
  }
}
function enforceBuyCaps(_exchange, notional) {
  if (!(Number(notional) > 0 && Number.isFinite(Number(notional)))) {
    throw new Error("invalid buy notional");
  }
}
function recordBuy(exchange, notional) {
  refreshDailyCounter(exchange);
  rateState[exchange].dailyBuy += Math.max(0, Number(notional) || 0);
}

async function parseResponse(response, exchange) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.msg || data?.message ||
      `${exchange} ${response.status}`;
    const error = new Error(message);
    error.code = data?.error?.name || data?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.data = data;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return { data, headers: response.headers };
}

function contextualizeError(error, context) {
  const wrapped = new Error(`${context}: ${error?.message || String(error)}`);
  wrapped.code = error?.code;
  wrapped.status = error?.status;
  wrapped.data = error?.data;
  wrapped.retryAfter = error?.retryAfter;
  return wrapped;
}
async function upbitRequest(method, path, { query = {}, body = null, timeoutMs = 10_000 } = {}) {
  guardRate("upbit", upbitRateGroup(method, path, false));
  const parameters = method === "GET" || method === "DELETE" ? query : (body || {});
  const encoded = encodedQueryString(query);
  const url = `${UPBIT_BASE}${path}${encoded ? `?${encoded}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${createUpbitJwt(parameters)}`,
        ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    try {
      const parsed = await parseResponse(response, "Upbit");
      return { data: parsed.data, remainingReq: parsed.headers.get("remaining-req") };
    } catch (error) {
      throw contextualizeError(error, `Upbit ${method} ${path}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
async function publicUpbit(path, query = {}) {
  guardRate("upbit", upbitRateGroup("GET", path, true));
  const encoded = encodedQueryString(query);
  const response = await fetch(`${UPBIT_BASE}${path}${encoded ? `?${encoded}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  try {
    return (await parseResponse(response, "Upbit public")).data;
  } catch (error) {
    throw contextualizeError(error, `Upbit public GET ${path}`);
  }
}

/**
 * Spot and USDⓈ-M futures are two hosts behind one API key. `venue` selects the host and
 * the local rate-guard bucket; everything else about signing is identical, including the
 * clock offset, which both hosts share.
 */
function binanceHost(venue) {
  return venue === "binance_futures" ? BINANCE_FUTURES_BASE : BINANCE_BASE;
}
async function syncBinanceTime(force = false) {
  if (!force && Date.now() - lastBinanceTimeSyncAt < 10 * 60_000) return binanceTimeOffsetMs;
  guardRate("binance", "rest");
  const started = Date.now();
  const response = await fetch(`${BINANCE_BASE}/api/v3/time`, {
    headers: { Accept: "application/json" },
  });
  const data = (await parseResponse(response, "Binance time")).data;
  const ended = Date.now();
  const serverTime = Number(data?.serverTime);
  if (!Number.isFinite(serverTime)) throw new Error("Binance time response is invalid");
  binanceTimeOffsetMs = serverTime - Math.round((started + ended) / 2);
  lastBinanceTimeSyncAt = ended;
  return binanceTimeOffsetMs;
}
async function publicBinance(path, query = {}, timeoutMs = 10_000, venue = "binance") {
  guardRate(venue, "rest");
  const encoded = binanceQueryString(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${binanceHost(venue)}${path}${encoded ? `?${encoded}` : ""}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    return (await parseResponse(response, "Binance public")).data;
  } finally {
    clearTimeout(timer);
  }
}
function publicBinanceFutures(path, query = {}, timeoutMs = 10_000) {
  return publicBinance(path, query, timeoutMs, "binance_futures");
}
async function binanceRequest(
  method,
  path,
  parameters = {},
  { timeoutMs = 10_000, retryTimestamp = true, venue = "binance" } = {},
) {
  if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
    throw Object.assign(new Error("BINANCE_API_KEY/BINANCE_SECRET_KEY are not configured"), {
      status: 503,
      code: "BINANCE_KEYS_MISSING",
    });
  }
  guardRate(venue, "rest");
  await syncBinanceTime(false);
  const signed = {
    ...parameters,
    recvWindow: Math.min(5_000, Math.max(1_000, Number(parameters.recvWindow) || 5_000)),
    timestamp: Date.now() + binanceTimeOffsetMs,
  };
  const payload = binanceQueryString(signed);
  const signature = createBinanceSignature(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${binanceHost(venue)}${path}?${payload}&signature=${signature}`,
      {
        method,
        signal: controller.signal,
        headers: { Accept: "application/json", "X-MBX-APIKEY": BINANCE_API_KEY },
      },
    );
    try {
      const parsed = await parseResponse(response, "Binance");
      return { data: parsed.data, headers: parsed.headers };
    } catch (error) {
      if (retryTimestamp && Number(error?.code) === -1021) {
        await syncBinanceTime(true);
        return binanceRequest(method, path, parameters, {
          timeoutMs,
          retryTimestamp: false,
          venue,
        });
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}
function futuresRequest(method, path, parameters = {}, options = {}) {
  return binanceRequest(method, path, parameters, { ...options, venue: "binance_futures" });
}

const EXCHANGES = ["upbit", "binance", "binance_futures"];

function validateExchange(exchange) {
  const value = String(exchange || "").toLowerCase();
  if (!EXCHANGES.includes(value)) {
    throw new Error(`exchange must be one of ${EXCHANGES.join(", ")}`);
  }
  return value;
}
function isBinanceFutures(exchange) {
  return exchange === "binance_futures";
}
function validateUpbitMarket(market) {
  const value = String(market || "").toUpperCase();
  if (!/^KRW-[A-Z0-9]{2,20}$/.test(value)) {
    throw new Error("only Upbit KRW spot markets are allowed");
  }
  return value;
}
function validateBinanceSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  if (!/^[A-Z0-9]{2,24}USDT$/.test(value)) {
    throw new Error("only Binance USDT spot symbols are allowed");
  }
  return value;
}
function validateMarket(exchange, market) {
  return exchange === "upbit" ? validateUpbitMarket(market) : validateBinanceSymbol(market);
}
function validateIdentifier(identifier) {
  const value = String(identifier || "");
  if (
    !value.startsWith(BOT_IDENTIFIER_PREFIX) || value.length > 36 || !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error("invalid bot order identifier");
  return value;
}
function validateMarkets(exchange, markets) {
  const rows = Array.isArray(markets)
    ? markets.map(String)
    : String(markets || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!rows.length || rows.length > 100) throw new Error("invalid market list");
  return rows.map((market) => validateMarket(exchange, market));
}

function normalizeStatus(exchange, rawStatus, executedQty = 0, originalQty = 0) {
  if (exchange === "upbit") {
    if (rawStatus === "done") return "FILLED";
    if (rawStatus === "cancel") return executedQty > 0 ? "PARTIALLY_FILLED_CANCELED" : "CANCELED";
    if (rawStatus === "wait" || rawStatus === "watch") {
      return executedQty > 0 ? "PARTIALLY_FILLED" : "OPEN";
    }
    return "UNKNOWN";
  }
  const status = String(rawStatus || "").toUpperCase();
  if (status === "FILLED") return "FILLED";
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
  if (["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(status)) {
    return executedQty > 0 ? "PARTIALLY_FILLED_CANCELED" : "CANCELED";
  }
  if (status === "NEW" || status === "PENDING_NEW") return "OPEN";
  if (originalQty > 0 && executedQty >= originalQty) return "FILLED";
  return "UNKNOWN";
}
function normalizeUpbitOrder(order) {
  const trades = Array.isArray(order?.trades) ? order.trades : [];
  const tradeVolume = trades.reduce((sum, row) => sum + Number(row.volume || 0), 0);
  const tradeFunds = trades.reduce(
    (sum, row) => sum + Number(row.funds || Number(row.price || 0) * Number(row.volume || 0)),
    0,
  );
  const tradeFees = trades.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  // Upbit occasionally serializes the cumulative fields as the truthy string "0" even
  // though `trades` contains fills. Do not let that placeholder suppress the fill ledger.
  const executedVolume = Math.max(Number(order?.executed_volume || 0), tradeVolume);
  const executedFunds = Math.max(Number(order?.executed_funds || 0), tradeFunds);
  const paidFee = Math.max(Number(order?.paid_fee || 0), tradeFees);
  const normalizedTrades = trades.map((trade) => ({
    trade_id: trade.uuid || null,
    price: Number(trade.price || 0),
    volume: Number(trade.volume || 0),
    funds: Number(trade.funds || Number(trade.price || 0) * Number(trade.volume || 0)),
    // Upbit trade rows omit fee; null preserves "missing" instead of fabricating zero.
    fee: trade.fee == null ? null : Number(trade.fee),
    fee_asset: "KRW",
    executed_at: trade.created_at || null,
    raw: trade,
  }));
  return {
    exchange: "upbit",
    exchange_order_id: order?.uuid || null,
    client_order_id: order?.identifier || null,
    raw_status: order?.state || null,
    status: normalizeStatus("upbit", order?.state, executedVolume, Number(order?.volume || 0)),
    executed_volume: Number.isFinite(executedVolume) ? executedVolume : 0,
    executed_funds: Number.isFinite(executedFunds) ? executedFunds : 0,
    average_price: executedVolume > 0
      ? executedFunds / executedVolume
      : Number(order?.avg_price || 0) || null,
    paid_fee: Number.isFinite(paidFee) ? paidFee : 0,
    fee_asset: "KRW",
    // v5.4: the autotrader must be able to tell that a resting order is ITS OWN and how
    // much base asset it reserves. Without these the account reconciliation reads the
    // bot's own working orders as a user locking the coin.
    side: String(order?.side || "").toLowerCase() === "ask"
      ? "SELL"
      : String(order?.side || "").toLowerCase() === "bid"
      ? "BUY"
      : null,
    market: order?.market || null,
    requested_volume: Number(order?.volume || 0),
    remaining_volume: Number(
      order?.remaining_volume ?? Math.max(0, Number(order?.volume || 0) - executedVolume),
    ),
    trades: normalizedTrades,
    raw: order,
  };
}
function binanceTradesToFills(trades) {
  return (Array.isArray(trades) ? trades : []).map((trade) => ({
    tradeId: trade?.id != null ? String(trade.id) : trade?.tradeId,
    price: trade?.price,
    qty: trade?.qty,
    commission: trade?.commission,
    commissionAsset: trade?.commissionAsset,
    time: trade?.time,
  }));
}
async function markBinanceCommissionQuote(fills, tradedSymbol) {
  const rows = Array.isArray(fills) ? fills.map((row) => ({ ...row })) : [];
  const quote = "USDT";
  const base = String(tradedSymbol || "").toUpperCase().endsWith(quote)
    ? String(tradedSymbol).toUpperCase().slice(0, -quote.length)
    : "";
  const cache = new Map();
  for (const row of rows) {
    const asset = String(row.commissionAsset || "").toUpperCase();
    const amount = Math.max(0, Number(row.commission || 0));
    if (!(amount > 0)) continue;
    if (asset === quote) {
      row.feeQuoteMarked = amount;
      row.feeQuoteMarkSource = "QUOTE_ASSET_EXACT";
      continue;
    }
    if (asset === base) {
      row.feeQuoteMarked = 0;
      row.feeQuoteMarkSource = "BASE_ASSET_QUANTITY_ACCOUNTING";
      continue;
    }
    const ts = Math.max(0, Number(row.time || 0));
    const minute = Math.floor(ts / 60_000) * 60_000;
    const pair = `${asset}USDT`;
    const key = `${pair}:${minute}`;
    let mark = cache.get(key);
    if (mark === undefined) {
      mark = 0;
      try {
        const klines = await publicBinance("/api/v3/klines", {
          symbol: pair,
          interval: "1m",
          startTime: minute,
          endTime: minute + 59_999,
          limit: 1,
        });
        const candle = Array.isArray(klines) ? klines[0] : null;
        // Use the minute VWAP proxy (quote volume / base volume) when available; it is a
        // deterministic execution-time mark, not the old arbitrary percentage estimate.
        const baseVolume = Number(candle?.[5] || 0);
        const quoteVolume = Number(candle?.[7] || 0);
        mark = baseVolume > 0 && quoteVolume > 0
          ? quoteVolume / baseVolume
          : Number(candle?.[4] || 0);
      } catch {
        mark = 0;
      }
      cache.set(key, mark);
    }
    if (mark > 0) {
      row.feeQuoteMarked = amount * mark;
      row.feeQuoteMarkPrice = mark;
      row.feeQuoteMarkSource = "EXECUTION_MINUTE_VWAP";
    } else {
      row.feeQuoteMarked = null;
      row.feeQuoteMarkSource = "MARK_UNAVAILABLE";
    }
  }
  return rows;
}
function normalizeBinanceOrder(order) {
  const fills = Array.isArray(order?.fills) ? order.fills : [];
  const executedVolume = Number(order?.executedQty || 0);
  const executedFunds = Number(
    order?.cummulativeQuoteQty || order?.cumulativeQuoteQty ||
      fills.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.qty || 0), 0),
  );
  const commissions = fills.reduce((sum, row) => sum + Number(row.commission || 0), 0);
  const feeAssetSet = [...new Set(fills.map((row) => row.commissionAsset).filter(Boolean))];
  const trades = fills.map((fill, index) => ({
    trade_id: fill.tradeId != null ? String(fill.tradeId) : `${order?.orderId || "order"}-${index}`,
    price: Number(fill.price || 0),
    volume: Number(fill.qty || 0),
    funds: Number(fill.price || 0) * Number(fill.qty || 0),
    fee: Number(fill.commission || 0),
    fee_asset: fill.commissionAsset || null,
    fee_quote_marked: Number(fill.feeQuoteMarked || 0),
    fee_quote_mark_source: fill.feeQuoteMarkSource || null,
    executed_at: fill?.time
      ? new Date(Number(fill.time)).toISOString()
      : order?.transactTime
      ? new Date(Number(order.transactTime)).toISOString()
      : null,
    raw: fill,
  }));
  return {
    exchange: "binance",
    exchange_order_id: order?.orderId != null ? String(order.orderId) : null,
    client_order_id: order?.clientOrderId || order?.origClientOrderId || null,
    raw_status: order?.status || null,
    status: normalizeStatus("binance", order?.status, executedVolume, Number(order?.origQty || 0)),
    executed_volume: Number.isFinite(executedVolume) ? executedVolume : 0,
    executed_funds: Number.isFinite(executedFunds) ? executedFunds : 0,
    average_price: executedVolume > 0 ? executedFunds / executedVolume : null,
    paid_fee: Number.isFinite(commissions) ? commissions : 0,
    fee_asset: feeAssetSet.length === 1 ? feeAssetSet[0] : feeAssetSet.length ? "MIXED" : null,
    // v5.4: see the Upbit normalizer above.
    side: order?.side ? String(order.side).toUpperCase() : null,
    market: order?.symbol || null,
    requested_volume: Number(order?.origQty || 0),
    remaining_volume: Math.max(0, Number(order?.origQty || 0) - executedVolume),
    trades,
    raw: order,
  };
}

async function upbitGetOrder(identifier) {
  const order = (await upbitRequest("GET", "/v1/order", { query: { identifier } })).data;
  return normalizeUpbitOrder(order);
}
async function upbitCreateOrder(payload, waitForFinalMs = 2500) {
  const market = validateUpbitMarket(payload.market);
  const identifier = validateIdentifier(payload.identifier);
  const side = payload.side === "SELL" || payload.side === "ask"
    ? "ask"
    : payload.side === "BUY" || payload.side === "bid"
    ? "bid"
    : null;
  if (!side) throw new Error("invalid Upbit order side");
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  const body = { market, side, identifier };
  if (type === "LIMIT") {
    const price = Number(payload.price);
    const volume = Number(payload.quantity ?? payload.volume);
    if (!(price > 0 && volume > 0)) {
      throw new Error("Upbit limit order requires positive price and quantity");
    }
    if (side === "bid") enforceBuyCaps("upbit", price * volume);
    body.ord_type = "limit";
    body.price = decimal(price, 12);
    body.volume = decimal(volume, 16);
    if (payload.time_in_force) body.time_in_force = String(payload.time_in_force).toLowerCase();
  } else if (type === "MARKET") {
    if (side !== "ask") throw new Error("Upbit market orders are restricted to sells");
    const volume = Number(payload.quantity ?? payload.volume);
    if (!(volume > 0)) throw new Error("Upbit market sell requires positive quantity");
    body.ord_type = "market";
    body.volume = decimal(volume, 16);
  } else if (type === "LIMIT_MAKER") {
    // Upbit has no post-only flag. A bid priced at or below the best bid cannot cross, so
    // it rests as a maker by construction; the autotrader is responsible for pricing it
    // there. Mapped to a plain limit with NO time_in_force — setting one would make it
    // IOC or FOK, which is exactly the taker behavior being avoided.
    const price = Number(payload.price);
    const volume = Number(payload.quantity ?? payload.volume);
    if (!(price > 0 && volume > 0)) {
      throw new Error("Upbit maker order requires positive price and quantity");
    }
    if (side === "bid") enforceBuyCaps("upbit", price * volume);
    body.ord_type = "limit";
    body.price = decimal(price, 12);
    body.volume = decimal(volume, 16);
  } else throw new Error("Upbit order type must be LIMIT, LIMIT_MAKER or MARKET");

  let normalized;
  try {
    const raw = (await upbitRequest("POST", "/v1/orders", { body, timeoutMs: 12_000 })).data;
    normalized = normalizeUpbitOrder(raw);
  } catch (error) {
    if (["AbortError", "TypeError"].includes(error?.name) || Number(error?.status) >= 500) {
      try {
        normalized = await upbitGetOrder(identifier);
      } catch {
        throw error;
      }
    } else throw error;
  }
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(waitForFinalMs) || 0));
  while (Date.now() < deadline && ["OPEN", "PARTIALLY_FILLED"].includes(normalized.status)) {
    await sleep(300);
    normalized = await upbitGetOrder(identifier);
  }
  if (side === "bid" && type === "LIMIT" && normalized.executed_funds > 0) {
    recordBuy("upbit", normalized.executed_funds);
  }
  return { order: normalized, fill: fillSummary(normalized) };
}
async function upbitOrderTest(payload) {
  const market = validateUpbitMarket(payload.market);
  const identifier = validateIdentifier(payload.identifier);
  const side = payload.side === "SELL" || payload.side === "ask"
    ? "ask"
    : payload.side === "BUY" || payload.side === "bid"
    ? "bid"
    : null;
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  if (!side || !["LIMIT", "MARKET", "LIMIT_MAKER"].includes(type)) {
    throw new Error("invalid Upbit test order");
  }
  const body = { market, side, identifier };
  if (type === "LIMIT") {
    const price = Number(payload.price);
    const quantity = Number(payload.quantity ?? payload.volume);
    if (!(price > 0 && quantity > 0)) {
      throw new Error("Upbit limit test requires price and quantity");
    }
    Object.assign(body, {
      ord_type: "limit",
      price: decimal(price, 12),
      volume: decimal(quantity, 16),
    });
    if (payload.time_in_force) body.time_in_force = String(payload.time_in_force).toLowerCase();
  } else {
    if (side !== "ask") throw new Error("Upbit market test is restricted to sell");
    const quantity = Number(payload.quantity ?? payload.volume);
    if (!(quantity > 0)) throw new Error("Upbit market test requires quantity");
    Object.assign(body, { ord_type: "market", volume: decimal(quantity, 16) });
  }
  return (await upbitRequest("POST", "/v1/orders/test", { body })).data;
}

async function binanceExchangeInfo(symbol) {
  const market = validateBinanceSymbol(symbol);
  const data = await publicBinance("/api/v3/exchangeInfo", { symbol: market });
  const row = Array.isArray(data?.symbols) ? data.symbols[0] : null;
  if (!row || row.status !== "TRADING" || row.isSpotTradingAllowed === false) {
    throw new Error(`Binance ${market} is not available for spot trading`);
  }
  const filters = Object.fromEntries(
    (row.filters || []).map((filter) => [filter.filterType, filter]),
  );
  return {
    symbol: market,
    base_asset: row.baseAsset,
    quote_asset: row.quoteAsset,
    price_tick: Number(filters.PRICE_FILTER?.tickSize || 0),
    quantity_step: Number(filters.LOT_SIZE?.stepSize || 0),
    min_quantity: Number(filters.LOT_SIZE?.minQty || 0),
    max_quantity: Number(filters.LOT_SIZE?.maxQty || 0),
    min_notional: Number(filters.NOTIONAL?.minNotional || filters.MIN_NOTIONAL?.minNotional || 0),
    max_notional: Number(filters.NOTIONAL?.maxNotional || 0),
    raw: row,
  };
}
function conformBinanceOrder(payload, info) {
  const side = String(payload.side || "").toUpperCase();
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  if (!["BUY", "SELL"].includes(side)) throw new Error("invalid Binance order side");
  // v5.5: LIMIT_MAKER is post-only — Binance REJECTS it outright if it would cross and
  // take. That rejection is the point: accidental taker execution becomes impossible
  // rather than merely unlikely, so the maker cost model can be trusted.
  if (!["LIMIT", "MARKET", "LIMIT_MAKER"].includes(type)) {
    throw new Error("Binance order type must be LIMIT, LIMIT_MAKER or MARKET");
  }
  const clientOrderId = validateIdentifier(payload.identifier || payload.newClientOrderId);
  let quantity = floorStep(Number(payload.quantity ?? payload.volume), info.quantity_step);
  if (!(quantity > 0) || quantity < info.min_quantity) {
    throw new Error("Binance quantity is below LOT_SIZE minimum");
  }
  if (info.max_quantity > 0 && quantity > info.max_quantity) {
    quantity = floorStep(info.max_quantity, info.quantity_step);
  }
  const order = {
    symbol: info.symbol,
    side,
    type,
    // Keep the exact LOT_SIZE decimal precision. Converting the floored number back
    // through a generic 16-decimal formatter can expose binary floating-point tails
    // (for example 2.06 -> 2.0600000000000001), which Binance rejects as -1111.
    quantity: formatStep(quantity, info.quantity_step),
    newClientOrderId: clientOrderId,
    newOrderRespType: "FULL",
  };
  if (type === "LIMIT") {
    const price = floorStep(Number(payload.price), info.price_tick);
    if (!(price > 0)) throw new Error("Binance limit order requires a valid tick-aligned price");
    const notional = price * quantity;
    if (info.min_notional > 0 && notional < info.min_notional) {
      throw new Error(`Binance order notional ${notional} below ${info.min_notional}`);
    }
    if (info.max_notional > 0 && notional > info.max_notional) {
      throw new Error(`Binance order notional ${notional} above ${info.max_notional}`);
    }
    if (side === "BUY") enforceBuyCaps("binance", notional);
    order.price = formatStep(price, info.price_tick);
    order.timeInForce = String(payload.time_in_force || payload.timeInForce || "IOC").toUpperCase();
  } else if (type === "LIMIT_MAKER") {
    const price = floorStep(Number(payload.price), info.price_tick);
    if (!(price > 0)) throw new Error("Binance maker order requires a valid tick-aligned price");
    const notional = price * quantity;
    if (info.min_notional > 0 && notional < info.min_notional) {
      throw new Error(`Binance order notional ${notional} below ${info.min_notional}`);
    }
    if (info.max_notional > 0 && notional > info.max_notional) {
      throw new Error(`Binance order notional ${notional} above ${info.max_notional}`);
    }
    if (side === "BUY") enforceBuyCaps("binance", notional);
    order.price = formatStep(price, info.price_tick);
    // LIMIT_MAKER accepts no timeInForce.
  } else if (side === "BUY") {
    throw new Error("Binance market orders are restricted to sells");
  }
  return {
    order,
    info,
    notional: ["LIMIT", "LIMIT_MAKER"].includes(type)
      ? Number(order.price) * Number(order.quantity)
      : 0,
  };
}
async function binanceGetOrder(identifier, symbol) {
  const market = validateBinanceSymbol(symbol);
  const data = (await binanceRequest("GET", "/api/v3/order", {
    symbol: market,
    origClientOrderId: validateIdentifier(identifier),
  })).data;
  const executedQty = Number(data?.executedQty || 0);
  if (executedQty > 0 && data?.orderId != null) {
    try {
      const trades = (await binanceRequest("GET", "/api/v3/myTrades", {
        symbol: market,
        orderId: data.orderId,
        limit: 1000,
      })).data;
      data.fills = await markBinanceCommissionQuote(binanceTradesToFills(trades), market);
    } catch (error) {
      // Order status must remain recoverable even if the commission-detail lookup is
      // temporarily unavailable. The autotrader then records a conservative fee estimate
      // instead of zero and the next reconciliation can replace it with exact fills.
      data.fills = [];
      data.fee_lookup_error = error?.message || String(error);
    }
  }
  return normalizeBinanceOrder(data);
}
async function binanceCreateOrder(payload, waitForFinalMs = 2500) {
  const info = await binanceExchangeInfo(payload.market);
  const conformed = conformBinanceOrder(payload, info);
  let normalized;
  try {
    const raw =
      (await binanceRequest("POST", "/api/v3/order", conformed.order, { timeoutMs: 12_000 })).data;
    if (Array.isArray(raw?.fills) && raw.fills.length) {
      raw.fills = await markBinanceCommissionQuote(raw.fills, info.symbol);
    }
    normalized = normalizeBinanceOrder(raw);
  } catch (error) {
    // Binance documents 5xx/-1007 as UNKNOWN execution status. Reconcile by
    // deterministic clientOrderId; never submit the same economic order twice.
    if (
      ["AbortError", "TypeError"].includes(error?.name) || Number(error?.status) >= 500 ||
      Number(error?.code) === -1007
    ) {
      try {
        normalized = await binanceGetOrder(conformed.order.newClientOrderId, info.symbol);
      } catch {
        throw error;
      }
    } else throw error;
  }
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(waitForFinalMs) || 0));
  while (Date.now() < deadline && ["OPEN", "PARTIALLY_FILLED"].includes(normalized.status)) {
    await sleep(250);
    normalized = await binanceGetOrder(conformed.order.newClientOrderId, info.symbol);
  }
  if (conformed.order.side === "BUY" && normalized.executed_funds > 0) {
    recordBuy("binance", normalized.executed_funds);
  }
  return { order: normalized, fill: fillSummary(normalized), symbol_info: info };
}
async function binanceOrderTest(payload) {
  const info = await binanceExchangeInfo(payload.market);
  const conformed = conformBinanceOrder(payload, info);
  return (await binanceRequest("POST", "/api/v3/order/test", conformed.order)).data;
}

// ---------------------------------------------------------------------------
// Binance USDⓈ-M futures.
//
// Direction and effect are separate. This prevents an exit from flipping a position and
// prevents an entry from being accidentally marked reduce-only. Nothing here touches
// wallet transfers. Leverage is the only account-level setting the gateway writes, and
// only for the symbol it is about to trade.
// ---------------------------------------------------------------------------

const FUTURES_MIN_LEVERAGE = 1;
const FUTURES_MAX_LEVERAGE = 20;
// Mirrors FUTURES_MIN_ENTRY_MARGIN_USDT in the engine. This gateway-side copy is an
// independent last line of defence if a malformed command bypasses engine sizing.
const FUTURES_MIN_ENTRY_MARGIN_USDT = 50;
// Mirrors DEFAULT_FUTURES_LEVERAGE in the engine's futures-exit-policy. The gateway keeps
// its own copy so an order that arrives without one still opens at the authorised size.
const DEFAULT_FUTURES_LEVERAGE = integerEnv(
  "BINANCE_FUTURES_DEFAULT_LEVERAGE",
  3,
  FUTURES_MIN_LEVERAGE,
  FUTURES_MAX_LEVERAGE,
);

function validateFuturesLeverage(value) {
  const leverage = Math.round(Number(value));
  if (!Number.isFinite(leverage) || leverage < FUTURES_MIN_LEVERAGE) {
    throw new Error("futures leverage must be a positive integer");
  }
  if (leverage > FUTURES_MAX_LEVERAGE) {
    throw new Error(`futures leverage above the gateway ceiling of ${FUTURES_MAX_LEVERAGE}x`);
  }
  return leverage;
}

async function binanceFuturesExchangeInfo(symbol) {
  const market = validateBinanceSymbol(symbol);
  const data = await publicBinanceFutures("/fapi/v1/exchangeInfo");
  const row = (Array.isArray(data?.symbols) ? data.symbols : []).find((item) =>
    String(item?.symbol).toUpperCase() === market
  );
  if (!row || row.status !== "TRADING" || String(row.contractType || "PERPETUAL") !== "PERPETUAL") {
    throw new Error(`Binance futures ${market} is not an active perpetual contract`);
  }
  const filters = Object.fromEntries(
    (row.filters || []).map((filter) => [filter.filterType, filter]),
  );
  return {
    symbol: market,
    base_asset: row.baseAsset,
    quote_asset: row.quoteAsset,
    price_tick: Number(filters.PRICE_FILTER?.tickSize || 0),
    quantity_step: Number(filters.LOT_SIZE?.stepSize || 0),
    min_quantity: Number(filters.LOT_SIZE?.minQty || 0),
    // A MARKET exit is bounded by MARKET_LOT_SIZE, which is usually tighter than LOT_SIZE.
    max_quantity: Number(filters.LOT_SIZE?.maxQty || 0),
    market_max_quantity: Number(filters.MARKET_LOT_SIZE?.maxQty || 0),
    min_notional: Number(filters.MIN_NOTIONAL?.notional || 5),
    max_notional: 0,
    max_leverage: FUTURES_MAX_LEVERAGE,
    raw: row,
  };
}

/**
 * Hedge mode and one-way mode take mutually exclusive order parameters: one-way wants
 * `reduceOnly`, hedge mode rejects it and wants `positionSide`. Read the account setting
 * once rather than guessing, because guessing wrong fails the exit, not the entry.
 */
async function futuresPositionSideDual() {
  if (futuresDualPositionSide !== null) return futuresDualPositionSide;
  const data = (await futuresRequest("GET", "/fapi/v1/positionSide/dual")).data;
  futuresDualPositionSide = Boolean(data?.dualSidePosition);
  return futuresDualPositionSide;
}

async function ensureFuturesLeverage(symbol, leverage) {
  const market = validateBinanceSymbol(symbol);
  const target = validateFuturesLeverage(leverage);
  if (futuresLeverageApplied.get(market) === target) {
    return { symbol: market, leverage: target, changed: false };
  }
  const data = (await futuresRequest("POST", "/fapi/v1/leverage", {
    symbol: market,
    leverage: target,
  })).data;
  const applied = Number(data?.leverage) || target;
  futuresLeverageApplied.set(market, applied);
  return {
    symbol: market,
    leverage: applied,
    max_notional_quote: Number(data?.maxNotionalValue) || null,
    changed: true,
  };
}

function resolveFuturesIntent(payload) {
  const side = String(payload?.side || "").toUpperCase();
  // Backward-compatible legacy defaults preserve the old long-only command contract.
  const positionSide = String(payload?.position_side || payload?.positionSide || "LONG")
    .toUpperCase();
  const effect = String(
    payload?.position_effect || payload?.positionEffect || (side === "BUY" ? "OPEN" : "CLOSE"),
  ).toUpperCase();
  if (!["LONG", "SHORT"].includes(positionSide)) {
    throw new Error("Binance futures position_side must be LONG or SHORT");
  }
  if (!["OPEN", "CLOSE"].includes(effect)) {
    throw new Error("Binance futures position_effect must be OPEN or CLOSE");
  }
  const expectedSide = positionSide === "LONG"
    ? effect === "OPEN" ? "BUY" : "SELL"
    : effect === "OPEN"
    ? "SELL"
    : "BUY";
  if (side !== expectedSide) {
    throw new Error(
      `invalid futures intent: ${
        side || "MISSING"
      }/${positionSide}/${effect} requires ${expectedSide}`,
    );
  }
  return { side, positionSide, effect };
}

function conformFuturesOrder(
  payload,
  info,
  dualPositionSide,
  leverage = DEFAULT_FUTURES_LEVERAGE,
) {
  const side = String(payload.side || "").toUpperCase();
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  if (!["BUY", "SELL"].includes(side)) throw new Error("invalid Binance futures order side");
  if (!["LIMIT", "MARKET", "LIMIT_MAKER"].includes(type)) {
    throw new Error("Binance futures order type must be LIMIT, LIMIT_MAKER or MARKET");
  }
  const intent = resolveFuturesIntent(payload);
  const clientOrderId = validateIdentifier(payload.identifier || payload.newClientOrderId);
  const stepCeiling = type === "MARKET" && info.market_max_quantity > 0
    ? info.market_max_quantity
    : info.max_quantity;
  let quantity = floorStep(Number(payload.quantity ?? payload.volume), info.quantity_step);
  if (!(quantity > 0) || quantity < info.min_quantity) {
    throw new Error("Binance futures quantity is below LOT_SIZE minimum");
  }
  if (stepCeiling > 0 && quantity > stepCeiling) {
    quantity = floorStep(stepCeiling, info.quantity_step);
  }
  const order = {
    symbol: info.symbol,
    side,
    type: type === "LIMIT_MAKER" ? "LIMIT" : type,
    quantity: formatStep(quantity, info.quantity_step),
    newClientOrderId: clientOrderId,
    newOrderRespType: "RESULT",
  };
  // Hedge mode identifies the book explicitly and rejects reduceOnly. One-way mode uses
  // reduceOnly on every CLOSE so an oversized or replayed exit can never flip direction.
  if (dualPositionSide) order.positionSide = intent.positionSide;
  else if (intent.effect === "CLOSE") order.reduceOnly = "true";
  if (type === "LIMIT" || type === "LIMIT_MAKER") {
    const price = floorStep(Number(payload.price), info.price_tick);
    if (!(price > 0)) {
      throw new Error("Binance futures limit order requires a valid tick-aligned price");
    }
    const notional = price * quantity;
    if (info.min_notional > 0 && notional < info.min_notional) {
      throw new Error(`Binance futures order notional ${notional} below ${info.min_notional}`);
    }
    if (intent.effect === "OPEN") {
      const entryLeverage = validateFuturesLeverage(leverage);
      const minimumEntryNotional = FUTURES_MIN_ENTRY_MARGIN_USDT * entryLeverage;
      if (notional + 1e-9 < minimumEntryNotional) {
        throw new Error(
          `Binance futures entry requires at least ${FUTURES_MIN_ENTRY_MARGIN_USDT} USDT margin (${minimumEntryNotional} USDT notional at ${entryLeverage}x); got ${notional}`,
        );
      }
      enforceBuyCaps("binance_futures", notional);
    }
    order.price = formatStep(price, info.price_tick);
    // GTX is post-only: the exchange rejects the order outright rather than crossing, so
    // the maker cost model holds on futures exactly as LIMIT_MAKER makes it hold on spot.
    order.timeInForce = type === "LIMIT_MAKER"
      ? "GTX"
      : String(payload.time_in_force || payload.timeInForce || "IOC").toUpperCase();
  } else if (intent.effect === "OPEN") {
    throw new Error("Binance futures market orders are restricted to position closes");
  }
  return {
    order,
    info,
    intent,
    notional: order.price ? Number(order.price) * Number(order.quantity) : 0,
  };
}

function normalizeFuturesOrder(order) {
  const fills = Array.isArray(order?.fills) ? order.fills : [];
  const executedVolume = Number(order?.executedQty || 0);
  // USDⓈ-M reports cumulative quote as `cumQuote`. When an UNKNOWN-status recovery read
  // omits it, avgPrice x executedQty is exact, and the fill list is the last resort.
  const executedFunds = Number(order?.cumQuote) > 0
    ? Number(order.cumQuote)
    : Number(order?.avgPrice || 0) > 0
    ? Number(order.avgPrice) * executedVolume
    : fills.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.qty || 0), 0);
  const commissions = fills.reduce((sum, row) => sum + Number(row.commission || 0), 0);
  const feeAssetSet = [...new Set(fills.map((row) => row.commissionAsset).filter(Boolean))];
  const trades = fills.map((fill, index) => ({
    trade_id: fill.tradeId != null ? String(fill.tradeId) : `${order?.orderId || "order"}-${index}`,
    price: Number(fill.price || 0),
    volume: Number(fill.qty || 0),
    funds: Number(fill.price || 0) * Number(fill.qty || 0),
    fee: Number(fill.commission || 0),
    fee_asset: fill.commissionAsset || null,
    fee_quote_marked: Number(fill.feeQuoteMarked || 0),
    fee_quote_mark_source: fill.feeQuoteMarkSource || null,
    realized_pnl_quote: Number(fill.realizedPnl || 0),
    executed_at: fill?.time
      ? new Date(Number(fill.time)).toISOString()
      : order?.updateTime
      ? new Date(Number(order.updateTime)).toISOString()
      : null,
    raw: fill,
  }));
  const averagePrice = Number(order?.avgPrice || 0) > 0
    ? Number(order.avgPrice)
    : executedVolume > 0
    ? executedFunds / executedVolume
    : null;
  return {
    exchange: "binance_futures",
    exchange_order_id: order?.orderId != null ? String(order.orderId) : null,
    client_order_id: order?.clientOrderId || order?.origClientOrderId || null,
    raw_status: order?.status || null,
    status: normalizeStatus(
      "binance_futures",
      order?.status,
      executedVolume,
      Number(order?.origQty || 0),
    ),
    executed_volume: Number.isFinite(executedVolume) ? executedVolume : 0,
    executed_funds: Number.isFinite(executedFunds) ? executedFunds : 0,
    average_price: averagePrice,
    paid_fee: Number.isFinite(commissions) ? commissions : 0,
    fee_asset: feeAssetSet.length === 1 ? feeAssetSet[0] : feeAssetSet.length ? "MIXED" : null,
    side: order?.side ? String(order.side).toUpperCase() : null,
    market: order?.symbol || null,
    requested_volume: Number(order?.origQty || 0),
    remaining_volume: Math.max(0, Number(order?.origQty || 0) - executedVolume),
    reduce_only: Boolean(order?.reduceOnly),
    position_side: order?.positionSide || null,
    realized_pnl_quote: trades.reduce((sum, row) => sum + Number(row.realized_pnl_quote || 0), 0),
    trades,
    raw: order,
  };
}

async function attachFuturesFills(data, market) {
  const executedQty = Number(data?.executedQty || 0);
  if (!(executedQty > 0) || data?.orderId == null) return data;
  try {
    const trades = (await futuresRequest("GET", "/fapi/v1/userTrades", {
      symbol: market,
      orderId: data.orderId,
      limit: 1000,
    })).data;
    const rows = (Array.isArray(trades) ? trades : []).map((trade) => ({
      tradeId: trade?.id != null ? String(trade.id) : trade?.tradeId,
      price: trade?.price,
      qty: trade?.qty,
      commission: trade?.commission,
      commissionAsset: trade?.commissionAsset,
      realizedPnl: trade?.realizedPnl,
      time: trade?.time,
    }));
    data.fills = await markBinanceCommissionQuote(rows, market);
  } catch (error) {
    // Same rule as spot: order status must stay readable even when the commission detail
    // lookup is unavailable. A later reconciliation replaces the estimate with exact fills.
    data.fills = [];
    data.fee_lookup_error = error?.message || String(error);
  }
  return data;
}

async function binanceFuturesGetOrder(identifier, symbol) {
  const market = validateBinanceSymbol(symbol);
  const data = (await futuresRequest("GET", "/fapi/v1/order", {
    symbol: market,
    origClientOrderId: validateIdentifier(identifier),
  })).data;
  return normalizeFuturesOrder(await attachFuturesFills(data, market));
}

async function binanceFuturesCreateOrder(payload, waitForFinalMs = 2500, leverage = null) {
  const info = await binanceFuturesExchangeInfo(payload.market);
  const dual = await futuresPositionSideDual();
  const intent = resolveFuturesIntent(payload);
  const openingLeverage = intent.effect === "OPEN"
    ? validateFuturesLeverage(leverage ?? payload.leverage ?? DEFAULT_FUTURES_LEVERAGE)
    : null;
  const conformed = conformFuturesOrder(
    payload,
    info,
    dual,
    openingLeverage ?? DEFAULT_FUTURES_LEVERAGE,
  );
  // Leverage is a property of the symbol, not of the order, so it must be in place before
  // the position exists. Only an opening order needs it; a reduce-only exit inherits it.
  if (conformed.intent.effect === "OPEN") {
    await ensureFuturesLeverage(info.symbol, openingLeverage);
  }
  let normalized;
  try {
    const raw = (await futuresRequest("POST", "/fapi/v1/order", conformed.order, {
      timeoutMs: 12_000,
    })).data;
    normalized = normalizeFuturesOrder(await attachFuturesFills(raw, info.symbol));
  } catch (error) {
    if (
      ["AbortError", "TypeError"].includes(error?.name) || Number(error?.status) >= 500 ||
      Number(error?.code) === -1007
    ) {
      try {
        normalized = await binanceFuturesGetOrder(conformed.order.newClientOrderId, info.symbol);
      } catch {
        throw error;
      }
    } else throw error;
  }
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(waitForFinalMs) || 0));
  while (Date.now() < deadline && ["OPEN", "PARTIALLY_FILLED"].includes(normalized.status)) {
    await sleep(250);
    normalized = await binanceFuturesGetOrder(conformed.order.newClientOrderId, info.symbol);
  }
  normalized.position_side = conformed.intent.positionSide;
  normalized.position_effect = conformed.intent.effect;
  if (conformed.intent.effect === "OPEN" && normalized.executed_funds > 0) {
    recordBuy("binance_futures", normalized.executed_funds);
  }
  return {
    order: normalized,
    fill: fillSummary(normalized),
    symbol_info: info,
    leverage: futuresLeverageApplied.get(info.symbol) || null,
  };
}

/**
 * The futures wallet presented in the same shape as a spot portfolio.
 *
 * `accounts` carries the USDT margin row plus one compatibility row per open LONG.
 * Direction-aware callers use `positions`, which includes both LONG and SHORT. What the
 * base rows are NOT is spendable inventory, so
 * `total_equity_quote` is the exchange's own margin balance rather than a sum of those
 * rows valued at mark — most of a leveraged notional is borrowed.
 */
function buildFuturesPortfolio(account, prices) {
  const assets = Array.isArray(account?.assets) ? account.assets : [];
  const positions = (Array.isArray(account?.positions) ? account.positions : [])
    .filter((row) => Math.abs(Number(row?.positionAmt || 0)) > 0);
  const usdt = assets.find((row) => String(row?.asset).toUpperCase() === "USDT") || {};
  const walletBalance = Number(usdt.walletBalance || 0);
  const availableBalance = Number(
    account?.availableBalance ?? usdt.availableBalance ?? walletBalance,
  );
  const accounts = [{
    currency: "USDT",
    balance: Math.max(0, availableBalance),
    locked: Math.max(0, walletBalance - availableBalance),
    avg_buy_price: null,
  }];
  const openPositions = [];
  for (const row of positions) {
    const symbol = String(row?.symbol || "").toUpperCase();
    if (!symbol.endsWith("USDT")) continue;
    const amount = Number(row?.positionAmt || 0);
    const currency = symbol.slice(0, -4);
    openPositions.push({
      market: symbol,
      base_asset: currency,
      side: amount > 0 ? "LONG" : "SHORT",
      quantity: Math.abs(amount),
      entry_price: Number(row?.entryPrice || 0),
      leverage: Number(row?.leverage || 0) || null,
      margin_type: row?.isolated === true ? "ISOLATED" : "CROSSED",
      unrealized_pnl_quote: Number(row?.unrealizedProfit || 0),
      initial_margin_quote: Number(row?.initialMargin || 0),
      liquidation_price: Number(row?.liquidationPrice || 0) || null,
    });
    // Compatibility rows remain long-only so the legacy spot-shaped exit path cannot try
    // to sell a short. The P10 path reads the direction-aware `positions` collection.
    if (amount > 0) {
      accounts.push({ currency, balance: amount, locked: 0, avg_buy_price: null });
    }
  }
  return {
    exchange: "binance_futures",
    quote_currency: "USDT",
    accounts,
    prices,
    positions: openPositions,
    total_equity_quote: Number(
      account?.totalMarginBalance ?? account?.totalWalletBalance ?? walletBalance,
    ),
    available_quote: Math.max(0, availableBalance),
    locked_quote: Math.max(0, walletBalance - availableBalance),
    // The margin wallet floats with the mark price of every open position, so this is the
    // only figure that moves solely on realised events (fills, funding, transfers).
    settled_quote: walletBalance,
    unrealized_pnl_quote: Number(account?.totalUnrealizedProfit || 0),
    total_initial_margin_quote: Number(account?.totalInitialMargin || 0),
    max_withdraw_quote: Number(account?.maxWithdrawAmount || 0),
  };
}

async function binanceFuturesPortfolio() {
  const [account, tickers] = await Promise.all([
    futuresRequest("GET", "/fapi/v2/account").then((row) => row.data),
    publicBinanceFutures("/fapi/v1/ticker/price"),
  ]);
  const prices = Object.fromEntries(
    (Array.isArray(tickers) ? tickers : []).map((row) => [row.symbol, Number(row.price)]),
  );
  return buildFuturesPortfolio(account, prices);
}

async function binanceFuturesFees(market = null) {
  const symbol = market ? validateBinanceSymbol(market) : "BTCUSDT";
  const data = (await futuresRequest("GET", "/fapi/v1/commissionRate", { symbol })).data;
  const maker = Number(data?.makerCommissionRate);
  const taker = Number(data?.takerCommissionRate);
  return {
    exchange: "binance_futures",
    market: symbol,
    maker_pct: Number.isFinite(maker) ? maker * 100 : null,
    taker_pct: Number.isFinite(taker) ? taker * 100 : null,
    source: "futures_commission_rate",
  };
}
function fillSummary(order) {
  return {
    executedVolume: Number(order?.executed_volume || 0),
    executedFunds: Number(order?.executed_funds || 0),
    averagePrice: Number(order?.average_price || 0) || null,
    paidFee: Number(order?.paid_fee || 0),
    feeAsset: order?.fee_asset || null,
  };
}

function buildUpbitPortfolio(accounts, tickers) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const tickerRows = Array.isArray(tickers) ? tickers : [];
  const prices = Object.fromEntries(
    tickerRows
      .filter((row) => String(row?.market || "").startsWith("KRW-") && Number(row?.trade_price) > 0)
      .map((row) => [String(row.market), Number(row.trade_price)]),
  );
  let total = 0;
  let available = 0;
  let locked = 0;
  const unpricedAssets = [];
  for (const row of rows) {
    const currency = String(row?.currency || "").toUpperCase();
    const free = Math.max(0, Number(row?.balance || 0));
    const held = Math.max(0, Number(row?.locked || 0));
    const quantity = free + held;
    if (currency === "KRW") {
      available = free;
      locked = held;
      total += quantity;
      continue;
    }
    if (!(quantity > 0)) continue;
    const market = `KRW-${currency}`;
    const price = Number(prices[market] || 0);
    if (price > 0) total += quantity * price;
    else {unpricedAssets.push({
        currency,
        balance: free,
        locked: held,
        reason: "NO_ACTIVE_KRW_TICKER",
      });}
  }
  return {
    exchange: "upbit",
    quote_currency: "KRW",
    accounts: rows,
    prices,
    total_equity_quote: total,
    available_quote: available,
    locked_quote: locked,
    unpriced_assets: unpricedAssets,
  };
}
async function upbitPortfolio() {
  const accounts = (await upbitRequest("GET", "/v1/accounts")).data;
  // Query all active KRW tickers once. Constructing KRW-{asset} for every account
  // balance can include delisted/dust assets and makes /v1/ticker fail the whole
  // portfolio with 404 Code not found. Unpriced assets are surfaced separately and
  // never counted as deployable capital.
  const tickers = await publicUpbit("/v1/ticker/all", { quote_currencies: "KRW" });
  return buildUpbitPortfolio(accounts, tickers);
}
async function binancePortfolio() {
  const account =
    (await binanceRequest("GET", "/api/v3/account", { omitZeroBalances: "true" })).data;
  const balances = Array.isArray(account?.balances) ? account.balances : [];
  const tickers = await publicBinance("/api/v3/ticker/price");
  const prices = Object.fromEntries(
    (Array.isArray(tickers) ? tickers : []).map((r) => [r.symbol, Number(r.price)]),
  );
  let total = 0;
  let available = 0;
  let locked = 0;
  const accounts = balances.map((row) => ({
    currency: row.asset,
    balance: Number(row.free || 0),
    locked: Number(row.locked || 0),
    avg_buy_price: null,
  }));
  for (const row of accounts) {
    if (row.currency === "USDT") {
      available = row.balance;
      locked = row.locked;
      total += row.balance + row.locked;
    } else total += (row.balance + row.locked) * Number(prices[`${row.currency}USDT`] || 0);
  }
  return {
    exchange: "binance",
    quote_currency: "USDT",
    accounts,
    prices,
    total_equity_quote: total,
    available_quote: available,
    locked_quote: locked,
    commission_rates: account?.commissionRates || null,
  };
}
/**
 * v5.8: executed trade flow.
 *
 * With mechanical time exits removed, market data is the ONLY thing that closes a losing
 * position before its stop. Until now the monitor received the orderbook and nothing else,
 * so it could see resting intent but never actual aggression — the single most direct
 * evidence that a thesis has died. Both endpoints are public and cost one extra call.
 *
 * Returns a signed pressure in [-1, 1]: +1 is pure buyer aggression, -1 pure seller.
 * Weighted by recency so a burst thirty seconds ago does not outvote what is happening now.
 */
const TRADE_FLOW_HALF_LIFE_MS = 20_000;

function summarizeTradeFlow(trades, nowMs) {
  let buy = 0;
  let sell = 0;
  let latest = 0;
  for (const t of trades) {
    const notional = t.price * t.qty;
    if (!(notional > 0)) continue;
    const age = Math.max(0, nowMs - t.ts);
    const weight = Math.pow(0.5, age / TRADE_FLOW_HALF_LIFE_MS);
    if (t.buyerTaker) buy += notional * weight;
    else sell += notional * weight;
    if (t.ts > latest) latest = t.ts;
  }
  const total = buy + sell;
  return {
    pressure: total > 0 ? (buy - sell) / total : 0,
    buy_notional: buy,
    sell_notional: sell,
    trade_count: trades.length,
    last_trade_at: latest || null,
    half_life_ms: TRADE_FLOW_HALF_LIFE_MS,
  };
}

const EMPTY_FLOW = {
  pressure: 0,
  buy_notional: 0,
  sell_notional: 0,
  trade_count: 0,
  last_trade_at: null,
  half_life_ms: TRADE_FLOW_HALF_LIFE_MS,
};

async function quote(exchange, market) {
  const symbol = validateMarket(exchange, market);
  // v6.5: the moment this gateway asked the exchange, and the moment it got an answer.
  // Without these the autotrader cannot tell a slow venue from a slow scheduler, and the
  // whole tick-to-order measurement has no anchor on Binance, which publishes no
  // orderbook timestamp of its own.
  const requestedAtMs = Date.now();
  if (exchange === "upbit") {
    const [tickers, books, ticks] = await Promise.all([
      publicUpbit("/v1/ticker", { markets: symbol }),
      publicUpbit("/v1/orderbook", { markets: symbol }),
      // Trade flow must never be able to break a quote the exit path depends on.
      publicUpbit("/v1/trades/ticks", { market: symbol, count: 100 }).catch(() => null),
    ]);
    const ticker = Array.isArray(tickers) ? tickers[0] : null;
    const book = Array.isArray(books) ? books[0] : null;
    const units = Array.isArray(book?.orderbook_units) ? book.orderbook_units : [];
    return {
      exchange,
      market: symbol,
      current: Number(ticker?.trade_price || 0),
      best_ask: Number(units[0]?.ask_price || ticker?.trade_price || 0),
      best_bid: Number(units[0]?.bid_price || ticker?.trade_price || 0),
      asks: units.map((unit) => ({ price: Number(unit.ask_price), size: Number(unit.ask_size) })),
      bids: units.map((unit) => ({ price: Number(unit.bid_price), size: Number(unit.bid_size) })),
      // ask_bid === "BID" means the BUYER lifted the offer, i.e. buyer-initiated.
      trade_flow: Array.isArray(ticks)
        ? summarizeTradeFlow(
          ticks.map((t) => ({
            price: Number(t.trade_price),
            qty: Number(t.trade_volume),
            ts: Number(t.timestamp) || Date.now(),
            buyerTaker: String(t.ask_bid).toUpperCase() === "BID",
          })),
          Date.now(),
        )
        : EMPTY_FLOW,
      raw: { ticker, book },
      timing: {
        requested_at_ms: requestedAtMs,
        received_at_ms: Date.now(),
        gateway_elapsed_ms: Date.now() - requestedAtMs,
        // Upbit stamps its orderbook; this is the only true exchange-side anchor we get.
        book_captured_at_ms: Number(book?.timestamp) || null,
        source: Number(book?.timestamp) ? "EXCHANGE" : "GATEWAY_RECEIPT",
      },
    };
  }
  const futures = isBinanceFutures(exchange);
  const [ticker, depth, trades] = futures
    ? await Promise.all([
      publicBinanceFutures("/fapi/v1/ticker/bookTicker", { symbol }),
      publicBinanceFutures("/fapi/v1/depth", { symbol, limit: 100 }),
      publicBinanceFutures("/fapi/v1/trades", { symbol, limit: 100 }).catch(() => null),
    ])
    : await Promise.all([
      publicBinance("/api/v3/ticker/bookTicker", { symbol }),
      publicBinance("/api/v3/depth", { symbol, limit: 100 }),
      publicBinance("/api/v3/trades", { symbol, limit: 100 }).catch(() => null),
    ]);
  const asks = Array.isArray(depth?.asks)
    ? depth.asks.map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    : [];
  const bids = Array.isArray(depth?.bids)
    ? depth.bids.map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    : [];
  const bestAsk = Number(ticker?.askPrice || asks[0]?.price || 0);
  const bestBid = Number(ticker?.bidPrice || bids[0]?.price || 0);
  return {
    exchange,
    market: symbol,
    current: bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : Number(ticker?.price || 0),
    best_ask: bestAsk,
    best_bid: bestBid,
    asks,
    bids,
    // isBuyerMaker === true means the buyer was resting, so the SELLER was the aggressor.
    trade_flow: Array.isArray(trades)
      ? summarizeTradeFlow(
        trades.map((t) => ({
          price: Number(t.price),
          qty: Number(t.qty),
          ts: Number(t.time) || Date.now(),
          buyerTaker: t.isBuyerMaker === false,
        })),
        Date.now(),
      )
      : EMPTY_FLOW,
    raw: { ticker, depth },
    timing: {
      requested_at_ms: requestedAtMs,
      received_at_ms: Date.now(),
      gateway_elapsed_ms: Date.now() - requestedAtMs,
      // Binance /api/v3/depth returns no timestamp, so the receipt time is the best
      // anchor available. It understates true staleness by the venue's own response
      // time, which is why `source` is recorded rather than assumed.
      book_captured_at_ms: null,
      source: "GATEWAY_RECEIPT",
    },
  };
}

async function getOrder(exchange, identifier, market) {
  const id = validateIdentifier(identifier);
  if (isBinanceFutures(exchange)) return binanceFuturesGetOrder(id, market);
  return exchange === "upbit" ? upbitGetOrder(id) : binanceGetOrder(id, market);
}
async function cancelOrder(exchange, identifier, market) {
  const id = validateIdentifier(identifier);
  if (isBinanceFutures(exchange)) {
    return normalizeFuturesOrder(
      (await futuresRequest("DELETE", "/fapi/v1/order", {
        symbol: validateBinanceSymbol(market),
        origClientOrderId: id,
      })).data,
    );
  }
  if (exchange === "upbit") {
    const cancelled = normalizeUpbitOrder(
      (await upbitRequest("DELETE", "/v1/order", { query: { identifier: id } })).data,
    );
    if (cancelled.executed_volume > 0 && !(cancelled.executed_funds > 0)) {
      // The cancellation acknowledgement may omit the trade list. Re-read the terminal
      // order so a real partial fill can never be reported as zero-notional.
      try {
        return await upbitGetOrder(id);
      } catch {
        // The autotrader also merges cumulative progress monotonically. Returning the
        // acknowledgement is safer than treating a successful cancel as a live order.
      }
    }
    return cancelled;
  }
  return normalizeBinanceOrder(
    (await binanceRequest("DELETE", "/api/v3/order", {
      symbol: validateBinanceSymbol(market),
      origClientOrderId: id,
    })).data,
  );
}
// v5.4: real account commission rates.
//
// The cost model hardcoded 0.05% (Upbit) and 0.10% (Binance) per side. Those are list
// prices: Binance applies a 25% discount when "pay fees with BNB" is enabled, VIP tiers
// move both sides, and some pairs run promotional rates. Since required win rate is a
// direct function of cost, trading on an assumed fee rather than the account's real one
// mis-sizes every barrier. Fail soft: on any error the caller keeps its defaults.
async function accountFees(exchange, market = null) {
  if (isBinanceFutures(exchange)) return binanceFuturesFees(market);
  if (exchange === "upbit") {
    const symbol = market ? validateUpbitMarket(market) : "KRW-BTC";
    const chance =
      (await upbitRequest("GET", "/v1/orders/chance", { query: { market: symbol } })).data;
    const bid = Number(chance?.bid_fee);
    const ask = Number(chance?.ask_fee);
    return {
      exchange: "upbit",
      market: symbol,
      maker_pct: Number.isFinite(bid) ? bid * 100 : null,
      taker_pct: Number.isFinite(ask) ? ask * 100 : null,
      source: "orders_chance",
    };
  }
  const account =
    (await binanceRequest("GET", "/api/v3/account", { omitZeroBalances: "true" })).data;
  const rates = account?.commissionRates || {};
  const maker = Number(rates.maker);
  const taker = Number(rates.taker);
  return {
    exchange: "binance",
    market: market || null,
    maker_pct: Number.isFinite(maker) ? maker * 100 : null,
    taker_pct: Number.isFinite(taker) ? taker * 100 : null,
    // Reported rates already include the BNB discount when fee payment in BNB is enabled.
    bnb_fee_payment: account?.canTrade != null ? Boolean(account?.commissionRates) : null,
    source: "account_commission_rates",
  };
}

async function openOrders(exchange, market = null) {
  if (isBinanceFutures(exchange)) {
    const rows = (await futuresRequest(
      "GET",
      "/fapi/v1/openOrders",
      market ? { symbol: validateBinanceSymbol(market) } : {},
    )).data;
    return (Array.isArray(rows) ? rows : []).map(normalizeFuturesOrder);
  }
  if (exchange === "upbit") {
    const rows = (await upbitRequest("GET", "/v1/orders/open", {
      query: {
        states: ["wait", "watch"],
        limit: 100,
        order_by: "asc",
        ...(market ? { market: validateUpbitMarket(market) } : {}),
      },
    })).data;
    return (Array.isArray(rows) ? rows : []).map(normalizeUpbitOrder);
  }
  const rows = (await binanceRequest(
    "GET",
    "/api/v3/openOrders",
    market ? { symbol: validateBinanceSymbol(market) } : {},
  )).data;
  return (Array.isArray(rows) ? rows : []).map(normalizeBinanceOrder);
}
async function cancelBotOrders(exchange, market = null) {
  const rows = await openOrders(exchange, market);
  const targets = rows.filter((row) =>
    String(row.client_order_id || "").startsWith(BOT_IDENTIFIER_PREFIX)
  );
  const results = [];
  for (const row of targets) {
    try {
      results.push(
        await cancelOrder(
          exchange,
          row.client_order_id,
          market || row.raw?.symbol || row.raw?.market,
        ),
      );
    } catch (error) {
      results.push({
        client_order_id: row.client_order_id,
        error: error.message,
        code: error.code,
      });
    }
    await sleep(exchange === "upbit" ? 150 : 80);
  }
  return results;
}

/**
 * v6.5: bracket an order submission with timestamps.
 *
 * `submitted_at_ms` is when the request left this process and `acked_at_ms` is when the
 * exchange answered. The difference is transport plus matching-engine time, which is the
 * only part of the path the autotrader cannot see from its own side. Timing must never be
 * able to fail an order, so it is attached only on success and never inspected here.
 */
async function withOrderTiming(work) {
  const submittedAtMs = Date.now();
  const result = await work();
  const ackedAtMs = Date.now();
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.timing = {
      submitted_at_ms: submittedAtMs,
      acked_at_ms: ackedAtMs,
      round_trip_ms: ackedAtMs - submittedAtMs,
    };
  }
  return result;
}

function assertOrderEngineVersion(command) {
  const supplied = String(command?.engine_version || "");
  if (!ACCEPTED_ENGINE_VERSIONS.has(supplied)) {
    throw Object.assign(
      new Error(`engine version mismatch: command=${supplied || "MISSING"}, gateway=${VERSION}`),
      { status: 409, code: "ENGINE_VERSION_MISMATCH" },
    );
  }
  return true;
}

async function handleCommand(command) {
  const exchange = validateExchange(command?.exchange);
  const futures = isBinanceFutures(exchange);
  switch (String(command?.action || "")) {
    case "portfolio":
      if (futures) return binanceFuturesPortfolio();
      return exchange === "upbit" ? upbitPortfolio() : binancePortfolio();
    case "accounts":
      if (futures) return (await futuresRequest("GET", "/fapi/v2/account")).data;
      return exchange === "upbit"
        ? (await upbitRequest("GET", "/v1/accounts")).data
        : (await binanceRequest("GET", "/api/v3/account", { omitZeroBalances: "true" })).data;
    case "quote":
      return quote(exchange, command.market);
    case "symbol_info":
      if (futures) return binanceFuturesExchangeInfo(command.market);
      return exchange === "binance"
        ? binanceExchangeInfo(command.market)
        : { market: validateUpbitMarket(command.market), quote_asset: "KRW" };
    case "set_leverage":
      if (!futures) throw new Error("leverage is only settable on binance_futures");
      return ensureFuturesLeverage(command.market, command.leverage ?? DEFAULT_FUTURES_LEVERAGE);
    case "order_test":
      if (futures) {
        // USDⓈ-M has no dry-run order endpoint. Conforming the order is the equivalent
        // check: it applies every filter the exchange would apply, without submitting.
        const info = await binanceFuturesExchangeInfo((command.order || {}).market);
        return conformFuturesOrder(
          command.order || {},
          info,
          await futuresPositionSideDual(),
          command.leverage ?? (command.order || {}).leverage ?? DEFAULT_FUTURES_LEVERAGE,
        ).order;
      }
      return exchange === "upbit"
        ? upbitOrderTest(command.order || {})
        : binanceOrderTest(command.order || {});
    case "create_order":
      assertOrderEngineVersion(command);
      return withOrderTiming(() =>
        futures
          ? binanceFuturesCreateOrder(
            command.order || {},
            command.wait_for_final_ms,
            command.leverage ?? (command.order || {}).leverage ?? null,
          )
          : exchange === "upbit"
          ? upbitCreateOrder(command.order || {}, command.wait_for_final_ms)
          : binanceCreateOrder(command.order || {}, command.wait_for_final_ms)
      );
    case "get_order":
      return getOrder(exchange, command.identifier, command.market);
    case "cancel_order":
      return cancelOrder(exchange, command.identifier, command.market);
    case "open_orders":
      return openOrders(exchange, command.market || null);
    case "fees":
      return accountFees(exchange, command.market || null);
    case "cancel_bot_orders":
      return cancelBotOrders(exchange, command.market || null);
    default:
      throw new Error("unsupported gateway action");
  }
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
async function readBody(req, maxBytes = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function callAutotrader(action) {
  if (!SUPABASE_URL || !AUTOTRADE_TOKEN) {
    throw new Error("SUPABASE_URL/AUTOTRADE_ACCESS_TOKEN not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action === "scan" ? 360_000 : 45_000);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/market-autotrader`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-autotrade-token": AUTOTRADE_TOKEN },
      body: JSON.stringify({
        action,
        source: "static-ip-gateway-scheduler",
        at: new Date().toISOString(),
        engine_version: VERSION,
      }),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) throw new Error(`autotrader ${response.status}: ${data?.error || text}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function schedulerTick(kind) {
  const key = kind === "scan" ? "scanRunning" : "monitorRunning";
  if (schedulerState[key]) return;
  schedulerState[key] = true;
  try {
    const result = await callAutotrader(kind);
    schedulerState[kind === "scan" ? "lastScanAt" : "lastMonitorAt"] = new Date().toISOString();
    schedulerState[kind === "scan" ? "lastScanResult" : "lastMonitorResult"] = result?.status ||
      "ok";
    schedulerState.lastError = null;
  } catch (error) {
    schedulerState.lastError = `${kind}: ${error.message}`;
    console.error("scheduler", kind, error);
  } finally {
    schedulerState[key] = false;
  }
}
async function discoverEgressIp() {
  try {
    const response = await fetch("https://api4.ipify.org?format=json");
    const data = await response.json();
    schedulerState.egressIpv4 = data.ip || null;
  } catch (error) {
    console.warn("egress IP discovery failed", error.message);
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          accepted_engine_versions: [...ACCEPTED_ENGINE_VERSIONS],
          keys_configured: {
            upbit: Boolean(UPBIT_ACCESS_KEY && UPBIT_SECRET_KEY),
            binance: Boolean(BINANCE_API_KEY && BINANCE_SECRET_KEY),
            // The futures lane shares the Binance key; the account must additionally
            // have USDⓈ-M futures enabled for it, which only a live call can prove.
            binance_futures: Boolean(BINANCE_API_KEY && BINANCE_SECRET_KEY),
          },
          scheduler_enabled: SCHEDULER_ENABLED,
          scheduler: schedulerState,
          intervals: {
            scan_seconds: SCAN_INTERVAL_MS / 1000,
            monitor_seconds: MONITOR_INTERVAL_MS / 1000,
          },
          limits: {
            source: "operator_allocation",
            hidden_monetary_caps: false,
          },
        });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/command") {
        return sendJson(res, 404, { error: "not found" });
      }
      const raw = await readBody(req);
      const verification = verifyGatewayRequest(req, raw);
      if (!verification.ok) {
        return sendJson(res, verification.status, { error: verification.error });
      }
      const result = await handleCommand(raw ? JSON.parse(raw) : {});
      return sendJson(res, 200, { ok: true, result, version: VERSION });
    } catch (error) {
      console.error("gateway request failed", error);
      return sendJson(res, Number(error.status) || 400, {
        ok: false,
        error: error.message,
        code: error.code || "GATEWAY_ERROR",
      });
    }
  });
}
export async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`Trading-booooo multi-exchange gateway v${VERSION} listening on ${PORT}`);
  await discoverEgressIp();
  if (BINANCE_API_KEY && BINANCE_SECRET_KEY) {
    syncBinanceTime(true).catch((error) => console.warn("Binance time sync failed", error.message));
  }
  if (SCHEDULER_ENABLED) {
    setTimeout(() => schedulerTick("monitor"), 2_000).unref();
    // v6.2: the first scan used to wait 20 seconds after boot, so every deploy and every
    // machine restart bought roughly two scan cycles of nothing. The heat sample is
    // self-contained within a single scan -- it takes its own three snapshots -- so there
    // is no warm-up state that the delay was protecting.
    setTimeout(() => schedulerTick("scan"), COLD_START_SCAN_MS).unref();
    setInterval(() => schedulerTick("monitor"), MONITOR_INTERVAL_MS).unref();
    setInterval(() => schedulerTick("scan"), SCAN_INTERVAL_MS).unref();
    setInterval(discoverEgressIp, 6 * 60 * 60 * 1000).unref();
    setInterval(() => syncBinanceTime(true).catch(() => null), 30 * 60_000).unref();
  }
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  assertOrderEngineVersion,
  binanceQueryString,
  binanceTradesToFills,
  buildFuturesPortfolio,
  buildUpbitPortfolio,
  conformFuturesOrder,
  contextualizeError,
  createBinanceSignature,
  createUpbitJwt,
  encodedQueryString,
  floorStep,
  formatStep,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  localRateLimit,
  normalizeBinanceOrder,
  normalizeFuturesOrder,
  normalizeUpbitOrder,
  rawQueryString,
  resolveFuturesIntent,
  stepPrecision,
  upbitRateGroup,
  validateBinanceSymbol,
  validateExchange,
  validateFuturesLeverage,
  validateIdentifier,
  validateUpbitMarket,
  VERSION,
};
