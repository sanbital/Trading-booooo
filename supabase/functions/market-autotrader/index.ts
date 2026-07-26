// Trading-booooo v5.3.1 — autonomous Upbit KRW + Binance USDT spot orchestrator.
// Private service-role function. No withdrawal, transfer, margin, futures, leverage, or market-buy routes exist.

import {
  adjustedPlanForFill,
  baseAsset,
  calculateManagedCapital,
  calculatePositionSize,
  clamp,
  decideExit,
  dangerousControlError,
  evaluateCircuit,
  finite,
  floorToStep,
  manualReconcileAccounting,
  nextTrailingStop,
  normalizedOrderState,
  quoteCurrency,
  resumeSafetyError,
  t1SellQuantity,
  type Exchange,
  type TradingMode,
  type TradingSettings,
} from "./core.ts";
import { scalpEntryDecision } from "../_shared/scalp/scalp-gate.ts";
import { DEFAULT_SCALP_SIGNAL, refreshPWinAtOrderTime } from "../_shared/scalp/signal.ts";
import { applyCalibration, IDENTITY_CALIBRATION, type CalibrationModel } from "../_shared/scalp/calibration.ts";
import { evaluateHold, resolveHoldConfig, safetyTtlExceeded, type ScalpHoldConfig } from "../_shared/scalp/hold.ts";
import { DEFAULT_SCALP_SAFETY, type ScalpSafetyConfig, type ScalpDayState } from "../_shared/scalp/safety.ts";
import { DEFAULT_COST_MODEL, type CostModelConfig } from "../_shared/scalp/cost-model.ts";

const VERSION = "5.4.2";
// Must match BOT_IDENTIFIER_PREFIX in gateway/server.mjs and the prefix used by uniqueId().
const BOT_ORDER_PREFIX = "tb-";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const GATEWAY_URL = env("ORDER_GATEWAY_URL").replace(/\/$/, "");
const GATEWAY_SECRET = env("GATEWAY_SHARED_SECRET");
// Optional exchange-split: route Binance orders to a dedicated gateway (e.g. Paris/cdg).
// When BINANCE_ORDER_GATEWAY_URL is unset, Binance falls back to the primary gateway,
// so existing single-gateway deployments behave exactly as before. Upbit always uses the primary.
const BINANCE_GATEWAY_URL = env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/, "") || GATEWAY_URL;
const BINANCE_GATEWAY_SECRET = env("BINANCE_GATEWAY_SHARED_SECRET") || GATEWAY_SECRET;
function gatewayTarget(exchange: Exchange): { url: string; secret: string } {
  return exchange === "binance"
    ? { url: BINANCE_GATEWAY_URL, secret: BINANCE_GATEWAY_SECRET }
    : { url: GATEWAY_URL, secret: GATEWAY_SECRET };
}
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";
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
  if (!provided) return false;
  return (AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, provided)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, provided));
}
const CORS_HEADERS = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
  "access-control-max-age": "86400",
};
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function requiredConfiguration() {
  const missing: string[] = [];
  for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, AUTOTRADE_ACCESS_TOKEN: AUTOTRADE_TOKEN, DASHBOARD_ACCESS_TOKEN: DASHBOARD_TOKEN, ORDER_GATEWAY_URL: GATEWAY_URL, GATEWAY_SHARED_SECRET: GATEWAY_SECRET })) if (!value) missing.push(name);
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
  const target = gatewayTarget(exchange);
  const raw = JSON.stringify({ exchange, ...command });
  const ts = String(Date.now()); const nonce = crypto.randomUUID();
  const signature = await hmacHex(target.secret, `${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target.url}/v1/command`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-gateway-ts": ts, "x-gateway-nonce": nonce, "x-gateway-signature": signature }, body: raw,
    });
    const text = await res.text(); let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok || !data?.ok) {
      const error = new Error(`gateway ${res.status}: ${data?.error || text}`) as Error & { status?: number; code?: string; payload?: any };
      error.status = res.status;
      error.code = data?.code || `GATEWAY_${res.status}`;
      error.payload = data;
      throw error;
    }
    return data.result;
  } finally { clearTimeout(timer); }
}

function defaultSettings(): TradingSettings & JsonRecord {
  return {
    id: 1, configured: true, mode: DEFAULT_MODE, pause_new_entries: false, emergency_liquidation: false,
    upbit_enabled: true, binance_enabled: true,
    max_open_positions: 4, max_open_positions_per_exchange: 2,
    max_daily_entries: 8, max_daily_entries_per_exchange: 4,
    // Financial exposure is controlled only by the operator allocation settings below.
    // Legacy sizing fields remain for schema compatibility but are non-binding in SCALP.
    max_position_pct: 100, risk_per_trade_pct: 100,
    max_order_krw: 1_000_000_000,
    min_order_krw: 5_000,
    max_daily_buy_krw: 10_000_000_000,
    max_order_usdt: 10_000_000,
    min_order_usdt: clamp(finite(env("BINANCE_MIN_ORDER_USDT"), 10), 5, 1000),
    max_daily_buy_usdt: 100_000_000,
    upbit_allocation_mode: "ALL", upbit_allocation_krw: 0, upbit_reserve_krw: 0,
    binance_allocation_mode: "ALL", binance_allocation_usdt: 0, binance_reserve_usdt: 0,
    withdrawal_mode: false, manual_intervention_required: false, manual_event_reason: null,
    max_daily_loss_pct: 1.5, max_weekly_loss_pct: 3, max_consecutive_losses: 3,
    entry_ttl_seconds: 180,
    full_scan_interval_seconds: clamp(finite(env("AUTO_SCAN_INTERVAL_SECONDS"), 60), 60, 3600),
    monitor_interval_seconds: clamp(finite(env("AUTO_MONITOR_INTERVAL_SECONDS"), 15), 5, 300),
    max_new_entries_per_scan: 2, suppress_cross_exchange_same_asset: true,
    // Stage 4: scalp strategy. Default "TREND" = existing behavior, fully off.
    strategy: (env("TRADING_STRATEGY") === "SCALP" ? "SCALP" : "TREND"),
    scalp_per_order_pct: 100, // deprecated: allocation UI is the sole exposure ceiling
    scalp_daily_loss_pct: clamp(finite(env("SCALP_DAILY_LOSS_PCT"), 20), 0.1, 100),
    scalp_max_single_loss_pct: clamp(finite(env("SCALP_MAX_SINGLE_LOSS_PCT"), 5), 0.1, 100),
    scalp_max_consecutive_losses: clamp(finite(env("SCALP_MAX_CONSECUTIVE_LOSSES"), 4), 1, 50),
    scalp_kill_switch: env("SCALP_KILL_SWITCH") === "true",
    // v5.3 --------------------------------------------------------------------
    // Default raised 30 -> 120. A cost-cleared target cannot be reached in 30
    // minutes on most symbols; geometry.ts sizes the per-symbol horizon and this
    // is only the hard ceiling.
    scalp_max_holding_minutes: clamp(finite(env("SCALP_MAX_HOLDING_MINUTES"), 120), 1, 1440),
    // Capital is split into this many concurrent slots. v5.2.5 sized every entry at
    // the FULL available allocation, so the first candidate consumed everything and
    // the "max 2 entries per scan" allowance could never be used.
    scalp_position_slots: clamp(finite(env("SCALP_POSITION_SLOTS"), 6), 1, 20),
    // Excess win rate the signal is assumed to deliver. Drives barrier width.
    scalp_edge_budget: clamp(finite(env("SCALP_EDGE_BUDGET"), 0.10), 0.02, 0.30),
    scalp_reward_risk: clamp(finite(env("SCALP_REWARD_RISK"), 2.0), 1, 4),
    scalp_slippage_allowance: clamp(finite(env("SCALP_SLIPPAGE_ALLOWANCE"), 0.0009), 0, 0.01),
    // Half-life applied to scan-time alpha when the signal is re-priced at order time.
    scalp_alpha_half_life_ms: clamp(finite(env("SCALP_ALPHA_HALF_LIFE_MS"), 20000), 1000, 300000),
    // Move the effective stop to breakeven+cost once the first target is taken.
    scalp_breakeven_after_t1: env("SCALP_BREAKEVEN_AFTER_T1") !== "false",
    // Rest a limit sell at the first target instead of market-selling when a 15s poll
    // notices the target was crossed. Default OFF: this changes the order lifecycle and
    // should be enabled only after a small-size live trial. See restingTakeProfit below.
    scalp_resting_tp: env("SCALP_RESTING_TP") === "true",
    // v5.4 --------------------------------------------------------------------
    // The 30-minute forced exit is GONE. It was a safety timeout from the original
    // fixed +0.60%/-0.30% barrier, not a profit rule, and it force-sold positions whose
    // thesis was still intact while paying a full round trip for a non-outcome.
    // Positions are now held while the live edge survives; absolute time is only a
    // stuck-ledger backstop, and the operator sets it.
    scalp_safety_ttl_minutes: clamp(finite(env("SCALP_SAFETY_TTL_MINUTES"), 360), 10, 10080),
    scalp_hold_alpha_half_life_minutes: clamp(finite(env("SCALP_HOLD_ALPHA_HALF_LIFE_MINUTES"), 12), 1, 240),
    scalp_hold_min_edge_after_expected: clamp(finite(env("SCALP_HOLD_MIN_EDGE_AFTER_EXPECTED"), 0.0005), 0, 0.01),
    scalp_hold_reversal_imbalance: clamp(finite(env("SCALP_HOLD_REVERSAL_IMBALANCE"), -0.25), -1, 0),
    scalp_hold_reversal_confirmations: clamp(finite(env("SCALP_HOLD_REVERSAL_CONFIRMATIONS"), 2), 1, 10),
    // Query the exchange for this account's real commission rate instead of assuming the
    // list price. Set false to pin the static FEE_PCT table.
    scalp_use_live_fees: env("SCALP_USE_LIVE_FEES") !== "false",
    updated_at: new Date().toISOString(),
  };
}
const RECOVERED_SCALP_SETTINGS: JsonRecord = {
  strategy: "SCALP",
  scalp_per_order_pct: 100,
  scalp_daily_loss_pct: 20,
  scalp_max_single_loss_pct: 5,
  scalp_max_consecutive_losses: 4,
  scalp_kill_switch: false,
  scalp_max_holding_minutes: 30,
};

function hasMalformedLegacyScalpSettings(settings: TradingSettings & JsonRecord): boolean {
  return String(settings.strategy || "").toUpperCase() === "SCALP" &&
    finite(settings.scalp_per_order_pct) <= 0.1 &&
    finite(settings.scalp_daily_loss_pct) <= 0.1 &&
    finite(settings.scalp_max_single_loss_pct) <= 0.1 &&
    finite(settings.scalp_max_consecutive_losses) <= 1 &&
    finite(settings.scalp_max_holding_minutes) <= 1 &&
    settings.scalp_kill_switch === true;
}

async function loadSettings(): Promise<TradingSettings & JsonRecord> {
  const rows = await db("trading_settings?id=eq.1&select=*");
  if (rows?.[0]) {
    const merged = { ...defaultSettings(), ...rows[0] } as TradingSettings & JsonRecord;
    // v5.2.0 could persist percentage fractions (0.1) as percentage points and
    // enable the kill switch at the same time. That signature blocks every live
    // entry. Repair that exact legacy signature once, while preserving future
    // intentional operator changes such as manually enabling the kill switch.
    if (hasMalformedLegacyScalpSettings(merged)) {
      const repaired = (await patch("trading_settings", "id=eq.1", {
        ...RECOVERED_SCALP_SETTINGS,
        version: finite(merged.version) + 1,
      }))[0];
      return { ...merged, ...RECOVERED_SCALP_SETTINGS, ...(repaired || {}) };
    }
    return merged;
  }
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
async function withLeaseRetry<T>(name: string, seconds: number, attempts: number, delayMs: number, work: () => Promise<T>): Promise<T | null> {
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const result = await withLease(name, seconds, work);
    if (result != null) return result;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
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
async function accountStats(exchange: Exchange, equityQuote: number, isPaper: boolean) {
  const [activeGlobal, activeExchange, todayGlobal, todayExchange, dailyBuyOrders, dailyClosed, weeklyClosed, recentClosed] = await Promise.all([
    db(`trading_positions?is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id,exchange,market,base_asset`),
    db(`trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id,market,base_asset`),
    db(`trading_positions?is_paper=eq.${isPaper}&created_at=gte.${encodeURIComponent(dayBoundary("upbit"))}&state=neq.CANCELLED&select=id`),
    db(`trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&created_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=neq.CANCELLED&select=id`),
    db(`trading_orders?exchange=eq.${exchange}&side=eq.BUY&requested_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=in.(APPLIED,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED)&select=executed_funds_quote,trading_positions!inner(is_paper)&trading_positions.is_paper=eq.${isPaper}`),
    db(`trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&closed_at=gte.${encodeURIComponent(dayBoundary(exchange))}&state=eq.CLOSED&select=realized_pnl_quote`),
    db(`trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&closed_at=gte.${encodeURIComponent(weekBoundary(exchange))}&state=eq.CLOSED&select=realized_pnl_quote`),
    db(`trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=eq.CLOSED&select=realized_pnl_quote&order=closed_at.desc&limit=20`),
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
        strategy: (settings as any).strategy,
        scalp_overrides: {
          minimumEdge: finite((settings as any).scalp_minimum_edge, DEFAULT_COST_MODEL.minimumEdge),
        },
        // v5.3: barrier geometry. `edgeBudget` is the dominant knob — it is the excess
        // win rate the signal is assumed to deliver, and it sets how wide T + S must be
        // for the required win rate to be attainable at all.
        geometry_overrides: {
          edgeBudget: finite((settings as any).scalp_edge_budget, 0.10),
          rewardRiskRatio: finite((settings as any).scalp_reward_risk, 2.0),
          slippageAllowance: finite((settings as any).scalp_slippage_allowance, 0.0009),
          minimumEdge: finite((settings as any).scalp_minimum_edge, DEFAULT_COST_MODEL.minimumEdge),
          maxHorizonMinutes: finite((settings as any).scalp_max_holding_minutes, 120),
        },
        capital_krw: Math.max(10_000, finite(portfolios.upbit?.managed?.managedCapitalQuote, portfolios.upbit?.available_quote || 10_000)),
        capital_usdt: Math.max(10, finite(portfolios.binance?.managed?.managedCapitalQuote, portfolios.binance?.available_quote || 10)),
        risk_pct: (settings as any).strategy === "SCALP" ? 100 : settings.risk_per_trade_pct,
        // v5.4: the scanner sizes barriers from cost, so it must receive the account's
        // real commission rate rather than recomputing the list price.
        upbit_fee_per_side_pct: await liveFeePct("upbit", settings),
        binance_fee_per_side_pct: await liveFeePct("binance", settings),
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
async function loadBuyCandidates(scanId: string, settings?: TradingSettings): Promise<Candidate[]> {
  const rows = await db(`scanner_candidates?scan_id=eq.${scanId}&decision=eq.BUY&exchange=in.(upbit,binance)&select=*&order=score.desc,period_score.desc`) as Candidate[];
  if (String((settings as any)?.strategy || "") !== "SCALP") return rows;
  // v5.3: in SCALP the entry decision comes from the orderbook signal, but v5.2.5 still
  // handed the candidates to the sizer ordered by the LEGACY TREND SCORE. Combined with
  // full-allocation sizing that meant the single position the bot could hold was chosen
  // by trend score rather than by scalp expected value. Re-rank by provisional edge.
  const edge = (row: Candidate) => {
    const scalp = (row as any).snapshot?.scalp;
    return finite(scalp?.provisional_edge, Number.NEGATIVE_INFINITY);
  };
  return [...rows].sort((a, b) => edge(b) - edge(a));
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
/**
 * v5.3: top-of-book imbalance from a live orderbook, using the same depth and decay as
 * the scanner's `book_imbalance_top`, so the order-time refresh is on the same scale as
 * the scan-time term it replaces. Keep SCALP_BOOK_DEPTH / SCALP_BOOK_DECAY in
 * market-scanner/engine.ts in sync with these two constants.
 */
const SCALP_BOOK_DEPTH = 5;
const SCALP_BOOK_DECAY = 1.5;
function topOfBookImbalance(bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>): number {
  let bid = 0; let ask = 0;
  for (let i = 0; i < SCALP_BOOK_DEPTH; i++) {
    const weight = 1 / Math.pow(i + 1, SCALP_BOOK_DECAY);
    const b = bids[i]; const a = asks[i];
    if (b && finite(b.price) > 0 && finite(b.size) > 0) bid += finite(b.price) * finite(b.size) * weight;
    if (a && finite(a.price) > 0 && finite(a.size) > 0) ask += finite(a.price) * finite(a.size) * weight;
  }
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : 0;
}

function candidatePlan(candidate: Candidate, settings?: TradingSettings) {
  const trade = candidate.snapshot?.trade_plan || {}; const tick = finite(trade.tick_size, finite(candidate.feature_vector?.tick_size));
  const allocation = clamp(finite(trade.first_target_allocation_pct, 60), 50, 80); const strategy = String(trade.target_strategy || "SCALE_OUT");
  const isScalp = String((settings as any)?.strategy || "") === "SCALP";
  const scalpStopPct = finite((candidate as any).snapshot?.scalp?.stop_pct, 0.003);
  return {
    tick, allocation,
    // v5.3: SCALP always trails after the first target.
    //
    // v5.2.5 defaulted to SCALE_OUT, under which the runner kept the ORIGINAL stop after
    // T1 — so a position that reached +T and retraced closed the remainder at -S and
    // could end net negative despite having hit its target. The legacy 1.2% trail was
    // also inert at scalp scale: nextTrailingStop() floors at the hard stop, so with a
    // 0.6% target the trail never engaged until the peak passed +0.91%.
    exitPolicy: isScalp
      ? "TRAIL_AFTER_T1"
      : strategy === "TRAIL_AFTER_T1" ? "TRAIL_AFTER_T1" : strategy === "SHORT_ONLY" ? "FIXED_T1" : "SCALE_OUT",
    recommended: finite(trade.recommended_investment_quote, finite(trade.recommended_investment_krw)),
    // Trail one stop-width below the peak instead of a flat 1.2%.
    trailingDistancePct: isScalp
      ? clamp(scalpStopPct * 100, 0.1, 5)
      : clamp(finite(candidate.feature_vector?.risk_snapshot?.trailing_distance_pct, 1.2), 0.5, 5),
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
/**
 * v5.4.1: commission charged IN THE BASE ASSET.
 *
 * Binance spot deducts the buy commission from the coin you receive whenever fee payment
 * in BNB is off. `executedQty` is the GROSS matched quantity, so the amount that actually
 * lands in the account is `executedQty - commission`. Booking the gross figure makes the
 * ledger permanently expect ~0.1% more coin than exists, and the account reconciliation
 * then reads that shortfall as a user having sold — which halts the whole system.
 *
 * Upbit charges its fee in KRW on both sides, so its base quantity is unaffected. That is
 * why the mismatch only ever appeared on Binance.
 */
function baseAssetFee(order: any, fill: any, baseAssetSymbol: string): number {
  const symbol = String(baseAssetSymbol || "").toUpperCase();
  if (!symbol) return 0;
  const trades = Array.isArray(order?.trades) ? order.trades : Array.isArray(fill?.trades) ? fill.trades : [];
  if (trades.length) {
    // Per-fill is authoritative: a single order can pay commission in several assets.
    return trades.reduce(
      (total: number, trade: any) =>
        String(trade?.fee_asset || "").toUpperCase() === symbol ? total + Math.max(0, finite(trade?.fee)) : total,
      0,
    );
  }
  const aggregateAsset = String(fill?.feeAsset || order?.fee_asset || "").toUpperCase();
  return aggregateAsset === symbol ? Math.max(0, finite(fill?.paidFee, order?.paid_fee)) : 0;
}

async function updateOrderFromGateway(orderRow: any, payload: any) {
  const order = payload?.order || payload; const fill = payload?.fill || {
    executedVolume: finite(order?.executed_volume), executedFunds: finite(order?.executed_funds), averagePrice: finite(order?.average_price), paidFee: finite(order?.paid_fee), feeAsset: order?.fee_asset,
  };
  const feeQuote = feeQuoteEstimate(orderRow.exchange, order, fill);
  // Attach the base-asset commission so the caller can book the NET quantity received.
  const paidFeeBase = baseAssetFee(order, fill, baseAsset(orderRow.exchange as Exchange, orderRow.market));
  const rows = await patch("trading_orders", `id=eq.${orderRow.id}`, {
    exchange_order_id: order?.exchange_order_id || null,
    state: normalizedOrderState(orderRow.state, order?.status),
    executed_volume: finite(fill.executedVolume), average_fill_price: finite(fill.averagePrice) || null,
    executed_funds_quote: finite(fill.executedFunds), paid_fee_quote: feeQuote, fee_asset: fill.feeAsset || order?.fee_asset || null,
    completed_at: ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(order?.status)) ? new Date().toISOString() : null,
    raw_response: order || {},
  });
  await storeFills(orderRow, order);
  return { row: rows[0] || orderRow, order, fill: { ...fill, paidFeeQuote: feeQuote, paidFeeBase } };
}
async function applyEntryAccounting(position: Position, orderRow: any, fill: any) {
  const grossQuantity = finite(fill.executedVolume); const price = finite(fill.averagePrice);
  // v5.4.1: book what the account actually received, not what was matched. See baseAssetFee().
  const baseFee = Math.max(0, finite(fill.paidFeeBase, baseAssetFee(null, fill, position.base_asset)));
  const quantity = floorToStep(Math.max(0, grossQuantity - baseFee), finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0 && price > 0)) throw new Error("entry fill has no executable quantity");
  if (baseFee > 0) {
    await event("ENTRY_BASE_FEE_ADJUSTED", `${position.exchange}:${position.market} commission paid in base asset`, {
      gross_quantity: grossQuantity, base_fee: baseFee, booked_quantity: quantity, base_asset: position.base_asset,
    }, { positionId: position.id, orderId: orderRow.id, level: "INFO" });
  }
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
async function applyExitAccounting(position: Position, orderRow: any, fill: any, action: string, fallbackPrice: number, breakevenAfterT1 = true) {
  const quantity = finite(fill.executedVolume); const price = finite(fill.averagePrice, fallbackPrice);
  if (!(quantity > 0 && price > 0)) throw new Error("exit fill has no executable quantity");
  // v5.3: once the first target is realized the remainder must never be able to give
  // the trade back. The trail is floored at entry + round-trip cost, i.e. true breakeven
  // after fees, not at the original stop.
  //
  // NOTE: this is applied to `trailing_stop`, not `stop_price`. The trading_positions
  // check constraint requires stop_price < average_entry_price, so breakeven cannot be
  // expressed there. decideExit() uses max(stop_price, trailing_stop) once t1_completed,
  // so seeding the trail achieves the same effect without a schema change.
  const breakevenFloor = breakevenAfterT1 && finite(position.average_entry_price) > 0
    ? finite(position.average_entry_price) * (1 + FEE_PCT[position.exchange as Exchange] * 2 / 100)
    : 0;
  const nextTrail = action === "TARGET_1" && position.exit_policy === "TRAIL_AFTER_T1"
    ? Math.max(
      breakevenFloor,
      nextTrailingStop(position.trailing_stop, Math.max(price, finite(position.peak_price, position.average_entry_price)), finite(position.trailing_distance_pct, 1.2), position.stop_price),
    )
    : null;
  const result = await rpc("apply_trading_exit_order", {
    p_order_id: orderRow.id, p_action: action, p_fill_price: price, p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity), p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_trailing_stop: nextTrail, p_dust_value_quote: position.exchange === "upbit" ? 1000 : 1,
  });
  return { applied: Boolean(result?.applied), closed: Boolean(result?.closed), position: result?.position || position, fillPrice: price, quantity };
}

function allocationConfig(settings: TradingSettings, exchange: Exchange) {
  return exchange === "upbit"
    ? { mode: settings.upbit_allocation_mode || "ALL", fixed: finite(settings.upbit_allocation_krw), reserve: finite(settings.upbit_reserve_krw) }
    : { mode: settings.binance_allocation_mode || "ALL", fixed: finite(settings.binance_allocation_usdt), reserve: finite(settings.binance_reserve_usdt) };
}
async function managedPortfolio(settings: TradingSettings, exchange: Exchange, portfolio: any) {
  const paper = settings.mode !== "LIVE_LIMITED";
  const active = await db(`trading_positions?exchange=eq.${exchange}&state=in.(ENTRY_PENDING,OPEN,EXITING)&is_paper=eq.${paper}&select=market,remaining_quantity,average_entry_price,planned_entry_price`) as any[];
  let openCost = 0;
  let botPositionValue = 0;
  for (const row of active || []) {
    const quantity = Math.max(0, finite(row.remaining_quantity));
    const entry = Math.max(0, finite(row.average_entry_price, row.planned_entry_price));
    const current = Math.max(0, finite(portfolio?.prices?.[row.market], entry));
    openCost += quantity * entry;
    botPositionValue += quantity * current;
  }
  // Capital allocation is quote-currency based: Upbit KRW and Binance USDT.
  // Manual coin holdings are excluded; only quote cash/locked quote and bot positions count.
  const capitalBaseQuote = Math.max(0, finite(portfolio.available_quote)) +
    Math.max(0, finite(portfolio.locked_quote)) + botPositionValue;
  const config = allocationConfig(settings, exchange);
  const managed = calculateManagedCapital({
    capitalBaseQuote,
    availableQuote: finite(portfolio.available_quote),
    // Use the more conservative of entry cost and current value so a winning
    // position cannot make a fixed allocation appear to have free capacity.
    openCostQuote: Math.max(openCost, botPositionValue),
    allocationMode: config.mode === "FIXED" ? "FIXED" : "ALL",
    fixedAllocationQuote: config.fixed,
    reserveQuote: config.reserve,
  });
  return { ...portfolio, managed: { ...managed, botPositionValueQuote: botPositionValue } };
}

function exchangeLimits(settings: TradingSettings, exchange: Exchange) {
  const allocationControlled = (settings as any).strategy === "SCALP";
  return exchange === "upbit"
    ? {
      maxOrder: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_order_krw,
      minOrder: settings.min_order_krw,
      quoteStep: 1000,
      dailyBuy: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_daily_buy_krw,
    }
    : {
      maxOrder: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_order_usdt,
      minOrder: settings.min_order_usdt,
      quoteStep: 0.01,
      dailyBuy: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_daily_buy_usdt,
    };
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

// --- Stage 4 scalp helpers ---------------------------------------------------
function scalpSafetyConfig(settings: TradingSettings): ScalpSafetyConfig {
  return {
    // The dashboard allocation (ALL/FIXED minus reserve) is the sole exposure ceiling.
    perOrderPctOfCapital: 1,
    dailyLossPctOfCapital: finite((settings as any).scalp_daily_loss_pct, DEFAULT_SCALP_SAFETY.dailyLossPctOfCapital * 100) / 100,
    // No unapproved streak cap; the approved daily loss rail remains authoritative.
    maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
    killSwitch: (settings as any).scalp_kill_switch === true,
  };
}

function scalpCostConfig(settings: TradingSettings, exchange: Exchange, feePct = FEE_PCT[exchange]): CostModelConfig {
  return {
    ...DEFAULT_COST_MODEL,
    roundTripFeeFraction: feePct * 2 / 100,
    minimumEdge: finite((settings as any).scalp_minimum_edge, DEFAULT_COST_MODEL.minimumEdge),
  };
}

/**
 * Day state for the scalp safety rails: today's realized P&L and the current
 * consecutive-loss streak, scoped to this exchange and paper/live mode.
 * Day boundary follows the exchange convention (KST for upbit, UTC for binance).
 */
async function scalpDayState(exchange: Exchange, isPaper: boolean): Promise<ScalpDayState> {
  const now = new Date();
  const dayStart = exchange === "upbit"
    ? new Date(new Date(now.getTime() + 9 * 3600_000).setUTCHours(0, 0, 0, 0) - 9 * 3600_000) // KST midnight
    : new Date(new Date(now).setUTCHours(0, 0, 0, 0)); // UTC midnight
  const rows = await db(
    `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=eq.CLOSED&closed_at=gte.${dayStart.toISOString()}&select=realized_pnl_quote,closed_at&order=closed_at.desc`,
  ) as Array<{ realized_pnl_quote: number; closed_at: string }>;
  let realizedPnlQuote = 0;
  let consecutiveLosses = 0;
  let streakOpen = true;
  for (const row of rows || []) {
    const pnl = finite(row.realized_pnl_quote);
    realizedPnlQuote += pnl;
    if (streakOpen) {
      if (pnl < 0) consecutiveLosses += 1;
      else streakOpen = false;
    }
  }
  return { realizedPnlQuote, consecutiveLosses };
}

async function enterCandidate(candidate: Candidate, settings: TradingSettings, portfolio: any, activeBases: Set<string>, cycleId: string) {
  const exchange = candidate.exchange; const quote = quoteCurrency(exchange); const base = baseAsset(exchange, candidate.market);
  if (candidate.recommendation_valid_until && Date.now() > new Date(candidate.recommendation_valid_until).getTime()) return { entered: false, exchange, market: candidate.market, reason: "recommendation expired" };
  const existing = await db(`trading_positions?exchange=eq.${exchange}&market=eq.${candidate.market}&state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id&limit=1`);
  if (existing.length) return { entered: false, exchange, market: candidate.market, reason: "market already tracked" };
  if (settings.suppress_cross_exchange_same_asset && activeBases.has(base)) return { entered: false, exchange, market: candidate.market, reason: `base asset ${base} already exposed on another market` };
  // v5.4: asset-scoped pause. A confirmed mismatch on one coin no longer stops the
  // whole system; it stops that coin.
  const assetLocks = Array.isArray((settings as any).manual_asset_locks) ? (settings as any).manual_asset_locks : [];
  if (assetLocks.includes(`${exchange}:${base}`)) return { entered: false, exchange, market: candidate.market, reason: `asset ${base} is paused pending manual review` };

  const market = await marketQuote(exchange, candidate.market);
  const bestAsk = finite(market.best_ask); const bestBid = finite(market.best_bid);
  if (!(bestAsk > 0 && bestBid > 0)) return { entered: false, exchange, market: candidate.market, reason: "empty orderbook" };
  if (accountQuantity(portfolio, base) * Math.max(finite(market.current), bestBid) >= (exchange === "upbit" ? 1000 : 1)) {
    return { entered: false, exchange, market: candidate.market, reason: "pre-existing account balance detected; manual and bot holdings are isolated" };
  }
  // v5.3: in SCALP the entry ceiling must come from the live book, not from the trend
  // plan's entry zone. `candidate.entry_high` is computed from 15m ATR structure and
  // routinely sits below the current ask, which silently blocked scalp entries.
  const scalpStopPctForCeiling = finite((candidate as any).snapshot?.scalp?.stop_pct, 0.003);
  const maxEntry = (settings as any).strategy === "SCALP"
    ? bestAsk * (1 + Math.min(0.25 * scalpStopPctForCeiling, 0.002))
    : finite(candidate.entry_high);
  if (!(maxEntry > 0) || bestAsk > maxEntry) return { entered: false, exchange, market: candidate.market, reason: `best ask ${bestAsk} above entry ceiling ${maxEntry}` };
  const spreadBps = (bestAsk / bestBid - 1) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > LIVE_MAX_SPREAD_BPS) return { entered: false, exchange, market: candidate.market, reason: `spread ${spreadBps.toFixed(1)}bp exceeds ${LIVE_MAX_SPREAD_BPS}bp` };

  const plan = candidatePlan(candidate, settings); const rules = await symbolRules(exchange, candidate, plan); const limits = exchangeLimits(settings, exchange);
  const managedPortfolioState = await managedPortfolio(settings, exchange, portfolio);
  const managed = managedPortfolioState.managed;
  if (finite(managed.managedAvailableQuote) < Math.max(limits.minOrder, rules.min_notional)) {
    return { entered: false, exchange, market: candidate.market, reason: "managed allocation has no available buying power" };
  }
  const allocationOnly = (settings as any).strategy === "SCALP";
  const managedAvailable = finite(managed.managedAvailableQuote);
  // v5.3: split the managed allocation into concurrent slots. v5.2.5 used
  // `managedAvailable` directly, so candidate #1 took the entire exchange balance,
  // candidate #2 always failed the exchange minimum, and the bot ran a single
  // position at a time — the opposite of the intended high-turnover profile.
  const slots = allocationOnly ? clamp(finite((settings as any).scalp_position_slots, 6), 1, 20) : 1;
  const slotQuote = allocationOnly
    ? Math.max(0, finite(managed.managedCapitalQuote)) / slots
    : Number.POSITIVE_INFINITY;
  const maxOrder = allocationOnly
    ? Math.min(managedAvailable, slotQuote)
    : Math.min(limits.maxOrder, plan.recommended > 0 ? plan.recommended : limits.maxOrder);
  const allocationSizing = (entryPrice: number) => {
    const minOrder = Math.max(limits.minOrder, rules.min_notional);
    const notionalQuote = floorToStep(Math.min(managedAvailable, maxOrder), limits.quoteStep);
    return notionalQuote >= minOrder
      ? { allowed: true, notionalQuote, quantity: notionalQuote / entryPrice, stopDistancePct: 0, riskBudgetQuote: notionalQuote, reason: null }
      : { allowed: false, notionalQuote: 0, quantity: 0, stopDistancePct: 0, riskBudgetQuote: 0, reason: `allocated order ${notionalQuote} below minimum ${minOrder}` };
  };
  const initial = allocationOnly ? allocationSizing(bestAsk) : calculatePositionSize({
    equityQuote: finite(managed.managedCapitalQuote), availableQuote: managedAvailable, entryPrice: bestAsk, stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct, riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder, minOrderQuote: Math.max(limits.minOrder, rules.min_notional), quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!initial.allowed) return { entered: false, exchange, market: candidate.market, reason: initial.reason };
  let depth = executableDepth(market.asks, maxEntry, initial.notionalQuote);
  if (!depth.executable || depth.availableFunds < initial.notionalQuote * LIVE_MIN_DEPTH_BUFFER) return { entered: false, exchange, market: candidate.market, reason: `insufficient ask depth (${depth.availableFunds.toFixed(exchange === "upbit" ? 0 : 2)} ${quote})` };
  const entryPrice = tickRound(Math.min(maxEntry, depth.worstPrice), rules.price_tick, "down");
  const sizing = allocationOnly ? allocationSizing(entryPrice) : calculatePositionSize({
    equityQuote: finite(managed.managedCapitalQuote), availableQuote: managedAvailable, entryPrice, stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct, riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder, minOrderQuote: Math.max(limits.minOrder, rules.min_notional), quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!sizing.allowed) return { entered: false, exchange, market: candidate.market, reason: sizing.reason };
  depth = executableDepth(market.asks, maxEntry, sizing.notionalQuote);
  if (!depth.executable || depth.availableFunds < sizing.notionalQuote * LIVE_MIN_DEPTH_BUFFER) return { entered: false, exchange, market: candidate.market, reason: "depth deteriorated during sizing" };
  let quantity = floorToStep(sizing.notionalQuote / entryPrice, rules.quantity_step || 0.00000001);
  if (!(quantity > 0) || quantity * entryPrice < Math.max(limits.minOrder, rules.min_notional)) return { entered: false, exchange, market: candidate.market, reason: "quantity below exchange minimum" };

  // Stage 4: scalp final gate — safety rails (halt/cap) FIRST, then precise stressed-slippage EV.
  // Only active when strategy === "SCALP"; otherwise the original flow is untouched.
  let scalpStopPrice: number | null = null;
  let scalpTarget1: number | null = null;
  let scalpTarget2: number | null = null;
  let scalpAudit: JsonRecord | null = null;
  if ((settings as any).strategy === "SCALP") {
    const scalpSnapshot = (candidate as any).snapshot?.scalp || {};
    const scanPWin = finite((candidate as any).scalp_p_win ?? scalpSnapshot.pWin ?? (candidate as any).scalp?.pWin, 0.5);
    const scalpTargetPct = finite((candidate as any).scalp_target_pct ?? scalpSnapshot.target_pct ?? (candidate as any).scalp?.target_pct, 0.006);
    const scalpStopPct = finite((candidate as any).scalp_stop_pct ?? scalpSnapshot.stop_pct ?? (candidate as any).scalp?.stop_pct, 0.003);
    const resolveProbability = clamp(finite(scalpSnapshot.geometry?.resolve_probability, 1), 0, 1);

    const askLevels = (market.asks || []).map((a: any) => ({ price: finite(a.price ?? a[0]), size: finite(a.size ?? a[1]) }));
    const bidLevels = (market.bids || []).map((b: any) => ({ price: finite(b.price ?? b[0]), size: finite(b.size ?? b[1]) }));

    // v5.3: re-price the signal against the book that exists RIGHT NOW.
    // v5.2.5 carried `pWin` verbatim from the scan and only refreshed depth, so with a
    // 60s scan cadence the entry could be driven by a minute-old orderbook reading while
    // `maxBookAgeMs: 5000` implied freshness was enforced.
    const signalAtMs = Date.parse(String(scalpSnapshot.signal_at || candidate.created_at || ""));
    const signalAgeMs = Number.isFinite(signalAtMs) ? Math.max(0, Date.now() - signalAtMs) : 60_000;
    const liveImbalance = topOfBookImbalance(bidLevels, askLevels);
    const rawPWin = refreshPWinAtOrderTime(
      scanPWin,
      finite(scalpSnapshot.imbalance_contribution, 0),
      liveImbalance,
      signalAgeMs,
      {
        ...DEFAULT_SCALP_SIGNAL,
        alphaHalfLifeMs: clamp(finite((settings as any).scalp_alpha_half_life_ms, DEFAULT_SCALP_SIGNAL.alphaHalfLifeMs), 1000, 300000),
      },
      finite(scalpSnapshot.trend_penalty, 1),
    );
    // v5.3: correct the model's probability with whatever the realized outcomes say.
    // Identity until the calibration job has enough samples to promote a profile.
    const calibration = await loadScalpCalibration();
    const scalpPWin = applyCalibration(rawPWin, calibration);

    const day = await scalpDayState(exchange, settings.mode !== "LIVE_LIMITED");
    const decision = scalpEntryDecision(
      {
        capitalQuote: finite(managed.managedCapitalQuote),
        requestedNotional: sizing.notionalQuote,
        day,
        pWin: scalpPWin,
        targetPct: scalpTargetPct,
        stopPct: scalpStopPct,
        askLevels,
        bidLevels,
        bestAsk, bestBid,
        resolveProbability,
        timeoutReturn: 0,
      },
      scalpSafetyConfig(settings),
      scalpCostConfig(settings, exchange, await liveFeePct(exchange, settings)),
    );
    scalpAudit = {
      scan_p_win: scanPWin,
      raw_order_p_win: rawPWin,
      order_p_win: scalpPWin,
      calibration: { slope: calibration.a, intercept: calibration.b, samples: calibration.samples },
      signal_age_ms: signalAgeMs,
      live_top_imbalance: liveImbalance,
      resolve_probability: resolveProbability,
      target_pct: scalpTargetPct,
      stop_pct: scalpStopPct,
      expected_net_edge: decision.expectedNetEdge,
      geometry: scalpSnapshot.geometry || null,
      features: scalpSnapshot.features || null,
      slots,
      slot_quote: Number.isFinite(slotQuote) ? slotQuote : null,
    };
    if (!decision.allow) {
      await event("SCALP_GATE_BLOCK", `${exchange}:${candidate.market} scalp gate blocked`, { reason: decision.reason, ...scalpAudit }, { cycleId });
      return { entered: false, exchange, market: candidate.market, reason: `scalp gate: ${decision.reason}` };
    }
    if (decision.notional < sizing.notionalQuote) {
      quantity = floorToStep(decision.notional / entryPrice, rules.quantity_step || 0.00000001);
      if (!(quantity > 0) || quantity * entryPrice < Math.max(limits.minOrder, rules.min_notional)) {
        return { entered: false, exchange, market: candidate.market, reason: "allocation-controlled order below exchange minimum" };
      }
    }
    // Exits follow the scalp target/stop the EV gate was evaluated on, not the wide
    // trend plan — otherwise the position would hold to trend targets after a scalp entry.
    scalpStopPrice = tickRound(entryPrice * (1 - scalpStopPct), rules.price_tick, "down");
    scalpTarget1 = tickRound(entryPrice * (1 + scalpTargetPct), rules.price_tick, "up");
    scalpTarget2 = tickRound(entryPrice * (1 + scalpTargetPct * 1.5), rules.price_tick, "up");
  }

  // v5.3: the holding horizon is per symbol. geometry.ts stretches it to the time the
  // symbol actually needs, at its own volatility, to travel `target_pct`; the operator
  // setting is only the ceiling. v5.2.5 used a flat 30 minutes for everything, which
  // guaranteed a time exit on any symbol slower than the (fixed) target.
  // v5.4: two different clocks, with two different jobs.
  //   expected_resolution_at — volatility-derived estimate of when this symbol should
  //     have reached its target. NOT an exit. Past it, the hold test gets stricter.
  //   max_holding_at — the absolute backstop against a stuck ledger. Operator-set,
  //     default 6 hours. This is the only absolute time that can close a position.
  const scalpHorizonCeiling = clamp(finite((settings as any).scalp_max_holding_minutes, 120), 1, 1440);
  const scalpExpectedMinutes = clamp(
    finite((candidate as any).snapshot?.scalp?.geometry?.horizon_minutes, scalpHorizonCeiling),
    1,
    scalpHorizonCeiling,
  );
  const scalpSafetyTtlMinutes = Math.max(
    scalpExpectedMinutes,
    clamp(finite((settings as any).scalp_safety_ttl_minutes, 360), 10, 10080),
  );
  const maxHolding = (settings as any).strategy === "SCALP"
    ? new Date(Date.now() + scalpSafetyTtlMinutes * 60_000).toISOString()
    : new Date(Date.now() + clamp(finite(candidate.intended_horizon_hours, 24), 1, 480) * 3600_000).toISOString();
  const position = (await insert("trading_positions", {
    candidate_id: candidate.id, scan_id: candidate.scan_id, exchange, quote_currency: quote, market: candidate.market, base_asset: base,
    state: "ENTRY_PENDING", is_paper: settings.mode !== "LIVE_LIMITED", profile_version: candidate.profile_version || 0,
    planned_entry_price: entryPrice, stop_price: scalpStopPrice ?? candidate.stop_price, target_1: scalpTarget1 ?? candidate.target_1, target_2: scalpTarget2 ?? candidate.target_2,
    tick_size: rules.price_tick, quantity_step: rules.quantity_step, min_notional_quote: Math.max(limits.minOrder, rules.min_notional),
    t1_allocation_pct: plan.allocation, exit_policy: plan.exitPolicy, trailing_distance_pct: plan.trailingDistancePct,
    intended_horizon_hours: candidate.intended_horizon_hours, max_holding_at: maxHolding,
    metadata: {
      cycle_id: cycleId, sizing, managed_allocation: managed, quote_at_entry: market,
      execution_depth: depth, live_spread_bps: spreadBps, engine_version: VERSION,
      // v5.3: the full entry-time signal, persisted so the pWin calibration loop can
      // later join predicted probability against the realized outcome on this row.
      scalp_signal: scalpAudit,
      scalp_expected_minutes: (settings as any).strategy === "SCALP" ? scalpExpectedMinutes : null,
      scalp_safety_ttl_minutes: (settings as any).strategy === "SCALP" ? scalpSafetyTtlMinutes : null,
      expected_resolution_at: (settings as any).strategy === "SCALP"
        ? new Date(Date.now() + scalpExpectedMinutes * 60_000).toISOString()
        : null,
    },
  }))[0] as Position;

  if (settings.mode !== "LIVE_LIMITED") {
    const paperPrice = depth.vwap > 0 ? depth.vwap : entryPrice;
    // PAPER must use the same final, safety-capped quantity as LIVE.
    const paperQty = floorToStep(quantity, rules.quantity_step || 0.00000001);
    const opened = await openPaperPosition(position, candidate, paperPrice, paperQty, paperQty * paperPrice);
    await event("PAPER_ENTRY", `${exchange}:${candidate.market} paper entry`, { price: paperPrice, quantity: paperQty, notional_quote: paperQty * paperPrice, quote }, { cycleId, positionId: position.id });
    return { entered: true, paper: true, exchange, market: candidate.market, position: opened };
  }

  const testIdentifier = uniqueId("t", position.id);
  try {
    await gateway(exchange, { action: "order_test", order: { market: candidate.market, side: "BUY", type: "LIMIT", price: entryPrice, quantity, time_in_force: "IOC", identifier: testIdentifier } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patch("trading_positions", `id=eq.${position.id}`, {
      state: "CANCELLED", close_reason: "ENTRY_TEST_REJECTED", closed_at: new Date().toISOString(),
      metadata: { ...(position.metadata || {}), entry_test_error: message },
    });
    await event("ENTRY_ERROR", `${exchange}:${candidate.market} entry test rejected`, { error: message }, { cycleId, positionId: position.id, level: "WARNING" });
    return { entered: false, exchange, market: candidate.market, reason: message };
  }
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
    // v5.3: rest the first-target limit sell now, so the profit path never depends on a
    // 15-second poll catching the touch. No-op unless scalp_resting_tp is enabled.
    const withTp = await placeRestingTakeProfit(opened as Position, settings, cycleId);
    return { entered: true, paper: false, exchange, market: candidate.market, position: withTp };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((error as any)?.status || 0);
    // A deterministic 4xx rejection means Binance/Upbit did not accept the order.
    // Do not leave a ghost ENTRY_PENDING position. Only transport/5xx uncertainty
    // remains reserved for duplicate-safe reconciliation.
    if (status >= 400 && status < 500) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "REJECTED", error_message: message, completed_at: new Date().toISOString() });
      await patch("trading_positions", `id=eq.${position.id}`, { state: "CANCELLED", close_reason: "ENTRY_REJECTED", closed_at: new Date().toISOString() });
      await event("ENTRY_ERROR", `${exchange}:${candidate.market} entry rejected`, { identifier, error: message, status }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" });
      return { entered: false, exchange, market: candidate.market, reason: message };
    }
    await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "UNKNOWN", error_message: message });
    await event("ENTRY_RESULT_UNKNOWN", `${exchange}:${candidate.market} entry requires reconciliation`, { identifier, error: message }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" });
    return { entered: false, reserved: true, pending_reconcile: true, exchange, market: candidate.market, reason: "entry result unknown; duplicate suppressed" };
  }
}

// =====================================================================================
// v5.3: resting take-profit
// =====================================================================================
//
// The v5.2.5 profit exit was: poll the ticker every 15 seconds, and when it is at or
// above the target, send a MARKET sell. That loses on both sides of the same trade:
//
//   1) If price touches the target and retreats inside the 15s gap, the WIN NEVER
//      HAPPENS — the position stays open and often closes later at the stop. This is a
//      direct, and large, hit to realized win rate.
//   2) Even when the poll catches it, a market sell fills at the best BID, i.e. the
//      target minus the spread, so every winner is smaller than the EV model assumed.
//
// Resting a limit sell at the target from the moment of entry removes both: the
// exchange matches at exactly the target price, with no polling in the profit path.
//
// The cost is a real order-lifecycle state machine. The invariants are:
//   - A resting TP is accounted EXACTLY ONCE, at its terminal state. While it is OPEN or
//     PARTIALLY_FILLED nothing is booked, so partial fills cannot be double counted.
//   - Any other exit (stop, time, emergency) MUST cancel the TP and confirm the cancel
//     before market-selling. The resting order locks the base asset; selling first would
//     be rejected for insufficient balance and leave the position stuck.
//   - If the cancel reveals the TP filled in the meantime, that fill is booked as
//     TARGET_1 and the exit is re-evaluated on the next cycle rather than forced.

const TP_TERMINAL_STATUSES = ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED", "REJECTED", "EXPIRED"];

// v5.3: active pWin calibration, loaded once per cycle. Falls back to the identity, so a
// missing table or a failed read can never change trading behavior.
let calibrationCache: { model: CalibrationModel; expires: number } | null = null;
async function loadScalpCalibration(): Promise<CalibrationModel> {
  if (calibrationCache && calibrationCache.expires > Date.now()) return calibrationCache.model;
  let model: CalibrationModel = { ...IDENTITY_CALIBRATION };
  try {
    const rows = await db("scalp_calibration_profiles?active=eq.true&select=slope,intercept,train_samples&limit=1");
    const row = rows?.[0];
    if (row) {
      model = {
        ...IDENTITY_CALIBRATION,
        a: finite(row.slope, 1) || 1,
        b: finite(row.intercept, 0),
        samples: finite(row.train_samples, 0),
      };
    }
  } catch {
    // Table absent or unreadable: stay on the identity.
  }
  calibrationCache = { model, expires: Date.now() + 60_000 };
  return model;
}

/**
 * v5.4: base-asset quantity locked by the bot's OWN resting orders, per asset.
 *
 * Every identifier this system creates starts with the bot prefix, and the gateway
 * refuses to touch any order that does not. So an open order carrying that prefix is
 * definitionally ours, and the quantity it reserves must be counted as still held —
 * otherwise the reconciliation reads our own working orders as a user locking the coin.
 *
 * Falls back to parsing the raw exchange payload when the gateway predates the
 * normalized remaining-volume field, and returns an empty map on any failure so a
 * transient error can never manufacture a mismatch.
 */
/**
 * v5.4: real per-side taker fee for this account, in percent.
 *
 * FEE_PCT was a hardcoded list price (Upbit 0.05, Binance 0.10). Binance applies a 25%
 * discount when fee payment in BNB is enabled, VIP tiers move both sides, and some pairs
 * run promotions. Required win rate is a direct function of cost, so an assumed fee
 * mis-sizes every barrier the geometry module produces. Falls back to FEE_PCT on any
 * failure, and never blocks a cycle.
 */
const feeCache: Partial<Record<Exchange, { pct: number; expires: number }>> = {};
async function liveFeePct(exchange: Exchange, settings: TradingSettings): Promise<number> {
  if ((settings as any).scalp_use_live_fees === false) return FEE_PCT[exchange];
  const cached = feeCache[exchange];
  if (cached && cached.expires > Date.now()) return cached.pct;
  let pct = FEE_PCT[exchange];
  try {
    const fees = await gateway(exchange, { action: "fees" });
    const taker = finite(fees?.taker_pct, NaN);
    // Sanity band: a reported rate outside it means the payload changed shape, not that
    // trading suddenly became free.
    if (Number.isFinite(taker) && taker >= 0 && taker <= 1) pct = taker;
  } catch {
    // Gateway may predate the `fees` action; keep the static assumption.
  }
  feeCache[exchange] = { pct, expires: Date.now() + 30 * 60_000 };
  return pct;
}

async function botLockedQuantities(exchange: Exchange, positions: Position[]): Promise<Map<string, number>> {
  const locked = new Map<string, number>();
  try {
    const rows = await gateway(exchange, { action: "open_orders" });
    const ours = new Set(
      ((await db(`trading_orders?exchange=eq.${exchange}&state=in.(REQUESTED,ACCEPTED,OPEN,PARTIAL,APPLIED)&select=identifier`).catch(() => [])) as any[])
        .map((row) => String(row.identifier || "")),
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const clientId = String(row?.client_order_id || "");
      // Prefix match is the authoritative test; the ledger lookup is a second confirmation
      // and never a requirement, because an order can exist on the exchange a moment
      // before our row is written.
      if (!clientId.startsWith(BOT_ORDER_PREFIX) && !ours.has(clientId)) continue;
      const side = String(row?.side ?? row?.raw?.side ?? "").toUpperCase();
      if (side && !["SELL", "ASK"].includes(side)) continue;
      const raw = row?.raw || {};
      const remaining = finite(
        row?.remaining_volume,
        finite(raw.remaining_volume, Math.max(0, finite(raw.origQty, finite(raw.volume)) - finite(raw.executedQty, finite(raw.executed_volume)))),
      );
      if (!(remaining > 0)) continue;
      const market = String(row?.market ?? raw.market ?? raw.symbol ?? "");
      const asset = baseAsset(exchange, market) ||
        positions.find((p) => p.market === market)?.base_asset || "";
      if (!asset) continue;
      locked.set(asset, (locked.get(asset) || 0) + remaining);
    }
  } catch {
    // Unreadable open orders must not be treated as evidence of anything.
    return new Map();
  }
  return locked;
}

function scalpHoldConfig(settings: TradingSettings, exchange: Exchange): ScalpHoldConfig {
  return resolveHoldConfig({
    alphaHalfLifeMinutes: finite((settings as any).scalp_hold_alpha_half_life_minutes, 12),
    minEdgeAfterExpected: finite((settings as any).scalp_hold_min_edge_after_expected, 0.0005),
    reversalImbalance: finite((settings as any).scalp_hold_reversal_imbalance, -0.25),
    reversalConfirmations: finite((settings as any).scalp_hold_reversal_confirmations, 2),
    safetyTtlMinutes: finite((settings as any).scalp_safety_ttl_minutes, 360),
    // One side only: the entry leg is sunk cost and must not be charged again.
    exitCostFraction: FEE_PCT[exchange] / 100 + finite((settings as any).scalp_slippage_allowance, 0.0009) / 2,
  });
}

function restingTpEnabled(settings: TradingSettings, position: Position): boolean {
  return String((settings as any).strategy || "") === "SCALP" &&
    (settings as any).scalp_resting_tp === true &&
    !position.is_paper;
}

function restingTpIdentifier(position: Position): string | null {
  const id = position.metadata?.tp_identifier;
  return typeof id === "string" && id ? id : null;
}

/** Place the first-target limit sell immediately after the entry fill is booked. */
async function placeRestingTakeProfit(position: Position, settings: TradingSettings, cycleId: string): Promise<Position> {
  if (!restingTpEnabled(settings, position) || restingTpIdentifier(position)) return position;
  const target = finite(position.target_1);
  const step = finite(position.quantity_step, 0.00000001);
  const remaining = finite(position.remaining_quantity);
  if (!(target > 0 && remaining > 0)) return position;
  const qty = floorToStep(t1SellQuantity(finite(position.initial_quantity), remaining, finite(position.t1_allocation_pct, 60)), step);
  const minNotional = finite(position.min_notional_quote, position.exchange === "upbit" ? 5000 : 10);
  // Both the TP slice AND the remainder must clear the exchange minimum, otherwise the
  // runner becomes un-sellable dust. If they cannot, fall back to the polling exit path.
  if (!(qty > 0) || qty * target < minNotional || (remaining - qty) * target < minNotional) {
    await event("TP_REST_SKIPPED", `${position.exchange}:${position.market} resting TP below exchange minimum`, { qty, target, minNotional }, { cycleId, positionId: position.id });
    return position;
  }
  const identifier = uniqueId("tp", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id, candidate_id: position.candidate_id, cycle_id: cycleId, exchange: position.exchange,
    quote_currency: position.quote_currency, identifier, market: position.market, side: "SELL", purpose: "TARGET_1",
    order_type: "LIMIT", time_in_force: position.exchange === "binance" ? "GTC" : null,
    requested_price: target, requested_volume: qty, requested_notional_quote: qty * target, state: "REQUESTED",
  });
  try {
    const result = await gateway(position.exchange, {
      action: "create_order",
      order: {
        market: position.market, side: "SELL", type: "LIMIT", price: target, quantity: qty, identifier,
        // Upbit rests plain limit orders by default and only accepts ioc/fok here, so the
        // field is omitted. The Binance path defaults to IOC when unset, so GTC is explicit.
        ...(position.exchange === "binance" ? { time_in_force: "GTC" } : {}),
      },
      wait_for_final_ms: 0,
    }, 20_000);
    await updateOrderFromGateway(orderRow, result);
    const updated = await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: { ...(position.metadata || {}), tp_identifier: identifier, tp_order_id: orderRow.id, tp_price: target, tp_quantity: qty, tp_placed_at: new Date().toISOString() },
    });
    await event("TP_RESTED", `${position.exchange}:${position.market} resting take-profit placed`, { price: target, quantity: qty, identifier }, { cycleId, positionId: position.id, orderId: orderRow.id });
    return { ...position, ...(updated[0] || {}) } as Position;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patch("trading_orders", `id=eq.${orderRow.id}`, { state: "REJECTED", error_message: message, completed_at: new Date().toISOString() });
    // Non-fatal: the position simply keeps the v5.2.5 polling exit behavior.
    await event("TP_REST_FAILED", `${position.exchange}:${position.market} resting take-profit rejected`, { error: message }, { cycleId, positionId: position.id, level: "WARNING" });
    return position;
  }
}

/** Book a resting TP that has reached a terminal state. Returns the refreshed position. */
async function settleRestingTakeProfit(position: Position, order: any, cycleId: string): Promise<Position> {
  const orderRow = (await db(`trading_orders?id=eq.${position.metadata?.tp_order_id}&select=*&limit=1`))[0];
  if (!orderRow) return position;
  const updated = await updateOrderFromGateway(orderRow, order);
  const clearMeta = { ...(position.metadata || {}), tp_identifier: null, tp_settled_at: new Date().toISOString() };
  if (finite(updated.fill.executedVolume) > 0) {
    const result = await finalizeExitFill(position, { orderRow: updated.row, ...updated }, "TARGET_1", finite(position.target_1), cycleId);
    const next = (result as any)?.position || position;
    const rows = await patch("trading_positions", `id=eq.${next.id}`, { metadata: { ...(next.metadata || {}), ...clearMeta } });
    return { ...next, ...(rows[0] || {}) } as Position;
  }
  const rows = await patch("trading_positions", `id=eq.${position.id}`, { metadata: clearMeta });
  return { ...position, ...(rows[0] || {}) } as Position;
}

/** Poll a live resting TP. Books it only once it is terminal. */
async function syncRestingTakeProfit(position: Position, cycleId: string): Promise<Position> {
  const identifier = restingTpIdentifier(position);
  if (!identifier) return position;
  let order: any;
  try {
    order = await gateway(position.exchange, { action: "get_order", identifier, market: position.market });
  } catch (error) {
    // Transport failure: leave the order in place and retry next cycle. Never assume it
    // is gone — assuming that and re-selling is how duplicate exits happen.
    await event("TP_SYNC_ERROR", `${position.exchange}:${position.market} resting TP query failed`, { error: error instanceof Error ? error.message : String(error) }, { cycleId, positionId: position.id, level: "WARNING" });
    return position;
  }
  const status = String(order?.status || order?.order?.status || "");
  if (!TP_TERMINAL_STATUSES.includes(status)) return position;
  return settleRestingTakeProfit(position, order, cycleId);
}

/**
 * Cancel the resting TP and confirm it is terminal before any market exit.
 * Returns false when the caller must NOT proceed to sell this cycle.
 */
async function cancelRestingTakeProfit(position: Position, cycleId: string): Promise<{ ok: boolean; position: Position }> {
  const identifier = restingTpIdentifier(position);
  if (!identifier) return { ok: true, position };
  let terminal: any = null;
  for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
    try {
      const result = attempt === 0
        ? await gateway(position.exchange, { action: "cancel_order", identifier, market: position.market })
        : await gateway(position.exchange, { action: "get_order", identifier, market: position.market });
      const status = String(result?.status || result?.order?.status || "");
      if (TP_TERMINAL_STATUSES.includes(status)) terminal = result;
    } catch (error) {
      // A cancel can legitimately fail because the order already filled; the follow-up
      // get_order resolves which case this is.
      await event("TP_CANCEL_RETRY", `${position.exchange}:${position.market} resting TP cancel attempt failed`, { attempt, error: error instanceof Error ? error.message : String(error) }, { cycleId, positionId: position.id, level: "WARNING" });
    }
  }
  if (!terminal) {
    await event("TP_CANCEL_UNRESOLVED", `${position.exchange}:${position.market} resting TP not confirmed cancelled; exit deferred`, { identifier }, { cycleId, positionId: position.id, level: "CRITICAL" });
    return { ok: false, position };
  }
  return { ok: true, position: await settleRestingTakeProfit(position, terminal, cycleId) };
}

async function snapshotAccount(exchange: Exchange, portfolio: any, positions: Position[], prices: Record<string, number>, settings: TradingSettings) {
  let openCost = 0; let unrealized = 0;
  const paper = settings.mode !== "LIVE_LIMITED";
  for (const position of positions.filter((row) => row.exchange === exchange && row.is_paper === paper)) {
    const qty = finite(position.remaining_quantity); const entry = finite(position.average_entry_price); const current = finite(prices[position.market], entry);
    openCost += qty * entry; unrealized += qty * (current - entry);
  }
  const botPositionValue = positions
    .filter((row) => row.exchange === exchange && row.is_paper === paper)
    .reduce((sum, position) => sum + Math.max(0, finite(position.remaining_quantity)) * Math.max(0, finite(prices[position.market], position.average_entry_price)), 0);
  const capitalBaseQuote = Math.max(0, finite(portfolio.available_quote)) + Math.max(0, finite(portfolio.locked_quote)) + botPositionValue;
  const config = allocationConfig(settings, exchange);
  const managed = calculateManagedCapital({
    capitalBaseQuote, availableQuote: finite(portfolio.available_quote), openCostQuote: Math.max(openCost, botPositionValue),
    allocationMode: config.mode === "FIXED" ? "FIXED" : "ALL", fixedAllocationQuote: config.fixed, reserveQuote: config.reserve,
  });
  await db("trading_account_snapshots", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
    exchange, quote_currency: quoteCurrency(exchange), total_equity_quote: finite(portfolio.total_equity_quote), available_quote: finite(portfolio.available_quote), locked_quote: finite(portfolio.locked_quote),
    bot_open_cost_quote: openCost, bot_unrealized_pnl_quote: unrealized, capital_base_quote: managed.capitalBaseQuote, managed_capital_quote: managed.managedCapitalQuote,
    managed_available_quote: managed.managedAvailableQuote, protected_reserve_quote: managed.protectedReserveQuote, allocation_mode: managed.allocationMode,
    balances: portfolio.accounts || [], prices: { ...(portfolio.prices || {}), ...prices },
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
async function finalizeExitFill(position: Position, result: any, action: string, fallbackPrice: number, cycleId: string, breakevenAfterT1 = true) {
  const applied = await applyExitAccounting(position, result.orderRow, result.fill || {}, action, fallbackPrice, breakevenAfterT1); const updated = applied.position;
  await event(applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT", `${position.exchange}:${position.market} ${action}`, {
    price: applied.fillPrice, sold_quantity: applied.quantity, remaining: finite(updated?.remaining_quantity), pnl_quote: finite(updated?.realized_pnl_quote), quote: position.quote_currency, accounting_applied: applied.applied,
  }, { cycleId, positionId: position.id, orderId: result.orderRow.id });
  return { action, exchange: position.exchange, market: position.market, closed: applied.closed, position: updated };
}
async function applyExit(position: Position, price: number, action: string, cycleId: string, breakevenAfterT1 = true) {
  let quantity = action === "TARGET_1" ? t1SellQuantity(position.initial_quantity, position.remaining_quantity, position.t1_allocation_pct) : finite(position.remaining_quantity);
  const minNotional = finite(position.min_notional_quote, position.exchange === "upbit" ? 5000 : 10);
  if (quantity * price < minNotional || (position.remaining_quantity - quantity) * price < minNotional) quantity = position.remaining_quantity;
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) return { action: "NONE", reason: "zero sell quantity" };
  if (!position.is_paper) position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, { state: "EXITING", metadata: { ...(position.metadata || {}), pending_exit_action: action, pending_exit_at: new Date().toISOString() } }))[0] };
  const result = position.is_paper ? await sellPaper(position, quantity, price, action, cycleId) : await sellLive(position, quantity, action, cycleId);
  return finalizeExitFill(position, result, action, price, cycleId, breakevenAfterT1);
}

async function reconcileEntryPending(position: Position, cycleId: string) {
  if (position.is_paper) return;
  const orderRow = (await db(`trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&select=*&order=created_at.desc&limit=1`))[0];
  if (!orderRow) {
    const createdAt = new Date((position as any).created_at || 0).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30_000) {
      await patch("trading_positions", `id=eq.${position.id}`, { state: "CANCELLED", close_reason: "ORPHAN_ENTRY_PENDING", closed_at: new Date().toISOString() });
      await event("ORPHAN_ENTRY_CANCELLED", `${position.exchange}:${position.market} orphan pending entry cleared`, {}, { cycleId, positionId: position.id, level: "WARNING" });
    }
    return;
  }
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

async function reconcileManualReduction(position: Position, actualQuantity: number, currentPrice: number, cycleId: string) {
  const previous = Math.max(0, finite(position.remaining_quantity));
  const actual = Math.max(0, Math.min(previous, finite(actualQuantity)));
  const missing = Math.max(0, previous - actual);
  if (!(missing > Math.max(1e-10, previous * 1e-7))) return position;
  const estimatedValue = missing * Math.max(0, finite(currentPrice, position.average_entry_price));
  const dust = position.exchange === "upbit" ? 1000 : 1;
  const closed = actual * Math.max(0, finite(currentPrice, position.average_entry_price)) < dust;
  const entryOrder = (await db(`trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&state=eq.APPLIED&select=executed_funds_quote,paid_fee_quote&order=created_at.asc&limit=1`).catch(() => []))[0];
  const accounting = manualReconcileAccounting({
    initialQuantity: finite(position.initial_quantity),
    actualQuantity: closed ? 0 : actual,
    originalEntryCostQuote: finite(entryOrder?.executed_funds_quote, position.realized_cost_quote),
    originalEntryFeeQuote: finite(entryOrder?.paid_fee_quote),
  });
  const metadata = {
    ...(position.metadata || {}),
    exclude_from_learning: true,
    manual_reconcile: { detected_at: new Date().toISOString(), previous_quantity: previous, actual_quantity: actual, missing_quantity: missing, estimated_value_quote: estimatedValue },
  };
  const values: JsonRecord = {
    remaining_quantity: closed ? 0 : actual,
    realized_cost_quote: accounting.remainingCostQuote,
    realized_proceeds_quote: accounting.realizedProceedsQuote,
    paid_fees_quote: accounting.remainingEntryFeeQuote,
    realized_pnl_quote: accounting.realizedPnlQuote,
    metadata,
    ...(closed ? { state: "CLOSED", close_reason: "MANUAL_RECONCILE", closed_at: new Date().toISOString() } : {}),
  };
  const updated = (await patch("trading_positions", `id=eq.${position.id}`, values))[0] || { ...position, ...values };
  await insert("trading_cash_flows", {
    exchange: position.exchange, quote_currency: position.quote_currency, flow_type: "MANUAL_POSITION_REDUCTION",
    amount_quote: estimatedValue, details: { position_id: position.id, market: position.market, base_asset: position.base_asset, previous_quantity: previous, actual_quantity: actual, estimated_price: currentPrice },
  });
  await event("MANUAL_POSITION_REDUCTION", `${position.exchange}:${position.market} manual balance reduction reconciled`, {
    previous_quantity: previous, actual_quantity: actual, missing_quantity: missing, estimated_value_quote: estimatedValue, closed,
  }, { cycleId, positionId: position.id, level: "CRITICAL" });
  return updated;
}

async function detectExternalQuoteFlow(exchange: Exchange, portfolio: any, settings: TradingSettings & JsonRecord, cycleId: string) {
  const rows = await db(`trading_account_snapshots?exchange=eq.${exchange}&select=available_quote,captured_at&order=captured_at.desc&limit=1`) as any[];
  const last = rows?.[0];
  if (!last) return { detected: false, delta: 0, baseline: "INITIAL" };
  const since = String(last.captured_at || "");
  const snapshotAt = new Date(since).getTime();
  // A stale snapshot after deploy/restart is not evidence of manual trading. The
  // current monitor cycle will write a fresh snapshot and establish a new baseline.
  if (!Number.isFinite(snapshotAt) || Date.now() - snapshotAt > 120_000) {
    await event("BALANCE_BASELINE_RESET", `${exchange} stale balance snapshot replaced without pausing trading`, {
      previous_snapshot_at: since, current_available_quote: finite(portfolio.available_quote), engine_version: VERSION,
    }, { cycleId, level: "INFO" });
    return { detected: false, delta: 0, baseline: "RESET" };
  }
  const orders = await db(`trading_orders?exchange=eq.${exchange}&state=eq.APPLIED&requested_at=gte.${encodeURIComponent(since)}&select=side,executed_funds_quote,paid_fee_quote,trading_positions!inner(is_paper)&trading_positions.is_paper=eq.false`) as any[];
  let expectedOrderDelta = 0;
  for (const order of orders || []) {
    const funds = Math.max(0, finite(order.executed_funds_quote));
    const fee = Math.max(0, finite(order.paid_fee_quote));
    expectedOrderDelta += String(order.side).toUpperCase() === "SELL" ? funds - fee : -(funds + fee);
  }
  const previous = finite(last.available_quote);
  const current = finite(portfolio.available_quote);
  const expected = previous + expectedOrderDelta;
  const externalDelta = current - expected;
  const threshold = exchange === "upbit" ? 5000 : 5;
  if (Math.abs(externalDelta) < threshold) return { detected: false, delta: externalDelta };
  const flowType = externalDelta < 0 ? "EXTERNAL_DECREASE" : "EXTERNAL_INCREASE";
  await insert("trading_cash_flows", {
    exchange, quote_currency: quoteCurrency(exchange), flow_type: flowType, amount_quote: Math.abs(externalDelta),
    details: { previous_available_quote: previous, expected_available_quote: expected, current_available_quote: current, bot_order_delta_quote: expectedOrderDelta, previous_snapshot_at: since, withdrawal_mode: settings.withdrawal_mode, detection_mode: "RECORD_ONLY", engine_version: VERSION },
  });
  // Quote-balance deltas are informational. Deposits, fee rebates, conversions,
  // gateway changes and delayed snapshots can all produce them. They must never
  // be treated as proof of a manual trade or automatically pause the engine.
  await event(flowType, `${exchange} quote balance delta recorded; trading remains active`, {
    external_delta_quote: externalDelta, previous, expected, current, auto_pause: false,
  }, { cycleId, level: "WARNING" });
  return { detected: true, delta: externalDelta, flow_type: flowType, paused: false };
}

async function monitorCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const tracked = await db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=*&order=created_at.asc") as Position[];
  for (const position of tracked.filter((p) => p.state === "ENTRY_PENDING")) await reconcileEntryPending(position, cycleId);
  for (const position of tracked.filter((p) => p.state === "EXITING")) await reconcileExitPending(position, cycleId);
  const open = await db("trading_positions?state=eq.OPEN&select=*&order=created_at.asc") as Position[];
  const actions: any[] = []; const prices: Record<string, number> = {}; const portfolios: Partial<Record<Exchange, any>> = {};
  const books: Record<string, any> = {};
  const unresolvedManualAssets: string[] = [];
  for (const exchange of ["upbit", "binance"] as Exchange[]) {
    const exchangePositions = open.filter((p) => p.exchange === exchange);
    const exchangeEnabled = exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled;
    // Disabling an exchange blocks new entries only. Existing positions must remain monitored and exit-capable.
    if (!exchangeEnabled && exchangePositions.length === 0) continue;
    const portfolio = await gateway(exchange, { action: "portfolio" }); portfolios[exchange] = portfolio;
    await detectExternalQuoteFlow(exchange, portfolio, settings, cycleId);
    const totalByAsset = new Map<string, number>();
    const freeByAsset = new Map<string, number>();
    for (const account of portfolio.accounts || []) {
      const asset = String(account.currency || account.asset || "").toUpperCase();
      const free = Math.max(0, finite(account.balance ?? account.free));
      const locked = Math.max(0, finite(account.locked));
      freeByAsset.set(asset, free);
      totalByAsset.set(asset, free + locked);
    }
    const quotes = await Promise.all(exchangePositions.map(async (position) => [position.market, await marketQuote(exchange, position.market)] as const));
    // v5.4: retain the full book, not just the price. The holding decision is made from
    // the live orderbook; discarding it here is what forced the fallback to a wall clock.
    for (const [market, quote] of quotes) {
      prices[market] = finite(quote.current, (finite(quote.best_ask) + finite(quote.best_bid)) / 2);
      books[market] = quote;
    }
    // v5.4 ---------------------------------------------------------------------------
    // The bot's OWN open orders lock base asset. v5.2.5 compared `expected` against the
    // FREE balance, so any bot-placed resting sell (and every in-flight exit) looked like
    // a user had locked the coin, and after 3 checks — 45 seconds — it set
    // manual_intervention_required, which halts NEW ENTRIES ON EVERY MARKET AND BOTH
    // EXCHANGES. A bot doing its job could therefore shut the whole system down.
    //
    // Fix, in two parts:
    //   1) Add the quantity locked by our own orders back before comparing.
    //   2) A locked-but-present asset is never a global halt. Only an asset that has
    //      actually LEFT the account is, and even then the pause is scoped to that asset
    //      unless the pattern is systemic (several assets at once => wrong account, key
    //      change, or exchange-side problem).
    const botLockedByAsset = await botLockedQuantities(exchange, exchangePositions);
    const mismatches = new Set<string>();
    const vanishedAssets = new Set<string>();
    for (const originalPosition of exchangePositions.filter((row) => !row.is_paper)) {
      let position = originalPosition;
      // Only a position backed by a successfully APPLIED entry fill may be
      // compared with exchange balances. Ghost/legacy rows are cancelled rather
      // than mislabeled as a user manual sale.
      const appliedEntry = (await db(`trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&state=eq.APPLIED&select=id&limit=1`).catch(() => []))[0];
      if (!appliedEntry) {
        await patch("trading_positions", `id=eq.${position.id}`, {
          state: "CANCELLED", close_reason: "UNVERIFIED_OPEN_POSITION", closed_at: new Date().toISOString(),
          metadata: { ...(position.metadata || {}), exclude_from_learning: true, verification_error: "NO_APPLIED_ENTRY_ORDER" },
        });
        await event("UNVERIFIED_POSITION_CANCELLED", `${exchange}:${position.market} unverified internal position cleared without pausing trading`, {}, { cycleId, positionId: position.id, level: "WARNING" });
        continue;
      }
      const expected = finite(position.remaining_quantity);
      const actualTotal = totalByAsset.get(position.base_asset) || 0;
      const actualFree = freeByAsset.get(position.base_asset) || 0;
      const botLocked = botLockedByAsset.get(position.base_asset) || 0;
      // Quantity we ourselves put beyond reach counts as present.
      const effectiveFree = actualFree + botLocked;

      // v5.4.1: fee-sized shortfalls are OUR OWN accounting, not a user's trade.
      //
      // Binance deducts the buy commission from the base asset, so the account legitimately
      // holds ~0.1% less than the matched quantity. v5.2.5 compared against a 0.0001%
      // tolerance, so every Binance entry drifted into "the coin is gone" and, 45 seconds
      // later, halted the entire system. Entries booked from v5.4.1 onward are already net
      // of that commission; this tolerance heals positions opened before the fix and any
      // step-size rounding dust.
      const shortfall = Math.max(0, expected - actualTotal);
      const feeDustTolerance = Math.max(
        finite(position.quantity_step, 0) * 2,
        expected * FEE_PCT[exchange] / 100 * 3,
      );
      if (shortfall > 0 && shortfall <= feeDustTolerance) {
        const healed = Math.max(0, expected - shortfall);
        position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, {
          remaining_quantity: healed,
          metadata: { ...(position.metadata || {}), account_mismatch_count: 0, last_account_mismatch_at: null, fee_dust_healed_quantity: shortfall, fee_dust_healed_at: new Date().toISOString() },
        }))[0] };
        await event("LEDGER_FEE_DUST_HEALED", `${exchange}:${position.market} ledger aligned to account; shortfall within fee tolerance`, {
          expected_quantity: expected, actual_quantity: actualTotal, shortfall, tolerance: feeDustTolerance, healed_quantity: healed,
        }, { cycleId, positionId: position.id, level: "INFO" });
        continue;
      }

      const totalMissing = actualTotal + 1e-10 < expected * 0.999999;
      const freeMissing = !totalMissing && effectiveFree + 1e-10 < expected * 0.999999;
      const previousCount = Math.max(0, Math.floor(finite(position.metadata?.account_mismatch_count)));
      if (!totalMissing && !freeMissing) {
        if (previousCount > 0) await patch("trading_positions", `id=eq.${position.id}`, { metadata: { ...(position.metadata || {}), account_mismatch_count: 0, last_account_mismatch_at: null } });
        continue;
      }
      if (freeMissing && botLocked > 0) {
        // Partially explained by our own orders but still short: record it and keep
        // watching. Never escalate a lock we are partly responsible for.
        await event("ACCOUNT_LOCK_PARTIALLY_EXPLAINED", `${exchange}:${position.market} lock partially explained by bot orders`, {
          expected_quantity: expected, free_quantity: actualFree, bot_locked_quantity: botLocked, total_quantity: actualTotal,
        }, { cycleId, positionId: position.id, level: "INFO" });
      }
      const mismatchCount = previousCount + 1;
      position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, {
        metadata: { ...(position.metadata || {}), account_mismatch_count: mismatchCount, last_account_mismatch_at: new Date().toISOString(), observed_total_quantity: actualTotal, observed_free_quantity: actualFree },
      }))[0] };
      if (mismatchCount < 3) {
        await event("ACCOUNT_MISMATCH_OBSERVED", `${exchange}:${position.market} balance mismatch awaiting confirmation ${mismatchCount}/3`, {
          expected_quantity: expected, free_quantity: actualFree, total_quantity: actualTotal,
        }, { cycleId, positionId: position.id, level: "WARNING" });
        continue;
      }
      mismatches.add(position.base_asset);
      if (totalMissing) {
        vanishedAssets.add(position.base_asset);
        await reconcileManualReduction(position, actualTotal, prices[position.market], cycleId);
      } else {
        unresolvedManualAssets.push(`${exchange}:${position.base_asset}`);
        // Locked but present, and NOT explained by our own orders. That is a user limit
        // order on this coin — a reason to leave this asset alone, not to stop trading.
        await event("MANUAL_ASSET_LOCK", `${exchange}:${position.market} base-asset lock not explained by bot orders`, {
          expected_quantity: expected, free_quantity: actualFree, bot_locked_quantity: botLocked, total_quantity: actualTotal, scope: "ASSET_ONLY",
        }, { cycleId, positionId: position.id, level: "WARNING" });
      }
    }
    if (mismatches.size) {
      // Scope the pause to the affected assets. enterCandidate skips these; every other
      // market keeps trading.
      const previousLocks = Array.isArray((settings as any).manual_asset_locks) ? (settings as any).manual_asset_locks : [];
      const nextLocks = [...new Set([...previousLocks, ...[...mismatches].map((asset) => `${exchange}:${asset}`)])];
      // Escalate to a full halt only when the pattern is systemic: an asset that actually
      // left the account, and more than one of them. One manual sale is not a system fault.
      const systemic = vanishedAssets.size >= 2 ||
        (vanishedAssets.size >= 1 && vanishedAssets.size >= Math.ceil(exchangePositions.length / 2) && exchangePositions.length >= 2);
      await patch("trading_settings", "id=eq.1", {
        manual_asset_locks: nextLocks,
        ...(systemic
          ? { pause_new_entries: true, manual_intervention_required: true, manual_event_reason: `SAFETY_POSITION_MISMATCH:${exchange}:${[...vanishedAssets].join(",")}`, last_manual_event_at: new Date().toISOString() }
          : {}),
      });
      await event(systemic ? "SAFETY_PAUSE" : "ASSET_SCOPED_PAUSE",
        systemic
          ? `${exchange} multiple positions vanished from the account; all entries paused`
          : `${exchange} entries paused for affected assets only; other markets continue`,
        { exchange, assets: [...mismatches], vanished: [...vanishedAssets], scope: systemic ? "GLOBAL" : "ASSET", source: "ACCOUNT_RECONCILIATION" },
        { cycleId, level: systemic ? "CRITICAL" : "WARNING" });
    }
    for (const original of exchangePositions) {
      let position = original;
      if (!position.is_paper && mismatches.has(position.base_asset)) { actions.push({ exchange, market: position.market, action: "PAUSED", reason: "account mismatch" }); continue; }
      const current = prices[position.market]; if (!(current > 0)) continue;
      const peak = Math.max(current, finite(position.peak_price, position.average_entry_price)); const trough = Math.min(current, finite(position.trough_price, position.average_entry_price));
      const values: JsonRecord = { peak_price: peak, trough_price: trough };
      if (position.t1_completed && position.exit_policy === "TRAIL_AFTER_T1") values.trailing_stop = nextTrailingStop(position.trailing_stop, peak, finite(position.trailing_distance_pct, 1.2), position.stop_price);
      if (peak !== finite(position.peak_price) || trough !== finite(position.trough_price) || values.trailing_stop) position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0] };
      // v5.3: settle a resting take-profit that has reached a terminal state before
      // deciding anything else, so the position's remaining quantity is current.
      if (restingTpEnabled(settings, position)) {
        position = await syncRestingTakeProfit(position, cycleId);
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) {
          actions.push({ exchange, market: position.market, action: "TARGET_1", reason: "resting take-profit filled" });
          continue;
        }
      }
      let decision = decideExit(position, current, Date.now(), settings.emergency_liquidation);
      // v5.4: replace the fixed time exit with a live-edge test.
      //
      // decideExit() still returns TIME_EXIT at max_holding_at, but for SCALP that column
      // now holds the operator's SAFETY TTL (default 6h), not a 30-minute trading rule.
      // Everything between entry and that backstop is decided by whether the reason for
      // the trade is still true.
      if ((settings as any).strategy === "SCALP" && decision.action === "NONE" && !settings.emergency_liquidation) {
        const holdCfg = scalpHoldConfig(settings, exchange);
        const book = books[position.market];
        const liveImbalance = book
          ? topOfBookImbalance(
            (book.bids || []).map((b: any) => ({ price: finite(b.price ?? b[0]), size: finite(b.size ?? b[1]) })),
            (book.asks || []).map((a: any) => ({ price: finite(a.price ?? a[0]), size: finite(a.size ?? a[1]) })),
          )
          : 0;
        const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
        const heldMinutes = Number.isFinite(openedAt) ? Math.max(0, (Date.now() - openedAt) / 60_000) : 0;
        const hold = evaluateHold({
          entryPrice: finite(position.average_entry_price),
          currentPrice: current,
          targetPrice: finite(position.target_2, finite(position.target_1)),
          stopPrice: Math.max(finite(position.stop_price), finite(position.trailing_stop)),
          entryPWin: finite(position.metadata?.scalp_signal?.order_p_win, holdCfg.basePWin),
          liveImbalance,
          reversalStreak: Math.max(0, Math.floor(finite(position.metadata?.hold_reversal_streak))),
          heldMinutes,
          expectedMinutes: finite(position.metadata?.scalp_expected_minutes, 0),
          t1Completed: position.t1_completed === true,
        }, holdCfg);

        if (hold.reversalStreak !== finite(position.metadata?.hold_reversal_streak)) {
          position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: { ...(position.metadata || {}), hold_reversal_streak: hold.reversalStreak, last_hold_edge: hold.liveEdge, last_hold_p_win: hold.livePWin, last_hold_at: new Date().toISOString() },
          }))[0] };
        }
        if (hold.action === "EXIT") {
          decision = { action: "STOP", fraction: 1, reason: `live_hold:${hold.reason}` } as any;
          await event("SCALP_HOLD_EXIT", `${exchange}:${position.market} live edge exhausted`, {
            reason: hold.reason, live_edge: hold.liveEdge, live_p_win: hold.livePWin, held_minutes: heldMinutes,
            expected_minutes: finite(position.metadata?.scalp_expected_minutes, 0), live_imbalance: liveImbalance,
          }, { cycleId, positionId: position.id, level: "INFO" });
        } else if (hold.action === "TIGHTEN" && position.t1_completed) {
          // Pull the trail up to just under the current price instead of dumping.
          const tightened = Math.max(finite(position.trailing_stop), current * (1 - Math.max(0.001, holdCfg.exitCostFraction * 2)));
          if (tightened > finite(position.trailing_stop)) {
            position = { ...position, ...(await patch("trading_positions", `id=eq.${position.id}`, { trailing_stop: tightened }))[0] };
            await event("SCALP_HOLD_TIGHTEN", `${exchange}:${position.market} trail tightened on faded edge`, { reason: hold.reason, trailing_stop: tightened, live_edge: hold.liveEdge }, { cycleId, positionId: position.id });
          }
        }
      }
      // The resting order owns the first target. Without this the 15s poll would ALSO
      // fire a market TARGET_1 and the position would be sold twice.
      if (decision.action === "TARGET_1" && restingTpIdentifier(position)) {
        decision = { action: "NONE", fraction: 0, reason: "first target handled by resting order" } as any;
      }
      // Independent scalp backstop: no single position may lose more than the
      // operator-selected percentage, even if the normal stop failed or moved.
      if ((settings as any).strategy === "SCALP" && position.average_entry_price > 0) {
        const lossPct = (current - position.average_entry_price) / position.average_entry_price * 100;
        const maxSingleLossPct = Math.abs(finite((settings as any).scalp_max_single_loss_pct, 5));
        if (lossPct <= -maxSingleLossPct) {
          decision = { action: "STOP", reason: "scalp_max_single_loss" } as any;
        }
      }
      if (decision.action === "NONE") continue;
      // v5.3: the resting sell locks the base asset. Cancel and CONFIRM before any market
      // exit; a rejected sell would leave the position open with no protection.
      if (restingTpIdentifier(position)) {
        const cancelled = await cancelRestingTakeProfit(position, cycleId);
        position = cancelled.position;
        if (!cancelled.ok) {
          actions.push({ exchange, market: position.market, action: decision.action, error: "resting take-profit cancel unconfirmed; exit deferred one cycle" });
          continue;
        }
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) continue;
        const recheck = decideExit(position, current, Date.now(), settings.emergency_liquidation);
        if (recheck.action === "NONE") continue;
        decision = recheck;
      }
      try { actions.push(await applyExit(position, current, decision.action, cycleId, (settings as any).scalp_breakeven_after_t1 !== false)); }
      catch (error) { actions.push({ exchange, market: position.market, action: decision.action, error: error instanceof Error ? error.message : String(error) }); await event("EXIT_ERROR", error instanceof Error ? error.message : String(error), { decision }, { cycleId, positionId: position.id, level: "CRITICAL" }); }
    }
  }
  const stillOpen = await db("trading_positions?state=eq.OPEN&select=*") as Position[];
  for (const exchange of Object.keys(portfolios) as Exchange[]) await snapshotAccount(exchange, portfolios[exchange], stillOpen, prices, settings);
  await patch("trading_settings", "id=eq.1", { last_monitor_at: new Date().toISOString(), last_gateway_heartbeat_at: new Date().toISOString(), gateway_error_count: 0, ...(settings.emergency_liquidation && stillOpen.length === 0 ? { emergency_liquidation: false, pause_new_entries: true } : {}) });
  return { positions: open.length, actions, unresolved_manual_assets: unresolvedManualAssets };
}

async function scanCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const exchanges = (["upbit", "binance"] as Exchange[]).filter((exchange) => exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled);
  const portfolios = {} as Record<Exchange, any>;
  const stats = {} as Record<Exchange, any>;
  const circuits = {} as Record<Exchange, any>;
  for (const exchange of exchanges) {
    portfolios[exchange] = await managedPortfolio(settings, exchange, await gateway(exchange, { action: "portfolio" }));
    stats[exchange] = await accountStats(exchange, finite(portfolios[exchange].managed.managedCapitalQuote), settings.mode !== "LIVE_LIMITED");
    const limits = exchangeLimits(settings, exchange);
    // In SCALP mode the scalp-specific loss rails are authoritative. Without
    // this override the legacy 1.5% daily / 3% weekly circuit would stop the
    // engine long before the configured -20% scalp day limit.
    const circuitSettings = (settings as any).strategy === "SCALP"
      ? {
        ...settings,
        // Only operator-approved loss rails apply in SCALP. Allocation controls
        // determine exposure; hidden position, entry-count, weekly, and streak caps do not.
        max_open_positions: Number.MAX_SAFE_INTEGER,
        max_open_positions_per_exchange: Number.MAX_SAFE_INTEGER,
        max_daily_entries: Number.MAX_SAFE_INTEGER,
        max_daily_entries_per_exchange: Number.MAX_SAFE_INTEGER,
        max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 20),
        max_weekly_loss_pct: Number.MAX_SAFE_INTEGER,
        max_consecutive_losses: Number.MAX_SAFE_INTEGER,
      }
      : settings;
    circuits[exchange] = evaluateCircuit({
      mode: settings.mode, configured: settings.configured, exchangeEnabled: true, pauseNewEntries: settings.pause_new_entries || settings.withdrawal_mode || settings.manual_intervention_required,
      emergencyLiquidation: settings.emergency_liquidation, availableQuote: finite(portfolios[exchange].managed.managedAvailableQuote), minOrderQuote: limits.minOrder,
      openPositionsGlobal: stats[exchange].openGlobal, openPositionsExchange: stats[exchange].openExchange,
      entriesTodayGlobal: stats[exchange].entriesTodayGlobal, entriesTodayExchange: stats[exchange].entriesTodayExchange,
      dailyBoughtQuote: stats[exchange].dailyBoughtQuote, maxDailyBuyQuote: limits.dailyBuy,
      dailyPnlPct: stats[exchange].dailyPnlPct, weeklyPnlPct: stats[exchange].weeklyPnlPct, consecutiveLosses: stats[exchange].consecutiveLosses, settings: circuitSettings,
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
  const candidates = await loadBuyCandidates(scanId, settings);
  const active = (await db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=exchange,market,base_asset")) as any[];
  const activeMarkets = new Set(active.map((row) => `${row.exchange}:${row.market}`)); const activeBases = new Set(active.map((row) => row.base_asset));
  const entries: any[] = []; const enteredPerExchange: Record<Exchange, number> = { upbit: 0, binance: 0 };
  for (const candidate of candidates) {
    const exchange = candidate.exchange;
    if (!exchanges.includes(exchange) || !circuits[exchange]?.allowNewEntry) continue;
    if (entries.filter((row) => row.entered || row.reserved).length >= settings.max_new_entries_per_scan) break;
    const exchangeCapacity = (settings as any).strategy === "SCALP"
      ? Number.MAX_SAFE_INTEGER
      : Math.min(
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
  const [positions, closedPositions, orders, cycles, snapshots, events, cashFlows, profiles] = await Promise.all([
    db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=*&order=created_at.desc"),
    db("trading_positions?state=eq.CLOSED&select=*&order=closed_at.desc&limit=20"),
    db("trading_orders?select=*&order=created_at.desc&limit=40"),
    db("trading_cycle_runs?select=*&order=started_at.desc&limit=20"),
    db("trading_account_snapshots?select=*&order=captured_at.desc&limit=8"),
    db("trading_events?select=*&order=created_at.desc&limit=50"),
    db("trading_cash_flows?select=*&order=detected_at.desc&limit=20"),
    db("scanner_runtime_profiles?select=version,source,active,parameters,samples,validation_samples,objective,champion_objective,evidence,promoted_at,parent_version&order=version.desc&limit=3").catch(() => []),
  ]);
  const accounts: JsonRecord = {};
  const accountStatsByExchange: JsonRecord = {};
  for (const exchange of ["upbit", "binance"] as Exchange[]) {
    const exchangeEnabled = exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled;
    const hasTrackedPosition = (positions || []).some((row: any) => row.exchange === exchange);
    if (!exchangeEnabled && !hasTrackedPosition) continue;
    try {
      accounts[exchange] = await managedPortfolio(settings, exchange, await gateway(exchange, { action: "portfolio" }));
      accountStatsByExchange[exchange] = await accountStats(exchange, finite(accounts[exchange].managed.managedCapitalQuote), settings.mode !== "LIVE_LIMITED");
    } catch (error) {
      accounts[exchange] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  let health: any;
  try { const res = await fetch(`${GATEWAY_URL}/health`, { headers: { accept: "application/json" } }); health = await res.json(); }
  catch (error) { health = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  let binanceHealth: any = null;
  if (BINANCE_GATEWAY_URL && BINANCE_GATEWAY_URL !== GATEWAY_URL) {
    try { const res = await fetch(`${BINANCE_GATEWAY_URL}/health`, { headers: { accept: "application/json" } }); binanceHealth = await res.json(); }
    catch (error) { binanceHealth = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  return {
    version: VERSION, settings, accounts, account_stats: accountStatsByExchange, positions, recently_closed_positions: closedPositions,
    binance_gateway_health: binanceHealth,
    recent_orders: orders, recent_cycles: cycles, latest_accounts: snapshots, recent_events: events, cash_flows: cashFlows,
    learning: { profiles, active_profile: (profiles || []).find((row: any) => row.active) || profiles?.[0] || null }, gateway: health,
  };
}
async function control(body: JsonRecord, settings: TradingSettings & JsonRecord) {
  const allowed: JsonRecord = {};
  const safetyError = dangerousControlError({
    mode: body.mode,
    emergencyLiquidation: body.emergency_liquidation,
    confirmation: body.confirmation,
  });
  if (safetyError) throw new Error(safetyError);
  if (body.mode != null) allowed.mode = parseMode(String(body.mode));
  for (const key of ["pause_new_entries", "emergency_liquidation", "upbit_enabled", "binance_enabled", "suppress_cross_exchange_same_asset", "scalp_kill_switch"] as const) if (body[key] != null) allowed[key] = Boolean(body[key]);
  if (body.strategy != null) allowed.strategy = String(body.strategy).toUpperCase() === "SCALP" ? "SCALP" : "TREND";
  if (body.upbit_allocation_mode != null) allowed.upbit_allocation_mode = String(body.upbit_allocation_mode).toUpperCase() === "FIXED" ? "FIXED" : "ALL";
  if (body.binance_allocation_mode != null) allowed.binance_allocation_mode = String(body.binance_allocation_mode).toUpperCase() === "FIXED" ? "FIXED" : "ALL";
  const ranges: Record<string, [number, number]> = {
    max_open_positions: [1, 20], max_open_positions_per_exchange: [1, 10], max_daily_entries: [1, 50], max_daily_entries_per_exchange: [1, 25],
    max_position_pct: [0.5, 25], risk_per_trade_pct: [0.05, 2],
    max_order_krw: [5000, 1_000_000_000], min_order_krw: [5000, 1_000_000], max_daily_buy_krw: [5000, 10_000_000_000],
    max_order_usdt: [5, 10_000_000], min_order_usdt: [5, 1000], max_daily_buy_usdt: [5, 100_000_000],
    upbit_allocation_krw: [0, 100_000_000_000], upbit_reserve_krw: [0, 100_000_000_000],
    binance_allocation_usdt: [0, 1_000_000_000], binance_reserve_usdt: [0, 1_000_000_000],
    max_daily_loss_pct: [0.2, 10], max_weekly_loss_pct: [0.5, 20], max_consecutive_losses: [1, 10],
    scalp_per_order_pct: [0.1, 100], scalp_daily_loss_pct: [0.1, 100], scalp_max_single_loss_pct: [0.1, 100],
    scalp_max_consecutive_losses: [1, 50], scalp_max_holding_minutes: [1, 1440],
    entry_ttl_seconds: [30, 900], full_scan_interval_seconds: [60, 3600], monitor_interval_seconds: [10, 300], max_new_entries_per_scan: [1, 4],
  };
  for (const [key, [low, high]] of Object.entries(ranges)) if (body[key] != null) allowed[key] = clamp(finite(body[key]), low, high);
  if (!Object.keys(allowed).length) return settings;
  allowed.version = finite(settings.version) + 1;
  return (await patch("trading_settings", "id=eq.1", allowed))[0];
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return response({ error: "POST only" }, 405);
  if (!authorized(request)) return response({ error: "unauthorized" }, 401);
  let cycleId = "";
  try {
    requiredConfiguration(); const body = await request.json().catch(() => ({})) as JsonRecord; const action = String(body.action || "status").toLowerCase();
    let settings = await loadSettings(); if (!settings.configured) settings = await ensureConfigured(settings);
    if (action === "status") return response({ ok: true, ...(await status(settings)) });
    const kind: CycleKind = action === "scan" ? "SCAN" : action === "monitor" ? "MONITOR" : ["control", "resume", "reconcile", "withdrawal_mode"].includes(action) ? "CONTROL" : "BOOTSTRAP";
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
    if (action === "control") {
      const operatorPause = body.pause_new_entries === true && settings.pause_new_entries !== true;
      if (operatorPause && String(body.pause_confirmation || "") !== "PAUSE_NOW") {
        await finishCycle(cycleId, "FAILED", {}, "pause confirmation required");
        return response({ ok: false, error: "PAUSE_NOW confirmation is required", cycle_id: cycleId }, 400);
      }
      settings = await control(body, settings);
      if (operatorPause) {
        await event("OPERATOR_PAUSE", "new entries paused by explicit operator command", {
          source: String(body.control_source || "API"), reason: String(body.control_reason || "OPERATOR_REQUEST"), user_agent: request.headers.get("user-agent") || null,
        }, { cycleId, level: "WARNING" });
      }
      await finishCycle(cycleId, "SUCCESS", { settings });
      return response({ ok: true, cycle_id: cycleId, settings });
    }
    if (action === "withdrawal_mode") {
      settings = (await patch("trading_settings", "id=eq.1", {
        pause_new_entries: true, withdrawal_mode: true, manual_intervention_required: false, manual_event_reason: "WITHDRAWAL_MODE",
        last_manual_event_at: new Date().toISOString(), version: finite(settings.version) + 1,
      }))[0];
      await event("WITHDRAWAL_MODE_ENABLED", "withdrawal mode enabled; new entries paused", {}, { cycleId, level: "WARNING" });
      await finishCycle(cycleId, "SUCCESS", { settings });
      return response({ ok: true, cycle_id: cycleId, settings });
    }
    if (action === "reconcile") {
      const result = await withLease("autotrader-monitor", 90, () => monitorCycle(cycleId, { ...settings, pause_new_entries: true }));
      await finishCycle(cycleId, result == null ? "SKIPPED" : "SUCCESS", result || { reason: "monitor lease busy" });
      return response({ ok: true, status: result == null ? "SKIPPED" : "SUCCESS", cycle_id: cycleId, result });
    }
    if (action === "resume") {
      const reconciliation = await withLeaseRetry("autotrader-monitor", 90, 6, 2_000, () => monitorCycle(cycleId, { ...settings, pause_new_entries: true }));
      if (reconciliation == null) {
        await finishCycle(cycleId, "SKIPPED", { reason: "account reconciliation is busy; nothing was resumed" });
        return response({ ok: false, error: "account reconciliation is busy; try the resume button again", cycle_id: cycleId }, 409);
      }
      const activeAfterReconcile = await db("trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING)&select=id&limit=1");
      const resumeError = resumeSafetyError({
        emergencyLiquidation: Boolean(settings.emergency_liquidation),
        activePositionCount: activeAfterReconcile.length,
        unresolvedManualCount: Array.isArray((reconciliation as any).unresolved_manual_assets)
          ? (reconciliation as any).unresolved_manual_assets.length
          : 0,
      });
      if (resumeError) {
        await finishCycle(cycleId, "SKIPPED", { reason: resumeError, reconciliation });
        return response({ ok: false, error: resumeError, cycle_id: cycleId, reconciliation }, 409);
      }
      settings = (await patch("trading_settings", "id=eq.1", {
        pause_new_entries: false, withdrawal_mode: false, manual_intervention_required: false, manual_event_reason: null,
        emergency_liquidation: false, last_resume_at: new Date().toISOString(), version: finite(settings.version) + 1,
      }))[0];
      await event("TRADING_RESUMED_NOW", "new entries resumed immediately by operator after successful reconciliation", { reconciliation }, { cycleId });
      await finishCycle(cycleId, "SUCCESS", { settings, reconciliation, scan_now: true });
      return response({ ok: true, cycle_id: cycleId, settings, reconciliation, scan_now: true });
    }
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
    const availabilityFailure = /gateway\s+(?:5\d\d)|fetch failed|network|timeout|timed out|abort|econn|enotfound|socket|502|503|504/i.test(message);
    if (availabilityFailure) {
      const current = await loadSettings().catch(() => ({ gateway_error_count: 0 }));
      const count = 1 + finite(current.gateway_error_count);
      const pause = count >= 3;
      await patch("trading_settings", "id=eq.1", {
        gateway_error_count: count,
        ...(pause ? { pause_new_entries: true, manual_event_reason: "SAFETY_GATEWAY_UNAVAILABLE", last_manual_event_at: new Date().toISOString() } : {}),
      }).catch(() => null);
      if (pause) await event("SAFETY_PAUSE", "gateway unavailable for 3 consecutive engine calls; entries paused", { error: message, count, source: "GATEWAY_AVAILABILITY" }, { cycleId, level: "CRITICAL" }).catch(() => null);
    } else {
      await event("ENGINE_ERROR_NO_PAUSE", "non-connectivity engine error recorded without pausing entries", { error: message }, { cycleId, level: "WARNING" }).catch(() => null);
    }
    console.error("market-autotrader failed", error); return response({ ok: false, error: message, version: VERSION }, 500);
  }
});
