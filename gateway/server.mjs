import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns";
import { pathToFileURL } from "node:url";

// Trading-booooo v5.2.0 static-egress order gateway.
// It deliberately exposes only spot account/order primitives. There are no
// withdrawal, transfer, margin, futures, leverage, or API-key management routes.
dns.setDefaultResultOrder("ipv4first");

const VERSION = "5.2.1";
const PORT = integerEnv("PORT", 8080, 1, 65535);
const UPBIT_BASE = env("UPBIT_BASE_URL", "https://api.upbit.com").replace(/\/$/, "");
const BINANCE_BASE = env("BINANCE_BASE_URL", "https://api.binance.com").replace(/\/$/, "");
const UPBIT_ACCESS_KEY = env("UPBIT_ACCESS_KEY");
const UPBIT_SECRET_KEY = env("UPBIT_SECRET_KEY");
const BINANCE_API_KEY = env("BINANCE_API_KEY");
const BINANCE_SECRET_KEY = env("BINANCE_SECRET_KEY");
const SHARED_SECRET = env("GATEWAY_SHARED_SECRET");
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const SCHEDULER_ENABLED = boolEnv("SCHEDULER_ENABLED", true);
const SCAN_INTERVAL_MS = integerEnv("AUTO_SCAN_INTERVAL_SECONDS", 60, 60, 3600) * 1000;
const MONITOR_INTERVAL_MS = integerEnv("AUTO_MONITOR_INTERVAL_SECONDS", 15, 10, 300) * 1000;
const REQUEST_TOLERANCE_MS = integerEnv("GATEWAY_REQUEST_TOLERANCE_SECONDS", 60, 10, 300) * 1000;
const UPBIT_MAX_ORDER_KRW = numberEnv("UPBIT_MAX_ORDER_KRW", 100_000, 5_000, 1_000_000_000);
const UPBIT_MAX_DAILY_BUY_KRW = numberEnv("UPBIT_MAX_DAILY_BUY_KRW", 300_000, 5_000, 10_000_000_000);
const BINANCE_MAX_ORDER_USDT = numberEnv("BINANCE_MAX_ORDER_USDT", 100, 5, 10_000_000);
const BINANCE_MAX_DAILY_BUY_USDT = numberEnv("BINANCE_MAX_DAILY_BUY_USDT", 300, 5, 100_000_000);
const BOT_IDENTIFIER_PREFIX = "tb-";

const nonceCache = new Map();
const rateState = {
  upbit: { groups: new Map(), dailyKey: kstDate(), dailyBuy: 0 },
  binance: { groups: new Map(), dailyKey: utcDate(), dailyBuy: 0 },
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

function env(name, fallback = "") { return String(process.env[name] ?? fallback).trim(); }
function boolEnv(name, fallback) {
  const value = env(name);
  return value ? ["1", "true", "yes", "on"].includes(value.toLowerCase()) : fallback;
}
function numberEnv(name, fallback, min, max) {
  const value = Number(env(name));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function integerEnv(name, fallback, min, max) { return Math.round(numberEnv(name, fallback, min, max)); }
function kstDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}
function utcDate(date = new Date()) { return date.toISOString().slice(0, 10); }
function base64url(input) { return Buffer.from(input).toString("base64url"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function decimal(value, maxDecimals = 16) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("invalid decimal value");
  return n.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
}
function floorStep(value, step) {
  const v = Number(value); const s = Number(step);
  if (!(v > 0 && s > 0)) return 0;
  const precision = Math.min(16, Math.max(0, (String(s).split(".")[1] || "").replace(/0+$/, "").length));
  return Number((Math.floor((v + s * 1e-9) / s) * s).toFixed(precision));
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
function rawQueryString(object = {}) { return pairs(object).map(([key, value]) => `${key}=${value}`).join("&"); }
function encodedQueryString(object = {}) {
  return pairs(object).map(([key, value]) => `${encodeURIComponent(key).replace(/%5B%5D/g, "[]")}=${encodeURIComponent(value)}`).join("&");
}
function binanceQueryString(object = {}) {
  return Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function createUpbitJwt(parameters = {}) {
  if (!UPBIT_ACCESS_KEY || !UPBIT_SECRET_KEY) {
    throw Object.assign(new Error("UPBIT_ACCESS_KEY/UPBIT_SECRET_KEY are not configured"), { status: 503, code: "UPBIT_KEYS_MISSING" });
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
  if (!BINANCE_SECRET_KEY) throw Object.assign(new Error("BINANCE_SECRET_KEY is not configured"), { status: 503, code: "BINANCE_KEYS_MISSING" });
  return crypto.createHmac("sha256", BINANCE_SECRET_KEY).update(queryString).digest("hex");
}

function pruneNonces(now = Date.now()) {
  for (const [nonce, expiry] of nonceCache.entries()) if (expiry <= now) nonceCache.delete(nonce);
}
function verifyGatewayRequest(req, rawBody) {
  if (!SHARED_SECRET || SHARED_SECRET.length < 32) return { ok: false, status: 503, error: "gateway secret is not configured" };
  const timestamp = req.headers["x-gateway-ts"];
  const nonce = req.headers["x-gateway-nonce"];
  const signature = req.headers["x-gateway-signature"];
  if (!timestamp || !nonce || !signature) return { ok: false, status: 401, error: "missing signed gateway headers" };
  const ts = Number(timestamp); const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REQUEST_TOLERANCE_MS) return { ok: false, status: 401, error: "expired gateway request" };
  pruneNonces(now);
  if (nonceCache.has(String(nonce))) return { ok: false, status: 409, error: "replayed gateway request" };
  const expected = crypto.createHmac("sha256", SHARED_SECRET).update(`${timestamp}\n${nonce}\n${rawBody}`).digest("hex");
  if (!safeEqual(expected, signature)) return { ok: false, status: 401, error: "invalid gateway signature" };
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
  if (current.second !== second) { current.second = second; current.count = 0; }
  current.count++;
  state.groups.set(group, current);
  const max = localRateLimit(exchange, group);
  if (current.count > max) throw Object.assign(new Error(`local ${exchange} ${group} rate guard exceeded`), { status: 429, code: "LOCAL_RATE_GUARD" });
}
function refreshDailyCounter(exchange) {
  const state = rateState[exchange];
  const today = exchange === "upbit" ? kstDate() : utcDate();
  if (state.dailyKey !== today) { state.dailyKey = today; state.dailyBuy = 0; }
}
function enforceBuyCaps(exchange, notional) {
  refreshDailyCounter(exchange);
  const maxOrder = exchange === "upbit" ? UPBIT_MAX_ORDER_KRW : BINANCE_MAX_ORDER_USDT;
  const maxDaily = exchange === "upbit" ? UPBIT_MAX_DAILY_BUY_KRW : BINANCE_MAX_DAILY_BUY_USDT;
  if (notional > maxOrder + 1e-8) throw new Error(`order exceeds gateway ${exchange} max order ${maxOrder}`);
  if (rateState[exchange].dailyBuy + notional > maxDaily + 1e-8) throw new Error(`daily gateway ${exchange} buy cap ${maxDaily} exceeded`);
}
function recordBuy(exchange, notional) { refreshDailyCounter(exchange); rateState[exchange].dailyBuy += Math.max(0, Number(notional) || 0); }

async function parseResponse(response, exchange) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.msg || data?.message || `${exchange} ${response.status}`;
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
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method, signal: controller.signal,
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
    } catch (error) { throw contextualizeError(error, `Upbit ${method} ${path}`); }
  } finally { clearTimeout(timer); }
}
async function publicUpbit(path, query = {}) {
  guardRate("upbit", upbitRateGroup("GET", path, true));
  const encoded = encodedQueryString(query);
  const response = await fetch(`${UPBIT_BASE}${path}${encoded ? `?${encoded}` : ""}`, { headers: { Accept: "application/json" } });
  try { return (await parseResponse(response, "Upbit public")).data; }
  catch (error) { throw contextualizeError(error, `Upbit public GET ${path}`); }
}

async function syncBinanceTime(force = false) {
  if (!force && Date.now() - lastBinanceTimeSyncAt < 10 * 60_000) return binanceTimeOffsetMs;
  guardRate("binance", "rest");
  const started = Date.now();
  const response = await fetch(`${BINANCE_BASE}/api/v3/time`, { headers: { Accept: "application/json" } });
  const data = (await parseResponse(response, "Binance time")).data;
  const ended = Date.now();
  const serverTime = Number(data?.serverTime);
  if (!Number.isFinite(serverTime)) throw new Error("Binance time response is invalid");
  binanceTimeOffsetMs = serverTime - Math.round((started + ended) / 2);
  lastBinanceTimeSyncAt = ended;
  return binanceTimeOffsetMs;
}
async function publicBinance(path, query = {}, timeoutMs = 10_000) {
  guardRate("binance", "rest");
  const encoded = binanceQueryString(query);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BINANCE_BASE}${path}${encoded ? `?${encoded}` : ""}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    return (await parseResponse(response, "Binance public")).data;
  } finally { clearTimeout(timer); }
}
async function binanceRequest(method, path, parameters = {}, { timeoutMs = 10_000, retryTimestamp = true } = {}) {
  if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
    throw Object.assign(new Error("BINANCE_API_KEY/BINANCE_SECRET_KEY are not configured"), { status: 503, code: "BINANCE_KEYS_MISSING" });
  }
  guardRate("binance", "rest");
  await syncBinanceTime(false);
  const signed = {
    ...parameters,
    recvWindow: Math.min(5_000, Math.max(1_000, Number(parameters.recvWindow) || 5_000)),
    timestamp: Date.now() + binanceTimeOffsetMs,
  };
  const payload = binanceQueryString(signed);
  const signature = createBinanceSignature(payload);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BINANCE_BASE}${path}?${payload}&signature=${signature}`, {
      method,
      signal: controller.signal,
      headers: { Accept: "application/json", "X-MBX-APIKEY": BINANCE_API_KEY },
    });
    try {
      const parsed = await parseResponse(response, "Binance");
      return { data: parsed.data, headers: parsed.headers };
    } catch (error) {
      if (retryTimestamp && Number(error?.code) === -1021) {
        await syncBinanceTime(true);
        return binanceRequest(method, path, parameters, { timeoutMs, retryTimestamp: false });
      }
      throw error;
    }
  } finally { clearTimeout(timer); }
}

function validateExchange(exchange) {
  const value = String(exchange || "").toLowerCase();
  if (value !== "upbit" && value !== "binance") throw new Error("exchange must be upbit or binance");
  return value;
}
function validateUpbitMarket(market) {
  const value = String(market || "").toUpperCase();
  if (!/^KRW-[A-Z0-9]{2,20}$/.test(value)) throw new Error("only Upbit KRW spot markets are allowed");
  return value;
}
function validateBinanceSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  if (!/^[A-Z0-9]{2,24}USDT$/.test(value)) throw new Error("only Binance USDT spot symbols are allowed");
  return value;
}
function validateMarket(exchange, market) { return exchange === "upbit" ? validateUpbitMarket(market) : validateBinanceSymbol(market); }
function validateIdentifier(identifier) {
  const value = String(identifier || "");
  if (!value.startsWith(BOT_IDENTIFIER_PREFIX) || value.length > 36 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid bot order identifier");
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
    if (rawStatus === "wait" || rawStatus === "watch") return executedQty > 0 ? "PARTIALLY_FILLED" : "OPEN";
    return "UNKNOWN";
  }
  const status = String(rawStatus || "").toUpperCase();
  if (status === "FILLED") return "FILLED";
  if (status === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
  if (["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"].includes(status)) return executedQty > 0 ? "PARTIALLY_FILLED_CANCELED" : "CANCELED";
  if (status === "NEW" || status === "PENDING_NEW") return "OPEN";
  if (originalQty > 0 && executedQty >= originalQty) return "FILLED";
  return "UNKNOWN";
}
function normalizeUpbitOrder(order) {
  const trades = Array.isArray(order?.trades) ? order.trades : [];
  const executedVolume = Number(order?.executed_volume || trades.reduce((sum, row) => sum + Number(row.volume || 0), 0));
  const executedFunds = Number(order?.executed_funds || trades.reduce((sum, row) => sum + Number(row.funds || Number(row.price || 0) * Number(row.volume || 0)), 0));
  const paidFee = Number(order?.paid_fee || trades.reduce((sum, row) => sum + Number(row.fee || 0), 0));
  const normalizedTrades = trades.map((trade) => ({
    trade_id: trade.uuid || null,
    price: Number(trade.price || 0),
    volume: Number(trade.volume || 0),
    funds: Number(trade.funds || Number(trade.price || 0) * Number(trade.volume || 0)),
    fee: Number(trade.fee || 0),
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
    average_price: executedVolume > 0 ? executedFunds / executedVolume : Number(order?.avg_price || 0) || null,
    paid_fee: Number.isFinite(paidFee) ? paidFee : 0,
    fee_asset: "KRW",
    trades: normalizedTrades,
    raw: order,
  };
}
function normalizeBinanceOrder(order) {
  const fills = Array.isArray(order?.fills) ? order.fills : [];
  const executedVolume = Number(order?.executedQty || 0);
  const executedFunds = Number(order?.cummulativeQuoteQty || order?.cumulativeQuoteQty || fills.reduce((sum, row) => sum + Number(row.price || 0) * Number(row.qty || 0), 0));
  const commissions = fills.reduce((sum, row) => sum + Number(row.commission || 0), 0);
  const feeAssetSet = [...new Set(fills.map((row) => row.commissionAsset).filter(Boolean))];
  const trades = fills.map((fill, index) => ({
    trade_id: fill.tradeId != null ? String(fill.tradeId) : `${order?.orderId || "order"}-${index}`,
    price: Number(fill.price || 0),
    volume: Number(fill.qty || 0),
    funds: Number(fill.price || 0) * Number(fill.qty || 0),
    fee: Number(fill.commission || 0),
    fee_asset: fill.commissionAsset || null,
    executed_at: order?.transactTime ? new Date(Number(order.transactTime)).toISOString() : null,
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
  const side = payload.side === "SELL" || payload.side === "ask" ? "ask" : payload.side === "BUY" || payload.side === "bid" ? "bid" : null;
  if (!side) throw new Error("invalid Upbit order side");
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  const body = { market, side, identifier };
  if (type === "LIMIT") {
    const price = Number(payload.price); const volume = Number(payload.quantity ?? payload.volume);
    if (!(price > 0 && volume > 0)) throw new Error("Upbit limit order requires positive price and quantity");
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
  } else throw new Error("Upbit order type must be LIMIT or MARKET");

  let normalized;
  try {
    const raw = (await upbitRequest("POST", "/v1/orders", { body, timeoutMs: 12_000 })).data;
    normalized = normalizeUpbitOrder(raw);
  } catch (error) {
    if (["AbortError", "TypeError"].includes(error?.name) || Number(error?.status) >= 500) {
      try { normalized = await upbitGetOrder(identifier); } catch { throw error; }
    } else throw error;
  }
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(waitForFinalMs) || 0));
  while (Date.now() < deadline && ["OPEN", "PARTIALLY_FILLED"].includes(normalized.status)) {
    await sleep(300);
    normalized = await upbitGetOrder(identifier);
  }
  if (side === "bid" && type === "LIMIT" && normalized.executed_funds > 0) recordBuy("upbit", normalized.executed_funds);
  return { order: normalized, fill: fillSummary(normalized) };
}
async function upbitOrderTest(payload) {
  const market = validateUpbitMarket(payload.market); const identifier = validateIdentifier(payload.identifier);
  const side = payload.side === "SELL" || payload.side === "ask" ? "ask" : payload.side === "BUY" || payload.side === "bid" ? "bid" : null;
  const type = String(payload.type || payload.ord_type || "").toUpperCase();
  if (!side || !["LIMIT", "MARKET"].includes(type)) throw new Error("invalid Upbit test order");
  const body = { market, side, identifier };
  if (type === "LIMIT") {
    const price = Number(payload.price); const quantity = Number(payload.quantity ?? payload.volume);
    if (!(price > 0 && quantity > 0)) throw new Error("Upbit limit test requires price and quantity");
    Object.assign(body, { ord_type: "limit", price: decimal(price, 12), volume: decimal(quantity, 16) });
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
  if (!row || row.status !== "TRADING" || row.isSpotTradingAllowed === false) throw new Error(`Binance ${market} is not available for spot trading`);
  const filters = Object.fromEntries((row.filters || []).map((filter) => [filter.filterType, filter]));
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
  if (!["LIMIT", "MARKET"].includes(type)) throw new Error("Binance order type must be LIMIT or MARKET");
  const clientOrderId = validateIdentifier(payload.identifier || payload.newClientOrderId);
  let quantity = floorStep(Number(payload.quantity ?? payload.volume), info.quantity_step);
  if (!(quantity > 0) || quantity < info.min_quantity) throw new Error("Binance quantity is below LOT_SIZE minimum");
  if (info.max_quantity > 0 && quantity > info.max_quantity) quantity = floorStep(info.max_quantity, info.quantity_step);
  const order = {
    symbol: info.symbol,
    side,
    type,
    quantity: decimal(quantity, 16),
    newClientOrderId: clientOrderId,
    newOrderRespType: "FULL",
  };
  if (type === "LIMIT") {
    const price = floorStep(Number(payload.price), info.price_tick);
    if (!(price > 0)) throw new Error("Binance limit order requires a valid tick-aligned price");
    const notional = price * quantity;
    if (info.min_notional > 0 && notional < info.min_notional) throw new Error(`Binance order notional ${notional} below ${info.min_notional}`);
    if (info.max_notional > 0 && notional > info.max_notional) throw new Error(`Binance order notional ${notional} above ${info.max_notional}`);
    if (side === "BUY") enforceBuyCaps("binance", notional);
    order.price = decimal(price, 16);
    order.timeInForce = String(payload.time_in_force || payload.timeInForce || "IOC").toUpperCase();
  } else if (side === "BUY") {
    throw new Error("Binance market orders are restricted to sells");
  }
  return { order, info, notional: type === "LIMIT" ? Number(order.price) * Number(order.quantity) : 0 };
}
async function binanceGetOrder(identifier, symbol) {
  const data = (await binanceRequest("GET", "/api/v3/order", {
    symbol: validateBinanceSymbol(symbol), origClientOrderId: validateIdentifier(identifier),
  })).data;
  return normalizeBinanceOrder(data);
}
async function binanceCreateOrder(payload, waitForFinalMs = 2500) {
  const info = await binanceExchangeInfo(payload.market);
  const conformed = conformBinanceOrder(payload, info);
  let normalized;
  try {
    const raw = (await binanceRequest("POST", "/api/v3/order", conformed.order, { timeoutMs: 12_000 })).data;
    normalized = normalizeBinanceOrder(raw);
  } catch (error) {
    // Binance documents 5xx/-1007 as UNKNOWN execution status. Reconcile by
    // deterministic clientOrderId; never submit the same economic order twice.
    if (["AbortError", "TypeError"].includes(error?.name) || Number(error?.status) >= 500 || Number(error?.code) === -1007) {
      try { normalized = await binanceGetOrder(conformed.order.newClientOrderId, info.symbol); } catch { throw error; }
    } else throw error;
  }
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(waitForFinalMs) || 0));
  while (Date.now() < deadline && ["OPEN", "PARTIALLY_FILLED"].includes(normalized.status)) {
    await sleep(250);
    normalized = await binanceGetOrder(conformed.order.newClientOrderId, info.symbol);
  }
  if (conformed.order.side === "BUY" && normalized.executed_funds > 0) recordBuy("binance", normalized.executed_funds);
  return { order: normalized, fill: fillSummary(normalized), symbol_info: info };
}
async function binanceOrderTest(payload) {
  const info = await binanceExchangeInfo(payload.market);
  const conformed = conformBinanceOrder(payload, info);
  return (await binanceRequest("POST", "/api/v3/order/test", conformed.order)).data;
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
  const prices = Object.fromEntries(tickerRows
    .filter((row) => String(row?.market || "").startsWith("KRW-") && Number(row?.trade_price) > 0)
    .map((row) => [String(row.market), Number(row.trade_price)]));
  let total = 0; let available = 0; let locked = 0;
  const unpricedAssets = [];
  for (const row of rows) {
    const currency = String(row?.currency || "").toUpperCase();
    const free = Math.max(0, Number(row?.balance || 0));
    const held = Math.max(0, Number(row?.locked || 0));
    const quantity = free + held;
    if (currency === "KRW") {
      available = free; locked = held; total += quantity;
      continue;
    }
    if (!(quantity > 0)) continue;
    const market = `KRW-${currency}`;
    const price = Number(prices[market] || 0);
    if (price > 0) total += quantity * price;
    else unpricedAssets.push({ currency, balance: free, locked: held, reason: "NO_ACTIVE_KRW_TICKER" });
  }
  return {
    exchange: "upbit", quote_currency: "KRW", accounts: rows, prices,
    total_equity_quote: total, available_quote: available, locked_quote: locked,
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
  const account = (await binanceRequest("GET", "/api/v3/account", { omitZeroBalances: "true" })).data;
  const balances = Array.isArray(account?.balances) ? account.balances : [];
  const tickers = await publicBinance("/api/v3/ticker/price");
  const prices = Object.fromEntries((Array.isArray(tickers) ? tickers : []).map((r) => [r.symbol, Number(r.price)]));
  let total = 0; let available = 0; let locked = 0;
  const accounts = balances.map((row) => ({
    currency: row.asset,
    balance: Number(row.free || 0),
    locked: Number(row.locked || 0),
    avg_buy_price: null,
  }));
  for (const row of accounts) {
    if (row.currency === "USDT") { available = row.balance; locked = row.locked; total += row.balance + row.locked; }
    else total += (row.balance + row.locked) * Number(prices[`${row.currency}USDT`] || 0);
  }
  return {
    exchange: "binance", quote_currency: "USDT", accounts, prices,
    total_equity_quote: total, available_quote: available, locked_quote: locked,
    commission_rates: account?.commissionRates || null,
  };
}
async function quote(exchange, market) {
  const symbol = validateMarket(exchange, market);
  if (exchange === "upbit") {
    const [tickers, books] = await Promise.all([
      publicUpbit("/v1/ticker", { markets: symbol }),
      publicUpbit("/v1/orderbook", { markets: symbol }),
    ]);
    const ticker = Array.isArray(tickers) ? tickers[0] : null;
    const book = Array.isArray(books) ? books[0] : null;
    const units = Array.isArray(book?.orderbook_units) ? book.orderbook_units : [];
    return {
      exchange, market: symbol, current: Number(ticker?.trade_price || 0),
      best_ask: Number(units[0]?.ask_price || ticker?.trade_price || 0),
      best_bid: Number(units[0]?.bid_price || ticker?.trade_price || 0),
      asks: units.map((unit) => ({ price: Number(unit.ask_price), size: Number(unit.ask_size) })),
      bids: units.map((unit) => ({ price: Number(unit.bid_price), size: Number(unit.bid_size) })),
      raw: { ticker, book },
    };
  }
  const [ticker, depth] = await Promise.all([
    publicBinance("/api/v3/ticker/bookTicker", { symbol }),
    publicBinance("/api/v3/depth", { symbol, limit: 100 }),
  ]);
  const asks = Array.isArray(depth?.asks) ? depth.asks.map(([price, size]) => ({ price: Number(price), size: Number(size) })) : [];
  const bids = Array.isArray(depth?.bids) ? depth.bids.map(([price, size]) => ({ price: Number(price), size: Number(size) })) : [];
  const bestAsk = Number(ticker?.askPrice || asks[0]?.price || 0);
  const bestBid = Number(ticker?.bidPrice || bids[0]?.price || 0);
  return {
    exchange, market: symbol, current: bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : Number(ticker?.price || 0),
    best_ask: bestAsk, best_bid: bestBid, asks, bids, raw: { ticker, depth },
  };
}

async function getOrder(exchange, identifier, market) {
  const id = validateIdentifier(identifier);
  return exchange === "upbit" ? upbitGetOrder(id) : binanceGetOrder(id, market);
}
async function cancelOrder(exchange, identifier, market) {
  const id = validateIdentifier(identifier);
  if (exchange === "upbit") {
    return normalizeUpbitOrder((await upbitRequest("DELETE", "/v1/order", { query: { identifier: id } })).data);
  }
  return normalizeBinanceOrder((await binanceRequest("DELETE", "/api/v3/order", {
    symbol: validateBinanceSymbol(market), origClientOrderId: id,
  })).data);
}
async function openOrders(exchange, market = null) {
  if (exchange === "upbit") {
    const rows = (await upbitRequest("GET", "/v1/orders/open", {
      query: { states: ["wait", "watch"], limit: 100, order_by: "asc", ...(market ? { market: validateUpbitMarket(market) } : {}) },
    })).data;
    return (Array.isArray(rows) ? rows : []).map(normalizeUpbitOrder);
  }
  const rows = (await binanceRequest("GET", "/api/v3/openOrders", market ? { symbol: validateBinanceSymbol(market) } : {})).data;
  return (Array.isArray(rows) ? rows : []).map(normalizeBinanceOrder);
}
async function cancelBotOrders(exchange, market = null) {
  const rows = await openOrders(exchange, market);
  const targets = rows.filter((row) => String(row.client_order_id || "").startsWith(BOT_IDENTIFIER_PREFIX));
  const results = [];
  for (const row of targets) {
    try { results.push(await cancelOrder(exchange, row.client_order_id, market || row.raw?.symbol || row.raw?.market)); }
    catch (error) { results.push({ client_order_id: row.client_order_id, error: error.message, code: error.code }); }
    await sleep(exchange === "upbit" ? 150 : 80);
  }
  return results;
}

async function handleCommand(command) {
  const exchange = validateExchange(command?.exchange);
  switch (String(command?.action || "")) {
    case "portfolio": return exchange === "upbit" ? upbitPortfolio() : binancePortfolio();
    case "accounts": return exchange === "upbit" ? (await upbitRequest("GET", "/v1/accounts")).data : (await binanceRequest("GET", "/api/v3/account", { omitZeroBalances: "true" })).data;
    case "quote": return quote(exchange, command.market);
    case "symbol_info": return exchange === "binance" ? binanceExchangeInfo(command.market) : { market: validateUpbitMarket(command.market), quote_asset: "KRW" };
    case "order_test": return exchange === "upbit" ? upbitOrderTest(command.order || {}) : binanceOrderTest(command.order || {});
    case "create_order": return exchange === "upbit" ? upbitCreateOrder(command.order || {}, command.wait_for_final_ms) : binanceCreateOrder(command.order || {}, command.wait_for_final_ms);
    case "get_order": return getOrder(exchange, command.identifier, command.market);
    case "cancel_order": return cancelOrder(exchange, command.identifier, command.market);
    case "open_orders": return openOrders(exchange, command.market || null);
    case "cancel_bot_orders": return cancelBotOrders(exchange, command.market || null);
    default: throw new Error("unsupported gateway action");
  }
}
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
async function readBody(req, maxBytes = 65_536) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function callAutotrader(action) {
  if (!SUPABASE_URL || !AUTOTRADE_TOKEN) throw new Error("SUPABASE_URL/AUTOTRADE_ACCESS_TOKEN not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action === "scan" ? 360_000 : 45_000);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/market-autotrader`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-autotrade-token": AUTOTRADE_TOKEN },
      body: JSON.stringify({ action, source: "static-ip-gateway-scheduler", at: new Date().toISOString() }),
    });
    const text = await response.text(); let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) throw new Error(`autotrader ${response.status}: ${data?.error || text}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function schedulerTick(kind) {
  const key = kind === "scan" ? "scanRunning" : "monitorRunning";
  if (schedulerState[key]) return;
  schedulerState[key] = true;
  try {
    const result = await callAutotrader(kind);
    schedulerState[kind === "scan" ? "lastScanAt" : "lastMonitorAt"] = new Date().toISOString();
    schedulerState[kind === "scan" ? "lastScanResult" : "lastMonitorResult"] = result?.status || "ok";
    schedulerState.lastError = null;
  } catch (error) {
    schedulerState.lastError = `${kind}: ${error.message}`;
    console.error("scheduler", kind, error);
  } finally { schedulerState[key] = false; }
}
async function discoverEgressIp() {
  try {
    const response = await fetch("https://api4.ipify.org?format=json");
    const data = await response.json();
    schedulerState.egressIpv4 = data.ip || null;
  } catch (error) { console.warn("egress IP discovery failed", error.message); }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          keys_configured: {
            upbit: Boolean(UPBIT_ACCESS_KEY && UPBIT_SECRET_KEY),
            binance: Boolean(BINANCE_API_KEY && BINANCE_SECRET_KEY),
          },
          scheduler_enabled: SCHEDULER_ENABLED,
          scheduler: schedulerState,
          intervals: { scan_seconds: SCAN_INTERVAL_MS / 1000, monitor_seconds: MONITOR_INTERVAL_MS / 1000 },
          limits: {
            upbit: { max_order_krw: UPBIT_MAX_ORDER_KRW, max_daily_buy_krw: UPBIT_MAX_DAILY_BUY_KRW },
            binance: { max_order_usdt: BINANCE_MAX_ORDER_USDT, max_daily_buy_usdt: BINANCE_MAX_DAILY_BUY_USDT },
          },
        });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/command") return sendJson(res, 404, { error: "not found" });
      const raw = await readBody(req);
      const verification = verifyGatewayRequest(req, raw);
      if (!verification.ok) return sendJson(res, verification.status, { error: verification.error });
      const result = await handleCommand(raw ? JSON.parse(raw) : {});
      return sendJson(res, 200, { ok: true, result, version: VERSION });
    } catch (error) {
      console.error("gateway request failed", error);
      return sendJson(res, Number(error.status) || 400, { ok: false, error: error.message, code: error.code || "GATEWAY_ERROR" });
    }
  });
}
export async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`Trading-booooo multi-exchange gateway v${VERSION} listening on ${PORT}`);
  await discoverEgressIp();
  if (BINANCE_API_KEY && BINANCE_SECRET_KEY) syncBinanceTime(true).catch((error) => console.warn("Binance time sync failed", error.message));
  if (SCHEDULER_ENABLED) {
    setTimeout(() => schedulerTick("monitor"), 5_000).unref();
    setTimeout(() => schedulerTick("scan"), 20_000).unref();
    setInterval(() => schedulerTick("monitor"), MONITOR_INTERVAL_MS).unref();
    setInterval(() => schedulerTick("scan"), SCAN_INTERVAL_MS).unref();
    setInterval(discoverEgressIp, 6 * 60 * 60 * 1000).unref();
    setInterval(() => syncBinanceTime(true).catch(() => null), 30 * 60_000).unref();
  }
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer().catch((error) => { console.error(error); process.exit(1); });

export {
  binanceQueryString,
  buildUpbitPortfolio,
  contextualizeError,
  createBinanceSignature,
  createUpbitJwt,
  floorStep,
  upbitRateGroup,
  localRateLimit,
  normalizeBinanceOrder,
  normalizeUpbitOrder,
  rawQueryString,
  encodedQueryString,
  validateBinanceSymbol,
  validateIdentifier,
  validateUpbitMarket,
  validateExchange,
};
