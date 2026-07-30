Warning: truncated output (original token count: 74072)
Total output lines: 7184

// Trading-booooo v7.0.4-EXIT-LEARNING-INTEGRITY — autonomous spot orchestrator.
// Private service-role function. No withdrawal, transfer, margin, futures, leverage, or market-buy routes exist.

import {
  adjustedPlanForFill,
  allocateExitFillToPosition,
  baseAsset,
  BINANCE_MIN_ORDER_USDT,
  binanceMinOrderUsdt,
  calculateExitResidualAccounting,
  calculateManagedCapital,
  calculatePositionSize,
  clamp,
  dangerousControlError,
  decideExit,
  evaluateCircuit,
  type Exchange,
  finite,
  floorToStep,
  manualReconcileAccounting,
  mergeOrderExecutionProgress,
  nextTrailingStop,
  normalizedOrderState,
  pendingBotExitMayExplainBalanceReduction,
  quoteCurrency,
  reconcileAccount,
  resumeSafetyError,
  t1SellQuantity,
  type TradingMode,
  type TradingSettings,
} from "./core.ts";
import { calculateExposureLedger, reservationAfterFill } from "./exposure-ledger.ts";
import { residualSweepDecision } from "./residual-ledger.ts";
import { allocateNormalizedTradeFees, resolveFeeQuote } from "./fee-accounting.ts";
import { scalpEntryDecision } from "../_shared/scalp/scalp-gate.ts";
import { DEFAULT_SCALP_SIGNAL, refreshPWinAtOrderTime } from "../_shared/scalp/signal.ts";
import {
  applyCalibration,
  type CalibrationModel,
  IDENTITY_CALIBRATION,
} from "../_shared/scalp/calibration.ts";
import {
  evaluateHold,
  marketDataStale,
  resolveHoldConfig,
  type ScalpHoldConfig,
} from "../_shared/scalp/hold.ts";
import {
  DEFAULT_SCALP_SAFETY,
  type ScalpDayState,
  type ScalpSafetyConfig,
} from "../_shared/scalp/safety.ts";
import { type CostModelConfig, DEFAULT_COST_MODEL } from "../_shared/scalp/cost-model.ts";
import { resolveGeometryConfig, resolveMinimumEdge } from "../_shared/scalp/geometry.ts";
import { evaluateRateControl, resolveRateControlConfig } from "../_shared/scalp/rate-control.ts";
import {
  DEFAULT_CANDIDATE_GATE,
  type GateConfig,
  SHADOW_CANDIDATE_GATE,
} from "../_shared/scalp/candidate-gate.ts";
import {
  calculateOrderNotional,
  capitalSupportedSlotCount,
  enforceMinimumExecutableNotional,
} from "../_shared/scalp/risk-allocator.ts";
import {
  nextReconciliationFailure,
  type ReconciliationPhase,
  reconciliationRetryDue,
} from "../_shared/scalp/reconciliation.ts";
import {
  normalizeStrategyProfile,
  profileHoldingCeilingMinutes,
  resolveProfileHolding,
} from "../_shared/scalp/profile.ts";
import {
  calibrateMakerFillProbability,
  evaluateLobEntry,
  neutralWinRateOf,
} from "../_shared/lob/entry.ts";
import { detectLobPatternName } from "../_shared/lob/patterns.ts";
import type { LobTrapConfig } from "../_shared/lob/traps.ts";
import { patternDeployment } from "../_shared/lob/learning.ts";
import {
  type LobOnlineProfileRow,
  onlineAdverseEvPenaltyBps,
  resolveLobOnlineMarketPolicy,
} from "../_shared/lob/online.ts";
import {
  assignLobPolicy,
  type LobPolicyBundle,
  type LobPolicyRuntime,
  type LobPolicyVersionRow,
  policyBundleByVersion,
  resolveLobPolicyRuntime,
} from "../_shared/lob/governance.ts";
import { evaluateModelHealth, shouldConvertToTaker } from "../_shared/lob/health.ts";
import { evaluateLobExit } from "../_shared/lob/exit.ts";
import type { LobFeatureVector, LobPatternName } from "../_shared/lob/types.ts";
import { lobSelectionMetrics } from "../_shared/lob/selection.ts";
import {
  bookTimestampOf,
  LatencyTrace,
  resolveLatencyPenaltyBps,
} from "../_shared/scalp/latency.ts";
import {
  evaluateRotation,
  expectedResolutionSeconds,
  type HeldPositionRate,
  remainingValueBps,
} from "../_shared/scalp/rotation.ts";
import { settleSpotMarketReads, validateSpotMarket } from "../_shared/spot-market.ts";
import { boundedEvBiasPenalty } from "../_shared/lob/ev-bias.ts";
import {
  lobRecommendationWindowSeconds,
  recommendationAdmission,
  summarizeEntryAdmission,
} from "./entry-admission.ts";

const VERSION = "7.0.4-EXIT-LEARNING-INTEGRITY";
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

// v6.4: balance differences worth less than this are accounting noise, not a human
// trading behind the bot's back. Expressed in the quote currency of each exchange so no
// FX lookup sits on the safety path — a failed rate fetch must not decide whether the
// engine halts. Defaults are ~10 USD on both sides.
const DUST_TOLERANCE_QUOTE_DEFAULT: Record<Exchange, number> = { upbit: 14000, binance: 10 };

function dustToleranceQuote(settings: TradingSettings & JsonRecord, exchange: Exchange): number {
  const configured = exchange === "upbit"
    ? finite((settings as any).reconcile_dust_tolerance_krw, DUST_TOLERANCE_QUOTE_DEFAULT.upbit)
    : finite((settings as any).reconcile_dust_tolerance_usdt, DUST_TOLERANCE_QUOTE_DEFAULT.binance);
  return Math.max(0, configured);
}

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
  state:
    | "ENTRY_PENDING"
    | "OPEN"
    | "EXITING"
    | "RECONCILING"
    | "RECONCILIATION_FAILED"
    | "MANUAL_INTERVENTION_REQUIRED"
    | "CLOSED"
    | "CANCELLED"
    | "ERROR";
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
  residual_quantity: number;
  residual_value_quote: number;
  residual_fee_base: number;
  accounting_version: string | null;
};

function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}
function parseMode(value: string): TradingMode {
  const mode = String(value).toUpperCase();
  return mode === "LIVE_LIMITED" ? "LIVE_LIMITED" : mode === "PAUSED" ? "PAUSED" : "PAPER";
}
function isLobStrategy(value: unknown): boolean {
  return String(value || "").toUpperCase() === "LOB_SCALP";
}
function isScalpStrategy(value: unknown): boolean {
  const normalized = String(value || "").toUpperCase();
  return normalized === "SCALP" || normalized === "LOB_SCALP";
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
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
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
function requiredConfiguration() {
  const missing: string[] = [];
  for (
    const [name, value] of Object.entries({
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      AUTOTRADE_ACCESS_TOKEN: AUTOTRADE_TOKEN,
      DASHBOARD_ACCESS_TOKEN: DASHBOARD_TOKEN,
      ORDER_GATEWAY_URL: GATEWAY_URL,
      GATEWAY_SHARED_SECRET: GATEWAY_SECRET,
    })
  ) if (!value) missing.push(name);
  if (missing.length) throw new Error(`missing configuration: ${missing.join(", ")}`);
}
function dbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      `database ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
  }
  return data;
}
async function rpc(name: string, body: JsonRecord): Promise<any> {
  return db(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
}
async function patch(table: string, filter: string, values: JsonRecord): Promise<any[]> {
  return db(`${table}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
}
async function insert(table: string, values: JsonRecord | JsonRecord[]): Promise<any[]> {
  return db(table, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values),
  });
}
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
/**
 * v5.10.1: retry once on an expired signature.
 *
 * The gateway rejects a request whose `x-gateway-ts` is more than
 * GATEWAY_REQUEST_TOLERANCE_SECONDS old on arrival. The timestamp is stamped when the
 * request is BUILT, but compared against when it LANDS, and a Supabase Edge isolate can be
 * suspended or delayed in between. The result was `gateway 401: expired gateway request`,
 * which is not a 5xx so it was never classified as a connectivity failure: the cycle simply
 * threw, logged ENGINE_ERROR_NO_PAUSE, and produced nothing. Five in fifty minutes, each
 * one a lost scan.
 *
 * Retrying is safe here specifically because a 401 is rejected at the AUTH layer, before
 * the gateway touches an exchange — no order can have been placed. That is not true of a
 * replayed-nonce rejection, which means the first attempt DID get through, so that one is
 * deliberately excluded.
 */
const RETRYABLE_GATEWAY_ERROR = /expired gateway request/i;

async function gatewayOnce(
  exchange: Exchange,
  command: JsonRecord,
  timeoutMs: number,
): Promise<any> {
  const target = gatewayTarget(exchange);
  const raw = JSON.stringify({ exchange, ...command });
  // Stamp and sign as late as possible, immediately before dispatch.
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(target.secret, `${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${target.url}/v1/command`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-gateway-ts": ts,
        "x-gateway-nonce": nonce,
        "x-gateway-signature": signature,
      },
      body: raw,
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok || !data?.ok) {
      const error = new Error(`gateway ${res.status}: ${data?.error || text}`) as Error & {
        status?: number;
        code?: string;
        payload?: any;
      };
      error.status = res.status;
      error.code = data?.code || `GATEWAY_${res.status}`;
      error.payload = data;
      throw error;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function gateway(exchange: Exchange, command: JsonRecord, timeoutMs = 15_000): Promise<any> {
  try {
    return await gatewayOnce(exchange, command, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!RETRYABLE_GATEWAY_ERROR.test(message)) throw error;
    // Fresh timestamp and nonce. The exchange was never reached on the first attempt.
    return await gatewayOnce(exchange, command, timeoutMs);
  }
}

function defaultSettings(): TradingSettings & JsonRecord {
  return {
    id: 1,
    configured: true,
    mode: DEFAULT_MODE,
    pause_new_entries: false,
    emergency_liquidation: false,
    upbit_enabled: true,
    binance_enabled: true,
    max_open_positions: 4,
    max_open_positions_per_exchange: 2,
    max_daily_entries: Number.MAX_SAFE_INTEGER,
    max_daily_entries_per_exchange: Number.MAX_SAFE_INTEGER,
    // Financial exposure is controlled only by the operator allocation settings below.
    // Legacy sizing fields remain for schema compatibility but are non-binding in SCALP.
    max_position_pct: 100,
    risk_per_trade_pct: 100,
    max_order_krw: 1_000_000_000,
    min_order_krw: 40_000,
    max_daily_buy_krw: 10_000_000_000,
    max_order_usdt: 10_000_000,
    min_order_usdt: binanceMinOrderUsdt(
      finite(env("BINANCE_MIN_ORDER_USDT"), BINANCE_MIN_ORDER_USDT),
    ),
    max_daily_buy_usdt: 100_000_000,
    upbit_allocation_mode: "ALL",
    upbit_allocation_krw: 0,
    upbit_reserve_krw: 0,
    binance_allocation_mode: "ALL",
    binance_allocation_usdt: 0,
    binance_reserve_usdt: 0,
    withdrawal_mode: false,
    manual_intervention_required: false,
    manual_event_reason: null,
    max_daily_loss_pct: 1.5,
    max_weekly_loss_pct: 3,
    max_consecutive_losses: 3,
    entry_ttl_seconds: 20,
    full_scan_interval_seconds: clamp(finite(env("AUTO_SCAN_INTERVAL_SECONDS"), 12), 8, 3600),
    monitor_interval_seconds: clamp(finite(env("AUTO_MONITOR_INTERVAL_SECONDS"), 2), 1, 300),
    // v5.12: capacity controller may raise this up to 12. The total-exposure-invariant
    // risk allocator prevents the additional attempts from increasing strategy exposure.
    max_new_entries_per_scan: 20,
    suppress_cross_exchange_same_asset: true,
    // Stage 4: scalp strategy. Default "TREND" = existing behavior, fully off.
    strategy: env("TRADING_STRATEGY") === "TREND"
      ? "TREND"
      : env("TRADING_STRATEGY") === "SCALP"
      ? "SCALP"
      : "LOB_SCALP",
    scalp_per_order_pct: 100, // deprecated: allocation UI is the sole exposure ceiling
    scalp_daily_loss_pct: clamp(finite(env("SCALP_DAILY_LOSS_PCT"), 30), 0.1, 100),
    scalp_max_single_loss_pct: clamp(finite(env("SCALP_MAX_SINGLE_LOSS_PCT"), 5), 0.1, 100),
    scalp_max_consecutive_losses: clamp(finite(env("SCALP_MAX_CONSECUTIVE_LOSSES"), 4), 1, 50),
    scalp_kill_switch: env("SCALP_KILL_SWITCH") === "true",
    // v5.3 --------------------------------------------------------------------
    // Default raised 30 -> 120. A cost-cleared target cannot be reached in 30
    // minutes on most symbols; geometry.ts sizes the per-symbol horizon and this
    // is only the hard ceiling.
    // v5.6: back to a scalp horizon. Throughput-optimal barriers are narrow, so they
    // resolve fast; the wide-barrier / long-hold combination of v5.4 was a consequence of
    // taker costs, not of the strategy.
    scalp_max_holding_minutes: clamp(finite(env("SCALP_MAX_HOLDING_MINUTES"), 3), 0.1, 5),
    // Capital is split into this many concurrent slots. v5.2.5 sized every entry at
    // the FULL available allocation, so the first candidate consumed everything and
    // the "max 2 entries per scan" allowance could never be used.
    scalp_position_slots: clamp(finite(env("SCALP_POSITION_SLOTS"), 6), 1, 20),
    // Excess win rate the signal is assumed to deliver. Drives barrier width.
    scalp_edge_budget: clamp(finite(env("SCALP_EDGE_BUDGET"), 0.10), 0.02, 0.30),
    scalp_reward_risk: clamp(finite(env("SCALP_REWARD_RISK"), 2.0), 0.4, 4),
    // v5.6: target realized win rate. Drives the target/stop split.
    scalp_target_win_rate: clamp(finite(env("SCALP_TARGET_WIN_RATE"), 0.58), 0, 0.8),
    scalp_slippage_allowance: clamp(finite(env("SCALP_SLIPPAGE_ALLOWANCE"), 0.0009), 0, 0.01),
    // Half-life applied to scan-time alpha when the signal is re-priced at order time.
    scalp_alpha_half_life_ms: clamp(finite(env("SCALP_ALPHA_HALF_LIFE_MS"), 20000), 1000, 300000),
    // Move the effective stop to breakeven+cost once the first target is taken.
    scalp_breakeven_after_t1: env("SCALP_BREAKEVEN_AFTER_T1") !== "false",
    // v5.5: ON by default. This is the maker EXIT leg — the counterpart to
    // scalp_maker_entry. Market-selling on a 15s poll gives the spread back on every
    // winner and loses target touches that happen between polls, which is precisely the
    // cost the maker pivot exists to remove.
    scalp_resting_tp: env("SCALP_RESTING_TP") !== "false",
    // v5.12: max holding is a real barrier outcome. HF_SCALP is capped at 30 minutes;
    // INTRADAY_SCALP may extend to 120 minutes. The live-edge hold test can exit earlier,
    // but never extend a trade beyond the approved profile timeout.
    scalp_safety_ttl_minutes: clamp(finite(env("SCALP_SAFETY_TTL_MINUTES"), 5), 0.1, 5),
    // v6 LOB_SCALP: second-scale horizons and order-book-only execution controls.
    lob_max_holding_seconds: clamp(finite(env("LOB_MAX_HOLDING_SECONDS"), 180), 1, 300),
    lob_absolute_max_holding_seconds: clamp(
      finite(env("LOB_ABSOLUTE_MAX_HOLDING_SECONDS"), 300),
      1,
      300,
    ),
    lob_scan_interval_seconds: clamp(finite(env("LOB_SCAN_INTERVAL_SECONDS"), 15), 10, 60),
    lob_min_net_ev_bps: clamp(finite(env("LOB_MIN_NET_EV_BPS"), 0.01), 0, 100),
    lob_max_book_age_ms: clamp(finite(env("LOB_MAX_BOOK_AGE_MS"), 5000), 100, 10000),
    lob_max_spread_bps: clamp(finite(env("LOB_MAX_SPREAD_BPS"), 60), 1, 100),
    lob_min_bid_depth_ratio: clamp(finite(env("LOB_MIN_BID_DEPTH_RATIO"), 0.35), 0.05, 1),
    scalp_hold_alpha_half_life_minutes: clamp(
      finite(env("SCALP_HOLD_ALPHA_HALF_LIFE_MINUTES"), 12),
      1,
      240,
    ),
    scalp_hold_min_edge_after_expected: clamp(
      finite(env("SCALP_HOLD_MIN_EDGE_AFTER_EXPECTED"), 0.0005),
      0,
      0.01,
    ),
    scalp_hold_reversal_imbalance: clamp(
      finite(env("SCALP_HOLD_REVERSAL_IMBALANCE"), -0.25),
      -1,
      0,
    ),
    scalp_hold_reversal_confirmations: clamp(
      finite(env("SCALP_HOLD_REVERSAL_CONFIRMATIONS"), 2),
      1,
      10,
    ),
    // Query the exchange for this account's real commission rate instead of assuming the
    // list price. Set false to pin the static FEE_PCT table.
    scalp_use_live_fees: env("SCALP_USE_LIVE_FEES") !== "false",
    scalp_min_edge_cost_fraction: clamp(finite(env("SCALP_MIN_EDGE_COST_FRACTION"), 0.25), 0, 1),
    // v5.12: execution profile and lower-bound candidate gate.
    scalp_strategy_profile: "LOB_SCALP",
    scalp_min_win_probability_lcb: clamp(
      finite(env("SCALP_MIN_WIN_PROBABILITY_LCB"), 0.50),
      0.50,
      0.95,
    ),
    scalp_min_fill_probability_lcb: clamp(
      finite(env("SCALP_MIN_FILL_PROBABILITY_LCB"), 0.30),
      0.05,
      0.95,
    ),
    scalp_min_forecast_samples: clamp(finite(env("SCALP_MIN_FORECAST_SAMPLES"), 60), 0, 20000),
    scalp_min_independent_blocks: clamp(finite(env("SCALP_MIN_INDEPENDENT_BLOCKS"), 3), 0, 1000),
    // v5.10 --------------------------------------------------------------------
    // Budget spent on trades taken for their INFORMATION value.
    //
    // The EV gate rejects using pWin = neutralWinRate + signalEdge, and signalEdge comes
    // from weights chosen by hand that have never been measured against an outcome. Being
    // strict on that basis is not caution, it is arbitrary — and it guarantees the weights
    // stay unmeasured, because no trades means no outcomes means no calibration.
    //
    // These override the EV threshold and NOTHING else. Kill switch, daily loss, depth,
    // spread and exchange minimums all still apply.
    scalp_exploration_per_day: 0, // v5.12: live EV-gate bypass disabled; shadow labelling only
    scalp_exploration_per_scan: 0,
    scalp_exploration_size_fraction: clamp(
      finite(env("SCALP_EXPLORATION_SIZE_FRACTION"), 0.33),
      0.05,
      1,
    ),
    scalp_exploration_min_edge_cost_multiple: clamp(
      finite(env("SCALP_EXPLORATION_MIN_EDGE_COST_MULTIPLE"), -1),
      -5,
      0,
    ),
    // v5.11 --------------------------------------------------------------------
    // Trade frequency is the CONTROL VARIABLE, not an outcome. The gate serves the rate.
    // Risk is carried by SIZE, which stays small until shadow outcomes confirm an edge —
    // so the samples that settle the question arrive at full speed while little capital
    // rides on the answer.
    scalp_target_trades_per_hour: clamp(finite(env("SCALP_TARGET_TRADES_PER_HOUR"), 5), 0, 60),
    scalp_rate_window_minutes: clamp(finite(env("SCALP_RATE_WINDOW_MINUTES"), 60), 10, 1440),
    scalp_target_utilization: clamp(finite(env("SCALP_TARGET_UTILIZATION"), 0.70), 0.1, 0.95),
    scalp_min_position_slots: clamp(finite(env("SCALP_MIN_POSITION_SLOTS"), 2), 1, 20),
    scalp_max_position_slots: clamp(finite(env("SCALP_MAX_POSITION_SLOTS"), 12), 1, 20),
    scalp_scan_universe: clamp(finite(env("SCALP_SCAN_UNIVERSE"), 60), 10, 1000),
    scalp_min_scan_universe: clamp(finite(env("SCALP_MIN_SCAN_UNIVERSE"), 30), 10, 1000),
    scalp_max_scan_universe: clamp(finite(env("SCALP_MAX_SCAN_UNIVERSE"), 240), 10, 1000),
    scalp_average_holding_minutes: clamp(finite(env("SCALP_AVERAGE_HOLDING_MINUTES"), 2), 0.1, 5),
    scalp_unproven_size_fraction: clamp(finite(env("SCALP_UNPROVEN_SIZE_FRACTION"), 1), 0.05, 1),
    scalp_samples_for_full_size: clamp(finite(env("SCALP_SAMPLES_FOR_FULL_SIZE"), 400), 50, 20000),
    scalp_rate_relaxation: 0, // compatibility column; v5.12 always resets to zero
    // v5.5 --------------------------------------------------------------------
    // Post the entry on the bid instead of taking the ask.
    //
    // A taker PAYS the spread twice per round trip; a maker EARNS it. Upbit and Binance
    // charge makers and takers identically, so the whole gain is the spread — which is
    // the difference between a scalp that clears its costs and one that cannot.
    // It also raises the REALIZED win rate: entering a spread lower puts the target
    // closer and the stop further away, measured from where the market actually is.
    scalp_maker_entry: env("SCALP_MAKER_ENTRY") !== "false",
    // How long a resting entry waits before it is abandoned. Unfilled costs nothing.
    scalp_maker_entry_ttl_seconds: clamp(finite(env("SCALP_MAKER_ENTRY_TTL_SECONDS"), 8), 5, 900),
    // Cancel early if the book walks away from our resting bid by this many ticks.
    scalp_maker_entry_drift_ticks: clamp(finite(env("SCALP_MAKER_ENTRY_DRIFT_TICKS"), 1), 1, 50),
    // Assumed spread earned per round trip when sizing barriers. Live spread is measured
    // per symbol at order time; this is only the sizing input.
    scalp_spread_capture: clamp(finite(env("SCALP_SPREAD_CAPTURE"), 0.0005), 0, 0.005),
    // Only the stop branch crosses the book under maker execution.
    scalp_maker_slippage_allowance: clamp(
      finite(env("SCALP_MAKER_SLIPPAGE_ALLOWANCE"), 0.0003),
      0,
      0.01,
    ),
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
    // Database values from older releases must not lower the operator's live Binance floor.
    merged.min_order_usdt = binanceMinOrderUsdt(merged.min_order_usdt);
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
  return (await patch("trading_settings", "id=eq.1", {
    configured: true,
    ...(syncMode || !settings.configured ? { mode: DEFAULT_MODE } : {}),
    version: finite(settings.version) + 1,
  }))[0] || settings;
}
async function beginCycle(kind: CycleKind, mode?: string): Promise<string> {
  return (await insert("trading_cycle_runs", { kind, mode: mode || null, status: "RUNNING" }))[0]
    .id;
}
async function finishCycle(
  id: string,
  status: "SUCCESS" | "SKIPPED" | "FAILED",
  summary: JsonRecord,
  error?: string,
) {
  await db(`trading_cycle_runs?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      summary,
      error: error || null,
      finished_at: new Date().toISOString(),
    }),
  });
}
async function event(
  code: string,
  message: string,
  details: JsonRecord = {},
  refs: { cycleId?: string; positionId?: string; orderId?: string; level?: string } = {},
) {
  await db("trading_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      cycle_id: refs.cycleId || null,
      position_id: refs.positionId || null,
      order_id: refs.orderId || null,
      level: refs.level || "INFO",
      code,
      message,
      details,
    }),
  }).catch(() => null);
}
async function withLease<T>(
  name: string,
  seconds: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const owner = crypto.randomUUID();
  if (
    await rpc("acquire_trading_lease", { p_name: name, p_owner: owner, p_seconds: seconds }) !==
      true
  ) return null;
  try {
    return await work();
  } finally {
    await rpc("release_trading_lease", { p_name: name, p_owner: owner }).catch(() => null);
  }
}
async function withLeaseRetry<T>(
  name: string,
  seconds: number,
  attempts: number,
  delayMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const result = await withLease(name, seconds, work);
    if (result != null) return result;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

function dayBoundary(_exchange: Exchange, daysAgo = 0): string {
  const offset = 9;
  const date = new Date(Date.now() + offset * 3600_000);
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - offset * 3600_000 - daysAgo * 86400_000).toISOString();
}
function weekBoundary(_exchange: Exchange): string {
  const offset = 9;
  const date = new Date(Date.now() + offset * 3600_000);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - offset * 3600_000).toISOString();
}
async function accountStats(
  exchange: Exchange,
  equityQuote: number,
  isPaper: boolean,
  portfolio: any = null,
) {
  const [
    activeGlobal,
    activeExchange,
    todayGlobal,
    todayExchange,
    dailyBuyOrders,
    dailyClosed,
    weeklyClosed,
    recentClosed,
    dailySeedSnapshots,
  ] = await Promise.all([
    db(
      `trading_positions?is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,exchange,market,base_asset,state,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,paid_fees_quote,residual_value_quote`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,market,base_asset,state,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,paid_fees_quote,residual_value_quote`,
    ),
    db(
      `trading_positions?is_paper=eq.${isPaper}&created_at=gte.${
        encodeURIComponent(dayBoundary("upbit"))
      }&state=neq.CANCELLED&select=id`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&created_at=gte.${
        encodeURIComponent(dayBoundary(exchange))
      }&state=neq.CANCELLED&select=id`,
    ),
    db(
      `trading_orders?exchange=eq.${exchange}&side=eq.BUY&requested_at=gte.${
        encodeURIComponent(dayBoundary(exchange))
      }&state=in.(APPLIED,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED)&select=executed_funds_quote,trading_positions!inner(is_paper)&trading_positions.is_paper=eq.${isPaper}`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&closed_at=gte.${
        encodeURIComponent(dayBoundary(exchange))
      }&state=eq.CLOSED&select=realized_pnl_quote`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&closed_at=gte.${
        encodeURIComponent(weekBoundary(exchange))
      }&state=eq.CLOSED&select=realized_pnl_quote`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=eq.CLOSED&select=realized_pnl_quote&order=closed_at.desc&limit=20`,
    ),
    isPaper ? Promise.resolve([]) : db(
      `trading_account_snapshots?exchange=eq.${exchange}&captured_at=gte.${
        encodeURIComponent(dayBoundary(exchange))
      }&select=total_equity_quote,managed_capital_quote,captured_at&order=captured_at.asc&limit=1`,
    ),
  ]);
  const dailyBoughtQuote = (dailyBuyOrders || []).reduce(
    (sum: number, row: any) => sum + finite(row.executed_funds_quote),
    0,
  );
  const daily = (dailyClosed || []).reduce(
    (sum: number, row: any) => sum + finite(row.realized_pnl_quote),
    0,
  );
  const weekly = (weeklyClosed || []).reduce(
    (sum: number, row: any) => sum + finite(row.realized_pnl_quote),
    0,
  );
  const markedOpenPnl = (activeExchange || []).reduce((sum: number, row: any) => {
    const entry = Math.max(0, finite(row.average_entry_price, row.planned_entry_price));
    const current = Math.max(0, finite(portfolio?.prices?.[row.market], entry));
    return sum + calculateExposureLedger({
      state: row.state,
      remainingQuantity: row.remaining_quantity,
      reservedQuote: row.reserved_quote,
      reservedQuantity: row.reserved_quantity,
      averageEntryPrice: row.average_entry_price,
      plannedEntryPrice: row.planned_entry_price,
      currentPrice: current,
      realizedCostQuote: row.realized_cost_quote,
      realizedProceedsQuote: row.realized_proceeds_quote,
      paidFeesQuote: row.paid_fees_quote,
      residualValueQuote: row.residual_value_quote,
      estimatedExitCostPct: FEE_PCT[exchange] / 100 + 0.0005,
    }).markedNetPnlQuote;
  }, 0);
  const dailyEconomic = daily + markedOpenPnl;
  const weeklyEconomic = weekly + markedOpenPnl;
  const dailySeedEquityQuote = Math.max(
    0,
    finite(
      dailySeedSnapshots?.[0]?.total_equity_quote,
      finite(portfolio?.total_equity_quote, equityQuote),
    ),
  );
  let consecutiveLosses = 0;
  for (const row of recentClosed || []) {
    if (finite(row.realized_pnl_quote) < 0) consecutiveLosses++;
    else break;
  }
  return {
    activeGlobal,
    activeExchange,
    openGlobal: activeGlobal.length,
    openExchange: activeExchange.length,
    entriesTodayGlobal: todayGlobal.length,
    entriesTodayExchange: todayExchange.length,
    dailyBoughtQuote,
    dailyPnlQuote: dailyEconomic,
    weeklyPnlQuote: weeklyEconomic,
    realizedDailyPnlQuote: daily,
    markedOpenPnlQuote: markedOpenPnl,
    dailySeedEquityQuote,
    dailyPnlPct: dailySeedEquityQuote > 0 ? dailyEconomic / dailySeedEquityQuote * 100 : 0,
    weeklyPnlPct: equityQuote > 0 ? weeklyEconomic / equityQuote * 100 : 0,
    consecutiveLosses,
  };
}

async function runScanner(
  portfolios: Record<Exchange, any>,
  settings: TradingSettings,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_SCAN_SECONDS * 1000);
  const lobRecommendationSeconds = lobRecommendationWindowSeconds(
    settings.full_scan_interval_seconds,
  );
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/market-scanner`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-autotrade-token": AUTOTRADE_TOKEN },
      body: JSON.stringify({
        action: "scan",
        exchange: "combined",
        operator_mode: "AUTOMATED",
        automation: true,
        strategy: (settings as any).strategy,
        strategy_profile: normalizeStrategyProfile((settings as any).scalp_strategy_profile),
        scalp_overrides: isLobStrategy((settings as any).strategy)
          ? {
            // LOB_SCALP follows the user's sole economic threshold: expected net profit
            // after fees/slippage must be strictly positive. Legacy pWin/pFill buffers do
            // not leak into this route.
            minimumEdge: Math.max(0, finite((settings as any).lob_min_net_ev_bps, 0.01)) / 10_000,
            maxBookAgeMs: Math.max(100, finite((settings as any).lob_max_book_age_ms, 2500)),
            maxSpreadBps: Math.max(1, finite((settings as any).lob_max_spread_bps, 30)),
            maxHoldingSeconds: Math.round(
              clamp(finite((settings as any).lob_max_holding_seconds, 180), 1, 300),
            ),
          }
          : {
            minimumEdge: finite(
              (settings as any).scalp_minimum_edge,
              DEFAULT_COST_MODEL.minimumEdge,
            ),
          },
        // v5.3: barrier geometry. `edgeBudget` is the dominant knob — it is the excess
        // win rate the signal is assumed to deliver, and it sets how wide T + S must be
        // for the required win rate to be attainable at all.
        geometry_overrides: {
          edgeBudget: finite((settings as any).scalp_edge_budget, 0.10),
          // v5.6: the win rate the bot should print. The barrier split is derived from it,
          // because neutral win rate IS S/(T+S) — a 2:1 reward:risk caps the win rate at
          // 33% no matter how good the signal is.
          targetWinRate: finite((settings as any).scalp_target_win_rate, 0.58),
          rewardRiskRatio: finite((settings as any).scalp_reward_risk, 2.0),
          // v5.5: a maker entry does not cross the book, so it has NO entry slippage, and
          // the resting take-profit has none either. Only the stop branch market-sells.
          // The 0.0009 taker allowance assumed two crossings and over-taxes maker sizing.
          slippageAllowance: (settings as any).scalp_maker_entry === false
            ? finite((settings as any).scalp_slippage_allowance, 0.0009)
            : finite((settings as any).scalp_maker_slippage_allowance, 0.0003),
          // Maker execution earns the spread back; taker execution pays it.
          spreadCaptureFraction: (settings as any).scalp_maker_entry === false
            ? 0
            : finite((settings as any).scalp_spread_capture, 0.0005),
          minimumEdge: finite((settings as any).scalp_minimum_edge, DEFAULT_COST_MODEL.minimumEdge),
          minEdgeCostFraction: finite((settings as any).scalp_min_edge_cost_fraction, 0.25),
          maxHorizonMinutes: Math.max(
            5,
            Math.min(
              profileHoldingCeilingMinutes(
                normalizeStrategyProfile((settings as any).scalp_strategy_profile),
              ),
              finite((settings as any).scalp_max_holding_minutes, 30),
            ),
          ),
        },
        capital_krw: Math.max(
          10_000,
          finite(
            portfolios.upbit?.managed?.managedCapitalQuote,
            portfolios.upbit?.available_quote || 10_000,
          ),
        ),
        capital_usdt: Math.max(
          10,
          finite(
            portfolios.binance?.managed?.managedCapitalQuote,
            portfolios.binance?.available_quote || 10,
          ),
        ),
        risk_pct: isScalpStrategy((settings as any).strategy) ? 100 : settings.risk_per_trade_pct,
        // v5.4: the scanner sizes barriers from cost, so it must receive the account's
        // real commission rate rather than recomputing the list price.
        upbit_fee_per_side_pct: await liveFeePct("upbit", settings),
        binance_fee_per_side_pct: await liveFeePct("binance", settings),
        recommendation_valid_minutes: isLobStrategy((settings as any).strategy)
          ? lobRecommendationSeconds / 60
          : Math.max(1, Math.ceil(settings.entry_ttl_seconds / 60)),
        min_actionable_holding_hours: 0.08,
        max_unattended_hours: 2,
        require_precommitted_exit: true,
      }),
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(`scanner ${res.status}: ${data?.error || text}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function loadBuyCandidates(
  scanId: string,
  settings?: TradingSettings,
  cycleId?: string,
): Promise<Candidate[]> {
  const rows = await db(
    `scanner_candidates?scan_id=eq.${scanId}&decision=eq.BUY&exchange=in.(upbit,binance)&select=*&order=score.desc,period_score.desc`,
  ) as Candidate[];
  if (!isScalpStrategy((settings as any)?.strategy)) return rows;
  const makerByExchange = isLobStrategy((settings as any)?.strategy)
    ? {
      upbit: await loadMakerFillStats("upbit"),
      binance: await loadMakerFillStats("binance"),
    }
    : null;
  const policyRuntime = isLobStrategy((settings as any)?.strategy)
    ? await loadLobPolicyRuntime()
    : null;
  const policy = policyRuntime ? assignLobPolicy(policyRuntime, scanId) : null;
  if (isLobStrategy((settings as any)?.strategy) && !policy) {
    throw new Error("validated LOB policy unavailable; refusing an unversioned entry cycle");
  }
  const lobLearning = isLobStrategy((settings as any)?.strategy)
    ? policy?.patternProfile ?? null
    : null;
  const onlineProfiles = isLobStrategy((settings as any)?.strategy)
    ? await db(
      "lob_market_profiles?select=exchange,market,pattern,version,samples,profitable_trades," +
        "target_hits,early_exit_losses,ewma_net_bps,ewma_hold_seconds," +
        "ewma_profitable_hold_seconds,ewma_mae_bps,ewma_mfe_bps," +
        "ewma_profitable_mae_bps,exit_counts,updated_at&limit=5000",
    ).catch(() => policy?.onlineProfiles ?? []) as LobOnlineProfileRow[]
    : [];
  // v6.6.1: the first live deployment proved that a low-sample calibration cannot own the
  // hard gate: 17/17 candidates were discarded and throughput fell to zero. Evidence now
  // changes ordering immediately while the base positive-EV gate stays intact until that
  // exact pattern has enough samples. Non-dominated sorting jointly rewards net EV,
  // profitable-trade probability and EV per slot-second; it removes no candidate.
  const selection = (row: Candidate) => {
    const snapshot = (row as any).snapshot || {};
    if (isLobStrategy((settings as any)?.strategy)) {
      const lob = snapshot.lob || {};
      const stats = makerByExchange?.[row.exchange];
      const measuredRate = stats && stats.rested > 0 ? stats.filled / stats.rested : 0;
      const rawPFill = finite(lob.p_fill, 0);
      const calibrated = calibrateMakerFillProbability(
        rawPFill,
        measuredRate,
        stats?.rested || 0,
      );
      const fillScale = rawPFill > 0 ? calibrated.probability / rawPFill : 1;
      const deployment = patternDeployment(
        lobLearning,
        String(lob.pattern || "") as LobPatternName,
      );
      const onlinePolicy = resolveLobOnlineMarketPolicy(
        onlineProfiles,
        row.exchange,
        row.market,
        String(lob.pattern || "") as LobPatternName,
      );
      // Retain the exact policy that ranked this candidate for order-time diagnostics.
      // The live pattern is detected again immediately before the order and may resolve to
      // a different per-coin profile.
      (row as any).__online_policy = onlinePolicy;
      // Live observations are a common admission overlay for both policy lanes. They are
      // pinned onto the candidate and persisted with an entry, preserving causal audit
      // while allowing repeated market-specific losses to affect the next order.
      (row as any).__live_online_profiles = onlineProfiles;
      (row as any).__policy_bundle = policy;
      (row as any).__policy_assignment = policy
        ? {
          version: policy.version,
          lane: policy.lane,
          status: policy.status,
          phase: policy.phase,
          parent_version: policy.parentVersion,
        }
        : null;
      return lobSelectionMetrics({
        ...lob,
        ev_lower_bound_bps: finite(
          lob.ev_lower_bound_bps,
          Number.NEGATIVE_INFINITY,
        ) * fillScale,
        pattern_quality: deployment.rankingQuality * onlinePolicy.rankingQuality,
        empirical_profitable_rate: onlinePolicy.profitableRate ?? deployment.profitableRate,
        empirical_hold_seconds: onlinePolicy.expectedHoldSeconds ??
          deployment.medianHoldSeconds,
      });
    }
    return null;
  };
  const ranked = isLobStrategy((settings as any)?.strategy)
    ? [...rows].map((row) => {
      selection(row);
      return row;
    }).sort((left, right) => {
      const leftFeatures = (left as any).snapshot?.lob?.features || {};
      const rightFeatures = (right as any).snapshot?.lob?.features || {};
      const rankDelta = finite(leftFeatures.gainerRank, 99) -
        finite(rightFeatures.gainerRank, 99);
      if (Math.abs(rankDelta) > 1e-9) return rankDelta;
      return finite(rightFeatures.tradePressureFast, -1) -
        finite(leftFeatures.tradePressureFast, -1);
    })
    : [...rows].sort((a, b) =>
      finite((b as any).snapshot?.scalp?.provisional_edge, Number.NEGATIVE_INFINITY) -
      finite((a as any).snapshot?.scalp?.provisional_edge, Number.NEGATIVE_INFINITY)
    );
  const universe = clamp(
    finite((settings as any)?.scalp_scan_universe, ranked.length || 1),
    1,
    1000,
  );
  if (cycleId && isLobStrategy((settings as any)?.strategy)) {
    await recordLobPolicyExposure(cycleId, scanId, policy, rows.length);
  }
  return ranked.slice(0, universe);
}
function tickRound(value: number, tick: number, direction: "down" | "up" | "nearest" = "nearest") {
  const t = tick > 0 ? tick : Math.max(0.00000001, value * 0.000001);
  const units = value / t;
  return (direction === "down"
    ? Math.floor(units)
    : direction === "up"
    ? Math.ceil(units)
    : Math.round(units)) * t;
}
function executableDepth(asks: any[], maxEntry: number, requestedNotional: number) {
  let availableFunds = 0;
  let executionFunds = 0;
  let volume = 0;
  let worstPrice = 0;
  for (const unit of Array.isArray(asks) ? asks : []) {
    const price = finite(unit?.price);
    const size = finite(unit?.size);
    if (!(price > 0 && size > 0) || price > maxEntry) continue;
    const capacity = price * size;
    availableFunds += capacity;
    const take = Math.min(capacity, Math.max(0, requestedNotional - executionFunds));
    if (take > 0) {
      executionFunds += take;
      volume += take / price;
      worstPrice = price;
    }
  }
  return {
    executable: executionFunds + 1e-8 >= requestedNotional,
    availableFunds,
    executionFunds,
    volume,
    vwap: volume > 0 ? executionFunds / volume : 0,
    worstPrice,
  };
}
/**
 * v5.3: top-of-book imbalance from a live orderbook, using the same depth and decay as
 * the scanner's `book_imbalance_top`, so the order-time refresh is on the same scale as
 * the scan-time term it replaces. Keep SCALP_BOOK_DEPTH / SCALP_BOOK_DECAY in
 * market-scanner/engine.ts in sync with these two constants.
 */
const SCALP_BOOK_DEPTH = 5;
const SCALP_BOOK_DECAY = 1.5;
function topOfBookImbalance(
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
): number {
  let bid = 0;
  let ask = 0;
  for (let i = 0; i < SCALP_BOOK_DEPTH; i++) {
    const weight = 1 / Math.pow(i + 1, SCALP_BOOK_DECAY);
    const b = bids[i];
    const a = asks[i];
    if (b && finite(b.price) > 0 && finite(b.size) > 0) {
      bid += finite(b.price) * finite(b.size) * weight;
    }
    if (a && finite(a.price) > 0 && finite(a.size) > 0) {
      ask += finite(a.price) * finite(a.size) * weight;
    }
  }
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : 0;
}

function liveLobFeatures(scan: any, market: any): LobFeatureVector {
  const base = (scan?.features || {}) as Partial<LobFeatureVector>;
  const bids = (market?.bids || []).map((b: any) => ({
    price: finite(b.price ?? b[0]),
    size: finite(b.size ?? b[1]),
  }));
  const asks = (market?.asks || []).map((a: any) => ({
    price: finite(a.price ?? a[0]),
    size: finite(a.size ?? a[1]),
  }));
  const bestBid = finite(market?.best_bid, bids[0]?.price);
  const bestAsk = finite(market?.best_ask, asks[0]?.price);
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : finite(market?.current);
  const bidSize = finite(bids[0]?.size);
  const askSize = finite(asks[0]?.size);
  const microprice = bidSize + askSize > 0
    ? (bestAsk * bidSize + bestBid * askSize) / (bidSize + askSize)
    : mid;
  const bidDepth = bids.slice(0, 10).reduce((sum: number, x: any) => sum + x.price * x.size, 0);
  const askDepth = asks.slice(0, 10).reduce((sum: number, x: any) => sum + x.price * x.size, 0);
  const flow = market?.trade_flow || {};
  const buyNotional = finite(flow.buy_notional, base.buyNotional);
  const sellNotional = finite(flow.sell_notional, base.sellNotional);
  const tradeCount = Math.max(0, Math.floor(finite(flow.trade_count, base.tradeCount)));
  return {
    universeMode: base.universeMode,
    gainerRank: finite(base.gainerRank, finite(scan?.gainer_rank, 99)),
    samples: Math.max(1, Math.floor(finite(base.samples, tradeCount))),
    observationMs: Math.max(1, finite(base.observationMs, 15000)),
    bookAgeMs: 0,
    spreadBps: bestBid > 0 ? (bestAsk / bestBid - 1) * 10000 : null,
    bookImbalance: topOfBookImbalance(bids, asks),
    imbalanceStability: clamp(finite(base.imbalanceStability, 0.5), 0, 1),
    tradePressureFast: clamp(finite(flow.pressure, base.tradePressureFast), -1, 1),
    tradeCount,
    buyNotional,
    sellNotional,
    averageTradeNotional: tradeCount > 0
      ? (buyNotional + sellNotional) / tradeCount
      : finite(base.averageTradeNotional, 0),
    bookUpdateRate: finite(base.bookUpdateRate, 1),
    tradeArrivalRate: tradeCount / Math.max(1, finite(base.observationMs, 15000) / 1000),
    aggressiveNotionalPerSecond: (buyNotional + sellNotional) /
      Math.max(1, finite(base.observationMs, 15000) / 1000),
    micropriceDeviationBps: mid > 0 ? (microprice / mid - 1) * 10000 : 0,
    bidDepthQuote: bidDepth,
    askDepthQuote: askDepth,
    depthRatio: askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? 10 : 1,
    spoofLikeScore: finite(base.spoofLikeScore, 0),
    askSpoofScore: finite(base.askSpoofScore, 0),
    askRefillRatio: finite(base.askRefillRatio, 0),
    askAbsorptionScore: finite(base.askAbsorptionScore, 0),
    bidAbsorptionScore: finite(base.bidAbsorptionScore, 0),
    breakoutScore: finite(base.breakoutScore, 0),
    sweepReclaimScore: finite(base.sweepReclaimScore, 0),
    ofiPersistence: finite(base.ofiPersistence, 0),
    persistentBidWall: Boolean(base.persistentBidWall),
    persistentAskWall: Boolean(base.persistentAskWall),
    dynamicStatus: String(base.dynamicStatus || "NEUTRAL"),
    dataQuality: finite(base.dataQuality, 0.5),
    turnover24hQuote: finite(base.turnover24hQuote, 0),
    minActionableTurnover24h: Math.max(1, finite(base.minActionableTurnover24h, 1)),
    trendContext: finite(base.trendContext, 0),
    marketHeatScore: finite(base.marketHeatScore, finite(scan?.market_heat_score, 0)),
    recentNotionalPerSecond: finite(
      base.recentNotionalPerSecond,
      finite(scan?.recent_notional_per_second, 0),
    ),
    notionalAcceleration: finite(base.notionalAcceleration, finite(scan?.notional_acceleration, 0)),
    tradeCountPerSecond: finite(base.tradeCountPerSecond, finite(scan?.trade_count_per_second, 0)),
    notionalTrend: finite(base.notionalTrend, finite(scan?.notional_trend, 0)),
    tradeSpeedTrend: finite(base.tradeSpeedTrend, finite(scan?.trade_speed_trend, 0)),
    tradeArrivalTrend: finite(base.tradeArrivalTrend, 0),
    // v6.2: path shape is measured over the scan's observation window and cannot be
    // recomputed from a single live snapshot, so the scan value is carried forward. The
    // candidate TTL is what bounds how stale it may be.
    pathEfficiency: finite(base.pathEfficiency, 1),
    reversalRate: finite(base.reversalRate, 0),
    noiseBandBps: finite(base.noiseBandBps, 0),
    quoteFlickerRate: finite(base.quoteFlickerRate, 0),
    // Perp positioning is sampled once per scan alongside the heat snapshot. Re-fetching it
    // at order time would add a network hop to the latency-critical path for a signal that
    // is capped at +/-0.03 of the edge, so the scan value is carried forward.
    fundingPremiumBps: 0,
    fundingAttention: 0,
    fundingEdge: 0,
  };
}

/** Total resting bid notional in the visible book. */
function bidDepthQuote(book: any): number {
  return (Array.isArray(book?.bids) ? book.bids : []).reduce(
    (total: number, level: any) =>
      total + finite(level?.price ?? level?.[0]) * finite(level?.size ?? level?.[1]),
    0,
  );
}

function candidatePlan(candidate: Candidate, settings?: TradingSettings) {
  const trade = candidate.snapshot?.trade_plan || {};
  const tick = finite(trade.tick_size, finite(candidate.feature_vector?.tick_size));
  const allocation = clamp(finite(trade.first_target_allocation_pct, 60), 50, 80);
  const strategy = String(trade.target_strategy || "SCALE_OUT");
  const isScalp = isScalpStrategy((settings as any)?.strategy);
  const scalpStopPct = finite((candidate as any).snapshot?.scalp?.stop_pct, 0.003);
  return {
    tick,
    allocation,
    // v5.3: SCALP always trails after the first target.
    //
    // v5.2.5 defaulted to SCALE_OUT, under which the runner kept the ORIGINAL stop after
    // T1 — so a position that reached +T and retraced closed the remainder at -S and
    // could end net negative despite having hit its target. The legacy 1.2% trail was
    // also inert at scalp scale: nextTrailingStop() floors at the hard stop, so with a
    // 0.6% target the trail never engaged until the peak passed +0.91%.
    exitPolicy: isScalp
      ? "TRAIL_AFTER_T1"
      : strategy === "TRAIL_AFTER_T1"
      ? "TRAIL_AFTER_T1"
      : strategy === "SHORT_ONLY"
      ? "FIXED_T1"
      : "SCALE_OUT",
    recommended: finite(
      trade.recommended_investment_quote,
      finite(trade.recommended_investment_krw),
    ),
    // Trail one stop-width below the peak instead of a flat 1.2%.
    trailingDistancePct: isScalp
      ? clamp(scalpStopPct * 100, 0.1, 5)
      : clamp(finite(candidate.feature_vector?.risk_snapshot?.trailing_distance_pct, 1.2), 0.5, 5),
  };
}
async function marketQuote(exchange: Exchange, market: string) {
  return gateway(exchange, { action: "quote", market });
}
function uniqueId(prefix: string, id: string) {
  const compact = id.replaceAll("-", "").slice(0, 12);
  const suffix = Date.now().toString(36).slice(-8);
  return `tb-${prefix}-${compact}-${suffix}`.slice(0, 36);
}
async function createOrderRecord(values: JsonRecord) {
  return (await insert("trading_orders", values))[0];
}
function feeResolutionFor(exchange: Exchange, market: string, order: any, fill: any) {
  return resolveFeeQuote({
    quoteAsset: quoteCurrency(exchange),
    baseAsset: baseAsset(exchange, market),
    defaultFeePct: FEE_PCT[exchange],
    order,
    fill,
    // Binance GET /api/v3/order omits commissions. The gateway now enriches it from
    // /api/v3/myTrades; a conservative fallback remains if that detail lookup fails.
    estimateWhenMissing: exchange === "binance",
  });
}
async function storeFills(orderRow: any, normalized: any) {
  const trades = Array.isArray(normalized?.trades) ? normalized.trades : [];
  if (!trades.length) return;
  const quote = orderRow.quote_currency;
  const allocatedFees = allocateNormalizedTradeFees({
    quoteAsset: quote,
    baseAsset: baseAsset(orderRow.exchange as Exchange, orderRow.market),
    defaultFeePct: FEE_PCT[orderRow.exchange as Exchange],
    aggregatePaidFee: finite(normalized?.paid_fee),
    aggregateFeeAsset: normalized?.fee_asset || null,
    executedFunds: finite(normalized?.executed_funds),
    trades,
  });
  const rows = trades.map((trade: any, index: number) => {
    const allocated = allocatedFees[index] || {
      feeAmount: 0,
      feeAsset: trade.fee_asset || null,
      feeQuoteEstimate: 0,
    };
    return {
      order_id: orderRow.id,
      trade_id: trade.trade_id || `${orderRow.id}-${index}`,
      price: finite(trade.price),
      volume: finite(trade.volume),
      funds_quote: finite(trade.funds, finite(trade.price) * finite(trade.volume)),
      fee_amount: allocated.feeAmount,
      fee_asset: allocated.feeAsset,
      fee_quote_estimate: allocated.feeQuoteEstimate,
      executed_at: trade.executed_at || null,
      raw: {
        ...(trade.raw || trade),
        fee_accounting: {
          version: "6.10.0",
          source: allocated.source,
          marked_quote: allocated.source === "THIRD_ASSET_MARKED",
          fee_quote: allocated.feeQuoteEstimate,
        },
      },
    };
  });
  await db("trading_fills?on_conflict=order_id,trade_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
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
  const trades = Array.isArray(order?.trades)
    ? order.trades
    : Array.isArray(fill?.trades)
    ? fill.trades
    : [];
  if (trades.length) {
    // Per-fill is authoritative: a single order can pay commission in several assets.
    return trades.reduce(
      (total: number, trade: any) =>
        String(trade?.fee_asset || "").toUpperCase() === symbol
          ? total + Math.max(0, finite(trade?.fee))
          : total,
      0,
    );
  }
  const aggregateAsset = String(fill?.feeAsset || order?.fee_asset || "").toUpperCase();
  return aggregateAsset === symbol ? Math.max(0, finite(fill?.paidFee, order?.paid_fee)) : 0;
}

async function updateOrderFromGateway(orderRow: any, payload: any) {
  const order = payload?.order || payload;
  const rawFill = payload?.fill || {
    executedVolume: finite(order?.executed_volume),
    executedFunds: finite(order?.executed_funds),
    averagePrice: finite(order?.average_price),
    paidFee: finite(order?.paid_fee),
    feeAsset: order?.fee_asset,
  };
  const progress = mergeOrderExecutionProgress({
    executedVolume: orderRow.executed_volume,
    executedFunds: orderRow.executed_funds_quote,
    averagePrice: orderRow.average_fill_price,
  }, rawFill);
  const fill = {
    ...rawFill,
    executedVolume: progress.executedVolume,
    executedFunds: progress.executedFunds,
    averagePrice: progress.averagePrice,
  };
  const feeResolution = feeResolutionFor(orderRow.exchange, orderRow.market, order, fill);
  const feeQuote = feeResolution.feeQuote;
  const feeQuality = feeResolution.source === "PER_FILL_QUOTE"
    ? "EXACT"
    : feeResolution.source === "AGGREGATE_QUOTE"
    ? "AGGREGATE_EXACT"
    : feeResolution.source === "THIRD_ASSET_MARKED"
    ? "THIRD_ASSET_MARKED"
    : feeResolution.source === "BASE_ASSET"
    ? "BASE_ASSET_ACCOUNTED"
    : feeResolution.source === "MIXED" && !feeResolution.estimated
    ? "EXACT"
    : feeResolution.source === "MISSING"
    ? "MISSING"
    : "ESTIMATED";
  // Attach the base-asset commission so the caller can book the NET quantity received.
  const paidFeeBase = baseAssetFee(
    order,
    fill,
    baseAsset(orderRow.exchange as Exchange, orderRow.market),
  );
  const rows = await patch("trading_orders", `id=eq.${orderRow.id}`, {
    exchange_order_id: order?.exchange_order_id || null,
    state: normalizedOrderState(orderRow.state, order?.status),
    executed_volume: progress.executedVolume,
    average_fill_price: progress.averagePrice || null,
    executed_funds_quote: progress.executedFunds,
    paid_fee_quote: feeQuote,
    fee_asset: fill.feeAsset || order?.fee_asset || null,
    fee_accounting_quality: feeQuality,
    fee_accounting_version: "6.10.0",
    fee_quote_source: feeResolution.source,
    fee_reconciled_at: feeQuality === "ESTIMATED" || feeQuality === "MISSING"
      ? null
      : new Date().toISOString(),
    fee_reconcile_next_at: feeQuality === "ESTIMATED" || feeQuality === "MISSING"
      ? orderRow.fee_reconcile_next_at || new Date(Date.now() + 60_000).toISOString()
      : null,
    completed_at:
      ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(order?.status))
        ? new Date().toISOString()
        : null,
    raw_response: {
      ...(order || {}),
      fee_accounting: {
        version: "6.10.0",
        source: feeResolution.source,
        fee_quote: feeQuote,
        aggregate_fee_asset: feeResolution.aggregateFeeAsset,
        positive_trade_fee_count: feeResolution.positiveTradeFeeCount,
        estimated: feeResolution.estimated,
        complete: feeResolution.complete,
      },
    },
  });
  await storeFills(orderRow, order);
  return {
    row: rows[0] || orderRow,
    order,
    fill: { ...fill, paidFeeQuote: feeQuote, paidFeeBase },
  };
}
async function applyEntryAccounting(position: Position, orderRow: any, fill: any) {
  const grossQuantity = finite(fill.executedVolume);
  const price = finite(fill.averagePrice);
  // v5.4.1: book what the account actually received, not what was matched. See baseAssetFee().
  const baseFee = Math.max(
    0,
    finite(fill.paidFeeBase, baseAssetFee(null, fill, position.base_asset)),
  );
  // Store the exact net quantity received. Holdings are allowed below the exchange order
  // step; only a future SELL request must be floored. Flooring here silently discarded up
  // to one step of real account inventory and pushed the same value into fake PnL loss.
  const quantity = Math.max(0, grossQuantity - baseFee);
  if (!(quantity > 0 && price > 0)) throw new Error("entry fill has no executable quantity");
  if (baseFee > 0) {
    await event(
      "ENTRY_BASE_FEE_ADJUSTED",
      `${position.exchange}:${position.market} commission paid in base asset`,
      {
        gross_quantity: grossQuantity,
        base_fee: baseFee,
        booked_quantity: quantity,
        base_asset: position.base_asset,
      },
      { positionId: position.id, orderId: orderRow.id, level: "INFO" },
    );
  }
  const adjusted = adjustedPlanForFill(
    position.planned_entry_price,
    price,
    position.stop_price,
    position.target_1,
    position.target_2,
  );
  const result = await rpc("apply_trading_entry_order", {
    p_order_id: orderRow.id,
    p_fill_price: price,
    p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity),
    p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_stop_price: tickRound(adjusted.stopPrice, position.tick_size, "down"),
    p_target_1: tickRound(adjusted.target1, position.tick_size, "up"),
    p_target_2: adjusted.target2 ? tickRound(adjusted.target2, position.tick_size, "up") : null,
  });
  return result?.position || position;
}
async function applyExitAccounting(
  position: Position,
  orderRow: any,
  fill: any,
  action: string,
  fallbackPrice: number,
  breakevenAfterT1 = true,
) {
  const quantity = finite(fill.executedVolume);
  const price = finite(fill.averagePrice, fallbackPrice);
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
      nextTrailingStop(
        position.trailing_stop,
        Math.max(price, finite(position.peak_price, position.average_entry_price)),
        finite(position.trailing_distance_pct, 1.2),
        position.stop_price,
      ),
    )
    : null;
  const baseFee = Math.max(
    0,
    finite(
      fill.paidFeeBase,
      baseAssetFee(orderRow?.raw_response || null, fill, position.base_asset),
    ),
  );
  const dustValueQuote = position.exchange === "upbit" ? 1000 : 1;
  const allocation = allocateExitFillToPosition({
    remainingQuantity: finite(position.remaining_quantity),
    fillQuantity: quantity,
    fillFunds: finite(fill.executedFunds, price * quantity),
    fillFeeQuote: finite(fill.paidFeeQuote, fill.paidFee),
    fillPrice: price,
    quantityStep: finite(position.quantity_step),
    dustValueQuote,
  });
  const residualPreview = calculateExitResidualAccounting({
    remainingQuantity: finite(position.remaining_quantity),
    soldQuantity: allocation.positionQuantity,
    baseFeeQuantity: baseFee * allocation.allocationRatio,
    markPrice: price,
    dustValueQuote,
  });
  const result = await rpc("apply_trading_exit_order", {
    p_order_id: orderRow.id,
    p_action: action,
    p_fill_price: price,
    p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity),
    p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_trailing_stop: nextTrail,
    p_dust_value_quote: dustValueQuote,
  });
  if (allocation.unallocatedQuantity > 0 && result?.applied !== false) {
    await event(
      "EXIT_FILL_DUST_UNALLOCATED",
      `${position.exchange}:${position.market} dust-sized fill excess kept outside position PnL`,
      {
        exchange_fill_quantity: quantity,
        position_quantity: allocation.positionQuantity,
        unallocated_quantity: allocation.unallocatedQuantity,
        unallocated_funds_quote: allocation.unallocatedFunds,
        unallocated_fee_quote: allocation.unallocatedFeeQuote,
      },
      { positionId: position.id, orderId: orderRow.id, level: "WARNING" },
    );
  }
  if (Boolean(result?.closed) && result?.applied !== false && position.metadata?.is_exploration) {
    try {
      await rpc("settle_lob_exploration_budget_v610", { p_position_id: position.id });
    } catch (error) {
      await event(
        "EXPLORATION_BUDGET_SETTLEMENT_FAILED",
        `${position.exchange}:${position.market} exploration budget settlement failed`,
        { error: error instanceof Error ? error.message : String(error) },
        { positionId: position.id, orderId: orderRow.id, level: "WARNING" },
      );
    }
  }
  if (Boolean(result?.closed) && residualPreview.residualValueQuote > 0) {
    await event(
      "EXIT_RESIDUAL_VALUED",
      `${position.exchange}:${position.market} residual included in economic close`,
      {
        sold_quantity: quantity,
        base_fee_quantity: baseFee,
        residual_quantity: finite(
          result?.position?.residual_quantity,
          residualPreview.residualQuantity,
        ),
        residual_value_quote: finite(
          result?.position?.residual_value_quote,
          residualPreview.residualValueQuote,
        ),
        accounting_version: result?.position?.accounting_version || "6.8.1",
      },
      { positionId: position.id, orderId: orderRow.id, level: "INFO" },
    );
  }
  if (Boolean(result?.closed) && position.metadata?.lob_signal) {
    try {
      const learned = await rpc("learn_lob_trade_outcome", {
        p_position_id: position.id,
      });
      await event(
        "LOB_ONLINE_PROFILE_UPDATED",
        `${position.exchange}:${position.market} online profile updated`,
        {
          profile: learned,
          exit_reason: position.metadata?.pending_exit_reason || action,
        },
        { positionId: position.id, orderId: orderRow.id, level: "INFO" },
      );
    } catch (error) {
      // Accounting is already committed and must never be rolled back because learning
      // failed. The hourly calibration invokes the idempotent backfill RPC.
      await event(
        "LOB_ONLINE_LEARNING_DEFERRED",
        `${position.exchange}:${position.market} online update deferred`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { positionId: position.id, orderId: orderRow.id, level: "WARNING" },
      );
    }
  }
  return {
    applied: Boolean(result?.applied),
    closed: Boolean(result?.closed),
    position: result?.position || position,
    fillPrice: price,
    quantity,
  };
}

function allocationConfig(settings: TradingSettings, exchange: Exchange) {
  return exchange === "upbit"
    ? {
      mode: settings.upbit_allocation_mode || "ALL",
      fixed: finite(settings.upbit_allocation_krw),
      reserve: finite(settings.upbit_reserve_krw),
    }
    : {
      mode: settings.binance_allocation_mode || "ALL",
      fixed: finite(settings.binance_allocation_usdt),
      reserve: finite(settings.binance_reserve_usdt),
    };
}
async function managedPortfolio(settings: TradingSettings, exchange: Exchange, portfolio: any) {
  const paper = settings.mode !== "LIVE_LIMITED";
  const [active, residualRows] = await Promise.all([
    db(
      `trading_positions?exchange=eq.${exchange}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&is_paper=eq.${paper}&select=market,state,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,paid_fees_quote,residual_value_quote`,
    ) as Promise<any[]>,
    db(
      `trading_residual_inventory?exchange=eq.${exchange}&state=in.(AVAILABLE,RESERVED_FOR_REENTRY,SWEEP_PENDING)&select=market,remaining_quantity,value_quote`,
    ).catch(() => []) as Promise<any[]>,
  ]);
  const residualInventoryValue = (residualRows || []).reduce((sum: number, row: any) => {
    const quantity = Math.max(0, finite(row.remaining_quantity));
    const livePrice = Math.max(0, finite(portfolio?.prices?.[row.market]));
    const markedValue = livePrice > 0 ? quantity * livePrice : Math.max(0, finite(row.value_quote));
    return sum + markedValue;
  }, 0);
  let bookedExposure = 0;
  let botPositionValue = 0;
  let reservedExposure = 0;
  for (const row of active || []) {
    const entry = Math.max(0, finite(row.average_entry_price, row.planned_entry_price));
    const current = Math.max(0, finite(portfolio?.prices?.[row.market], entry));
    const ledger = calculateExposureLedger({
      state: row.state,
      remainingQuantity: row.remaining_quantity,
      reservedQuote: row.reserved_quote,
      reservedQuantity: row.reserved_quantity,
      averageEntryPrice: row.average_entry_price,
      plannedEntryPrice: row.planned_entry_price,
      currentPrice: current,
      realizedCostQuote: row.realized_cost_quote,
      realizedProceedsQuote: row.realized_proceeds_quote,
      paidFeesQuote: row.paid_fees_quote,
      residualValueQuote: row.residual_value_quote,
      estimatedExitCostPct: FEE_PCT[exchange] / 100 + 0.0005,
    });
    bookedExposure += ledger.totalExposureQuote;
    reservedExposure += ledger.reservedExposureQuote;
    botPositionValue += ledger.liquidationValueQuote;
  }
  const capitalBaseQuote = Math.max(0, finite(portfolio.available_quote)) +
    Math.max(0, finite(portfolio.locked_quote)) + botPositionValue + residualInventoryValue;
  const config = allocationConfig(settings, exchange);
  const managed = calculateManagedCapital({
    capitalBaseQuote,
    availableQuote: finite(portfolio.available_quote),
    openCostQuote: bookedExposure,
    allocationMode: config.mode === "FIXED" ? "FIXED" : "ALL",
    fixedAllocationQuote: config.fixed,
    reserveQuote: config.reserve,
  });
  return {
    ...portfolio,
    managed: {
      ...managed,
      openCostQuote: bookedExposure,
      botPositionValueQuote: botPositionValue,
      reservedExposureQuote: reservedExposure,
      residualInventoryValueQuote: residualInventoryValue,
      maxStrategyExposurePct: clamp(
        finite((settings as any).scalp_max_strategy_exposure_pct, 100),
        10,
        100,
      ),
    },
  };
}

function exchangeLimits(settings: TradingSettings, exchange: Exchange) {
  const allocationControlled = isScalpStrategy((settings as any).strategy);
  return exchange === "upbit"
    ? {
      maxOrder: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_order_krw,
      minOrder: settings.min_order_krw,
      quoteStep: 1000,
      dailyBuy: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_daily_buy_krw,
    }
    : {
      maxOrder: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_order_usdt,
      minOrder: binanceMinOrderUsdt(settings.min_order_usdt),
      quoteStep: 0.01,
      dailyBuy: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_daily_buy_usdt,
    };
}
function positionMinNotionalQuote(position: Position): number {
  const stored = finite(
    position.min_notional_quote,
    position.exchange === "upbit" ? 5000 : BINANCE_MIN_ORDER_USDT,
  );
  return position.exchange === "binance" ? Math.max(BINANCE_MIN_ORDER_USDT, stored) : stored;
}
function accountQuantity(portfolio: any, asset: string, freeOnly = false): number {
  const row = (Array.isArray(portfolio?.accounts) ? portfolio.accounts : []).find((item: any) =>
    String(item.currency || item.asset).toUpperCase() === asset.toUpperCase()
  );
  return Math.max(0, finite(row?.balance ?? row?.free) + (freeOnly ? 0 : finite(row?.locked)));
}
async function symbolRules(exchange: Exchange, candidate: Candidate, plan: any) {
  if (exchange === "upbit") {
    return {
      price_tick: plan.tick || Math.max(0.00000001, candidate.entry_high * 0.000001),
      quantity_step: 0.00000001,
      min_notional: 5000,
    };
  }
  const info = await gateway(exchange, { action: "symbol_info", market: candidate.market });
  return {
    price_tick: finite(info.price_tick),
    quantity_step: finite(info.quantity_step || info.step_size),
    min_notional: finite(info.min_notional, 10),
  };
}
async function openPaperPosition(
  position: Position,
  candidate: Candidate,
  price: number,
  quantity: number,
  notional: number,
) {
  const fee = notional * FEE_PCT[position.exchange] / 100;
  const order = await createOrderRecord({
    position_id: position.id,
    candidate_id: candidate.id,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier: uniqueId("pe", position.id),
    market: position.market,
    side: "BUY",
    purpose: "ENTRY",
    order_type: "paper_limit_ioc",
    time_in_force: "IOC",
    requested_price: price,
    requested_volume: quantity,
    requested_notional_quote: notional,
    state: "EXCHANGE_DONE",
    executed_volume: quantity,
    average_fill_price: price,
    executed_funds_quote: notional,
    paid_fee_quote: fee,
    fee_asset: position.quote_currency,
    completed_at: new Date().toISOString(),
    raw_response: { paper: true },
  });
  await insert("trading_fills", {
    order_id: order.id,
    trade_id: `paper-${order.id}`,
    price,
    volume: quantity,
    funds_quote: notional,
    fee_amount: fee,
    fee_asset: position.quote_currency,
    fee_quote_estimate: fee,
    executed_at: new Date().toISOString(),
    raw: { paper: true },
  });
  return applyEntryAccounting(position, order, {
    executedVolume: quantity,
    executedFunds: notional,
    averagePrice: price,
    paidFeeQuote: fee,
  });
}

// --- Stage 4 scalp helpers ---------------------------------------------------
function scalpSafetyConfig(settings: TradingSettings): ScalpSafetyConfig {
  return {
    // The dashboard allocation (ALL/FIXED minus reserve) is the sole exposure ceiling.
    perOrderPctOfCapital: 1,
    dailyLossPctOfCapital: finite(
      (settings as any).scalp_daily_loss_pct,
      DEFAULT_SCALP_SAFETY.dailyLossPctOfCapital * 100,
    ) / 100,
    // No unapproved streak cap; the approved daily loss rail remains authoritative.
    maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
    killSwitch: (settings as any).scalp_kill_switch === true,
  };
}

function scalpCostConfig(
  settings: TradingSettings,
  exchange: Exchange,
  feePct = FEE_PCT[exchange],
): CostModelConfig {
  // v5.8.1: the order-time gate must apply the SAME threshold the barriers were solved
  // for. Holding an absolute 0.10% here while the throughput optimum yields 0.08% per
  // trade rejected every candidate the design was built to accept.
  const maker = (settings as any).scalp_maker_entry !== false;
  const geometry = resolveGeometryConfig({
    roundTripFeeFraction: feePct * 2 / 100,
    slippageAllowance: maker
      ? finite((settings as any).scalp_maker_slippage_allowance, 0.0003)
      : finite((settings as any).scalp_slippage_allowance, 0.0009),
    spreadCaptureFraction: maker ? finite((settings as any).scalp_spread_capture, 0.0005) : 0,
    edgeBudget: finite((settings as any).scalp_edge_budget, 0.10),
    minEdgeCostFraction: finite((settings as any).scalp_min_edge_cost_fraction, 0.25),
    minimumEdge: finite((settings as any).scalp_minimum_edge, DEFAULT_COST_MODEL.minimumEdge),
  });
  // v5.12: throughput control cannot modify the EV threshold.
  const roundTripCost = feePct * 2 / 100;
  return {
    ...DEFAULT_COST_MODEL,
    roundTripFeeFraction: roundTripCost,
    minimumEdge: resolveMinimumEdge(geometry),
  };
}

function scalpCandidateGateConfig(settings: TradingSettings & JsonRecord): GateConfig {
  const base = settings.mode === "LIVE_LIMITED" ? DEFAULT_CANDIDATE_GATE : SHADOW_CANDIDATE_GATE;
  return {
    ...base,
    lowerQuantile: settings.mode === "LIVE_LIMITED" ? 0.05 : 0.10,
    minWinProbabilityLowerBound: clamp(
      finite((settings as any).scalp_min_win_probability_lcb, 0.50),
      0.50,
      0.95,
    ),
    minFillProbabilityLowerBound: clamp(
      finite((settings as any).scalp_min_fill_probability_lcb, 0.30),
      0.05,
      0.95,
    ),
    minEffectiveSamples: settings.mode === "LIVE_LIMITED"
      ? Math.max(0, Math.floor(finite((settings as any).scalp_min_forecast_samples, 60)))
      : 0,
    minIndependentBlocks: settings.mode === "LIVE_LIMITED"
      ? Math.max(0, Math.floor(finite((settings as any).scalp_min_independent_blocks, 3)))
      : 0,
    requireCalibrationReady: settings.mode === "LIVE_LIMITED",
  };
}

/**
 * Day state for the scalp safety rails: today's realized P&L and the current
 * consecutive-loss streak, scoped to this exchange and paper/live mode.
 * Both exchanges use the operator's KST accounting day. The loss denominator is the
 * first total-equity snapshot after KST midnight, never the shrinking current balance.
 */
async function scalpDayState(
  exchange: Exchange,
  isPaper: boolean,
  currentEquityQuote: number,
): Promise<ScalpDayState> {
  const dayStart = dayBoundary(exchange);
  const [rows, seedRows] = await Promise.all([
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=eq.CLOSED&closed_at=gte.${dayStart}&select=realized_pnl_quote,closed_at&order=closed_at.desc`,
    ) as Promise<Array<{ realized_pnl_quote: number; closed_at: string }>>,
    isPaper ? Promise.resolve([]) : db(
      `trading_account_snapshots?exchange=eq.${exchange}&captured_at=gte.${dayStart}&select=total_equity_quote,captured_at&order=captured_at.asc&limit=1`,
    ),
  ]);
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
  return {
    realizedPnlQuote,
    consecutiveLosses,
    dailySeedEquityQuote: Math.max(
      0,
      finite(seedRows?.[0]?.total_equity_quote, currentEquityQuote),
    ),
  };
}

// =====================================================================================
// v6.5: the decision ledger
// =====================================================================================
//
// Until now a candidate that was rejected at order time left one INFO event and nothing
// else, while a candidate that traded left an order and a position with no key joining it
// back to the scan that produced it. Both halves of that are a problem, but the rejections
// are the worse one: the reasons trades DO NOT happen are the primary evidence for whether
// the gates are calibrated, and they were the least durable thing in the system.
//
// Every write here is best-effort. Instrumentation that can fail an order is worse than no
// instrumentation, and a swallowed failure that hides itself is worse still -- so failures
// are caught, but they raise an event rather than disappearing, which is exactly what the
// v6.3 `.catch(() => null)` on persistScan did not do.

interface DecisionRecord {
  decisionId: string;
  cycleId: string;
  scanId: string | null;
  exchange: Exchange;
  market: string;
  outcome: "ENTERED" | "REJECTED" | "ROTATED_IN" | "ERROR";
  reason: string | null;
  audit: JsonRecord | null;
}

async function recordDecision(record: DecisionRecord): Promise<void> {
  try {
    const audit = (record.audit || {}) as JsonRecord;
    await insert("trading_decisions", {
      id: record.decisionId,
      cycle_id: record.cycleId,
      scan_id: record.scanId,
      exchange: record.exchange,
      market: record.market,
      strategy: null,
      outcome: record.outcome,
      reason: record.reason ? String(record.reason).slice(0, 500) : null,
      ev_lower_bound_bps: finiteOrNull((audit as any).ev_lower_bound_bps),
      target_bps: finiteOrNull((audit as any).target_bps),
      stop_bps: finiteOrNull((audit as any).stop_bps),
      neutral_win_rate: finiteOrNull((audit as any).neutral_win_rate),
      p_target: finiteOrNull((audit as any).p_target),
      audit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await event("DECISION_LEDGER_WRITE_FAILED", message, { decision_id: record.decisionId }, {
      cycleId: record.cycleId,
      level: "WARNING",
    }).catch(() => null);
  }
}

async function recordLatency(trace: LatencyTrace, extra: JsonRecord = {}): Promise<void> {
  try {
    // A trace with no book anchor still gets written. The COUNT of decisions that could
    // not be timed is itself the SLO's coverage metric, so dropping them would make the
    // measurement look healthier the worse the instrumentation got.
    await insert("trading_latency_samples", trace.toRow(extra) as JsonRecord);
  } catch {
    // No event here: a latency row is pure telemetry and the ledger write above already
    // reports storage trouble. Retrying or escalating twice for the same outage adds noise.
  }
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The latency cost to charge this candidate, in bps.
 *
 * Prefers the book's own measured noise band scaled to the measured p95 tick-to-order
 * time. Falls back to the settings-level shrunk estimate, and finally to the flat 1bp
 * constant that was the only thing here before v6.5.
 */
function latencyPenaltyBpsFor(
  settings: TradingSettings & JsonRecord,
  noiseBandBps: number,
  observationWindowMs: number,
  policy: {
    assumedP95Ms: number;
    unmeasuredFloorBps: number;
    penaltyMultiplier: number;
  },
): { bps: number; source: string } {
  return resolveLatencyPenaltyBps({
    noiseBandBps,
    observationWindowMs,
    measured: String((settings as any).scalp_latency_source || "ASSUMED") === "MEASURED",
    measuredP95Ms: finite((settings as any).scalp_latency_p95_ms, 0),
    measuredSamples: Math.max(0, Math.floor(finite((settings as any).scalp_latency_samples, 0))),
    operatorPriorBps: Math.max(0, finite((settings as any).scalp_latency_penalty_bps, 0)),
    assumedP95Ms: Math.max(
      250,
      finite((settings as any).scalp_unmeasured_latency_ms, policy.assumedP95Ms),
    ),
    unmeasuredFloorBps: Math.max(
      0.25,
      finite(
        (settings as any).scalp_unmeasured_latency_penalty_bps,
        policy.unmeasuredFloorBps,
      ),
    ),
    penaltyMultiplier: policy.penaltyMultiplier,
  });
}

/**
 * v6.5: one wrapper around the entry path so that EVERY outcome is recorded once.
 *
 * `enterCandidateInner` has more than twenty early returns, each a different reason not to
 * trade. Adding a ledger write to each of them would guarantee that the next reason added
 * forgets one -- which is the same class of mistake as the swallowed catch. The wrapper
 * records whatever the inner function returns, so a rejection cannot be silent no matter
 * where in the gate it happens.
 */
async function enterCandidate(
  candidate: Candidate,
  settings: TradingSettings,
  portfolio: any,
  activeBases: Set<string>,
  cycleId: string,
) {
  const decisionId = crypto.randomUUID();
  const route = validateSpotMarket(candidate.exchange, candidate.market);
  if (!route.ok) {
    const reason = `invalid market route: ${route.reason}`;
    await recordDecision({
      decisionId,
      cycleId,
      scanId: candidate.scan_id ? String(candidate.scan_id) : null,
      exchange: candidate.exchange,
      market: String(candidate.market || ""),
      outcome: "REJECTED",
      reason,
      audit: {
        candidate_id: candidate.id,
        raw_exchange: candidate.exchange,
        raw_market: candidate.market,
      },
    });
    await event("CANDIDATE_MARKET_REJECTED", reason, {
      candidate_id: candidate.id,
      exchange: candidate.exchange,
      market: candidate.market,
    }, { cycleId, level: "WARNING" }).catch(() => null);
    return {
      entered: false,
      exchange: candidate.exchange,
      market: candidate.market,
      reason,
      decision_id: decisionId,
    };
  }
  candidate = { ...candidate, exchange: route.exchange, market: route.market };
  const trace = new LatencyTrace(decisionId, candidate.exchange, candidate.market);
  let result: any;
  try {
    result = await enterCandidateInner(
      candidate,
      settings,
      portfolio,
      activeBases,
      cycleId,
      decisionId,
      trace,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordDecision({
      decisionId,
      cycleId,
      scanId: candidate.scan_id ? String(candidate.scan_id) : null,
      exchange: candidate.exchange,
      market: candidate.market,
      outcome: "ERROR",
      reason: message,
      audit: (candidate as any).__decision_audit || null,
    });
    await recordLatency(trace, { outcome: "ERROR" });
    throw error;
  }
  const outcome = result?.entered ? "ENTERED" : result?.reserved ? "ENTERED" : "REJECTED";
  await recordDecision({
    decisionId,
    cycleId,
    scanId: candidate.scan_id ? String(candidate.scan_id) : null,
    exchange: candidate.exchange,
    market: candidate.market,
    outcome,
    reason: result?.reason ? String(result.reason) : null,
    audit: {
      ...((candidate as any).__decision_audit || {}),
      entered: Boolean(result?.entered),
      reserved: Boolean(result?.reserved),
      paper: Boolean(result?.paper),
      position_id: result?.position?.id || null,
      latency: trace.segments(),
    },
  });
  await recordLatency(trace, { outcome });
  return { ...result, decision_id: decisionId };
}

async function enterCandidateInner(
  candidate: Candidate,
  settings: TradingSettings,
  portfolio: any,
  activeBases: Set<string>,
  cycleId: string,
  decisionId: string,
  trace: LatencyTrace,
) {
  const exchange = candidate.exchange;
  const quote = quoteCurrency(exchange);
  const base = baseAsset(exchange, candidate.market);
  const recommendation = recommendationAdmission({
    strategy: (settings as any).strategy,
    recommendationValidUntil: candidate.recommendation_valid_until,
    candidateCreatedAt: candidate.created_at,
    lobLiveRecheckMaxAgeMs: lobRecommendationWindowSeconds(
      settings.full_scan_interval_seconds,
    ) * 1000,
  });
  (candidate as any).__decision_audit = { recommendation };
  if (!recommendation.allowed) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `recommendation expired (${recommendation.reason})`,
    };
  }
  const existing = await db(
    `trading_positions?exchange=eq.${exchange}&market=eq.${candidate.market}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id&limit=1`,
  );
  if (existing.length) {
    return { entered: false, exchange, market: candidate.market, reason: "market already tracked" };
  }
  if (settings.suppress_cross_exchange_same_asset && activeBases.has(base)) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `base asset ${base} already exposed on another market`,
    };
  }
  // v5.4: asset-scoped pause. A confirmed mismatch on one coin no longer stops the
  // whole system; it stops that coin.
  let activeLock: any = null;
  try {
    activeLock = (await db(
      `trading_asset_locks?exchange=eq.${exchange}&asset=eq.${
        encodeURIComponent(base)
      }&state=eq.LOCKED&select=reason,clean_checks&limit=1`,
    ))[0] || null;
  } catch (error) {
    // Rolling-deploy fallback: preserve a known legacy lock, but fail closed when the
    // authoritative lock ledger itself cannot be read. This blocks only a new entry;
    // monitor/exit paths remain independent and continue to protect existing holdings.
    const legacyLocks = Array.isArray((settings as any).manual_asset_locks)
      ? (settings as any).manual_asset_locks
      : [];
    if (legacyLocks.map(String).includes(`${exchange}:${base}`)) {
      activeLock = { reason: "LEGACY_MANUAL_ASSET_LOCK", clean_checks: 0 };
    } else {
      activeLock = {
        reason: "LOCK_LEDGER_QUERY_FAILED",
        clean_checks: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (activeLock) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `asset ${base} is paused: ${activeLock.reason || "account reconciliation"}`,
    };
  }

  const market = await marketQuote(exchange, candidate.market);
  // v6.5: the two anchors of the whole measurement. `book_captured` is the exchange's own
  // orderbook timestamp where the venue publishes one (Upbit) and the gateway's receipt
  // time where it does not (Binance) -- the difference is recorded, not smoothed over.
  trace.mark("book_captured", bookTimestampOf(market));
  trace.mark("quote_received");
  const bestAsk = finite(market.best_ask);
  const bestBid = finite(market.best_bid);
  if (!(bestAsk > 0 && bestBid > 0)) {
    return { entered: false, exchange, market: candidate.market, reason: "empty orderbook" };
  }
  if (
    accountQuantity(portfolio, base) * Math.max(finite(market.current), bestBid) >=
      (exchange === "upbit" ? 1000 : 1)
  ) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: "pre-existing account balance detected; manual and bot holdings are isolated",
    };
  }
  // v5.3: in SCALP the entry ceiling must come from the live book, not from the trend
  // plan's entry zone. `candidate.entry_high` is computed from 15m ATR structure and
  // routinely sits below the current ask, which silently blocked scalp entries.
  const scalpStopPctForCeiling = finite((candidate as any).snapshot?.scalp?.stop_pct, 0.003);
  const maxEntry = isScalpStrategy((settings as any).strategy)
    ? bestAsk * (1 + Math.min(0.25 * scalpStopPctForCeiling, 0.002))
    : finite(candidate.entry_high);
  if (!(maxEntry > 0) || bestAsk > maxEntry) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `best ask ${bestAsk} above entry ceiling ${maxEntry}`,
    };
  }
  const spreadBps = (bestAsk / bestBid - 1) * 10_000;
  const entryMaxSpreadBps = isLobStrategy((settings as any).strategy)
    ? Math.max(1, finite((settings as any).lob_max_spread_bps, 60))
    : LIVE_MAX_SPREAD_BPS;
  if (!Number.isFinite(spreadBps) || spreadBps > entryMaxSpreadBps) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `spread ${spreadBps.toFixed(1)}bp exceeds ${entryMaxSpreadBps}bp`,
    };
  }

  let lobSizingContext: any = null;
  if (isLobStrategy((settings as any).strategy)) {
    const lobSnapshot = (candidate as any).snapshot?.lob || {};
    const features = liveLobFeatures(lobSnapshot, market);
    const assignedPolicy = ((candidate as any).__policy_bundle as LobPolicyBundle | null) ??
      assignLobPolicy(await loadLobPolicyRuntime(), String(candidate.scan_id || cycleId));
    if (!assignedPolicy || assignedPolicy.version <= 0) {
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: "validated LOB policy unavailable",
      };
    }
    const livePattern = detectLobPatternName(features);
    const patternPolicy = patternDeployment(assignedPolicy.patternProfile, livePattern);
    const liveOnlineProfiles = Array.isArray((candidate as any).__live_online_profiles)
      ? (candidate as any).__live_online_profiles as LobOnlineProfileRow[]
      : assignedPolicy.onlineProfiles;
    const onlinePolicy = resolveLobOnlineMarketPolicy(
      liveOnlineProfiles,
      exchange,
      candidate.market,
      livePattern,
    );
    // v7 sizing permission is present-tense LOB-only as well. Historical market/pattern
    // outcomes stay in the audit payload but cannot shrink an otherwise valid live setup.
    const qualityScore = clamp(finite((features as any).dataQuality, 0), 0, 1);
    const featureScore = clamp(finite((features as any).samples, 0) / 4, 0, 1);
    const insufficient = String((features as any).dynamicStatus || "INSUFFICIENT")
      .toUpperCase().includes("INSUFFICIENT") || qualityScore < 0.25 || featureScore < 1;
    const evidenceSizing = {
      fraction: insufficient ? 0.35 : 1,
      qualityScore,
      featureScore,
      marketScore: 0,
      parentScore: 0,
      onlineScore: 0,
      marketRecencyWeight: 0,
      parentRecencyWeight: 0,
      lowEvidence: insufficient,
      cappedBy: insufficient ? "INSUFFICIENT_STATUS" : "NONE",
      reason: insufficient ? "current LOB evidence insufficient" : "current LOB evidence complete",
    };
    lobSizingContext = {
      lobSnapshot,
      features,
      assignedPolicy,
      livePattern,
      patternPolicy,
      onlinePolicy,
      evidenceSizing,
    };
  }

  const plan = candidatePlan(candidate, settings);
  const rules = await symbolRules(exchange, candidate, plan);
  const limits = exchangeLimits(settings, exchange);
  const managedPortfolioState = await managedPortfolio(settings, exchange, portfolio);
  const managed = managedPortfolioState.managed;
  if (finite(managed.managedAvailableQuote) < Math.max(limits.minOrder, rules.min_notional)) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: "managed allocation has no available buying power",
    };
  }
  const allocationOnly = isScalpStrategy((settings as any).strategy);
  const managedAvailable = finite(managed.managedAvailableQuote);
  const strategyExposureFraction = allocationOnly
    ? clamp(finite((settings as any).scalp_max_strategy_exposure_pct, 100), 10, 100) / 100
    : 1;
  // Quantity is floored to the exchange step after quote sizing. Fund one quantity/quote
  // step above the operator floor so that flooring cannot turn KRW 40,000 into 39,999.x.
  const executableMinimumNotional = Math.max(limits.minOrder, rules.min_notional) +
    Math.max(limits.quoteStep, Math.max(0, finite(rules.quantity_step)) * bestAsk);
  // Keep the configured denominator whenever capital supports it. If fixed division would
  // make every ticket smaller than the operator floor, contract concurrency just enough to
  // permit a valid ticket without increasing total strategy exposure.
  const configuredSlots = allocationOnly
    ? clamp(finite((settings as any).scalp_position_slots, 6), 1, 20)
    : 1;
  const slots = allocationOnly
    ? capitalSupportedSlotCount(
      finite(managed.managedCapitalQuote),
      strategyExposureFraction,
      configuredSlots,
      executableMinimumNotional,
    )
    : 1;
  // LOB evidence sizing is resolved from the immutable policy and current live book before
  // allocation. The configured slot count remains the hard ceiling denominator.
  const evidenceSize = allocationOnly
    ? isLobStrategy((settings as any).strategy)
      ? clamp(finite(lobSizingContext?.evidenceSizing?.fraction, 0.35), 0.10, 1)
      : clamp(finite((settings as any).scalp_size_fraction, 0.35), 0.05, 1)
    : 1;
  const visibleAskDepth = Math.max(
    0,
    (market.asks || []).reduce(
      (sum: number, row: any) => sum + finite(row.price ?? row[0]) * finite(row.size ?? row[1]),
      0,
    ),
  );
  const scalpStopPctForSizing = finite((candidate as any).snapshot?.scalp?.stop_pct, 0.003);
  const riskSizing = allocationOnly
    ? calculateOrderNotional({
      managedCapitalQuote: finite(managed.managedCapitalQuote),
      maxStrategyExposureFraction: strategyExposureFraction,
      desiredSlots: slots,
      perTradeLossBudgetQuote: finite(managed.managedCapitalQuote) *
        clamp(finite((settings as any).scalp_max_single_loss_pct, 5), 0.1, 100) / 100,
      stopPct: Math.max(0.000001, scalpStopPctForSizing),
      estimatedExitCostPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
      depthLimitedNotional: visibleAskDepth / LIVE_MIN_DEPTH_BUFFER,
      exchangeLimitedNotional: limits.maxOrder,
      sizeFraction: evidenceSize,
      currentExposureQuote: finite(managed.openCostQuote),
    })
    : null;
  const slotQuote = allocationOnly ? finite(riskSizing?.slotCap) : Number.POSITIVE_INFINITY;
  const riskNotional = allocationOnly && riskSizing
    ? enforceMinimumExecutableNotional(
      riskSizing,
      executableMinimumNotional,
      managedAvailable,
    )
    : 0;
  const maxOrder = allocationOnly
    ? Math.min(managedAvailable, riskNotional)
    : Math.min(limits.maxOrder, plan.recommended > 0 …24072 tokens truncated…onMinNotionalQuote(position);
  if (
    quantity * price < minNotional || (position.remaining_quantity - quantity) * price < minNotional
  ) quantity = position.remaining_quantity;
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) return { action: "NONE", reason: "zero sell quantity" };
  if (!position.is_paper) {
    position = {
      ...position,
      ...(await patch("trading_positions", `id=eq.${position.id}`, {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: action,
          pending_exit_reason: decisionReason || action,
          pending_exit_at: new Date().toISOString(),
        },
      }))[0],
    };
  }
  const result = position.is_paper
    ? await sellPaper(position, quantity, price, action, cycleId)
    : await sellLive(position, quantity, action, cycleId);
  return finalizeExitFill(position, result, action, price, cycleId, breakevenAfterT1);
}

function clearedReconciliationMetadata(metadata: JsonRecord | null | undefined): JsonRecord {
  const next = { ...(metadata || {}) };
  for (
    const key of [
      "reconciliation_phase",
      "reconciliation_failure_count",
      "reconciliation_last_error",
      "reconciliation_failed_at",
      "reconciliation_retry_at",
      "reconciliation_retry_started_at",
    ]
  ) delete next[key];
  next.reconciliation_last_success_at = new Date().toISOString();
  return next;
}

async function recordReconciliationFailure(
  position: Position,
  phase: ReconciliationPhase,
  message: string,
  cycleId: string,
  orderId?: string,
) {
  const decision = nextReconciliationFailure({
    previousFailures: finite(position.metadata?.reconciliation_failure_count),
    phase,
    maxAutomaticRetries: 3,
    baseBackoffMs: 5000,
  });
  const metadata = {
    ...(position.metadata || {}),
    reconciliation_phase: phase,
    reconciliation_failure_count: decision.failureCount,
    reconciliation_last_error: message,
    reconciliation_failed_at: new Date().toISOString(),
    reconciliation_retry_at: decision.retryAtMs == null
      ? null
      : new Date(decision.retryAtMs).toISOString(),
  };
  await patch("trading_positions", `id=eq.${position.id}`, { state: decision.state, metadata });
  if (decision.manualInterventionRequired) {
    await rpc("record_asset_lock_check_v610", {
      p_exchange: position.exchange,
      p_asset: position.base_asset,
      p_status: "MISMATCH",
      p_reason: `RECONCILIATION_FAILED_${phase}`,
      p_metadata: {
        cycle_id: cycleId,
        position_id: position.id,
        error: message,
        scope: "ASSET_ONLY",
      },
    }).catch(() => null);
  }
  await event(
    decision.manualInterventionRequired
      ? "RECONCILIATION_MANUAL_REQUIRED"
      : "RECONCILIATION_FAILED",
    `${position.exchange}:${position.market} ${phase.toLowerCase()} reconciliation failed`,
    {
      phase,
      failure_count: decision.failureCount,
      retry_at: metadata.reconciliation_retry_at,
      error: message,
      scope: "ASSET_ONLY",
    },
    {
      cycleId,
      positionId: position.id,
      orderId,
      level: decision.manualInterventionRequired ? "CRITICAL" : "WARNING",
    },
  );
}

async function reconcileEntryPending(
  position: Position,
  cycleId: string,
  settings?: TradingSettings,
) {
  if (position.is_paper) return;
  if (position.state === "RECONCILIATION_FAILED") {
    if (!reconciliationRetryDue(position.metadata?.reconciliation_retry_at)) return;
    position = {
      ...position,
      ...(await patch("trading_positions", `id=eq.${position.id}`, {
        state: "ENTRY_PENDING",
        metadata: {
          ...(position.metadata || {}),
          reconciliation_retry_started_at: new Date().toISOString(),
        },
      }))[0],
    };
  }
  let orderRow: any = null;
  // v6.6.1 legacy recovery: older maker entries were moved to RECONCILING before their
  // phase was stamped. They have zero booked quantity and an EXCHANGE_OPEN `tb-m-` order,
  // so the monitor filter skipped them forever and the exchange bid never reached its TTL
  // cancel. Rebuild the maker metadata from the durable order row; never infer a fill.
  if (
    !position.metadata?.maker_entry_identifier &&
    finite(position.initial_quantity) <= 0 &&
    finite(position.remaining_quantity) <= 0
  ) {
    orderRow = (await db(
      `trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&select=*&order=created_at.desc&limit=1`,
    ))[0];
    if (
      orderRow &&
      (String(orderRow.order_type).toUpperCase() === "LIMIT_MAKER" ||
        String(orderRow.identifier).startsWith("tb-m-"))
    ) {
      const metadata = {
        ...(position.metadata || {}),
        reconciliation_phase: "ENTRY",
        maker_entry_identifier: orderRow.identifier,
        maker_entry_order_id: orderRow.id,
        maker_entry_price: finite(orderRow.requested_price, position.planned_entry_price),
        maker_entry_placed_at: orderRow.requested_at || orderRow.created_at,
        legacy_maker_recovered_at: new Date().toISOString(),
      };
      position = {
        ...position,
        ...(await patch("trading_positions", `id=eq.${position.id}`, {
          state: "ENTRY_PENDING",
          metadata,
        }))[0],
      };
    }
  }
  // v5.5: a resting maker entry has its own lifecycle — TTL, book-drift cancel, and a
  // partial fill that must clear the exchange minimum before it is booked. The generic
  // path below would treat a still-working order as an orphan.
  if (position.metadata?.maker_entry_identifier && settings) {
    try {
      await syncMakerEntry(position, settings, cycleId);
    } catch (error) {
      await recordReconciliationFailure(
        position,
        "ENTRY",
        error instanceof Error ? error.message : String(error),
        cycleId,
        position.metadata?.maker_entry_order_id,
      );
    }
    return;
  }
  orderRow = orderRow ||
    (await db(
      `trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&select=*&order=created_at.desc&limit=1`,
    ))[0];
  if (!orderRow) {
    const createdAt = new Date((position as any).created_at || 0).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30_000) {
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "ORPHAN_ENTRY_PENDING",
        closed_at: new Date().toISOString(),
      });
      await event(
        "ORPHAN_ENTRY_CANCELLED",
        `${position.exchange}:${position.market} orphan pending entry cleared`,
        {},
        { cycleId, positionId: position.id, level: "WARNING" },
      );
    }
    return;
  }
  position = {
    ...position,
    ...(await patch("trading_positions", `id=eq.${position.id}`, {
      state: "RECONCILING",
      metadata: {
        ...(position.metadata || {}),
        reconciliation_phase: "ENTRY",
        reconciliation_started_at: new Date().toISOString(),
      },
    }))[0],
  };
  try {
    const order = await gateway(position.exchange, {
      action: "get_order",
      identifier: orderRow.identifier,
      market: position.market,
    });
    const updated = await updateOrderFromGateway(orderRow, order);
    if (finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0) {
      await applyEntryAccounting(position, orderRow, updated.fill);
      await patch("trading_positions", `id=eq.${position.id}`, {
        metadata: clearedReconciliationMetadata(position.metadata),
      });
    } else if (
      ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(updated.order?.status))
    ) {
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "ENTRY_NOT_FILLED",
        closed_at: new Date().toISOString(),
        metadata: clearedReconciliationMetadata(position.metadata),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const requested = new Date(orderRow.requested_at || orderRow.created_at || 0).getTime();
    if (Date.now() - requested > 120_000 && /not found|404|-2013|order/i.test(message)) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, {
        state: "NOT_FOUND",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "ENTRY_ORDER_NOT_FOUND",
        closed_at: new Date().toISOString(),
      });
    } else await recordReconciliationFailure(position, "ENTRY", message, cycleId, orderRow.id);
  }
}
async function reconcileExitPending(position: Position, cycleId: string) {
  if (position.is_paper) {
    await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN" });
    return;
  }
  if (position.state === "RECONCILIATION_FAILED") {
    if (!reconciliationRetryDue(position.metadata?.reconciliation_retry_at)) return;
    position = {
      ...position,
      ...(await patch("trading_positions", `id=eq.${position.id}`, {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          reconciliation_retry_started_at: new Date().toISOString(),
        },
      }))[0],
    };
  }
  const orderRow = (await db(
    `trading_orders?position_id=eq.${position.id}&side=eq.SELL&select=*&order=created_at.desc&limit=1`,
  ))[0];
  if (!orderRow) {
    await patch("trading_positions", `id=eq.${position.id}`, { state: "OPEN" });
    return;
  }
  position = {
    ...position,
    ...(await patch("trading_positions", `id=eq.${position.id}`, {
      state: "RECONCILING",
      metadata: {
        ...(position.metadata || {}),
        reconciliation_phase: "EXIT",
        reconciliation_started_at: new Date().toISOString(),
      },
    }))[0],
  };
  try {
    const order = await gateway(position.exchange, {
      action: "get_order",
      identifier: orderRow.identifier,
      market: position.market,
    });
    const updated = await updateOrderFromGateway(orderRow, order);
    if (finite(updated.fill.executedVolume) > 0) {
      const finalized = await finalizeExitFill(
        position,
        { orderRow, ...updated },
        String(orderRow.purpose || position.metadata?.pending_exit_action || "MANUAL_RECONCILE"),
        finite(updated.fill.averagePrice, position.average_entry_price),
        cycleId,
      );
      const refreshed = (finalized as any)?.position || position;
      const refreshedState = String(refreshed.state);
      await patch("trading_positions", `id=eq.${position.id}`, {
        // An already-APPLIED order is an idempotent no-op. If a timeout left the row in
        // RECONCILING, explicitly restore OPEN so durable TP recovery and normal monitoring
        // can continue instead of replaying the same completed exit forever.
        ...(refreshedState === "CLOSED" || finite(refreshed.remaining_quantity) <= 0
          ? {}
          : { state: "OPEN" }),
        metadata: clearedReconciliationMetadata(refreshed.metadata),
      });
    } else if (
      ["FILLED", "CANCELED", "PARTIALLY_FILLED_CANCELED"].includes(String(updated.order?.status))
    ) {
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "OPEN",
        metadata: {
          ...clearedReconciliationMetadata(position.metadata),
          pending_exit_action: null,
          pending_exit_at: null,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const requested = new Date(orderRow.requested_at || orderRow.created_at || 0).getTime();
    if (Date.now() - requested > 120_000 && /not found|404|-2013|order/i.test(message)) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, {
        state: "NOT_FOUND",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "OPEN",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: null,
          pending_exit_at: null,
        },
      });
    } else await recordReconciliationFailure(position, "EXIT", message, cycleId, orderRow.id);
  }
}

async function reconcileManualReduction(
  position: Position,
  actualQuantity: number,
  currentPrice: number,
  cycleId: string,
) {
  const previous = Math.max(0, finite(position.remaining_quantity));
  const actual = Math.max(0, Math.min(previous, finite(actualQuantity)));
  const missing = Math.max(0, previous - actual);
  if (!(missing > Math.max(1e-10, previous * 1e-7))) return position;
  const estimatedValue = missing * Math.max(0, finite(currentPrice, position.average_entry_price));
  const dust = position.exchange === "upbit" ? 1000 : 1;
  const closed = actual * Math.max(0, finite(currentPrice, position.average_entry_price)) < dust;
  const entryOrder = (await db(
    `trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&state=eq.APPLIED&select=executed_funds_quote,paid_fee_quote&order=created_at.asc&limit=1`,
  ).catch(() => []))[0];
  const accounting = manualReconcileAccounting({
    initialQuantity: finite(position.initial_quantity),
    actualQuantity: closed ? 0 : actual,
    originalEntryCostQuote: finite(entryOrder?.executed_funds_quote, position.realized_cost_quote),
    originalEntryFeeQuote: finite(entryOrder?.paid_fee_quote),
  });
  const metadata = {
    ...(position.metadata || {}),
    exclude_from_learning: true,
    manual_reconcile: {
      detected_at: new Date().toISOString(),
      previous_quantity: previous,
      actual_quantity: actual,
      missing_quantity: missing,
      estimated_value_quote: estimatedValue,
    },
  };
  const values: JsonRecord = {
    remaining_quantity: closed ? 0 : actual,
    realized_cost_quote: accounting.remainingCostQuote,
    realized_proceeds_quote: accounting.realizedProceedsQuote,
    paid_fees_quote: accounting.remainingEntryFeeQuote,
    realized_pnl_quote: accounting.realizedPnlQuote,
    metadata,
    ...(closed
      ? { state: "CLOSED", close_reason: "MANUAL_RECONCILE", closed_at: new Date().toISOString() }
      : {}),
  };
  const updated = (await patch("trading_positions", `id=eq.${position.id}`, values))[0] ||
    { ...position, ...values };
  await insert("trading_cash_flows", {
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    flow_type: "MANUAL_POSITION_REDUCTION",
    amount_quote: estimatedValue,
    details: {
      position_id: position.id,
      market: position.market,
      base_asset: position.base_asset,
      previous_quantity: previous,
      actual_quantity: actual,
      estimated_price: currentPrice,
    },
  });
  await event(
    "MANUAL_POSITION_REDUCTION",
    `${position.exchange}:${position.market} manual balance reduction reconciled`,
    {
      previous_quantity: previous,
      actual_quantity: actual,
      missing_quantity: missing,
      estimated_value_quote: estimatedValue,
      closed,
    },
    { cycleId, positionId: position.id, level: "CRITICAL" },
  );
  return updated;
}

async function detectExternalQuoteFlow(
  exchange: Exchange,
  portfolio: any,
  settings: TradingSettings & JsonRecord,
  cycleId: string,
) {
  const rows = await db(
    `trading_account_snapshots?exchange=eq.${exchange}&select=available_quote,captured_at&order=captured_at.desc&limit=1`,
  ) as any[];
  const last = rows?.[0];
  if (!last) return { detected: false, delta: 0, baseline: "INITIAL" };
  const since = String(last.captured_at || "");
  const snapshotAt = new Date(since).getTime();
  // A stale snapshot after deploy/restart is not evidence of manual trading. The
  // current monitor cycle will write a fresh snapshot and establish a new baseline.
  if (!Number.isFinite(snapshotAt) || Date.now() - snapshotAt > 120_000) {
    await event(
      "BALANCE_BASELINE_RESET",
      `${exchange} stale balance snapshot replaced without pausing trading`,
      {
        previous_snapshot_at: since,
        current_available_quote: finite(portfolio.available_quote),
        engine_version: VERSION,
      },
      { cycleId, level: "INFO" },
    );
    return { detected: false, delta: 0, baseline: "RESET" };
  }
  const orders = await db(
    `trading_orders?exchange=eq.${exchange}&state=eq.APPLIED&requested_at=gte.${
      encodeURIComponent(since)
    }&select=side,executed_funds_quote,paid_fee_quote,trading_positions!inner(is_paper)&trading_positions.is_paper=eq.false`,
  ) as any[];
  let expectedOrderDelta = 0;
  for (const order of orders || []) {
    const funds = Math.max(0, finite(order.executed_funds_quote));
    const fee = Math.max(0, finite(order.paid_fee_quote));
    expectedOrderDelta += String(order.side).toUpperCase() === "SELL"
      ? funds - fee
      : -(funds + fee);
  }
  const previous = finite(last.available_quote);
  const current = finite(portfolio.available_quote);
  const expected = previous + expectedOrderDelta;
  const externalDelta = current - expected;
  const threshold = exchange === "upbit" ? 5000 : 5;
  if (Math.abs(externalDelta) < threshold) return { detected: false, delta: externalDelta };
  const flowType = externalDelta < 0 ? "EXTERNAL_DECREASE" : "EXTERNAL_INCREASE";
  await insert("trading_cash_flows", {
    exchange,
    quote_currency: quoteCurrency(exchange),
    flow_type: flowType,
    amount_quote: Math.abs(externalDelta),
    details: {
      previous_available_quote: previous,
      expected_available_quote: expected,
      current_available_quote: current,
      bot_order_delta_quote: expectedOrderDelta,
      previous_snapshot_at: since,
      withdrawal_mode: settings.withdrawal_mode,
      detection_mode: "RECORD_ONLY",
      engine_version: VERSION,
    },
  });
  // Quote-balance deltas are informational. Deposits, fee rebates, conversions,
  // gateway changes and delayed snapshots can all produce them. They must never
  // be treated as proof of a manual trade or automatically pause the engine.
  await event(flowType, `${exchange} quote balance delta recorded; trading remains active`, {
    external_delta_quote: externalDelta,
    previous,
    expected,
    current,
    auto_pause: false,
  }, { cycleId, level: "WARNING" });
  return { detected: true, delta: externalDelta, flow_type: flowType, paused: false };
}

async function monitorCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const tracked = await db(
    "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=*&order=created_at.asc",
  ) as Position[];
  for (
    const ghost of tracked.filter((row) =>
      row.state !== "ENTRY_PENDING" && finite(row.remaining_quantity) <= 0 &&
      finite((row as any).reserved_quote) <= 0
    )
  ) {
    await patch("trading_positions", `id=eq.${ghost.id}`, {
      state: "CLOSED",
      remaining_quantity: 0,
      reserved_quote: 0,
      reserved_quantity: 0,
      reservation_expires_at: null,
      closed_at: ghost.closed_at || new Date().toISOString(),
      close_reason: ghost.close_reason || "ZERO_QUANTITY_AUTO_CLOSE_V610",
    });
    await event(
      "ZERO_QUANTITY_GHOST_CLOSED",
      `${ghost.exchange}:${ghost.market} zero-quantity ghost closed`,
      {},
      { cycleId, positionId: ghost.id, level: "WARNING" },
    );
  }
  for (
    const position of tracked.filter((p) =>
      p.state === "ENTRY_PENDING" ||
      (["RECONCILING", "RECONCILIATION_FAILED"].includes(p.state) && (
        p.metadata?.reconciliation_phase === "ENTRY" ||
        (
          !p.metadata?.reconciliation_phase &&
          finite(p.initial_quantity) <= 0 &&
          finite(p.remaining_quantity) <= 0
        )
      ))
    )
  ) await reconcileEntryPending(position, cycleId, settings);
  for (
    const position of tracked.filter((p) =>
      p.state === "EXITING" ||
      (["RECONCILING", "RECONCILIATION_FAILED"].includes(p.state) &&
        p.metadata?.reconciliation_phase === "EXIT")
    )
  ) await reconcileExitPending(position, cycleId);
  const feeReconciliations = await reconcileFeeLedger(cycleId);
  // Exchange balances move before our position ledger does. Resolve every durable resting
  // TP first — including rows whose metadata reference was lost — so account reconciliation
  // never classifies the bot's own fill as a manual sale.
  const tpCandidates = await db(
    "trading_positions?state=in.(OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&is_paper=eq.false&select=*&order=created_at.asc",
  ) as Position[];
  for (const position of tpCandidates) {
    try {
      await syncRestingTakeProfit(position, cycleId);
    } catch (error) {
      await event(
        "TP_PRE_RECONCILIATION_FAILED",
        `${position.exchange}:${position.market} TP settlement failed before balance comparison`,
        { error: error instanceof Error ? error.message : String(error) },
        { cycleId, positionId: position.id, level: "CRITICAL" },
      );
    }
  }
  const open = await db(
    "trading_positions?state=eq.OPEN&select=*&order=created_at.asc",
  ) as Position[];
  const lobPolicyRuntime = isLobStrategy((settings as any).strategy)
    ? await loadLobPolicyRuntime()
    : null;
  const championPolicy = lobPolicyRuntime?.champion
    ? policyBundleByVersion(lobPolicyRuntime, finite(lobPolicyRuntime.champion.version))
    : null;
  const actions: any[] = feeReconciliations.map((row) => ({
    action: "FEE_RECONCILIATION",
    ...row,
  }));
  const prices: Record<string, number> = {};
  const portfolios: Partial<Record<Exchange, any>> = {};
  const portfolioCapturedAt: Partial<Record<Exchange, string>> = {};
  const books: Record<string, any> = {};
  const unresolvedManualAssets: string[] = [];
  for (const exchange of ["upbit", "binance"] as Exchange[]) {
    const exchangePositions = open.filter((p) => p.exchange === exchange);
    const exchangeEnabled = exchange === "upbit"
      ? settings.upbit_enabled
      : settings.binance_enabled;
    // Disabling an exchange blocks new entries only. Existing positions must remain monitored and exit-capable.
    if (!exchangeEnabled && exchangePositions.length === 0) continue;
    const portfolio = await gateway(exchange, { action: "portfolio" });
    portfolios[exchange] = portfolio;
    portfolioCapturedAt[exchange] = new Date().toISOString();
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
    // v6.5.1: one malformed market or one failed quote must not reject the whole monitor
    // batch. The old Promise.all stopped exit evaluation for every healthy position.
    const quoteResults = await settleSpotMarketReads(
      exchangePositions,
      async (venue, market) => await marketQuote(venue, market),
    );
    const quoteErrorsByPosition = new Map<string, string>();
    // v5.4: retain the full book, not just the price. The holding decision is made from
    // the live orderbook; discarding it here is what forced the fallback to a wall clock.
    for (const result of quoteResults) {
      if (!result.ok) {
        quoteErrorsByPosition.set(String(result.item.id), result.error);
        continue;
      }
      prices[result.market] = finite(
        result.value.current,
        (finite(result.value.best_ask) + finite(result.value.best_bid)) / 2,
      );
      books[result.market] = result.value;
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
    const botLockedResult = await botLockedQuantities(exchange, exchangePositions);
    // v6.4: when the open-order book is unreadable we cannot attribute a lock to anyone.
    // Suppress the locked-balance branch entirely rather than blaming the user for it.
    const botLockedKnown = botLockedResult !== null;
    const botLockedByAsset = botLockedResult ?? new Map<string, number>();
    const allOpenOrderAssets = await openOrderAssets(exchange);
    const trackedExchangePositions = tracked.filter((p) => p.exchange === exchange);
    await recordJointObjectiveSnapshot(
      exchange,
      settings,
      portfolio,
      trackedExchangePositions,
    ).catch(() => null);
    await reconcilePersistedAssetLocks(
      exchange,
      portfolio,
      trackedExchangePositions,
      allOpenOrderAssets,
      cycleId,
    );
    if (!botLockedKnown) {
      await event(
        "BOT_LOCK_UNKNOWN",
        `${exchange} open orders unreadable; locked-balance mismatch checks suspended this cycle`,
        {
          positions: exchangePositions.length,
        },
        { cycleId, level: "WARNING" },
      );
    }
    const mismatches = new Set<string>();
    const vanishedAssets = new Set<string>();
    // v6.4: quantity we can actually sell right now, per asset. Used to size an exit on
    // an asset under review instead of refusing to exit at all.
    const sellableByAsset = new Map<string, number>();
    for (const originalPosition of exchangePositions.filter((row) => !row.is_paper)) {
      let position = originalPosition;
      // Only a position backed by a successfully APPLIED entry fill may be
      // compared with exchange balances. Ghost/legacy rows are cancelled rather
      // than mislabeled as a user manual sale.
      const appliedEntry = (await db(
        `trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&state=eq.APPLIED&select=id&limit=1`,
      ).catch(() => []))[0];
      if (!appliedEntry) {
        await patch("trading_positions", `id=eq.${position.id}`, {
          state: "CANCELLED",
          reserved_quote: 0,
          reserved_quantity: 0,
          reservation_expires_at: null,
          close_reason: "UNVERIFIED_OPEN_POSITION",
          closed_at: new Date().toISOString(),
          metadata: {
            ...(position.metadata || {}),
            exclude_from_learning: true,
            verification_error: "NO_APPLIED_ENTRY_ORDER",
          },
        });
        await event(
          "UNVERIFIED_POSITION_CANCELLED",
          `${exchange}:${position.market} unverified internal position cleared without pausing trading`,
          {},
          { cycleId, positionId: position.id, level: "WARNING" },
        );
        continue;
      }
      const expected = finite(position.remaining_quantity);
      const actualTotal = totalByAsset.get(position.base_asset) || 0;
      const actualFree = freeByAsset.get(position.base_asset) || 0;
      const botLocked = botLockedByAsset.get(position.base_asset) || 0;

      // Reconciliation verdict.
      //
      // v5.4.1 fixed the Binance case where the buy commission is taken out of the base
      // asset, so the account legitimately holds ~0.1% less than the matched quantity.
      // v6.4 moves the whole judgement into one unit-tested function in core.ts and adds
      // a NOTIONAL dust floor to it: a difference worth less than the operator's threshold
      // is accounting noise, not someone trading behind the bot.
      //
      // The verdict governs ENTRIES on this asset. It never governs exits — see the
      // monitor loop below.
      const referencePrice = Math.max(
        0,
        finite(prices[position.market], finite(position.average_entry_price)),
      );
      const dustQuote = dustToleranceQuote(settings, exchange);
      const verdict = reconcileAccount({
        bookedQuantity: expected,
        freeQuantity: actualFree,
        lockedQuantity: Math.max(0, actualTotal - actualFree),
        botLockedQuantity: botLockedKnown ? botLocked : null,
        price: referencePrice,
        dustToleranceQuote: dustQuote,
        feePctPerSide: FEE_PCT[exchange],
        quantityStep: finite(position.quantity_step, 0),
      });
      sellableByAsset.set(position.base_asset, verdict.sellableQuantity);

      if (verdict.shortfallQuantity > 1e-12) {
        const pendingSellOrders = await unappliedBotSellOrders(position);
        if (pendingSellOrders.length > 0) {
          if (finite(position.metadata?.account_mismatch_count) > 0) {
            await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                account_mismatch_count: 0,
                last_account_mismatch_at: null,
              },
            });
          }
          await event(
            "BALANCE_REDUCTION_DEFERRED_FOR_BOT_EXIT",
            `${exchange}:${position.market} balance reduction belongs to unsettled bot SELL`,
            {
              expected_quantity: expected,
              actual_quantity: actualTotal,
              shortfall_quantity: verdict.shortfallQuantity,
              orders: pendingSellOrders.map((row) => ({
                id: row.id,
                purpose: row.purpose,
                state: row.state,
                executed_volume: row.executed_volume,
                requested_volume: row.requested_volume,
              })),
            },
            { cycleId, positionId: position.id, level: "INFO" },
          );
          continue;
        }
      }

      if (verdict.verdict === "DUST_ALIGN") {
        position = {
          ...position,
          ...(await patch("trading_positions", `id=eq.${position.id}`, {
            remaining_quantity: verdict.alignedQuantity,
            metadata: {
              ...(position.metadata || {}),
              account_mismatch_count: 0,
              last_account_mismatch_at: null,
              fee_dust_healed_quantity: verdict.shortfallQuantity,
              fee_dust_healed_at: new Date().toISOString(),
            },
          }))[0],
        };
        await event(
          "LEDGER_FEE_DUST_HEALED",
          `${exchange}:${position.market} ledger aligned to account; difference below the dust threshold`,
          {
            expected_quantity: expected,
            actual_quantity: actualTotal,
            shortfall: verdict.shortfallQuantity,
            shortfall_quote: verdict.shortfallQuote,
            dust_tolerance_quote: dustQuote,
            tolerance_quantity: verdict.toleranceQuantity,
            healed_quantity: verdict.alignedQuantity,
            reason: verdict.reason,
          },
          { cycleId, positionId: position.id, level: "INFO" },
        );
        continue;
      }

      if (verdict.verdict === "UNKNOWN_LOCK") {
        await event(
          "ACCOUNT_LOCK_UNATTRIBUTED",
          `${exchange}:${position.market} locked balance cannot be attributed while open orders are unreadable`,
          {
            expected_quantity: expected,
            free_quantity: actualFree,
            total_quantity: actualTotal,
            reason: verdict.reason,
          },
          { cycleId, positionId: position.id, level: "WARNING" },
        );
        continue;
      }

      const totalMissing = verdict.verdict === "VANISHED";
      const freeMissing = verdict.verdict === "ASSET_REVIEW";
      const previousCount = Math.max(
        0,
        Math.floor(finite(position.metadata?.account_mismatch_count)),
      );
      if (!totalMissing && !freeMissing) {
        if (previousCount > 0) {
          await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: {
              ...(position.metadata || {}),
              account_mismatch_count: 0,
              last_account_mismatch_at: null,
            },
          });
        }
        continue;
      }
      if (freeMissing && botLocked > 0) {
        // Partially explained by our own orders but still short: record it and keep
        // watching. Never escalate a lock we are partly responsible for.
        await event(
          "ACCOUNT_LOCK_PARTIALLY_EXPLAINED",
          `${exchange}:${position.market} lock partially explained by bot orders`,
          {
            expected_quantity: expected,
            free_quantity: actualFree,
            bot_locked_quantity: botLocked,
            total_quantity: actualTotal,
          },
          { cycleId, positionId: position.id, level: "INFO" },
        );
      }
      const mismatchCount = previousCount + 1;
      position = {
        ...position,
        ...(await patch("trading_positions", `id=eq.${position.id}`, {
          metadata: {
            ...(position.metadata || {}),
            account_mismatch_count: mismatchCount,
            last_account_mismatch_at: new Date().toISOString(),
            observed_total_quantity: actualTotal,
            observed_free_quantity: actualFree,
          },
        }))[0],
      };
      if (mismatchCount < 3) {
        await event(
          "ACCOUNT_MISMATCH_OBSERVED",
          `${exchange}:${position.market} balance mismatch awaiting confirmation ${mismatchCount}/3`,
          {
            expected_quantity: expected,
            free_quantity: actualFree,
            total_quantity: actualTotal,
          },
          { cycleId, positionId: position.id, level: "WARNING" },
        );
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
        await event(
          "MANUAL_ASSET_LOCK",
          `${exchange}:${position.market} base-asset lock not explained by bot orders`,
          {
            expected_quantity: expected,
            free_quantity: actualFree,
            bot_locked_quantity: botLocked,
            total_quantity: actualTotal,
            scope: "ASSET_ONLY",
          },
          { cycleId, positionId: position.id, level: "WARNING" },
        );
      }
    }
    if (mismatches.size) {
      // Scope the pause to the affected assets. enterCandidate skips these; every other
      // market keeps trading.
      for (const asset of mismatches) {
        await rpc("record_asset_lock_check_v610", {
          p_exchange: exchange,
          p_asset: asset,
          p_status: "MISMATCH",
          p_reason: vanishedAssets.has(asset) ? "ASSET_VANISHED" : "UNATTRIBUTED_ACCOUNT_LOCK",
          p_metadata: { cycle_id: cycleId, source: "ACCOUNT_RECONCILIATION" },
        }).catch(() => null);
      }
      await event(
        "ASSET_SCOPED_PAUSE",
        `${exchange} entries paused for affected assets only; other markets continue`,
        {
          exchange,
          assets: [...mismatches],
          vanished: [...vanishedAssets],
          scope: "ASSET",
          source: "ACCOUNT_RECONCILIATION",
        },
        { cycleId, level: vanishedAssets.size ? "CRITICAL" : "WARNING" },
      );
    }
    const residualSweeps = await sweepResidualInventory(
      exchange,
      settings,
      trackedExchangePositions,
      allOpenOrderAssets,
      cycleId,
    );
    actions.push(...residualSweeps.map((row) => ({ action: "RESIDUAL_SWEEP", ...row })));
    for (const original of exchangePositions) {
      let position = original;
      // v6.4 -------------------------------------------------------------------------
      // A detected mismatch pauses NEW ENTRIES on that asset. It must never stop us from
      // MANAGING what we already hold.
      //
      // Until now this branch skipped the position entirely, so a coin under review was
      // never priced, never evaluated and never sold — the ledger froze it in place and
      // the only way out was a human selling by hand. An Upbit ETH position sat open for
      // 8h39m this way while every other market kept trading.
      //
      // The exit path below runs for these positions now; the only concession is that the
      // quantity is capped at what the account can actually deliver.
      const underReview = !position.is_paper && mismatches.has(position.base_asset);
      if (underReview) {
        const sellable = Math.max(0, finite(sellableByAsset.get(position.base_asset), 0));
        const booked = finite(position.remaining_quantity);
        if (sellable <= 0) {
          actions.push({
            exchange,
            market: position.market,
            action: "PAUSED",
            reason: "asset under review and nothing sellable in account",
          });
          await event(
            "EXIT_BLOCKED_NO_BALANCE",
            `${exchange}:${position.market} under review with no deliverable balance`,
            {
              booked_quantity: booked,
              sellable_quantity: sellable,
            },
            { cycleId, positionId: position.id, level: "WARNING" },
          );
          continue;
        }
        if (sellable + 1e-12 < booked) {
          position = { ...position, remaining_quantity: sellable };
          await event(
            "EXIT_QUANTITY_CAPPED",
            `${exchange}:${position.market} exit sized to deliverable balance while under review`,
            {
              booked_quantity: booked,
              sellable_quantity: sellable,
            },
            { cycleId, positionId: position.id, level: "WARNING" },
          );
        }
      }
      const current = prices[position.market];
      if (!(current > 0)) {
        // v6.4: this used to be a bare `continue`. A market that stops quoting produced no
        // log line anywhere, so a position could go unmanaged indefinitely and look normal.
        const priorMisses = Math.max(0, Math.floor(finite(position.metadata?.quote_miss_count)));
        const misses = priorMisses + 1;
        await patch("trading_positions", `id=eq.${position.id}`, {
          metadata: {
            ...(position.metadata || {}),
            quote_miss_count: misses,
            last_quote_miss_at: new Date().toISOString(),
          },
        }).catch(() => null);
        await event(
          "MARKET_DATA_UNAVAILABLE",
          `${exchange}:${position.market} no usable quote; exit evaluation skipped ${misses}x`,
          {
            consecutive_misses: misses,
            error: quoteErrorsByPosition.get(String(position.id)) || null,
            isolated: true,
          },
          { cycleId, positionId: position.id, level: misses >= 4 ? "CRITICAL" : "WARNING" },
        );
        actions.push({
          exchange,
          market: position.market,
          action: "UNEVALUATED",
          reason: "no market data",
        });
        continue;
      }
      if (finite(position.metadata?.quote_miss_count) > 0) {
        position = {
          ...position,
          ...(await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: {
              ...(position.metadata || {}),
              quote_miss_count: 0,
              last_quote_miss_at: null,
            },
          }))[0],
        };
      }
      const peak = Math.max(current, finite(position.peak_price, position.average_entry_price));
      const trough = Math.min(current, finite(position.trough_price, position.average_entry_price));
      const values: JsonRecord = { peak_price: peak, trough_price: trough };
      if (position.t1_completed && position.exit_policy === "TRAIL_AFTER_T1") {
        values.trailing_stop = nextTrailingStop(
          position.trailing_stop,
          peak,
          finite(position.trailing_distance_pct, 1.2),
          position.stop_price,
        );
      }
      if (
        peak !== finite(position.peak_price) || trough !== finite(position.trough_price) ||
        values.trailing_stop
      ) {
        position = {
          ...position,
          ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0],
        };
      }
      // v5.3: settle a resting take-profit that has reached a terminal state before
      // deciding anything else, so the position's remaining quantity is current.
      if (restingTpEnabled(settings, position)) {
        position = await syncRestingTakeProfit(position, cycleId);
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) {
          actions.push({
            exchange,
            market: position.market,
            action: "TARGET_1",
            reason: "resting take-profit filled",
          });
          continue;
        }
      }
      const scalpMode = isScalpStrategy((settings as any).strategy);
      // v5.12: TIMEOUT is one of the modelled barrier outcomes. Live edge may close the
      // position earlier, but the approved strategy profile always enforces max_holding_at.
      let decision = decideExit(
        position,
        current,
        Date.now(),
        settings.emergency_liquidation,
        true,
      );
      // v6.5: a slot marked for rotation by the scan cycle closes here, on the monitor's
      // own price and through the ordinary exit path -- cancelling the resting take-profit,
      // booking the fill, reconciling. The scan cycle deliberately does NOT sell: it has
      // neither a fresh price nor the exit plumbing, and a second code path that liquidates
      // positions is exactly the kind of divergence that produced the 8h39m ETH hold.
      if (
        decision.action === "NONE" && position.metadata?.rotation_displaced_at &&
        !settings.emergency_liquidation
      ) {
        decision = { action: "STOP", fraction: 1, reason: "rotation:displaced" } as any;
        await event(
          "SLOT_ROTATION_EXIT",
          `${exchange}:${position.market} closed to free capital for a better book`,
          {
            displaced_for: position.metadata?.rotation_displaced_for || null,
            slot_rate: position.metadata?.slot_rate || null,
            marked_at: position.metadata?.rotation_displaced_at,
          },
          { cycleId, positionId: position.id },
        );
      }
      if (
        isLobStrategy((settings as any).strategy) && decision.action === "NONE" &&
        !settings.emergency_liquidation
      ) {
        const book = books[position.market];
        const bids = (book?.bids || []).map((b: any) => ({
          price: finite(b.price ?? b[0]),
          size: finite(b.size ?? b[1]),
        }));
        const asks = (book?.asks || []).map((a: any) => ({
          price: finite(a.price ?? a[0]),
          size: finite(a.size ?? a[1]),
        }));
        const imbalance = topOfBookImbalance(bids, asks);
        const bestBid = finite(book?.best_bid);
        const bestAsk = finite(book?.best_ask);
        const spread = bestBid > 0 ? (bestAsk / bestBid - 1) * 10000 : Number.POSITIVE_INFINITY;
        const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
        const heldSeconds = Number.isFinite(openedAt)
          ? Math.max(0, (Date.now() - openedAt) / 1000)
          : 0;
        const entryDepth = Math.max(1, finite(position.metadata?.entry_bid_depth_quote, 1));
        const entryPolicyVersion = finite(position.metadata?.lob_signal?.policy?.version, -1);
        const entryPolicy = lobPolicyRuntime && entryPolicyVersion >= 0
          ? policyBundleByVersion(lobPolicyRuntime, entryPolicyVersion)
          : null;
        const pinnedCoinPolicy = position.metadata?.lob_signal?.coin_learning || {};
        const fallbackOnlinePolicy = resolveLobOnlineMarketPolicy(
          entryPolicy?.onlineProfiles ?? championPolicy?.onlineProfiles ?? [],
          exchange,
          position.market,
          String(position.metadata?.lob_signal?.pattern || "") as LobPatternName,
        );
        // Exit behavior is pinned at entry. A later profile update or promotion cannot
        // relabel an already-open position into another cohort or move its soft stop.
        const softExitGraceSeconds = clamp(
          finite(
            pinnedCoinPolicy.soft_exit_grace_seconds,
            fallbackOnlinePolicy.softExitGraceSeconds,
          ),
          6,
          24,
        );
        const softExitConfirmations = Math.round(clamp(
          finite(
            pinnedCoinPolicy.soft_exit_confirmations,
            fallbackOnlinePolicy.softExitConfirmations,
          ),
          2,
          4,
        ));
        const exit = evaluateLobExit({
          emergency: false,
          reconciliationFailed: String(position.state) === "RECONCILIATION_FAILED",
          currentPrice: current,
          stopPrice: finite(position.stop_price),
          targetPrice: finite(position.target_1),
          heldSeconds,
          maxHoldingSeconds: clamp(
            finite(position.metadata?.lob_signal?.max_holding_seconds, 180),
            1,
            300,
          ),
          bookImbalance: imbalance,
          tradePressure: finite(book?.trade_flow?.pressure, 0),
          micropriceDeviationBps: imbalance * Math.max(0, spread) * 0.5,
          spreadBps: spread,
          maxSpreadBps: finite((settings as any).lob_max_spread_bps, LIVE_MAX_SPREAD_BPS),
          bidDepthRatio: book ? bidDepthQuote(book) / entryDepth : 0,
          minBidDepthRatio: clamp(finite((settings as any).lob_min_bid_depth_ratio, 0.35), 0.05, 1),
          // Never reuse the ENTRY snapshot's dynamic risk label as though it were a live
          // observation. That stale value could force an exit on every monitor cycle.
          dynamicStatus: undefined,
          previousSoftReason: position.metadata?.lob_soft_exit_reason || null,
          softSignalStreak: finite(position.metadata?.lob_soft_exit_streak),
          softExitGraceSeconds,
          softExitConfirmations,
        });
        if (
          exit.nextSoftReason !== (position.metadata?.lob_soft_exit_reason || null) ||
          exit.nextSoftSignalStreak !== finite(position.metadata?.lob_soft_exit_streak)
        ) {
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                lob_soft_exit_reason: exit.nextSoftReason,
                lob_soft_exit_streak: exit.nextSoftSignalStreak,
                lob_soft_exit_profile_version: finite(
                  pinnedCoinPolicy.profile_version,
                  fallbackOnlinePolicy.profileVersion,
                ),
                lob_soft_exit_policy_version: entryPolicyVersion >= 0
                  ? entryPolicyVersion
                  : championPolicy?.version ?? 0,
                lob_soft_exit_last_checked_at: new Date().toISOString(),
              },
            }))[0],
          };
        }
        if (exit.exit) {
          decision = {
            action: exit.reason === "TARGET_HIT" ? "TARGET_1" : "STOP",
            fraction: 1,
            reason: `lob:${exit.reason}`,
          } as any;
          await event("LOB_EXIT", `${exchange}:${position.market} ${exit.reason}`, {
            ...exit,
            held_seconds: heldSeconds,
            imbalance,
            spread_bps: spread,
            online_policy: {
              ...fallbackOnlinePolicy,
              policy_version: entryPolicyVersion >= 0
                ? entryPolicyVersion
                : championPolicy?.version ?? 0,
              policy_lane: position.metadata?.lob_signal?.policy?.lane || "LEGACY",
              pinned_at_entry: Boolean(position.metadata?.lob_signal?.coin_learning),
              soft_exit_grace_seconds: softExitGraceSeconds,
              soft_exit_confirmations: softExitConfirmations,
            },
          }, { cycleId, positionId: position.id });
        } else {
          // v6.5: record what this slot is still earning per second, so the scan cycle can
          // compare a new book against the capital already committed WITHOUT re-quoting
          // every open position. The monitor already holds the price; the scan does not.
          const remaining = remainingValueBps({
            currentPrice: current,
            targetPrice: finite(position.target_1),
            stopPrice: finite(position.stop_price),
            entryPTarget: finite(position.metadata?.lob_signal?.p_target, 0),
            entryNeutralWinRate: finite(position.metadata?.lob_signal?.neutral_win_rate, 0),
            heldSeconds,
            edgeHalfLifeSeconds: Math.max(
              10,
              clamp(finite(position.metadata?.lob_signal?.max_holding_seconds, 180), 1, 300) / 2,
            ),
          });
          const expectedSeconds = expectedResolutionSeconds(
            Math.max(1, remaining.remainingUpsideBps),
            Math.max(1, remaining.remainingDownsideBps),
            finite(position.metadata?.lob_signal?.features?.noiseBandBps, 0) /
              Math.sqrt(
                Math.max(1, finite((settings as any).lob_observation_window_ms, 8000) / 1000),
              ),
            {
              min: 5,
              // A position cannot occupy the slot past its precommitted LOB timeout.
              // Reporting 600s here while the position must close at 180s understated
              // its profit rate and broke capital-rotation comparisons.
              max: Math.max(
                5,
                clamp(
                  finite(position.metadata?.lob_signal?.max_holding_seconds, 180) -
                    heldSeconds,
                  5,
                  300,
                ),
              ),
            },
          );
          await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: {
              ...(position.metadata || {}),
              slot_rate: {
                remaining_ev_bps: remaining.remainingEvBps,
                remaining_upside_bps: remaining.remainingUpsideBps,
                remaining_downside_bps: remaining.remainingDownsideBps,
                p_target_now: remaining.pTargetNow,
                expected_seconds_to_resolve: expectedSeconds,
                exit_cost_bps: FEE_PCT[exchange] * 100 + Math.max(0.4, spread * 0.55),
                measured_at: new Date().toISOString(),
              },
            },
          }).catch(() => null);
        }
      } else if (scalpMode && decision.action === "NONE" && !settings.emergency_liquidation) {
        const holdCfg = scalpHoldConfig(settings, exchange);
        const book = books[position.market];
        const liveImbalance = book
          ? topOfBookImbalance(
            (book.bids || []).map((b: any) => ({
              price: finite(b.price ?? b[0]),
              size: finite(b.size ?? b[1]),
            })),
            (book.asks || []).map((a: any) => ({
              price: finite(a.price ?? a[0]),
              size: finite(a.size ?? a[1]),
            })),
          )
          : 0;
        const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
        const heldMinutes = Number.isFinite(openedAt)
          ? Math.max(0, (Date.now() - openedAt) / 60_000)
          : 0;
        const hold = evaluateHold({
          entryPrice: finite(position.average_entry_price),
          currentPrice: current,
          targetPrice: finite(position.target_2, finite(position.target_1)),
          stopPrice: Math.max(finite(position.stop_price), finite(position.trailing_stop)),
          entryPWin: finite(position.metadata?.scalp_signal?.order_p_win, holdCfg.basePWin),
          // v5.7: as the signal ages the estimate must fall back to what the barrier
          // geometry alone implies, not to a flat constant.
          neutralWinRate: finite(position.metadata?.scalp_signal?.geometry?.neutral_win_rate, 0),
          liveImbalance,
          reversalStreak: Math.max(0, Math.floor(finite(position.metadata?.hold_reversal_streak))),
          heldMinutes,
          // v5.8: executed flow, spread and bid support — the market data that now carries
          // the entire burden of closing a position early.
          tradePressure: finite(book?.trade_flow?.pressure, 0),
          flowReversalStreak: Math.max(
            0,
            Math.floor(finite(position.metadata?.hold_flow_reversal_streak)),
          ),
          spreadBps: book && finite(book.best_bid) > 0
            ? (finite(book.best_ask) / finite(book.best_bid) - 1) * 10_000
            : null,
          bidDepthRatio: finite(position.metadata?.entry_bid_depth_quote, 0) > 0 && book
            ? bidDepthQuote(book) / finite(position.metadata?.entry_bid_depth_quote)
            : null,
          t1Completed: position.t1_completed === true,
        }, holdCfg);

        if (
          hold.reversalStreak !== finite(position.metadata?.hold_reversal_streak) ||
          hold.flowReversalStreak !== finite(position.metadata?.hold_flow_reversal_streak)
        ) {
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                hold_reversal_streak: hold.reversalStreak,
                hold_flow_reversal_streak: hold.flowReversalStreak,
                last_hold_edge: hold.liveEdge,
                last_hold_p_win: hold.livePWin,
                last_hold_at: new Date().toISOString(),
              },
            }))[0],
          };
        }
        // v5.8: a position that has stopped receiving quotes is not being managed. That is
        // an operator matter, not a reason to sell blind into a market we cannot see.
        const lastEval = Date.parse(
          String(position.metadata?.last_hold_at || position.opened_at || ""),
        );
        const minutesSinceEval = Number.isFinite(lastEval) ? (Date.now() - lastEval) / 60_000 : 0;
        if (
          marketDataStale(minutesSinceEval, holdCfg) && !position.metadata?.stale_data_flagged_at
        ) {
          await patch("trading_positions", `id=eq.${position.id}`, {
            metadata: {
              ...(position.metadata || {}),
              stale_data_flagged_at: new Date().toISOString(),
            },
          });
          await event(
            "POSITION_UNEVALUATED",
            `${exchange}:${position.market} no usable market data for ${
              Math.round(minutesSinceEval)
            }m; review required`,
            {
              minutes_since_evaluation: Math.round(minutesSinceEval),
            },
            { cycleId, positionId: position.id, level: "CRITICAL" },
          );
        }
        if (hold.action === "EXIT") {
          decision = { action: "STOP", fraction: 1, reason: `live_hold:${hold.reason}` } as any;
          await event("SCALP_HOLD_EXIT", `${exchange}:${position.market} live edge exhausted`, {
            reason: hold.reason,
            live_edge: hold.liveEdge,
            live_p_win: hold.livePWin,
            held_minutes: heldMinutes,
            expected_minutes: finite(position.metadata?.scalp_expected_minutes, 0),
            live_imbalance: liveImbalance,
          }, { cycleId, positionId: position.id, level: "INFO" });
        } else if (hold.action === "TIGHTEN" && position.t1_completed) {
          // Pull the trail up to just under the current price instead of dumping.
          const tightened = Math.max(
            finite(position.trailing_stop),
            current * (1 - Math.max(0.001, holdCfg.exitCostFraction * 2)),
          );
          if (tightened > finite(position.trailing_stop)) {
            position = {
              ...position,
              ...(await patch("trading_positions", `id=eq.${position.id}`, {
                trailing_stop: tightened,
              }))[0],
            };
            await event(
              "SCALP_HOLD_TIGHTEN",
              `${exchange}:${position.market} trail tightened on faded edge`,
              { reason: hold.reason, trailing_stop: tightened, live_edge: hold.liveEdge },
              { cycleId, positionId: position.id },
            );
          }
        }
      }
      // The resting order owns the first target. Without this the 15s poll would ALSO
      // fire a market TARGET_1 and the position would be sold twice.
      if (decision.action === "TARGET_1" && restingTpIdentifier(position)) {
        decision = {
          action: "NONE",
          fraction: 0,
          reason: "first target handled by resting order",
        } as any;
      }
      // Independent scalp backstop: no single position may lose more than the
      // operator-selected percentage, even if the normal stop failed or moved.
      if (isScalpStrategy((settings as any).strategy) && position.average_entry_price > 0) {
        const lossPct = (current - position.average_entry_price) / position.average_entry_price *
          100;
        const maxSingleLossPct = Math.abs(finite((settings as any).scalp_max_single_loss_pct, 5));
        if (lossPct <= -maxSingleLossPct) {
          decision = { action: "STOP", reason: "scalp_max_single_loss" } as any;
        }
      }
      if (decision.action === "NONE") continue;
      // v5.3: the resting sell locks the base asset. Cancel and CONFIRM before any market
      // exit; a rejected sell would leave the position open with no protection.
      if (restingTpIdentifier(position)) {
        const nonPriceDecisionConfirmed = String(decision.reason || "").startsWith("lob:") ||
          String(decision.reason || "").startsWith("live_hold:") ||
          String(decision.reason || "").startsWith("rotation:");
        const cancelled = await cancelRestingTakeProfit(position, cycleId);
        position = cancelled.position;
        if (!cancelled.ok) {
          actions.push({
            exchange,
            market: position.market,
            action: decision.action,
            error: "resting take-profit cancel unconfirmed; exit deferred one cycle",
          });
          continue;
        }
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) continue;
        const recheck = decideExit(
          position,
          current,
          Date.now(),
          settings.emergency_liquidation,
          true,
        );
        if (recheck.action !== "NONE") decision = recheck;
        else if (!nonPriceDecisionConfirmed) continue;
      }
      try {
        actions.push(
          await applyExit(
            position,
            current,
            decision.action,
            cycleId,
            (settings as any).scalp_breakeven_after_t1 !== false,
            decision.reason,
          ),
        );
      } catch (error) {
        actions.push({
          exchange,
          market: position.market,
          action: decision.action,
          error: error instanceof Error ? error.message : String(error),
        });
        await event("EXIT_ERROR", error instanceof Error ? error.message : String(error), {
          decision,
        }, { cycleId, positionId: position.id, level: "CRITICAL" });
      }
    }
  }
  const stillOpen = await db("trading_positions?state=eq.OPEN&select=*") as Position[];
  for (const exchange of Object.keys(portfolios) as Exchange[]) {
    await snapshotAccount(
      exchange,
      portfolios[exchange],
      stillOpen,
      prices,
      settings,
      portfolioCapturedAt[exchange],
    );
  }
  await patch("trading_settings", "id=eq.1", {
    last_monitor_at: new Date().toISOString(),
    last_gateway_heartbeat_at: new Date().toISOString(),
    gateway_error_count: 0,
    ...(settings.emergency_liquidation && stillOpen.length === 0
      ? { emergency_liquidation: false, pause_new_entries: true }
      : {}),
  });
  return { positions: open.length, actions, unresolved_manual_assets: unresolvedManualAssets };
}

// =====================================================================================
// v6.5: capital rotation
// =====================================================================================
//
// Entry has only ever asked one question per candidate: does this book clear its own cost
// floor? Capital already committed never entered the comparison, so with every slot full a
// book worth ten times the worst holding was declined without being compared to it. The
// scarce resource in this strategy is not opportunity, it is the slot-second.
//
// The comparison happens ONLY when a candidate was turned away for lack of capital. A free
// slot is always better than a rotation, because filling it costs nothing.

/**
 * Did this candidate fail on capital rather than on merit?
 *
 * Matched against the exact strings the sizing path produces. Anything else -- a failed
 * gate, a trap, a spread, a stale book -- is a judgement that the book is not worth
 * trading, and no amount of free capital would change it.
 */
function capitalStarved(reason: unknown): boolean {
  const text = String(reason || "").toLowerCase();
  if (!text) return false;
  return text.includes("managed allocation has no available buying power") ||
    text.includes("allocated order") && text.includes("below minimum");
}

/** Rotations already performed in the trailing hour, counted from the event log. */
async function countRecentRotations(): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  try {
    const rows = await db(
      `trading_events?code=eq.SLOT_ROTATION&created_at=gte.${encodeURIComponent(since)}&select=id`,
    ) as any[];
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    // Unknown means "assume the budget is spent". Failing closed on a throughput feature
    // costs one cycle of opportunity; failing open costs real money in churn.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Compare a starved candidate against the worst slot currently held, and mark that slot
 * for closure if the candidate wins by enough to pay for the switch.
 *
 * Nothing is sold here -- see the monitor cycle. This function's only side effects are a
 * metadata flag and an event.
 */
async function considerRotation(
  candidate: Candidate,
  entry: any,
  settings: TradingSettings & JsonRecord,
  cycleId: string,
): Promise<{ rotated: boolean; reason: string; detail?: JsonRecord } | null> {
  const rotationInput = (candidate as any).__rotation;
  // No rotation payload means the candidate never reached the LOB decision -- it was
  // rejected before its worth was ever computed, so there is nothing to compare.
  if (!rotationInput) return null;

  const open = await db(
    "trading_positions?state=eq.OPEN&select=id,exchange,market,opened_at,metadata,state",
  ).catch(() => []) as any[];

  const held: HeldPositionRate[] = (open || [])
    .map((row) => {
      const rate = row.metadata?.slot_rate;
      // A position the monitor has not yet measured is not a candidate for displacement.
      // Treating an unmeasured slot as worthless would make the newest position the first
      // one killed, which is precisely backwards.
      if (!rate) return null;
      const openedAt = Date.parse(String(row.opened_at || ""));
      return {
        positionId: String(row.id),
        exchange: String(row.exchange),
        market: String(row.market),
        remainingEvBps: finite(rate.remaining_ev_bps, 0),
        expectedSecondsToResolve: Math.max(1, finite(rate.expected_seconds_to_resolve, 180)),
        exitCostBps: Math.max(0, finite(rate.exit_cost_bps, 10)),
        ageSeconds: Number.isFinite(openedAt) ? Math.max(0, (Date.now() - openedAt) / 1000) : 0,
        state: String(row.state),
      } as HeldPositionRate;
    })
    .filter((row): row is HeldPositionRate => row !== null);

  if (!held.length) {
    return { rotated: false, reason: "no measured slot available to compare against" };
  }

  const decision = evaluateRotation(
    {
      exchange: candidate.exchange,
      market: candidate.market,
      evLowerBoundBps: finite(rotationInput.evLowerBoundBps, 0),
      expectedSecondsToResolve: Math.max(1, finite(rotationInput.expectedSecondsToResolve, 180)),
    },
    held,
    {
      candidateEntryCostBps: Math.max(0, finite(rotationInput.entryCostBps, 0)),
      rotationsInLastHour: 0, // budget is enforced by the caller, which knows the count
    },
    {
      hysteresisFraction: clamp(finite((settings as any).lob_rotation_hysteresis, 0.40), 0.10, 3),
      minHoldSeconds: clamp(finite((settings as any).lob_rotation_min_hold_seconds, 60), 10, 3600),
      maxRotationsPerHour: Math.max(
        0,
        Math.floor(finite((settings as any).lob_max_rotations_per_hour, 6)),
      ),
    },
  );

  const detail: JsonRecord = {
    candidate: `${candidate.exchange}:${candidate.market}`,
    candidate_rate_bps_per_second: decision.candidateRateBpsPerSecond,
    incumbent_rate_bps_per_second: decision.incumbentRateBpsPerSecond,
    improvement_bps_per_second: decision.improvementBpsPerSecond,
    required_improvement_bps_per_second: decision.requiredImprovementBpsPerSecond,
    switching_cost_bps: decision.switchingCostBps,
    net_candidate_ev_bps: decision.netCandidateEvBps,
    displace: decision.displace
      ? `${decision.displace.exchange}:${decision.displace.market}`
      : null,
    entry_reason: entry?.reason || null,
  };

  if (!decision.rotate || !decision.displace) {
    // Declined rotations are logged too. The distribution of near-misses is the evidence
    // for whether the hysteresis is set anywhere near right, and it is only visible if
    // the comparisons that failed are recorded as well as the ones that passed.
    await event("SLOT_ROTATION_DECLINED", decision.reason, detail, { cycleId, level: "INFO" });
    return { rotated: false, reason: decision.reason, detail };
  }

  const displaced = decision.displace;
  const rows = await patch("trading_positions", `id=eq.${displaced.positionId}`, {
    metadata: {
      ...((open.find((row) => String(row.id) === displaced.positionId)?.metadata) || {}),
      rotation_displaced_at: new Date().toISOString(),
      rotation_displaced_for: `${candidate.exchange}:${candidate.market}`,
      rotation_detail: detail,
    },
  }).catch(() => null);

  if (!rows || !rows.length) {
    await event("SLOT_ROTATION_FAILED", "could not mark the displaced position", detail, {
      cycleId,
      level: "WARNING",
    });
    return { rotated: false, reason: "failed to mark displaced position", detail };
  }

  await event("SLOT_ROTATION", decision.reason, detail, {
    cycleId,
    positionId: displaced.positionId,
    level: "INFO",
  });
  return { rotated: true, reason: decision.reason, detail };
}

async function scanCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const exchanges = (["upbit", "binance"] as Exchange[]).filter((exchange) =>
    exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled
  );
  const portfolios = {} as Record<Exchange, any>;
  const stats = {} as Record<Exchange, any>;
  const circuits = {} as Record<Exchange, any>;
  for (const exchange of exchanges) {
    portfolios[exchange] = await managedPortfolio(
      settings,
      exchange,
      await gateway(exchange, { action: "portfolio" }),
    );
    stats[exchange] = await accountStats(
      exchange,
      finite(portfolios[exchange].managed.managedCapitalQuote),
      settings.mode !== "LIVE_LIMITED",
      portfolios[exchange],
    );
    const limits = exchangeLimits(settings, exchange);
    // In SCALP mode the scalp-specific loss rails are authoritative. Without
    // this override the legacy 1.5% daily / 3% weekly circuit would stop the
    // engine long before the configured -20% scalp day limit.
    const circuitSettings = isScalpStrategy((settings as any).strategy)
      ? {
        ...settings,
        // Only operator-approved loss rails apply in SCALP. Allocation controls
        // determine exposure; hidden position, entry-count, weekly, and streak caps do not.
        max_open_positions: Number.MAX_SAFE_INTEGER,
        max_open_positions_per_exchange: Number.MAX_SAFE_INTEGER,
        max_daily_entries: Number.MAX_SAFE_INTEGER,
        max_daily_entries_per_exchange: Number.MAX_SAFE_INTEGER,
        max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 30),
        max_weekly_loss_pct: Number.MAX_SAFE_INTEGER,
        max_consecutive_losses: Number.MAX_SAFE_INTEGER,
      }
      : settings;
    circuits[exchange] = evaluateCircuit({
      mode: settings.mode,
      configured: settings.configured,
      exchangeEnabled: true,
      pauseNewEntries: settings.pause_new_entries || settings.withdrawal_mode ||
        settings.manual_intervention_required,
      pausedByOperator: Boolean(settings.pause_new_entries),
      withdrawalMode: Boolean(settings.withdrawal_mode),
      manualInterventionRequired: Boolean(settings.manual_intervention_required),
      emergencyLiquidation: settings.emergency_liquidation,
      availableQuote: finite(portfolios[exchange].managed.managedAvailableQuote),
      minOrderQuote: limits.minOrder,
      openPositionsGlobal: stats[exchange].openGlobal,
      openPositionsExchange: stats[exchange].openExchange,
      entriesTodayGlobal: stats[exchange].entriesTodayGlobal,
      entriesTodayExchange: stats[exchange].entriesTodayExchange,
      dailyBoughtQuote: stats[exchange].dailyBoughtQuote,
      maxDailyBuyQuote: limits.dailyBuy,
      dailyPnlPct: stats[exchange].dailyPnlPct,
      weeklyPnlPct: stats[exchange].weeklyPnlPct,
      consecutiveLosses: stats[exchange].consecutiveLosses,
      settings: circuitSettings,
    });
  }
  if (!exchanges.some((exchange) => circuits[exchange].allowNewEntry)) {
    await event(
      "ENTRY_CIRCUIT_BLOCK",
      "new entries blocked on all exchanges",
      { circuits, stats },
      { cycleId, level: exchanges.some((x) => circuits[x].hardStop) ? "CRITICAL" : "WARNING" },
    );
    await patch("trading_settings", "id=eq.1", {
      last_full_scan_at: new Date().toISOString(),
      last_gateway_heartbeat_at: new Date().toISOString(),
    });
    return { skipped: true, circuits, stats };
  }
  // v5.12: rate control changes capacity only. EV/pWin/pFill and risk gates are immutable.
  const rateCfg = resolveRateControlConfig({
    targetTradesPerHour: finite((settings as any).scalp_target_trades_per_hour, 5),
    windowMinutes: finite((settings as any).scalp_rate_window_minutes, 60),
    minSlots: finite((settings as any).scalp_min_position_slots, 2),
    maxSlots: finite((settings as any).scalp_max_position_slots, 12),
    targetUtilization: finite((settings as any).scalp_target_utilization, 0.70),
    minScanUniverse: finite((settings as any).scalp_min_scan_universe, 30),
    maxScanUniverse: finite((settings as any).scalp_max_scan_universe, 240),
    minEvaluationIntervalSeconds: 30,
    maxEvaluationIntervalSeconds: 300,
    unprovenSizeFraction: finite((settings as any).scalp_unproven_size_fraction, 0.35),
    samplesForFullSize: finite((settings as any).scalp_samples_for_full_size, 400),
  });
  if (isLobStrategy((settings as any).strategy)) {
    // LOB online learning owns ranking, stops and confirmations. Slot count is operator
    // capital allocation and must never be auto-tuned.
    const desiredSlots = clamp(finite((settings as any).scalp_position_slots, 6), 1, 20);
    const scanUniverse = clamp(finite((settings as any).scalp_scan_universe, 120), 20, 1000);
    const interval = clamp(finite((settings as any).lob_scan_interval_seconds, 15), 10, 60);
    settings = {
      ...settings,
      scalp_size_fraction: 1,
      scalp_position_slots: desiredSlots,
      scalp_scan_universe: scanUniverse,
      full_scan_interval_seconds: interval,
      max_new_entries_per_scan: Math.min(20, desiredSlots),
    } as any;
    await patch("trading_settings", "id=eq.1", {
      scalp_size_fraction: 1,
      scalp_scan_universe: scanUniverse,
      full_scan_interval_seconds: interval,
      max_new_entries_per_scan: Math.min(20, desiredSlots),
    }).catch(() => null);
  } else if ((settings as any).strategy === "SCALP") {
    const windowStart = new Date(Date.now() - rateCfg.windowMinutes * 60_000).toISOString();
    // Throughput target is FILLED entries, not submitted/cancelled attempts.
    const recent = await db(
      `trading_positions?opened_at=gte.${encodeURIComponent(windowStart)}&is_paper=eq.${
        settings.mode !== "LIVE_LIMITED"
      }&select=id,exchange`,
    ).catch(() => []) as any[];
    const perExchange = (["upbit", "binance"] as Exchange[])
      .filter((x) => exchanges.includes(x))
      .map((x) => (recent || []).filter((r) => r.exchange === x).length);
    const slowest = perExchange.length ? Math.min(...perExchange) : 0;
    const rate = evaluateRateControl({
      entriesInWindow: slowest,
      observedMinutes: rateCfg.windowMinutes,
      currentSlots: finite((settings as any).scalp_position_slots, 6),
      currentScanUniverse: finite((settings as any).scalp_scan_universe, 60),
      currentEvaluationIntervalSeconds: finite(settings.full_scan_interval_seconds, 60),
      averageHoldingMinutes: finite((settings as any).scalp_average_holding_minutes, 15),
      pFillLowerBound: finite((settings as any).scalp_min_fill_probability_lcb, 0.30),
      currentRelaxation: finite((settings as any).scalp_rate_relaxation, 0),
      edgeSamples: Math.max(0, Math.floor(finite((settings as any).scalp_edge_budget_samples))),
      measuredEdgeLowerBound: (settings as any).scalp_edge_budget_source === "MEASURED"
        ? finite((settings as any).scalp_edge_budget, 0)
        : null,
    }, rateCfg);
    const nextPerScan = Math.max(1, Math.min(12, rate.desiredSlots));
    settings = {
      ...settings,
      scalp_rate_relaxation: 0,
      scalp_size_fraction: rate.sizeFraction,
      scalp_position_slots: rate.desiredSlots,
      scalp_scan_universe: rate.scanUniverse,
      full_scan_interval_seconds: rate.evaluationIntervalSeconds,
      max_new_entries_per_scan: nextPerScan,
    } as any;
    await patch("trading_settings", "id=eq.1", {
      scalp_rate_relaxation: 0,
      scalp_size_fraction: rate.sizeFraction,
      scalp_position_slots: rate.desiredSlots,
      scalp_scan_universe: rate.scanUniverse,
      full_scan_interval_seconds: rate.evaluationIntervalSeconds,
      max_new_entries_per_scan: nextPerScan,
    }).catch(() => null);
    await event(
      "SCALP_RATE_CONTROL",
      `observed ${rate.observedRate.toFixed(1)}/h vs target ${rate.targetRate}/h`,
      {
        observed_rate: rate.observedRate,
        target_rate: rate.targetRate,
        threshold_relaxation: 0,
        desired_slots: rate.desiredSlots,
        scan_universe: rate.scanUniverse,
        evaluation_interval_seconds: rate.evaluationIntervalSeconds,
        attempts_required_per_hour: rate.attemptsRequiredPerHour,
        estimated_filled_capacity_per_hour: rate.estimatedFilledCapacityPerHour,
        size_fraction: rate.sizeFraction,
        edge_negative: rate.edgeNegative,
        reason: rate.reason,
      },
      { cycleId, level: rate.edgeNegative ? "WARNING" : "INFO" },
    );
  }

  const result = await runScanner(portfolios, settings);
  const scanId = String(result.scan_id || result.meta?.scan_id || "");
  if (!scanId) throw new Error("scanner response did not include scan_id");
  await db(`trading_cycle_runs?id=eq.${cycleId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ scan_id: scanId }),
  });
  const candidates = await loadBuyCandidates(scanId, settings, cycleId);
  const active = (await db(
    "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=exchange,market,base_asset",
  )) as any[];
  const activeMarkets = new Set(active.map((row) => `${row.exchange}:${row.market}`));
  const activeBases = new Set(active.map((row) => row.base_asset));
  const entries: any[] = [];
  const enteredPerExchange: Record<Exchange, number> = { upbit: 0, binance: 0 };
  const rotations: any[] = [];
  const rotationBudget = (settings as any).lob_rotation_enabled === false
    ? 0
    : Math.max(0, Math.floor(finite((settings as any).lob_max_rotations_per_hour, 6)));
  let rotationsThisHour = rotationBudget > 0 ? await countRecentRotations() : 0;
  for (const candidate of candidates) {
    const exchange = candidate.exchange;
    // v6.3: how many books are actually competing for capital this cycle, and how much is
    // already committed. Slot sizing needs both, or it divides the account by a slot count
    // that no candidate exists to fill.
    (candidate as any).__candidate_pool_size = candidates.length;
    (candidate as any).__open_positions = active.length;
    if (!exchanges.includes(exchange) || !circuits[exchange]?.allowNewEntry) continue;
    if (
      entries.filter((row) => row.entered || row.reserved).length >=
        settings.max_new_entries_per_scan
    ) break;
    const exchangeCapacity = isScalpStrategy((settings as any).strategy)
      ? Number.MAX_SAFE_INTEGER
      : Math.min(
        settings.max_open_positions_per_exchange - stats[exchange].openExchange,
        settings.max_daily_entries_per_exchange - stats[exchange].entriesTodayExchange,
      );
    if (enteredPerExchange[exchange] >= Math.max(0, exchangeCapacity)) continue;
    if (activeMarkets.has(`${exchange}:${candidate.market}`)) continue;
    try {
      const entry = await enterCandidate(
        candidate,
        settings,
        portfolios[exchange],
        activeBases,
        cycleId,
      );
      entries.push(entry);
      if (entry.entered || entry.reserved) {
        enteredPerExchange[exchange]++;
        activeMarkets.add(`${exchange}:${candidate.market}`);
        activeBases.add(baseAsset(exchange, candidate.market));
        // Recompute booked exposure after every fill OR resting reservation. Without this,
        // later candidates in the same scan reused capital already committed by the first.
        const refreshedRaw = !entry.paper
          ? await gateway(exchange, { action: "portfolio" })
          : portfolios[exchange];
        portfolios[exchange] = await managedPortfolio(settings, exchange, refreshedRaw);
      } else if (capitalStarved(entry.reason) && rotationsThisHour < rotationBudget) {
        // v6.5: the book cleared every gate and was turned away only because the capital
        // is already spent. Until now that was the end of it -- a candidate worth ten
        // times the worst holding was declined without ever being compared to it, which
        // is the wrong objective for a strategy whose scarce resource is the slot-second.
        const rotation = await considerRotation(candidate, entry, settings, cycleId);
        if (rotation?.rotated) {
          rotationsThisHour++;
          rotations.push(rotation);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ entered: false, exchange, market: candidate.market, error: message });
      await event("ENTRY_ERROR", message, { candidate_id: candidate.id, exchange }, {
        cycleId,
        level: "CRITICAL",
      });
    }
  }
  await patch("trading_settings", "id=eq.1", {
    last_full_scan_at: new Date().toISOString(),
    last_gateway_heartbeat_at: new Date().toISOString(),
    gateway_error_count: 0,
  });
  await completeLobPolicyExposure(
    cycleId,
    entries.length,
    entries.filter((row) => row.entered || row.reserved).length,
  );
  const admission = summarizeEntryAdmission(candidates.length, entries);
  await event(
    admission.admissionCollapse ? "ENTRY_ADMISSION_COLLAPSE" : "ENTRY_ADMISSION_SUMMARY",
    admission.admissionCollapse
      ? `${admission.attempts} entry attempts produced zero reservations`
      : `${admission.reservations}/${admission.attempts} entry attempts reserved`,
    {
      ...admission,
      scan_id: scanId,
      // The raw decisions remain in the decision ledger. This compact aggregate makes a
      // throughput collapse visible in one status row instead of requiring thousands of
      // individual rejection records to be inspected.
      rejection_reasons: admission.rejectionReasons,
    },
    { cycleId, level: admission.admissionCollapse ? "WARNING" : "INFO" },
  );
  return {
    scan_id: scanId,
    buy_candidates: candidates.length,
    entries,
    admission,
    rotations,
    circuits,
    stats,
  };
}

async function status(settings: TradingSettings & JsonRecord) {
  const [
    positions,
    closedPositions,
    orders,
    cycles,
    snapshots,
    events,
    cashFlows,
    profiles,
    lobBatchProfiles,
    lobOnlineStatus,
    lobPolicyStatus,
    scalpCalibration,
    assetLocks,
    residualInventory,
    objectiveSnapshots,
  ] = await Promise.all([
    db(
      "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=*&order=created_at.desc",
    ),
    db("trading_positions?state=eq.CLOSED&select=*&order=closed_at.desc&limit=20"),
    db("trading_orders?select=*&order=created_at.desc&limit=40"),
    db("trading_cycle_runs?select=*&order=started_at.desc&limit=20"),
    db("trading_account_snapshots?select=*&order=captured_at.desc&limit=8"),
    db("trading_events?select=*&order=created_at.desc&limit=50"),
    db("trading_cash_flows?select=*&order=detected_at.desc&limit=20"),
    db(
      "scanner_runtime_profiles?select=version,source,active,parameters,samples,validation_samples,objective,champion_objective,evidence,promoted_at,parent_version&order=version.desc&limit=3",
    ).catch(() => []),
    db(
      "lob_learning_profiles?active=eq.true&select=generated_at,samples,base_hit_rate,patterns,notes&order=generated_at.desc&limit=1",
    ).catch(() => []),
    db("rpc/get_lob_online_learning_status", {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => null),
    db("rpc/get_lob_policy_status", {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => null),
    db(
      "scalp_calibration_profiles?active=eq.true&select=created_at,slope,intercept,train_samples,holdout_samples,promotion_reason&order=created_at.desc&limit=1",
    ).catch(() => []),
    db(
      "trading_asset_locks?state=eq.LOCKED&select=exchange,asset,reason,clean_checks,last_checked_at,last_check_status,locked_at&order=locked_at.asc",
    ).catch(() => []),
    db(
      "trading_residual_inventory?state=in.(AVAILABLE,RESERVED_FOR_REENTRY,SWEEP_PENDING)&select=exchange,asset,market,remaining_quantity,value_quote,state,updated_at&order=updated_at.asc",
    ).catch(() => []),
    db("trading_joint_objective_snapshots?select=*&order=captured_at.desc&limit=40").catch(
      () => [],
    ),
  ]);
  const accounts: JsonRecord = {};
  const accountStatsByExchange: JsonRecord = {};
  for (const exchange of ["upbit", "binance"] as Exchange[]) {
    const exchangeEnabled = exchange === "upbit"
      ? settings.upbit_enabled
      : settings.binance_enabled;
    const hasTrackedPosition = (positions || []).some((row: any) => row.exchange === exchange);
    if (!exchangeEnabled && !hasTrackedPosition) continue;
    try {
      accounts[exchange] = await managedPortfolio(
        settings,
        exchange,
        await gateway(exchange, { action: "portfolio" }),
      );
      accountStatsByExchange[exchange] = await accountStats(
        exchange,
        finite(accounts[exchange].managed.managedCapitalQuote),
        settings.mode !== "LIVE_LIMITED",
        accounts[exchange],
      );
    } catch (error) {
      accounts[exchange] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let health: any;
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { headers: { accept: "application/json" } });
    health = await res.json();
  } catch (error) {
    health = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let binanceHealth: any = null;
  if (BINANCE_GATEWAY_URL && BINANCE_GATEWAY_URL !== GATEWAY_URL) {
    try {
      const res = await fetch(`${BINANCE_GATEWAY_URL}/health`, {
        headers: { accept: "application/json" },
      });
      binanceHealth = await res.json();
    } catch (error) {
      binanceHealth = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const resolvedOnlineStatus = Array.isArray(lobOnlineStatus)
    ? lobOnlineStatus[0]
    : lobOnlineStatus;
  const resolvedPolicyStatus = Array.isArray(lobPolicyStatus)
    ? lobPolicyStatus[0]
    : lobPolicyStatus;
  const lobLearningStatus = {
    mode: "ONLINE_ON_EVERY_LIVE_CLOSE",
    profile_version: 0,
    samples: 0,
    profitable_trades: 0,
    profitable_rate: null,
    mean_net_bps: null,
    mean_hold_seconds: null,
    profiled_markets: 0,
    last_updated_at: null,
    ...(resolvedOnlineStatus && typeof resolvedOnlineStatus === "object"
      ? resolvedOnlineStatus
      : {}),
    governance: resolvedPolicyStatus && typeof resolvedPolicyStatus === "object"
      ? resolvedPolicyStatus
      : null,
    batch_profile: lobBatchProfiles?.[0] || null,
  };
  return {
    version: VERSION,
    settings,
    accounts,
    account_stats: accountStatsByExchange,
    positions: (positions || []).filter((row: any) =>
      row.state === "ENTRY_PENDING" || finite(row.remaining_quantity) > 0 ||
      finite(row.reserved_quote) > 0
    ),
    asset_locks: assetLocks || [],
    residual_inventory: residualInventory || [],
    joint_objective_snapshots: objectiveSnapshots || [],
    recently_closed_positions: closedPositions,
    binance_gateway_health: binanceHealth,
    recent_orders: orders,
    recent_cycles: cycles,
    latest_accounts: snapshots,
    recent_events: events,
    cash_flows: cashFlows,
    learning: {
      profiles,
      active_profile: (profiles || []).find((row: any) => row.active) || profiles?.[0] || null,
      scalp_calibration: scalpCalibration?.[0] || null,
      lob: lobLearningStatus,
    },
    gateway: health,
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
  for (
    const key of [
      "pause_new_entries",
      "emergency_liquidation",
      "upbit_enabled",
      "binance_enabled",
      "suppress_cross_exchange_same_asset",
      "scalp_kill_switch",
      "residual_sweep_enabled",
    ] as const
  ) if (body[key] != null) allowed[key] = Boolean(body[key]);
  if (body.strategy != null) {
    const strategy = String(body.strategy).toUpperCase();
    allowed.strategy = strategy === "TREND"
      ? "TREND"
      : strategy === "SCALP"
      ? "SCALP"
      : "LOB_SCALP";
  }
  if (body.upbit_allocation_mode != null) {
    allowed.upbit_allocation_mode = String(body.upbit_allocation_mode).toUpperCase() === "FIXED"
      ? "FIXED"
      : "ALL";
  }
  if (body.binance_allocation_mode != null) {
    allowed.binance_allocation_mode = String(body.binance_allocation_mode).toUpperCase() === "FIXED"
      ? "FIXED"
      : "ALL";
  }
  const ranges: Record<string, [number, number]> = {
    max_open_positions: [1, 20],
    max_open_positions_per_exchange: [1, 20],
    max_daily_entries: [1, 1000000],
    max_daily_entries_per_exchange: [1, 1000000],
    max_position_pct: [0.5, 25],
    risk_per_trade_pct: [0.05, 2],
    max_order_krw: [40000, 1_000_000_000],
    min_order_krw: [40000, 1_000_000],
    max_daily_buy_krw: [40000, 10_000_000_000],
    max_order_usdt: [5, 10_000_000],
    min_order_usdt: [BINANCE_MIN_ORDER_USDT, 1000],
    max_daily_buy_usdt: [5, 100_000_000],
    scalp_max_strategy_exposure_pct: [10, 100],
    scalp_low_evidence_daily_loss_pct: [0.05, 2],
    asset_lock_clean_checks_required: [1, 10],
    residual_sweep_buffer: [1, 2],
    scalp_latency_slo_ms: [250, 5000],
    upbit_allocation_krw: [0, 100_000_000_000],
    upbit_reserve_krw: [0, 100_000_000_000],
    binance_allocation_usdt: [0, 1_000_000_000],
    binance_reserve_usdt: [0, 1_000_000_000],
    max_daily_loss_pct: [0.2, 10],
    max_weekly_loss_pct: [0.5, 20],
    max_consecutive_losses: [1, 10],
    scalp_per_order_pct: [0.1, 100],
    scalp_daily_loss_pct: [0.1, 100],
    scalp_max_single_loss_pct: [0.1, 100],
    scalp_max_consecutive_losses: [1, 50],
    scalp_max_holding_minutes: [0.1, 5],
    entry_ttl_seconds: [5, 900],
    full_scan_interval_seconds: [10, 3600],
    monitor_interval_seconds: [5, 300],
    max_new_entries_per_scan: [1, 20],
    lob_max_holding_seconds: [1, 300],
    lob_absolute_max_holding_seconds: [1, 300],
    lob_scan_interval_seconds: [10, 60],
    lob_min_net_ev_bps: [0, 100],
    lob_max_book_age_ms: [100, 10000],
    lob_max_spread_bps: [1, 100],
    lob_min_bid_depth_ratio: [0.05, 1],
  };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (body[key] != null) allowed[key] = clamp(finite(body[key]), low, high);
  }
  if (!Object.keys(allowed).length) return settings;
  allowed.version = finite(settings.version) + 1;
  return (await patch("trading_settings", "id=eq.1", allowed))[0];
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") return response({ error: "POST only" }, 405);
  if (!authorized(request)) return response({ error: "unauthorized" }, 401);
  let cycleId = "";
  try {
    requiredConfiguration();
    const body = await request.json().catch(() => ({})) as JsonRecord;
    const action = String(body.action || "status").toLowerCase();
    let settings = await loadSettings();
    if (!settings.configured) settings = await ensureConfigured(settings);
    if (action === "status") return response({ ok: true, ...(await status(settings)) });
    const kind: CycleKind = action === "scan"
      ? "SCAN"
      : action === "monitor"
      ? "MONITOR"
      : ["control", "resume", "reconcile", "withdrawal_mode"].includes(action)
      ? "CONTROL"
      : "BOOTSTRAP";
    cycleId = await beginCycle(kind, settings.mode);
    if (action === "bootstrap") {
      settings = await ensureConfigured(settings, Boolean(body.sync_mode));
      const portfolios: JsonRecord = {};
      for (const exchange of ["upbit", "binance"] as Exchange[]) {
        if (exchange === "upbit" ? settings.upbit_enabled : settings.binance_enabled) {
          portfolios[exchange] = await gateway(exchange, { action: "portfolio" });
        }
      }
      await patch("trading_settings", "id=eq.1", {
        last_gateway_heartbeat_at: new Date().toISOString(),
        gateway_error_count: 0,
      });
      const result = {
        settings,
        portfolios,
        gateway: await status(settings).then((row) => row.gateway),
      };
      await finishCycle(cycleId, "SUCCESS", result);
      return response({ ok: true, cycle_id: cycleId, ...result });
    }
    if (action === "control") {
      const operatorPause = body.pause_new_entries === true && settings.pause_new_entries !== true;
      if (operatorPause && String(body.pause_confirmation || "") !== "PAUSE_NOW") {
        await finishCycle(cycleId, "FAILED", {}, "pause confirmation required");
        return response({
          ok: false,
          error: "PAUSE_NOW confirmation is required",
          cycle_id: cycleId,
        }, 400);
      }
      settings = await control(body, settings);
      if (operatorPause) {
        await event("OPERATOR_PAUSE", "new entries paused by explicit operator command", {
          source: String(body.control_source || "API"),
          reason: String(body.control_reason || "OPERATOR_REQUEST"),
          user_agent: request.headers.get("user-agent") || null,
        }, { cycleId, level: "WARNING" });
      }
      await finishCycle(cycleId, "SUCCESS", { settings });
      return response({ ok: true, cycle_id: cycleId, settings });
    }
    if (action === "withdrawal_mode") {
      settings = (await patch("trading_settings", "id=eq.1", {
        pause_new_entries: true,
        withdrawal_mode: true,
        manual_intervention_required: false,
        manual_event_reason: "WITHDRAWAL_MODE",
        last_manual_event_at: new Date().toISOString(),
        version: finite(settings.version) + 1,
      }))[0];
      await event("WITHDRAWAL_MODE_ENABLED", "withdrawal mode enabled; new entries paused", {}, {
        cycleId,
        level: "WARNING",
      });
      await finishCycle(cycleId, "SUCCESS", { settings });
      return response({ ok: true, cycle_id: cycleId, settings });
    }
    if (action === "reconcile") {
      const result = await withLease(
        "autotrader-monitor",
        90,
        () => monitorCycle(cycleId, { ...settings, pause_new_entries: true }),
      );
      await finishCycle(
        cycleId,
        result == null ? "SKIPPED" : "SUCCESS",
        result || { reason: "monitor lease busy" },
      );
      return response({
        ok: true,
        status: result == null ? "SKIPPED" : "SUCCESS",
        cycle_id: cycleId,
        result,
      });
    }
    if (action === "resume") {
      const reconciliation = await withLeaseRetry(
        "autotrader-monitor",
        90,
        6,
        2_000,
        () => monitorCycle(cycleId, { ...settings, pause_new_entries: true }),
      );
      if (reconciliation == null) {
        await finishCycle(cycleId, "SKIPPED", {
          reason: "account reconciliation is busy; nothing was resumed",
        });
        return response({
          ok: false,
          error: "account reconciliation is busy; try the resume button again",
          cycle_id: cycleId,
        }, 409);
      }
      const activeAfterReconcile = await db(
        "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id&limit=1",
      );
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
        pause_new_entries: false,
        withdrawal_mode: false,
        manual_intervention_required: false,
        manual_event_reason: null,
        emergency_liquidation: false,
        last_resume_at: new Date().toISOString(),
        version: finite(settings.version) + 1,
      }))[0];
      await event(
        "TRADING_RESUMED_NOW",
        "new entries resumed immediately by operator after successful reconciliation",
        { reconciliation },
        { cycleId },
      );
      await finishCycle(cycleId, "SUCCESS", { settings, reconciliation, scan_now: true });
      return response({ ok: true, cycle_id: cycleId, settings, reconciliation, scan_now: true });
    }
    if (action === "monitor") {
      const result = await withLease(
        "autotrader-monitor",
        90,
        () => monitorCycle(cycleId, settings),
      );
      if (result == null) {
        await finishCycle(cycleId, "SKIPPED", { reason: "monitor lease busy" });
        return response({ ok: true, status: "SKIPPED", reason: "monitor lease busy" });
      }
      await finishCycle(cycleId, "SUCCESS", result);
      return response({ ok: true, status: "SUCCESS", cycle_id: cycleId, result });
    }
    if (action === "scan") {
      settings = await tryAutoResume(settings, cycleId);
      const result = await withLease(
        "autotrader-scan",
        MAX_SCAN_SECONDS + 30,
        () => scanCycle(cycleId, settings),
      );
      if (result == null) {
        await finishCycle(cycleId, "SKIPPED", { reason: "scan lease busy" });
        return response({ ok: true, status: "SKIPPED", reason: "scan lease busy" });
      }
      await finishCycle(cycleId, result.skipped ? "SKIPPED" : "SUCCESS", result);
      return response({
        ok: true,
        status: result.skipped ? "SKIPPED" : "SUCCESS",
        cycle_id: cycleId,
        result,
      });
    }
    await finishCycle(cycleId, "FAILED", {}, "unsupported action");
    return response({ error: "unsupported action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cycleId) await finishCycle(cycleId, "FAILED", {}, message).catch(() => null);
    // v5.10.1: a signature that expires twice in a row is a latency/clock problem, i.e. an
    // availability fault. Classifying it as one routes it into the gateway_error_count path
    // that now auto-resumes once things recover, instead of dying silently every cycle.
    const availabilityFailure =
      /gateway\s+(?:5\d\d)|expired gateway request|fetch failed|network|timeout|timed out|abort|econn|enotfound|socket|502|503|504/i
        .test(message);
    if (availabilityFailure) {
      const current = await loadSettings().catch(() => ({ gateway_error_count: 0 }));
      const count = 1 + finite(current.gateway_error_count);
      await patch("trading_settings", "id=eq.1", {
        gateway_error_count: count,
        gateway_recovery_cycles: 0,
      }).catch(() => null);
      if (count >= 3) {
        await event(
          "GATEWAY_DEGRADED_NO_GLOBAL_PAUSE",
          "gateway availability degraded; future cycles will keep retrying",
          {
            error: message,
            count,
            source: "GATEWAY_AVAILABILITY",
            scope: "FAILED_CYCLE_ONLY",
          },
          { cycleId, level: "WARNING" },
        ).catch(() => null);
      }
    } else {
      await event(
        "ENGINE_ERROR_NO_PAUSE",
        "non-connectivity engine error recorded without pausing entries",
        { error: message },
        { cycleId, level: "WARNING" },
      ).catch(() => null);
    }
    console.error("market-autotrader failed", error);
    return response({ ok: false, error: message, version: VERSION }, 500);
  }
});
