// Trading-booooo v5.1.0 — autonomous Upbit KRW + Binance USDT spot orchestrator.
// Private service-role function. No withdrawal, transfer, margin, futures, leverage, or market-buy routes exist.

import {
  adjustedPlanForFill,
  baseAsset,
  calculatePositionSize,
  clamp,
  decideExit,
  evaluateCircuit,
  finite,
  floorToStep,
  nextTrailingStop,
  normalizedOrderState,
  quoteCurrency,
  t1SellQuantity,
  type Exchange,
  type TradingMode,
  type TradingSettings,
} from "./core.ts";

const VERSION = "5.1.0";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const GATEWAY_URL = env("ORDER_GATEWAY_URL").replace(/\/$/, "");
const GATEWAY_SECRET = env("GATEWAY_SHARED_SECRET");
const DEFAULT_MODE = parseMode(env("TRADING_MODE_DEFAULT") || "PAPER");
const MAX_SCAN_SECONDS = 280;
const LIVE_MAX_SPREAD_BPS = clamp(finite(env("LIVE_MAX_SPREAD_BPS"), 25), 5, 50);
const LIVE_MIN_DEPTH_BUFFER = clamp(finite(env("LIVE_MIN_DEPTH_BUFFER"), 1.2), 1, 3);
const FEE_PCT: Record<Exchange, number> = {
  upbit: clamp(finite(env("UPBIT_FEE_PER_SIDE_PCT"), 0.05), 0, 0.5),
  binance: clamp(finite(env("BINANCE_FEE_PER_SIDE_PCT"), 0.1), 0, 0.5),
};

type JsonRecord = Record<string, any>;
type CycleKind = "SCAN" | "MONITOR" | "BOOTSTRAP" | "CONTROL";

type Candidate = JsonRecord & {
  id: string;
  scan_id: string;
  exchange: Exchange;
  quote_currency: "KRW" | "USDT";
  market: string;
  created_at: string;
  decision: string;
  score: number;
  period_score: number;
  entry_low: number;
  entry_high: number;
  stop_price: number;
  target_1: number;
  target_2: number | null;
  net_rr: number;
  intended_horizon_hours: number;
  recommendation_valid_until: string | null;
  active_policy_key: string;
  profile_version: number;
  feature_vector: JsonRecord;
  snapshot: JsonRecord;
};

type Position = JsonRecord & {
  id: string;
  exchange: Exchange;
  quote_currency: "KRW" | "USDT";
  market: string;
  base_asset: string;
  state: "ENTRY_PENDING" | "OPEN" | "EXITING" | "CLOSED" | "CANCELLED" | "ERROR";
  is_paper: boolean;
  initial_quantity: number;
  remaining_quantity: number;
  average_entry_price: number;
  planned_entry_price: number;
  stop_price: number;
  target_1: number;
  target_2: number | null;
  tick_size: number;
  quantity_step: number | null;
  min_notional_quote: number | null;
  t1_allocation_pct: number;
  t1_completed: boolean;
  peak_price: number | null;
  trailing_stop: number | null;
  trailing_distance_pct: number | null;
  max_holding_at: string;
  realized_proceeds_quote: number;
  realized_cost_quote: number;
  paid_fees_quote: number;
  realized_pnl_quote: number;
};

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function parseMode(value: string): TradingMode {
  const mode = String(value).toUpperCase();
  return mode === "LIVE_LIMITED" ? "LIVE_LIMITED" : mode === "PAUSED" ? "PAUSED" : "PAPER";
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length); let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
function authorized(request: Request): boolean {
  const provided = (request.headers.get("x-autotrade-token") || "").trim();
  return AUTOTRADE_TOKEN.length >= 32 && provided.length > 0 && safeEqual(AUTOTRADE_TOKEN, provided);
}
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function requiredConfiguration() {
  const missing: string[] = [];
  for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, AUTOTRADE_ACCESS_TOKEN: AUTOTRADE_TOKEN, ORDER_GATEWAY_URL: GATEWAY_URL, GATEWAY_SHARED_SECRET: GATEWAY_SECRET })) if (!value) missing.push(name);
  if (missing.length) throw new Error(`missing configuration: ${missing.join(", ")}`);
}
function dbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...extra };
}
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...dbHeaders(), ...(init.headers || {}) } });
  const text = await res.text(); let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`database ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
async function rpc(name: string, body: JsonRecord): Promise<any> { return db(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) }); }
async function patch(table: string, filter: string, values: JsonRecord): Promise<any[]> {
  return db(`${table}?${filter}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }) });
}
async function insert(table: string, values: JsonRecord | JsonRecord[]): Promise<any[]> {
  return db(table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(values) });
}
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function gateway(exchange: Exchange, command: JsonRecord, timeoutMs = 15_000): Promise<any> {
  const raw = JSON.stringify({ exchange, ...command });
  const ts = String(Date.now()); const nonce = crypto.randomUUID();
  const signature = await hmacHex(GATEWAY_SECRET, `${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/command`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-gateway-ts": ts, "x-gateway-nonce": nonce, "x-gateway-signature": signature }, body: raw,
    });
    const text = await res.text(); let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok || !data?.ok) throw new Error(`gateway ${res.status}: ${data?.error || text}`);
    return data.result;
  } finally { clearTimeout(timer); }
}

function defaultSettings(): TradingSettings & JsonRecord {
  return {
    id: 1, configured: true, mode: DEFAULT_MODE, pause_new_entries: false, emergency_liquidation: false,
    upbit_enabled: true, binance_enabled: true,
    max_open_positions: 4, max_open_positions_per_exchange: 2,
    max_daily_entries: 8, max_daily_entries_per_exchange: 4,
    max_position_pct: 5, risk_per_trade_pct: 0.5,
    max_order_krw: clamp(finite(env("UPBIT_MAX_ORDER_KRW") || env("MAX_ORDER_KRW"), 100_000), 5_000, 1_000_000_000),
    min_order_krw: 5_000,
    max_daily_buy_krw: clamp(finite(env("UPBIT_MAX_DAILY_BUY_KRW"), 300_000), 5_000, 10_000_000_000),
    max_order_usdt: clamp(finite(env("BINANCE_MAX_ORDER_USDT"), 100), 5, 10_000_000),
    min_order_usdt: clamp(finite(env("BINANCE_MIN_ORDER_USDT"), 10), 5, 1000),
    max_daily_buy_usdt: clamp(finite(env("BINANCE_MAX_DAILY_BUY_USDT"), 300), 5, 100_000_000),
    max_daily_loss_pct: 1.5, max_weekly_loss_pct: 3, max_consecutive_losses: 3,
    entry_ttl_seconds: 180,
    full_scan_interval_seconds: clamp(finite(env("AUTO_SCAN_INTERVAL_SECONDS"), 300), 300, 3600),
    monitor_interval_seconds: clamp(finite(env("AUTO_MONITOR_INTERVAL_SECONDS"), 15), 10, 300),
    max_new_entries_per_scan: 2, suppress_cross_exchange_same_asset: true,
    updated_at: new Date().toISOString(),
  };
}
async function loadSettings(): Promise<TradingSettings & JsonRecord> {
  const rows = await db("trading_settings?id=eq.1&select=*");
  if (rows?.[0]) return rows[0];
  return (await insert("trading_settings", defaultSettings()))[0];
}
async function ensureConfigured(settings: TradingSettings & JsonRecord, syncMode = false) {
  if (settings.configured && !syncMode) return settings;
  return (await patch("trading_settings", "id=eq.1", { configured: true, ...(syncMode || !settings.configured ? { mode: DEFAULT_MODE } : {}), version: finite(settings.version) + 1 }))[0] || settings;
}
async function beginCycle(kind: CycleKind, mode?: string): Promise<string> { return (await insert("trading_cycle_runs", { kind, mode: mode || null, status: "RUNNING" }))[0].id; }
async function finishCycle(id: string, status: "SUCCESS" | "SKIPPED" | "FAILED", summary: JsonRecord, error?: string) {
  await db(`trading_cycle_runs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status, summary, error: error || null, finished_at: new Date().toISOString() }) });
}
async function event(code: string, message: string, details: JsonRecord = {}, refs: { cycleId?: string; positionId?: string; orderId?: string; level?: string } = {}) {
  await db("trading_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ cycle_id: refs.cycleId || null, position_id: refs.positionId || null, order_id: refs.orderId || null, level: refs.level || "INFO", code, message, details }) }).catch(() => null);
}
async function withLease<T>(name: string, seconds: number, work: () => Promise<T>): Promise<T | null> {
  const owner = crypto.randomUUID();
  if (await rpc("acquire_trading_lease", { p_name: name, p_owner: owner, p_seconds: seconds }) !== true) return null;
  try { return await work(); } finally { await rpc("release_trading_lease", { p_name: name, p_owner: owner }).catch(() => null); }
}

function dayBoundary(exchange: Exchange, daysAgo = 0): string {
  const offset = exchange === "upbit" ? 9 : 0;
  const date = new Date(Date.now() + offset * 3600_000); date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - offset * 3600_000 - daysAgo * 86400_000).toISOString();
}
function weekBoundary(exchange: Exchange): string {
  const offset = exchange === "upbit" ? 9 : 0;
  const date = new Date(Date.now() + offset * 3600_000); const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1); date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - offset * 3600_000).toISOString();
}
async function accountStats(exchange: Exchange, equityQuote: number) {
  const [activeGlobal, activeExchange, todayGlobal, todayExchange, dailyBuyOrders, dailyClosed, weeklyClosed, recentClosed] = await Promise.all([
    db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id,exchange,market,base_asset"),
    db(`trading_positions?exchange=eq.${exchange}&state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id,market,base_asset`),
    db(`trading_positions?created_at=gte.${encodeURIComponent(dayBoundary("upbit"))}&state=neq.CANCELLED&select=id`),
    db(`trading_positions?exchange=eq.${exchange}&created_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=neq.CANCELLED&select=id`),
    db(`trading_orders?exchange=eq.${exchange}&side=eq.BUY&requested_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=in.(APPLIED,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED)&select=executed_funds_quote`),
    db(`trading_positions?exchange=eq.${exchange}&closed_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=eq.CLOSED&select=realized_pnl_quote`),
    db(`trading_positions?exchange=eq.${exchange}&closed_at=gte.${encodeURIComponent(weekBoundary(exchange))}&state=eq.CLOSED&select=realized_pnl_quote`),
    db(`trading_positions?exchange=eq.${exchange}&state=eq.CLOSED&select=realized_pnl_quote&order=closed_at.desc&limit=20`),
  ]);
  const dailyBoughtQuote = (dailyBuyOrders || []).reduce((sum: number, row: any) => sum + finite(row.executed_funds_quote), 0);
  const daily = (dailyClosed || []).reduce((sum: number, row: any) => sum + finite(row.realized_pnl_quote), 0);
  const weekly = (weeklyClosed || []).reduce((sum: number, row: any) => sum + finite(row.realized_pnl_quote), 0);
  let consecutiveLosses = 0;
  for (const row of recentClosed || []) { if (finite(row.realized_pnl_quote) < 0) consecutiveLosses++; else break; }
  return {
    activeGlobal, activeExchange,
    openGlobal: activeGlobal.length, openExchange: activeExchange.length,
    entriesTodayGlobal: todayGlobal.length, entriesTodayExchange: todayExchange.length,
    dailyBoughtQuote,
    dailyPnlQuote: daily, weeklyPnlQuote: weekly,
    dailyPnlPct: equityQuote > 0 ? daily / equityQuote * 100 : 0,
    weeklyPnlPct: equityQuote > 0 ? weekly / equityQuote * 100 : 0,
    consecutiveLosses,
  };
}

async function runScanner(portfolios: Record<Exchange, any>, settings: TradingSettings): Promise<any> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), MAX_SCAN_SECONDS * 1000);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/market-scanner`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-autotrade-token": AUTOTRADE_TOKEN },
      body: JSON.stringify({
        action: "scan", exchange: "combined", operator_mode: "AUTOMATED", automation: true,
        capital_krw: Math.max(10_000, finite(portfolios.upbit?.available_quote, 10_000)),
        capital_usdt: Math.max(10, finite(portfolios.binance?.available_quote, 10)),
        risk_pct: settings.risk_per_trade_pct,
        recommendation_valid_minutes: Math.max(1, Math.ceil(settings.entry_ttl_seconds / 60)),
        min_actionable_holding_hours: 1, max_unattended_hours: 24, require_precommitted_exit: true,
      }),
    });
    const text = await res.text(); let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`scanner ${res.status}: ${data?.error || text}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function loadBuyCandidates(scanId: string): Promise<Candidate[]> {
  return db(`scanner_candidates?scan_id=eq.${scanId}&decision=eq.BUY&exchange=in.(upbit,binance)&select=*&order=score.desc,period_score.desc`);
}
function tickRound(value: number, tick: number, direction: "down" | "up" | "nearest" = "nearest") {
  const t = tick > 0 ? tick : Math.max(0.00000001, value * 0.000001); const units = value / t;
  return (direction === "down" ? Math.floor(units) : direction === "up" ? Math.ceil(units) : Math.round(units)) * t;
}
function executableDepth(asks: any[], maxEntry: number, requestedNotional: number) {
  let availableFunds = 0; let executionFunds = 0; let volume = 0; let worstPrice = 0;
  for (const unit of Array.isArray(asks) ? asks : []) {
    const price = finite(unit?.price); const size = finite(unit?.size);
    if (!(price > 0 && size > 0) || price > maxEntry) continue;
    const capacity = price * size; availableFunds += capacity;
    const take = Math.min(capacity, Math.max(0, requestedNotional - executionFunds));
    if (take > 0) { executionFunds += take; volume += take / price; worstPrice = price; }
  }
  return { executable: executionFunds + 1e-8 >= requestedNotional, availableFunds, executionFunds, volume, vwap: volume > 0 ? executionFunds / volume : 0, worstPrice };
}
function candidatePlan(candidate: Candidate) {
  const trade = candidate.snapshot?.trade_plan || {}; const tick = finite(trade.tick_size, finite(candidate.feature_vector?.tick_size));
  const allocation = clamp(finite(trade.first_target_allocation_pct, 60), 50, 80); const strategy = String(trade.target_strategy || "SCALE_OUT");
  return {
    tick, allocation,
    exitPolicy: strategy === "TRAIL_AFTER_T1" ? "TRAIL_AFTER_T1" : strategy === "SHORT_ONLY" ? "FIXED_T1" : "SCALE_OUT",
    recommended: finite(trade.recommended_investment_quote, finite(trade.recommended_investment_krw)),
    trailingDistancePct: clamp(finite(candidate.feature_vector?.risk_snapshot?.trailing_distance_pct, 1.2), 0.5, 5),
  };
}
async function marketQuote(exchange: Exchange, market: string) { return gateway(exchange, { action: "quote", market }); }
function uniqueId(prefix: string, id: string) {
  const compact = id.replaceAll("-", "").slice(0, 12); const suffix = Date.now().toString(36).slice(-8);
  return `tb-${prefix}-${compact}-${suffix}`.slice(0, 36);
}
async function createOrderRecord(values: JsonRecord) { return (await insert("trading_orders", values))[0]; }
function feeQuoteEstimate(exchange: Exchange, order: any, fill: any): number {
  const quote = quoteCurrency(exchange); const feeAsset = String(fill?.feeAsset || order?.fee_asset || "").toUpperCase();
  const paid = finite(fill?.paidFee, finite(order?.paid_fee));
  if (feeAsset === quote) return paid;
  return finite(fill?.executedFunds, finite(order?.executed_funds)) * FEE_PCT[exchange] / 100;
}
async function storeFills(orderRow: any, normalized: any) {
  const trades = Array.isArray(normalized?.trades) ? normalized.trades : [];
  if (!trades.length) return;
  const quote = orderRow.quote_currency;
  const rows = trades.map((trade: any, index: number) => ({
    order_id: orderRow.id, trade_id: trade.trade_id || `${orderRow.id}-${index}`,
    price: finite(trade.price), volume: finite(trade.volume), funds_quote: finite(trade.funds, finite(trade.price) * finite(trade.volume)),
    fee_amount: finite(trade.fee), fee_asset: trade.fee_asset || null,
    fee_quote_estimate: String(trade.fee_asset || "").toUpperCase() === quote ? finite(trade.fee) : finite(trade.funds) * FEE_PCT[orderRow.exchange as Exchange] / 100,
    executed_at: trade.executed_at || null, raw: trade.raw || trade,
  }));
  await db("trading_fills?on_conflict=order_id,trade_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
}
async function updateOrderFromGateway(orderRow: any, payload: any) {
  const order = payload?.order || payload; const fill = payload?.fill || {
    executedVolume: finite(order?.executed_volume), executedFunds: finite(order?.executed_funds), averagePrice: finite(order?.average_price), paidFee: finite(order?.paid_fee), feeAsset: order?.fee_asset,
  };
  const feeQuote = feeQuoteEstimate(orderRow.exchange, order, fill);
  const rows = await patch("trading_orders", `id=eq.${orderRow.id}`, {
    exchange_order_id: order?.exchange_order_id || null,
    state: normalizedOrderState(orderRow.state, order?.status),
    executed_volume: finite(fill.executedVolume), average_fill_price: finite(fill.averagePrice) || null,
    executed_funds_quote: finite(fill.executedFunds), paid_fee_quote: feeQuote, fee_asset: fill.feeAsset || order?.fee_asset || null,
    completed_at: ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(order?.status)) ? new Date().toISOString() : null,
    raw_response: order || {},
  });
  await storeFills(orderRow, order);
  return { row: rows[0] || orderRow, order, fill: { ...fill, paidFeeQuote: feeQuote } };
}
async function applyEntryAccounting(position: Position, orderRow: any, fill: any) {
  const quantity = finite(fill.executedVolume); const price = finite(fill.averagePrice);
  if (!(quantity > 0 && price > 0)) throw new Error("entry fill has no executable quantity");
  const adjusted = adjustedPlanForFill(position.planned_entry_price, price, position.stop_price, position.target_1, position.target_2);
  const result = await rpc("apply_trading_entry_order", {
    p_order_id: orderRow.id, p_fill_price: price, p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity), p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_stop_price: tickRound(adjusted.stopPrice, position.tick_size, "down"),
    p_target_1: tickRound(adjusted.target1, position.tick_size, "up"),
    p_target_2: adjusted.target2 ? tickRound(adjusted.target2, position.tick_size, "up") : null,
  });
  return result?.position || position;
}
async function applyExitAccounting(position: Position, orderRow: any, fill: any, action: string, fallbackPrice: number) {
  const quantity = finite(fill.executedVolume); const price = finite(fill.averagePrice, fallbackPrice);
  if (!(quantity > 0 && price > 0)) throw new Error("exit fill has no executable quantity");
  const nextTrail = action === "TARGET_1" && position.exit_policy === "TRAIL_AFTER_T1"
    ? nextTrailingStop(position.trailing_stop, Math.max(price, finite(position.peak_price, position.average_entry_price)), finite(position.trailing_distance_pct, 1.2), position.stop_price)
    : null;
  const result = await rpc("apply_trading_exit_order", {
    p_order_id: orderRow.id, p_action: action, p_fill_price: price, p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity), p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_trailing_stop: nextTrail, p_dust_value_quote: position.exchange === "upbit" ? 1000 : 1,
  });
  return { applied: Boolean(result?.applied), closed: Boolean(result?.closed), position: result?.position || position, fillPrice: price, quantity };
}

function exchangeLimits(settings: TradingSettings, exchange: Exchange) {
  return exchange === "upbit"
    ? { maxOrder: settings.max_order_krw, minOrder: settings.min_order_krw, quoteStep: 1000, dailyBuy: settings.max_daily_buy_krw }
    : { maxOrder: settings.max_order_usdt, minOrder: settings.min_order_usdt, quoteStep: 0.01, dailyBuy: settings.max_daily_buy_usdt };
}
function accountQuantity(portfolio: any, asset: string, freeOnly = false): number {
  const row = (Array.isArray(portfolio?.accounts) ? portfolio.accounts : []).find((item: any) => String(item.currency || item.asset).toUpperCase() === asset.toUpperCase());
  return Math.max(0, finite(row?.balance ?? row?.free) + (freeOnly ? 0 : finite(row?.locked)));
}
async function symbolRules(exchange: Exchange, candidate: Candidate, plan: any) {
  if (exchange === "upbit") return { price_tick: plan.tick || Math.max(0.00000001, candidate.entry_high * 0.000001), quantity_step: 0.00000001, min_notional: 5000 };
  const info = await gateway(exchange, { action: "symbol_info", market: candidate.market });
  return { price_tick: finite(info.price_tick), quantity_step: finite(info.quantity_step || info.step_size), min_notional: finite(info.min_notional, 10) };
}
async function openPaperPosition(position: Position, candidate: Candidate, price: number, quantity: number, notional: number) {
  const fee = notional * FEE_PCT[position.exchange] / 100;
  const order = await createOrderRecord({
    position_id: position.id, candidate_id: candidate.id, exchange: position.exchange, quote_currency: position.quote_currency,
    identifier: uniqueId("pe", position.id), market: position.market, side: "BUY", purpose: "ENTRY",
    order_type: "paper_limit_ioc", time_in_force: "IOC", requested_price: price, requested_volume: quantity,
    requested_notional_quote: notional, state: "EXCHANGE_DONE", executed_volume: quantity, average_fill_price: price,
    executed_funds_quote: notional, paid_fee_quote: fee, fee_asset: position.quote_currency, completed_at: new Date().toISOString(), raw_response: { paper: true },
  });
  await insert("trading_fills", { order_id: order.id, trade_id: `paper-${order.id}`, price, volume: quantity, funds_quote: notional, fee_amount: fee, fee_asset: position.quote_currency, fee_quote_estimate: fee, executed_at: new Date().toISOString(), raw: { paper: true } });
  return applyEntryAccounting(position, order, { executedVolume: quantity, executedFunds: notional, averagePrice: price, paidFeeQuote: fee });
}

async function enterCandidate(candidate: Candidate, settings: TradingSettings, portfolio: any, activeBases: Set<string>, cycleId: string) {
  const exchange = candidate.exchange; const quote = quoteCurrency(exchange); const base = baseAsset(exchange, candidate.market);
  if (candidate.recommendation_valid_until && Date.now() > new Date(candidate.recommendation_valid_until).getTime()) return { entered: false, exchange, market: candidate.market, reason: "recommendation expired" };
  const existing = await db(`trading_positions?exchange=eq.${exchange}&market=eq.${candidate.market}&state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id&limit=1`);
  if (existing.length) return { entered: false, exchange, market: candidate.market, reason: "market already tracked" };
  if (settings.suppress_cross_exchange_same_asset && activeBases.has(base)) return { entered: false, exchange, market: candidate.market, reason: `base asset ${base} already exposed on another market` };

  const market = await marketQuote(exchange, candidate.market);
  const bestAsk = finite(market.best_ask); const bestBid = finite(market.best_bid);
  if (!(bestAsk > 0 && bestBid > 0)) return { entered: false, exchange, market: candidate.market, reason: "empty orderbook" };
  if (accountQuantity(portfolio, base) * Math.max(finite(market.current), bestBid) >= (exchange === "upbit" ? 1000 : 1)) {
    return { entered: false, exchange, market: candidate.market, reason: "pre-existing account balance detected; manual and bot holdings are isolated" };
  }
  const maxEntry = finite(candidate.entry_high);
  if (!(maxEntry > 0) || bestAsk > maxEntry) return { entered: false, exchange, market: candidate.market, reason: `best ask ${bestAsk} above entry ceiling ${maxEntry}` };
  const spreadBps = (bestAsk / bestBid - 1) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > LIVE_MAX_SPREAD_BPS) return { entered: false, exchange, market: candidate.market, reason: `spread ${spreadBps.toFixed(1)}bp exceeds ${LIVE_MAX_SPREAD_BPS}bp` };

  const plan = candidatePlan(candidate); const rules = await symbolRules(exchange, candidate, plan); const limits = exchangeLimits(settings, exchange);
  const maxOrder = Math.min(limits.maxOrder, plan.recommended > 0 ? plan.recommended : limits.maxOrder);
  const initial = calculatePositionSize({
    equityQuote: finite(portfolio.total_equity_quote), availableQuote: finite(portfolio.available_quote), entryPrice: bestAsk, stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct, riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder, minOrderQuote: Math.max(limits.minOrder, rules.min_notional), quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!initial.allowed) return { entered: false, exchange, market: candidate.market, reason: initial.reason };
  let depth = executableDepth(market.asks, maxEntry, initial.notionalQuote);
  if (!depth.executable || depth.availableFunds < initial.notionalQuote * LIVE_MIN_DEPTH_BUFFER) return { entered: false, exchange, market: candidate.market, reason: `insufficient ask depth (${depth.availableFunds.toFixed(exchange === "upbit" ? 0 : 2)} ${quote})` };
  const entryPrice = tickRound(Math.min(maxEntry, depth.worstPrice), rules.price_tick, "down");
  const sizing = calculatePositionSize({
    equityQuote: finite(portfolio.total_equity_quote), availableQuote: finite(portfolio.available_quote), entryPrice, stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct, riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder, minOrderQuote: Math.max(limits.minOrder, rules.min_notional), quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!sizing.allowed) return { entered: false, exchange, market: candidate.market, reason: sizing.reason };
  depth = executableDepth(market.asks, maxEntry, sizing.notionalQuote);
  if (!depth.executable || depth.availableFunds < sizing.notionalQuote * LIVE_MIN_DEPTH_BUFFER) return { entered: false, exchange, market: candidate.market, reason: "depth deteriorated during sizing" };
  const quantity = floorToStep(sizing.notionalQuote / entryPrice, rules.quantity_step || 0.00000001);
  if (!(quantity > 0) || quantity * entryPrice < Math.max(limits.minOrder, rules.min_notional)) return { entered: false, exchange, market: candidate.market, reason: "quantity below exchange minimum" };

  const maxHolding = new Date(Date.now() + clamp(finite(candidate.intended_horizon_hours, 24), 1, 480) * 3600_000).toISOString();
  const position = (await insert("trading_positions", {
    candidate_id: candidate.id, scan_id: candidate.scan_id, exchange, quote_currency: quote, market: candidate.market, base_asset: base,
    state: "ENTRY_PENDING", is_paper: settings.mode !== "LIVE_LIMITED", profile_version: candidate.profile_version || 0,
    planned_entry_price: entryPrice, stop_price: candidate.stop_price, target_1: candidate.target_1, target_2: candidate.target_2,
    tick_size: rules.price_tick, quantity_step: rules.quantity_step, min_notional_quote: Math.max(limits.minOrder, rules.min_notional),
    t1_allocation_pct: plan.allocation, exit_policy: plan.exitPolicy, trailing_distance_pct: plan.trailingDistancePct,
    intended_horizon_hours: candidate.intended_horizon_hours, max_holding_at: maxHolding,
    metadata: { cycle_id: cycleId, sizing, quote_at_entry: market, execution_depth: depth, live_spread_bps: spreadBps, engine_version: VERSION },
  }))[0] as Position;

  if (settings.mode !== "LIVE_LIMITED") {
    const paperPrice = depth.vwap > 0 ? depth.vwap : entryPrice; const paperQty = floorToStep(sizing.notionalQuote / paperPrice, rules.quantity_step || 0.00000001);
    const opened = await openPaperPosition(position, candidate, paperPrice, paperQty, paperQty * paperPrice);
    await event("PAPER_ENTRY", `${exchange}:${candidate.market} paper entry`, { price: paperPrice, quantity: paperQty, notional_quote: paperQty * paperPrice, quote }, { cycleId, positionId: position.id });
    return { entered: true, paper: true, exchange, market: candidate.market, position: opened };
  }

  const testIdentifier = uniqueId("t", position.id);
  await gateway(exchange, { action: "order_test", order: { market: candidate.market, side: "BUY", type: "LIMIT", price: entryPrice, quantity, time_in_force: "IOC", identifier: testIdentifier } });
  const identifier = uniqueId("e", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id, candidate_id: candidate.id, cycle_id: cycleId, exchange, quote_currency: quote,
    identifier, market: candidate.market, side: "BUY", purpose: "ENTRY", order_type: "LIMIT", time_in_force: "IOC",
    requested_price: entryPrice, requested_volume: quantity, requested_notional_quote: quantity * entryPrice, state: "REQUESTED",
  });
  try {
    const result = await gateway(exchange, { action: "create_order", order: { market: candidate.market, side: "BUY", type: "LIMIT", price: entryPrice, quantity, time_in_force: "IOC", identifier }, wait_for_final_ms: 4000 }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, result);
    if (!(finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0)) {
      if (["OPEN", "PARTIALLY_FILLED"].includes(String(updated.order?.status))) return { entered: false, reserved: true, pending_reconcile: true, exchange, market: candidate.market, reason: "entry order still reconciling" };
      await patch("trading_positions", `id=eq.${position.id}`, { state: "CANCELLED", close_reason: "ENTRY_NOT_FILLED", closed_at: new Date().toISOString() });
      return { entered: false, exchange, market: candidate.market, reason: "IOC entry not filled" };
    }
    const opened = await applyEntryAccounting(position, orderRow, updated.fill);
    await event("LIVE_ENTRY", `${exchange}:${candidate.market} live entry`, { fill_price: updated.fill.averagePrice, quantity: updated.fill.executedVolume }, { cycleId, positionId: position.id, orderId: orderRow.id });
    return { entered: true, paper: false, exchange, market: candidate.market, position: opened };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "UNKNOWN", error_message: message });
    await event("ENTRY_RESULT_UNKNOWN", `${exchange}:${candidate.market} entry requires reconciliation`, { identifier, error: message }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" });
    return { entered: false, reserved: true, pending_reconcile: true, exchange, market: candidate.market, reason: "entry result unknown; duplicate suppressed" };
  }
}

async function snapshotAccount(exchange: Exchange, portfolio: any, positions: Position[], prices: Record<string, number>) {
  let openCost = 0; let unrealized = 0;
  for (const position of positions.filter((row) => row.exchange === exchange)) {
    const qty = finite(position.remaining_quantity); const entry = finite(position.average_entry_price); const current = finite(prices[position.market], entry);
    openCost += qty * entry; unrealized += qty * (current - entry);
  }
  await db("trading_account_snapshots", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    exchange, quote_currency: quoteCurrency(exchange), total_equity_quote: finite(portfolio.total_equity_quote), available_quote: finite(portfolio.available_quote), locked_quote: finite(portfolio.locked_quote),
    bot_open_cost_quote: openCost, bot_unrealized_pnl_quote: unrealized, balances: portfolio.accounts || [], prices: { ...(portfolio.prices || {}), ...prices },
  }) });
}
async function sellPaper(position: Position, quantity: number, price: number, purpose: string, cycleId: string) {
  const qty = Math.min(position.remaining_quantity, quantity); const funds = qty * price; const fee = funds * FEE_PCT[position.exchange] / 100;
  const order = await createOrderRecord({
    position_id: position.id, candidate_id: position.candidate_id, cycle_id: cycleId, exchange: position.exchange, quote_currency: position.quote_currency,
    identifier: uniqueId("px", position.id), market: position.market, side: "SELL", purpose, order_type: "PAPER_MARKET",
    requested_volume: qty, state: "EXCHANGE_DONE", executed_volume: qty, average_fill_price: price, executed_funds_quote: funds,
    paid_fee_quote: fee, fee_asset: position.quote_currency, completed_at: new Date().toISOString(), raw_response: { paper: true },
  });
  await insert("trading_fills", { order_id: order.id, trade_id: `paper-${order.id}`, price, volume: qty, funds_quote: funds, fee_amount: fee, fee_asset: position.quote_currency, fee_quote_estimate: fee, executed_at: new Date().toISOString(), raw: { paper: true } });
  return { orderRow: order, fill: { executedVolume: qty, executedFunds: funds, averagePrice: price, paidFeeQuote: fee }, order: { status: "FILLED" } };
}
async function sellLive(position: Position, quantity: number, purpose: string, cycleId: string) {
  const portfolio = await gateway(position.exchange, { action: "portfolio" });
  const available = accountQuantity(portfolio, position.base_asset, true);
  const step = finite(position.quantity_step, 0.00000001); const qty = floorToStep(Math.min(position.remaining_quantity, quantity, available), step);
  if (!(qty > 0)) throw new Error(`no available ${position.base_asset} balance for exit`);
  const identifier = uniqueId("x", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id, candidate_id: position.candidate_id, cycle_id: cycleId, exchange: position.exchange, quote_currency: position.quote_currency,
    identifier, market: position.market, side: "SELL", purpose, order_type: "MARKET", requested_volume: qty, state: "REQUESTED",
  });
  try {
    const result = await gateway(position.exchange, { action: "create_order", order: { market: position.market, side: "SELL", type: "MARKET", quantity: qty, identifier }, wait_for_final_ms: 4000 }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, result);
    if (finite(updated.fill.executedVolume) <= 0) throw new Error("market sell returned no fill");
    return { orderRow, ...updated };
  } catch (error) {
    await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "UNKNOWN", error_message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
async function finalizeExitFill(position: Position, result: any, action: string, fallbackPrice: number, cycleId: string) {
  const applied = await applyExitAccounting(position, result.orderRow, result.fill || {}, action, fallbackPrice); const updated = applied.position;
  await event(applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT", `${position.exchange}:${position.market} ${action}`, {
    price: applied.fillPrice, sold_quantity: applied.quantity, remaining: finite(updated?.remaining_quantity), pnl_quote: finite(updated?.realized_pnl_quote), quote: position.quote_currency, accounting_applied: applied.applied,
  }, { cycleId, positionId: position.id, orderId: result.orderRow.id });
  return { action, exchange: position.exchange, market: position.market, closed: applied.closed, position: updated };
}
async function applyExit(position: Position, price: number, action: string, cycleId: string) {
  let quantity = action === "TARGET_1" ? t1SellQuantity(position.initial_quantity, position.remaining_quantity, position.t1_allocation_pct) : finite(position.remaining_quantity);
  const minNotional = finite(position.min_notional_quote, position.exchange === "upbit" ? 5000 : 10);
  if (quantity * price < minNotional || (position.remaining_quantity - quantity) * price < minNotional) quantity = position.remaining_quantity;
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) return { action: "NONE", reason: "zero sell quantity" };
  if (!position.is_paper) position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, { state: "EXITING", metadata: { ...(position.metadata || {}), pending_exit_action: action, pending_exit_at: new Date().toISOString() } }))[0] };
  const result = position.is_paper ? await sellPaper(position, quantity, price, action, cycleId) : await sellLive(position, quantity, action, cycleId);
  return finalizeExitFill(position, result, action, price, cycleId);
}

async function reconcileEntryPending(position: Position, cycleId: string) {
  if (position.is_paper) return;
  const orderRow = (await db(`trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&select=*&order=created_at.desc&limit=1`))[0];
  if (!orderRow) return;
  try {
    const order = await gateway(position.exchange, { action: "get_order", identifier: orderRow.identifier, market: position.market });
    const updated = await updateOrderFromGateway(orderRow, order);
    if (finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0) await applyEntryAccounting(position, orderRow, updated.fill);
    else if (["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(updated.order?.status))) await patch("trading_positions", `id=eq.${position.id}`, { state: "CANCELLED", close_reason: "ENTRY_NOT_FILLED", closed_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const requested = new Date(orderRow.requested_at || orderRow.created_at || 0).getTime();
    if (Date.now() - requested > 120_000 && /not found|404|-2013|order/i.test(message)) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "NOT_FOUND", error_message: message, completed_at: new Date().toISOString() });
      await patch("trading_positions", `id=eq.${position.id}`, { state: "CANCELLED", close_reason: "ENTRY_ORDER_NOT_FOUND", closed_at: new Date().toISOString() });
    } else await event("ENTRY_RECONCILE_ERROR", message, { identifier: orderRow.identifier }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" });
  }
}
async function reconcileExitPending(position: Position, cycleId: string) {
  if (position.is_paper) { await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN" }); return; }
  const orderRow = (await db(`trading_orders?position_id=eq.${position.id}&side=eq.SELL&select=*&order=created_at.desc&limit=1`))[0];
  if (!orderRow) { await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN" }); return; }
  try {
    const order = await gateway(position.exchange, { action: "get_order", identifier: orderRow.identifier, market: position.market });
    const updated = await updateOrderFromGateway(orderRow, order);
    if (finite(updated.fill.executedVolume) > 0) await finalizeExitFill(position, { orderRow, ...updated }, String(orderRow.purpose || position.metadata?.pending_exit_action || "MANUAL_RECONCILE"), finite(updated.fill.averagePrice, position.average_entry_price), cycleId);
    else if (["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(updated.order?.status))) await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN", metadata: { ...(position.metadata || {}), pending_exit_action: null, pending_exit_at: null } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const requested = new Date(orderRow.requested_at || orderRow.created_at || 0).getTime();
    if (Date.now() - requested > 120_000 && /not found|404|-2013|order/i.test(message)) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "NOT_FOUND", error_message: message, completed_at: new Date().toISOString() });
      await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN", metadata: { ...(position.metadata || {}), pending_exit_action: null, pending_exit_at: null } });
    } else await event("EXIT_RECONCILE_ERROR", message, { identifier: orderRow.identifier }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" });
  }
}

async function monitorCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const tracked = await db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=*&order=created_at.asc") as Position[];
  for (const position of tracked.filter((p) => p.state === "ENTRY_PENDING")) await reconcileEntryPending(position, cycleId);
  for (const position of tracked.filter((p) => p.state === "EXITING")) await reconcileExitPending(position, cycleId);
  const open = await db("trading_positions?state=eq.OPEN&select=*&order=created_at.asc") as Position[];
  const actions: any[] = []; const prices: Record<string, number> = {}; const portfolios: Partial<Record<Exchange, any>> = {};
  for (const exchange of ["upbit", "binance"] as Exchange[]) {
    const exchangePositions = open.filter((p) => p.exchange === exchange);
    if (!exchangePositions.length) continue;
    const portfolio = await gateway(exchange, { action: "portfolio" }); portfolios[exchange] = portfolio;
    const availableByAsset = new Map<string, number>();
    for (const account of portfolio.accounts || []) availableByAsset.set(String(account.currency || "").toUpperCase(), Math.max(0, finite(account.balance) + finite(account.locked)));
    const trackedByAsset = new Map<string, number>();
    for (const position of exchangePositions.filter((p) => !p.is_paper)) trackedByAsset.set(position.base_asset, (trackedByAsset.get(position.base_asset) || 0) + position.remaining_quantity);
    const mismatches = new Set<string>();
    for (const [asset, quantity] of trackedByAsset) if ((availableByAsset.get(asset) || 0) + 1e-10 < quantity * 0.999999) mismatches.add(asset);
    if (mismatches.size) {
      await patch("trading_settings", "id=eq.1", { pause_new_entries: true });
      await event("ACCOUNT_POSITION_MISMATCH", `${exchange} account balance below bot ledger; entries paused`, { exchange, assets: [...mismatches] }, { cycleId, level: "CRITICAL" });
    }
    const quotes = await Promise.all(exchangePositions.map(async (position) => [position.market, await marketQuote(exchange, position.market)] as const));
    for (const [market, quote] of quotes) prices[market] = finite(quote.current, (finite(quote.best_ask) + finite(quote.best_bid)) / 2);
    for (const original of exchangePositions) {
      let position = original;
      if (!position.is_paper && mismatches.has(position.base_asset)) { actions.push({ exchange, market: position.market, action: "PAUSED", reason: "account mismatch" }); continue; }
      const current = prices[position.market]; if (!(current > 0)) continue;
      const peak = Math.max(current, finite(position.peak_price, position.average_entry_price)); const trough = Math.min(current, finite(position.trough_price, position.average_entry_price));
      const values: JsonRecord = { peak_price: peak, trough_price: trough };
      if (position.t1_completed && position.exit_policy === "TRAIL_AFTER_T1") values.trailing_stop = nextTrailingStop(position.trailing_stop, peak, finite(position.trailing_distance_pct, 1.2), position.stop_price);
      if (peak !== finite(position.peak_price) || trough !== finite(position.trough_price) || values.trailing_stop) position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0] };
      const decision = decideExit(position, current, Date.now(), settings.emergency_liquidation);
      if (decision.action === "NONE") continue;
      try { actions.push(await applyExit(position, current, decision.action, cycleId)); }
      catch (error) { actions.push({ exchange, market: position.market, action: decision.action, error: error instanceof Error ? error.message : String(error) }); await event("EXIT_ERROR", error instanceof Error ? error.message : String(error), { decision }, { cycleId, positionId: position.id, level: "CRITICAL" }); }
    }
  }
  const stillOpen = await db("trading_positions?state=eq.OPEN&select=*") as Position[];
  for (const exchange of Object.keys(portfolios) as Exchange[]) await snapshotAccount(exchange, portfolios[exchange], stillOpen, prices);
  await patch("trading_settings", "id=eq.1", { last_monitor_at: new Date().toISOString(), last_gateway_heartbeat_at: new Date().toISOString(), gateway_error_count: 0, ...(settings.emergency_liquidation && stillOpen.length === 0 ? { emergency_liquidation: false, pause_new_entries: true } : {}) });
  return { positions: open.length, actions };
}

async function scanCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const exchanges = (["upbit", "binance"] as Exchange[]).filter((exchange) => exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled);
  const portfolios = {} as Record<Exchange, any>;
  const stats = {} as Record<Exchange, any>;
  const circuits = {} as Record<Exchange, any>;
  for (const exchange of exchanges) {
    portfolios[exchange] = await gateway(exchange, { action: "portfolio" });
    stats[exchange] = await accountStats(exchange, finite(portfolios[exchange].total_equity_quote));
    const limits = exchangeLimits(settings, exchange);
    circuits[exchange] = evaluateCircuit({
      mode: settings.mode, configured: settings.configured, exchangeEnabled: true, pauseNewEntries: settings.pause_new_entries,
      emergencyLiquidation: settings.emergency_liquidation, availableQuote: finite(portfolios[exchange].available_quote), minOrderQuote: limits.minOrder,
      openPositionsGlobal: stats[exchange].openGlobal, openPositionsExchange: stats[exchange].openExchange,
      entriesTodayGlobal: stats[exchange].entriesTodayGlobal, entriesTodayExchange: stats[exchange].entriesTodayExchange,
      dailyBoughtQuote: stats[exchange].dailyBoughtQuote, maxDailyBuyQuote: limits.dailyBuy,
      dailyPnlPct: stats[exchange].dailyPnlPct, weeklyPnlPct: stats[exchange].weeklyPnlPct, consecutiveLosses: stats[exchange].consecutiveLosses, settings,
    });
  }
  if (!exchanges.some((exchange) => circuits[exchange].allowNewEntry)) {
    await event("ENTRY_CIRCUIT_BLOCK", "new entries blocked on all exchanges", { circuits, stats }, { cycleId, level: exchanges.some((x) => circuits[x].hardStop) ? "CRITICAL" : "WARNING" });
    await patch("trading_settings", "id=eq.1", { last_full_scan_at: new Date().toISOString(), last_gateway_heartbeat_at: new Date().toISOString() });
    return { skipped: true, circuits, stats };
  }
  const result = await runScanner(portfolios, settings); const scanId = String(result.scan_id || result.meta?.scan_id || "");
  if (!scanId) throw new Error("scanner response did not include scan_id");
  await db(`trading_cycle_runs?id=eq.${cycleId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ scan_id: scanId }) });
  const candidates = await loadBuyCandidates(scanId);
  const active = (await db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=exchange,market,base_asset")) as any[];
  const activeMarkets = new Set(active.map((row) => `${row.exchange}:${row.market}`)); const activeBases = new Set(active.map((row) => row.base_asset));
  const entries: any[] = []; const enteredPerExchange: Record<Exchange, number> = { upbit: 0, binance: 0 };
  for (const candidate of candidates) {
    const exchange = candidate.exchange;
    if (!exchanges.includes(exchange) || !circuits[exchange]?.allowNewEntry) continue;
    if (entries.filter((row) => row.entered || row.reserved).length >= settings.max_new_entries_per_scan) break;
    const exchangeCapacity = Math.min(
      settings.max_open_positions_per_exchange - stats[exchange].openExchange,
      settings.max_daily_entries_per_exchange - stats[exchange].entriesTodayExchange,
    );
    if (enteredPerExchange[exchange] >= Math.max(0, exchangeCapacity)) continue;
    if (activeMarkets.has(`${exchange}:${candidate.market}`)) continue;
    try {
      const entry = await enterCandidate(candidate, settings, portfolios[exchange], activeBases, cycleId); entries.push(entry);
      if (entry.entered || entry.reserved) {
        enteredPerExchange[exchange]++; activeMarkets.add(`${exchange}:${candidate.market}`); activeBases.add(baseAsset(exchange, candidate.market));
        if (entry.entered && !entry.paper) portfolios[exchange] = await gateway(exchange, { action: "portfolio" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); entries.push({ entered: false, exchange, market: candidate.market, error: message });
      await event("ENTRY_ERROR", message, { candidate_id: candidate.id, exchange }, { cycleId, level: "CRITICAL" });
    }
  }
  await patch("trading_settings", "id=eq.1", { last_full_scan_at: new Date().toISOString(), last_gateway_heartbeat_at: new Date().toISOString(), gateway_error_count: 0 });
  return { scan_id: scanId, buy_candidates: candidates.length, entries, circuits, stats };
}

async function status(settings: TradingSettings & JsonRecord) {
  const [positions, orders, cycles, snapshots] = await Promise.all([
    db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=*&order=created_at.desc"),
    db("trading_orders?select=*&order=created_at.desc&limit=30"),
    db("trading_cycle_runs?select=*&order=started_at.desc&limit=20"),
    db("trading_account_snapshots?select=*&order=captured_at.desc&limit=4"),
  ]);
  let health: any;
  try { const res = await fetch(`${GATEWAY_URL}/health`, { headers: { accept: "application/json" } }); health = await res.json(); }
  catch (error) { health = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  return { version: VERSION, settings, positions, recent_orders: orders, recent_cycles: cycles, latest_accounts: snapshots, gateway: health };
}
async function control(body: JsonRecord, settings: TradingSettings & JsonRecord) {
  const allowed: JsonRecord = {};
  if (body.mode != null) allowed.mode = parseMode(String(body.mode));
  for (const key of ["pause_new_entries", "emergency_liquidation", "upbit_enabled", "binance_enabled", "suppress_cross_exchange_same_asset"] as const) if (body[key] != null) allowed[key] = Boolean(body[key]);
  const ranges: Record<string, [number, number]> = {
    max_open_positions: [1, 20], max_open_positions_per_exchange: [1, 10], max_daily_entries: [1, 50], max_daily_entries_per_exchange: [1, 25],
    max_position_pct: [0.5, 25], risk_per_trade_pct: [0.05, 2],
    max_order_krw: [5000, 1_000_000_000], min_order_krw: [5000, 1_000_000], max_daily_buy_krw: [5000, 10_000_000_000],
    max_order_usdt: [5, 10_000_000], min_order_usdt: [5, 1000], max_daily_buy_usdt: [5, 100_000_000],
    max_daily_loss_pct: [0.2, 10], max_weekly_loss_pct: [0.5, 20], max_consecutive_losses: [1, 10],
    entry_ttl_seconds: [30, 900], full_scan_interval_seconds: [300, 3600], monitor_interval_seconds: [10, 300], max_new_entries_per_scan: [1, 4],
  };
  for (const [key, [low, high]] of Object.entries(ranges)) if (body[key] != null) allowed[key] = clamp(finite(body[key]), low, high);
  if (!Object.keys(allowed).length) return settings;
  allowed.version = finite(settings.version) + 1;
  return (await patch("trading_settings", "id=eq.1", allowed))[0];
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return response({ error: "POST only" }, 405);
  if (!authorized(request)) return response({ error: "unauthorized" }, 401);
  let cycleId = "";
  try {
    requiredConfiguration(); const body = await request.json().catch(() => ({})) as JsonRecord; const action = String(body.action || "status").toLowerCase();
    let settings = await loadSettings(); if (!settings.configured) settings = await ensureConfigured(settings);
    if (action === "status") return response({ ok: true, ...(await status(settings)) });
    const kind: CycleKind = action === "scan" ? "SCAN" : action === "monitor" ? "MONITOR" : action === "control" ? "CONTROL" : "BOOTSTRAP";
    cycleId = await beginCycle(kind, settings.mode);
    if (action === "bootstrap") {
      settings = await ensureConfigured(settings, Boolean(body.sync_mode));
      const portfolios: JsonRecord = {};
      for (const exchange of ["upbit", "binance"] as Exchange[]) {
        if (exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled) portfolios[exchange] = await gateway(exchange, { action: "portfolio" });
      }
      await patch("trading_settings", "id=eq.1", { last_gateway_heartbeat_at: new Date().toISOString(), gateway_error_count: 0 });
      const result = { settings, portfolios, gateway: await status(settings).then((row) => row.gateway) };
      await finishCycle(cycleId, "SUCCESS", result); return response({ ok: true, cycle_id: cycleId, ...result });
    }
    if (action === "control") { settings = await control(body, settings); await finishCycle(cycleId, "SUCCESS", { settings }); return response({ ok: true, cycle_id: cycleId, settings }); }
    if (action === "monitor") {
      const result = await withLease("autotrader-monitor", 90, () => monitorCycle(cycleId, settings));
      if (result == null) { await finishCycle(cycleId, "SKIPPED", { reason: "monitor lease busy" }); return response({ ok: true, status: "SKIPPED", reason: "monitor lease busy" }); }
      await finishCycle(cycleId, "SUCCESS", result); return response({ ok: true, status: "SUCCESS", cycle_id: cycleId, result });
    }
    if (action === "scan") {
      const result = await withLease("autotrader-scan", MAX_SCAN_SECONDS + 30, () => scanCycle(cycleId, settings));
      if (result == null) { await finishCycle(cycleId, "SKIPPED", { reason: "scan lease busy" }); return response({ ok: true, status: "SKIPPED", reason: "scan lease busy" }); }
      await finishCycle(cycleId, result.skipped ? "SKIPPED" : "SUCCESS", result); return response({ ok: true, status: result.skipped ? "SKIPPED" : "SUCCESS", cycle_id: cycleId, result });
    }
    await finishCycle(cycleId, "FAILED", {}, "unsupported action"); return response({ error: "unsupported action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cycleId) await finishCycle(cycleId, "FAILED", {}, message).catch(() => null);
    const current = await loadSettings().catch(() => ({ gateway_error_count: 0 })); const count = 1 + finite(current.gateway_error_count);
    await patch("trading_settings", "id=eq.1", { gateway_error_count: count, ...(count >= 3 ? { pause_new_entries: true } : {}) }).catch(() => null);
    console.error("market-autotrader failed", error); return response({ ok: false, error: message, version: VERSION }, 500);
  }
});
