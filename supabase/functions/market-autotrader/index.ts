// Trading-booooo v8.0.0 — existing P10/I46 LONG + S096 RSI-momentum SHORT orchestration.
// Private service-role function. No withdrawal or transfer route exists. Futures short
// orders are accepted only through explicit, direction-safe OPEN/CLOSE intent.

import {
  adjustedPlanForFill,
  allocateExitFillToPosition,
  baseAsset,
  BINANCE_MIN_ORDER_USDT,
  binanceMinOrderUsdt,
  calculateExitResidualAccounting,
  calculateManagedCapital,
  calculatePositionSize,
  ceilToStep,
  clamp,
  dangerousControlError,
  decideExit,
  entryQuantityForNotional,
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
import { dustQuoteFor } from "../_shared/position-value.ts";
import { resolveDisplayPositions } from "./position-display.ts";
import { resolveManualPositions } from "./manual-position-import.ts";
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
import { type LobPreOrderRecheck } from "../_shared/lob/preorder.ts";
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
import type { LobCostEstimate, LobFeatureVector, LobPatternName } from "../_shared/lob/types.ts";
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
import {
  type ExecutableNetExitQuote,
  orderTimeExitPolicyQuote,
  quoteExecutableNetExit,
} from "./executable-exit.ts";
import { spotSplitExitDecision } from "./spot-exit-policy.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  FUTURES_SPLIT_EXIT_THRESHOLDS,
  futuresAffordableEntry,
  futuresEntryMinimums,
  futuresRecoveryState,
  futuresSplitExitDecision,
  normalizeFuturesLeverage,
} from "./futures-exit-policy.ts";
import {
  LATE_RECOVERY_THRESHOLDS,
  lateRecoveryDecision,
  updatePost180RunningTrough,
} from "./late-recovery-policy.ts";
import { buildTradingHeartbeatPatch, type TradingHeartbeatPatch } from "./heartbeat.ts";
import { type LeaseGateway, runWithContendedLease } from "./lease.ts";
import {
  mapConcurrentOrdered,
  P10_MONITOR_POSITION_CONCURRENCY,
  P10_SCAN_PORTFOLIO_CONCURRENCY,
} from "./monitor-concurrency.ts";
import { shouldLoadCompletedPolicyBar } from "./p10-monitor-cadence.ts";
import {
  p10EntryFailureDisposition,
  p10EntryOrderDisposition,
  p10PendingReservationExpired,
  p10PreOrderEntryDisposition,
  summarizeP10LinkedEntryFills,
  untrackedFuturesExposures,
} from "./p10-entry-reconciliation.ts";
import { assessCandidateIntegrity } from "./entry-integrity.ts";
import { buildLobGateConfig } from "../_shared/lob/gate-config.ts";
import { loadMinuteEntryGate } from "../_shared/lob/minute-entry-market.ts";
import { liveBlockedLobPatterns, preT1ProfitProtectionHit } from "./live-guards.ts";
import { resolveFinalLobAdmission } from "./final-entry-gate.ts";
import {
  evaluateP10Exit,
  P10_CONFIG,
  P10_HOUR_MS,
  P10_REVISION,
  P10_STRATEGY_KEY,
  type P10Bar,
  p10ExactFuturesTicketCapital,
  p10ExecutableTicketCapital,
  p10RoundTripCostBps,
  type P10Side,
  type P10Venue,
  planP10Entry,
  prepareP10Bars,
} from "../_shared/p10-policy.ts";
import {
  applyP10MarketRiskOverlay,
  evaluateP10MarketRisk,
  P10_MARKET_RISK_CONFIG,
  type P10MarketRiskObservation,
  p10RequestedExitQuantity,
} from "../_shared/p10-market-risk.ts";
import {
  FUTURES_SHORT_LIVE_ENV,
  futuresShortEntryBlockReason,
  futuresShortLiveEnabled,
} from "../_shared/futures-short-safety.ts";
import {
  authenticatedFuturesSnapshot,
  FUTURES_POSITION_SNAPSHOT_REVISION,
} from "./futures-snapshot.ts";
import {
  evaluateS37ShortExit,
  S37_SHORT_REVISION,
  S37_SHORT_STRATEGY_KEY,
} from "../_shared/s37-short-policy.ts";
import {
  evaluateS096ShortExit,
  isS096SignalEvidence,
  planS096ShortEntry,
  resolveFixedShortCurrentStop,
  S096_SHORT_CONFIG,
  S096_SHORT_REVISION,
  S096_SHORT_STRATEGY_KEY,
} from "../_shared/s096-short-policy.ts";

// Order-gateway/scanner protocol version. Strategy identity is stored separately in metadata.
const VERSION = "8.0.2-P10-ORPHAN-ENTRY-SELF-HEAL";
// Keep create-order commands compatible with the still-running v8.0.0 gateway during the
// rolling deploy. The new gateway accepts both protocol revisions; a later release can
// advance this only after every gateway reports v8.0.1.
const ORDER_GATEWAY_PROTOCOL_VERSION = "8.0.0-P10-DONCHIAN-SLOW4R";
const P10_FAST_GATEWAY_TIMEOUT_MS = 1_900;
// Must match BOT_IDENTIFIER_PREFIX in gateway/server.mjs and the prefix used by uniqueId().
const BOT_ORDER_PREFIX = "tb-";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const GATEWAY_URL = env("ORDER_GATEWAY_URL").replace(/\/$/, "");
const GATEWAY_SECRET = env("GATEWAY_SHARED_SECRET");
// Deliberately independent of signal generation and trading_settings.  Until an
// operator explicitly provisions this exact env flag, research/shadow SHORT signals
// cannot cross the executor into a live futures SELL.
const FUTURES_SHORT_LIVE_FLAG = env(FUTURES_SHORT_LIVE_ENV);
// Optional exchange-split: route Binance orders to a dedicated gateway (e.g. Paris/cdg).
// When BINANCE_ORDER_GATEWAY_URL is unset, Binance falls back to the primary gateway,
// so existing single-gateway deployments behave exactly as before. Upbit always uses the primary.
const BINANCE_GATEWAY_URL = env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/, "") || GATEWAY_URL;
const BINANCE_GATEWAY_SECRET = env("BINANCE_GATEWAY_SHARED_SECRET") || GATEWAY_SECRET;
// The futures lane may sit behind its own static-egress gateway; when unset it shares the
// Binance gateway, which in turn falls back to the primary one.
const BINANCE_FUTURES_GATEWAY_URL = env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/, "") ||
  BINANCE_GATEWAY_URL;
const BINANCE_FUTURES_GATEWAY_SECRET = env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET") ||
  BINANCE_GATEWAY_SECRET;
function gatewayTarget(exchange: Exchange): { url: string; secret: string } {
  if (exchange === "binance_futures") {
    return { url: BINANCE_FUTURES_GATEWAY_URL, secret: BINANCE_FUTURES_GATEWAY_SECRET };
  }
  return exchange === "binance"
    ? { url: BINANCE_GATEWAY_URL, secret: BINANCE_GATEWAY_SECRET }
    : { url: GATEWAY_URL, secret: GATEWAY_SECRET };
}
const BINANCE_FUTURES_PUBLIC_URL = "https://fapi.binance.com";
let activeFuturesSymbolCache: { expires: number; symbols: Set<string> } | null = null;

/**
 * Active USDⓈ-M perpetual membership is not the same thing as spot symbol grammar.
 *
 * Exchange-info alone is not sufficient: production observed symbols present in the
 * mirrored spot universe that still returned Binance -1121 from the live futures
 * ticker/order path. Require membership in BOTH the active perpetual rules and the
 * live USDⓈ-M ticker surface before a spot signal can enter the futures lane.
 */
async function activeBinanceFuturesSymbols(): Promise<Set<string>> {
  const now = Date.now();
  if (activeFuturesSymbolCache && activeFuturesSymbolCache.expires > now) {
    return activeFuturesSymbolCache.symbols;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const [exchangeInfoResponse, tickerResponse] = await Promise.all([
      fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v1/exchangeInfo`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
      fetch(`${BINANCE_FUTURES_PUBLIC_URL}/fapi/v2/ticker/price`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
    ]);
    const [exchangeInfoText, tickerText] = await Promise.all([
      exchangeInfoResponse.text(),
      tickerResponse.text(),
    ]);
    if (!exchangeInfoResponse.ok) {
      throw new Error(
        `Binance futures exchangeInfo ${exchangeInfoResponse.status}: ${
          exchangeInfoText.slice(0, 160)
        }`,
      );
    }
    if (!tickerResponse.ok) {
      throw new Error(
        `Binance futures ticker ${tickerResponse.status}: ${tickerText.slice(0, 160)}`,
      );
    }

    const exchangeInfoPayload = exchangeInfoText ? JSON.parse(exchangeInfoText) : {};
    const tickerPayload = tickerText ? JSON.parse(tickerText) : [];
    const liveTickerSymbols = new Set<string>(
      (Array.isArray(tickerPayload) ? tickerPayload : [])
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    const rows = Array.isArray(exchangeInfoPayload?.symbols) ? exchangeInfoPayload.symbols : [];
    const symbols = new Set<string>(
      rows
        .filter((row: any) => {
          const symbol = String(row?.symbol || "").toUpperCase();
          return String(row?.status || "") === "TRADING" &&
            String(row?.contractType || "") === "PERPETUAL" &&
            String(row?.quoteAsset || "") === "USDT" &&
            liveTickerSymbols.has(symbol);
        })
        .map((row: any) => String(row?.symbol || "").toUpperCase())
        .filter(Boolean),
    );
    if (!symbols.size) {
      throw new Error("Binance futures universe intersection returned no tradable USDT perpetuals");
    }
    activeFuturesSymbolCache = { expires: now + 5 * 60_000, symbols };
    return symbols;
  } finally {
    clearTimeout(timer);
  }
}

const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";
const DEFAULT_MODE = parseMode(env("TRADING_MODE_DEFAULT") || "PAPER");
const MAX_SCAN_SECONDS = 280;
// Scan lease shape. The TTL is a renewed heartbeat, not the scan's worst-case runtime, so a
// scan that dies mid-flight frees the shared engine lease in SCAN_LEASE_TTL_SECONDS instead
// of holding monitor off for the whole scan budget. SCAN_LEASE_WAIT_MS spans one full monitor
// cycle (13-15s live) so a scan can claim the gap monitor leaves instead of skipping.
const SCAN_LEASE_TTL_SECONDS = 45;
const SCAN_LEASE_RENEW_MS = 10_000;
const SCAN_LEASE_WAIT_MS = 18_000;
const SCAN_LEASE_POLL_MS = 2_000;
const LIVE_MAX_SPREAD_BPS = clamp(finite(env("LIVE_MAX_SPREAD_BPS"), 25), 5, 50);
const LIVE_MIN_DEPTH_BUFFER = clamp(finite(env("LIVE_MIN_DEPTH_BUFFER"), 1.2), 1, 3);
const FEE_PCT: Record<Exchange, number> = {
  upbit: clamp(finite(env("UPBIT_FEE_PER_SIDE_PCT"), 0.05), 0, 0.5),
  binance: clamp(finite(env("BINANCE_FEE_PER_SIDE_PCT"), 0.1), 0, 0.5),
  // USDⓈ-M list taker is 0.05% per side, half the spot rate. The live rate still comes
  // from the account at runtime; this is only the pre-first-read default.
  binance_futures: clamp(finite(env("BINANCE_FUTURES_FEE_PER_SIDE_PCT"), 0.05), 0, 0.5),
};

/** All venues the engine can trade, in the order every per-exchange loop walks them. */
const ALL_EXCHANGES: readonly Exchange[] = ["upbit", "binance", "binance_futures"];

function exchangeEnabled(settings: TradingSettings & JsonRecord, exchange: Exchange): boolean {
  if (exchange === "upbit") return Boolean(settings.upbit_enabled);
  if (exchange === "binance") return Boolean(settings.binance_enabled);
  return Boolean((settings as any).binance_futures_enabled);
}

function enabledExchanges(settings: TradingSettings & JsonRecord): Exchange[] {
  return ALL_EXCHANGES.filter((exchange) => exchangeEnabled(settings, exchange));
}

/**
 * Leverage the futures lane opens at. Spot venues are always 1x, so callers can multiply
 * or divide by this unconditionally.
 */
function exchangeLeverage(settings: TradingSettings & JsonRecord, exchange: Exchange): number {
  if (exchange !== "binance_futures") return 1;
  return normalizeFuturesLeverage((settings as any).binance_futures_leverage);
}

/** Leverage a position was actually opened with, which outlives a later settings change. */
function positionLeverage(position: JsonRecord): number {
  if (position?.exchange !== "binance_futures") return 1;
  return normalizeFuturesLeverage(
    position?.leverage ?? position?.metadata?.futures?.leverage,
  );
}

// v6.4: balance differences worth less than this are accounting noise, not a human
// trading behind the bot's back. Expressed in the quote currency of each exchange so no
// FX lookup sits on the safety path — a failed rate fetch must not decide whether the
// engine halts. Defaults are ~10 USD on both sides.
const DUST_TOLERANCE_QUOTE_DEFAULT: Record<Exchange, number> = {
  upbit: 14000,
  binance: 10,
  binance_futures: 10,
};

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
  failed_gate_count: number;
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
function isP10Strategy(value: unknown): boolean {
  return String(value || "").toUpperCase() === "P10_DONCHIAN_SLOW4R";
}
function isP10Position(value: unknown): boolean {
  const row = value as JsonRecord;
  return String(row?.strategy_key || row?.metadata?.strategy_key || "") === P10_STRATEGY_KEY;
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
async function patchTradingHeartbeat(values: TradingHeartbeatPatch): Promise<any[]> {
  return patch("trading_settings", "id=eq.1", buildTradingHeartbeatPatch(values));
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
  const versionedCommand = String(command?.action || "") === "create_order"
    ? { ...command, engine_version: ORDER_GATEWAY_PROTOCOL_VERSION }
    : command;
  try {
    return await gatewayOnce(exchange, versionedCommand, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!RETRYABLE_GATEWAY_ERROR.test(message)) throw error;
    // Fresh timestamp and nonce. The exchange was never reached on the first attempt.
    return await gatewayOnce(exchange, versionedCommand, timeoutMs);
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
    // The futures lane ships off. Leverage makes a misconfigured deploy expensive, so it
    // has to be switched on deliberately rather than inherited from a default.
    binance_futures_enabled: false,
    binance_futures_leverage: DEFAULT_FUTURES_LEVERAGE,
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
    // The futures wallet is a separate balance from the spot wallet, so it gets its own
    // allocation rather than sharing the Binance spot numbers.
    binance_futures_allocation_mode: "ALL",
    binance_futures_allocation_usdt: 0,
    binance_futures_reserve_usdt: 0,
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
    strategy: env("TRADING_STRATEGY") === "P10_DONCHIAN_SLOW4R"
      ? "P10_DONCHIAN_SLOW4R"
      : env("TRADING_STRATEGY") === "TREND"
      ? "TREND"
      : env("TRADING_STRATEGY") === "SCALP"
      ? "SCALP"
      : "LOB_SCALP",
    scalp_per_order_pct: 100, // deprecated: allocation UI is the sole exposure ceiling
    scalp_daily_loss_pct: clamp(finite(env("SCALP_DAILY_LOSS_PCT"), 20), 0.1, 100),
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
/**
 * Lease gateway backed by the trading_leases RPCs. Acquiring with an owner that already holds
 * the lease refreshes its expiry, which is what the renewal heartbeat relies on.
 */
const LEASE_GATEWAY: LeaseGateway = {
  acquire: (name, owner, ttlSeconds) =>
    rpc("acquire_trading_lease", { p_name: name, p_owner: owner, p_seconds: ttlSeconds })
      .then((granted) => granted === true),
  release: (name, owner) => rpc("release_trading_lease", { p_name: name, p_owner: owner }),
};

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
      `trading_positions?is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,exchange,market,base_asset,state,strategy_key,position_side,initial_quantity,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,realized_pnl_quote,paid_fees_quote,residual_value_quote`,
    ),
    db(
      `trading_positions?exchange=eq.${exchange}&is_paper=eq.${isPaper}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,market,base_asset,state,strategy_key,position_side,initial_quantity,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,realized_pnl_quote,paid_fees_quote,residual_value_quote`,
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
    if (isP10Position(row) && String(row.position_side) === "SHORT") {
      const gross = (entry - current) * Math.max(0, finite(row.remaining_quantity));
      const estimatedExitFee = current * Math.max(0, finite(row.remaining_quantity)) *
        FEE_PCT[exchange] / 100;
      return sum + gross + finite(row.realized_pnl_quote) - estimatedExitFee;
    }
    return sum + calculateExposureLedger({
      state: row.state,
      initialQuantity: row.initial_quantity,
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
      estimatedExitCostPct: FEE_PCT[exchange] / 100,
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
        min_net_rr: isLobStrategy((settings as any).strategy)
          ? clamp(
            Math.max(1.5, finite((settings as any).lob_min_net_reward_risk_ratio, 1.5)),
            1.5,
            5,
          )
          : undefined,
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
/**
 * Mirror this scan's Binance spot BUY candidates onto the USDⓈ-M perpetual venue.
 *
 * The operator's requirement is that the futures lane's entry logic is identical to spot,
 * so it consumes the identical signal rather than a second, subtly different scan. The
 * mirrored row is a real `scanner_candidates` row so a futures position keeps a candidate
 * of its own to attribute outcomes to, and so per-venue learning stays separated.
 *
 * Only the SIGNAL is mirrored. Everything priced at execution time — the book, the
 * depth, the symbol filters, the fill — is read from the perpetual venue itself, because
 * the gateway routes by exchange.
 */
async function mirrorBinanceFuturesCandidates(
  scanId: string,
  cycleId?: string,
): Promise<number> {
  const [spot, existing] = await Promise.all([
    db(
      `scanner_candidates?scan_id=eq.${scanId}&exchange=eq.binance&decision=eq.BUY&select=*`,
    ) as Promise<JsonRecord[]>,
    db(
      `scanner_candidates?scan_id=eq.${scanId}&exchange=eq.binance_futures&select=market`,
    ).catch(() => []) as Promise<JsonRecord[]>,
  ]);
  const already = new Set((existing || []).map((row) => String(row.market)));
  const unmirroredSpot = (spot || []).filter((row) => !already.has(String(row.market)));
  let activeFuturesSymbols: Set<string>;
  try {
    activeFuturesSymbols = await activeBinanceFuturesSymbols();
  } catch (error) {
    await event(
      "FUTURES_UNIVERSE_REFRESH_FAILED",
      "Binance futures universe unavailable; skipping futures mirror for this scan",
      { scan_id: scanId, error: error instanceof Error ? error.message : String(error) },
      { cycleId, level: "WARNING" },
    );
    return 0;
  }
  const skippedMarkets = unmirroredSpot
    .map((row) => String(row.market || "").toUpperCase())
    .filter((market) => market && !activeFuturesSymbols.has(market));
  if (skippedMarkets.length) {
    await event(
      "FUTURES_SPOT_ONLY_SYMBOL_SKIPPED",
      "Spot BUY candidates without an active USDⓈ-M perpetual were not mirrored",
      { scan_id: scanId, markets: skippedMarkets, count: skippedMarkets.length },
      { cycleId, level: "INFO" },
    );
  }
  const clones = unmirroredSpot
    .filter((row) => activeFuturesSymbols.has(String(row.market || "").toUpperCase()))
    .map((row) => {
      // Copy every column the scanner wrote so schema additions travel automatically;
      // only identity and provenance are rewritten.
      const { id: _id, created_at: _createdAt, ...rest } = row;
      return {
        ...rest,
        exchange: "binance_futures",
        snapshot: {
          ...(row.snapshot && typeof row.snapshot === "object" ? row.snapshot : {}),
          mirrored_from: { exchange: "binance", candidate_id: row.id, scan_id: scanId },
        },
      };
    });
  if (!clones.length) return 0;
  try {
    await insert("scanner_candidates", clones);
    return clones.length;
  } catch (error) {
    // A failed mirror costs the futures lane one scan; it must never fail the spot scan
    // that produced the signal.
    await event(
      "FUTURES_CANDIDATE_MIRROR_FAILED",
      `binance_futures candidate mirror failed for scan ${scanId}`,
      { error: error instanceof Error ? error.message : String(error), attempted: clones.length },
      { cycleId, level: "WARNING" },
    );
    return 0;
  }
}

async function loadBuyCandidates(
  scanId: string,
  settings?: TradingSettings,
  cycleId?: string,
): Promise<Candidate[]> {
  if (exchangeEnabled(settings as TradingSettings & JsonRecord, "binance_futures")) {
    await mirrorBinanceFuturesCandidates(scanId, cycleId);
  }
  const rows = await db(
    `scanner_candidates?scan_id=eq.${scanId}&decision=eq.BUY&exchange=in.(upbit,binance,binance_futures)&select=*&order=score.desc,period_score.desc`,
  ) as Candidate[];
  if (!isScalpStrategy((settings as any)?.strategy)) return rows;
  const makerByExchange = isLobStrategy((settings as any)?.strategy)
    ? {
      upbit: await loadMakerFillStats("upbit"),
      binance: await loadMakerFillStats("binance"),
      binance_futures: await loadMakerFillStats("binance_futures"),
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
    change24hPct: finite(base.change24hPct, 0),
    dayRangePct: finite(base.dayRangePct, 0),
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
    m1GateVersion: base.m1GateVersion,
    m1DataAvailable: base.m1DataAvailable === true,
    m1PreviousBullish: base.m1PreviousBullish ?? null,
    m1StochK: base.m1StochK ?? null,
    m1StochD: base.m1StochD ?? null,
    m1CompletedBars: Math.max(0, Math.floor(finite(base.m1CompletedBars, 0))),
    m1CompletedCandleOpenTime: base.m1CompletedCandleOpenTime ?? null,
    m1CompletedCandleCloseTime: base.m1CompletedCandleCloseTime ?? null,
    m1BandPosition: base.m1BandPosition ?? null,
    m1BandWidth: base.m1BandWidth ?? null,
    m1BandWidthExpansionRatio: base.m1BandWidthExpansionRatio ?? null,
    m1UpperBandSlopePct: base.m1UpperBandSlopePct ?? null,
    m1BodyAtrRatio: base.m1BodyAtrRatio ?? null,
    m1RangeAtrRatio: base.m1RangeAtrRatio ?? null,
    m1RecentAdvanceAtr: base.m1RecentAdvanceAtr ?? null,
    m1VolumeRatio: base.m1VolumeRatio ?? null,
    m1SqueezeRelease: base.m1SqueezeRelease === true,
    m1PreBreakout: base.m1PreBreakout === true,
    m1CorePassed: base.m1CorePassed === true,
    m1UpperBandTouched: base.m1UpperBandTouched === true,
    m1AuxiliaryScore: base.m1AuxiliaryScore ?? null,
    m1AuxiliaryPassed: base.m1AuxiliaryPassed === true,
    m1BearishUpperBandReentry: base.m1BearishUpperBandReentry === true,
    m1UpperBandReclaimed: base.m1UpperBandReclaimed === true,
    m1PreviousAtUpperBand: base.m1PreviousAtUpperBand === true,
    m1LatestClose: base.m1LatestClose ?? null,
    m1UpperBand: base.m1UpperBand ?? null,
  };
}

/** Re-run the LOB gate on a fresh quote; the immutable scan-time 1m gate is carried here,
 * and a second fresh 1m fetch is enforced immediately before the order. */
export function evaluateLobPreOrderRecheck(
  lobSnapshot: any,
  market: any,
  options: {
    maxEntry: number;
    maxBookAgeMs: number;
    maxSpreadBps: number;
    requiredNotionalQuote: number;
    costs: LobCostEstimate;
    fixedTargetBps: number;
    fixedStopBps: number;
    maxStopToTargetRatio: number;
    minNetRewardRiskRatio: number;
    requireMinuteEntryGate: boolean;
    blockedPatterns?: LobPatternName[];
    trap?: Partial<LobTrapConfig>;
  },
): LobPreOrderRecheck {
  const features = liveLobFeatures(lobSnapshot, market);
  const decision = evaluateLobEntry(features, {
    ...options.costs,
    spreadBps: Math.max(0, finite(features.spreadBps)),
  }, {
    maxBookAgeMs: options.maxBookAgeMs,
    maxSpreadBps: options.maxSpreadBps,
    fixedTargetBps: options.fixedTargetBps,
    fixedStopBps: options.fixedStopBps,
    maxStopToTargetRatio: options.maxStopToTargetRatio,
    minNetRewardRiskRatio: options.minNetRewardRiskRatio,
    requireMinuteEntryGate: options.requireMinuteEntryGate,
    blockedPatterns: options.blockedPatterns,
    trap: options.trap || {},
  });
  const bestBid = finite(market?.best_bid);
  const bestAsk = finite(market?.best_ask);
  const reasons = [...decision.reasons];
  if (!(bestBid > 0 && bestAsk > 0)) reasons.push("PREORDER_EMPTY_ORDERBOOK");
  if (!(options.maxEntry > 0) || bestAsk > options.maxEntry) {
    reasons.push("PREORDER_ENTRY_CEILING_BREACHED");
  }
  const depth = executableDepth(
    Array.isArray(market?.asks) ? market.asks : [],
    options.maxEntry,
    options.requiredNotionalQuote,
  );
  if (
    !depth.executable ||
    depth.availableFunds < options.requiredNotionalQuote * LIVE_MIN_DEPTH_BUFFER
  ) reasons.push("PREORDER_ASK_DEPTH_DROPPED");
  const uniqueReasons = [...new Set(reasons)];
  return {
    passed: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    decision: decision.decision,
    checkedAt: new Date().toISOString(),
    bestBid,
    bestAsk,
    spreadBps: features.spreadBps,
    bidDepthQuote: features.bidDepthQuote,
    askDepthQuote: features.askDepthQuote,
    tradePressureFast: features.tradePressureFast,
    micropriceDeviationBps: features.micropriceDeviationBps,
    features,
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

/** Quantity-aware executable sell price. If visible depth is incomplete, value the
 * entire quantity at the lowest visible bid instead of falling back to ticker/mid. */
function executableBidVwap(book: any, requestedQuantity: number): number {
  const requested = Math.max(0, finite(requestedQuantity));
  if (!(requested > 0)) return 0;
  let remaining = requested;
  let filled = 0;
  let funds = 0;
  let lowestVisibleBid = 0;
  for (const level of Array.isArray(book?.bids) ? book.bids : []) {
    const price = Math.max(0, finite(level?.price ?? level?.[0]));
    const size = Math.max(0, finite(level?.size ?? level?.[1]));
    if (!(price > 0 && size > 0)) continue;
    lowestVisibleBid = price;
    const take = Math.min(remaining, size);
    funds += take * price;
    filled += take;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  if (filled + 1e-12 >= requested) return funds / requested;
  return lowestVisibleBid > 0 ? lowestVisibleBid : Math.max(0, finite(book?.best_bid));
}

function candidatePlan(candidate: Candidate, settings?: TradingSettings) {
  const trade = candidate.snapshot?.trade_plan || {};
  const tick = finite(trade.tick_size, finite(candidate.feature_vector?.tick_size));
  const allocation = clamp(finite(trade.first_target_allocation_pct, 60), 50, 80);
  const strategy = String(trade.target_strategy || "SCALE_OUT");
  const isScalp = isScalpStrategy((settings as any)?.strategy);
  const isLob = isLobStrategy((settings as any)?.strategy);
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
    exitPolicy: isLob
      ? "FIXED_T1"
      : isScalp
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

type P10QuoteLoad = { ok: true; value: any } | { ok: false; error: string };

async function p10PositionPortfolio(exchange: Exchange): Promise<any> {
  try {
    return await gateway(
      exchange,
      { action: "p10_portfolio" },
      P10_FAST_GATEWAY_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((error as any)?.status || 0);
    if (!(status === 400 && /unsupported.+action/i.test(message))) throw error;
    return await gateway(
      exchange,
      { action: "portfolio" },
      P10_FAST_GATEWAY_TIMEOUT_MS,
    );
  }
}

async function p10MarketQuoteBatch(
  exchange: Exchange,
  markets: readonly string[],
): Promise<Map<string, P10QuoteLoad>> {
  const requested = [...new Set(markets.map((market) => String(market).toUpperCase()))];
  const result = new Map<string, P10QuoteLoad>();
  if (!requested.length) return result;
  try {
    const rows = await gateway(
      exchange,
      { action: "p10_quotes", markets: requested },
      P10_FAST_GATEWAY_TIMEOUT_MS,
    );
    if (!Array.isArray(rows)) throw new Error("P10 quote batch response is not an array");
    for (const row of rows) {
      const market = String(row?.market || "").toUpperCase();
      if (!requested.includes(market)) continue;
      if (!(finite(row?.best_bid) > 0 && finite(row?.best_ask) > 0)) {
        result.set(market, {
          ok: false,
          error: String(
            row?.error || `P10 executable quote unavailable for ${exchange}:${market}`,
          ),
        });
        continue;
      }
      result.set(market, { ok: true, value: row });
    }
    for (const market of requested) {
      if (!result.has(market)) {
        result.set(market, {
          ok: false,
          error: `P10 quote batch omitted ${exchange}:${market}`,
        });
      }
    }
    return result;
  } catch (error) {
    // A rolling gateway rollback must not blind exits. Fall back to the legacy full quote
    // contract only when the additive action is genuinely unsupported. A timeout, 429 or
    // venue failure must end this attempt quickly so the next two-second tick can retry;
    // fanning out after such a failure would amplify the exact outage we are containing.
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((error as any)?.status || 0);
    if (!(status === 400 && /unsupported.+action/i.test(message))) {
      for (const market of requested) result.set(market, { ok: false, error: message });
      return result;
    }
    const rows = await mapConcurrentOrdered(requested, async (market) => {
      try {
        return {
          market,
          load: {
            ok: true as const,
            value: await gateway(
              exchange,
              { action: "quote", market },
              P10_FAST_GATEWAY_TIMEOUT_MS,
            ),
          },
        };
      } catch (error) {
        return {
          market,
          load: {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }, 2);
    for (const row of rows) result.set(row.market, row.load);
    return result;
  }
}
function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
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
  // A second monitor can hold a pre-APPLIED snapshot while the scan commits the same
  // fill.  Make the PostgREST predicate observe the current database state so that stale
  // EXCHANGE_DONE evidence cannot demote the already committed APPLIED row.  Fee refreshes
  // that intentionally start from APPLIED remain writable.
  const orderFilter = String(orderRow.state || "").toUpperCase() === "APPLIED"
    ? `id=eq.${orderRow.id}&state=eq.APPLIED`
    : `id=eq.${orderRow.id}&state=neq.APPLIED`;
  const rows = await patch("trading_orders", orderFilter, {
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
  const currentRow = rows[0] || (await db(
    `trading_orders?id=eq.${orderRow.id}&select=*&limit=1`,
  ).catch(() => []))?.[0] || orderRow;
  return {
    row: currentRow,
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
  if (exchange === "binance_futures") {
    return {
      mode: (settings as any).binance_futures_allocation_mode || "ALL",
      fixed: finite((settings as any).binance_futures_allocation_usdt),
      reserve: finite((settings as any).binance_futures_reserve_usdt),
    };
  }
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
      `trading_positions?exchange=eq.${exchange}&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&is_paper=eq.${paper}&select=exchange,market,state,strategy_key,position_side,leverage,initial_quantity,remaining_quantity,reserved_quote,reserved_quantity,average_entry_price,planned_entry_price,realized_cost_quote,realized_proceeds_quote,paid_fees_quote,residual_value_quote`,
    ) as Promise<any[]>,
    exchange === "binance_futures" ? Promise.resolve([]) : db(
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
    if (isP10Position(row) && String(row.position_side) === "SHORT") {
      const leverageDivisor = exchange === "binance_futures" ? positionLeverage(row) : 1;
      const openNotional = Math.max(0, finite(row.remaining_quantity)) * entry;
      const reservedNotional = Math.max(0, finite(row.reserved_quantity)) * entry;
      bookedExposure += openNotional / leverageDivisor;
      reservedExposure += reservedNotional / leverageDivisor;
      // Futures capital is authoritative below; this compatibility mark is not added to it.
      botPositionValue += openNotional / leverageDivisor;
      continue;
    }
    const ledger = calculateExposureLedger({
      state: row.state,
      initialQuantity: row.initial_quantity,
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
      estimatedExitCostPct: FEE_PCT[exchange] / 100,
    });
    // A leveraged position ties up margin, not notional. Use the leverage stamped on each
    // position: changing the dashboard setting must not retroactively revalue open margin.
    const leverageDivisor = exchange === "binance_futures" ? positionLeverage(row) : 1;
    bookedExposure += ledger.totalExposureQuote / leverageDivisor;
    reservedExposure += ledger.reservedExposureQuote / leverageDivisor;
    botPositionValue += ledger.liquidationValueQuote / leverageDivisor;
  }
  // On futures the exchange already reports margin balance including unrealised PnL, and
  // it is authoritative; reconstructing it from position marks would double-count.
  const capitalBaseQuote = exchange === "binance_futures"
    ? Math.max(0, finite(portfolio.total_equity_quote))
    : Math.max(0, finite(portfolio.available_quote)) +
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
  if (exchange === "binance_futures") {
    return {
      maxOrder: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_order_usdt,
      // This is CAPITAL (posted margin), not contract notional and not the configurable
      // Binance spot floor. At the default 3x the corresponding position is 120 USDT.
      minOrder: FUTURES_MIN_ENTRY_MARGIN_USDT,
      quoteStep: 0.01,
      dailyBuy: allocationControlled ? Number.MAX_SAFE_INTEGER : settings.max_daily_buy_usdt,
    };
  }
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
  if (position.exchange === "binance_futures") {
    // The exit sells the contract quantity, so the binding floor is the symbol's own
    // MIN_NOTIONAL captured at entry, not the spot order minimum.
    return Math.max(0, stored);
  }
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
  const candidateIntegrity = assessCandidateIntegrity(candidate, VERSION);
  (candidate as any).__decision_audit = {
    recommendation,
    failed_gate_count: candidateIntegrity.failedGateCount,
    failed_gates: candidateIntegrity.failedGates,
    candidate_engine_version: candidateIntegrity.candidateEngineVersion || null,
    execution_engine_version: VERSION,
  };
  if (!candidateIntegrity.allowed) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: candidateIntegrity.reason,
    };
  }
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
    const fixedPlanTargetBps = finite(lobSnapshot.target_bps, 0);
    const fixedPlanStopBps = finite(lobSnapshot.stop_bps, 0);
    const fixedPlanMaxHoldingSeconds = Math.round(
      finite(lobSnapshot.max_holding_seconds, 0),
    );
    if (
      !(fixedPlanTargetBps > 0) ||
      !(fixedPlanStopBps > 0) ||
      !(fixedPlanMaxHoldingSeconds > 0)
    ) {
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: "scanner LOB plan geometry is missing or invalid",
      };
    }
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
      fixedPlanTargetBps,
      fixedPlanStopBps,
      fixedPlanMaxHoldingSeconds,
    };
  }

  const plan = candidatePlan(candidate, settings);
  const rules = await symbolRules(exchange, candidate, plan);
  const limits = exchangeLimits(settings, exchange);
  const leverage = exchangeLeverage(settings, exchange);
  const futuresMinimums = exchange === "binance_futures"
    ? futuresEntryMinimums(leverage, rules.min_notional)
    : null;
  // Spot compares one notional floor. Futures keeps the operator's 40 USDT MARGIN floor
  // separate from Binance's symbol NOTIONAL filter.
  const minimumEntryMarginQuote = futuresMinimums?.marginQuote ??
    Math.max(limits.minOrder, rules.min_notional);
  const minimumEntryNotionalQuote = futuresMinimums?.notionalQuote ??
    Math.max(limits.minOrder, rules.min_notional);
  const managedPortfolioState = await managedPortfolio(settings, exchange, portfolio);
  const managed = managedPortfolioState.managed;
  if (finite(managed.managedAvailableQuote) < minimumEntryMarginQuote) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: "managed allocation has no available buying power",
    };
  }
  const allocationOnly = isScalpStrategy((settings as any).strategy);
  const managedAvailable = finite(managed.managedAvailableQuote);
  const futuresEntryFeePct = exchange === "binance_futures"
    ? await liveFeePct(exchange, settings)
    : 0;
  const futuresMarginCapacity = exchange === "binance_futures"
    ? managedAvailable / (1 + leverage * Math.max(0, futuresEntryFeePct) / 100)
    : managedAvailable;
  const strategyExposureFraction = allocationOnly
    ? clamp(finite((settings as any).scalp_max_strategy_exposure_pct, 100), 10, 100) / 100
    : 1;
  // Spot quantities are floored, so fund one quantity/quote step above the operator floor.
  // Futures quantities are instead rounded up by entryQuantityForNotional: its 40 USDT
  // minimum is a margin contract and must remain executable with an exact 40 allocation.
  const quantityStepCapitalQuote = Math.max(0, finite(rules.quantity_step)) * bestAsk / leverage;
  const executableMinimumCapitalQuote = exchange === "binance_futures"
    ? minimumEntryMarginQuote
    : minimumEntryMarginQuote + Math.max(limits.quoteStep, quantityStepCapitalQuote);
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
      executableMinimumCapitalQuote,
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
  // The allocator operates on the capital at risk. A futures price loss and both-side
  // execution costs consume leverage times as much of posted margin, so scale those two
  // inputs into margin-return space before it chooses a margin amount.
  const marginReturnMultiplier = exchange === "binance_futures" ? leverage : 1;
  const riskSizing = allocationOnly
    ? calculateOrderNotional({
      managedCapitalQuote: finite(managed.managedCapitalQuote),
      maxStrategyExposureFraction: strategyExposureFraction,
      desiredSlots: slots,
      perTradeLossBudgetQuote: finite(managed.managedCapitalQuote) *
        clamp(finite((settings as any).scalp_max_single_loss_pct, 5), 0.1, 100) / 100,
      stopPct: Math.max(0.000001, scalpStopPctForSizing * marginReturnMultiplier),
      estimatedExitCostPct: (FEE_PCT[exchange] * 2 / 100 + 0.001) * marginReturnMultiplier,
      // The allocator returns capital. Visible book depth is contract notional, so the
      // futures lane converts it back to margin before applying the common allocator.
      depthLimitedNotional: visibleAskDepth / leverage / LIVE_MIN_DEPTH_BUFFER,
      exchangeLimitedNotional: limits.maxOrder,
      sizeFraction: evidenceSize,
      currentExposureQuote: finite(managed.openCostQuote),
    })
    : null;
  const slotQuote = allocationOnly ? finite(riskSizing?.slotCap) : Number.POSITIVE_INFINITY;
  const riskNotional = allocationOnly && riskSizing
    ? enforceMinimumExecutableNotional(
      riskSizing,
      executableMinimumCapitalQuote,
      managedAvailable,
    )
    : 0;
  const maxOrder = allocationOnly
    ? Math.min(managedAvailable, riskNotional)
    : Math.min(limits.maxOrder, plan.recommended > 0 ? plan.recommended : limits.maxOrder);
  // On spot leverage is 1 and everything below is unchanged. On the futures lane the
  // allocator still decides how much CAPITAL the trade may commit, and leverage decides
  // how much notional that capital controls: margin x leverage. Sizing the margin rather
  // than the notional is what makes "-12% on margin" cost the operator the same fraction
  // of the account that "-4% on price" costs a spot trade of the same allocation.
  const allocationSizing = (entryPrice: number) => {
    const marginQuote = floorToStep(
      Math.min(futuresMarginCapacity, maxOrder),
      limits.quoteStep,
    );
    const notionalQuote = floorToStep(marginQuote * leverage, limits.quoteStep);
    return marginQuote >= minimumEntryMarginQuote &&
        notionalQuote >= minimumEntryNotionalQuote
      ? {
        allowed: true,
        notionalQuote,
        marginQuote,
        leverage,
        quantity: notionalQuote / entryPrice,
        stopDistancePct: 0,
        riskBudgetQuote: marginQuote,
        reason: null,
      }
      : {
        allowed: false,
        notionalQuote: 0,
        marginQuote: 0,
        leverage,
        quantity: 0,
        stopDistancePct: 0,
        riskBudgetQuote: 0,
        reason:
          `allocated margin ${marginQuote} below ${minimumEntryMarginQuote} or position notional ${notionalQuote} below ${minimumEntryNotionalQuote}`,
      };
  };
  const marginBasedSizing = allocationOnly || exchange === "binance_futures";
  const initial = marginBasedSizing ? allocationSizing(bestAsk) : calculatePositionSize({
    equityQuote: finite(managed.managedCapitalQuote),
    availableQuote: managedAvailable,
    entryPrice: bestAsk,
    stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct,
    riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder,
    minOrderQuote: Math.max(limits.minOrder, rules.min_notional),
    quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!initial.allowed) {
    return { entered: false, exchange, market: candidate.market, reason: initial.reason };
  }
  let depth = executableDepth(market.asks, maxEntry, initial.notionalQuote);
  if (!depth.executable || depth.availableFunds < initial.notionalQuote * LIVE_MIN_DEPTH_BUFFER) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: `insufficient ask depth (${
        depth.availableFunds.toFixed(exchange === "upbit" ? 0 : 2)
      } ${quote})`,
    };
  }
  const entryPrice = tickRound(Math.min(maxEntry, depth.worstPrice), rules.price_tick, "down");
  const sizing = marginBasedSizing ? allocationSizing(entryPrice) : calculatePositionSize({
    equityQuote: finite(managed.managedCapitalQuote),
    availableQuote: managedAvailable,
    entryPrice,
    stopPrice: candidate.stop_price,
    maxPositionPct: settings.max_position_pct,
    riskPerTradePct: settings.risk_per_trade_pct,
    maxOrderQuote: maxOrder,
    minOrderQuote: Math.max(limits.minOrder, rules.min_notional),
    quoteStep: limits.quoteStep,
    extraLossPct: FEE_PCT[exchange] * 2 / 100 + 0.001,
  });
  if (!sizing.allowed) {
    return { entered: false, exchange, market: candidate.market, reason: sizing.reason };
  }
  depth = executableDepth(market.asks, maxEntry, sizing.notionalQuote);
  if (!depth.executable || depth.availableFunds < sizing.notionalQuote * LIVE_MIN_DEPTH_BUFFER) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: "depth deteriorated during sizing",
    };
  }
  const entryQuantityStep = rules.quantity_step || 0.00000001;
  const executableEntryQuantity = (requestedNotionalQuote: number): number => {
    if (exchange !== "binance_futures") {
      return entryQuantityForNotional(
        exchange,
        requestedNotionalQuote,
        entryPrice,
        entryQuantityStep,
      );
    }
    return futuresAffordableEntry({
      availableMarginQuote: managedAvailable,
      requestedNotionalQuote,
      entryPrice,
      quantityStep: entryQuantityStep,
      leverage,
      feePerSidePct: futuresEntryFeePct,
    }).quantity;
  };
  let quantity = executableEntryQuantity(sizing.notionalQuote);
  if (!(quantity > 0) || quantity * entryPrice < minimumEntryNotionalQuote) {
    return {
      entered: false,
      exchange,
      market: candidate.market,
      reason: "quantity below exchange minimum",
    };
  }

  // Stage 4: scalp final gate — safety rails (halt/cap) FIRST, then precise stressed-slippage EV.
  // Only active when strategy === "SCALP"; otherwise the original flow is untouched.
  let scalpStopPrice: number | null = null;
  let scalpTarget1: number | null = null;
  let scalpTarget2: number | null = null;
  let scalpAudit: JsonRecord | null = null;
  let decisionNotional = quantity * entryPrice;
  if (isLobStrategy((settings as any).strategy)) {
    const {
      lobSnapshot,
      features,
      assignedPolicy,
      patternPolicy,
      onlinePolicy,
      evidenceSizing,
      fixedPlanTargetBps,
      fixedPlanStopBps,
      fixedPlanMaxHoldingSeconds,
    } = lobSizingContext;
    const liveFee = await liveFeePct(exchange, settings);
    const roundTripFeeBps = liveFee * 2 * 100;
    // Fees, slippage and latency are already subtracted below. Adding a second
    // fee-proportional cushion double-counted costs and turned a positive-net rule into an
    // undocumented no-trade rule.
    const minimumTargetNetProfitBps = Math.max(
      0.01,
      finite((settings as any).lob_min_target_net_profit_bps, 0.01),
    );
    const makerFill = await loadMakerFillStats(exchange);
    const measuredMakerFillRate = makerFill.rested > 0 ? makerFill.filled / makerFill.rested : 0;
    // v6.5: execution delay is now priced from measurement instead of being absent from
    // this path entirely. The book's own noise band supplies the volatility and the
    // measured p95 tick-to-order supplies the time; see _shared/scalp/latency.ts.
    const latencyPenalty = latencyPenaltyBpsFor(
      settings as TradingSettings & JsonRecord,
      finite((features as any).noiseBandBps, 0),
      Math.max(1000, finite((settings as any).lob_observation_window_ms, 8000)),
      assignedPolicy.policyDefinition.latency,
    );
    const calibratedEvBiasPenaltyBps = boundedEvBiasPenalty(
      (settings as any).scalp_ev_bias_penalty_bps,
      assignedPolicy.policyDefinition.evBias.penaltyMultiplier,
      assignedPolicy.policyDefinition.evBias.maxPenaltyBps,
    );
    const onlineMarketPenaltyBps = onlineAdverseEvPenaltyBps(
      onlinePolicy,
      assignedPolicy.policyDefinition.evBias.maxPenaltyBps,
    );
    // These are two estimates of the same optimism, not independent costs. Apply the
    // stronger one once so repeated negative fee-net evidence corrects admission without
    // double-counting it or imposing a trade-count cap.
    const lobExecutionCosts: LobCostEstimate = {
      roundTripFeeBps,
      entrySlippageBps: makerEntryEnabled(settings, exchange) ? 0 : Math.max(0.1, spreadBps * 0.15),
      targetExitSlippageBps: exchange !== "binance_futures" &&
          (settings as any).scalp_resting_tp !== false
        ? 0
        : Math.max(0.1, spreadBps * 0.15),
      stopExitSlippageBps: Math.max(0.4, spreadBps * 0.55),
      spreadBps,
      latencyPenaltyBps: latencyPenalty.bps,
      forecastBiasPenaltyBps: 0,
    };
    const lobExecutionGate = {
      // Same builder the scanner uses, so the first-pass BUY judgement and this
      // order-time recheck cannot drift apart again.
      ...buildLobGateConfig({
        minNetProfitBps: minimumTargetNetProfitBps,
        minNetRewardRiskRatio: finite((settings as any).lob_min_net_reward_risk_ratio, 1.5),
        maxStopToTargetRatio: finite((settings as any).lob_max_stop_to_target_ratio, 1.35),
        maxGainerRank: finite((settings as any).lob_max_gainer_rank, 3),
        maxBookAgeMs: finite((settings as any).lob_max_book_age_ms, 2500),
        maxSpreadBps: finite((settings as any).lob_max_spread_bps, LIVE_MAX_SPREAD_BPS),
      }, { maxSpreadBps: LIVE_MAX_SPREAD_BPS }),
      requireMinuteEntryGate: true,
      maxHoldingSeconds: Math.round(
        clamp(finite((settings as any).lob_max_holding_seconds, 180), 1, 300),
      ),
      absoluteMaxHoldingSeconds: Math.round(
        clamp(finite((settings as any).lob_absolute_max_holding_seconds, 300), 1, 300),
      ),
      uncertaintyHaircut: clamp(finite((settings as any).lob_uncertainty_haircut, 0.25), 0, 0.9),
      trap: lobTrapOverrides(settings),
      disabledVetoes: [],
      patternProbabilityMultiplier: 1,
      measuredMakerFillRate,
      makerFillSamples: makerFill.rested,
      learnedStopFloorBps: 0,
      fixedTargetBps: fixedPlanTargetBps,
      fixedStopBps: fixedPlanStopBps,
      fixedMaxHoldingSeconds: fixedPlanMaxHoldingSeconds,
      blockedPatterns: liveBlockedLobPatterns(exchange),
    };
    const decision = evaluateLobEntry(features, lobExecutionCosts, lobExecutionGate);
    lobSizingContext.preOrderGate = {
      costs: lobExecutionCosts,
      maxBookAgeMs: lobExecutionGate.maxBookAgeMs,
      fixedTargetBps: fixedPlanTargetBps,
      fixedStopBps: fixedPlanStopBps,
      maxStopToTargetRatio: lobExecutionGate.maxStopToTargetRatio,
      minNetRewardRiskRatio: lobExecutionGate.minNetRewardRiskRatio,
      requireMinuteEntryGate: true,
      blockedPatterns: liveBlockedLobPatterns(exchange),
    };
    scalpAudit = {
      strategy: "LOB_SCALP",
      strategy_revision: VERSION,
      recommendation,
      pattern: decision.pattern,
      patterns: decision.patterns,
      hotness: decision.hotness,
      p_target: decision.pTarget,
      p_stop: decision.pStop,
      p_timeout: decision.pTimeout,
      p_fill: decision.pFill,
      p_fill_raw: decision.rawPFill,
      p_fill_calibration_weight: decision.fillCalibrationWeight,
      pattern_learning: {
        samples: patternPolicy.samples,
        observed_multiplier: patternPolicy.observedMultiplier,
        gate_multiplier: patternPolicy.gateMultiplier,
        gate_weight: patternPolicy.gateWeight,
        ranking_quality: patternPolicy.rankingQuality,
        profitable_rate: patternPolicy.profitableRate,
        mean_net_bps: patternPolicy.meanNetBps,
        median_hold_seconds: patternPolicy.medianHoldSeconds,
        profit_factor: patternPolicy.profitFactor,
        payoff_ratio: patternPolicy.payoffRatio,
        mean_net_lower_bound_bps: patternPolicy.meanNetLowerBoundBps,
        deployment_reason: patternPolicy.deploymentReason,
      },
      policy: assignedPolicy
        ? {
          version: assignedPolicy.version,
          lane: assignedPolicy.lane,
          status: assignedPolicy.status,
          phase: assignedPolicy.phase,
          parent_version: assignedPolicy.parentVersion,
          evaluation_started_at: assignedPolicy.evaluationStartedAt,
          definition: assignedPolicy.policyDefinition,
        }
        : {
          version: 0,
          lane: "LEGACY",
          status: "CHAMPION",
          phase: "IDLE",
          parent_version: null,
          evaluation_started_at: null,
        },
      coin_learning: {
        profile_version: onlinePolicy.profileVersion,
        source: onlinePolicy.source,
        market_samples: onlinePolicy.marketSamples,
        pattern_samples: onlinePolicy.globalSamples,
        profitable_rate: onlinePolicy.profitableRate,
        target_hit_rate: onlinePolicy.targetHitRate,
        mean_net_bps: onlinePolicy.meanNetBps,
        expected_hold_seconds: onlinePolicy.expectedHoldSeconds,
        ranking_quality: onlinePolicy.rankingQuality,
        learned_stop_floor_bps: onlinePolicy.learnedStopFloorBps,
        soft_exit_grace_seconds: onlinePolicy.softExitGraceSeconds,
        soft_exit_confirmations: onlinePolicy.softExitConfirmations,
      },
      target_bps: decision.targetBps,
      stop_bps: decision.stopBps,
      target_return_net_bps: decision.targetReturnNetBps,
      stop_to_target_ratio: decision.stopToTargetRatio,
      net_reward_risk_ratio: decision.netRewardRiskRatio,
      minimum_target_net_profit_bps: decision.minimumTargetNetProfitBps,
      minimum_verified_ev_bps: decision.minimumVerifiedEvBps,
      // v6.2: the calibration job needs the arithmetic term separated from the model's
      // belief, otherwise it cannot tell a wide stop from actual predictive skill.
      neutral_win_rate: neutralWinRateOf(decision.targetBps, decision.stopBps),
      noise_adjusted_stop_bps: decision.noiseAdjustedStopBps,
      traps: decision.traps.traps.map((trap) => trap.name),
      trap_detail: decision.traps.traps,
      prediction_basis: "FILL_CONDITIONAL",
      conditional_ev_net_bps: decision.conditionalEvNetBps,
      conditional_ev_lower_bound_bps: decision.conditionalEvLowerBoundBps,
      attempt_ev_net_bps: decision.attemptEvNetBps,
      attempt_ev_lower_bound_bps: decision.attemptEvLowerBoundBps,
      // Compatibility aliases are conditional-on-fill from v6.10 onward.
      ev_net_bps: decision.evNetBps,
      ev_lower_bound_bps: decision.evLowerBoundBps,
      max_holding_seconds: decision.maxHoldingSeconds,
      reasons: decision.reasons,
      warnings: decision.warnings,
      features: decision.features,
      fixed_scan_plan_geometry: {
        target_bps: fixedPlanTargetBps,
        stop_bps: fixedPlanStopBps,
        max_holding_seconds: fixedPlanMaxHoldingSeconds,
      },
      scanned_lob: lobSnapshot,
      slots,
      slot_quote: Number.isFinite(slotQuote) ? slotQuote : null,
      risk_sizing: riskSizing,
      evidence_sizing: evidenceSizing,
      forecast_bias_penalty_bps: decision.forecastBiasPenaltyBps,
      calibrated_forecast_bias_penalty_bps: calibratedEvBiasPenaltyBps,
      online_market_adverse_penalty_bps: onlineMarketPenaltyBps,
      forecast_bias_samples: Math.max(0, finite((settings as any).scalp_ev_bias_samples, 0)),
      forecast_bias_source: onlineMarketPenaltyBps > calibratedEvBiasPenaltyBps
        ? "ONLINE_MARKET_EVIDENCE"
        : String((settings as any).scalp_ev_bias_source || "UNMEASURED"),
      // v6.3: the open question from v5.5 -- what fraction of maker entries actually fill --
      // recorded on every entry so it stops being a guess. `convertToTaker` is the measured
      // recommendation; acting on it costs 2.4x more per round trip on Upbit, so it is
      // reported first and switched on deliberately.
      maker_fill: (() => {
        const evAtTaker = decision.evLowerBoundBps -
          (Math.max(0.1, spreadBps * 0.15) + Math.max(0.1, spreadBps * 0.15));
        return { ...makerFill, ...shouldConvertToTaker(makerFill, evAtTaker) };
      })(),
      decision_id: decisionId,
      latency_penalty_bps: latencyPenalty.bps,
      latency_penalty_source: latencyPenalty.source,
    };
    trace.mark("decision_made");
    // v6.5: the audit travels with the candidate so the wrapper can file it whether this
    // book trades or not. A rejection now carries the same evidence an entry does.
    (candidate as any).__decision_audit = scalpAudit;
    // Ranking inputs for rotation: what this book is worth per second of slot occupancy.
    const rotationMetrics = lobSelectionMetrics({
      ev_lower_bound_bps: decision.evLowerBoundBps,
      p_target: decision.pTarget,
      target_bps: decision.targetBps,
      stop_bps: decision.stopBps,
      max_holding_seconds: decision.maxHoldingSeconds,
      pattern_quality: patternPolicy.rankingQuality,
      empirical_profitable_rate: patternPolicy.profitableRate,
      empirical_hold_seconds: patternPolicy.medianHoldSeconds,
      features: {
        noiseBandBps: finite((features as any).noiseBandBps, 0),
        observationMs: Math.max(
          1000,
          finite((settings as any).lob_observation_window_ms, 8000),
        ),
      },
    });
    (candidate as any).__rotation = {
      evLowerBoundBps: rotationMetrics.qualityAdjustedEvBps,
      expectedSecondsToResolve: rotationMetrics.expectedSecondsToResolve,
      entryCostBps: liveFee * 100 + latencyPenalty.bps,
    };
    // v7.1.1: FIXED_PLAN_STOP_INVALIDATED was a scanner/autotrader contract mismatch.
    // Ignore that code only when it is the sole blocker and the live recheck still has
    // a primary pattern, positive conditional EV and positive fee-net target.
    const effectiveRecheckReasons = decision.reasons.filter((reason) =>
      reason !== "FIXED_PLAN_STOP_INVALIDATED"
    );
    const fixedPlanCompatibilityEntry = decision.decision !== "BUY" &&
      effectiveRecheckReasons.length === 0 &&
      Boolean(decision.pattern) &&
      decision.conditionalEvNetBps > 0 &&
      decision.targetReturnNetBps > 0;
    if (decision.decision !== "BUY" && !fixedPlanCompatibilityEntry) {
      await event(
        "LOB_CANDIDATE_DISCARD",
        `${exchange}:${candidate.market} live LOB recheck discarded`,
        scalpAudit,
        { cycleId, level: "INFO" },
      );
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: `LOB recheck: ${decision.reasons.join(",") || decision.decision}`,
      };
    }
    const targetPct = decision.targetBps / 10000;
    // The target only needs to clear actual entry/exit fees plus one minimum
    // quote-currency display unit. No second synthetic price haircut is applied.
    const targetFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);
    const targetEntryFeeRate = exchange === "upbit" ? targetFeeRate : 0;
    const targetProfitBufferQuote = exchange === "upbit" ? 1 : 0.01;
    const targetEntryCost = entryPrice * quantity * (1 + targetEntryFeeRate);
    const netPositiveTargetPrice = (targetEntryCost + targetProfitBufferQuote) /
      (quantity * (1 - targetFeeRate));
    const stopPct = clamp(finite(decision.stopBps, 0) / 10_000, 0.0006, 0.02);
    scalpStopPrice = tickRound(entryPrice * (1 - stopPct), rules.price_tick, "down");
    scalpTarget1 = tickRound(
      Math.max(entryPrice * (1 + targetPct), netPositiveTargetPrice),
      rules.price_tick,
      "up",
    );
    scalpTarget2 = scalpTarget1;
  } else if ((settings as any).strategy === "SCALP") {
    const scalpSnapshot = (candidate as any).snapshot?.scalp || {};
    const scanPWin = finite(
      (candidate as any).scalp_p_win ?? scalpSnapshot.pWin ?? (candidate as any).scalp?.pWin,
      0.5,
    );
    const scalpTargetPct = finite(
      (candidate as any).scalp_target_pct ?? scalpSnapshot.target_pct ??
        (candidate as any).scalp?.target_pct,
      0.006,
    );
    const scalpStopPct = finite(
      (candidate as any).scalp_stop_pct ?? scalpSnapshot.stop_pct ??
        (candidate as any).scalp?.stop_pct,
      0.003,
    );
    const resolveProbability = clamp(finite(scalpSnapshot.geometry?.resolve_probability, 1), 0, 1);

    const askLevels = (market.asks || []).map((a: any) => ({
      price: finite(a.price ?? a[0]),
      size: finite(a.size ?? a[1]),
    }));
    const bidLevels = (market.bids || []).map((b: any) => ({
      price: finite(b.price ?? b[0]),
      size: finite(b.size ?? b[1]),
    }));

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
        alphaHalfLifeMs: clamp(
          finite((settings as any).scalp_alpha_half_life_ms, DEFAULT_SCALP_SIGNAL.alphaHalfLifeMs),
          1000,
          300000,
        ),
      },
      finite(scalpSnapshot.trend_penalty, 1),
      // v5.7: anchor the refresh to the barrier baseline, not a flat constant.
      finite(scalpSnapshot.neutral_win_rate, 0),
    );
    // v5.3: correct the model's probability with whatever the realized outcomes say.
    // Identity until the calibration job has enough samples to promote a profile.
    const calibration = await loadScalpCalibration();
    const scalpPWin = applyCalibration(rawPWin, calibration);

    const day = await scalpDayState(
      exchange,
      settings.mode !== "LIVE_LIMITED",
      finite(managed.managedCapitalQuote),
    );
    const decision = scalpEntryDecision(
      {
        capitalQuote: finite(managed.managedCapitalQuote),
        requestedCapital: exchange === "binance_futures"
          ? finite((sizing as any).marginQuote)
          : sizing.notionalQuote,
        notionalPerCapital: leverage,
        requestedNotional: sizing.notionalQuote,
        day,
        pWin: scalpPWin,
        targetPct: scalpTargetPct,
        stopPct: scalpStopPct,
        askLevels,
        bidLevels,
        bestAsk,
        bestBid,
        resolveProbability,
        expectedHoldingMinutes: clamp(finite(scalpSnapshot.geometry?.horizon_minutes, 15), 1, 1440),
        expectedOrderType: (settings as any).scalp_maker_entry === false
          ? "IOC_LIMIT"
          : "POST_ONLY",
        depthCoverageRatio: depth.availableFunds / Math.max(1, sizing.notionalQuote),
        spreadBps,
        bookImbalance: liveImbalance,
        signalAgeMs,
        forecastEffectiveSamples: calibration.samples,
        forecastIndependentBlocks: Math.floor(calibration.samples / 20),
        forecastCalibrationReady: calibration.samples >=
          Math.max(0, finite((settings as any).scalp_min_forecast_samples, 60)),
        modelVersion: `${VERSION}-outcome.bridge.1`,
        calibrationVersion: `platt:${calibration.a.toFixed(6)}:${calibration.b.toFixed(6)}`,
      },
      scalpSafetyConfig(settings),
      scalpCostConfig(settings, exchange, await liveFeePct(exchange, settings)),
      scalpCandidateGateConfig(settings),
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
      ev_lower_bound: decision.evLowerBound,
      p_win_lower_bound: decision.pWinLowerBound,
      p_fill_lower_bound: decision.pFillLowerBound,
      rejection_reasons: decision.rejectionReasons,
      capital_efficiency: decision.evaluation?.capitalEfficiency ?? null,
      geometry: scalpSnapshot.geometry || null,
      features: scalpSnapshot.features || null,
      strategy_profile: normalizeStrategyProfile((settings as any).scalp_strategy_profile),
      slots,
      slot_quote: Number.isFinite(slotQuote) ? slotQuote : null,
      risk_sizing: riskSizing,
    };
    if (!decision.allow) {
      // v5.12: rejected candidates remain available to shadow replay, but no live/paper
      // entry may bypass EV, pWin or pFill lower bounds.
      await event("SCALP_GATE_BLOCK", `${exchange}:${candidate.market} scalp gate blocked`, {
        reason: decision.reason,
        shadow_only: true,
        ...scalpAudit,
      }, { cycleId, level: "INFO" });
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: `scalp gate: ${decision.reason}`,
      };
    }
    decisionNotional = decision.notional;
    if (decision.notional < sizing.notionalQuote) {
      quantity = executableEntryQuantity(decision.notional);
      if (
        !(quantity > 0) || quantity * entryPrice < minimumEntryNotionalQuote
      ) {
        return {
          entered: false,
          exchange,
          market: candidate.market,
          reason: "allocation-controlled order below exchange minimum",
        };
      }
    }
    decisionNotional = quantity * entryPrice;
    // Exits follow the scalp target/stop the EV gate was evaluated on, not the wide
    // trend plan — otherwise the position would hold to trend targets after a scalp entry.
    scalpStopPrice = tickRound(entryPrice * (1 - scalpStopPct), rules.price_tick, "down");
    scalpTarget1 = tickRound(entryPrice * (1 + scalpTargetPct), rules.price_tick, "up");
    scalpTarget2 = tickRound(entryPrice * (1 + scalpTargetPct * 1.5), rules.price_tick, "up");
  }

  // v7.2.4: do not perform a network quote here. The live LOB decision above already
  // validated the current book. A single final quote is taken after reservation and
  // immediately before order construction, eliminating serial confirmation latency.

  // Low-evidence trades preserve learning throughput, but they have their own daily loss
  // budget and concurrency cap. The budget is claimed only AFTER the position row exists,
  // so every reserve has an idempotent position key and cancellation cannot leak budget.
  const lowEvidenceTrade = isLobStrategy((settings as any).strategy) &&
    Boolean(lobSizingContext?.evidenceSizing?.lowEvidence);
  let explorationWorstCaseLossQuote = 0;
  if (settings.mode === "LIVE_LIMITED" && lowEvidenceTrade) {
    const maxConcurrent = Math.max(
      1,
      Math.floor(
        finite(
          lobSizingContext?.assignedPolicy?.policyDefinition?.exploration?.maxConcurrentLowEvidence,
          1,
        ),
      ),
    );
    const activeLowEvidence = await db(
      `trading_positions?exchange=eq.${exchange}&state=in.(ENTRY_PENDING,OPEN,EXITING)&metadata->>low_evidence=eq.true&select=id`,
    ).catch(() => []);
    if (activeLowEvidence.length >= maxConcurrent) {
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: "low-evidence concurrency budget exhausted",
      };
    }
    const stopFraction = Math.max(
      0.000001,
      scalpStopPrice && entryPrice > 0 ? (entryPrice - scalpStopPrice) / entryPrice : 0.005,
    );
    explorationWorstCaseLossQuote = decisionNotional *
      (stopFraction + FEE_PCT[exchange] * 2 / 100 + 0.001);
  }

  // v5.12: per-symbol expected resolution is retained for diagnostics, while
  // max_holding_at is the hard TIMEOUT barrier. The profile ceiling prevents an HF signal
  // from silently turning into an intraday position.
  const holdingProfile = resolveProfileHolding(
    isLobStrategy((settings as any).strategy)
      ? "LOB_SCALP"
      : (settings as any).scalp_strategy_profile,
    finite((settings as any).scalp_max_holding_minutes, 3),
    finite((settings as any).scalp_safety_ttl_minutes, 5),
    isLobStrategy((settings as any).strategy)
      ? finite((candidate as any).snapshot?.lob?.max_holding_seconds, 180) / 60
      : finite((candidate as any).snapshot?.scalp?.geometry?.horizon_minutes, 15),
  );
  const scalpExpectedMinutes = isLobStrategy((settings as any).strategy)
    ? clamp(finite((candidate as any).snapshot?.lob?.max_holding_seconds, 180) / 60, 0.1, 5)
    : holdingProfile.expectedResolutionMinutes;
  const scalpSafetyTtlMinutes = isLobStrategy((settings as any).strategy)
    ? clamp(finite((settings as any).lob_absolute_max_holding_seconds, 300) / 60, 0.1, 5)
    : holdingProfile.timeoutMinutes;
  const maxHolding = isScalpStrategy((settings as any).strategy)
    ? new Date(Date.now() + scalpSafetyTtlMinutes * 60_000).toISOString()
    : new Date(Date.now() + clamp(finite(candidate.intended_horizon_hours, 24), 1, 480) * 3600_000)
      .toISOString();
  let position = (await insert("trading_positions", {
    candidate_id: candidate.id,
    scan_id: candidate.scan_id,
    decision_id: decisionId,
    exchange,
    quote_currency: quote,
    market: candidate.market,
    base_asset: base,
    state: "ENTRY_PENDING",
    // Persisted rather than re-read from settings at exit time: the thresholds are stated
    // on margin, so a position must be closed at the leverage it was opened with even if
    // the operator changes the setting while it is running.
    leverage,
    reserved_quote: quantity * entryPrice,
    reserved_quantity: quantity,
    reservation_expires_at: new Date(
      Date.now() + Math.max(30, finite(settings.entry_ttl_seconds, 180)) * 1000,
    ).toISOString(),
    fee_accounting_quality: settings.mode === "LIVE_LIMITED"
      ? "LEGACY_UNVERIFIED"
      : "NOT_APPLICABLE",
    fee_accounting_version: "6.10.0",
    is_paper: settings.mode !== "LIVE_LIMITED",
    profile_version: candidate.profile_version || 0,
    planned_entry_price: entryPrice,
    stop_price: scalpStopPrice ?? candidate.stop_price,
    target_1: scalpTarget1 ?? candidate.target_1,
    target_2: scalpTarget2 ?? candidate.target_2,
    tick_size: rules.price_tick,
    quantity_step: rules.quantity_step,
    // Spot records the higher of the operator floor and the venue filter, because both
    // apply to the same number. On futures the operator floor governs the MARGIN while the
    // venue filter governs the NOTIONAL, so the exit-side floor is the venue's alone —
    // carrying the margin floor here would make a legitimate half-exit look like dust.
    min_notional_quote: exchange === "binance_futures"
      ? Math.max(1, rules.min_notional)
      : Math.max(limits.minOrder, rules.min_notional),
    t1_allocation_pct: plan.allocation,
    exit_policy: plan.exitPolicy,
    trailing_distance_pct: plan.trailingDistancePct,
    intended_horizon_hours: candidate.intended_horizon_hours,
    max_holding_at: maxHolding,
    metadata: {
      cycle_id: cycleId,
      sizing,
      futures: exchange === "binance_futures"
        ? {
          leverage,
          margin_quote: decisionNotional / leverage,
          notional_quote: decisionNotional,
          exit_policy: "FUTURES_SPLIT_ROE",
          thresholds: FUTURES_SPLIT_EXIT_THRESHOLDS,
        }
        : null,
      managed_allocation: managed,
      quote_at_entry: market,
      execution_depth: depth,
      live_spread_bps: spreadBps,
      engine_version: VERSION,
      // Baseline for the bid-support check: how much resting bid stood under the position
      // at entry. A large fall in this is support evaporating.
      entry_bid_depth_quote: bidDepthQuote(market),
      // v5.3: the full entry-time signal, persisted so the pWin calibration loop can
      // later join predicted probability against the realized outcome on this row.
      scalp_signal: scalpAudit,
      lob_signal: isLobStrategy((settings as any).strategy)
        ? { ...(scalpAudit || {}), prediction_basis: "FILL_CONDITIONAL" }
        : null,
      prediction_basis: isLobStrategy((settings as any).strategy) ? "FILL_CONDITIONAL" : null,
      low_evidence: Boolean(lobSizingContext?.evidenceSizing?.lowEvidence),
      // Tagged so calibration can weight these and so their cost is reportable separately.
      is_exploration: lowEvidenceTrade,
      exploration_budget: (candidate as any).__exploration_budget || null,
      scalp_expected_minutes: isScalpStrategy((settings as any).strategy)
        ? scalpExpectedMinutes
        : null,
      scalp_safety_ttl_minutes: isScalpStrategy((settings as any).strategy)
        ? scalpSafetyTtlMinutes
        : null,
      expected_resolution_at: isScalpStrategy((settings as any).strategy)
        ? new Date(Date.now() + scalpExpectedMinutes * 60_000).toISOString()
        : null,
      // v7.2.4 removed the first serial pre-order recheck; only the final quote taken
      // immediately before order construction survives, and it is recorded as recheck_2.
      pre_order_lob_recheck_1: null,
    },
  }))[0] as Position;

  if (settings.mode === "LIVE_LIMITED" && lowEvidenceTrade) {
    const explorationClaim = await rpc("claim_lob_exploration_budget_v610", {
      p_position_id: position.id,
      p_exchange: exchange,
      p_managed_capital_quote: finite(managed.managedCapitalQuote),
      p_worst_case_loss_quote: explorationWorstCaseLossQuote,
    });
    if (explorationClaim?.allowed !== true) {
      // The operator-approved daily stop is `scalp_daily_loss_pct`. This separate learning
      // ledger is telemetry only: it must never become a hidden second circuit breaker.
      await event(
        "LOW_EVIDENCE_BUDGET_OBSERVED",
        `${exchange}:${candidate.market} learning-loss telemetry threshold exceeded`,
        { ...(explorationClaim || {}), enforcement: "TELEMETRY_ONLY" },
        { cycleId, positionId: position.id, level: "INFO" },
      );
    }
    const explorationBudget = {
      ...(explorationClaim || {}),
      enforcement: "TELEMETRY_ONLY",
      claimed_loss_quote: explorationWorstCaseLossQuote,
      day_key: explorationClaim?.day_key || explorationClaim?.row?.day_key || null,
    };
    const updated = await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: {
        ...(position.metadata || {}),
        exploration_budget: explorationBudget,
      },
    });
    position = (updated[0] ||
      {
        ...position,
        metadata: { ...(position.metadata || {}), exploration_budget: explorationBudget },
      }) as Position;
  }

  let secondLobPreOrderRecheck: LobPreOrderRecheck | null = null;
  if (isLobStrategy((settings as any).strategy)) {
    // v7.2.4 single-final validation: one fresh quote, no wait, no paired persistence
    // check, and no audit DB write before the exchange request. A failed final book
    // still blocks immediately; a passed book proceeds directly to order construction.
    const [finalPreOrderMarket, finalMinuteEntryGate] = await Promise.all([
      marketQuote(exchange, candidate.market),
      loadMinuteEntryGate(exchange, candidate.market),
    ]);
    secondLobPreOrderRecheck = evaluateLobPreOrderRecheck(
      lobSizingContext.lobSnapshot,
      finalPreOrderMarket,
      {
        maxEntry,
        maxSpreadBps: entryMaxSpreadBps,
        requiredNotionalQuote: decisionNotional,
        ...lobSizingContext.preOrderGate,
        trap: lobTrapOverrides(settings),
      },
    );
    // Live futures data showed the second M1 snapshot was re-vetoing opportunities that
    // had already passed the setup gate, while the current executable LOB remained safe.
    // Keep the fresh futures M1 read for audit only; current executable LOB safety owns the
    // final futures veto. Spot/Upbit retain their existing hard final M1 behavior.
    const finalAdmission = resolveFinalLobAdmission(
      exchange,
      secondLobPreOrderRecheck.passed,
      secondLobPreOrderRecheck.reasons,
      finalMinuteEntryGate.passed,
      finalMinuteEntryGate.reasons,
    );
    const finalReasons = finalAdmission.blockingReasons;
    const finalPassed = finalAdmission.passed;
    const finalAudit = {
      checked_at: secondLobPreOrderRecheck.checkedAt,
      passed: finalPassed,
      reasons: finalReasons,
      minute_entry_gate: finalMinuteEntryGate,
      minute_entry_gate_advisory: {
        enabled: finalAdmission.minuteGateAdvisory,
        passed: finalMinuteEntryGate.passed,
        reasons: finalAdmission.minuteGateAdvisoryReasons,
        rationale: finalAdmission.minuteGateAdvisory
          ? "FUTURES_SETUP_M1_ALREADY_CONFIRMED_FINAL_EXECUTABLE_LOB_AUTHORITATIVE"
          : null,
      },
      best_bid: secondLobPreOrderRecheck.bestBid,
      best_ask: secondLobPreOrderRecheck.bestAsk,
      spread_bps: secondLobPreOrderRecheck.spreadBps,
      bid_depth_quote: secondLobPreOrderRecheck.bidDepthQuote,
      ask_depth_quote: secondLobPreOrderRecheck.askDepthQuote,
      trade_pressure_fast: secondLobPreOrderRecheck.tradePressureFast,
      microprice_deviation_bps: secondLobPreOrderRecheck.micropriceDeviationBps,
      interval_ms: 0,
      validation_mode: "SINGLE_FINAL_NO_WAIT",
    };
    if (!finalPassed) {
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "LOB_PREORDER_RECHECK_BLOCKED",
        closed_at: new Date().toISOString(),
        metadata: { ...(position.metadata || {}), pre_order_lob_recheck_2: finalAudit },
      });
      await event(
        "LOB_PREORDER_RECHECK_BLOCK",
        `${exchange}:${candidate.market} final pre-order LOB check blocked`,
        { stage: "FINAL", ...finalAudit },
        { cycleId, positionId: position.id, level: "INFO" },
      );
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: `LOB final pre-order check: ${finalReasons.join(",")}`,
      };
    }
    // Keep the audit in memory. The normal post-order position update persists it without
    // adding a blocking database round trip between the final quote and order submission.
    position = {
      ...position,
      metadata: { ...(position.metadata || {}), pre_order_lob_recheck_2: finalAudit },
    };
  }

  if (settings.mode !== "LIVE_LIMITED") {
    const paperPrice = depth.vwap > 0 ? depth.vwap : entryPrice;
    // PAPER must use the same final, safety-capped quantity as LIVE.
    const paperQty = floorToStep(quantity, rules.quantity_step || 0.00000001);
    const opened = await openPaperPosition(
      position,
      candidate,
      paperPrice,
      paperQty,
      paperQty * paperPrice,
    );
    await event("PAPER_ENTRY", `${exchange}:${candidate.market} paper entry`, {
      price: paperPrice,
      quantity: paperQty,
      notional_quote: paperQty * paperPrice,
      quote,
    }, { cycleId, positionId: position.id });
    return { entered: true, paper: true, exchange, market: candidate.market, position: opened };
  }

  // v5.5: maker route. Post on the bid and wait instead of taking the ask.
  if (makerEntryEnabled(settings, exchange)) {
    const makerPrice = makerBidPrice(
      secondLobPreOrderRecheck?.bestBid || bestBid,
      rules.price_tick,
    );
    const makerQuantity = floorToStep(
      decisionNotional / makerPrice,
      rules.quantity_step || 0.00000001,
    );
    if (
      !(makerPrice > 0 && makerQuantity > 0) ||
      makerQuantity * makerPrice < minimumEntryNotionalQuote
    ) {
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "MAKER_ENTRY_BELOW_MINIMUM",
        closed_at: new Date().toISOString(),
      });
      return {
        entered: false,
        exchange,
        market: candidate.market,
        reason: "maker order below exchange minimum",
      };
    }
    const makerIdentifier = uniqueId("m", position.id);
    const makerOrderRow = await createOrderRecord({
      position_id: position.id,
      candidate_id: candidate.id,
      cycle_id: cycleId,
      decision_id: decisionId,
      exchange,
      quote_currency: quote,
      identifier: makerIdentifier,
      market: candidate.market,
      side: "BUY",
      purpose: "ENTRY",
      order_type: "LIMIT_MAKER",
      requested_price: makerPrice,
      requested_volume: makerQuantity,
      requested_notional_quote: makerQuantity * makerPrice,
      state: "REQUESTED",
    });
    try {
      trace.mark("order_submitted");
      const result = await gateway(exchange, {
        action: "create_order",
        // The gateway applies this to the symbol before an opening order and ignores it
        // on every other venue. An exit inherits the leverage the position already has.
        leverage: exchange === "binance_futures" ? leverage : undefined,
        order: {
          market: candidate.market,
          side: "BUY",
          type: "LIMIT_MAKER",
          price: makerPrice,
          quantity: makerQuantity,
          identifier: makerIdentifier,
        },
        wait_for_final_ms: 0,
      }, 20_000);
      // The gateway reports when the exchange actually answered; prefer it over our own
      // clock, which includes the return trip and would flatter the measurement.
      trace.mark("order_acked", finite((result as any)?.timing?.acked_at_ms) || null);
      await updateOrderFromGateway(makerOrderRow, result);
      const rows = await patch("trading_positions", `id=eq.${position.id}`, {
        planned_entry_price: makerPrice,
        reserved_quote: makerQuantity * makerPrice,
        reserved_quantity: makerQuantity,
        reservation_expires_at: new Date(
          Date.now() + Math.max(30, finite(settings.entry_ttl_seconds, 180)) * 1000,
        ).toISOString(),
        metadata: {
          ...(position.metadata || {}),
          maker_entry_identifier: makerIdentifier,
          maker_entry_order_id: makerOrderRow.id,
          maker_entry_price: makerPrice,
          maker_entry_placed_at: new Date().toISOString(),
          maker_best_bid_at_placement: bestBid,
          maker_best_ask_at_placement: bestAsk,
        },
      });
      await event("MAKER_ENTRY_RESTED", `${exchange}:${candidate.market} entry posted on the bid`, {
        price: makerPrice,
        quantity: makerQuantity,
        best_bid: bestBid,
        best_ask: bestAsk,
        spread_bps: spreadBps,
      }, { cycleId, positionId: position.id, orderId: makerOrderRow.id });
      // Reserved, not entered: the slot's capital is committed until the order resolves.
      return {
        entered: false,
        reserved: true,
        maker_pending: true,
        exchange,
        market: candidate.market,
        position: { ...position, ...(rows[0] || {}) },
        reason: "maker entry resting",
        exploration: lowEvidenceTrade,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await patch("trading_orders", `id=eq.${makerOrderRow.id}`, {
        state: "REJECTED",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "MAKER_ENTRY_REJECTED",
        closed_at: new Date().toISOString(),
      });
      await event("MAKER_ENTRY_REJECTED", `${exchange}:${candidate.market} maker entry rejected`, {
        error: message,
        price: makerPrice,
      }, { cycleId, positionId: position.id, level: "WARNING" });
      return { entered: false, exchange, market: candidate.market, reason: message };
    }
  }

  // Both Binance venues use FOK so a partial fill cannot create a live position below
  // its operator floor (40 USDT of margin on futures). Upbit keeps its proven IOC path.
  const entryTimeInForce = exchange === "upbit" ? "IOC" : "FOK";
  // v7.2.4: skip the exchange order_test round trip. Precision, minimum notional,
  // depth, spread and executable-price checks have already run locally; the real order
  // response remains the authoritative acceptance check.
  const identifier = uniqueId("e", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id,
    candidate_id: candidate.id,
    cycle_id: cycleId,
    decision_id: decisionId,
    exchange,
    quote_currency: quote,
    identifier,
    market: candidate.market,
    side: "BUY",
    purpose: "ENTRY",
    order_type: "LIMIT",
    time_in_force: entryTimeInForce,
    requested_price: entryPrice,
    requested_volume: quantity,
    requested_notional_quote: quantity * entryPrice,
    state: "REQUESTED",
  });
  try {
    trace.mark("order_submitted");
    const result = await gateway(exchange, {
      action: "create_order",
      leverage: exchange === "binance_futures" ? leverage : undefined,
      order: {
        market: candidate.market,
        side: "BUY",
        type: "LIMIT",
        price: entryPrice,
        quantity,
        time_in_force: entryTimeInForce,
        identifier,
      },
      wait_for_final_ms: 4000,
    }, 20_000);
    trace.mark("order_acked", finite((result as any)?.timing?.acked_at_ms) || null);
    const updated = await updateOrderFromGateway(orderRow, result);
    if (!(finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0)) {
      if (["OPEN", "PARTIALLY_FILLED"].includes(String(updated.order?.status))) {
        return {
          entered: false,
          reserved: true,
          pending_reconcile: true,
          exchange,
          market: candidate.market,
          reason: "entry order still reconciling",
        };
      }
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "ENTRY_NOT_FILLED",
        closed_at: new Date().toISOString(),
      });
      return { entered: false, exchange, market: candidate.market, reason: "IOC entry not filled" };
    }
    const opened = await applyEntryAccounting(position, orderRow, updated.fill);
    await event("LIVE_ENTRY", `${exchange}:${candidate.market} live entry`, {
      fill_price: updated.fill.averagePrice,
      quantity: updated.fill.executedVolume,
    }, { cycleId, positionId: position.id, orderId: orderRow.id });
    // v5.3: rest the first-target limit sell now, so the profit path never depends on a
    // 15-second poll catching the touch. No-op unless scalp_resting_tp is enabled.
    const withTp = await placeRestingTakeProfit(opened as Position, settings, cycleId);
    return {
      entered: true,
      paper: false,
      exchange,
      market: candidate.market,
      position: withTp,
      exploration: lowEvidenceTrade,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((error as any)?.status || 0);
    // A deterministic 4xx rejection means Binance/Upbit did not accept the order.
    // Do not leave a ghost ENTRY_PENDING position. Only transport/5xx uncertainty
    // remains reserved for duplicate-safe reconciliation.
    if (status >= 400 && status < 500) {
      await patch("trading_orders", `id=eq.${orderRow.id}`, {
        state: "REJECTED",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "ENTRY_REJECTED",
        closed_at: new Date().toISOString(),
      });
      await event("ENTRY_ERROR", `${exchange}:${candidate.market} entry rejected`, {
        identifier,
        error: message,
        status,
      }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" });
      return { entered: false, exchange, market: candidate.market, reason: message };
    }
    await patch("trading_orders", `id=eq.${orderRow.id}`, {
      state: "UNKNOWN",
      error_message: message,
    });
    await event(
      "ENTRY_RESULT_UNKNOWN",
      `${exchange}:${candidate.market} entry requires reconciliation`,
      { identifier, error: message },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" },
    );
    return {
      entered: false,
      reserved: true,
      pending_reconcile: true,
      exchange,
      market: candidate.market,
      reason: "entry result unknown; duplicate suppressed",
    };
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

const TP_TERMINAL_STATUSES = [
  "FILLED",
  "CANCELED",
  "PARTIALLY_FILLED_CANCELED",
  "REJECTED",
  "EXPIRED",
];

// v6.8: raw learning tables are observations. Runtime decisions use only immutable policy
// snapshots from lob_policy_versions. Read governance once per scan/monitor request rather
// than keeping an isolate-global cache: after rejection or rollback, even one more entry
// under the retired model would contaminate the next cohort. The selected immutable bundle
// travels with every candidate, so its order-time recheck cannot switch policies.
async function loadLobPolicyRuntime(): Promise<LobPolicyRuntime> {
  try {
    const rows = await db(
      "lob_policy_versions?status=in.(CHAMPION,CHALLENGER,CONTROL)" +
        "&select=version,status,parent_version,engine_version,fingerprint,source_online_version," +
        "traffic_fraction,evaluation_started_at,created_at,confirmed_at,online_profiles," +
        "pattern_profile,policy_definition,metrics,decision_reason&order=version.desc",
    ) as LobPolicyVersionRow[];
    return resolveLobPolicyRuntime(Array.isArray(rows) ? rows : []);
  } catch {
    // New entries fail closed at the caller. Monitor logic can still protect existing
    // positions from their entry-pinned exit parameters while the database recovers.
    return { champion: null, alternate: null, phase: "IDLE" };
  }
}

async function recordLobPolicyExposure(
  cycleId: string,
  scanId: string,
  policy: LobPolicyBundle | null,
  candidateCount: number,
) {
  if (!policy || policy.version <= 0) return;
  await db("lob_policy_cycle_exposures?on_conflict=cycle_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      cycle_id: cycleId,
      scan_id: scanId,
      policy_version: policy.version,
      policy_lane: policy.lane,
      candidate_count: Math.max(0, Math.floor(candidateCount)),
      entry_attempts: 0,
      reservations: 0,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => null);
}

async function completeLobPolicyExposure(
  cycleId: string,
  entryAttempts: number,
  reservations: number,
) {
  await patch("lob_policy_cycle_exposures", `cycle_id=eq.${cycleId}`, {
    entry_attempts: Math.max(0, Math.floor(entryAttempts)),
    reservations: Math.max(0, Math.floor(reservations)),
    completed_at: new Date().toISOString(),
  }).catch(() => null);
}

/** Operator overrides for trap thresholds. Absent keys keep the module defaults. */
function lobTrapOverrides(settings: JsonRecord): Partial<LobTrapConfig> {
  // Written out one column at a time on purpose. A loop over a name table reads more
  // neatly but hides the columns from the migration guard, which exists precisely because
  // a setting that has no column fails the next deploy that touches it.
  const overrides: Partial<LobTrapConfig> = {};
  const take = (key: keyof LobTrapConfig, value: unknown) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) (overrides as any)[key] = parsed;
  };
  take("askIcebergAbsorption", (settings as any).lob_trap_ask_iceberg_absorption);
  take("askIcebergRefillRatio", (settings as any).lob_trap_ask_iceberg_refill);
  take("bidSpoofScore", (settings as any).lob_trap_bid_spoof);
  take("askSpoofScore", (settings as any).lob_trap_ask_spoof);
  take("stopNoiseMultiple", (settings as any).lob_trap_stop_noise_multiple);
  take("maxViableStopBps", (settings as any).lob_trap_max_viable_stop_bps);
  take("flickerPerTrade", (settings as any).lob_trap_flicker_per_trade);
  return overrides;
}

// v6.3: maker fill rate. No new instrumentation was needed -- a filled maker entry becomes
// an OPEN position and an unfilled one is CANCELLED with a MAKER_ENTRY_* reason, so the rate
// has been recoverable from `trading_positions` all along. It was simply never computed,
// which is why "what fraction of maker entries actually fill" stayed an open question while
// the entire cost model depended on the answer.
let makerFillCache: {
  stats: Record<Exchange, { rested: number; filled: number }>;
  expires: number;
} | null = null;
async function loadMakerFillStats(exchange: Exchange): Promise<{ rested: number; filled: number }> {
  if (makerFillCache && makerFillCache.expires > Date.now()) {
    return makerFillCache.stats[exchange];
  }
  const stats: Record<Exchange, { rested: number; filled: number }> = {
    upbit: { rested: 0, filled: 0 },
    binance: { rested: 0, filled: 0 },
    binance_futures: { rested: 0, filled: 0 },
  };
  try {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rows = await db(
      `trading_positions?created_at=gte.${since}&is_paper=eq.false&select=exchange,state,close_reason,opened_at,metadata&limit=5000`,
    );
    for (const row of rows || []) {
      if (!row?.metadata?.maker_entry_placed_at) continue;
      const venue = String(row.exchange) as Exchange;
      if (!(venue in stats)) continue;
      stats[venue].rested++;
      const reason = String(row.close_reason || "");
      const unfilled = reason === "MAKER_ENTRY_UNFILLED" || reason === "MAKER_ENTRY_DRIFTED";
      if (!unfilled && row.opened_at) stats[venue].filled++;
    }
  } catch {
    // Unreadable: report zero samples, which the policy treats as "not yet measured".
  }
  makerFillCache = { stats, expires: Date.now() + 300_000 };
  return stats[exchange];
}

// v5.3: active pWin calibration, loaded once per cycle. Falls back to the identity, so a
// missing table or a failed read can never change trading behavior.
let calibrationCache: { model: CalibrationModel; expires: number } | null = null;
async function loadScalpCalibration(): Promise<CalibrationModel> {
  if (calibrationCache && calibrationCache.expires > Date.now()) return calibrationCache.model;
  let model: CalibrationModel = { ...IDENTITY_CALIBRATION };
  try {
    const rows = await db(
      "scalp_calibration_profiles?active=eq.true&select=slope,intercept,train_samples&limit=1",
    );
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

// v6.4: the return type carries "we could not read the book" as a distinct value.
// Returning an empty Map on failure was indistinguishable from "we hold no orders",
// so one failed open_orders call made every bot-placed resting sell look like a user
// lock — the exact false positive that halted LTC.
async function botLockedQuantities(
  exchange: Exchange,
  positions: Position[],
): Promise<Map<string, number> | null> {
  const locked = new Map<string, number>();
  try {
    const rows = await gateway(exchange, { action: "open_orders" });
    const ours = new Set(
      ((await db(
        `trading_orders?exchange=eq.${exchange}&state=in.(REQUESTED,ACCEPTED,OPEN,PARTIAL,APPLIED)&select=identifier`,
      ).catch(() => [])) as any[])
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
        finite(
          raw.remaining_volume,
          Math.max(
            0,
            finite(raw.origQty, finite(raw.volume)) -
              finite(raw.executedQty, finite(raw.executed_volume)),
          ),
        ),
      );
      if (!(remaining > 0)) continue;
      const market = String(row?.market ?? raw.market ?? raw.symbol ?? "");
      const asset = baseAsset(exchange, market) ||
        positions.find((p) => p.market === market)?.base_asset || "";
      if (!asset) continue;
      locked.set(asset, (locked.get(asset) || 0) + remaining);
    }
  } catch {
    // Unreadable open orders must not be treated as evidence of anything. `null` says
    // "unknown"; an empty Map would say "we definitely hold no orders", which is a claim
    // we cannot make when the request failed.
    return null;
  }
  return locked;
}

async function reconcileFeeLedger(cycleId: string) {
  const due = new Date().toISOString();
  const rows = await db(
    `trading_orders?state=eq.APPLIED&executed_funds_quote=gt.0&fee_accounting_quality=in.(ESTIMATED,MISSING,LEGACY_UNVERIFIED)&or=(fee_reconcile_next_at.is.null,fee_reconcile_next_at.lte.${
      encodeURIComponent(due)
    })&select=*&order=completed_at.desc&limit=12`,
  ).catch(() => []) as any[];
  const results: any[] = [];
  for (const row of rows) {
    const attempts = Math.max(0, Math.floor(finite(row.fee_reconcile_attempts)));
    try {
      const order = await gateway(row.exchange as Exchange, {
        action: "get_order",
        identifier: row.identifier,
        market: row.market,
      });
      const updated = await updateOrderFromGateway(row, order);
      const quality = String(updated.row?.fee_accounting_quality || "");
      const exact = ["EXACT", "AGGREGATE_EXACT", "THIRD_ASSET_MARKED", "BASE_ASSET_ACCOUNTED"]
        .includes(quality);
      await patch("trading_orders", `id=eq.${row.id}`, {
        fee_reconcile_attempts: attempts + 1,
        fee_reconcile_next_at: exact
          ? null
          : new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, attempts)))
            .toISOString(),
        fee_reconciled_at: exact ? new Date().toISOString() : null,
      });
      let recomputed: any = null;
      if (row.position_id) {
        recomputed = await rpc("recompute_position_economic_accounting_v610", {
          p_position_id: row.position_id,
        }).catch(() => null);
        const position = recomputed?.position;
        if (exact && position?.state === "CLOSED" && position?.metadata?.lob_signal) {
          await rpc("learn_lob_trade_outcome", { p_position_id: row.position_id }).catch(() =>
            null
          );
        }
      }
      results.push({ order_id: row.id, quality, exact, recomputed: Boolean(recomputed?.updated) });
    } catch (error) {
      const nextAt = new Date(
        Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, attempts)),
      ).toISOString();
      await patch("trading_orders", `id=eq.${row.id}`, {
        fee_reconcile_attempts: attempts + 1,
        fee_reconcile_next_at: nextAt,
      }).catch(() => null);
      await event(
        "FEE_RECONCILIATION_RETRY",
        `${row.exchange}:${row.market} fee detail remains unresolved`,
        {
          order_id: row.id,
          attempts: attempts + 1,
          next_at: nextAt,
          error: error instanceof Error ? error.message : String(error),
        },
        { cycleId, positionId: row.position_id, orderId: row.id, level: "WARNING" },
      );
    }
  }
  return results;
}

async function recordJointObjectiveSnapshot(
  exchange: Exchange,
  settings: TradingSettings & JsonRecord,
  rawPortfolio: any,
  trackedPositions: Position[],
) {
  const latest = (await db(
    `trading_joint_objective_snapshots?exchange=eq.${exchange}&select=captured_at&order=captured_at.desc&limit=1`,
  ).catch(() => []))[0];
  const latestMs = Date.parse(String(latest?.captured_at || ""));
  if (Number.isFinite(latestMs) && Date.now() - latestMs < 60_000) return null;
  const flowSince = Number.isFinite(latestMs)
    ? new Date(latestMs).toISOString()
    : new Date(0).toISOString();
  const cashFlows = await db(
    `trading_cash_flows?exchange=eq.${exchange}&detected_at=gt.${
      encodeURIComponent(flowSince)
    }&select=flow_type,amount_quote`,
  ).catch(() => []) as any[];
  const externalFlowQuote = cashFlows.reduce((sum, row) => {
    const amount = Math.max(0, finite(row.amount_quote));
    return sum + (String(row.flow_type).toUpperCase() === "EXTERNAL_DECREASE" ? -amount : amount);
  }, 0);
  const managed = await managedPortfolio(settings, exchange, rawPortfolio);
  const dayStart = dayBoundary(exchange);
  const realizedRows = await db(
    `trading_positions?exchange=eq.${exchange}&is_paper=eq.${
      settings.mode !== "LIVE_LIMITED"
    }&state=eq.CLOSED&closed_at=gte.${encodeURIComponent(dayStart)}&select=realized_pnl_quote`,
  ).catch(() => []) as any[];
  const realizedDaily = realizedRows.reduce(
    (sum, row) => sum + finite(row.realized_pnl_quote),
    0,
  );
  const markedOpen = trackedPositions.reduce((sum, row) => {
    if (row.state === "ENTRY_PENDING" || finite(row.remaining_quantity) <= 0) return sum;
    const entry = Math.max(0, finite(row.average_entry_price, row.planned_entry_price));
    const current = Math.max(0, finite(rawPortfolio?.prices?.[row.market], entry));
    return sum + calculateExposureLedger({
      state: row.state,
      initialQuantity: row.initial_quantity,
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
      estimatedExitCostPct: FEE_PCT[exchange] / 100,
    }).markedNetPnlQuote;
  }, 0);
  return (await insert("trading_joint_objective_snapshots", {
    exchange,
    total_equity_quote: Math.max(0, finite(rawPortfolio?.total_equity_quote)),
    managed_capital_quote: Math.max(0, finite(managed?.managed?.managedCapitalQuote)),
    managed_available_quote: Math.max(0, finite(managed?.managed?.managedAvailableQuote)),
    filled_exposure_quote: Math.max(
      0,
      finite(managed?.managed?.openCostQuote) - finite(managed?.managed?.reservedExposureQuote),
    ),
    reserved_exposure_quote: Math.max(0, finite(managed?.managed?.reservedExposureQuote)),
    residual_inventory_value_quote: Math.max(
      0,
      finite(managed?.managed?.residualInventoryValueQuote),
    ),
    marked_open_pnl_quote: markedOpen,
    realized_daily_pnl_quote: realizedDaily,
    external_flow_quote: finite(externalFlowQuote),
    engine_version: VERSION,
    metadata: {
      strategy: (settings as any).strategy,
      max_strategy_exposure_pct: finite((settings as any).scalp_max_strategy_exposure_pct, 100),
    },
  }))[0];
}

async function openOrderAssets(exchange: Exchange): Promise<Set<string> | null> {
  try {
    const rows = await gateway(exchange, { action: "open_orders" });
    const assets = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const raw = row?.raw || {};
      const market = String(row?.market ?? raw.market ?? raw.symbol ?? "");
      const asset = baseAsset(exchange, market);
      if (asset) assets.add(asset.toUpperCase());
    }
    return assets;
  } catch {
    return null;
  }
}

async function reconcilePersistedAssetLocks(
  exchange: Exchange,
  portfolio: any,
  activePositions: Position[],
  orderAssets: Set<string> | null,
  cycleId: string,
) {
  const locks = await db(
    `trading_asset_locks?exchange=eq.${exchange}&state=eq.LOCKED&select=asset,reason,clean_checks`,
  ).catch(() => []) as any[];
  if (!locks.length) return;
  const activeAssets = new Set(
    activePositions.map((row) => String(row.base_asset || "").toUpperCase()),
  );
  // Futures contracts are positions, never residual wallet inventory. Keeping this map
  // empty prevents a legacy row from influencing futures asset-lock reconciliation.
  const residualRows = exchange === "binance_futures" ? [] : await db(
    `trading_residual_inventory?exchange=eq.${exchange}&state=in.(AVAILABLE,RESERVED_FOR_REENTRY)&select=asset,remaining_quantity`,
  ).catch(() => []) as any[];
  const residual = new Map<string, number>();
  for (const row of residualRows) {
    const asset = String(row.asset || "").toUpperCase();
    residual.set(asset, (residual.get(asset) || 0) + Math.max(0, finite(row.remaining_quantity)));
  }
  const balances = new Map<string, number>();
  for (const row of Array.isArray(portfolio?.accounts) ? portfolio.accounts : []) {
    const asset = String(row.currency || row.asset || "").toUpperCase();
    balances.set(
      asset,
      Math.max(0, finite(row.balance ?? row.free)) + Math.max(0, finite(row.locked)),
    );
  }
  for (const lock of locks) {
    const asset = String(lock.asset || "").toUpperCase();
    if (orderAssets === null) {
      await rpc("record_asset_lock_check_v610", {
        p_exchange: exchange,
        p_asset: asset,
        p_status: "QUERY_FAILED",
        p_reason: "OPEN_ORDERS_UNREADABLE",
        p_metadata: { cycle_id: cycleId },
      }).catch(() => null);
      continue;
    }
    const accountQty = balances.get(asset) || 0;
    const residualQty = residual.get(asset) || 0;
    const quantityTolerance = Math.max(1e-12, residualQty * 0.005);
    const clean = !activeAssets.has(asset) && !orderAssets.has(asset) &&
      accountQty <= residualQty + quantityTolerance;
    await rpc("record_asset_lock_check_v610", {
      p_exchange: exchange,
      p_asset: asset,
      p_status: clean ? "CLEAN" : "MISMATCH",
      p_reason: clean
        ? "NO_ACTIVE_POSITION_ORDER_OR_UNEXPLAINED_BALANCE"
        : "LOCK_CONDITION_STILL_PRESENT",
      p_metadata: {
        cycle_id: cycleId,
        account_quantity: accountQty,
        residual_quantity: residualQty,
      },
    }).catch(() => null);
  }
}

async function sweepResidualInventory(
  exchange: Exchange,
  settings: TradingSettings & JsonRecord,
  activePositions: Position[],
  orderAssets: Set<string> | null,
  cycleId: string,
) {
  // Spot fees can leave physical base-asset dust. USDⓈ-M positions are contracts; a
  // position-less residual SELL could reduce an unrelated live long on the same symbol.
  if (exchange === "binance_futures") return [];
  if (
    settings.mode !== "LIVE_LIMITED" ||
    (settings as any).residual_sweep_enabled === false ||
    orderAssets === null
  ) return [];
  const rows = await db(
    `trading_residual_inventory?exchange=eq.${exchange}&state=eq.AVAILABLE&remaining_quantity=gt.0&select=*&order=updated_at.asc`,
  ).catch(() => []) as any[];
  const actions: any[] = [];
  const activeAssets = new Set(
    activePositions.map((row) => String(row.base_asset || "").toUpperCase()),
  );
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = `${String(row.asset || "").toUpperCase()}|${
      String(row.market || "").toUpperCase()
    }`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const asset = String(first.asset || "").toUpperCase();
    const market = String(first.market || "").toUpperCase();
    // Keep BNB available for Binance commission payment.
    if (exchange === "binance" && asset === "BNB") continue;
    const planned = await db(
      `scanner_candidates?exchange=eq.${exchange}&market=eq.${
        encodeURIComponent(market)
      }&decision=eq.BUY&created_at=gte.${
        encodeURIComponent(new Date(Date.now() - 300_000).toISOString())
      }&select=id&limit=1`,
    ).catch(() => []);
    let quote: any;
    try {
      quote = await marketQuote(exchange, market);
    } catch {
      continue;
    }
    const price = Math.max(0, finite(quote?.best_bid, quote?.current));
    const totalQuantity = group.reduce(
      (sum, row) => sum + Math.max(0, finite(row.remaining_quantity)),
      0,
    );
    const minOrder = exchange === "upbit"
      ? finite(settings.min_order_krw, 5000)
      : binanceMinOrderUsdt(settings.min_order_usdt);
    const decision = residualSweepDecision({
      quantity: totalQuantity,
      markPrice: price,
      minOrderQuote: minOrder,
      activePosition: activeAssets.has(asset),
      openOrder: orderAssets.has(asset),
      plannedReentry: planned.length > 0,
      sweepBuffer: finite((settings as any).residual_sweep_buffer, 1.10),
    });
    if (!decision.allowed) continue;
    const identifier = uniqueId("rs", String(first.position_id));
    const orderRow = await createOrderRecord({
      position_id: null,
      candidate_id: null,
      cycle_id: cycleId,
      decision_id: null,
      exchange,
      quote_currency: quoteCurrency(exchange),
      identifier,
      market,
      side: "SELL",
      purpose: "RESIDUAL_SWEEP",
      order_type: "MARKET",
      requested_volume: totalQuantity,
      requested_notional_quote: decision.valueQuote,
      state: "REQUESTED",
    });
    for (const row of group) {
      await patch("trading_residual_inventory", `position_id=eq.${row.position_id}`, {
        state: "SWEEP_PENDING",
        sweep_order_id: orderRow.id,
        updated_at: new Date().toISOString(),
      });
    }
    try {
      const result = await gateway(exchange, {
        action: "create_order",
        order: { market, side: "SELL", type: "MARKET", quantity: totalQuantity, identifier },
        wait_for_final_ms: 4000,
      }, 20_000);
      const updated = await updateOrderFromGateway(orderRow, result);
      const sold = Math.max(0, finite(updated.fill.executedVolume));
      const baseFee = Math.max(0, finite(updated.fill.paidFeeBase));
      const proceeds = Math.max(0, finite(updated.fill.executedFunds));
      const quoteFee = Math.max(0, finite(updated.fill.paidFeeQuote));
      let soldLeft = sold;
      let baseFeeLeft = baseFee;
      let allocatedProceeds = 0;
      let allocatedQuoteFee = 0;
      for (let index = 0; index < group.length; index++) {
        const row = group[index];
        const before = Math.max(0, finite(row.remaining_quantity));
        const soldFromRow = Math.min(before, soldLeft);
        soldLeft -= soldFromRow;
        const afterSale = Math.max(0, before - soldFromRow);
        const baseFeeFromRow = Math.min(afterSale, baseFeeLeft);
        baseFeeLeft -= baseFeeFromRow;
        const remaining = Math.max(0, afterSale - baseFeeFromRow);
        const isLastSoldAllocation = index === group.length - 1 || soldLeft <= 1e-12;
        const proceedsShare = sold > 0
          ? isLastSoldAllocation
            ? Math.max(0, proceeds - allocatedProceeds)
            : proceeds * soldFromRow / sold
          : 0;
        const feeShare = sold > 0
          ? isLastSoldAllocation
            ? Math.max(0, quoteFee - allocatedQuoteFee)
            : quoteFee * soldFromRow / sold
          : 0;
        allocatedProceeds += proceedsShare;
        allocatedQuoteFee += feeShare;
        const cumulativeProceeds = Math.max(0, finite(row.realized_proceeds_quote)) + proceedsShare;
        const cumulativeFees = Math.max(0, finite(row.paid_fees_quote)) + feeShare;
        const cumulativeBaseFee = Math.max(0, finite(row.paid_fee_base_quantity)) + baseFeeFromRow;
        const originalMarkValue = Math.max(0, finite(row.original_quantity)) *
          Math.max(0, finite(row.mark_price));
        const residualPnl = cumulativeProceeds - cumulativeFees + remaining * price -
          originalMarkValue;
        await patch("trading_residual_inventory", `position_id=eq.${row.position_id}`, {
          remaining_quantity: remaining,
          swept_quantity: Math.max(0, finite(row.swept_quantity)) + soldFromRow,
          realized_proceeds_quote: cumulativeProceeds,
          paid_fees_quote: cumulativeFees,
          paid_fee_base_quantity: cumulativeBaseFee,
          value_quote: remaining * price,
          residual_pnl_quote: residualPnl,
          state: remaining <= 1e-12 ? "SWEPT" : "AVAILABLE",
          updated_at: new Date().toISOString(),
        });
      }
      actions.push({
        asset,
        market,
        sold,
        base_fee_quantity: baseFee,
        proceeds_quote: proceeds,
        fee_quote: quoteFee,
        remaining: Math.max(0, totalQuantity - sold - baseFee),
        source_positions: group.length,
        order_id: orderRow.id,
      });
    } catch (error) {
      for (const row of group) {
        await patch("trading_residual_inventory", `position_id=eq.${row.position_id}`, {
          state: "AVAILABLE",
          sweep_order_id: null,
          updated_at: new Date().toISOString(),
        });
      }
      await event("RESIDUAL_SWEEP_FAILED", `${exchange}:${asset} residual sweep failed`, {
        error: error instanceof Error ? error.message : String(error),
        source_positions: group.length,
      }, { cycleId, orderId: orderRow.id, level: "WARNING" });
    }
  }
  return actions;
}

function scalpHoldConfig(settings: TradingSettings, exchange: Exchange): ScalpHoldConfig {
  return resolveHoldConfig({
    alphaHalfLifeMinutes: finite((settings as any).scalp_hold_alpha_half_life_minutes, 12),
    reversalImbalance: finite((settings as any).scalp_hold_reversal_imbalance, -0.25),
    reversalTradePressure: finite((settings as any).scalp_hold_reversal_trade_pressure, -0.30),
    maxSpreadBps: finite((settings as any).scalp_hold_max_spread_bps, 40),
    minBidDepthRatio: finite((settings as any).scalp_hold_min_bid_depth_ratio, 0.35),
    reversalConfirmations: finite((settings as any).scalp_hold_reversal_confirmations, 2),
    staleDataMinutes: finite((settings as any).scalp_stale_data_minutes, 30),
    // One side only: the entry leg is sunk cost and must not be charged again.
    exitCostFraction: FEE_PCT[exchange] / 100 +
      finite((settings as any).scalp_slippage_allowance, 0.0009) / 2,
  });
}

function restingTpEnabled(settings: TradingSettings, position: Position): boolean {
  const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
  const heldSeconds = Number.isFinite(openedAt) ? Math.max(0, (Date.now() - openedAt) / 1000) : 0;
  // Spot holdings can be locked by a resting sell. A futures contract is not inventory,
  // and every exit must pass through the leverage-aware split policy instead.
  return position.exchange !== "binance_futures" &&
    isScalpStrategy((settings as any).strategy) &&
    !isLobStrategy((settings as any).strategy) &&
    (settings as any).scalp_resting_tp === true &&
    !position.is_paper &&
    heldSeconds >= 60;
}

function restingTpIdentifier(position: Position): string | null {
  const id = position.metadata?.tp_identifier;
  return typeof id === "string" && id ? id : null;
}

async function unappliedBotSellOrders(position: Position): Promise<any[]> {
  const rows = await db(
    `trading_orders?position_id=eq.${position.id}&side=eq.SELL&select=*&order=created_at.desc&limit=12`,
  ).catch(() => []) as any[];
  return rows.filter((row) =>
    pendingBotExitMayExplainBalanceReduction([{
      side: row.side,
      purpose: row.purpose,
      state: row.state,
      executedVolume: row.executed_volume,
    }])
  );
}

async function unappliedRestingTpOrder(position: Position): Promise<any | null> {
  const rows = await unappliedBotSellOrders(position);
  const metadataOrderId = String(position.metadata?.tp_order_id || "");
  return rows.find((row) => metadataOrderId && String(row.id) === metadataOrderId) ||
    rows.find((row) => String(row.purpose).toUpperCase() === "TARGET_1") ||
    null;
}

/** Place the first-target limit sell immediately after the entry fill is booked. */
async function placeRestingTakeProfit(
  position: Position,
  settings: TradingSettings,
  cycleId: string,
): Promise<Position> {
  if (!restingTpEnabled(settings, position) || restingTpIdentifier(position)) return position;
  const target = finite(position.target_1);
  const step = finite(position.quantity_step, 0.00000001);
  const remaining = finite(position.remaining_quantity);
  if (!(target > 0 && remaining > 0)) return position;
  const qty = floorToStep(
    t1SellQuantity(
      finite(position.initial_quantity),
      remaining,
      finite(position.t1_allocation_pct, 60),
    ),
    step,
  );
  const minNotional = positionMinNotionalQuote(position);
  // Both the TP slice AND the remainder must clear the exchange minimum, otherwise the
  // runner becomes un-sellable dust. If they cannot, fall back to the polling exit path.
  if (!(qty > 0) || qty * target < minNotional || (remaining - qty) * target < minNotional) {
    await event(
      "TP_REST_SKIPPED",
      `${position.exchange}:${position.market} resting TP below exchange minimum`,
      { qty, target, minNotional },
      { cycleId, positionId: position.id },
    );
    return position;
  }
  const identifier = uniqueId("tp", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id,
    candidate_id: position.candidate_id,
    cycle_id: cycleId,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier,
    market: position.market,
    side: "SELL",
    purpose: "TARGET_1",
    order_type: "LIMIT",
    time_in_force: position.exchange === "binance" ? "GTC" : null,
    requested_price: target,
    requested_volume: qty,
    requested_notional_quote: qty * target,
    state: "REQUESTED",
  });
  try {
    const result = await gateway(position.exchange, {
      action: "create_order",
      order: {
        market: position.market,
        side: "SELL",
        type: "LIMIT",
        price: target,
        quantity: qty,
        identifier,
        // Upbit rests plain limit orders by default and only accepts ioc/fok here, so the
        // field is omitted. The Binance path defaults to IOC when unset, so GTC is explicit.
        ...(position.exchange === "binance" ? { time_in_force: "GTC" } : {}),
      },
      wait_for_final_ms: 0,
    }, 20_000);
    await updateOrderFromGateway(orderRow, result);
    const updated = await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: {
        ...(position.metadata || {}),
        tp_identifier: identifier,
        tp_order_id: orderRow.id,
        tp_price: target,
        tp_quantity: qty,
        tp_placed_at: new Date().toISOString(),
      },
    });
    await event("TP_RESTED", `${position.exchange}:${position.market} resting take-profit placed`, {
      price: target,
      quantity: qty,
      identifier,
    }, { cycleId, positionId: position.id, orderId: orderRow.id });
    return { ...position, ...(updated[0] || {}) } as Position;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patch("trading_orders", `id=eq.${orderRow.id}`, {
      state: "REJECTED",
      error_message: message,
      completed_at: new Date().toISOString(),
    });
    // Non-fatal: the position simply keeps the v5.2.5 polling exit behavior.
    await event(
      "TP_REST_FAILED",
      `${position.exchange}:${position.market} resting take-profit rejected`,
      { error: message },
      { cycleId, positionId: position.id, level: "WARNING" },
    );
    return position;
  }
}

/** Book a resting TP that has reached a terminal state. Returns the refreshed position. */
async function settleRestingTakeProfit(
  position: Position,
  order: any,
  cycleId: string,
  knownOrderRow?: any,
): Promise<Position> {
  const orderRow = knownOrderRow ||
    (await db(`trading_orders?id=eq.${position.metadata?.tp_order_id}&select=*&limit=1`))[0];
  if (!orderRow) return position;
  const updated = await updateOrderFromGateway(orderRow, order);
  const settledMeta = {
    tp_identifier: null,
    tp_order_id: null,
    tp_settled_at: new Date().toISOString(),
  };
  if (finite(updated.fill.executedVolume) > 0) {
    const result = await finalizeExitFill(
      position,
      { orderRow: updated.row, ...updated },
      "TARGET_1",
      finite(position.target_1),
      cycleId,
    );
    const next = (result as any)?.position || position;
    const rows = await patch("trading_positions", `id=eq.${next.id}`, {
      metadata: { ...(next.metadata || {}), ...settledMeta },
    });
    return { ...next, ...(rows[0] || {}) } as Position;
  }
  const rows = await patch("trading_positions", `id=eq.${position.id}`, {
    metadata: { ...(position.metadata || {}), ...settledMeta },
  });
  return { ...position, ...(rows[0] || {}) } as Position;
}

/** Poll a live resting TP. Books it only once it is terminal. */
async function syncRestingTakeProfit(position: Position, cycleId: string): Promise<Position> {
  const orderRow = await unappliedRestingTpOrder(position);
  if (!orderRow) {
    if (restingTpIdentifier(position)) {
      const rows = await patch("trading_positions", `id=eq.${position.id}`, {
        metadata: {
          ...(position.metadata || {}),
          tp_identifier: null,
          tp_order_id: null,
          tp_reference_cleared_at: new Date().toISOString(),
        },
      });
      return { ...position, ...(rows[0] || {}) } as Position;
    }
    return position;
  }
  const identifier = String(orderRow.identifier || restingTpIdentifier(position) || "");
  if (!identifier) return position;
  if (
    restingTpIdentifier(position) !== identifier ||
    String(position.metadata?.tp_order_id || "") !== String(orderRow.id)
  ) {
    const rows = await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: {
        ...(position.metadata || {}),
        tp_identifier: identifier,
        tp_order_id: orderRow.id,
        tp_reference_recovered_at: new Date().toISOString(),
      },
    });
    position = { ...position, ...(rows[0] || {}) } as Position;
    await event(
      "TP_REFERENCE_RECOVERED",
      `${position.exchange}:${position.market} resting TP reference recovered from order ledger`,
      { identifier, order_id: orderRow.id, order_state: orderRow.state },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" },
    );
  }
  let order: any;
  try {
    order = await gateway(position.exchange, {
      action: "get_order",
      identifier,
      market: position.market,
    });
  } catch (error) {
    // Transport failure: leave the order in place and retry next cycle. Never assume it
    // is gone — assuming that and re-selling is how duplicate exits happen.
    await event(
      "TP_SYNC_ERROR",
      `${position.exchange}:${position.market} resting TP query failed`,
      { error: error instanceof Error ? error.message : String(error) },
      { cycleId, positionId: position.id, level: "WARNING" },
    );
    return position;
  }
  const status = String(order?.status || order?.order?.status || "");
  if (!TP_TERMINAL_STATUSES.includes(status)) {
    await updateOrderFromGateway(orderRow, order);
    return position;
  }
  return settleRestingTakeProfit(position, order, cycleId, orderRow);
}

/**
 * Cancel the resting TP and confirm it is terminal before any market exit.
 * Returns false when the caller must NOT proceed to sell this cycle.
 */
async function cancelRestingTakeProfit(
  position: Position,
  cycleId: string,
): Promise<{ ok: boolean; position: Position }> {
  const identifier = restingTpIdentifier(position);
  if (!identifier) return { ok: true, position };
  let terminal: any = null;
  for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
    try {
      const result = attempt === 0
        ? await gateway(position.exchange, {
          action: "cancel_order",
          identifier,
          market: position.market,
        })
        : await gateway(position.exchange, {
          action: "get_order",
          identifier,
          market: position.market,
        });
      const status = String(result?.status || result?.order?.status || "");
      if (TP_TERMINAL_STATUSES.includes(status)) terminal = result;
    } catch (error) {
      // A cancel can legitimately fail because the order already filled; the follow-up
      // get_order resolves which case this is.
      await event(
        "TP_CANCEL_RETRY",
        `${position.exchange}:${position.market} resting TP cancel attempt failed`,
        { attempt, error: error instanceof Error ? error.message : String(error) },
        { cycleId, positionId: position.id, level: "WARNING" },
      );
    }
  }
  if (!terminal) {
    await event(
      "TP_CANCEL_UNRESOLVED",
      `${position.exchange}:${position.market} resting TP not confirmed cancelled; exit deferred`,
      { identifier },
      { cycleId, positionId: position.id, level: "CRITICAL" },
    );
    return { ok: false, position };
  }
  return { ok: true, position: await settleRestingTakeProfit(position, terminal, cycleId) };
}

// =====================================================================================
// v5.5: maker entry
// =====================================================================================
//
// v5.2.5 through v5.4 entered with a LIMIT IOC priced at the ask — a taker order in all
// but name. Combined with the MARKET exit, every round trip paid the spread twice, so the
// true cost was `fees + spread` rather than `fees`. On Upbit that is 0.17% against a 0.10%
// fee schedule; the nine live trades of 2026-07-26 had a median absolute price move of
// 0.109%, i.e. smaller than the cost they were paying. Those trades could not have won.
//
// Posting on the bid inverts the sign of the spread term: cost becomes `fees - spread`.
// Because Upbit and Binance price makers and takers identically, that swing IS the entire
// improvement, and it is larger than anything available from signal tuning.
//
// It also raises the realized win rate. Entering one spread lower puts the target one
// spread closer and the stop one spread further, measured from where the market actually
// trades. For a 0.6%/0.3% barrier pair at a 0.05% spread the neutral win rate moves from
// 33.3% to 38.9% on the entry leg alone, and the resting take-profit repeats the effect
// on the exit leg.
//
// The cost is fill uncertainty. An unfilled maker entry costs nothing but an opportunity,
// so the order is simply abandoned when it goes stale or the book walks away.

function makerEntryEnabled(settings: TradingSettings, exchange: Exchange): boolean {
  // A resting futures BUY can partially fill below 40 USDT of posted margin. Futures
  // entries therefore use the atomic FOK path; spot maker behavior is unchanged.
  if (exchange === "binance_futures") return false;
  return isScalpStrategy((settings as any).strategy) &&
    (settings as any).scalp_maker_entry !== false &&
    settings.mode === "LIVE_LIMITED";
}

/**
 * Price a resting bid. Never above the best bid: on Binance a crossing LIMIT_MAKER is
 * rejected outright, and on Upbit — which has no post-only flag — pricing at or below the
 * best bid is the only thing that guarantees the order rests instead of taking.
 */
export function makerBidPrice(bestBid: number, tick: number): number {
  const t = tick > 0 ? tick : Math.max(1e-8, bestBid * 1e-6);
  return Math.floor(bestBid / t) * t;
}

/** Has the book moved far enough that this resting bid is no longer competitive? */
export function makerEntryStale(
  restingPrice: number,
  bestBid: number,
  tick: number,
  driftTicks: number,
): boolean {
  if (!(restingPrice > 0 && bestBid > 0)) return true;
  const t = tick > 0 ? tick : Math.max(1e-8, bestBid * 1e-6);
  // Only downward drift matters: if the bid rises we are deep in the queue and unlikely
  // to fill; if it falls, our order is near the front and worth keeping.
  return (bestBid - restingPrice) / t >= driftTicks;
}

/**
 * Resolve a resting entry. Returns whether the position is still awaiting fill.
 * Booked exactly once, at a terminal state, for the same reason as the resting exit.
 */
async function syncMakerEntry(position: Position, settings: TradingSettings, cycleId: string) {
  const identifier = String(position.metadata?.maker_entry_identifier || "");
  const orderRowId = position.metadata?.maker_entry_order_id;
  if (!identifier || !orderRowId) return { pending: false, position };

  let order: any;
  try {
    order = await gateway(position.exchange, {
      action: "get_order",
      identifier,
      market: position.market,
    });
  } catch (error) {
    await event(
      "MAKER_ENTRY_SYNC_ERROR",
      `${position.exchange}:${position.market} resting entry query failed`,
      { error: error instanceof Error ? error.message : String(error) },
      { cycleId, positionId: position.id, level: "WARNING" },
    );
    throw error;
  }
  const status = String(order?.status || "");
  const orderRow = (await db(`trading_orders?id=eq.${orderRowId}&select=*&limit=1`))[0];
  if (!orderRow) return { pending: false, position };

  const placedAt = Date.parse(String(position.metadata?.maker_entry_placed_at || ""));
  const ageSeconds = Number.isFinite(placedAt)
    ? (Date.now() - placedAt) / 1000
    : Number.POSITIVE_INFINITY;
  const ttl = clamp(
    finite(
      (settings as any).scalp_maker_entry_ttl_seconds,
      isLobStrategy((settings as any).strategy) ? 8 : 90,
    ),
    5,
    900,
  );

  let drifted = false;
  if (status === "OPEN" || status === "PARTIALLY_FILLED") {
    try {
      const market = await marketQuote(position.exchange, position.market);
      drifted = makerEntryStale(
        finite(position.metadata?.maker_entry_price),
        finite(market.best_bid),
        finite(position.tick_size),
        clamp(
          finite(
            (settings as any).scalp_maker_entry_drift_ticks,
            isLobStrategy((settings as any).strategy) ? 1 : 3,
          ),
          1,
          50,
        ),
      );
    } catch { /* quote unavailable: fall back to the TTL alone */ }
  }

  const expired = ageSeconds >= ttl || drifted;
  if ((status === "OPEN" || status === "PARTIALLY_FILLED") && !expired) {
    const pendingUpdate = await updateOrderFromGateway(orderRow, order);
    const reservation = reservationAfterFill(
      finite(orderRow.requested_notional_quote, finite(position.reserved_quote)),
      finite(orderRow.requested_volume, finite(position.reserved_quantity)),
      finite(pendingUpdate.fill.executedFunds),
      finite(pendingUpdate.fill.executedVolume),
    );
    const rows = await patch("trading_positions", `id=eq.${position.id}`, {
      reserved_quote: reservation.reservedQuote,
      reserved_quantity: reservation.reservedQuantity,
      reservation_expires_at: new Date(placedAt + ttl * 1000).toISOString(),
    });
    return { pending: true, position: { ...position, ...(rows[0] || {}) } };
  }

  // Terminal, stale or drifted: stop the order so the fill amount is final.
  if (status === "OPEN" || status === "PARTIALLY_FILLED") {
    try {
      order = await gateway(position.exchange, {
        action: "cancel_order",
        identifier,
        market: position.market,
      });
    } catch {
      try {
        order = await gateway(position.exchange, {
          action: "get_order",
          identifier,
          market: position.market,
        });
      } catch (error) {
        // Unresolved: never abandon an order that might still be live. Escalate through
        // the reconciliation state machine instead of silently polling forever.
        throw error;
      }
    }
  }

  const updated = await updateOrderFromGateway(orderRow, order);
  const filled = finite(updated.fill.executedVolume);
  const minNotional = positionMinNotionalQuote(position);
  const reportedPrice = finite(updated.fill.averagePrice);
  const reportedFunds = finite(updated.fill.executedFunds);
  const fillPrice = reportedPrice > 0
    ? reportedPrice
    : filled > 0 && reportedFunds > 0
    ? reportedFunds / filled
    : finite(position.planned_entry_price);
  const resolvedFill = {
    ...updated.fill,
    executedVolume: filled,
    averagePrice: fillPrice,
    executedFunds: Math.max(reportedFunds, filled * Math.max(0, fillPrice)),
  };

  if (filled > 0 && filled * fillPrice >= minNotional) {
    const opened = await applyEntryAccounting(position, updated.row, resolvedFill);
    await event(
      "MAKER_ENTRY_FILLED",
      `${position.exchange}:${position.market} maker entry filled`,
      {
        price: fillPrice,
        quantity: filled,
        wait_seconds: Math.round(ageSeconds),
        drifted,
        partial: status !== "FILLED",
      },
      { cycleId, positionId: position.id, orderId: updated.row.id },
    );
    const withTp = await placeRestingTakeProfit(opened as Position, settings, cycleId);
    return { pending: false, position: withTp };
  }

  // Nothing usable filled. This is the normal, free outcome of a maker quote.
  await patch("trading_positions", `id=eq.${position.id}`, {
    state: "CANCELLED",
    reserved_quote: 0,
    reserved_quantity: 0,
    reservation_expires_at: null,
    close_reason: drifted ? "MAKER_ENTRY_DRIFTED" : "MAKER_ENTRY_UNFILLED",
    closed_at: new Date().toISOString(),
    metadata: {
      ...(position.metadata || {}),
      exclude_from_learning: true,
      maker_entry_wait_seconds: Math.round(ageSeconds),
      maker_entry_filled: filled,
    },
  });
  await event(
    "MAKER_ENTRY_UNFILLED",
    `${position.exchange}:${position.market} resting entry expired without a usable fill`,
    {
      wait_seconds: Math.round(ageSeconds),
      drifted,
      filled_quantity: filled,
    },
    { cycleId, positionId: position.id, level: "INFO" },
  );
  return { pending: false, position };
}

/**
 * v5.9.1: automatic recovery from an INFRASTRUCTURE pause.
 *
 * Legacy recovery for releases that latched a global SAFETY_GATEWAY_UNAVAILABLE pause.
 * v6.11 never creates that automatic pause, but clearing an old one remains necessary
 * during a rolling deployment.
 *
 * The distinction that matters is WHAT failed:
 *   - infrastructure (gateway unreachable)  -> recovers on its own once healthy again
 *   - account (balances do not reconcile)   -> still needs human eyes, never auto-cleared
 *   - operator intent (manual pause, withdrawal mode) -> never auto-cleared
 */
const AUTO_RECOVERABLE_PAUSE_REASONS = ["SAFETY_GATEWAY_UNAVAILABLE"];

async function tryAutoResume(settings: TradingSettings & JsonRecord, cycleId: string) {
  if (!settings.pause_new_entries) return settings;
  const reason = String(settings.manual_event_reason || "");
  if (!AUTO_RECOVERABLE_PAUSE_REASONS.includes(reason)) return settings;
  // An unresolved account discrepancy outranks connectivity recovery.
  if (settings.manual_intervention_required || settings.withdrawal_mode) return settings;

  const healthy = 1 + Math.max(0, Math.floor(finite((settings as any).gateway_recovery_cycles)));
  const required = clamp(finite((settings as any).gateway_recovery_cycles_required, 3), 1, 20);
  if (healthy < required) {
    const rows = await patch("trading_settings", "id=eq.1", { gateway_recovery_cycles: healthy })
      .catch(() => []);
    return { ...settings, ...(rows[0] || { gateway_recovery_cycles: healthy }) };
  }
  const rows = await patch("trading_settings", "id=eq.1", {
    pause_new_entries: false,
    manual_event_reason: null,
    gateway_recovery_cycles: 0,
    gateway_error_count: 0,
    last_resume_at: new Date().toISOString(),
  }).catch(() => []);
  await event(
    "TRADING_AUTO_RESUMED",
    `gateway healthy for ${healthy} consecutive cycles; entries resumed automatically`,
    {
      previous_reason: reason,
      healthy_cycles: healthy,
    },
    { cycleId, level: "WARNING" },
  );
  return { ...settings, ...(rows[0] || {}), pause_new_entries: false, manual_event_reason: null } as
    & TradingSettings
    & JsonRecord;
}

async function snapshotAccount(
  exchange: Exchange,
  portfolio: any,
  positions: Position[],
  prices: Record<string, number>,
  settings: TradingSettings,
  capturedAt?: string,
) {
  let openCost = 0;
  let unrealized = 0;
  const paper = settings.mode !== "LIVE_LIMITED";
  for (
    const position of positions.filter((row) => row.exchange === exchange && row.is_paper === paper)
  ) {
    const qty = finite(position.remaining_quantity);
    const entry = finite(position.average_entry_price);
    const current = finite(prices[position.market], entry);
    const leverage = position.exchange === "binance_futures" ? positionLeverage(position) : 1;
    openCost += qty * entry / leverage;
    unrealized += calculateExposureLedger({
      state: position.state,
      initialQuantity: position.initial_quantity,
      remainingQuantity: position.remaining_quantity,
      averageEntryPrice: position.average_entry_price,
      plannedEntryPrice: position.planned_entry_price,
      currentPrice: current,
      realizedCostQuote: position.realized_cost_quote,
      realizedProceedsQuote: position.realized_proceeds_quote,
      paidFeesQuote: position.paid_fees_quote,
      residualValueQuote: position.residual_value_quote,
      estimatedExitCostPct: FEE_PCT[exchange] / 100,
    }).markedNetPnlQuote;
  }
  const botPositionValue = positions
    .filter((row) => row.exchange === exchange && row.is_paper === paper)
    .reduce(
      (sum, position) =>
        sum +
        Math.max(0, finite(position.remaining_quantity)) *
          Math.max(0, finite(prices[position.market], position.average_entry_price)) /
          (position.exchange === "binance_futures" ? positionLeverage(position) : 1),
      0,
    );
  // Futures margin balance already includes every open position's unrealised PnL. Adding
  // marked contract notional here would inflate account capital by roughly the leverage.
  const capitalBaseQuote = exchange === "binance_futures"
    ? Math.max(0, finite(portfolio.total_equity_quote))
    : Math.max(0, finite(portfolio.available_quote)) +
      Math.max(0, finite(portfolio.locked_quote)) + botPositionValue;
  const config = allocationConfig(settings, exchange);
  const managed = calculateManagedCapital({
    capitalBaseQuote,
    availableQuote: finite(portfolio.available_quote),
    openCostQuote: Math.max(openCost, botPositionValue),
    allocationMode: config.mode === "FIXED" ? "FIXED" : "ALL",
    fixedAllocationQuote: config.fixed,
    reserveQuote: config.reserve,
  });
  const futuresSnapshot = authenticatedFuturesSnapshot(exchange, portfolio);
  await db("trading_account_snapshots", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      exchange,
      quote_currency: quoteCurrency(exchange),
      // This balance was read before exits in the current monitor cycle. Use the read
      // time instead of the later INSERT time so the next cycle attributes intervening
      // bot orders instead of recording them as external cash flow.
      captured_at: capturedAt || new Date().toISOString(),
      total_equity_quote: finite(portfolio.total_equity_quote),
      available_quote: finite(portfolio.available_quote),
      locked_quote: finite(portfolio.locked_quote),
      bot_open_cost_quote: openCost,
      bot_unrealized_pnl_quote: unrealized,
      capital_base_quote: managed.capitalBaseQuote,
      managed_capital_quote: managed.managedCapitalQuote,
      managed_available_quote: managed.managedAvailableQuote,
      protected_reserve_quote: managed.protectedReserveQuote,
      allocation_mode: managed.allocationMode,
      balances: portfolio.accounts || [],
      positions: futuresSnapshot.positions,
      positions_complete: futuresSnapshot.complete,
      positions_revision: futuresSnapshot.complete ? FUTURES_POSITION_SNAPSHOT_REVISION : null,
      prices: { ...(portfolio.prices || {}), ...prices },
    }),
  });
}
async function sellPaper(
  position: Position,
  quantity: number,
  price: number,
  purpose: string,
  cycleId: string,
) {
  const qty = Math.min(position.remaining_quantity, quantity);
  const funds = qty * price;
  const fee = funds * FEE_PCT[position.exchange] / 100;
  const order = await createOrderRecord({
    position_id: position.id,
    candidate_id: position.candidate_id,
    cycle_id: cycleId,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier: uniqueId("px", position.id),
    market: position.market,
    side: "SELL",
    purpose,
    order_type: "PAPER_MARKET",
    requested_volume: qty,
    state: "EXCHANGE_DONE",
    executed_volume: qty,
    average_fill_price: price,
    executed_funds_quote: funds,
    paid_fee_quote: fee,
    fee_asset: position.quote_currency,
    completed_at: new Date().toISOString(),
    raw_response: { paper: true },
  });
  await insert("trading_fills", {
    order_id: order.id,
    trade_id: `paper-${order.id}`,
    price,
    volume: qty,
    funds_quote: funds,
    fee_amount: fee,
    fee_asset: position.quote_currency,
    fee_quote_estimate: fee,
    executed_at: new Date().toISOString(),
    raw: { paper: true },
  });
  return {
    orderRow: order,
    fill: { executedVolume: qty, executedFunds: funds, averagePrice: price, paidFeeQuote: fee },
    order: { status: "FILLED" },
  };
}
type ProtectedTargetQuote = {
  limitPrice: number;
  expectedNetProfitQuote: number;
  availableQuantity: number;
  measuredAt: string;
};

type ProtectedPositiveNetQuote = ProtectedTargetQuote & {
  sellQuantity: number;
  audit: JsonRecord;
};

function positionEntryCostBasis(position: Position): number {
  const persisted = Math.max(0, finite(position.realized_cost_quote));
  const derived = Math.max(0, finite(position.initial_quantity)) *
    Math.max(0, finite(position.average_entry_price, position.planned_entry_price));
  // Spot normally persists exact executed funds; futures reconciliation can leave the
  // field at zero while the live contract is already open. Never let that transient
  // representation turn a real principal into zero cost.
  return Math.max(persisted, derived);
}

function exactUnrecoveredPositionCost(position: Position): number {
  return Math.max(
    0,
    positionEntryCostBasis(position) + finite(position.paid_fees_quote) -
      finite(position.realized_proceeds_quote),
  );
}

function protectedTargetProfitBuffer(position: Position): number {
  return position.exchange === "upbit" ? 1 : 0.01;
}

function post180SlippageSafetyRate(settings: TradingSettings & JsonRecord): number {
  return clamp(
    Math.max(0.0009, finite((settings as any).scalp_slippage_allowance, 0.0009)),
    0,
    0.01,
  );
}

async function paidBuyFeeQuote(position: Position): Promise<number> {
  const rows = await db(
    `trading_orders?position_id=eq.${position.id}&side=eq.BUY&state=in.(APPLIED,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED)&select=paid_fee_quote`,
  ).catch(() => []) as any[];
  const exact = rows.reduce((sum, row) => sum + Math.max(0, finite(row?.paid_fee_quote)), 0);
  return exact > 0 ? exact : Math.max(0, finite(position.paid_fees_quote));
}

function executableNetExitAudit(
  position: Position,
  quote: ExecutableNetExitQuote,
  buyFeeQuote: number,
  measuredAt: string,
): JsonRecord {
  return {
    revision: VERSION,
    price_basis: "FULL_VISIBLE_BID_DEPTH_FOK_FLOOR",
    measured_at: measuredAt,
    allowed: quote.allowed,
    block_reason: quote.allowed ? null : quote.reason,
    sell_price: quote.limitPrice,
    executable_vwap: quote.executableVwap,
    sell_quantity: quote.sellQuantity,
    requested_quantity: quote.requestedQuantity,
    account_available_quantity: quote.availableQuantity,
    visible_executable_quantity: quote.visibleExecutableQuantity,
    expected_gross_proceeds_quote: quote.expectedGrossProceedsQuote,
    protected_gross_proceeds_quote: quote.protectedGrossProceedsQuote,
    buy_principal_quote: quote.buyPrincipalQuote,
    buy_fee_quote: buyFeeQuote,
    already_paid_fees_quote: quote.alreadyPaidFeesQuote,
    prior_sell_proceeds_quote: quote.priorSellProceedsQuote,
    unrecovered_cost_quote: quote.unrecoveredCostQuote,
    expected_sell_fee_quote: quote.expectedSellFeeQuote,
    slippage_safety_quote: quote.slippageSafetyQuote,
    expected_net_profit_quote: Number.isFinite(quote.expectedNetProfitQuote)
      ? quote.expectedNetProfitQuote
      : null,
    order_type: "LIMIT",
    time_in_force: "FOK",
    engine_version: VERSION,
    position_engine_version: position.metadata?.engine_version || null,
  };
}

async function preparePositiveNetAfter180Exit(
  position: Position,
  requestedQuantity: number,
  settings: TradingSettings & JsonRecord,
  cycleId: string,
  blockedEvent = "POSITIVE_NET_AFTER_180S_BLOCKED",
): Promise<ProtectedPositiveNetQuote | null> {
  const [portfolio, market, buyFeeQuote] = await Promise.all([
    gateway(position.exchange, { action: "portfolio" }),
    marketQuote(position.exchange, position.market),
    paidBuyFeeQuote(position),
  ]);
  const availableQuantity = accountQuantity(portfolio, position.base_asset, true);
  const measuredAt = new Date().toISOString();
  const quote = quoteExecutableNetExit({
    bids: (market?.bids || []).map((row: any) => ({
      price: finite(row?.price ?? row?.[0]),
      size: finite(row?.size ?? row?.[1]),
    })),
    requestedQuantity,
    availableQuantity,
    quantityStep: finite(position.quantity_step, 0.00000001),
    buyPrincipalQuote: positionEntryCostBasis(position),
    alreadyPaidFeesQuote: finite(position.paid_fees_quote),
    priorSellProceedsQuote: finite(position.realized_proceeds_quote),
    sellFeeRate: clamp(FEE_PCT[position.exchange] / 100, 0, 0.01),
    slippageSafetyRate: post180SlippageSafetyRate(settings),
  });
  // The guard reads its authority out of exit_policy_quote, and this write replaces the
  // one the monitor cycle made, so the decision has to be carried across the re-quote.
  const audit = orderTimeExitPolicyQuote(
    position.metadata?.exit_policy_quote as JsonRecord | undefined,
    executableNetExitAudit(position, quote, buyFeeQuote, measuredAt),
    quote,
  ) as JsonRecord;
  await patch("trading_positions", `id=eq.${position.id}`, {
    metadata: {
      ...(position.metadata || {}),
      exit_policy_quote: audit,
    },
  });
  if (!quote.allowed) {
    await event(
      blockedEvent,
      `${position.exchange}:${position.market} executable net was not strictly positive`,
      audit,
      { cycleId, positionId: position.id, level: "INFO" },
    );
    return null;
  }
  return {
    limitPrice: quote.limitPrice,
    expectedNetProfitQuote: quote.expectedNetProfitQuote,
    availableQuantity: quote.visibleExecutableQuantity,
    measuredAt,
    sellQuantity: quote.sellQuantity,
    audit,
  };
}

async function prepareLateRecoveryProtectedExit(
  position: Position,
  requestedQuantity: number,
  settings: TradingSettings & JsonRecord,
  cycleId: string,
  decisionReason: "LATE_RECOVERY_NET_POSITIVE_EXIT" | "LATE_RECOVERY_DRAWDOWN_33_EXIT",
): Promise<ProtectedPositiveNetQuote | null> {
  // Re-read the position before the order-time quote. This picks up the trough persisted
  // by the current monitor decision and prevents a stale in-memory object from authorizing
  // a loss exit.
  const rows = await db(
    `trading_positions?id=eq.${position.id}&state=eq.OPEN&select=*&limit=1`,
  ) as Position[];
  const freshPosition = rows[0];
  const block = async (reason: string, audit: JsonRecord = {}) => {
    await event(
      "LATE_RECOVERY_ORDER_TIME_BLOCKED",
      `${position.exchange}:${position.market} ${reason}`,
      { decision_reason: decisionReason, ...audit },
      { cycleId, positionId: position.id, level: "INFO" },
    );
    return null;
  };
  if (!freshPosition) return await block("position is no longer OPEN");

  const openedAt = Date.parse(String(freshPosition.opened_at || freshPosition.created_at || ""));
  const heldSeconds = Number.isFinite(openedAt) ? Math.max(0, (Date.now() - openedAt) / 1000) : 0;
  const absoluteMaxHoldingSeconds = Math.max(
    1,
    finite(
      freshPosition.metadata?.absolute_max_holding_seconds,
      finite((settings as any).lob_absolute_max_holding_seconds, 600),
    ),
  );
  if (
    heldSeconds < LATE_RECOVERY_THRESHOLDS.startSeconds ||
    heldSeconds >= absoluteMaxHoldingSeconds
  ) {
    return await block("outside 460s-to-absolute-max ownership window", {
      held_seconds: heldSeconds,
      absolute_max_holding_seconds: absoluteMaxHoldingSeconds,
    });
  }

  const step = Math.max(0, finite(freshPosition.quantity_step, 0.00000001));
  const tolerance = Math.max(step * 1.001, finite(freshPosition.initial_quantity) * 1e-8, 1e-12);
  const residualStage = freshPosition.exchange === "binance_futures"
    ? freshPosition.t1_completed === true
    : finite(freshPosition.remaining_quantity) <=
      finite(freshPosition.initial_quantity) * 0.5 + tolerance;
  if (residualStage) {
    return await block("earned residual winner remains owned by residual policy");
  }

  const priorLateRecovery = freshPosition.metadata?.late_recovery || {};
  const entryPrice = Math.max(
    0,
    finite(freshPosition.average_entry_price, freshPosition.planned_entry_price),
  );
  const runningTroughPrice = Math.max(
    0,
    finite(priorLateRecovery.post180_running_trough_price),
  );
  if (!(entryPrice > 0 && runningTroughPrice > 0)) {
    return await block("persistent post-180 trough is unavailable", {
      entry_price: entryPrice,
      running_trough_price: runningTroughPrice,
    });
  }

  const [portfolio, market, buyFeeQuote] = await Promise.all([
    gateway(freshPosition.exchange, { action: "portfolio" }),
    marketQuote(freshPosition.exchange, freshPosition.market),
    paidBuyFeeQuote(freshPosition),
  ]);
  const availableQuantity = accountQuantity(portfolio, freshPosition.base_asset, true);
  const quote = quoteExecutableNetExit({
    bids: (market?.bids || []).map((row: any) => ({
      price: finite(row?.price ?? row?.[0]),
      size: finite(row?.size ?? row?.[1]),
    })),
    requestedQuantity,
    availableQuantity,
    quantityStep: finite(freshPosition.quantity_step, 0.00000001),
    buyPrincipalQuote: positionEntryCostBasis(freshPosition),
    alreadyPaidFeesQuote: finite(freshPosition.paid_fees_quote),
    priorSellProceedsQuote: finite(freshPosition.realized_proceeds_quote),
    sellFeeRate: clamp(FEE_PCT[freshPosition.exchange] / 100, 0, 0.01),
    slippageSafetyRate: post180SlippageSafetyRate(settings),
  });
  const measuredAt = new Date().toISOString();
  const expectedQuantity = floorToStep(
    Math.min(finite(freshPosition.remaining_quantity), requestedQuantity),
    Math.max(1e-12, step),
  );
  const fullDepth = quote.sellQuantity > 0 && quote.limitPrice > 0 &&
    Math.abs(quote.sellQuantity - expectedQuantity) <= tolerance &&
    quote.visibleExecutableQuantity + tolerance >= quote.sellQuantity;
  if (!fullDepth) {
    return await block("full executable depth is unavailable", {
      requested_quantity: requestedQuantity,
      expected_quantity: expectedQuantity,
      sell_quantity: quote.sellQuantity,
      visible_executable_quantity: quote.visibleExecutableQuantity,
    });
  }

  // Use the protected FOK LIMIT floor, not the optimistic book VWAP, for the reclaim test.
  // If the price moves before submission, the order cannot fill below this floor.
  const drawdown = entryPrice - runningTroughPrice;
  const recoveryRatio = drawdown > 0
    ? (quote.limitPrice - runningTroughPrice) / drawdown
    : Number.NEGATIVE_INFINITY;
  const expectedNetProfitQuote = quote.expectedNetProfitQuote;
  const eligible = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT"
    ? Number.isFinite(expectedNetProfitQuote) && expectedNetProfitQuote >= 0
    : Number.isFinite(expectedNetProfitQuote) && expectedNetProfitQuote < 0 &&
      drawdown > 0 && recoveryRatio >= LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio;
  if (!eligible) {
    return await block("fresh FOK quote no longer satisfies late-recovery economics", {
      expected_net_profit_quote: Number.isFinite(expectedNetProfitQuote)
        ? expectedNetProfitQuote
        : null,
      entry_price: entryPrice,
      running_trough_price: runningTroughPrice,
      protected_limit_price: quote.limitPrice,
      recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
    });
  }

  const status = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT"
    ? "LATE_RECOVERY_NET_POSITIVE"
    : "LATE_RECOVERY_DRAWDOWN_33";
  const baseAudit = executableNetExitAudit(freshPosition, quote, buyFeeQuote, measuredAt);
  const audit: JsonRecord = {
    ...(freshPosition.metadata?.exit_policy_quote || {}),
    ...baseAudit,
    revision: "7.6.10-LATE-RECOVERY-460-R33",
    late_recovery_revision: "7.6.10-LATE-RECOVERY-460-R33",
    status,
    approval_scope: "SINGLE_FOK_ORDER",
    approved_reason: decisionReason,
    allowed: decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT",
    executable_net_allowed: decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT",
    full_depth: true,
    held_seconds: heldSeconds,
    absolute_max_holding_seconds: absoluteMaxHoldingSeconds,
    entry_price: entryPrice,
    running_trough_price: runningTroughPrice,
    recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
    recovery_ratio_threshold: LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
    sell_price: quote.limitPrice,
    limit_price: quote.limitPrice,
    sell_quantity: quote.sellQuantity,
    expected_net_profit_quote: expectedNetProfitQuote,
    measured_at: measuredAt,
  };
  await patch("trading_positions", `id=eq.${freshPosition.id}`, {
    metadata: {
      ...(freshPosition.metadata || {}),
      exit_policy_quote: audit,
      late_recovery: {
        ...(priorLateRecovery || {}),
        last_order_time_recheck_at: measuredAt,
        last_order_time_limit_price: quote.limitPrice,
        last_order_time_expected_net_profit_quote: expectedNetProfitQuote,
        last_order_time_recovery_ratio: Number.isFinite(recoveryRatio) ? recoveryRatio : null,
      },
    },
  });
  return {
    limitPrice: quote.limitPrice,
    expectedNetProfitQuote,
    availableQuantity: quote.visibleExecutableQuantity,
    measuredAt,
    sellQuantity: quote.sellQuantity,
    audit,
  };
}

async function prepareProtectedTarget(
  position: Position,
  quantity: number,
  purpose: string,
  cycleId: string,
): Promise<ProtectedTargetQuote | null> {
  const quote = await marketQuote(position.exchange, position.market);
  const feeRate = clamp(FEE_PCT[position.exchange] / 100, 0, 0.01);
  const cost = exactUnrecoveredPositionCost(position);
  const profitBuffer = protectedTargetProfitBuffer(position);
  const tick = Math.max(0.000000000001, finite(position.tick_size, 0.00000001));
  const plannedTarget = purpose === "TARGET_2"
    ? Math.max(finite(position.target_2), finite(position.target_1))
    : finite(position.target_1);
  const economicFloor = quantity > 0 && 1 - feeRate > 0
    ? (cost + profitBuffer) / (quantity * (1 - feeRate))
    : Number.POSITIVE_INFINITY;
  const limitPrice = tickRound(Math.max(plannedTarget, economicFloor), tick, "up");
  const bids = (quote?.bids || []).map((row: any) => ({
    price: finite(row?.price ?? row?.[0]),
    size: finite(row?.size ?? row?.[1]),
  })).filter((row: any) => row.price > 0 && row.size > 0 && row.price + tick * 1e-9 >= limitPrice);
  const availableQuantity = bids.reduce((sum: number, row: any) => sum + row.size, 0);
  const expectedNetProfitQuote = limitPrice * quantity * (1 - feeRate) - cost;
  const measuredAt = new Date().toISOString();
  const protectedQuote = {
    revision: "7.1.6-PROTECTED-TARGET",
    purpose,
    measured_at: measuredAt,
    limit_price: limitPrice,
    planned_target: plannedTarget,
    economic_floor: economicFloor,
    requested_quantity: quantity,
    available_quantity_at_or_above_floor: availableQuantity,
    exact_unrecovered_cost_quote: cost,
    exit_fee_rate: feeRate,
    minimum_profit_quote: profitBuffer,
    expected_net_profit_quote: expectedNetProfitQuote,
  };
  if (
    !(limitPrice > 0) || expectedNetProfitQuote <= profitBuffer ||
    availableQuantity + Math.max(1e-12, quantity * 1e-8) < quantity
  ) {
    await patch("trading_positions", `id=eq.${position.id}`, {
      metadata: {
        ...(position.metadata || {}),
        target_net_guard: { ...protectedQuote, allowed: false },
      },
    });
    await event(
      "TARGET_NET_GUARD_BLOCKED",
      `${position.exchange}:${position.market} protected target not executable at positive net`,
      { ...protectedQuote, allowed: false },
      { cycleId, positionId: position.id, level: "INFO" },
    );
    return null;
  }
  await patch("trading_positions", `id=eq.${position.id}`, {
    metadata: {
      ...(position.metadata || {}),
      target_net_guard: { ...protectedQuote, allowed: true },
    },
  });
  return { limitPrice, expectedNetProfitQuote, availableQuantity, measuredAt };
}

/**
 * Settle a position the exchange says is already flat.
 *
 * Binance fills are the single source of truth. When an exit fails because the
 * account holds none of the asset, the position was closed on the exchange and only
 * our ledger disagrees. `reconcile_positions_from_exchange_fills` re-links the fills
 * and recomputes realized PnL from executed prices; it never touches a position that
 * is already CLOSED, and it is idempotent, so calling it here cannot move a settled
 * number. Returns true when the position ended up CLOSED.
 */
async function reconcileExhaustedPosition(
  position: Position,
  cycleId: string,
  reason: string,
): Promise<boolean> {
  try {
    const result = await rpc("reconcile_positions_from_exchange_fills", {
      p_exchange: position.exchange,
      p_market: position.market,
    });
    const summary = (Array.isArray(result) ? result[0] : result) || {};
    const rows = await db(
      `trading_positions?id=eq.${position.id}&select=state,remaining_quantity,realized_pnl_quote,closed_at`,
    ) as JsonRecord[];
    const settled = String(rows[0]?.state || "") === "CLOSED";
    await event(
      settled ? "EXIT_RECONCILED_FROM_FILLS" : "EXIT_RECONCILE_INCOMPLETE",
      `${position.exchange}:${position.market} ${
        settled
          ? "settled from exchange fills"
          : "exchange reports no balance but fills do not settle the position"
      }`,
      { reason, reconcile: summary, position: rows[0] ?? null },
      { cycleId, positionId: position.id, level: settled ? "INFO" : "CRITICAL" },
    );
    return settled;
  } catch (error) {
    await event(
      "EXIT_RECONCILE_FAILED",
      error instanceof Error ? error.message : String(error),
      { reason },
      { cycleId, positionId: position.id, level: "CRITICAL" },
    );
    return false;
  }
}

async function sellLive(
  position: Position,
  quantity: number,
  purpose: string,
  cycleId: string,
  protectedLimit: ProtectedTargetQuote | ProtectedPositiveNetQuote | null = null,
) {
  const portfolio = await gateway(position.exchange, { action: "portfolio" });
  const available = accountQuantity(portfolio, position.base_asset, true);
  const step = finite(position.quantity_step, 0.00000001);
  const qty = floorToStep(Math.min(position.remaining_quantity, quantity, available), step);
  if (!(qty > 0)) throw new Error(`no available ${position.base_asset} balance for exit`);
  const identifier = uniqueId("x", position.id);
  const isProtectedTarget = purpose === "TARGET_1" || purpose === "TARGET_2";
  const isProtectedLimit = protectedLimit !== null;
  if (isProtectedTarget && !isProtectedLimit) {
    throw new Error("protected target quote is required for target exit");
  }
  if (
    protectedLimit && "sellQuantity" in protectedLimit &&
    Math.abs(qty - protectedLimit.sellQuantity) > Math.max(1e-12, step * 1e-6)
  ) {
    throw new Error("protected positive-net quantity changed before order submission");
  }
  const orderType = isProtectedLimit ? "LIMIT" : "MARKET";
  const timeInForce = isProtectedLimit ? "FOK" : null;
  const requestedPrice = isProtectedLimit ? protectedLimit!.limitPrice : null;
  const orderRow = await createOrderRecord({
    position_id: position.id,
    candidate_id: position.candidate_id,
    cycle_id: cycleId,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier,
    market: position.market,
    side: "SELL",
    purpose,
    order_type: orderType,
    time_in_force: timeInForce,
    requested_price: requestedPrice,
    requested_volume: qty,
    requested_notional_quote: requestedPrice ? requestedPrice * qty : null,
    state: "REQUESTED",
  });
  try {
    const result = await gateway(position.exchange, {
      action: "create_order",
      order: isProtectedLimit
        ? {
          market: position.market,
          side: "SELL",
          type: "LIMIT",
          price: requestedPrice,
          quantity: qty,
          time_in_force: "FOK",
          identifier,
        }
        : { market: position.market, side: "SELL", type: "MARKET", quantity: qty, identifier },
      wait_for_final_ms: 4000,
    }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, result);
    if (finite(updated.fill.executedVolume) <= 0) {
      if (isProtectedLimit) return { orderRow, ...updated, noFill: true };
      throw new Error("market sell returned no fill");
    }
    return { orderRow, ...updated, noFill: false };
  } catch (error) {
    await patch("trading_orders", `id=eq.${orderRow.id}`, {
      state: "UNKNOWN",
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
async function finalizeExitFill(
  position: Position,
  result: any,
  action: string,
  fallbackPrice: number,
  cycleId: string,
  breakevenAfterT1 = true,
) {
  const applied = await applyExitAccounting(
    position,
    result.orderRow,
    result.fill || {},
    action,
    fallbackPrice,
    breakevenAfterT1,
  );
  const updated = applied.position;
  // Exit finalization idempotency v7.6.12: reconciliation can rediscover an
  // already-APPLIED exchange order. The accounting RPC is correctly idempotent, so a
  // replay returns applied=false. Do not manufacture a fresh PARTIAL_EXIT/POSITION_CLOSED
  // event for that no-op; those events are state-transition facts, not poll telemetry.
  if (applied.applied) {
    await event(
      applied.closed ? "POSITION_CLOSED" : "PARTIAL_EXIT",
      `${position.exchange}:${position.market} ${action}`,
      {
        price: applied.fillPrice,
        sold_quantity: applied.quantity,
        remaining: finite(updated?.remaining_quantity),
        pnl_quote: finite(updated?.realized_pnl_quote),
        quote: position.quote_currency,
        accounting_applied: true,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow.id },
    );
  }
  return {
    action,
    exchange: position.exchange,
    market: position.market,
    closed: applied.closed,
    position: updated,
  };
}
async function applyExit(
  position: Position,
  price: number,
  action: string,
  cycleId: string,
  breakevenAfterT1 = true,
  decisionReason?: string,
  settings?: TradingSettings & JsonRecord,
) {
  const targetAction = action === "TARGET_1" || action === "TARGET_2";
  const positiveNetAfter180 = decisionReason === "POSITIVE_NET_AFTER_180S";
  const recoveryNetPositive = decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT";
  const lateRecoveryNetPositive = decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT";
  const lateRecoveryDrawdown = decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT";
  // Upbit v7.6.16: a pre-T1 economic floor is only protection if the order-time book can
  // still execute the whole position above fee-net breakeven. Route this venue-specific
  // reason through the same fresh-depth FOK guard used by positive-net recovery exits.
  const upbitPreT1ProfitProtection = position.exchange === "upbit" &&
    decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT";
  const staleRecoveryNetPositive = decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
    decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M";
  const positiveNetGuardedExit = positiveNetAfter180 || recoveryNetPositive ||
    staleRecoveryNetPositive || upbitPreT1ProfitProtection;
  // Every reason that must be allowed to liquidate the protected half.
  // First take-profit (+5% spot / +15% futures ROE) is the only split-exit path that
  // preserves 50%. Hard stops and residual protected-trail exits must close everything
  // still remaining. Keep legacy residual reasons authorized for already-open positions.
  const fullLiquidationExit = decisionReason === "HALF_HOLD_ABSOLUTE_TIMEOUT" ||
    decisionReason === "POST180_MAX_HOLD_TIMEOUT" ||
    decisionReason === "HALF_HOLD_STOP_LOSS_4" ||
    decisionReason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||
    decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||
    decisionReason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||
    decisionReason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||
    decisionReason === "RESIDUAL_PROTECTED_TRAIL_EXIT" ||
    decisionReason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||
    decisionReason === "RESIDUAL_TAKE_PROFIT_10" ||
    decisionReason === "RESIDUAL_STOP_LOSS_4" ||
    decisionReason === "FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30" ||
    staleRecoveryNetPositive || recoveryNetPositive || lateRecoveryNetPositive ||
    lateRecoveryDrawdown || action === "EMERGENCY";
  const protectedHoldQuantity = fullLiquidationExit
    ? 0
    : Math.max(0, finite(position.initial_quantity) * 0.5);
  const maxExitQuantity = Math.max(
    0,
    finite(position.remaining_quantity) - protectedHoldQuantity,
  );
  const desiredQuantity = targetAction && position.metadata?.lob_signal
    ? finite(position.remaining_quantity)
    : action === "TARGET_1"
    ? t1SellQuantity(
      position.initial_quantity,
      position.remaining_quantity,
      position.t1_allocation_pct,
    )
    : finite(position.remaining_quantity);
  let quantity = Math.min(desiredQuantity, maxExitQuantity);
  // Entry sizing deliberately keeps the internal Binance 90 USDT floor. Exit sizing uses
  // the venue floor. A residual TP50/SL10 decision is the only non-emergency route allowed
  // to liquidate the formerly protected half; recovery mode is the other authorized route.
  const minNotional = position.exchange === "upbit" ? 5000 : 5;
  if (quantity * price < minNotional) {
    return { action: "NONE", reason: "exit quantity is below exchange minimum notional" };
  }
  quantity = floorToStep(quantity, finite(position.quantity_step, 0.00000001));
  if (!(quantity > 0)) {
    return { action: "NONE", reason: "no threshold-authorized sell quantity" };
  }

  const protectedTarget = !position.is_paper && targetAction
    ? await prepareProtectedTarget(position, quantity, action, cycleId)
    : null;
  if (!position.is_paper && targetAction && !protectedTarget) {
    return { action: "NONE", reason: "target net guard blocked or insufficient protected depth" };
  }
  const protectedPositiveNet = !position.is_paper && positiveNetGuardedExit && settings
    ? await preparePositiveNetAfter180Exit(
      position,
      quantity,
      settings,
      cycleId,
      upbitPreT1ProfitProtection
        ? "UPBIT_PRE_T1_PROFIT_PROTECTION_BLOCKED"
        : staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_BLOCKED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_BLOCKED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_BLOCKED"
        : "POSITIVE_NET_AFTER_180S_BLOCKED",
    )
    : null;
  if (!position.is_paper && positiveNetGuardedExit && !protectedPositiveNet) {
    return {
      action: "NONE",
      reason: upbitPreT1ProfitProtection
        ? "Upbit pre-T1 protection order-time positive-net recheck blocked; position retained"
        : staleRecoveryNetPositive
        ? "180m recovery net-positive order-time recheck blocked; position retained"
        : lateRecoveryNetPositive
        ? "late-recovery net-positive order-time recheck blocked; position retained"
        : recoveryNetPositive
        ? "recovery net-positive order-time recheck blocked; position retained"
        : "positive-net order-time recheck blocked; position retained",
    };
  }
  if (protectedPositiveNet) quantity = protectedPositiveNet.sellQuantity;
  const protectedLateRecovery = !position.is_paper &&
      (lateRecoveryNetPositive || lateRecoveryDrawdown) && settings
    ? await prepareLateRecoveryProtectedExit(
      position,
      quantity,
      settings,
      cycleId,
      lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_EXIT"
        : "LATE_RECOVERY_DRAWDOWN_33_EXIT",
    )
    : null;
  if (
    !position.is_paper && (lateRecoveryNetPositive || lateRecoveryDrawdown) &&
    !protectedLateRecovery
  ) {
    return {
      action: "NONE",
      reason: "late-recovery order-time FOK recheck blocked; position retained",
    };
  }
  if (protectedLateRecovery) quantity = protectedLateRecovery.sellQuantity;
  const protectedLimit = protectedTarget || protectedPositiveNet || protectedLateRecovery;
  const protectedExitAudit = protectedLateRecovery?.audit || protectedPositiveNet?.audit || null;

  if (!position.is_paper) {
    // Exit idempotency v7.6.11: never submit a second exchange SELL while an earlier
    // bot SELL for this position is still unresolved. The order ledger is durable and
    // reconciliation owns UNKNOWN/REQUESTED orders, so retrying here would be unsafe.
    const pendingSellOrders = await unappliedBotSellOrders(position);
    if (pendingSellOrders.length > 0) {
      await event(
        "EXIT_DEFERRED_UNSETTLED_ORDER",
        `${position.exchange}:${position.market} exit deferred because a bot SELL is still unsettled`,
        {
          action,
          decision_reason: decisionReason || action,
          pending_order_ids: pendingSellOrders.map((row) => row.id).filter(Boolean),
          pending_order_states: pendingSellOrders.map((row) => row.state).filter(Boolean),
        },
        { cycleId, positionId: position.id, level: "INFO" },
      );
      return {
        action: "NONE",
        reason: "exit deferred: unresolved bot SELL already exists",
        position,
      };
    }

    // This conditional PATCH is the exchange-side-effect claim. Concurrent monitor
    // invocations may both hold a stale OPEN snapshot, but only one can move OPEN to
    // EXITING and therefore only one is allowed to reach sellLive().
    const claimed = await patch(
      "trading_positions",
      `id=eq.${position.id}&state=eq.OPEN`,
      {
        state: "EXITING",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: action,
          pending_exit_reason: decisionReason || action,
          pending_exit_at: new Date().toISOString(),
          ...(protectedExitAudit ? { exit_policy_quote: protectedExitAudit } : {}),
        },
      },
    );
    if (!claimed.length) {
      await event(
        "EXIT_CLAIM_SKIPPED",
        `${position.exchange}:${position.market} exit skipped because position is no longer OPEN`,
        { action, decision_reason: decisionReason || action },
        { cycleId, positionId: position.id, level: "INFO" },
      );
      return {
        action: "NONE",
        reason: "exit already claimed or position not open",
        position,
      };
    }
    position = { ...position, ...claimed[0] };
  }
  const result = position.is_paper
    ? await sellPaper(position, quantity, price, action, cycleId)
    : await sellLive(position, quantity, action, cycleId, protectedLimit);

  if (!position.is_paper && (result as any)?.noFill) {
    const reopened = (await patch(
      "trading_positions",
      `id=eq.${position.id}&state=eq.EXITING`,
      {
        state: "OPEN",
        metadata: {
          ...(position.metadata || {}),
          pending_exit_action: null,
          pending_exit_reason: null,
          pending_exit_at: null,
          protected_limit_last_unfilled_at: new Date().toISOString(),
        },
      },
    ))[0] || position;
    await event(
      upbitPreT1ProfitProtection
        ? "UPBIT_PRE_T1_PROFIT_PROTECTION_FOK_NOT_FILLED"
        : staleRecoveryNetPositive
        ? "STALE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : lateRecoveryDrawdown
        ? "LATE_RECOVERY_DRAWDOWN_33_FOK_NOT_FILLED"
        : lateRecoveryNetPositive
        ? "LATE_RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : recoveryNetPositive
        ? "RECOVERY_NET_POSITIVE_FOK_NOT_FILLED"
        : positiveNetAfter180
        ? "POSITIVE_NET_AFTER_180S_FOK_NOT_FILLED"
        : "TARGET_PROTECTED_ORDER_NOT_FILLED",
      `${position.exchange}:${position.market} protected FOK did not fill; position retained`,
      {
        action,
        limit_price: protectedLimit?.limitPrice,
        expected_net_profit_quote: protectedLimit?.expectedNetProfitQuote,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "INFO" },
    );
    return { action: "NONE", reason: "protected target not filled", position: reopened };
  }

  let finalized = await finalizeExitFill(
    position,
    result,
    action,
    protectedLimit?.limitPrice || price,
    cycleId,
    breakevenAfterT1,
  );
  if (
    decisionReason === "FUTURES_HALF_STOP_LOSS_ROE_12" &&
    !finalized?.closed &&
    finite(finalized?.position?.remaining_quantity) > 0
  ) {
    const enteredAt = new Date().toISOString();
    const priorMetadata = finalized.position?.metadata || position.metadata || {};
    const recoveryMetadata = {
      ...priorMetadata,
      recovery_exit: {
        ...(priorMetadata.recovery_exit || {}),
        enabled: true,
        revision: VERSION,
        entered_at: enteredAt,
        trigger_reason: "FUTURES_HALF_STOP_LOSS_ROE_12",
        first_exit_price: finite(result?.fill?.averagePrice, price),
        first_exit_quantity: finite(result?.fill?.executedVolume),
        realized_pnl_quote_after_first_exit: finite(finalized.position?.realized_pnl_quote),
        exit_rule: "RESIDUAL_NET_PNL_GT_0",
        leverage: positionLeverage(position),
        percentage_residual_thresholds_disabled: true,
      },
    };
    const recoveryPosition =
      (await patch("trading_positions", `id=eq.${position.id}`, { metadata: recoveryMetadata }))[
        0
      ] || { ...finalized.position, metadata: recoveryMetadata };
    await event(
      "RECOVERY_MODE_ENTERED",
      `${position.exchange}:${position.market} first -12% ROE tranche filled; residual waits for positive residual net`,
      {
        first_exit_price: recoveryMetadata.recovery_exit.first_exit_price,
        first_exit_quantity: recoveryMetadata.recovery_exit.first_exit_quantity,
        realized_pnl_quote_after_first_exit:
          recoveryMetadata.recovery_exit.realized_pnl_quote_after_first_exit,
        exit_rule: recoveryMetadata.recovery_exit.exit_rule,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "INFO" },
    );
    finalized = { ...finalized, position: recoveryPosition };
    position = { ...position, ...recoveryPosition };
  }
  if (
    (targetAction || positiveNetGuardedExit || lateRecoveryNetPositive) && finalized?.closed &&
    finite(finalized?.position?.realized_pnl_quote) <= 0
  ) {
    const breachReason = upbitPreT1ProfitProtection
      ? "UPBIT_PRE_T1_PROFIT_PROTECTION_GUARD_BREACH"
      : staleRecoveryNetPositive
      ? "STALE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : lateRecoveryNetPositive
      ? "LATE_RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : recoveryNetPositive
      ? "RECOVERY_NET_POSITIVE_GUARD_BREACH"
      : positiveNetAfter180
      ? "POSITIVE_NET_AFTER_180S_GUARD_BREACH"
      : "TARGET_NET_GUARD_BREACH";
    const corrected = (await patch("trading_positions", `id=eq.${position.id}`, {
      close_reason: breachReason,
      metadata: {
        ...(finalized.position?.metadata || position.metadata || {}),
        original_close_reason: action,
        executable_net_guard_breached_at: new Date().toISOString(),
      },
    }))[0] || finalized.position;
    await event(
      breachReason,
      `${position.exchange}:${position.market} protected exit accounting was non-positive`,
      {
        action,
        realized_pnl_quote: finite(corrected?.realized_pnl_quote),
        limit_price: protectedLimit?.limitPrice,
      },
      { cycleId, positionId: position.id, orderId: result.orderRow?.id, level: "CRITICAL" },
    );
    finalized = { ...finalized, position: corrected };
  }
  if (
    finalized?.closed &&
    (decisionReason === "POSITIVE_NET_AFTER_180S" ||
      decisionReason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||
      decisionReason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
      decisionReason === "LATE_RECOVERY_NET_POSITIVE_EXIT" ||
      decisionReason === "LATE_RECOVERY_DRAWDOWN_33_EXIT" ||
      decisionReason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
      decisionReason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
      decisionReason === "HARD_STOP_MINUS_2_AFTER_180S") &&
    !(
      (positiveNetGuardedExit || lateRecoveryNetPositive) &&
      finite(finalized?.position?.realized_pnl_quote) <= 0
    )
  ) {
    const corrected = (await patch("trading_positions", `id=eq.${position.id}`, {
      close_reason: decisionReason,
      metadata: {
        ...(finalized.position?.metadata || position.metadata || {}),
        terminal_exit_reason: decisionReason,
      },
    }))[0] || finalized.position;
    finalized = { ...finalized, position: corrected };
  }
  return finalized;
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
      exchange_order_id: orderRow.exchange_order_id || null,
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
  // Same floor the dashboard uses: what is worth a dollar or less is not a position.
  const dust = dustQuoteFor(position.exchange);
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
  // A cross-margin futures wallet's available balance moves with the mark price of every
  // open position, so comparing it against booked order flow measures unrealised PnL
  // rather than external activity. There is nothing to detect here, only noise to log.
  if (exchange === "binance_futures") {
    return { detected: false, delta: 0, baseline: "FUTURES_MARGIN_BALANCE_FLOATS_WITH_MARK" };
  }
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

async function tryCompleteEmergencyLiquidation(cycleId: string) {
  try {
    const result = await rpc("complete_emergency_liquidation", {});
    if (result?.completed === true && result?.already_cleared !== true) {
      await event(
        "EMERGENCY_LIQUIDATION_COMPLETED",
        "all tracked positions and close orders are durably settled; entries remain locked",
        {
          active_positions: finite(result?.active_positions),
          pending_close_orders: finite(result?.pending_close_orders),
        },
        { cycleId, level: "CRITICAL" },
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await event(
      "EMERGENCY_LIQUIDATION_COMPLETION_FAILED",
      message,
      {},
      { cycleId, level: "CRITICAL" },
    );
    return { completed: false, error: message };
  }
}

async function monitorCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const monitorStartedAt = performance.now();
  const recoverySince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const [allTracked, terminalRecoveryRows] = await Promise.all([
    db(
      "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=*&order=created_at.asc",
    ) as Promise<Position[]>,
    db(
      `trading_positions?strategy_key=eq.${encodeURIComponent(P10_STRATEGY_KEY)}` +
        "&is_paper=eq.false&state=in.(CANCELLED,ERROR)" +
        "&trading_orders.purpose=eq.ENTRY&trading_orders.executed_volume=gt.0" +
        `&created_at=gte.${encodeURIComponent(recoverySince)}` +
        "&select=*,trading_orders!inner(id)&order=created_at.asc&limit=100",
    ).catch(() => []) as Promise<Position[]>,
  ]);
  const positionsLoadedAt = performance.now();
  // P10 has direction-aware futures accounting and hourly close-confirmed exits. Keep it
  // out of the legacy spot-shaped reconciliation/exit loop and manage it first.
  const p10Result = await monitorP10Positions(
    [
      ...allTracked.filter(isP10Position),
      ...(terminalRecoveryRows || []).filter((row) =>
        !row.metadata?.p10_entry_terminal_verified_at &&
        !allTracked.some((active) => active.id === row.id)
      ),
    ],
    settings,
    cycleId,
  );
  const p10Actions = p10Result.actions;
  const tracked = allTracked.filter((row) => !isP10Position(row));
  // P10 strategy has a fixed slow-maintenance owner: the SCAN lane. This remains true
  // during mixed/legacy transitions, so a position closing between two independent lease
  // reads can never hand residual sales or asset-lock counters to both lanes at once.
  const p10SlowMaintenanceOwnedByScan = isP10Strategy((settings as any).strategy);

  // P10's two-second lane owns price/market-risk decisions only.  Fee repair, idle-account
  // telemetry and legacy balance reconciliation run on the existing 12-second SCAN lane.
  // Before this split, an otherwise empty P10 monitor still fetched every enabled spot and
  // futures account, queried open orders twice and wrote telemetry after the risk decision.
  // The scheduler correctly ticked every two seconds but discarded each tick while that
  // 8-12 second request was in flight.
  if (isP10Strategy((settings as any).strategy) && tracked.length === 0) {
    const monitorHeartbeatAt = new Date().toISOString();
    await patchTradingHeartbeat({
      lastMonitorAt: monitorHeartbeatAt,
      lastGatewayHeartbeatAt: monitorHeartbeatAt,
      gatewayErrorCount: 0,
    });
    if (settings.emergency_liquidation) await tryCompleteEmergencyLiquidation(cycleId);
    return {
      positions: p10Result.openPositions,
      actions: p10Actions,
      unresolved_manual_assets: [],
      monitor_path: "P10_FAST_2S",
      timings_ms: {
        load_positions: Math.round(positionsLoadedAt - monitorStartedAt),
        p10: p10Result.timingsMs,
        total: Math.round(performance.now() - monitorStartedAt),
      },
    };
  }

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
  const feeReconciliations = p10SlowMaintenanceOwnedByScan ? [] : await reconcileFeeLedger(cycleId);
  // Exchange balances move before our position ledger does. Resolve every durable resting
  // TP first — including rows whose metadata reference was lost — so account reconciliation
  // never classifies the bot's own fill as a manual sale.
  const tpCandidates = await db(
    `trading_positions?strategy_key=neq.${encodeURIComponent(P10_STRATEGY_KEY)}` +
      "&state=in.(OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&is_paper=eq.false&select=*&order=created_at.asc",
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
    `trading_positions?strategy_key=neq.${encodeURIComponent(P10_STRATEGY_KEY)}` +
      "&state=eq.OPEN&select=*&order=created_at.asc",
  ) as Position[];
  const lobPolicyRuntime = isLobStrategy((settings as any).strategy)
    ? await loadLobPolicyRuntime()
    : null;
  const championPolicy = lobPolicyRuntime?.champion
    ? policyBundleByVersion(lobPolicyRuntime, finite(lobPolicyRuntime.champion.version))
    : null;
  const actions: any[] = [
    ...p10Actions,
    ...feeReconciliations.map((row) => ({
      action: "FEE_RECONCILIATION",
      ...row,
    })),
  ];
  const prices: Record<string, number> = {};
  const portfolios: Partial<Record<Exchange, any>> = {};
  const portfolioCapturedAt: Partial<Record<Exchange, string>> = {};
  const books: Record<string, any> = {};
  const unresolvedManualAssets: string[] = [];
  for (const exchange of ALL_EXCHANGES) {
    const exchangePositions = open.filter((p) => p.exchange === exchange);
    const balanceTrackedPositions = tracked.filter((p) =>
      p.exchange === exchange && !p.is_paper &&
      ["OPEN", "RECONCILING", "RECONCILIATION_FAILED", "MANUAL_INTERVENTION_REQUIRED"].includes(
        String(p.state),
      )
    );
    const venueEnabled = exchangeEnabled(settings, exchange);
    // Disabling an exchange blocks new entries only. Existing positions must remain monitored and exit-capable.
    if (!venueEnabled && exchangePositions.length === 0) continue;
    const portfolio = await gateway(exchange, { action: "portfolio" });
    portfolios[exchange] = portfolio;
    portfolioCapturedAt[exchange] = new Date().toISOString();
    if (!p10SlowMaintenanceOwnedByScan) {
      await detectExternalQuoteFlow(exchange, portfolio, settings, cycleId);
    }
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
        result.value.best_bid,
        finite(
          result.value.current,
          (finite(result.value.best_ask) + finite(result.value.best_bid)) / 2,
        ),
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
    const botLockedResult = await botLockedQuantities(exchange, balanceTrackedPositions);
    // v6.4: when the open-order book is unreadable we cannot attribute a lock to anyone.
    // Suppress the locked-balance branch entirely rather than blaming the user for it.
    const botLockedKnown = botLockedResult !== null;
    const botLockedByAsset = botLockedResult ?? new Map<string, number>();
    const allOpenOrderAssets = await openOrderAssets(exchange);
    const trackedExchangePositions = tracked.filter((p) => p.exchange === exchange);
    if (!p10SlowMaintenanceOwnedByScan) {
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
    }
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
    for (const originalPosition of balanceTrackedPositions) {
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

      // A stale non-OPEN row with an authenticated zero total balance and no exchange
      // order cannot represent a live holding. Reconcile it in this scan rather than
      // leaving a permanent RECONCILING ghost outside the OPEN-only monitor loop.
      if (
        position.state !== "OPEN" && actualTotal <= 1e-12 &&
        allOpenOrderAssets !== null && !allOpenOrderAssets.has(position.base_asset)
      ) {
        const pendingSellOrders = await unappliedBotSellOrders(position);
        if (!pendingSellOrders.length) {
          const reconciledAt = new Date().toISOString();
          await patch("trading_positions", `id=eq.${position.id}`, {
            state: "CLOSED",
            remaining_quantity: 0,
            reserved_quote: 0,
            reserved_quantity: 0,
            reservation_expires_at: null,
            closed_at: reconciledAt,
            close_reason: "EXCHANGE_BALANCE_ZERO_RECONCILED",
            marked_pnl_quote: null,
            metadata: {
              ...(position.metadata || {}),
              exclude_from_learning: true,
              display_data_status: "EXCHANGE_BALANCE_ZERO_RECONCILED",
              exchange_balance_reconciliation: {
                revision: "7.1.6-BALANCE-RECONCILE",
                observed_total_quantity: actualTotal,
                observed_free_quantity: actualFree,
                reconciled_at: reconciledAt,
                reason: "AUTHENTICATED_EXCHANGE_BALANCE_ZERO",
              },
            },
          });
          await event(
            "STALE_POSITION_BALANCE_RECONCILED",
            `${exchange}:${position.market} stale managed row closed after zero-balance check`,
            {
              previous_state: position.state,
              expected_quantity: expected,
              actual_total_quantity: actualTotal,
              revision: "7.1.6-BALANCE-RECONCILE",
            },
            { cycleId, positionId: position.id, level: "WARNING" },
          );
          continue;
        }
      }

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
        const phaseMissing = !position.metadata?.reconciliation_phase;
        const recoverLegacyState =
          ["RECONCILING", "RECONCILIATION_FAILED"].includes(String(position.state)) && phaseMissing;
        if (previousCount > 0 || recoverLegacyState) {
          await patch("trading_positions", `id=eq.${position.id}`, {
            ...(recoverLegacyState ? { state: "OPEN" } : {}),
            metadata: {
              ...(position.metadata || {}),
              account_mismatch_count: 0,
              last_account_mismatch_at: null,
              balance_reconciliation_checked_at: new Date().toISOString(),
              observed_total_quantity: actualTotal,
              observed_free_quantity: actualFree,
              ...(recoverLegacyState
                ? { legacy_reconciliation_recovered_at: new Date().toISOString() }
                : {}),
            },
          });
          if (recoverLegacyState) {
            await event(
              "LEGACY_RECONCILING_POSITION_RECOVERED",
              `${exchange}:${position.market} balance-backed legacy row returned to OPEN`,
              { previous_state: position.state, actual_total_quantity: actualTotal },
              { cycleId, positionId: position.id, level: "WARNING" },
            );
          }
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
    const residualSweeps = p10SlowMaintenanceOwnedByScan ? [] : await sweepResidualInventory(
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
      const current = executableBidVwap(
        books[position.market],
        finite(position.remaining_quantity),
      ) || prices[position.market];
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
      const liveMark = calculateExposureLedger({
        state: position.state,
        initialQuantity: position.initial_quantity,
        remainingQuantity: position.remaining_quantity,
        reservedQuote: position.reserved_quote,
        reservedQuantity: position.reserved_quantity,
        averageEntryPrice: position.average_entry_price,
        plannedEntryPrice: position.planned_entry_price,
        currentPrice: current,
        realizedCostQuote: position.realized_cost_quote,
        realizedProceedsQuote: position.realized_proceeds_quote,
        paidFeesQuote: position.paid_fees_quote,
        residualValueQuote: position.residual_value_quote,
        estimatedExitCostPct: FEE_PCT[exchange] / 100,
      });
      const markCostBasis = Math.max(
        1e-12,
        liveMark.markedCostBasisQuote + finite(position.paid_fees_quote),
      );
      const lobPosition = isLobStrategy(position.metadata?.lob_signal?.strategy);
      const values: JsonRecord = {
        peak_price: peak,
        trough_price: trough,
        marked_pnl_quote: liveMark.markedNetPnlQuote,
        metadata: lobPosition
          ? {
            ...(position.metadata || {}),
            active_exit_revision: VERSION,
            exit_policy_revision: VERSION,
            live_mark: {
              revision: VERSION,
              price_basis: "QUANTITY_AWARE_EXECUTABLE_BID",
              executable_price: current,
              quantity: finite(position.remaining_quantity),
              gross_return_pct: finite(position.average_entry_price) > 0
                ? (current / finite(position.average_entry_price) - 1) * 100
                : 0,
              fee_net_pnl_quote: liveMark.markedNetPnlQuote,
              fee_net_return_pct: liveMark.markedNetPnlQuote / markCostBasis * 100,
              measured_at: new Date().toISOString(),
            },
          }
          : position.metadata,
      };
      if (position.t1_completed && position.exit_policy === "TRAIL_AFTER_T1") {
        values.trailing_stop = nextTrailingStop(
          position.trailing_stop,
          peak,
          finite(position.trailing_distance_pct, 1.2),
          position.stop_price,
        );
      }
      position = {
        ...position,
        ...(await patch("trading_positions", `id=eq.${position.id}`, values))[0],
      };
      const futuresLane = position.exchange === "binance_futures";
      // v5.3: settle a resting take-profit that has reached a terminal state before
      // deciding anything else, so the position's remaining quantity is current.
      if (restingTpEnabled(settings, position)) {
        if (!restingTpIdentifier(position)) {
          position = await placeRestingTakeProfit(position, settings, cycleId);
        }
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
      const lobMode = isLobStrategy((settings as any).strategy);
      if ((lobMode || futuresLane) && restingTpIdentifier(position)) {
        const cancelled = await cancelRestingTakeProfit(position, cycleId);
        position = cancelled.position;
        if (!cancelled.ok) {
          actions.push({
            exchange,
            market: position.market,
            action: "NONE",
            reason: "LOB resting sell cancellation unconfirmed; exit deferred",
          });
          continue;
        }
        if (String(position.state) !== "OPEN" || finite(position.remaining_quantity) <= 0) continue;
      }
      const lobEntryPrice = finite(position.average_entry_price);
      const openedAt = Date.parse(String(position.opened_at || position.created_at || ""));
      const heldSeconds = Number.isFinite(openedAt)
        ? Math.max(0, (Date.now() - openedAt) / 1000)
        : 0;
      let decision = decideExit(
        position,
        current,
        Date.now(),
        settings.emergency_liquidation,
        !lobMode && !futuresLane,
      );
      if (
        lobMode && !futuresLane && !settings.emergency_liquidation && heldSeconds >= 180 &&
        !(finite(position.stop_price) > 0 && current <= finite(position.stop_price))
      ) {
        // After 180 seconds, ordinary exits still use executable-net policy. A real
        // scanner-derived stop remains authoritative at every position age.
        decision = { action: "NONE", fraction: 0, reason: "lob:post-180-await-executable-net" };
      }
      // v6.5: a slot marked for rotation by the scan cycle closes here, on the monitor's
      // own price and through the ordinary exit path -- cancelling the resting take-profit,
      // booking the fill, reconciling. The scan cycle deliberately does NOT sell: it has
      // neither a fresh price nor the exit plumbing, and a second code path that liquidates
      // positions is exactly the kind of divergence that produced the 8h39m ETH hold.
      if (
        decision.action === "NONE" && position.metadata?.rotation_displaced_at &&
        !settings.emergency_liquidation && !lobMode
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
        lobMode && !futuresLane && decision.action === "NONE" &&
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
        // heldSeconds is computed before the primary LOB exit decision.
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
        const rawSoftReason = exit.nextSoftReason;
        const nowMs = Date.now();
        const priorPost180Shadow = position.metadata?.lob_post180_recovery_shadow || {};
        const post180ShadowEligible = heldSeconds >= 180;
        const post180PriceAt180 = post180ShadowEligible
          ? Math.max(0, finite(priorPost180Shadow.price_at_180, current))
          : 0;
        const post180NoiseBandBps = clamp(
          Math.max(
            60,
            finite(position.metadata?.lob_signal?.features?.noiseBandBps, 0) * 4,
            finite(pinnedCoinPolicy.learned_stop_floor_bps, 0) * 2,
            Math.max(0, spread) * 3,
          ),
          60,
          220,
        );
        const priorPost180History = Array.isArray(position.metadata?.lob_post180_shadow_history)
          ? position.metadata.lob_post180_shadow_history
          : [];
        let post180ShadowHistory = priorPost180History
          .map((sample: any) => ({
            at: finite(sample?.at),
            reason: sample?.reason === "SIGNAL_REVERSAL" || sample?.reason === "LOB_INVALIDATION"
              ? sample.reason
              : null,
            price: finite(sample?.price),
            adverse_bps: finite(sample?.adverse_bps),
          }))
          .filter((sample: any) => sample.at >= nowMs - 180_000 && sample.at <= nowMs);
        if (post180ShadowEligible) {
          const adverseBps = post180PriceAt180 > 0 ? (current / post180PriceAt180 - 1) * 10000 : 0;
          post180ShadowHistory.push({
            at: nowMs,
            reason: rawSoftReason,
            price: current,
            adverse_bps: adverseBps,
          });
          post180ShadowHistory = post180ShadowHistory.slice(-120);
        } else {
          post180ShadowHistory = [];
        }
        const coveredPost180AdverseMs = (windowStartMs: number): number => {
          const samples = [...post180ShadowHistory]
            .filter((sample: any) => sample.at <= nowMs)
            .sort((left: any, right: any) => left.at - right.at);
          let activeReason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION" | null = null;
          let cursorMs = windowStartMs;
          let coveredMs = 0;
          for (const sample of samples) {
            if (sample.at <= windowStartMs) {
              activeReason = sample.reason;
              continue;
            }
            const sampleAtMs = Math.min(nowMs, sample.at);
            if (activeReason !== null) coveredMs += Math.max(0, sampleAtMs - cursorMs);
            cursorMs = Math.max(cursorMs, sampleAtMs);
            activeReason = sample.reason;
          }
          if (activeReason !== null) coveredMs += Math.max(0, nowMs - cursorMs);
          return coveredMs;
        };
        const post180LatestReason = post180ShadowHistory.length
          ? post180ShadowHistory[post180ShadowHistory.length - 1].reason
          : null;
        const post180AdversePersistent = post180ShadowEligible && post180LatestReason !== null &&
          coveredPost180AdverseMs(nowMs - 60_000) >= 45_000 &&
          coveredPost180AdverseMs(nowMs - 20_000) >= 18_000;
        let post180Phase = post180ShadowEligible
          ? String(priorPost180Shadow.phase || "POST180_RECOVERY_HOLD")
          : "INACTIVE";
        let post180FailedReclaims = post180ShadowEligible
          ? Math.max(0, Math.floor(finite(priorPost180Shadow.failed_reclaims)))
          : 0;
        let post180LowestPrice = post180ShadowEligible
          ? Math.min(current, finite(priorPost180Shadow.lowest_price, current))
          : current;
        let post180ReclaimHigh = post180ShadowEligible
          ? Math.max(current, finite(priorPost180Shadow.reclaim_high, current))
          : current;
        const post180AdverseFromStartBps = post180PriceAt180 > 0
          ? (current / post180PriceAt180 - 1) * 10000
          : 0;
        const post180ReboundFromLowBps = post180LowestPrice > 0
          ? (current / post180LowestPrice - 1) * 10000
          : 0;
        const post180ReclaimThresholdBps = clamp(post180NoiseBandBps * 0.35, 24, 80);
        if (post180ShadowEligible) {
          if (
            post180Phase === "POST180_RECOVERY_HOLD" &&
            post180AdverseFromStartBps <= -post180NoiseBandBps
          ) {
            post180Phase = "POST180_BREACH_WATCH";
            post180LowestPrice = current;
            post180ReclaimHigh = current;
          } else if (
            (post180Phase === "POST180_BREACH_WATCH" ||
              post180Phase === "POST180_FAILED_RECLAIM_1") &&
            post180ReboundFromLowBps >= post180ReclaimThresholdBps
          ) {
            post180Phase = "POST180_RECLAIM_TEST";
            post180ReclaimHigh = current;
          } else if (post180Phase === "POST180_RECLAIM_TEST") {
            post180ReclaimHigh = Math.max(post180ReclaimHigh, current);
            const retestedLow = current <= post180LowestPrice * 1.0005;
            const hadMeaningfulRebound = post180ReclaimHigh >=
              post180LowestPrice * (1 + post180ReclaimThresholdBps / 10000);
            if (retestedLow && hadMeaningfulRebound && post180AdversePersistent) {
              post180FailedReclaims += 1;
              post180Phase = post180FailedReclaims >= 2
                ? "POST180_FAILED_RECLAIM_2"
                : "POST180_FAILED_RECLAIM_1";
              post180LowestPrice = current;
              post180ReclaimHigh = current;
            }
          }
          if (
            post180Phase !== "POST180_RECLAIM_TEST" &&
            post180Phase !== "POST180_FAILED_RECLAIM_2"
          ) {
            post180LowestPrice = Math.min(post180LowestPrice, current);
          }
        }
        const priorPost180ShadowQualified = Boolean(priorPost180Shadow.shadow_exit_qualified);
        const post180ShadowQualified = post180ShadowEligible &&
          post180FailedReclaims >= 2 &&
          post180Phase === "POST180_FAILED_RECLAIM_2" &&
          post180AdversePersistent &&
          post180AdverseFromStartBps <= -post180NoiseBandBps;
        const softWindowEligible = heldSeconds < 180;
        const earliestSoftStart = Number.isFinite(openedAt) ? openedAt : nowMs;
        const priorHistory = Array.isArray(position.metadata?.lob_soft_exit_history)
          ? position.metadata.lob_soft_exit_history
          : [];
        let softHistory = priorHistory
          .map((sample: any) => ({
            at: finite(sample?.at),
            reason: sample?.reason === "SIGNAL_REVERSAL" || sample?.reason === "LOB_INVALIDATION"
              ? sample.reason
              : null,
          }))
          .filter((sample: any) =>
            sample.at >= earliestSoftStart && sample.at >= nowMs - 75_000 && sample.at <= nowMs
          );
        let recoveryStartedAtMs = Date.parse(
          String(position.metadata?.lob_soft_exit_recovery_started_at || ""),
        );
        if (!softWindowEligible) {
          softHistory = [];
          recoveryStartedAtMs = Number.NaN;
        } else {
          softHistory.push({ at: nowMs, reason: rawSoftReason });
          softHistory = softHistory.slice(-80);
          if (rawSoftReason === null) {
            if (!Number.isFinite(recoveryStartedAtMs)) recoveryStartedAtMs = nowMs;
            if (nowMs - recoveryStartedAtMs >= 8_000) softHistory = [];
          } else {
            recoveryStartedAtMs = Number.NaN;
          }
        }
        const coveredBadMilliseconds = (
          reason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION",
          windowStartMs: number,
        ): number => {
          const samples = [...softHistory]
            .filter((sample: any) => sample.at <= nowMs)
            .sort((left: any, right: any) => left.at - right.at);
          let activeReason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION" | null = null;
          let cursorMs = windowStartMs;
          let coveredMs = 0;
          for (const sample of samples) {
            if (sample.at <= windowStartMs) {
              activeReason = sample.reason;
              continue;
            }
            const sampleAtMs = Math.min(nowMs, sample.at);
            if (activeReason === reason) {
              coveredMs += Math.max(0, sampleAtMs - cursorMs);
            }
            cursorMs = Math.max(cursorMs, sampleAtMs);
            activeReason = sample.reason;
          }
          if (activeReason === reason) coveredMs += Math.max(0, nowMs - cursorMs);
          return coveredMs;
        };
        const qualifiesSoftWindow = (
          reason: "SIGNAL_REVERSAL" | "LOB_INVALIDATION",
          windowSeconds: number,
          requiredBadSeconds: number,
          tailSeconds: number,
        ): boolean => {
          const latestReason = softHistory.length
            ? softHistory[softHistory.length - 1].reason
            : null;
          const badMs = coveredBadMilliseconds(reason, nowMs - windowSeconds * 1000);
          const tailBadMs = coveredBadMilliseconds(reason, nowMs - tailSeconds * 1000);
          return latestReason === reason &&
            badMs >= requiredBadSeconds * 1000 &&
            tailBadMs >= tailSeconds * 1000;
        };
        const clearReversalQualified = softWindowEligible && qualifiesSoftWindow(
          "SIGNAL_REVERSAL",
          30,
          24,
          10,
        );
        const ambiguousReversalQualified = softWindowEligible && qualifiesSoftWindow(
          "LOB_INVALIDATION",
          50,
          40,
          14,
        );
        const softReason = softWindowEligible ? rawSoftReason : null;
        const softRequiredSeconds = softReason === "SIGNAL_REVERSAL"
          ? 30
          : softReason === "LOB_INVALIDATION"
          ? 50
          : 0;
        const softExitQualified = softReason === "SIGNAL_REVERSAL"
          ? clearReversalQualified
          : softReason === "LOB_INVALIDATION"
          ? ambiguousReversalQualified
          : false;
        const matchingSoftSamples = softReason
          ? softHistory.filter((sample: any) => sample.reason === softReason)
          : [];
        const softStartedAtMs = matchingSoftSamples.length
          ? finite(matchingSoftSamples[0].at)
          : Number.NaN;
        const softSignalAgeSeconds = Number.isFinite(softStartedAtMs)
          ? Math.max(0, (nowMs - softStartedAtMs) / 1000)
          : 0;
        const softStartedAtIso = Number.isFinite(softStartedAtMs)
          ? new Date(softStartedAtMs).toISOString()
          : null;
        const softMetadataChanged = true;
        if (softMetadataChanged) {
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                lob_soft_exit_reason: softReason,
                lob_soft_exit_streak: exit.nextSoftSignalStreak,
                lob_soft_exit_started_at: softStartedAtIso,
                lob_soft_exit_required_seconds: softRequiredSeconds,
                lob_soft_exit_qualified: softExitQualified,
                lob_soft_exit_history: softHistory,
                lob_soft_exit_recovery_started_at: Number.isFinite(recoveryStartedAtMs)
                  ? new Date(recoveryStartedAtMs).toISOString()
                  : null,
                lob_post180_shadow_history: post180ShadowHistory,
                lob_post180_recovery_shadow: post180ShadowEligible
                  ? {
                    revision: "7.1.9-POST180-RECOVERY-SHADOW",
                    mode: "SHADOW_ONLY",
                    started_at: priorPost180Shadow.started_at || new Date(nowMs).toISOString(),
                    price_at_180: post180PriceAt180,
                    phase: post180Phase,
                    failed_reclaims: post180FailedReclaims,
                    lowest_price: post180LowestPrice,
                    reclaim_high: post180ReclaimHigh,
                    adverse_band_bps: post180NoiseBandBps,
                    reclaim_threshold_bps: post180ReclaimThresholdBps,
                    adverse_from_180_bps: post180AdverseFromStartBps,
                    adverse_persistent: post180AdversePersistent,
                    latest_reason: post180LatestReason,
                    shadow_exit_qualified: post180ShadowQualified,
                    qualified_at: post180ShadowQualified
                      ? priorPost180Shadow.qualified_at || new Date(nowMs).toISOString()
                      : null,
                    checked_at: new Date(nowMs).toISOString(),
                  }
                  : null,
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
        if (post180ShadowQualified && !priorPost180ShadowQualified) {
          await event(
            "LOB_POST180_SHADOW_SOFT_EXIT",
            `${exchange}:${position.market} second reclaim failure qualified in shadow mode`,
            {
              mode: "SHADOW_ONLY",
              held_seconds: heldSeconds,
              price_at_180: post180PriceAt180,
              current_price: current,
              adverse_from_180_bps: post180AdverseFromStartBps,
              adverse_band_bps: post180NoiseBandBps,
              reclaim_threshold_bps: post180ReclaimThresholdBps,
              failed_reclaims: post180FailedReclaims,
              latest_reason: post180LatestReason,
              adverse_persistent: post180AdversePersistent,
              executable_action: "HOLD",
              canonical_positive_exit_preserved: true,
              canonical_hard_stop_preserved: true,
            },
            { cycleId, positionId: position.id, level: "INFO" },
          );
        }
        const lobExitSafetyReason = exit.reason === "RISK_EMERGENCY" ||
          exit.reason === "RECONCILIATION_FAILURE" ||
          exit.reason === "STOP_HIT";
        const lobSoftExitReady = softExitQualified && softReason !== null;
        if (exit.reason === "TARGET_HIT" || lobSoftExitReady || lobExitSafetyReason) {
          const approvedReason = lobSoftExitReady ? softReason : exit.reason;
          decision = {
            action: approvedReason === "TARGET_HIT" ? "TARGET_1" : "STOP",
            fraction: 1,
            reason: `lob:${approvedReason}`,
          } as any;
          await event("LOB_EXIT", `${exchange}:${position.market} ${approvedReason}`, {
            ...exit,
            reason: approvedReason,
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
      } else if (
        scalpMode && !futuresLane && decision.action === "NONE" &&
        !settings.emergency_liquidation
      ) {
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
      if (
        !futuresLane && isScalpStrategy((settings as any).strategy) &&
        position.average_entry_price > 0
      ) {
        const lossPct = (current - position.average_entry_price) / position.average_entry_price *
          100;
        const maxSingleLossPct = Math.abs(finite((settings as any).scalp_max_single_loss_pct, 5));
        if (lossPct <= -maxSingleLossPct) {
          decision = { action: "STOP", reason: "scalp_max_single_loss" } as any;
        }
      }
      // Spot: -4% hard stop, +5% half TP, then +3% floor / 1.5pp trailing.
      // Futures 3x: -12% ROE hard stop, +15% ROE half TP, then +9% floor / 4.5pp trailing.
      if ((lobMode || futuresLane) && !settings.emergency_liquidation) {
        const activeSplitPolicyVersion = futuresLane
          ? "FUTURES-ROE15-SL12-RECOVERY3M-FLOOR9-TRAIL4P5-GIVEBACK180M-V3"
          : "SPOT-PROTECTED-TRAIL-TP5-SL4-FLOOR3-TRAIL1P5-RECOVERY180M-V2";
        // v7.6.9 exit hotfix: LOB safety exits are hard invariants. The split TP/SL
        // policy is a profit-management layer and must never override a planned STOP_HIT,
        // risk stop, reconciliation stop, or the configured absolute holding ceiling.
        const configuredAbsoluteMaxHoldingSeconds = finite(
          position.metadata?.absolute_max_holding_seconds,
          finite((settings as any).lob_absolute_max_holding_seconds, 600),
        );
        const absoluteMaxHoldingSeconds = Math.max(1, configuredAbsoluteMaxHoldingSeconds);
        if (lobMode && !futuresLane && heldSeconds >= absoluteMaxHoldingSeconds) {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: "HALF_HOLD_ABSOLUTE_TIMEOUT",
            signalValid: false,
          } as any;
          console.error(
            `[HARD_EXIT_INVARIANT] ${exchange}:${position.market} held=${heldSeconds}s ` +
              `limit=${absoluteMaxHoldingSeconds}s -> full exit`,
          );
        }
        const requestedAction = decision.action;
        const requestedReason = String((decision as any).reason || "");
        const safetyRequested = requestedAction === "STOP";
        const policyFeeRate = clamp(FEE_PCT[exchange] / 100, 0, 0.01);
        const policyQuantity = Math.max(0, finite(position.remaining_quantity));
        const policyUnrecoveredCost = exactUnrecoveredPositionCost(position);
        const liveBook = books[position.market];
        const liveBids = (liveBook?.bids || []).map((row: any) => ({
          price: finite(row?.price ?? row?.[0]),
          size: finite(row?.size ?? row?.[1]),
        }));
        const liveAsks = (liveBook?.asks || []).map((row: any) => ({
          price: finite(row?.price ?? row?.[0]),
          size: finite(row?.size ?? row?.[1]),
        }));
        const executableQuote = quoteExecutableNetExit({
          bids: liveBids,
          requestedQuantity: policyQuantity,
          availableQuantity: position.is_paper
            ? policyQuantity
            : accountQuantity(portfolios[exchange], position.base_asset, true),
          quantityStep: finite(position.quantity_step, 0.00000001),
          buyPrincipalQuote: positionEntryCostBasis(position),
          alreadyPaidFeesQuote: finite(position.paid_fees_quote),
          priorSellProceedsQuote: finite(position.realized_proceeds_quote),
          sellFeeRate: policyFeeRate,
          slippageSafetyRate: post180SlippageSafetyRate(settings),
        });
        const executableExitPrice = executableQuote.executableVwap > 0
          ? executableQuote.executableVwap
          : current;
        const guardedNetProfitQuote = executableExitPrice * policyQuantity *
            (1 - policyFeeRate) - policyUnrecoveredCost;
        const guardedNetReturnPct = policyUnrecoveredCost > 0
          ? guardedNetProfitQuote / policyUnrecoveredCost * 100
          : 0;

        // Futures thresholds depend only on executable contract PnL and the leverage
        // stamped at entry. A later global strategy change or spot minute-gate outage
        // must not redirect or suspend the futures exit policy.
        const freshMinuteGate = futuresLane
          ? {
            passed: true,
            reasons: [],
            upperBandReclaimed: false,
            bearishUpperBandReentry: false,
            source: "FUTURES_EXIT_POLICY_NOT_APPLICABLE",
          }
          : await loadMinuteEntryGate(exchange, position.market);
        const liveImbalance = topOfBookImbalance(liveBids, liveAsks);
        const livePressure = finite(liveBook?.trade_flow?.pressure, 0);
        const entryDepth = Math.max(1, finite(position.metadata?.entry_bid_depth_quote, 1));
        const bidDepthRetention = liveBook ? bidDepthQuote(liveBook) / entryDepth : 0;
        const bestBid = finite(liveBook?.best_bid);
        const bestAsk = finite(liveBook?.best_ask);
        const liveSpreadBps = bestBid > 0 ? (bestAsk / bestBid - 1) * 10_000 : 9999;
        const entrySpreadBps = Math.max(
          1,
          finite(
            position.metadata?.lob_signal?.features?.spreadBps,
            position.metadata?.entry_spread_bps,
          ),
        );
        const weaknessSignals = [
          livePressure <= 0,
          liveImbalance <= -0.05,
          bidDepthRetention <= 0.70,
          liveSpreadBps >= Math.max(10, entrySpreadBps * 1.8),
        ];
        const weaknessVotes = weaknessSignals.filter(Boolean).length;
        const orderbookCollapse = (livePressure <= -0.35 && liveImbalance <= -0.20) ||
          (bidDepthRetention <= 0.45 &&
            liveSpreadBps >= Math.max(12, entrySpreadBps * 2));

        const nowMs = Date.now();
        const previousWatchText = String(position.metadata?.bb_exit_watch_started_at || "");
        const previousWatchMs = Date.parse(previousWatchText);
        let watchStartedMs = Number.isFinite(previousWatchMs) ? previousWatchMs : Number.NaN;
        if (freshMinuteGate.upperBandReclaimed) watchStartedMs = Number.NaN;
        else if (freshMinuteGate.bearishUpperBandReentry && !Number.isFinite(watchStartedMs)) {
          watchStartedMs = nowMs;
        }
        const watchAgeSeconds = Number.isFinite(watchStartedMs)
          ? Math.max(0, (nowMs - watchStartedMs) / 1000)
          : 0;
        const reentryConfirmed = freshMinuteGate.bearishUpperBandReentry && weaknessVotes >= 2;
        const reclaimFailed = Number.isFinite(watchStartedMs) && watchAgeSeconds >= 45 &&
          !freshMinuteGate.upperBandReclaimed && weaknessVotes >= 1;

        const entryPrice = finite(position.average_entry_price, position.planned_entry_price);
        const grossReturnPct = entryPrice > 0 ? (executableExitPrice / entryPrice - 1) * 100 : 0;
        const residualNetReturnPct = entryPrice > 0
          ? (executableExitPrice * (1 - policyFeeRate) /
              (entryPrice * (1 + policyFeeRate)) - 1) * 100
          : 0;
        const peakExecutablePrice = Math.max(
          executableExitPrice,
          finite(position.peak_price, entryPrice),
        );
        const peakGrossReturnPct = entryPrice > 0
          ? (peakExecutablePrice / entryPrice - 1) * 100
          : grossReturnPct;
        const protectedHoldQuantity = Math.max(0, finite(position.initial_quantity) * 0.5);
        const residualTolerance = Math.max(
          1e-12,
          finite(position.quantity_step, 0) * 1.001,
        );
        const quantityHasTradableHalf =
          finite(position.remaining_quantity) - protectedHoldQuantity >
            residualTolerance;
        // Futures residual stage is semantic, not inferred from quantity. Only an applied
        // TARGET_1 fill may set t1_completed; timeout/stop/other partial fills must never
        // fabricate a winning residual. Spot keeps its legacy quantity geometry.
        const hasTradableHalf = futuresLane
          ? position.t1_completed !== true
          : quantityHasTradableHalf;
        const preT1ProtectedStopPrice = Math.max(
          0,
          finite((position as any).metadata?.profit_protection?.protected_stop_price),
        );
        const preT1ProtectionHit = preT1ProfitProtectionHit({
          hasTradableHalf,
          entryPrice,
          executableExitPrice,
          protectedStopPrice: preT1ProtectedStopPrice,
          executableNetAllowed: executableQuote.allowed,
          executableNetProfitQuote: guardedNetProfitQuote,
        });

        const priorLateRecovery = position.metadata?.late_recovery || {};
        const priorLateRecoveryTrough = Math.max(
          0,
          finite(priorLateRecovery.post180_running_trough_price),
        );
        const recentShadowTrough = Array.isArray(position.metadata?.lob_post180_shadow_history)
          ? position.metadata.lob_post180_shadow_history.reduce((low: number, sample: any) => {
            const samplePrice = Math.max(0, finite(sample?.price));
            return samplePrice > 0 ? Math.min(low, samplePrice) : low;
          }, Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;
        const bootstrapPost180Trough = priorLateRecoveryTrough > 0
          ? priorLateRecoveryTrough
          : Number.isFinite(recentShadowTrough)
          ? Math.min(current, recentShadowTrough)
          : current;
        const post180RunningTrough = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds
          ? updatePost180RunningTrough(bootstrapPost180Trough, current)
          : 0;
        const lateRecoveryTrackingStartedNow = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds &&
          !priorLateRecovery.tracking_started_at;
        const lateRecoveryActivatedNow = heldSeconds >= LATE_RECOVERY_THRESHOLDS.startSeconds &&
          !priorLateRecovery.activated_at;
        const lateRecoveryTroughChanged = heldSeconds >=
            LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds &&
          (priorLateRecoveryTrough <= 0 ||
            post180RunningTrough <
              priorLateRecoveryTrough - Math.max(1e-12, priorLateRecoveryTrough * 1e-10));

        const positionLeverageValue = positionLeverage(position);
        let recoveryMode = futuresLane && position.metadata?.recovery_exit?.enabled === true;
        let futuresAudit: JsonRecord | null = null;
        let recoveryLatchedNow = false;

        if (requestedAction === "STOP") {
          // Preserve only true upstream safety decisions. Generic LOB/scalp time and soft
          // exits are excluded from Futures above, so a Futures STOP here is the planned
          // leverage-aware hard stop, reconciliation/emergency handling, or equivalent.
          console.warn(
            `[HARD_EXIT_INVARIANT] preserving ${requestedReason || "STOP"} for ` +
              `${exchange}:${position.market}`,
          );
        } else if (futuresLane) {
          const residualStage = !hasTradableHalf;
          // Residual winners use their own remaining-leg economics. Pre-T1 NORMAL/RECOVERY
          // decisions use the WHOLE position economics, including already-paid fees and any
          // prior proceeds, because the operator rule is about recovering the whole trade.
          const residualPrincipalQuote = Math.max(0, policyQuantity * entryPrice);
          const residualQuote = quoteExecutableNetExit({
            bids: liveBids,
            requestedQuantity: policyQuantity,
            availableQuantity: position.is_paper
              ? policyQuantity
              : accountQuantity(portfolios[exchange], position.base_asset, true),
            quantityStep: finite(position.quantity_step, 0.00000001),
            buyPrincipalQuote: residualPrincipalQuote,
            alreadyPaidFeesQuote: residualPrincipalQuote * policyFeeRate,
            priorSellProceedsQuote: 0,
            sellFeeRate: policyFeeRate,
            slippageSafetyRate: post180SlippageSafetyRate(settings),
          });
          const recoveryState = futuresRecoveryState({
            residualStage,
            alreadyLatched: recoveryMode,
            heldSeconds,
            netReturnPct: guardedNetReturnPct,
          });
          recoveryMode = recoveryState.enabled;
          recoveryLatchedNow = recoveryState.newlyLatched;

          const futuresNetReturnPct = residualStage ? residualNetReturnPct : guardedNetReturnPct;
          const futuresExecutableNetAllowed = residualStage
            ? residualQuote.allowed
            : executableQuote.allowed;
          const futuresExpectedNetProfitQuote = residualStage
            ? finite(residualQuote.expectedNetProfitQuote)
            : guardedNetProfitQuote;
          const futuresDecision = futuresSplitExitDecision({
            residualStage,
            recoveryMode,
            leverage: positionLeverageValue,
            grossReturnPct,
            peakGrossReturnPct,
            netReturnPct: futuresNetReturnPct,
            executableNetAllowed: futuresExecutableNetAllowed,
            expectedNetProfitQuote: futuresExpectedNetProfitQuote,
            heldSeconds,
            preT1ProfitProtectionHit: preT1ProtectionHit,
            safetyRequested,
          });
          decision = {
            action: futuresDecision.action,
            fraction: futuresDecision.fraction,
            reason: futuresDecision.reason,
          } as any;
          futuresAudit = {
            leverage: futuresDecision.leverage,
            roe_pct: futuresDecision.roePct,
            net_roe_pct: futuresDecision.netRoePct,
            price_return_pct: grossReturnPct,
            thresholds: FUTURES_SPLIT_EXIT_THRESHOLDS,
            residual_stage: residualStage,
            recovery_mode: recoveryMode,
            recovery_latched_now: recoveryLatchedNow,
            whole_position_net_return_pct: guardedNetReturnPct,
            whole_position_executable_net_allowed: executableQuote.allowed,
            whole_position_expected_net_profit_quote: guardedNetProfitQuote,
            residual_executable_net_allowed: residualQuote.allowed,
            residual_expected_net_profit_quote:
              Number.isFinite(residualQuote.expectedNetProfitQuote)
                ? residualQuote.expectedNetProfitQuote
                : null,
            residual_principal_quote: residualPrincipalQuote,
          };
        } else {
          decision = spotSplitExitDecision({
            residualStage: !hasTradableHalf,
            grossReturnPct,
            peakGrossReturnPct,
            residualNetReturnPct,
            heldSeconds,
            executableNetAllowed: executableQuote.allowed,
            expectedNetProfitQuote: finite(executableQuote.expectedNetProfitQuote),
            preT1ProfitProtectionHit: preT1ProtectionHit,
            safetyRequested,
          }) as any;
        }

        const executableDepthSufficient = policyQuantity > 0 &&
          executableQuote.executableVwap > 0 &&
          finite(executableQuote.visibleExecutableQuantity) +
                Math.max(1e-12, policyQuantity * 1e-8) >= policyQuantity;
        const lateRecovery = lateRecoveryDecision({
          heldSeconds,
          absoluteMaxHoldingSeconds,
          residualStage: !hasTradableHalf,
          existingAction: decision.action,
          entryPrice,
          runningTroughPrice: post180RunningTrough,
          executablePrice: executableExitPrice,
          executableDepthSufficient,
          executableNetAllowed: executableQuote.allowed,
          expectedNetProfitQuote: guardedNetProfitQuote,
        });
        if (lateRecovery.action === "STOP") {
          decision = {
            action: "STOP",
            fraction: 1,
            reason: lateRecovery.reason,
          } as any;
          if (!priorLateRecovery.triggered_at) {
            await event(
              "LATE_RECOVERY_EXIT_TRIGGERED",
              `${exchange}:${position.market} ${lateRecovery.reason}`,
              {
                held_seconds: heldSeconds,
                entry_price: entryPrice,
                post180_running_trough_price: post180RunningTrough,
                executable_price: executableExitPrice,
                recovery_ratio: lateRecovery.recoveryRatio,
                threshold_ratio: LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
                expected_net_profit_quote: guardedNetProfitQuote,
                executable_net_allowed: executableQuote.allowed,
                executable_depth_sufficient: executableDepthSufficient,
                existing_policy_action_preserved: false,
              },
              { cycleId, positionId: position.id, level: "INFO" },
            );
          }
        }
        const lateRecoveryMetadataChanged = lateRecoveryTrackingStartedNow ||
          lateRecoveryActivatedNow || lateRecoveryTroughChanged || lateRecovery.action === "STOP";

        const watchIso = Number.isFinite(watchStartedMs)
          ? new Date(watchStartedMs).toISOString()
          : null;
        const watchChanged = watchIso !== (previousWatchText || null);
        if (
          watchChanged || recoveryLatchedNow || lateRecoveryMetadataChanged ||
          decision.action !== "NONE"
        ) {
          const measuredAt = new Date(nowMs).toISOString();
          const approvedReason = String((decision as any).reason || "");
          const approvedAction = decision.action === "STOP" ? "STOP" : "NONE";
          const exitPolicyQuote = decision.action === "STOP"
            ? {
              revision: VERSION,
              burst_policy_version: activeSplitPolicyVersion,
              measured_at: measuredAt,
              price: executableExitPrice,
              executable_vwap: executableQuote.executableVwap,
              sell_price: executableQuote.limitPrice,
              approved_action: approvedAction,
              approved_reason: approvedReason,
              requested_action: requestedAction,
              requested_reason: requestedReason,
              ...(futuresLane ? { recovery_mode: recoveryMode } : {}),
              futures: futuresAudit,
              executable_net_allowed: executableQuote.allowed,
              expected_net_profit_quote: Number.isFinite(executableQuote.expectedNetProfitQuote)
                ? executableQuote.expectedNetProfitQuote
                : null,
              hard_stop_net_return_pct: guardedNetReturnPct,
              hard_stop_net_profit_quote: guardedNetProfitQuote,
              bb_upper_reentry_confirmed: reentryConfirmed,
              bb_reclaim_failed: reclaimFailed,
              orderbook_collapse: orderbookCollapse,
              bb_weakness_votes: weaknessVotes,
              bb_exit_watch_age_seconds: watchAgeSeconds,
              minute_entry_gate: freshMinuteGate,
              live_pressure: livePressure,
              live_imbalance: liveImbalance,
              bid_depth_retention: bidDepthRetention,
              spread_bps: liveSpreadBps,
              held_seconds: heldSeconds,
            }
            : position.metadata?.exit_policy_quote;
          position = {
            ...position,
            ...(await patch("trading_positions", `id=eq.${position.id}`, {
              metadata: {
                ...(position.metadata || {}),
                bb_exit_watch_started_at: watchIso,
                bb_last_minute_gate: freshMinuteGate,
                ...(heldSeconds >= LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds
                  ? {
                    late_recovery: {
                      ...(priorLateRecovery || {}),
                      revision: "7.6.10-LATE-RECOVERY-460-R33",
                      tracking_started_at: priorLateRecovery.tracking_started_at || measuredAt,
                      post180_running_trough_price: post180RunningTrough,
                      start_seconds: LATE_RECOVERY_THRESHOLDS.startSeconds,
                      drawdown_recovery_ratio_threshold:
                        LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio,
                      activated_at: heldSeconds >= LATE_RECOVERY_THRESHOLDS.startSeconds
                        ? priorLateRecovery.activated_at || measuredAt
                        : priorLateRecovery.activated_at || null,
                      last_recovery_ratio: lateRecovery.recoveryRatio,
                      last_executable_price: executableExitPrice,
                      last_expected_net_profit_quote: guardedNetProfitQuote,
                      last_executable_depth_sufficient: executableDepthSufficient,
                      last_decision: lateRecovery.reason,
                      triggered_at: lateRecovery.action === "STOP"
                        ? priorLateRecovery.triggered_at || measuredAt
                        : priorLateRecovery.triggered_at || null,
                      checked_at: measuredAt,
                    },
                  }
                  : {}),
                // RECOVERY is a permanent pre-T1 mission state. It is latched once, at the
                // first observation at/after 180s whose WHOLE-position executable net is
                // non-positive, and remains set until the position closes.
                ...(recoveryLatchedNow
                  ? {
                    recovery_exit: {
                      ...(position.metadata?.recovery_exit || {}),
                      enabled: true,
                      state: "RECOVERY",
                      revision: VERSION,
                      entered_at: new Date(nowMs).toISOString(),
                      trigger_reason: "FUTURES_3M_NET_NONPOSITIVE",
                      exit_rule: "FULL_POSITION_EXECUTABLE_NET_PNL_GT_0",
                      leverage: positionLeverageValue,
                      held_seconds_at_latch: heldSeconds,
                      net_return_pct_at_latch: guardedNetReturnPct,
                      net_profit_quote_at_latch: guardedNetProfitQuote,
                      permanent_until_exit: true,
                    },
                  }
                  : {}),
                ...(decision.action === "STOP" ? { exit_policy_quote: exitPolicyQuote } : {}),
              },
            }))[0],
          };
        }
      }

      if (decision.action === "NONE") continue;
      // v5.3: the resting sell locks the base asset. Cancel and CONFIRM before any market
      // exit; a rejected sell would leave the position open with no protection.
      if (restingTpIdentifier(position)) {
        const nonPriceDecisionConfirmed = String(decision.reason || "").startsWith("lob:") ||
          String(decision.reason || "").startsWith("live_hold:") ||
          String(decision.reason || "").startsWith("rotation:") ||
          decision.reason === "HARD_STOP_MINUS_2" ||
          decision.reason === "HALF_HOLD_TAKE_PROFIT_5" ||
          decision.reason === "HALF_HOLD_ABSOLUTE_TIMEOUT" ||
          decision.reason === "POST180_MAX_HOLD_TIMEOUT" ||
          decision.reason === "HALF_HOLD_STOP_LOSS_4" ||
          decision.reason === "FUTURES_HALF_TAKE_PROFIT_ROE_15" ||
          decision.reason === "FUTURES_HALF_STOP_LOSS_ROE_12" ||
          decision.reason === "PRE_T1_PROFIT_PROTECTION_EXIT" ||
          decision.reason === "FUTURES_PRE_T1_PROFIT_PROTECTION_EXIT" ||
          decision.reason === "FUTURES_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "LATE_RECOVERY_NET_POSITIVE_EXIT" ||
          decision.reason === "LATE_RECOVERY_DRAWDOWN_33_EXIT" ||
          decision.reason === "FUTURES_STALE_GIVEBACK_EXIT_180M" ||
          decision.reason === "FUTURES_RESIDUAL_PROTECTED_TRAIL_EXIT" ||
          decision.reason === "RESIDUAL_PROTECTED_TRAIL_EXIT" ||
          decision.reason === "STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
          decision.reason === "FUTURES_STALE_RECOVERY_NET_POSITIVE_EXIT_180M" ||
          decision.reason === "BB_UPPER_REENTRY_CONFIRMED" ||
          decision.reason === "BB_RECLAIM_FAILED" ||
          decision.reason === "ORDERBOOK_COLLAPSE";
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
            settings,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The exchange holding none of the asset is not a transient failure: the coin
        // is already sold, and our ledger is what is stale. Retrying the exit here just
        // reissues a doomed order every cycle (this produced thousands of CRITICAL
        // EXIT_ERRORs against positions that had been fully sold hours earlier).
        // Settle the position from the exchange fills instead and move on.
        if (/no available .* balance for exit/i.test(message)) {
          const settled = await reconcileExhaustedPosition(position, cycleId, message);
          actions.push({
            exchange,
            market: position.market,
            action: decision.action,
            reconciled: settled,
            error: settled ? undefined : message,
          });
          continue;
        }
        actions.push({
          exchange,
          market: position.market,
          action: decision.action,
          error: message,
        });
        await event("EXIT_ERROR", message, {
          decision,
        }, { cycleId, positionId: position.id, level: "CRITICAL" });
      }
    }
  }
  const stillOpen = await db("trading_positions?state=eq.OPEN&select=*") as Position[];
  if (!p10SlowMaintenanceOwnedByScan) {
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
  }
  const monitorHeartbeatAt = new Date().toISOString();
  await patchTradingHeartbeat({
    lastMonitorAt: monitorHeartbeatAt,
    lastGatewayHeartbeatAt: monitorHeartbeatAt,
    gatewayErrorCount: 0,
  });
  if (settings.emergency_liquidation) await tryCompleteEmergencyLiquidation(cycleId);
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

// =====================================================================================
// P10 Donchian breakout live lane
// =====================================================================================

type P10SignalRow = JsonRecord & {
  run_id: string;
  venue: P10Venue;
  market: string;
  side: P10Side;
  signal_time: string;
  score: number;
  reference_close: number;
  stop_reference: number;
  evidence: JsonRecord;
  created_at: string;
};

const P10_ENTRY_WINDOW_MS = 20 * 60_000;

function isS096ShortSignal(signal: P10SignalRow): boolean {
  return signal.venue === "binance_futures" && signal.side === "SHORT" &&
    isS096SignalEvidence(signal.evidence);
}

function combinedEntryPlan(signal: P10SignalRow, entryPrice: number) {
  if (isS096ShortSignal(signal)) {
    return planS096ShortEntry(
      finite(signal.reference_close),
      finite(signal.evidence?.atr14),
      entryPrice,
    );
  }
  return planP10Entry(
    String(signal.side) as P10Side,
    finite(signal.reference_close),
    finite(signal.evidence?.atr14),
    entryPrice,
  );
}

function p10VenueExchange(venue: P10Venue): Exchange {
  return venue === "upbit_spot"
    ? "upbit"
    : venue === "binance_spot"
    ? "binance"
    : "binance_futures";
}

function p10ExchangeVenue(exchange: Exchange): P10Venue {
  return exchange === "upbit"
    ? "upbit_spot"
    : exchange === "binance"
    ? "binance_spot"
    : "binance_futures";
}

function p10EntrySide(side: P10Side) {
  return side === "LONG" ? "BUY" : "SELL";
}

function p10ExitSide(side: P10Side) {
  return side === "LONG" ? "SELL" : "BUY";
}

function p10OrderPurpose(action: string) {
  if (action === "TARGET_1") return "TARGET_1";
  if (action === "TARGET_2") return "TARGET_2";
  if (action === "STOP") return "STOP";
  if (action === "TIME") return "TIME_EXIT";
  if (action === "EMERGENCY") return "EMERGENCY";
  return "TRAIL";
}

async function loadP10Signals(): Promise<P10SignalRow[]> {
  const since = new Date(Date.now() - 100 * 60_000).toISOString();
  const rows = await db(
    `v2_live_signals?config_key=eq.${encodeURIComponent(P10_STRATEGY_KEY)}` +
      `&created_at=gte.${encodeURIComponent(since)}` +
      "&select=*&order=created_at.desc,score.desc&limit=2000",
  ) as P10SignalRow[];
  const now = Date.now();
  const deduped = new Map<string, P10SignalRow>();
  for (const row of rows || []) {
    const signalTime = Date.parse(String(row.signal_time || ""));
    const nextBarOpen = signalTime + P10_HOUR_MS;
    if (
      !Number.isFinite(signalTime) || now < nextBarOpen ||
      now > nextBarOpen + P10_ENTRY_WINDOW_MS
    ) continue;
    if (row.venue !== "binance_futures" && row.side !== "LONG") continue;
    // Fail closed: legacy/research SHORT rows under the shared execution config must
    // never become live entries. Only the exact S096 strategy+revision is executable.
    if (row.side === "SHORT" && !isS096ShortSignal(row)) continue;
    const key = `${row.venue}:${row.market}:${row.side}:${row.signal_time}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  return [...deduped.values()].sort((left, right) => {
    // S096 and I46 scores are not calibrated to the same scale. Preserve the pre-existing
    // LONG lane's priority, then rank each side by its own research score.
    if (left.side !== right.side) return left.side === "LONG" ? -1 : 1;
    return finite(right.score) - finite(left.score);
  });
}

function p10Depth(
  levels: any[],
  side: P10Side,
  boundaryPrice: number,
  requestedNotional: number,
) {
  let availableFunds = 0;
  let executionFunds = 0;
  let volume = 0;
  let worstPrice = 0;
  for (const unit of Array.isArray(levels) ? levels : []) {
    const price = finite(unit?.price ?? unit?.[0]);
    const size = finite(unit?.size ?? unit?.[1]);
    if (!(price > 0 && size > 0)) continue;
    const withinBoundary = side === "LONG" ? price <= boundaryPrice : price >= boundaryPrice;
    if (!withinBoundary) continue;
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

function p10TicketCapital(
  exchange: Exchange,
  settings: TradingSettings & JsonRecord,
  managed: JsonRecord,
) {
  const slots = clamp(finite((settings as any).scalp_position_slots, 3), 1, 20);
  const available = Math.max(0, finite(managed.managedAvailableQuote));
  const capital = Math.max(0, finite(managed.managedCapitalQuote));
  let maximum = Number.MAX_SAFE_INTEGER;
  let minimum = finite(settings.min_order_krw, 40_000);
  if (exchange === "binance") {
    maximum = finite(settings.max_order_usdt, 40);
    minimum = binanceMinOrderUsdt(settings.min_order_usdt);
  }
  if (exchange === "upbit") maximum = finite(settings.max_order_krw, maximum);
  if (exchange === "binance_futures") {
    const operatorMargin = finite((settings as any).binance_futures_allocation_usdt, 200);
    if (operatorMargin > 0) {
      return p10ExactFuturesTicketCapital(available, operatorMargin, 0.01);
    }
    minimum = FUTURES_MIN_ENTRY_MARGIN_USDT;
  }
  const step = exchange === "upbit" ? 1000 : 0.01;
  return p10ExecutableTicketCapital({
    available,
    capital,
    slots,
    maximum,
    minimum,
    step,
  });
}

async function rejectP10Claim(claimId: string | null, reason: string) {
  if (!claimId) return;
  await patch("p10_signal_claims", `id=eq.${claimId}`, {
    status: "REJECTED",
    reason: reason.slice(0, 500),
  }).catch(() => null);
}

async function applyP10EntryAccounting(
  position: Position,
  orderRow: any,
  gatewayOrder: any,
  fill: any,
  signal: P10SignalRow,
) {
  const grossQuantity = finite(fill.executedVolume);
  const paidFeeBase = Math.max(
    0,
    finite(fill.paidFeeBase, baseAssetFee(gatewayOrder, fill, position.base_asset)),
  );
  const quantity = position.exchange === "binance_futures"
    ? grossQuantity
    : Math.max(0, grossQuantity - paidFeeBase);
  const price = finite(fill.averagePrice);
  const plan = combinedEntryPlan(signal, price);
  if (!(quantity > 0 && price > 0 && plan.allowed)) {
    throw new Error(`P10 filled entry has invalid accounting plan: ${plan.reason || "no fill"}`);
  }
  const result = await rpc("apply_p10_entry_order", {
    p_order_id: orderRow.id,
    p_fill_price: price,
    p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity),
    p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_stop_price: tickRound(
      plan.stopPrice,
      finite(position.tick_size),
      plan.side === "LONG" ? "down" : "up",
    ),
    p_target_1: tickRound(
      plan.partialTarget,
      finite(position.tick_size),
      plan.side === "LONG" ? "up" : "down",
    ),
    p_target_2: tickRound(
      plan.finalTarget,
      finite(position.tick_size),
      plan.side === "LONG" ? "up" : "down",
    ),
    p_initial_risk: plan.initialRisk,
  });
  return {
    applied: result?.applied === true,
    position: result?.position || position,
    order: result?.order || orderRow,
  };
}

async function enterP10Signal(
  signal: P10SignalRow,
  settings: TradingSettings & JsonRecord,
  rawPortfolio: any,
  cycleId: string,
) {
  const exchange = p10VenueExchange(signal.venue);
  const side = String(signal.side) as P10Side;
  const shortLiveOptIn = futuresShortLiveEnabled(FUTURES_SHORT_LIVE_FLAG) ||
    (settings as any).binance_futures_short_enabled === true;
  const shortBlock = futuresShortEntryBlockReason(
    exchange,
    side,
    shortLiveOptIn ? "true" : "false",
  );
  if (shortBlock) {
    return { entered: false, exchange, market: signal.market, reason: shortBlock };
  }
  if (exchange !== "binance_futures" && side !== "LONG") {
    return { entered: false, exchange, market: signal.market, reason: "spot is LONG-only" };
  }
  if (settings.mode !== "LIVE_LIMITED") {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "P10 cutover requires LIVE_LIMITED mode",
    };
  }
  const existing = await db(
    `trading_positions?exchange=eq.${exchange}&market=eq.${encodeURIComponent(signal.market)}` +
      "&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id&limit=1",
  );
  if (existing.length) {
    return { entered: false, exchange, market: signal.market, reason: "market already tracked" };
  }
  const base = baseAsset(exchange, signal.market);
  if (settings.suppress_cross_exchange_same_asset) {
    const activeBase = await db(
      `trading_positions?base_asset=eq.${encodeURIComponent(base)}` +
        "&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id&limit=1",
    );
    if (activeBase.length) {
      return {
        entered: false,
        exchange,
        market: signal.market,
        reason: `base asset ${base} already exposed`,
      };
    }
  }
  const market = await marketQuote(exchange, signal.market);
  const bestAsk = finite(market.best_ask);
  const bestBid = finite(market.best_bid);
  const executablePrice = side === "LONG" ? bestAsk : bestBid;
  if (!(bestAsk > 0 && bestBid > 0 && executablePrice > 0)) {
    return { entered: false, exchange, market: signal.market, reason: "empty orderbook" };
  }
  const spreadBps = (bestAsk / bestBid - 1) * 10_000;
  if (!Number.isFinite(spreadBps) || spreadBps > LIVE_MAX_SPREAD_BPS) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: `spread ${spreadBps.toFixed(2)}bp exceeds ${LIVE_MAX_SPREAD_BPS}bp`,
    };
  }
  const atr14 = finite(signal.evidence?.atr14);
  const preliminaryPlan = combinedEntryPlan(signal, executablePrice);
  if (!preliminaryPlan.allowed) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: preliminaryPlan.reason,
    };
  }
  if (
    exchange !== "binance_futures" &&
    accountQuantity(rawPortfolio, base) * executablePrice >= (exchange === "upbit" ? 1000 : 1)
  ) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "pre-existing account balance detected",
    };
  }
  if (exchange === "binance_futures") {
    const exchangePosition = (Array.isArray(rawPortfolio?.positions) ? rawPortfolio.positions : [])
      .find((row: any) =>
        String(row?.market || "").toUpperCase() === signal.market.toUpperCase() &&
        finite(row?.quantity) > 0
      );
    if (exchangePosition) {
      return {
        entered: false,
        exchange,
        market: signal.market,
        reason: `pre-existing futures ${
          String(exchangePosition.side || "UNKNOWN")
        } position detected`,
      };
    }
  }
  const syntheticCandidate = {
    market: signal.market,
    entry_high: executablePrice,
    feature_vector: {},
  } as Candidate;
  const rules = await symbolRules(exchange, syntheticCandidate, { tick: 0 });
  const managedPortfolioState = await managedPortfolio(settings, exchange, rawPortfolio);
  const managed = managedPortfolioState.managed;
  const marginQuote = p10TicketCapital(exchange, settings, managed);
  const leverage = exchangeLeverage(settings, exchange);
  const minimumMargin = exchange === "binance_futures"
    ? FUTURES_MIN_ENTRY_MARGIN_USDT
    : Math.max(exchangeLimits(settings, exchange).minOrder, rules.min_notional);
  // A futures slot is worth exactly the operator's configured margin. When the wallet
  // cannot fund a whole slot the entry is skipped outright: silently downsizing the
  // ticket would break the "1 slot = configured margin" invariant the operator sized
  // the strategy around.
  const configuredFuturesMargin = exchange === "binance_futures"
    ? finite((settings as any).binance_futures_allocation_usdt, 200)
    : 0;
  if (exchange === "binance_futures" && configuredFuturesMargin > 0 && marginQuote <= 0) {
    const reason = "P10_EXACT_MARGIN_INSUFFICIENT_BALANCE";
    await event(reason, "P10 futures slot skipped; wallet cannot fund a whole slot margin", {
      strategy_key: P10_STRATEGY_KEY,
      exchange,
      market: signal.market,
      side,
      requested_margin_usdt: configuredFuturesMargin,
      available_margin_usdt: finite(managed.managedAvailableQuote),
      leverage,
      requested_notional_usdt: configuredFuturesMargin * leverage,
    }, { cycleId, level: "WARNING" });
    return { entered: false, exchange, market: signal.market, reason };
  }
  if (marginQuote + 1e-8 < minimumMargin) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: `P10 ticket ${marginQuote} below minimum ${minimumMargin}`,
    };
  }
  const requestedNotional = marginQuote * leverage;
  const maxEntryGapAtr = isS096ShortSignal(signal)
    ? S096_SHORT_CONFIG.maxEntryGapAtr
    : P10_CONFIG.maxEntryGapAtr;
  const boundaryPrice = side === "LONG"
    ? finite(signal.reference_close) + maxEntryGapAtr * atr14
    : finite(signal.reference_close) - maxEntryGapAtr * atr14;
  const levels = side === "LONG" ? market.asks : market.bids;
  const depth = p10Depth(levels, side, boundaryPrice, requestedNotional);
  if (!depth.executable || depth.availableFunds < requestedNotional * LIVE_MIN_DEPTH_BUFFER) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "insufficient P10 gap-capped depth",
    };
  }
  // Place the limit at the strategy's gap boundary. FOK/IOC may improve the fill, but it
  // can never cross beyond 0.50 ATR. This also leaves room to round quantity upward by one
  // venue step so an exact operator minimum (40 USDT spot / 40 USDT futures margin) does
  // not become untradeable after quantity flooring.
  const limitPrice = tickRound(
    boundaryPrice,
    rules.price_tick,
    side === "LONG" ? "down" : "up",
  );
  const finalPlan = combinedEntryPlan(signal, limitPrice);
  if (!finalPlan.allowed) {
    return { entered: false, exchange, market: signal.market, reason: finalPlan.reason };
  }
  const quantity = ceilToStep(
    requestedNotional / limitPrice,
    rules.quantity_step || 0.00000001,
  );
  const orderNotional = quantity * limitPrice;
  const actualCapital = exchange === "binance_futures" ? orderNotional / leverage : orderNotional;
  const overshootAllowance = Math.max(
    exchange === "upbit" ? 1000 : 1,
    marginQuote * 0.05,
  );
  if (actualCapital > marginQuote + overshootAllowance + 1e-8) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "P10 venue quantity step exceeds the ticket overshoot limit",
    };
  }
  const feePct = await liveFeePct(exchange, settings);
  const walletDebit = exchange === "binance_futures"
    ? actualCapital + orderNotional * feePct / 100
    : orderNotional * (1 + feePct / 100);
  if (walletDebit > finite(managed.managedAvailableQuote) + 1e-8) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "P10 ticket plus entry fee exceeds available managed capital",
    };
  }
  if (
    !(quantity > 0) || orderNotional + 1e-8 < Math.max(rules.min_notional, minimumMargin * leverage)
  ) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "P10 quantity below executable minimum",
    };
  }
  const finalDepth = p10Depth(levels, side, boundaryPrice, orderNotional);
  if (!finalDepth.executable || finalDepth.availableFunds < orderNotional * LIVE_MIN_DEPTH_BUFFER) {
    return {
      entered: false,
      exchange,
      market: signal.market,
      reason: "P10 step-rounded quantity exceeds gap-capped depth",
    };
  }

  // Order-time sizing evidence. This is the only place where the configured slot margin,
  // the leverage it is multiplied by and the venue-rounded result are all known, so it is
  // the record used to prove a live fill honoured the exact-margin policy. No credentials.
  await event("P10_ENTRY_SIZING", "P10 entry sizing resolved before order placement", {
    strategy_key: P10_STRATEGY_KEY,
    exchange,
    market: signal.market,
    side,
    slots: clamp(finite((settings as any).scalp_position_slots, 3), 1, 20),
    allocation_mode: exchange === "binance_futures"
      ? String((settings as any).binance_futures_allocation_mode || "ALL")
      : String((settings as any).binance_allocation_mode || "ALL"),
    configured_margin_usdt: configuredFuturesMargin,
    effective_margin_usdt: marginQuote,
    leverage,
    target_notional_usdt: requestedNotional,
    rounded_notional_usdt: orderNotional,
    rounded_margin_usdt: actualCapital,
    quantity,
    price: limitPrice,
  }, { cycleId });

  const claimResult = await rpc("claim_p10_signal", {
    p_venue: signal.venue,
    p_market: signal.market,
    p_signal_time: signal.signal_time,
    p_side: side,
    p_evidence: {
      run_id: signal.run_id,
      score: signal.score,
      reference_close: signal.reference_close,
      evidence: signal.evidence,
      engine_version: VERSION,
    },
  });
  if (claimResult?.claimed !== true) {
    return { entered: false, exchange, market: signal.market, reason: "signal already claimed" };
  }
  const claimId = String(claimResult?.claim?.id || "");
  let position: Position;
  try {
    position = (await insert("trading_positions", {
      exchange,
      quote_currency: quoteCurrency(exchange),
      market: signal.market,
      base_asset: base,
      state: "ENTRY_PENDING",
      is_paper: false,
      strategy_key: P10_STRATEGY_KEY,
      position_side: side,
      leverage,
      reserved_quote: orderNotional,
      reserved_quantity: quantity,
      reservation_expires_at: new Date(Date.now() + 180_000).toISOString(),
      fee_accounting_quality: "LEGACY_UNVERIFIED",
      fee_accounting_version: "8.0.0",
      profile_version: 10,
      planned_entry_price: limitPrice,
      stop_price: tickRound(
        finalPlan.stopPrice,
        rules.price_tick,
        side === "LONG" ? "down" : "up",
      ),
      target_1: tickRound(
        finalPlan.partialTarget,
        rules.price_tick,
        side === "LONG" ? "up" : "down",
      ),
      target_2: tickRound(
        finalPlan.finalTarget,
        rules.price_tick,
        side === "LONG" ? "up" : "down",
      ),
      tick_size: rules.price_tick,
      quantity_step: rules.quantity_step,
      min_notional_quote: Math.max(1, rules.min_notional),
      t1_allocation_pct: isS096ShortSignal(signal) ? 100 : P10_CONFIG.partialFraction * 100,
      exit_policy: "P10_SLOW_4R",
      trailing_stop: tickRound(
        finalPlan.stopPrice,
        rules.price_tick,
        side === "LONG" ? "down" : "up",
      ),
      trailing_distance_pct: null,
      intended_horizon_hours: P10_CONFIG.maxHoldBars,
      max_holding_at: new Date(Date.now() + P10_CONFIG.maxHoldBars * P10_HOUR_MS).toISOString(),
      absolute_max_holding_at: new Date(
        Date.now() + P10_CONFIG.maxHoldBars * P10_HOUR_MS,
      ).toISOString(),
      metadata: {
        strategy_key: P10_STRATEGY_KEY,
        strategy_revision: isS096ShortSignal(signal) ? S096_SHORT_REVISION : P10_REVISION,
        entry_strategy_key: isS096ShortSignal(signal)
          ? S096_SHORT_STRATEGY_KEY
          : String(signal.evidence?.entry_strategy_key || P10_STRATEGY_KEY),
        directional_exit_policy: isS096ShortSignal(signal) ? "S096_FIXED_1P5R" : "P10_SLOW_4R",
        engine_version: VERSION,
        p10_claim_id: claimId,
        p10_signal_run_id: signal.run_id,
        p10_signal_time: signal.signal_time,
        p10_entry_bar_time: Date.parse(signal.signal_time) + P10_HOUR_MS,
        p10_reference_close: finite(signal.reference_close),
        p10_signal_atr14: atr14,
        p10_initial_risk: finalPlan.initialRisk,
        p10_last_policy_bar_time: Date.parse(signal.signal_time),
        p10_partial_fraction: isS096ShortSignal(signal) ? 1 : P10_CONFIG.partialFraction,
        p10_signal: signal,
        margin_quote: actualCapital,
        notional_quote: orderNotional,
        leverage,
        live_spread_bps: spreadBps,
        execution_depth: finalDepth,
      },
    }))[0] as Position;
  } catch (error) {
    const disposition = p10PreOrderEntryDisposition(error);
    await rejectP10Claim(claimId, disposition.reason);
    if (disposition.kind === "POLICY_BLOCK") {
      try {
        await event("P10_ENTRY_POLICY_BLOCK", disposition.reason, {
          strategy_key: P10_STRATEGY_KEY,
          venue: signal.venue,
          market: signal.market,
          side,
          signal_time: signal.signal_time,
          order_submitted: false,
        }, { cycleId, level: "INFO" });
      } catch (eventError) {
        console.error("P10_ENTRY_POLICY_BLOCK_EVENT_FAILED", eventError);
      }
      return {
        entered: false,
        exchange,
        market: signal.market,
        side,
        policy_blocked: true,
        reason: disposition.reason,
      };
    }
    throw error;
  }
  await patch("p10_signal_claims", `id=eq.${claimId}`, {
    position_id: position.id,
    status: "ORDERED",
  });
  const identifier = uniqueId("p10e", position.id);
  const orderSide = p10EntrySide(side);
  const timeInForce = exchange === "upbit" ? "IOC" : "FOK";
  let orderRow: any;
  try {
    orderRow = await createOrderRecord({
      position_id: position.id,
      cycle_id: cycleId,
      exchange,
      quote_currency: quoteCurrency(exchange),
      identifier,
      market: signal.market,
      side: orderSide,
      strategy_key: P10_STRATEGY_KEY,
      position_side: side,
      position_effect: "OPEN",
      purpose: "ENTRY",
      order_type: "LIMIT",
      time_in_force: timeInForce,
      requested_price: limitPrice,
      requested_volume: quantity,
      requested_notional_quote: orderNotional,
      state: "REQUESTED",
    });
  } catch (error) {
    // createOrderRecord is before gateway(create_order), so this path proves that this
    // attempt did not submit an exchange order. Release only this still-pending row.
    const errorMessage = error instanceof Error
      ? error.message
      : String(error ?? "unknown P10 order-record failure");
    const failedAt = new Date().toISOString();
    await patch("trading_positions", `id=eq.${position.id}&state=eq.ENTRY_PENDING`, {
      state: "CANCELLED",
      reserved_quote: 0,
      reserved_quantity: 0,
      reservation_expires_at: null,
      close_reason: "P10_ENTRY_ORDER_RECORD_FAILED",
      closed_at: failedAt,
      metadata: {
        ...(position.metadata || {}),
        p10_entry_order_record_failed_at: failedAt,
        p10_entry_order_record_error: errorMessage,
        p10_entry_order_submitted: false,
      },
    }).catch((cleanupError) =>
      console.error("P10_ENTRY_ORDER_RECORD_CLEANUP_FAILED", cleanupError)
    );
    await rejectP10Claim(claimId, `P10_ENTRY_ORDER_RECORD_FAILED:${errorMessage}`)
      .catch((claimError) =>
        console.error("P10_ENTRY_ORDER_RECORD_CLAIM_REJECT_FAILED", claimError)
      );
    await event("P10_ENTRY_ORDER_RECORD_FAILED", errorMessage, {
      strategy_key: P10_STRATEGY_KEY,
      exchange,
      market: signal.market,
      side,
      position_id: position.id,
      order_submitted: false,
    }, { cycleId, positionId: position.id, level: "WARNING" })
      .catch((eventError) =>
        console.error("P10_ENTRY_ORDER_RECORD_FAILURE_EVENT_FAILED", eventError)
      );
    return {
      entered: false,
      exchange,
      market: signal.market,
      side,
      pre_order_error: true,
      reason: "P10_ENTRY_ORDER_RECORD_FAILED",
    };
  }
  try {
    const result = await gateway(exchange, {
      action: "create_order",
      leverage: exchange === "binance_futures" ? leverage : undefined,
      order: {
        market: signal.market,
        side: orderSide,
        type: "LIMIT",
        price: limitPrice,
        quantity,
        time_in_force: timeInForce,
        identifier,
        position_side: exchange === "binance_futures" ? side : undefined,
        position_effect: exchange === "binance_futures" ? "OPEN" : undefined,
      },
      wait_for_final_ms: 4000,
    }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, result);
    const entryDisposition = p10EntryOrderDisposition({
      status: updated.order?.status,
      executedVolume: updated.fill.executedVolume,
      averagePrice: updated.fill.averagePrice,
    });
    if (entryDisposition !== "APPLY") {
      // A definitive zero-fill FOK/IOC still gets one fill+position cross-check and
      // suppresses the rest of this scan, but it is not a global incident by itself.
      // Unknown or positive-but-incomplete execution evidence is globally latched.
      if (entryDisposition === "RECONCILE") {
        await latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED");
      }
      const reconciled = await patch("trading_positions", `id=eq.${position.id}`, {
        state: "RECONCILING",
        metadata: {
          ...(position.metadata || {}),
          reconciliation_phase: "ENTRY",
          p10_entry_reconciliation_started_at: new Date().toISOString(),
          p10_entry_last_order_status: String(updated.order?.status || "UNKNOWN"),
          p10_entry_known_executed_volume: finite(updated.fill.executedVolume),
          p10_entry_accounting_detail_pending: true,
          p10_entry_terminal_zero_fill_candidate: entryDisposition === "NOT_FILLED",
        },
      });
      await event(
        entryDisposition === "NOT_FILLED"
          ? "P10_ENTRY_TERMINAL_VERIFYING"
          : "P10_ENTRY_RECONCILING",
        `${exchange}:${signal.market} entry requires fill and position reconciliation`,
        {
          identifier,
          side,
          order_status: updated.order?.status || null,
          executed_volume: finite(updated.fill.executedVolume),
          average_price: finite(updated.fill.averagePrice),
        },
        { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" },
      );
      return {
        entered: false,
        reserved: true,
        pending_reconcile: true,
        exchange,
        market: signal.market,
        position: { ...position, ...(reconciled[0] || {}) },
        reason: "P10 entry order still reconciling",
      };
    }
    const accounting = await applyP10EntryAccounting(
      position,
      orderRow,
      updated.order,
      updated.fill,
      signal,
    );
    const opened = accounting.position;
    if (!accounting.applied && !["OPEN", "EXITING", "CLOSED"].includes(opened.state)) {
      throw new Error("P10 entry accounting did not reach a managed lifecycle state");
    }
    // The accounting RPC is the commit boundary. Audit/event delivery is ancillary and
    // must never route a committed OPEN position through the uncertainty catch below.
    try {
      await event("P10_LIVE_ENTRY", `${exchange}:${signal.market} ${side} live entry`, {
        strategy_key: P10_STRATEGY_KEY,
        side,
        exchange_order_id: updated.order?.exchange_order_id || null,
        fill_price: updated.fill.averagePrice,
        quantity: updated.fill.executedVolume,
        margin_quote: actualCapital,
        notional_quote: updated.fill.executedFunds,
        stop_price: opened.stop_price,
        partial_target: opened.target_1,
        final_target: opened.target_2,
      }, { cycleId, positionId: position.id, orderId: orderRow.id });
    } catch (eventError) {
      console.error("P10_LIVE_ENTRY_EVENT_FAILED", eventError);
    }
    return {
      entered: true,
      paper: false,
      exchange,
      market: signal.market,
      side,
      position: opened,
      exchange_order_id: updated.order?.exchange_order_id || null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number((error as any)?.status || 0);
    const failureDisposition = p10EntryFailureDisposition({
      status,
      code: (error as any)?.code,
      message,
    });
    if (failureDisposition === "REJECTED") {
      await patch("trading_orders", `id=eq.${orderRow.id}`, {
        state: "REJECTED",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "P10_ENTRY_REJECTED",
        closed_at: new Date().toISOString(),
      });
      await rejectP10Claim(claimId, message);
      return { entered: false, exchange, market: signal.market, reason: message };
    }
    await latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED");
    await patch("trading_orders", `id=eq.${orderRow.id}&state=neq.APPLIED`, {
      state: "UNKNOWN",
      error_message: message,
    });
    const reconciling = await patch(
      "trading_positions",
      `id=eq.${position.id}&state=in.(ENTRY_PENDING,RECONCILING,RECONCILIATION_FAILED)`,
      {
        state: "RECONCILING",
        metadata: {
          ...(position.metadata || {}),
          reconciliation_phase: "ENTRY",
          p10_entry_reconciliation_started_at: new Date().toISOString(),
          p10_entry_last_error: message,
          p10_entry_last_error_code: (error as any)?.code || null,
        },
      },
    );
    await event(
      "P10_ENTRY_RESULT_UNKNOWN",
      `${exchange}:${signal.market} entry requires reconciliation`,
      {
        identifier,
        side,
        error: message,
      },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" },
    );
    return {
      entered: false,
      reserved: true,
      pending_reconcile: true,
      exchange,
      market: signal.market,
      position: { ...position, ...(reconciling[0] || {}) },
      reason: "P10 entry result unknown; duplicate suppressed",
    };
  }
}

async function p10ScanCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  const exchanges = enabledExchanges(settings);
  const portfolios = {} as Record<Exchange, any>;
  const portfolioCapturedAt = {} as Record<Exchange, string>;
  const stats = {} as Record<Exchange, any>;
  const circuits = {} as Record<Exchange, any>;
  const circuitDiagnostics = {} as Record<Exchange, JsonRecord>;
  const positionSlots = clamp(finite((settings as any).scalp_position_slots, 3), 1, 20);
  const diagnosticNumber = (value: unknown): JsonRecord => {
    const isNull = value === null;
    const isEmptyString = typeof value === "string" && value.trim() === "";
    const numeric = Number(value);
    const isFiniteNumber = !isNull && !isEmptyString && Number.isFinite(numeric);
    return {
      present: value !== undefined,
      is_null: isNull,
      is_empty_string: isEmptyString,
      type: typeof value,
      finite: isFiniteNumber,
      value: isFiniteNumber ? numeric : null,
    };
  };
  // Fan out only the three independent, read-only venue portfolio calls.  The DB-heavy
  // managed/account-stat/circuit pipeline below intentionally remains ordered, avoiding a
  // burst of roughly thirty PostgREST reads that would contend with the two-second risk lane.
  const portfolioExchanges = exchanges.includes("binance_futures")
    ? exchanges
    : [...exchanges, "binance_futures" as Exchange];
  const portfolioLoads = await mapConcurrentOrdered(
    portfolioExchanges,
    async (exchange) => {
      try {
        const raw = await gateway(exchange, { action: "portfolio" });
        return { exchange, raw, capturedAt: new Date().toISOString(), error: null };
      } catch (error) {
        if (exchanges.includes(exchange)) throw error;
        return {
          exchange,
          raw: null,
          capturedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    P10_SCAN_PORTFOLIO_CONCURRENCY,
  );
  let futuresObservationError: string | null = null;
  for (const { exchange, raw, capturedAt, error } of portfolioLoads) {
    if (exchange === "binance_futures" && error) futuresObservationError = error;
    if (error) continue;
    portfolios[exchange] = raw;
    // Snapshot age belongs to the exchange response, not to its later ordered processing.
    portfolioCapturedAt[exchange] = capturedAt;
    if (!exchanges.includes(exchange)) continue;
    const managed = await managedPortfolio(settings, exchange, raw);
    stats[exchange] = await accountStats(
      exchange,
      finite(managed.managed.managedCapitalQuote),
      false,
      raw,
    );
    const limits = exchangeLimits(settings, exchange);
    const managedState = managed.managed || {};
    const managedCapitalQuote = finite(managedState.managedCapitalQuote);
    const bookedExposureQuote = finite(managedState.openCostQuote);
    circuitDiagnostics[exchange] = {
      raw_total_equity_quote: diagnosticNumber(raw?.total_equity_quote),
      raw_available_quote: diagnosticNumber(raw?.available_quote),
      raw_locked_quote: diagnosticNumber(raw?.locked_quote),
      capital_base_quote: finite(managedState.capitalBaseQuote),
      booked_exposure_quote: bookedExposureQuote,
      bot_position_value_quote: finite(managedState.botPositionValueQuote),
      reserved_exposure_quote: finite(managedState.reservedExposureQuote),
      managed_capital_quote: managedCapitalQuote,
      unallocated_within_cap_quote: Math.max(0, managedCapitalQuote - bookedExposureQuote),
      managed_available_quote: finite(managedState.managedAvailableQuote),
      circuit_min_order_quote: limits.minOrder,
    };
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
      availableQuote: finite(managed.managed.managedAvailableQuote),
      minOrderQuote: limits.minOrder,
      openPositionsGlobal: stats[exchange].openGlobal,
      openPositionsExchange: stats[exchange].openExchange,
      entriesTodayGlobal: stats[exchange].entriesTodayGlobal,
      entriesTodayExchange: stats[exchange].entriesTodayExchange,
      dailyBoughtQuote: stats[exchange].dailyBoughtQuote,
      maxDailyBuyQuote: Number.MAX_SAFE_INTEGER,
      dailyPnlPct: stats[exchange].dailyPnlPct,
      weeklyPnlPct: stats[exchange].weeklyPnlPct,
      consecutiveLosses: stats[exchange].consecutiveLosses,
      settings: {
        ...settings,
        max_open_positions: positionSlots,
        max_open_positions_per_exchange: Math.min(
          positionSlots,
          Math.max(1, finite(settings.max_open_positions_per_exchange, positionSlots)),
        ),
        max_daily_entries: Number.MAX_SAFE_INTEGER,
        max_daily_entries_per_exchange: Number.MAX_SAFE_INTEGER,
        max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 30),
        max_weekly_loss_pct: Number.MAX_SAFE_INTEGER,
        max_consecutive_losses: Number.MAX_SAFE_INTEGER,
      },
    });
  }

  // Slow/account-wide maintenance belongs to the 12-second scan lane, not the 2-second
  // stop/target lane.  Snapshots retain idle-account telemetry and the authenticated
  // direction-aware Futures proof used by zero reconciliation.  A telemetry failure never
  // suppresses entry or exit decisions; it is recorded once for operator visibility.
  const maintenanceStartedAt = performance.now();
  const maintenancePositions = await db(
    "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=*",
  ) as Position[];
  if (futuresObservationError) {
    const safetyReason = "P10_FUTURES_EXPOSURE_OBSERVATION_FAILED";
    const newlyLatched = await latchP10EntrySafety(safetyReason);
    if (newlyLatched) {
      await event(
        safetyReason,
        "Binance Futures exposure could not be verified; entries are paused",
        { error: futuresObservationError, strategy_key: P10_STRATEGY_KEY },
        { cycleId, level: "CRITICAL" },
      );
    }
    await patchTradingHeartbeat({ lastFullScanAt: new Date().toISOString() });
    return {
      skipped: true,
      strategy_key: P10_STRATEGY_KEY,
      reason: safetyReason,
      error: futuresObservationError,
    };
  }
  const futuresPortfolio = portfolios.binance_futures;
  const untrackedFutures = futuresPortfolio
    ? untrackedFuturesExposures(
      Array.isArray(futuresPortfolio.positions) ? futuresPortfolio.positions : [],
      maintenancePositions
        .filter((position) => position.exchange === "binance_futures" && !position.is_paper)
        .map((position) => ({
          market: position.market,
          side: position.position_side,
          quantity: Math.max(
            finite(position.remaining_quantity),
            finite((position as any).reserved_quantity),
          ),
        })),
    )
    : [];
  if (untrackedFutures.length) {
    const safetyReason = "P10_UNTRACKED_FUTURES_EXPOSURE";
    const newlyLatched = await latchP10EntrySafety(safetyReason);
    if (newlyLatched) {
      await event(
        safetyReason,
        "Binance Futures exposure has no active directional database position",
        { exposures: untrackedFutures, strategy_key: P10_STRATEGY_KEY },
        { cycleId, level: "CRITICAL" },
      );
    }
    await patchTradingHeartbeat({
      lastFullScanAt: new Date().toISOString(),
      lastGatewayHeartbeatAt: new Date().toISOString(),
    });
    return {
      skipped: true,
      strategy_key: P10_STRATEGY_KEY,
      reason: safetyReason,
      untracked_futures_exposures: untrackedFutures,
    };
  }
  const snapshotPositions = maintenancePositions.filter((position) => position.state === "OPEN");
  const legacyMaintenancePositions = maintenancePositions.filter((position) =>
    !isP10Position(position)
  );
  let feeReconciliations: any[] = [];
  let snapshotErrors: Array<{ exchange: Exchange; error: string }> = [];
  let jointSnapshots = 0;
  let lockVenuesChecked = 0;
  const residualSweeps: any[] = [];
  const maintenanceErrors: Array<{ stage: string; exchange?: Exchange; error: string }> = [];

  // P10 SCAN is the fixed owner even while a legacy position is still being managed by the
  // monitor. Owner selection never depends on a racy position-count snapshot.
  {
    try {
      feeReconciliations = await reconcileFeeLedger(cycleId);
    } catch (error) {
      maintenanceErrors.push({
        stage: "FEE_RECONCILIATION",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // External-flow comparison must finish before the current snapshots become the next
    // baseline. Venue failures remain isolated and never block entry/exit decisions.
    const flowResults = await Promise.allSettled(
      exchanges.map((exchange) =>
        detectExternalQuoteFlow(exchange, portfolios[exchange], settings, cycleId)
      ),
    );
    flowResults.forEach((result, index) => {
      if (result.status === "rejected") {
        maintenanceErrors.push({
          stage: "EXTERNAL_QUOTE_FLOW",
          exchange: exchanges[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    const snapshotResults = await Promise.allSettled(
      exchanges.map((exchange) =>
        snapshotAccount(
          exchange,
          portfolios[exchange],
          snapshotPositions,
          portfolios[exchange]?.prices || {},
          settings,
          portfolioCapturedAt[exchange],
        )
      ),
    );
    snapshotErrors = snapshotResults.flatMap((result, index) =>
      result.status === "rejected"
        ? [{
          exchange: exchanges[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }]
        : []
    );
    maintenanceErrors.push(...snapshotErrors.map((row) => ({
      stage: "ACCOUNT_SNAPSHOT",
      ...row,
    })));

    const jointResults = await Promise.allSettled(
      exchanges.map((exchange) =>
        recordJointObjectiveSnapshot(
          exchange,
          settings,
          portfolios[exchange],
          legacyMaintenancePositions.filter((position) => position.exchange === exchange),
        )
      ),
    );
    jointSnapshots =
      jointResults.filter((result) => result.status === "fulfilled" && result.value).length;
    jointResults.forEach((result, index) => {
      if (result.status === "rejected") {
        maintenanceErrors.push({
          stage: "JOINT_OBJECTIVE_SNAPSHOT",
          exchange: exchanges[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });

    let lockedRows: any[] | null = null;
    try {
      lockedRows = await db("trading_asset_locks?state=eq.LOCKED&select=exchange") as any[];
    } catch (error) {
      maintenanceErrors.push({
        stage: "ASSET_LOCK_DISCOVERY",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const lockedExchanges = new Set(
      (lockedRows || []).map((row) => String(row.exchange) as Exchange),
    );
    const residualSweepEnabled = (settings as any).residual_sweep_enabled !== false;
    const orderBookVenues = exchanges.filter((exchange) =>
      lockedRows === null || lockedExchanges.has(exchange) ||
      (residualSweepEnabled && exchange !== "binance_futures")
    );
    const lockResults = await Promise.allSettled(
      orderBookVenues.map(async (exchange) => {
        const activeExchangePositions = maintenancePositions.filter((position) =>
          position.exchange === exchange
        );
        // One authenticated open-order snapshot is shared by lock cleanup and residual
        // policy. `null` means unknown and suppresses both destructive conclusions.
        const orderAssets = await openOrderAssets(exchange);
        await reconcilePersistedAssetLocks(
          exchange,
          portfolios[exchange],
          activeExchangePositions,
          orderAssets,
          cycleId,
        );
        const sweeps = await sweepResidualInventory(
          exchange,
          settings,
          activeExchangePositions,
          orderAssets,
          cycleId,
        );
        return { exchange, sweeps };
      }),
    );
    lockVenuesChecked = orderBookVenues.length;
    lockResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        residualSweeps.push(...result.value.sweeps);
      } else {
        maintenanceErrors.push({
          stage: "ASSET_LOCK_RESIDUAL",
          exchange: orderBookVenues[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  if (maintenanceErrors.length) {
    await event(
      "P10_SLOW_MAINTENANCE_BATCH_FAILED",
      "one or more P10 slow-maintenance stages failed",
      { errors: maintenanceErrors },
      { cycleId, level: "WARNING" },
    );
  }
  const maintenanceMs = Math.round(performance.now() - maintenanceStartedAt);

  if (!exchanges.some((exchange) => circuits[exchange]?.allowNewEntry)) {
    await event("P10_ENTRY_CIRCUIT_BLOCK", "P10 new entries blocked on all exchanges", {
      strategy_key: P10_STRATEGY_KEY,
      circuits,
      circuit_diagnostics: circuitDiagnostics,
      stats,
    }, { cycleId, level: "WARNING" });
    await patchTradingHeartbeat({
      lastFullScanAt: new Date().toISOString(),
      lastGatewayHeartbeatAt: new Date().toISOString(),
    });
    return {
      skipped: true,
      strategy_key: P10_STRATEGY_KEY,
      circuits,
      stats,
      maintenance: {
        owner: "P10_SCAN",
        fee_reconciliations: feeReconciliations.length,
        snapshot_errors: snapshotErrors,
        joint_snapshots: jointSnapshots,
        lock_venues_checked: lockVenuesChecked,
        residual_sweeps: residualSweeps.length,
        errors: maintenanceErrors,
        duration_ms: maintenanceMs,
      },
    };
  }

  const signals = await loadP10Signals();
  const active = await db(
    "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)&select=id,exchange,market,base_asset",
  ) as any[];
  const activeMarkets = new Set(active.map((row) => `${row.exchange}:${row.market}`));
  const entries: any[] = [];
  const maxNew = Math.max(
    0,
    Math.min(
      positionSlots - active.length,
      Math.floor(finite(settings.max_new_entries_per_scan, positionSlots)),
    ),
  );
  for (const signal of signals) {
    if (entries.filter((entry) => entry.entered || entry.reserved).length >= maxNew) break;
    const exchange = p10VenueExchange(signal.venue);
    if (
      !exchanges.includes(exchange) || !circuits[exchange]?.allowNewEntry ||
      activeMarkets.has(`${exchange}:${signal.market}`)
    ) continue;
    try {
      const result = await enterP10Signal(signal, settings, portfolios[exchange], cycleId);
      entries.push({ ...result, signal_time: signal.signal_time, score: signal.score });
      if (result.entered || result.reserved) {
        activeMarkets.add(`${exchange}:${signal.market}`);
      }
      if (result.pending_reconcile) break;
    } catch (error) {
      const disposition = p10PreOrderEntryDisposition(error);
      if (disposition.kind === "POLICY_BLOCK") {
        entries.push({
          entered: false,
          exchange,
          market: signal.market,
          side: signal.side,
          policy_blocked: true,
          reason: disposition.reason,
        });
        try {
          await event("P10_ENTRY_POLICY_BLOCK", disposition.reason, {
            strategy_key: P10_STRATEGY_KEY,
            venue: signal.venue,
            market: signal.market,
            side: signal.side,
            signal_time: signal.signal_time,
            order_submitted: false,
            caught_at: "P10_SCAN",
          }, { cycleId, level: "INFO" });
        } catch (eventError) {
          console.error("P10_ENTRY_POLICY_BLOCK_EVENT_FAILED", eventError);
        }
        continue;
      }
      entries.push({
        entered: false,
        exchange,
        market: signal.market,
        side: signal.side,
        pre_order_error: true,
        error: disposition.reason,
      });
      try {
        await event("P10_ENTRY_PREORDER_ERROR", disposition.reason, {
          strategy_key: P10_STRATEGY_KEY,
          venue: signal.venue,
          market: signal.market,
          side: signal.side,
          signal_time: signal.signal_time,
          order_submitted: false,
        }, { cycleId, level: "CRITICAL" });
      } catch (eventError) {
        console.error("P10_ENTRY_PREORDER_ERROR_EVENT_FAILED", eventError);
      }
      // Only enterP10Signal owns post-submit reconciliation. This catch has no durable
      // proof that an exchange order was sent, so it must never globally latch entries.
      break;
    }
  }
  const heartbeatAt = new Date().toISOString();
  await patchTradingHeartbeat({
    lastFullScanAt: heartbeatAt,
    lastGatewayHeartbeatAt: heartbeatAt,
    gatewayErrorCount: 0,
  });
  const routinePolicyOnly = entries.length > 0 &&
    entries.every((row) => row.policy_blocked === true || row.reason === "signal already claimed");
  await event(
    "P10_SCAN_SUMMARY",
    `${entries.filter((row) => row.entered).length} P10 entries filled`,
    {
      strategy_key: P10_STRATEGY_KEY,
      revision: P10_REVISION,
      eligible_signals: signals.length,
      attempted: entries.length,
      filled: entries.filter((row) => row.entered).length,
      reserved: entries.filter((row) => row.reserved).length,
      rejections: entries.filter((row) => !row.entered && !row.reserved).map((row) => ({
        exchange: row.exchange,
        market: row.market,
        reason: row.reason || row.error,
      })),
    },
    {
      cycleId,
      level: entries.some((row) => row.entered || row.reserved) || routinePolicyOnly
        ? "INFO"
        : "WARNING",
    },
  );
  return {
    strategy_key: P10_STRATEGY_KEY,
    revision: P10_REVISION,
    eligible_signals: signals.length,
    entries,
    circuits,
    stats,
    maintenance: {
      owner: "P10_SCAN",
      fee_reconciliations: feeReconciliations.length,
      snapshot_errors: snapshotErrors,
      joint_snapshots: jointSnapshots,
      lock_venues_checked: lockVenuesChecked,
      residual_sweeps: residualSweeps.length,
      errors: maintenanceErrors,
      duration_ms: maintenanceMs,
    },
  };
}

async function p10FetchJson(url: string, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "trading-booooo-p10-monitor/1.0" },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`P10 market data ${response.status}: ${text.slice(0, 240)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function p10CompletedBars(position: Position): Promise<P10Bar[]> {
  const end = Math.floor(Date.now() / P10_HOUR_MS) * P10_HOUR_MS - 1;
  if (position.exchange === "upbit") {
    const to = new Date(end + 1).toISOString();
    const payload = await p10FetchJson(
      `https://api.upbit.com/v1/candles/minutes/60?market=${encodeURIComponent(position.market)}` +
        `&count=140&to=${encodeURIComponent(to)}`,
      1_500,
    );
    return (Array.isArray(payload) ? payload : []).map((row: any) => ({
      time: Date.parse(String(row?.candle_date_time_utc || "") + "Z"),
      open: finite(row?.opening_price),
      high: finite(row?.high_price),
      low: finite(row?.low_price),
      close: finite(row?.trade_price),
      volume: finite(row?.candle_acc_trade_volume),
      quoteVolume: finite(row?.candle_acc_trade_price),
    }));
  }
  const futures = position.exchange === "binance_futures";
  const base = futures ? "https://fapi.binance.com" : "https://api.binance.com";
  const endpoint = futures ? "/fapi/v1/klines" : "/api/v3/klines";
  const payload = await p10FetchJson(
    `${base}${endpoint}?symbol=${encodeURIComponent(position.market)}` +
      `&interval=1h&endTime=${end}&limit=140`,
    1_500,
  );
  return (Array.isArray(payload) ? payload : []).map((row: any[]) => ({
    time: finite(row?.[0]),
    open: finite(row?.[1]),
    high: finite(row?.[2]),
    low: finite(row?.[3]),
    close: finite(row?.[4]),
    volume: finite(row?.[5]),
    quoteVolume: finite(row?.[7]),
  }));
}

async function loadP10MarketRiskObservations(): Promise<{
  observations: P10MarketRiskObservation[];
  error: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  const since = new Date(Date.now() - P10_MARKET_RISK_CONFIG.historyMaxAgeMs).toISOString();
  try {
    const observations = await db(
      `market_regime_observations?model_revision=eq.${
        encodeURIComponent(P10_MARKET_RISK_CONFIG.modelRevision)
      }` +
        "&trading_influence=eq.true" +
        `&observed_at=gte.${encodeURIComponent(since)}` +
        "&select=id,observation_bucket,observed_at,model_revision,predicted_regime,bull_score,confidence,sample_size,trading_influence,features" +
        "&order=observed_at.desc&limit=8",
      { signal: controller.signal },
    ) as P10MarketRiskObservation[];
    return { observations: Array.isArray(observations) ? observations : [], error: null };
  } catch (error) {
    return {
      observations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function applyP10ExitAccounting(
  position: Position,
  orderRow: any,
  fill: any,
  action: string,
  fallbackPrice: number,
  nextStop: number,
) {
  const quantity = finite(fill.executedVolume);
  const price = finite(fill.averagePrice, fallbackPrice);
  if (!(quantity > 0 && price > 0)) throw new Error("P10 exit fill has no executable quantity");
  return await rpc("apply_p10_exit_order", {
    p_order_id: orderRow.id,
    p_action: action,
    p_fill_price: price,
    p_fill_quantity: quantity,
    p_fill_funds: finite(fill.executedFunds, price * quantity),
    p_fill_fee_quote: finite(fill.paidFeeQuote, fill.paidFee),
    p_next_stop: nextStop,
  });
}

async function latchP10EntrySafety(reason: string) {
  const result = await rpc("latch_p10_entry_safety", { p_reason: reason });
  return result?.changed === true;
}

async function loadP10LinkedEntryFills(position: Position, orderRow: any) {
  const exchangeOrderId = String(orderRow.exchange_order_id || "");
  const identifier = String(orderRow.identifier || "");
  const select =
    "id,exchange,market,bot_order_id,exchange_order_id,client_order_id,side,price,quantity,quote_amount,fee_quote_amount,fee_amount,fee_asset,executed_at,exchange_trade_id,raw_response";
  const scope = `exchange=eq.${encodeURIComponent(position.exchange)}` +
    `&market=eq.${encodeURIComponent(position.market)}`;
  const identityQueries = [
    `exchange_trade_fills?${scope}&bot_order_id=eq.${orderRow.id}&select=${select}`,
    ...(exchangeOrderId
      ? [
        `exchange_trade_fills?${scope}` +
        `&exchange_order_id=eq.${encodeURIComponent(exchangeOrderId)}` +
        `&select=${select}`,
      ]
      : []),
    ...(identifier
      ? [
        `exchange_trade_fills?${scope}` +
        `&client_order_id=eq.${encodeURIComponent(identifier)}` +
        `&select=${select}`,
      ]
      : []),
  ];
  const [identityResults, positionRows] = await Promise.all([
    Promise.all(identityQueries.map((path) => db(path) as Promise<any[]>)),
    db(
      `exchange_trade_fills?position_id=eq.${position.id}&select=${select}` +
        "&order=executed_at.asc,exchange_trade_id.asc&limit=1000",
    ) as Promise<any[]>,
  ]);
  const linkedByTradeId = new Map<string, any>();
  for (const row of identityResults.flat()) {
    if (
      String(row.exchange || "") !== String(position.exchange) ||
      String(row.market || "").toUpperCase() !== String(position.market).toUpperCase()
    ) {
      throw new Error("linked entry fill escaped its exchange/market scope");
    }
    const key = row.id
      ? `id:${row.id}`
      : `trade:${row.exchange_trade_id}:${row.executed_at}:${row.price}:${row.quantity}`;
    linkedByTradeId.set(key, row);
  }
  const linked = [...linkedByTradeId.values()].sort((a, b) =>
    String(a.executed_at || "").localeCompare(String(b.executed_at || "")) ||
    String(a.exchange_trade_id || "").localeCompare(String(b.exchange_trade_id || ""))
  );
  const entrySide = p10EntrySide(String(position.position_side || "LONG") as P10Side);
  return {
    rows: linked,
    opposingRows: (positionRows || []).filter((row) =>
      String(row.side || "").toUpperCase() !== entrySide && finite(row.quantity) > 0
    ),
    summary: summarizeP10LinkedEntryFills(linked, entrySide),
  };
}

async function p10EntryExposureProof(position: Position, expectedQuantity: number) {
  const portfolio = await p10PositionPortfolio(position.exchange);
  const exchangeQuantity = p10ExchangeQuantity(position, portfolio);
  const exchangePosition = position.exchange === "binance_futures"
    ? (Array.isArray(portfolio?.positions) ? portfolio.positions : []).find((item: any) =>
      String(item?.market || "").toUpperCase() === String(position.market).toUpperCase() &&
      String(item?.side || "").toUpperCase() === String(position.position_side).toUpperCase()
    )
    : null;
  const tolerance = Math.max(0.000000000001, finite(position.quantity_step) / 2);
  return {
    exchangeQuantity,
    entryPrice: Math.max(0, finite(exchangePosition?.entry_price)),
    tolerance,
    matches: expectedQuantity > 0 && Math.abs(exchangeQuantity - expectedQuantity) <= tolerance,
  };
}

async function p10TerminalEntryRecoveryBlockReason(
  position: Position,
  orderRow: any,
  durable: Awaited<ReturnType<typeof loadP10LinkedEntryFills>>,
  exposure: Awaited<ReturnType<typeof p10EntryExposureProof>>,
) {
  const hasTerminalHistory = ["CANCELLED", "ERROR"].includes(position.state) ||
    ["CANCELLED", "ERROR"].includes(
      String(position.metadata?.p10_entry_previous_terminal_state || ""),
    );
  if (!hasTerminalHistory) return null;
  if (position.exchange !== "binance_futures") {
    return "automatic terminal recovery is restricted to direction-aware futures evidence";
  }
  if (!durable.summary.valid) return "terminal recovery requires durable entry fills";
  if (durable.opposingRows.length) return "linked opposing fills exist after the entry";

  const siblings = await db(
    `trading_positions?exchange=eq.${position.exchange}` +
      `&market=eq.${encodeURIComponent(position.market)}` +
      `&id=neq.${position.id}` +
      "&state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)" +
      "&select=id&limit=1",
  ) as any[];
  if (siblings.length) return `active sibling position ${siblings[0].id} exists`;

  if (!(exposure.entryPrice > 0)) return "live futures entry price is unavailable";
  const priceTolerance = Math.max(
    finite(position.tick_size) * 1.01,
    durable.summary.averagePrice * 0.000001,
  );
  if (Math.abs(exposure.entryPrice - durable.summary.averagePrice) > priceTolerance) {
    return "live entry price does not match the durable fill VWAP";
  }

  const executedAt = durable.summary.executedAt;
  if (!executedAt) return "durable entry fill time is unavailable";
  const opposingSide = p10ExitSide(String(position.position_side || "LONG") as P10Side);
  const laterOpposing = await db(
    `exchange_trade_fills?exchange=eq.${position.exchange}` +
      `&market=eq.${encodeURIComponent(position.market)}` +
      `&side=eq.${opposingSide}` +
      `&executed_at=gte.${encodeURIComponent(executedAt)}` +
      "&select=id&limit=1",
  ) as any[];
  if (laterOpposing.length) return "later opposing market fill breaks terminal entry lineage";

  const orderId = String(orderRow.exchange_order_id || "");
  if (!orderId && !String(orderRow.identifier || "")) {
    return "entry order has no durable exchange identifier";
  }
  return null;
}

async function markP10EntryReconciling(
  position: Position,
  orderRow: any,
  cycleId: string,
  reason: string,
  evidence: JsonRecord = {},
) {
  const safetyReason = "P10_ENTRY_RECONCILIATION_REQUIRED";
  const newlyLatched = await latchP10EntrySafety(safetyReason);
  const now = new Date().toISOString();
  const rows = await patch(
    "trading_positions",
    `id=eq.${position.id}&state=in.(ENTRY_PENDING,RECONCILING,RECONCILIATION_FAILED,CANCELLED,ERROR)`,
    {
      state: "RECONCILING",
      closed_at: null,
      close_reason: null,
      metadata: {
        ...(position.metadata || {}),
        reconciliation_phase: "ENTRY",
        p10_entry_reconciliation_started_at:
          position.metadata?.p10_entry_reconciliation_started_at ||
          now,
        p10_entry_reconciliation_checked_at: now,
        p10_entry_reconciliation_reason: reason,
        p10_entry_previous_terminal_state: ["CANCELLED", "ERROR"].includes(position.state)
          ? position.state
          : position.metadata?.p10_entry_previous_terminal_state || null,
        p10_entry_previous_close_reason: position.close_reason ||
          position.metadata?.p10_entry_previous_close_reason || null,
        ...evidence,
      },
    },
  );
  if (newlyLatched || position.metadata?.p10_entry_reconciliation_reason !== reason) {
    await event(
      "P10_ENTRY_RECONCILIATION_REQUIRED",
      `${position.exchange}:${position.market} entry remains uncertain; entries are paused`,
      { reason, safety_newly_latched: newlyLatched, ...evidence },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" },
    );
  }
  if (rows[0]) return rows[0];
  const current = await db(`trading_positions?id=eq.${position.id}&select=*&limit=1`).catch(
    () => [],
  );
  return current?.[0] || position;
}

async function applyP10RecoveredEntry(
  position: Position,
  orderRow: any,
  gatewayOrder: any,
  fill: {
    executedVolume: number;
    executedFunds: number;
    averagePrice: number;
    paidFeeQuote: number;
    feeAsset?: string | null;
    feeQuoteComplete?: boolean;
    executedAt?: string | null;
  },
  linkedRows: any[],
  cycleId: string,
  source: "ORDER" | "EXCHANGE_FILLS",
) {
  const signal = position.metadata?.p10_signal as P10SignalRow;
  const accounting = await applyP10EntryAccounting(
    position,
    orderRow,
    gatewayOrder,
    fill,
    signal,
  );
  const opened = accounting.position;
  if (!accounting.applied && !["OPEN", "EXITING", "CLOSED"].includes(opened.state)) {
    throw new Error("P10 recovered entry accounting did not reach a managed lifecycle state");
  }
  // Once the RPC commits, lifecycle state is monotonic and belongs to the RPC alone.
  // Every write below is ancillary and isolated so an audit/ledger outage cannot demote
  // an OPEN position or resurrect one that already advanced to EXITING/CLOSED.
  const ancillaryErrors: Array<{ stage: string; error: string }> = [];
  const ancillary = async (stage: string, operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      ancillaryErrors.push({
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (linkedRows.length) {
    const normalizedRows = linkedRows.map((row: any) => ({
      order_id: orderRow.id,
      trade_id: String(row.exchange_trade_id),
      price: finite(row.price),
      volume: finite(row.quantity),
      funds_quote: row.quote_amount == null
        ? finite(row.price) * finite(row.quantity)
        : finite(row.quote_amount),
      fee_amount: Math.max(0, finite(row.fee_amount)),
      fee_asset: row.fee_asset || null,
      fee_quote_estimate: row.fee_quote_amount != null
        ? Math.max(0, finite(row.fee_quote_amount))
        : ["USDT", "USDC", "BUSD", "FDUSD"].includes(
            String(row.fee_asset || "").toUpperCase(),
          )
        ? Math.max(0, finite(row.fee_amount))
        : 0,
      executed_at: row.executed_at || null,
      raw: row.raw_response || row,
    }));
    await ancillary("TRADING_FILLS", () =>
      db("trading_fills?on_conflict=order_id,trade_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(normalizedRows),
      }));
  }
  if (!accounting.applied && ["EXITING", "CLOSED"].includes(opened.state)) {
    if (ancillaryErrors.length) {
      console.error("P10_ENTRY_LEDGER_BACKFILL_FAILED_AFTER_LIFECYCLE_ADVANCE", ancillaryErrors);
    }
    return opened;
  }
  const recoveredAt = new Date().toISOString();
  let refreshed: any[] = [];
  await ancillary("POSITION_DETAIL", async () => {
    refreshed = await patch("trading_positions", `id=eq.${position.id}&state=eq.OPEN`, {
      opened_at: fill.executedAt || opened.opened_at || recoveredAt,
      metadata: {
        ...(opened.metadata || position.metadata || {}),
        reconciliation_phase: null,
        p10_entry_accounting_detail_pending: false,
        p10_entry_recovered_at: recoveredAt,
        p10_entry_recovery_source: source,
        p10_entry_recovery_fill_count: linkedRows.length,
        p10_entry_previous_terminal_state: ["CANCELLED", "ERROR"].includes(position.state)
          ? position.state
          : position.metadata?.p10_entry_previous_terminal_state || null,
        p10_entry_previous_close_reason: position.close_reason ||
          position.metadata?.p10_entry_previous_close_reason || null,
      },
    });
  });
  await ancillary(
    "ORDER_DETAIL",
    () =>
      patch("trading_orders", `id=eq.${orderRow.id}&state=eq.APPLIED`, {
        executed_volume: fill.executedVolume,
        average_fill_price: fill.averagePrice,
        executed_funds_quote: fill.executedFunds,
        paid_fee_quote: fill.paidFeeQuote,
        fee_asset: fill.feeAsset || orderRow.fee_asset || null,
        fee_accounting_quality: linkedRows.length
          ? fill.feeQuoteComplete === false ? "MISSING" : "EXACT"
          : orderRow.fee_accounting_quality,
        fee_quote_source: linkedRows.length
          ? fill.feeQuoteComplete === false ? "MISSING" : "PER_FILL_QUOTE"
          : orderRow.fee_quote_source,
        fee_reconciled_at: linkedRows.length && fill.feeQuoteComplete !== false
          ? recoveredAt
          : orderRow.fee_reconciled_at,
        fee_reconcile_next_at: linkedRows.length && fill.feeQuoteComplete === false
          ? new Date(Date.now() + 60_000).toISOString()
          : orderRow.fee_reconcile_next_at,
        completed_at: orderRow.completed_at || recoveredAt,
      }),
  );
  const claimId = String(position.metadata?.p10_claim_id || "");
  if (claimId) {
    await ancillary("SIGNAL_CLAIM", () =>
      patch("p10_signal_claims", `id=eq.${claimId}`, {
        status: "FILLED",
        position_id: position.id,
        reason: null,
      }));
  }
  await ancillary("RECOVERY_EVENT", () =>
    event(
      position.state === "CANCELLED" || position.state === "ERROR"
        ? "P10_ENTRY_RECOVERED_FROM_EXCHANGE_FILLS"
        : "P10_ENTRY_RECONCILED",
      `${position.exchange}:${position.market} entry applied from ${source.toLowerCase()} evidence`,
      {
        source,
        exchange_order_id: gatewayOrder?.exchange_order_id || orderRow.exchange_order_id || null,
        side: position.position_side,
        fill_price: fill.averagePrice,
        quantity: fill.executedVolume,
        fill_count: linkedRows.length,
      },
      { cycleId, positionId: position.id, orderId: orderRow.id },
    ));
  if (ancillaryErrors.length) {
    console.error("P10_ENTRY_RECOVERY_ANCILLARY_FAILED", ancillaryErrors);
    await event(
      "P10_ENTRY_RECOVERY_ANCILLARY_FAILED",
      `${position.exchange}:${position.market} entry is managed but ancillary recovery writes failed`,
      { source, errors: ancillaryErrors },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "WARNING" },
    ).catch(() => null);
  }
  const current = refreshed[0] || (await db(
    `trading_positions?id=eq.${position.id}&select=*&limit=1`,
  ).catch(() => []))?.[0];
  const recovered = current || opened;
  return recovered;
}

async function reconcileP10Order(position: Position, cycleId: string) {
  const currentlyTerminal = ["CANCELLED", "ERROR"].includes(position.state);
  const reconcilingEntry = ["ENTRY_PENDING", "RECONCILING", "RECONCILIATION_FAILED"].includes(
    position.state,
  ) && (position.state === "ENTRY_PENDING" || position.metadata?.reconciliation_phase === "ENTRY");
  const entryReconciliation = currentlyTerminal || reconcilingEntry;
  const recoveringTerminal = currentlyTerminal ||
    (entryReconciliation && ["CANCELLED", "ERROR"].includes(
      String(position.metadata?.p10_entry_previous_terminal_state || ""),
    ));
  const states = entryReconciliation
    ? "REQUESTED,UNKNOWN,EXCHANGE_OPEN,EXCHANGE_PARTIAL,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED,EXCHANGE_CANCELLED,REJECTED,APPLIED"
    : "REQUESTED,UNKNOWN,EXCHANGE_OPEN,EXCHANGE_PARTIAL,EXCHANGE_DONE,EXCHANGE_PARTIAL_CANCELLED,EXCHANGE_CANCELLED";
  const rows = await db(
    `trading_orders?position_id=eq.${position.id}` +
      `&state=in.(${states})` +
      (entryReconciliation ? "&purpose=eq.ENTRY" : "") +
      "&select=*&order=requested_at.desc&limit=1",
  ) as any[];
  const orderRow = rows[0];
  if (!orderRow) {
    if (
      !entryReconciliation || position.state !== "ENTRY_PENDING" ||
      !p10PendingReservationExpired({
        state: position.state,
        reservationExpiresAt: position.reservation_expires_at,
        createdAt: position.created_at,
        nowMs: Date.now(),
      })
    ) {
      return { reconciled: false, reason: "no pending P10 order" };
    }

    // Missing from the normal reconciliation-state query is not sufficient evidence to
    // release capital. Prove there is no ENTRY order row in any state first.
    const anyEntryOrders = await db(
      `trading_orders?position_id=eq.${position.id}&purpose=eq.ENTRY&select=id,state&limit=1`,
    ) as any[];
    if (anyEntryOrders.length) {
      await latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED");
      await event(
        "P10_ORPHAN_ENTRY_ORDER_STATE_MISMATCH",
        `${position.exchange}:${position.market} has an entry order outside the reconciliation state set`,
        {
          order_id: anyEntryOrders[0]?.id || null,
          order_state: anyEntryOrders[0]?.state || null,
          reservation_released: false,
        },
        { cycleId, positionId: position.id, level: "CRITICAL" },
      ).catch(() => null);
      return { reconciled: false, reason: "P10 entry order exists outside reconcilable states" };
    }

    // Prove zero directional exchange exposure before releasing the reservation. A failed
    // proof or a live position is fail-closed and latches new P10 entries for reconciliation.
    let exposure: Awaited<ReturnType<typeof p10EntryExposureProof>>;
    try {
      exposure = await p10EntryExposureProof(position, 0);
    } catch (error) {
      await latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED");
      await event(
        "P10_ORPHAN_ENTRY_EXPOSURE_PROOF_FAILED",
        `${position.exchange}:${position.market} exchange exposure could not be proven before orphan cleanup`,
        {
          error: error instanceof Error ? error.message : String(error),
          reservation_released: false,
        },
        { cycleId, positionId: position.id, level: "CRITICAL" },
      ).catch(() => null);
      return { reconciled: false, reason: "P10 orphan exchange exposure proof failed" };
    }

    if (exposure.exchangeQuantity > exposure.tolerance) {
      await latchP10EntrySafety("P10_ENTRY_RECONCILIATION_REQUIRED");
      const detectedAt = new Date().toISOString();
      const flagged = await patch(
        "trading_positions",
        `id=eq.${position.id}&state=eq.ENTRY_PENDING`,
        {
          state: "RECONCILIATION_FAILED",
          metadata: {
            ...(position.metadata || {}),
            reconciliation_phase: "ENTRY",
            p10_entry_accounting_detail_pending: true,
            p10_orphan_entry_exposure_detected_at: detectedAt,
            p10_orphan_entry_exchange_quantity: exposure.exchangeQuantity,
            p10_orphan_entry_exposure_tolerance: exposure.tolerance,
          },
        },
      );
      await event(
        "P10_ORPHAN_ENTRY_LIVE_EXPOSURE",
        `${position.exchange}:${position.market} orphan pending retained because live exposure exists`,
        {
          exchange_quantity: exposure.exchangeQuantity,
          tolerance: exposure.tolerance,
          reservation_released: false,
        },
        { cycleId, positionId: position.id, level: "CRITICAL" },
      ).catch(() => null);
      return {
        reconciled: false,
        reason: "P10 orphan entry has live exchange exposure",
        position: flagged[0] || position,
      };
    }

    const cancelledAt = new Date().toISOString();
    const cancelled = await patch(
      "trading_positions",
      `id=eq.${position.id}&state=eq.ENTRY_PENDING`,
      {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "P10_ORPHAN_ENTRY_EXPIRED",
        closed_at: cancelledAt,
        metadata: {
          ...(position.metadata || {}),
          p10_orphan_entry_cancelled_at: cancelledAt,
          p10_orphan_entry_zero_exposure_proven: true,
        },
      },
    );
    if (!cancelled.length) {
      return { reconciled: false, reason: "P10 orphan entry changed concurrently" };
    }
    const claimId = String(position.metadata?.p10_claim_id || "");
    if (claimId) {
      await rejectP10Claim(claimId, "P10_ORPHAN_ENTRY_EXPIRED").catch(() => null);
    }
    await event(
      "P10_ORPHAN_ENTRY_CANCELLED",
      `${position.exchange}:${position.market} expired orphan pending reservation released`,
      {
        order_row_count: 0,
        exchange_quantity: exposure.exchangeQuantity,
        tolerance: exposure.tolerance,
        reservation_released: true,
      },
      { cycleId, positionId: position.id, level: "WARNING" },
    ).catch(() => null);
    return { reconciled: true, cancelled: cancelled[0], source: "ORPHAN_ENTRY_EXPIRED" };
  }
  try {
    if (orderRow.purpose === "ENTRY") {
      const durable = await loadP10LinkedEntryFills(position, orderRow);
      if (durable.summary.valid) {
        const exposure = await p10EntryExposureProof(position, durable.summary.executedVolume);
        const lineageBlock = await p10TerminalEntryRecoveryBlockReason(
          position,
          orderRow,
          durable,
          exposure,
        );
        if (exposure.matches && !lineageBlock) {
          const opened = await applyP10RecoveredEntry(
            position,
            orderRow,
            orderRow.raw_response || {},
            {
              executedVolume: durable.summary.executedVolume,
              executedFunds: durable.summary.executedFunds,
              averagePrice: durable.summary.averagePrice,
              paidFeeQuote: durable.summary.paidFeeQuote,
              feeAsset: durable.summary.feeAsset,
              feeQuoteComplete: durable.summary.feeQuoteComplete,
              executedAt: durable.summary.executedAt,
            },
            durable.rows,
            cycleId,
            "EXCHANGE_FILLS",
          );
          return { reconciled: true, opened, source: "EXCHANGE_FILLS" };
        }
        const reconciling = await markP10EntryReconciling(
          position,
          orderRow,
          cycleId,
          lineageBlock || "durable entry fills do not match the live directional position",
          {
            durable_fill_quantity: durable.summary.executedVolume,
            exchange_quantity: exposure.exchangeQuantity,
            exchange_entry_price: exposure.entryPrice,
            lineage_block_reason: lineageBlock,
          },
        );
        return {
          reconciled: false,
          reconciling,
          reason: lineageBlock || "entry exposure mismatch",
        };
      }

      const persistedDisposition = p10EntryOrderDisposition({
        status: orderRow.raw_response?.status || orderRow.state,
        executedVolume: orderRow.executed_volume,
        averagePrice: orderRow.average_fill_price,
      });
      if (persistedDisposition === "APPLY") {
        const quantity = finite(orderRow.executed_volume);
        const exposure = await p10EntryExposureProof(position, quantity);
        if (exposure.matches && !recoveringTerminal) {
          const opened = await applyP10RecoveredEntry(
            position,
            orderRow,
            orderRow.raw_response || {},
            {
              executedVolume: quantity,
              executedFunds: finite(
                orderRow.executed_funds_quote,
                quantity * finite(orderRow.average_fill_price),
              ),
              averagePrice: finite(orderRow.average_fill_price),
              paidFeeQuote: finite(orderRow.paid_fee_quote),
              feeAsset: orderRow.fee_asset || null,
              executedAt: orderRow.completed_at || null,
            },
            [],
            cycleId,
            "ORDER",
          );
          return { reconciled: true, opened, source: "ORDER" };
        }
      }
    }

    const payload = await gateway(position.exchange, {
      action: "get_order",
      identifier: orderRow.identifier,
      market: position.market,
      exchange_order_id: orderRow.exchange_order_id || null,
    }, P10_FAST_GATEWAY_TIMEOUT_MS);
    const updated = await updateOrderFromGateway(orderRow, payload);
    if (orderRow.purpose === "ENTRY") {
      const disposition = p10EntryOrderDisposition({
        status: updated.order?.status,
        executedVolume: updated.fill.executedVolume,
        averagePrice: updated.fill.averagePrice,
      });
      if (disposition === "APPLY") {
        const quantity = finite(updated.fill.executedVolume);
        const exposure = await p10EntryExposureProof(position, quantity);
        if (exposure.matches && !recoveringTerminal) {
          const opened = await applyP10RecoveredEntry(
            position,
            orderRow,
            updated.order,
            {
              executedVolume: quantity,
              executedFunds: finite(
                updated.fill.executedFunds,
                quantity * finite(updated.fill.averagePrice),
              ),
              averagePrice: finite(updated.fill.averagePrice),
              paidFeeQuote: finite(updated.fill.paidFeeQuote, updated.fill.paidFee),
              feeAsset: updated.fill.feeAsset || updated.order?.fee_asset || null,
              executedAt: updated.order?.completed_at || null,
            },
            [],
            cycleId,
            "ORDER",
          );
          return { reconciled: true, opened, source: "ORDER" };
        }
        const reconciling = await markP10EntryReconciling(
          position,
          orderRow,
          cycleId,
          "order execution does not match the live directional position",
          {
            order_executed_quantity: quantity,
            exchange_quantity: exposure.exchangeQuantity,
            exchange_entry_price: exposure.entryPrice,
            terminal_recovery_requires_durable_fills: recoveringTerminal,
          },
        );
        return { reconciled: false, reconciling, reason: "entry exposure mismatch" };
      }
      if (disposition === "RECONCILE") {
        const exposure = await p10EntryExposureProof(position, finite(updated.fill.executedVolume));
        const reconciling = await markP10EntryReconciling(
          position,
          orderRow,
          cycleId,
          "order status or accounting detail remains uncertain",
          {
            order_status: String(updated.order?.status || "UNKNOWN"),
            order_executed_quantity: finite(updated.fill.executedVolume),
            order_average_price: finite(updated.fill.averagePrice),
            exchange_quantity: exposure.exchangeQuantity,
          },
        );
        return { reconciled: false, reconciling, reason: "entry remains uncertain" };
      }

      const durable = await loadP10LinkedEntryFills(position, orderRow);
      const exposure = await p10EntryExposureProof(position, 0);
      if (durable.summary.executedVolume > 0 || exposure.exchangeQuantity > exposure.tolerance) {
        const reconciling = await markP10EntryReconciling(
          position,
          orderRow,
          cycleId,
          "terminal zero-fill status conflicts with fill or position evidence",
          {
            order_status: String(updated.order?.status || "UNKNOWN"),
            durable_fill_quantity: durable.summary.executedVolume,
            exchange_quantity: exposure.exchangeQuantity,
          },
        );
        return { reconciled: false, reconciling, reason: "terminal evidence conflict" };
      }
      const now = new Date().toISOString();
      await patch("trading_positions", `id=eq.${position.id}`, {
        state: "CANCELLED",
        reserved_quote: 0,
        reserved_quantity: 0,
        reservation_expires_at: null,
        close_reason: "P10_ENTRY_TERMINAL_NO_FILL",
        closed_at: position.closed_at || now,
        metadata: {
          ...(position.metadata || {}),
          reconciliation_phase: null,
          p10_entry_terminal_verified_at: now,
          p10_entry_terminal_verified_status: String(updated.order?.status || "UNKNOWN"),
          p10_entry_terminal_verified_exchange_quantity: exposure.exchangeQuantity,
        },
      });
      await rejectP10Claim(
        String(position.metadata?.p10_claim_id || ""),
        "P10 entry terminal without fill",
      );
      return { reconciled: true, terminal: true };
    }

    if (finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0) {
      const action = String(
        position.metadata?.pending_exit_action ||
          (orderRow.purpose === "TIME_EXIT" ? "TIME" : orderRow.purpose),
      );
      const result = await applyP10ExitAccounting(
        position,
        orderRow,
        updated.fill,
        action,
        finite(updated.fill.averagePrice),
        finite(position.trailing_stop, position.stop_price),
      );
      await event("P10_EXIT_RECONCILED", `${position.exchange}:${position.market} exit applied`, {
        exchange_order_id: updated.order?.exchange_order_id || null,
        action,
        closed: Boolean(result?.closed),
      }, { cycleId, positionId: position.id, orderId: orderRow.id });
      return { reconciled: true, result };
    }
    const terminal = ["CANCELED", "PARTIALLY_FILLED_CANCELED", "REJECTED", "EXPIRED"].includes(
      String(updated.order?.status),
    );
    if (!terminal) return { reconciled: false, reason: "P10 order remains open" };
    await patch("trading_positions", `id=eq.${position.id}`, {
      state: "OPEN",
      metadata: {
        ...(position.metadata || {}),
        pending_exit_action: null,
        pending_exit_reason: null,
        pending_exit_at: null,
        p10_last_unfilled_exit_at: new Date().toISOString(),
      },
    });
    return { reconciled: true, terminal: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (orderRow.purpose === "ENTRY") {
      await markP10EntryReconciling(position, orderRow, cycleId, message, {
        reconciliation_error_code: (error as any)?.code || null,
        reconciliation_error_status: (error as any)?.status || null,
      }).catch(() => null);
    }
    await event("P10_ORDER_RECONCILIATION_FAILED", message, {
      position_state: position.state,
      order_id: orderRow.id,
      identifier: orderRow.identifier,
    }, { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" });
    return { reconciled: false, reason: message };
  }
}

function p10ExchangeQuantity(position: Position, portfolio: any) {
  if (position.exchange !== "binance_futures") {
    return accountQuantity(portfolio, position.base_asset, true);
  }
  const row = (Array.isArray(portfolio?.positions) ? portfolio.positions : []).find((item: any) =>
    String(item?.market || "").toUpperCase() === String(position.market).toUpperCase() &&
    String(item?.side || "").toUpperCase() === String(position.position_side).toUpperCase()
  );
  return Math.max(0, finite(row?.quantity));
}

async function executeP10Exit(
  position: Position,
  action: string,
  reason: string,
  fraction: number,
  price: number,
  nextStop: number,
  portfolio: any,
  cycleId: string,
) {
  const step = Math.max(0.000000000001, finite(position.quantity_step, 0.00000001));
  const available = p10ExchangeQuantity(position, portfolio);
  const requested = p10RequestedExitQuantity({
    action,
    initialQuantity: position.initial_quantity,
    remainingQuantity: position.remaining_quantity,
    fraction,
  });
  const quantity = floorToStep(Math.min(requested, available), step);
  if (!(quantity > 0)) {
    await event(
      "P10_EXIT_NO_EXCHANGE_POSITION",
      `${position.exchange}:${position.market} no exit quantity`,
      {
        action,
        position_side: position.position_side,
        booked_quantity: position.remaining_quantity,
        exchange_quantity: available,
      },
      { cycleId, positionId: position.id, level: "CRITICAL" },
    );
    return { action: "NONE", reason: "no exchange-backed P10 exit quantity" };
  }
  if (quantity * price < Math.max(1, finite(position.min_notional_quote))) {
    return { action: "NONE", reason: "P10 exit quantity below exchange minimum" };
  }
  const claimed = await patch("trading_positions", `id=eq.${position.id}&state=eq.OPEN`, {
    state: "EXITING",
    trailing_stop: nextStop,
    metadata: {
      ...(position.metadata || {}),
      pending_exit_action: action,
      pending_exit_reason: reason,
      pending_exit_at: new Date().toISOString(),
    },
  });
  if (!claimed.length) return { action: "NONE", reason: "P10 exit already claimed" };
  position = { ...position, ...claimed[0] };
  const side = String(position.position_side) as P10Side;
  const orderSide = p10ExitSide(side);
  const identifier = uniqueId("p10x", position.id);
  const orderRow = await createOrderRecord({
    position_id: position.id,
    cycle_id: cycleId,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    identifier,
    market: position.market,
    side: orderSide,
    strategy_key: P10_STRATEGY_KEY,
    position_side: side,
    position_effect: "CLOSE",
    purpose: p10OrderPurpose(action),
    order_type: "MARKET",
    requested_volume: quantity,
    state: "REQUESTED",
  });
  try {
    const payload = await gateway(position.exchange, {
      action: "create_order",
      order: {
        market: position.market,
        side: orderSide,
        type: "MARKET",
        quantity,
        identifier,
        position_side: position.exchange === "binance_futures" ? side : undefined,
        position_effect: position.exchange === "binance_futures" ? "CLOSE" : undefined,
      },
      wait_for_final_ms: 4000,
    }, 20_000);
    const updated = await updateOrderFromGateway(orderRow, payload);
    if (!(finite(updated.fill.executedVolume) > 0 && finite(updated.fill.averagePrice) > 0)) {
      return {
        action: "NONE",
        pending_reconcile: true,
        reason: "P10 market exit returned no final fill",
      };
    }
    const applied = await applyP10ExitAccounting(
      position,
      orderRow,
      updated.fill,
      action,
      price,
      nextStop,
    );
    const exitEventCode = action === "MARKET_RISK_PARTIAL"
      ? "P10_MARKET_PARTIAL_EXIT"
      : action === "MARKET_RISK_EXIT"
      ? "P10_MARKET_FULL_EXIT"
      : applied?.closed
      ? "P10_POSITION_CLOSED"
      : "P10_PARTIAL_EXIT";
    await event(
      exitEventCode,
      `${position.exchange}:${position.market} ${side} ${action}`,
      {
        strategy_key: P10_STRATEGY_KEY,
        reason,
        exchange_order_id: updated.order?.exchange_order_id || null,
        fill_price: updated.fill.averagePrice,
        quantity: updated.fill.executedVolume,
        remaining_quantity: applied?.position?.remaining_quantity,
        realized_pnl_quote: applied?.position?.realized_pnl_quote,
        market_overlay: action.startsWith("MARKET_RISK")
          ? position.metadata?.p10_market_overlay || null
          : null,
      },
      { cycleId, positionId: position.id, orderId: orderRow.id },
    );
    return {
      action,
      reason,
      closed: Boolean(applied?.closed),
      position: applied?.position,
      exchange_order_id: updated.order?.exchange_order_id || null,
      market_overlay: action.startsWith("MARKET_RISK")
        ? position.metadata?.p10_market_overlay || null
        : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patch("trading_orders", `id=eq.${orderRow.id}`, {
      state: "UNKNOWN",
      error_message: message,
    });
    await event(
      "P10_EXIT_RESULT_UNKNOWN",
      `${position.exchange}:${position.market} exit requires reconciliation`,
      {
        action,
        reason,
        identifier,
        error: message,
      },
      { cycleId, positionId: position.id, orderId: orderRow.id, level: "CRITICAL" },
    );
    return { action: "NONE", pending_reconcile: true, reason: message };
  }
}

async function monitorP10Positions(
  initial: Position[],
  settings: TradingSettings & JsonRecord,
  cycleId: string,
) {
  const startedAt = performance.now();
  const pending = initial.filter((row) =>
    [
      "ENTRY_PENDING",
      "EXITING",
      "RECONCILING",
      "RECONCILIATION_FAILED",
      "CANCELLED",
      "ERROR",
    ].includes(row.state)
  );

  // Start immutable/shared reads immediately.  The old loop waited for every position's
  // portfolio, quote and PATCH before it even priced the next market, so three holdings
  // turned a 2-second scheduler into a 10-12 second effective safety cadence.
  const marketRiskPromise = loadP10MarketRiskObservations();
  type PortfolioLoad =
    | { ok: true; value: any }
    | { ok: false; error: string };
  const portfolioPromises = new Map<Exchange, Promise<PortfolioLoad>>();
  const ensurePortfolio = (exchange: Exchange): Promise<PortfolioLoad> => {
    const existing = portfolioPromises.get(exchange);
    if (existing) return existing;
    const loading = p10PositionPortfolio(exchange)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));
    portfolioPromises.set(exchange, loading);
    return loading;
  };
  for (const exchange of new Set(initial.map((row) => row.exchange))) {
    ensurePortfolio(exchange);
  }

  // Pending orders belong to different positions and their durable DB/exchange identifiers
  // make reconciliation idempotent.  Run them together instead of serialising one market's
  // network latency in front of every other market.
  const reconciliationPromise = mapConcurrentOrdered(pending, async (position) => ({
    action: "P10_RECONCILE",
    exchange: position.exchange,
    market: position.market,
    result: await reconcileP10Order(position, cycleId),
  })).then((actions) => ({ actions, finishedAt: performance.now() }));

  // One bounded read per monitor cycle. Every open P10/I46/S37/S096 position evaluates
  // the same immutable snapshot; a timeout disables only the overlay, never base exits.
  const [marketRiskContext, open] = await Promise.all([
    marketRiskPromise,
    db(
      `trading_positions?strategy_key=eq.${encodeURIComponent(P10_STRATEGY_KEY)}` +
        "&state=eq.OPEN&select=*&order=created_at.asc",
    ) as Promise<Position[]>,
  ]);
  const marketRiskNow = Date.now();
  for (const exchange of new Set(open.map((row) => row.exchange))) ensurePortfolio(exchange);
  const quoteBatchPromises = new Map<Exchange, Promise<Map<string, P10QuoteLoad>>>();
  const ensureQuoteBatch = (exchange: Exchange) => {
    const existing = quoteBatchPromises.get(exchange);
    if (existing) return existing;
    const loading = p10MarketQuoteBatch(
      exchange,
      open.filter((row) => row.exchange === exchange).map((row) => row.market),
    );
    quoteBatchPromises.set(exchange, loading);
    return loading;
  };
  for (const exchange of new Set(open.map((row) => row.exchange))) ensureQuoteBatch(exchange);
  const sharedReadsFinishedAt = performance.now();

  const monitoredActionsPromise = mapConcurrentOrdered(open, async (originalPosition) => {
    let position = originalPosition;
    try {
      const side = String(position.position_side || "LONG") as P10Side;
      const s37Position = side === "SHORT" &&
        position.metadata?.entry_strategy_key === S37_SHORT_STRATEGY_KEY &&
        position.metadata?.strategy_revision === S37_SHORT_REVISION;
      const s096Position = side === "SHORT" &&
        position.metadata?.entry_strategy_key === S096_SHORT_STRATEGY_KEY &&
        position.metadata?.strategy_revision === S096_SHORT_REVISION;
      const completedBarPromise = (async () => {
        const shouldLoad = !s37Position && !s096Position && shouldLoadCompletedPolicyBar(
          finite(position.metadata?.p10_last_policy_bar_time),
          Date.now(),
          P10_HOUR_MS,
        );
        if (!shouldLoad) {
          return {
            latest: null as ReturnType<typeof prepareP10Bars>[number] | null,
            error: null as string | null,
            fetched: false,
          };
        }
        try {
          return {
            latest: prepareP10Bars(await p10CompletedBars(position)).at(-1) || null,
            error: null,
            fetched: true,
          };
        } catch (error) {
          // Quote-driven STOP/TARGET/TIME must remain live when a public candle API fails.
          return {
            latest: null,
            error: error instanceof Error ? error.message : String(error),
            fetched: true,
          };
        }
      })();
      const [portfolioLoad, quoteBatch, completedBar] = await Promise.all([
        ensurePortfolio(position.exchange),
        ensureQuoteBatch(position.exchange),
        completedBarPromise,
      ]);
      if (!portfolioLoad.ok) throw new Error(portfolioLoad.error);
      const quoteLoad = quoteBatch.get(String(position.market).toUpperCase());
      if (!quoteLoad) throw new Error("P10 quote batch omitted held market");
      if (!quoteLoad.ok) throw new Error(quoteLoad.error);
      const quote = quoteLoad.value;
      const portfolio = portfolioLoad.value;
      const exchangeQuantity = p10ExchangeQuantity(position, portfolio);
      const tolerance = Math.max(0.000000000001, finite(position.quantity_step) * 2);
      const quantityMismatch = exchangeQuantity + tolerance < finite(position.remaining_quantity);
      if (quantityMismatch) {
        const newlyLatched = await latchP10EntrySafety("P10_POSITION_QUANTITY_MISMATCH");
        if (
          newlyLatched ||
          finite(position.metadata?.p10_last_mismatch_exchange_quantity, -1) !== exchangeQuantity ||
          finite(position.metadata?.p10_last_mismatch_booked_quantity, -1) !==
            finite(position.remaining_quantity)
        ) {
          await event(
            "P10_POSITION_QUANTITY_MISMATCH",
            `${position.exchange}:${position.market} quantity mismatch`,
            {
              position_side: position.position_side,
              booked_quantity: position.remaining_quantity,
              exchange_quantity: exchangeQuantity,
              safety_newly_latched: newlyLatched,
            },
            { cycleId, positionId: position.id, level: "CRITICAL" },
          );
        }
      }
      const executablePrice = side === "LONG" ? finite(quote.best_bid) : finite(quote.best_ask);
      if (!(executablePrice > 0)) throw new Error("P10 executable quote unavailable");
      const latestCompletedBar = completedBar.latest;
      const completedBarError = completedBar.error;
      const entryPrice = finite(position.average_entry_price, position.planned_entry_price);
      const initialRisk = finite(
        position.metadata?.p10_initial_risk,
        Math.abs(entryPrice - finite(position.stop_price)),
      );
      const currentStop = s37Position || s096Position
        ? resolveFixedShortCurrentStop(position.stop_price, position.trailing_stop)
        : side === "LONG"
        ? Math.max(finite(position.stop_price), finite(position.trailing_stop))
        : Math.min(
          finite(position.stop_price),
          finite(position.trailing_stop, position.stop_price),
        );
      let decision: {
        action: string;
        reason: string | null;
        fraction: number;
        nextStop: number;
        policyBarTime: number;
      } = s37Position
        ? evaluateS37ShortExit({
          entryPrice,
          initialRisk,
          currentStop,
          executablePrice,
          openedAtMs: Date.parse(String(position.opened_at || position.created_at || "")),
          nowMs: Date.now(),
          lastPolicyBarTime: finite(position.metadata?.p10_last_policy_bar_time),
          latestCompletedBarTime: latestCompletedBar?.time,
        })
        : s096Position
        ? evaluateS096ShortExit({
          entryPrice,
          initialRisk,
          currentStop,
          executablePrice,
          openedAtMs: Date.parse(String(position.opened_at || position.created_at || "")),
          nowMs: Date.now(),
          lastPolicyBarTime: finite(position.metadata?.p10_last_policy_bar_time),
          latestCompletedBarTime: latestCompletedBar?.time,
        })
        : evaluateP10Exit({
          side,
          entryPrice,
          initialRisk,
          currentStop,
          partialDone: position.t1_completed === true,
          executablePrice,
          entryBarTime: finite(
            position.metadata?.p10_entry_bar_time,
            Date.parse(String(position.opened_at || position.created_at || "")),
          ),
          openedAtMs: Date.parse(String(position.opened_at || position.created_at || "")),
          nowMs: Date.now(),
          lastPolicyBarTime: finite(position.metadata?.p10_last_policy_bar_time),
          latestCompletedBar,
          roundTripCostBps: p10RoundTripCostBps(p10ExchangeVenue(position.exchange)),
        });
      const baseAction = decision.action;
      const marketRiskDecision = evaluateP10MarketRisk({
        side,
        observations: marketRiskContext.observations,
        nowMs: marketRiskNow,
        partialAlreadyDone: Boolean(position.metadata?.p10_market_risk_partial_at),
        sourceError: marketRiskContext.error,
      });
      decision = applyP10MarketRiskOverlay(decision, marketRiskDecision);
      if (settings.emergency_liquidation) {
        decision = {
          action: "EMERGENCY",
          reason: "EMERGENCY_LIQUIDATION",
          fraction: 1,
          nextStop: decision.nextStop,
          policyBarTime: decision.policyBarTime,
        };
      }
      const nextStop = tickRound(
        decision.nextStop,
        finite(position.tick_size),
        side === "LONG" ? "down" : "up",
      );
      const peakPrice = Math.max(finite(position.peak_price, entryPrice), executablePrice);
      const troughPrice = Math.min(finite(position.trough_price, entryPrice), executablePrice);
      const metadata = {
        ...(position.metadata || {}),
        p10_last_mismatch_booked_quantity: quantityMismatch
          ? finite(position.remaining_quantity)
          : null,
        p10_last_mismatch_exchange_quantity: quantityMismatch ? exchangeQuantity : null,
        p10_last_mismatch_checked_at: quantityMismatch ? new Date().toISOString() : null,
        p10_last_policy_bar_time: decision.policyBarTime,
        p10_last_policy_checked_at: new Date().toISOString(),
        p10_last_executable_price: executablePrice,
        p10_completed_bar_error: completedBar.fetched
          ? completedBarError
          : position.metadata?.p10_completed_bar_error || null,
        p10_market_overlay: {
          ...marketRiskDecision.audit,
          side,
          decision: marketRiskDecision.action,
          base_action: baseAction,
          applied_action: decision.action,
          partial_already_done: Boolean(position.metadata?.p10_market_risk_partial_at),
        },
        p10_last_completed_bar: latestCompletedBar
          ? {
            time: latestCompletedBar.time,
            close: latestCompletedBar.close,
            ema20: latestCompletedBar.ema20,
            atr14: latestCompletedBar.atr14,
          }
          : position.metadata?.p10_last_completed_bar || null,
      };
      const refreshed = await patch("trading_positions", `id=eq.${position.id}&state=eq.OPEN`, {
        trailing_stop: nextStop,
        peak_price: peakPrice,
        trough_price: troughPrice,
        metadata,
      });
      if (!refreshed.length) return null;
      position = { ...position, ...refreshed[0] };
      if (decision.action === "NONE") {
        return {
          action: "P10_HOLD",
          exchange: position.exchange,
          market: position.market,
          side,
          executable_price: executablePrice,
          stop: nextStop,
          market_overlay: metadata.p10_market_overlay,
        };
      }
      return await executeP10Exit(
        position,
        decision.action,
        String(decision.reason || decision.action),
        decision.fraction,
        executablePrice,
        nextStop,
        portfolio,
        cycleId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = {
        action: "P10_MONITOR_ERROR",
        exchange: position.exchange,
        market: position.market,
        error: message,
      };
      await event("P10_MONITOR_ERROR", message, {
        strategy_key: P10_STRATEGY_KEY,
        position_side: position.position_side,
      }, { cycleId, positionId: position.id, level: "CRITICAL" });
      return action;
    }
  }, P10_MONITOR_POSITION_CONCURRENCY);
  const [reconciliation, monitoredActions] = await Promise.all([
    reconciliationPromise,
    monitoredActionsPromise,
  ]);
  const finishedAt = performance.now();
  return {
    actions: [
      ...reconciliation.actions,
      ...monitoredActions.filter((action) => action !== null),
    ],
    openPositions: open.length,
    timingsMs: {
      reconcile: Math.round(reconciliation.finishedAt - startedAt),
      shared_reads: Math.round(sharedReadsFinishedAt - startedAt),
      position_batch: Math.round(finishedAt - sharedReadsFinishedAt),
      total: Math.round(finishedAt - startedAt),
    },
  };
}

async function scanCycle(cycleId: string, settings: TradingSettings & JsonRecord) {
  if (isP10Strategy((settings as any).strategy)) {
    return await p10ScanCycle(cycleId, settings);
  }
  const exchanges = enabledExchanges(settings);
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
        max_daily_loss_pct: finite((settings as any).scalp_daily_loss_pct, 20),
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
    const heartbeatAt = new Date().toISOString();
    await patchTradingHeartbeat({
      lastFullScanAt: heartbeatAt,
      lastGatewayHeartbeatAt: heartbeatAt,
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
    const perExchange = ALL_EXCHANGES
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
  const enteredPerExchange: Record<Exchange, number> = {
    upbit: 0,
    binance: 0,
    binance_futures: 0,
  };
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
  const scanHeartbeatAt = new Date().toISOString();
  await patchTradingHeartbeat({
    lastFullScanAt: scanHeartbeatAt,
    lastGatewayHeartbeatAt: scanHeartbeatAt,
    gatewayErrorCount: 0,
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

function displayPosition(row: any): any {
  const lob = isLobStrategy(row?.metadata?.lob_signal?.strategy);
  if (!lob) return row;
  const revision = String(
    row?.metadata?.active_exit_revision || row?.metadata?.exit_policy_revision ||
      (row?.exchange === "binance_futures" ? "7.6.0-BINANCE-FUTURES" : "7.6.2-SPOT-SPLIT-SL4"),
  );
  const markedPnl = finite(
    row?.marked_pnl_quote,
    finite(row?.metadata?.live_mark?.fee_net_pnl_quote),
  );
  if (row?.exchange === "binance_futures") {
    return {
      ...row,
      exit_policy: "FUTURES_SPLIT_EXIT",
      strategy_revision: revision,
      marked_pnl_quote: markedPnl,
      active_exit_policy: {
        revision,
        price_basis: "QUANTITY_AWARE_EXECUTABLE_BID",
        return_basis: "RETURN_ON_MARGIN",
        leverage: positionLeverage(row),
        first_take_profit_roe_pct: 15,
        first_stop_loss_roe_pct: -12,
        hard_stop_sell_fraction: 1,
        first_tranche_sell_fraction: 0.5,
        residual_profit_floor_roe_pct: 9,
        residual_trailing_drawdown_roe_pct: 4.5,
        residual_sell_fraction: 1,
        stop_price: row?.stop_price,
        target_1: row?.target_1,
        target_2: null,
        marked_pnl_quote: markedPnl,
        measured_at: row?.metadata?.live_mark?.measured_at || null,
      },
    };
  }
  return {
    ...row,
    exit_policy: "SPOT_SPLIT_EXIT",
    strategy_revision: revision,
    stop_bps: 400,
    marked_pnl_quote: markedPnl,
    active_exit_policy: {
      revision,
      price_basis: "QUANTITY_AWARE_EXECUTABLE_BID",
      return_basis: "RETURN_ON_PRICE",
      first_take_profit_pct: 5,
      first_stop_loss_pct: -4,
      hard_stop_sell_fraction: 1,
      first_tranche_sell_fraction: 0.5,
      residual_profit_floor_pct: 3,
      residual_trailing_drawdown_pct: 1.5,
      residual_sell_fraction: 1,
      stop_price: row?.stop_price,
      target_1: row?.target_1,
      target_2: null,
      marked_pnl_quote: markedPnl,
      measured_at: row?.metadata?.live_mark?.measured_at || null,
    },
    historical_entry_signal: {
      engine_version: row?.metadata?.engine_version || null,
      strategy_revision: row?.metadata?.lob_signal?.strategy_revision || null,
      stop_bps: row?.metadata?.lob_signal?.stop_bps ?? null,
    },
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
    manualFills,
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
      "trading_residual_inventory?exchange=neq.binance_futures&state=in.(AVAILABLE,RESERVED_FOR_REENTRY,SWEEP_PENDING)&select=exchange,asset,market,remaining_quantity,value_quote,state,updated_at&order=updated_at.asc",
    ).catch(() => []),
    db("trading_joint_objective_snapshots?select=*&order=captured_at.desc&limit=40").catch(
      () => [],
    ),
    db(
      "exchange_trade_fills?source=eq.MANUAL&position_id=is.null&select=exchange,market,side,price,quantity,quote_amount,base_asset,fee_asset,fee_amount,fee_quote_amount,source,position_id,executed_at,exchange_trade_id&order=executed_at.asc,exchange_trade_id.asc&limit=1000",
    ).catch(() => []),
  ]);
  const accounts: JsonRecord = {};
  const accountStatsByExchange: JsonRecord = {};
  for (const exchange of ALL_EXCHANGES) {
    const hasTrackedPosition = (positions || []).some((row: any) => row.exchange === exchange);
    if (!exchangeEnabled(settings, exchange) && !hasTrackedPosition) continue;
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
  // The gateway portfolio fetched for this response is fresher than the persisted account
  // snapshots loaded above. Put those live snapshots first so both manual-sale settlement
  // and manual-buy import use the balance the operator can see on the exchange right now.
  const liveSnapshots = ALL_EXCHANGES.flatMap((exchange) => {
    const portfolio = accounts[exchange];
    if (!portfolio || portfolio.ok === false || !Array.isArray(portfolio.accounts)) return [];
    return [{
      ...portfolio,
      exchange,
      captured_at: new Date().toISOString(),
      balances: portfolio.accounts,
      prices: portfolio.prices || {},
    }];
  });
  const accountSnapshots = [...liveSnapshots, ...(snapshots || [])];
  const displayable = resolveDisplayPositions(positions || [], accountSnapshots);
  const manual = resolveManualPositions({
    trackedPositions: positions || [],
    snapshots: accountSnapshots,
    residualInventory: residualInventory || [],
    manualFills: manualFills || [],
  });
  return {
    version: VERSION,
    settings,
    accounts,
    account_stats: accountStatsByExchange,
    positions: [...displayable.positions.map(displayPosition), ...manual.positions],
    // Rows the ledger still carries but the account no longer backs. They are reported
    // rather than dropped silently so a reconciliation lag stays visible.
    settled_positions: displayable.settled,
    position_display_rule: displayable.rule,
    manual_position_rule: manual.rule,
    asset_locks: assetLocks || [],
    residual_inventory: residualInventory || [],
    joint_objective_snapshots: objectiveSnapshots || [],
    recently_closed_positions: (closedPositions || []).map(displayPosition),
    binance_gateway_health: binanceHealth,
    recent_orders: orders,
    recent_cycles: cycles,
    latest_accounts: accountSnapshots,
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
  const emergencyRequested = body.emergency_liquidation === true;
  const safetyError = dangerousControlError({
    mode: body.mode,
    emergencyLiquidation: body.emergency_liquidation,
    confirmation: body.confirmation,
  });
  if (safetyError) throw new Error(safetyError);
  if (body.emergency_liquidation === false && settings.emergency_liquidation === true) {
    throw new Error(
      "active emergency liquidation can only be cleared after durable reconciliation",
    );
  }
  if (emergencyRequested) {
    const confirmed = await rpc("request_emergency_liquidation", {
      p_confirmation: String(body.confirmation || ""),
      p_source: String(body.control_source || "API"),
    });
    return { ...settings, ...(confirmed || {}) } as TradingSettings & JsonRecord;
  }
  if (body.mode != null) allowed.mode = parseMode(String(body.mode));
  for (
    const key of [
      "pause_new_entries",
      "emergency_liquidation",
      "upbit_enabled",
      "binance_enabled",
      "binance_futures_enabled",
      "suppress_cross_exchange_same_asset",
      "scalp_kill_switch",
      "residual_sweep_enabled",
    ] as const
  ) if (body[key] != null) allowed[key] = Boolean(body[key]);
  if (body.strategy != null) {
    const strategy = String(body.strategy).toUpperCase();
    allowed.strategy = strategy === "P10_DONCHIAN_SLOW4R"
      ? "P10_DONCHIAN_SLOW4R"
      : strategy === "TREND"
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
  if (body.binance_futures_allocation_mode != null) {
    allowed.binance_futures_allocation_mode =
      String(body.binance_futures_allocation_mode).toUpperCase() === "FIXED" ? "FIXED" : "ALL";
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
    binance_futures_allocation_usdt: [0, 1_000_000_000],
    binance_futures_reserve_usdt: [0, 1_000_000_000],
    // The exit thresholds are stated on margin, so leverage is the single lever that
    // decides how far price has to move to reach them. The gateway enforces the same 20x
    // ceiling independently.
    binance_futures_leverage: [1, 20],
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
  const futuresAllocationMode = String(
    allowed.binance_futures_allocation_mode ??
      (settings as any).binance_futures_allocation_mode ??
      "ALL",
  );
  const futuresAllocationMargin = finite(
    allowed.binance_futures_allocation_usdt ??
      (settings as any).binance_futures_allocation_usdt,
  );
  if (
    futuresAllocationMode === "FIXED" &&
    futuresAllocationMargin < FUTURES_MIN_ENTRY_MARGIN_USDT
  ) {
    throw new Error(
      `Binance futures FIXED allocation must provide at least ${FUTURES_MIN_ENTRY_MARGIN_USDT} USDT of margin`,
    );
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
      for (const exchange of ALL_EXCHANGES) {
        if (exchangeEnabled(settings, exchange)) {
          portfolios[exchange] = await gateway(exchange, { action: "portfolio" });
        }
      }
      await patchTradingHeartbeat({
        lastGatewayHeartbeatAt: new Date().toISOString(),
        gatewayErrorCount: 0,
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
      const emergencyRequest = body.emergency_liquidation === true;
      const operatorPause = body.pause_new_entries === true && settings.pause_new_entries !== true;
      if (
        operatorPause && !emergencyRequest &&
        String(body.pause_confirmation || "") !== "PAUSE_NOW"
      ) {
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
      if (emergencyRequest) {
        await event(
          "EMERGENCY_LIQUIDATION_REQUESTED",
          "confirmed emergency liquidation requested",
          {
            source: String(body.control_source || "API"),
            user_agent: request.headers.get("user-agent") || null,
          },
          { cycleId, level: "CRITICAL" },
        );
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
        "trading_positions?state=in.(ENTRY_PENDING,OPEN,EXITING,RECONCILING,RECONCILIATION_FAILED,MANUAL_INTERVENTION_REQUIRED)" +
          "&select=id,exchange,market,position_side,remaining_quantity,reserved_quantity,quantity_step,is_paper,state,strategy_key&limit=1000",
      ) as any[];
      const unresolvedEntryRows = activeAfterReconcile.filter((row) =>
        [
          "ENTRY_PENDING",
          "RECONCILING",
          "RECONCILIATION_FAILED",
          "MANUAL_INTERVENTION_REQUIRED",
        ].includes(String(row.state))
      );
      let futuresResumeError: string | null = null;
      let untrackedFuturesAtResume: ReturnType<typeof untrackedFuturesExposures> = [];
      let futuresQuantityMismatches: Array<{
        market: string;
        side: string;
        booked_quantity: number;
        exchange_quantity: number;
      }> = [];
      try {
        const futuresPortfolio = await p10PositionPortfolio("binance_futures");
        const exchangePositions = Array.isArray(futuresPortfolio?.positions)
          ? futuresPortfolio.positions
          : [];
        untrackedFuturesAtResume = untrackedFuturesExposures(
          exchangePositions,
          activeAfterReconcile
            .filter((row) => row.exchange === "binance_futures" && !row.is_paper)
            .map((row) => ({
              market: row.market,
              side: row.position_side,
              quantity: Math.max(finite(row.remaining_quantity), finite(row.reserved_quantity)),
            })),
        );
        futuresQuantityMismatches = activeAfterReconcile
          .filter((row) => row.exchange === "binance_futures" && !row.is_paper)
          .flatMap((row) => {
            const exchangeQuantity = exchangePositions
              .filter((item: any) =>
                String(item?.market || "").toUpperCase() === String(row.market).toUpperCase() &&
                String(item?.side || "").toUpperCase() ===
                  String(row.position_side).toUpperCase()
              )
              .reduce((sum: number, item: any) => sum + Math.max(0, finite(item?.quantity)), 0);
            const bookedQuantity = Math.max(
              finite(row.remaining_quantity),
              finite(row.reserved_quantity),
            );
            const tolerance = Math.max(0.000000000001, finite(row.quantity_step) * 2);
            if (Math.abs(exchangeQuantity - bookedQuantity) <= tolerance) return [];
            return [{
              market: String(row.market),
              side: String(row.position_side),
              booked_quantity: bookedQuantity,
              exchange_quantity: exchangeQuantity,
            }];
          });
      } catch (error) {
        futuresResumeError = `Binance Futures exposure verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const p10ResumeError = unresolvedEntryRows.length
        ? "entry reconciliation is still unresolved; resume is blocked"
        : futuresResumeError
        ? futuresResumeError
        : untrackedFuturesAtResume.length || futuresQuantityMismatches.length
        ? "Binance Futures and database quantities do not match; resume is blocked"
        : null;
      const resumeError = p10ResumeError || resumeSafetyError({
        emergencyLiquidation: Boolean(settings.emergency_liquidation),
        activePositionCount: activeAfterReconcile.length,
        unresolvedManualCount: Array.isArray((reconciliation as any).unresolved_manual_assets)
          ? (reconciliation as any).unresolved_manual_assets.length
          : 0,
      });
      if (resumeError) {
        const safety = {
          unresolved_entry_positions: unresolvedEntryRows.map((row) => row.id),
          untracked_futures_exposures: untrackedFuturesAtResume,
          futures_quantity_mismatches: futuresQuantityMismatches,
          futures_verification_error: futuresResumeError,
        };
        await finishCycle(cycleId, "SKIPPED", { reason: resumeError, reconciliation, safety });
        return response({
          ok: false,
          error: resumeError,
          cycle_id: cycleId,
          reconciliation,
          safety,
        }, 409);
      }
      if (settings.emergency_liquidation) {
        const completion = await rpc("complete_emergency_liquidation", {});
        if (completion?.completed !== true) {
          const error = "emergency liquidation still has unsettled positions or close orders";
          await finishCycle(cycleId, "SKIPPED", {
            reason: error,
            reconciliation,
            emergency_completion: completion,
          });
          return response({
            ok: false,
            error,
            cycle_id: cycleId,
            reconciliation,
            emergency_completion: completion,
          }, 409);
        }
        settings = {
          ...settings,
          ...(completion?.settings || {}),
        } as TradingSettings & JsonRecord;
      }
      const latestSettings = (await db(
        "trading_settings?id=eq.1&select=*&limit=1",
      ))?.[0] as TradingSettings & JsonRecord;
      const resumeResult = await rpc("resume_p10_safely", {
        p_expected_version: latestSettings?.version == null
          ? null
          : Math.floor(finite(latestSettings.version)),
        p_expected_lock_reason: latestSettings?.pause_lock_reason ?? null,
        p_expected_manual_reason: latestSettings?.manual_event_reason ?? null,
        p_external_futures_clear: !futuresResumeError &&
          !untrackedFuturesAtResume.length && !futuresQuantityMismatches.length,
        p_unresolved_manual_count: Array.isArray(
            (reconciliation as any).unresolved_manual_assets,
          )
          ? (reconciliation as any).unresolved_manual_assets.length
          : 0,
      });
      if (resumeResult?.resumed !== true) {
        const error = `safe resume refused: ${resumeResult?.reason || "UNKNOWN"}`;
        await finishCycle(cycleId, "SKIPPED", {
          reason: error,
          reconciliation,
          resume_result: resumeResult,
        });
        return response({
          ok: false,
          error,
          cycle_id: cycleId,
          reconciliation,
          resume_result: resumeResult,
        }, 409);
      }
      settings = resumeResult.settings as TradingSettings & JsonRecord;
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
      const result = await runWithContendedLease(
        LEASE_GATEWAY,
        "autotrader-scan",
        () => crypto.randomUUID(),
        {
          ttlSeconds: SCAN_LEASE_TTL_SECONDS,
          renewMs: SCAN_LEASE_RENEW_MS,
          waitMs: SCAN_LEASE_WAIT_MS,
          pollMs: SCAN_LEASE_POLL_MS,
        },
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
