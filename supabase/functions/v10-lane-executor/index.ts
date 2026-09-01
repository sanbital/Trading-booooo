import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  evaluateV10ExitBar,
  initialV10ExitState,
  prepareV10ExitBars,
  type V10ExitState,
  type V10RawBar,
} from "../_shared/v10_lane_exit.ts";
import {
  getV10ExitPolicy,
  isV10LaneLiveEligible,
  V10_EXIT_BAR_INTERVAL_MS,
  V10_EXIT_ENGINE_REVISION,
  V10_EXIT_SPEC_SHA256,
  type V10Lane,
} from "../_shared/v10_lane_exit_config.ts";
import { P10_MARKET_RISK_CONFIG } from "../_shared/p10-market-risk.ts";
import {
  buildV10RegimeSnapshot,
  evaluateV10RegimeTransition,
  V10_REGIME_TRANSITION_LIVE_EXIT_COMPILED,
  V10_REGIME_TRANSITION_REVISION,
} from "../_shared/v10_regime_transition.ts";
import {
  finite,
  floorToStep,
  freshSnapshotAgeMs,
  type GatewayFill,
  isTerminalNoFill,
  parseGatewayFill,
  v10ClientOrderId,
} from "../_shared/v10_lane_executor.ts";

const ENGINE_REVISION = "V10-LANE-EXECUTOR-1.0.0";
const SIGNAL_REVISION = "V10-LANES-3.0.0";
const SIGNAL_SPEC_SHA256 = "9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f";
const GATEWAY_PROTOCOL_VERSION = "8.0.0-P10-DONCHIAN-SLOW4R";
const MAX_SNAPSHOT_AGE_MS = 90_000;
const MAX_SPREAD_BPS = 25;
const ENTRY_FEE_BUFFER_RATE = 0.001;
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

type DbClient = ReturnType<typeof createClient>;
type JsonRecord = Record<string, any>;

interface ClaimedSignal {
  signal_id: string;
  lane: V10Lane;
  fingerprint: string;
  symbol: string;
  side: "LONG";
  signal_bar_at: string;
  entry_bar_at: string;
  hold_hours: number;
  features: JsonRecord;
  notional_usdt: number | string;
  leverage: number | string;
  max_concurrent: number;
  max_aggregate_notional_usdt: number | string;
}

interface PositionRow {
  id: string;
  signal_id: string;
  lane: V10Lane;
  fingerprint: string;
  symbol: string;
  side: "LONG";
  quantity: number | string;
  original_quantity: number | string | null;
  remaining_quantity: number | string | null;
  entry_price: number | string;
  entry_notional_usdt: number | string;
  leverage: number;
  entry_order_id: string;
  entry_client_order_id: string;
  opened_at: string;
  expected_exit_at: string;
  state: string;
  realized_pnl_usdt: number | string | null;
  exit_state: V10ExitState | JsonRecord;
  last_exit_evaluated_bar_at: string | null;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}
function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

const GATEWAY_URL = env("BINANCE_FUTURES_ORDER_GATEWAY_URL").replace(/\/$/, "") ||
  env("BINANCE_ORDER_GATEWAY_URL").replace(/\/$/, "") ||
  env("ORDER_GATEWAY_URL").replace(/\/$/, "");
const GATEWAY_SECRET = env("BINANCE_FUTURES_GATEWAY_SHARED_SECRET") ||
  env("BINANCE_GATEWAY_SHARED_SECRET") ||
  env("GATEWAY_SHARED_SECRET");

async function gateway(command: JsonRecord, timeoutMs = 20_000): Promise<any> {
  if (!GATEWAY_URL || !GATEWAY_SECRET) throw new Error("V10_EXECUTOR_GATEWAY_CONFIG_MISSING");
  const versioned = command.action === "create_order"
    ? { ...command, engine_version: GATEWAY_PROTOCOL_VERSION }
    : command;
  const raw = JSON.stringify({ exchange: "binance_futures", ...versioned });
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await hmacHex(GATEWAY_SECRET, `${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/command`, {
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
      throw new Error(`V10_GATEWAY_${res.status}:${data?.error || text}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function authorized(db: DbClient, req: Request): Promise<boolean> {
  const provided = (req.headers.get("x-v10-executor-token") || "").trim();
  if (!provided) return false;
  const { data, error } = await db.from("edge_internal_tokens")
    .select("token").eq("name", "v10-lane-executor").maybeSingle();
  if (error || !data?.token) return false;
  return constantTimeEqual(String(data.token), provided);
}

async function openCircuit(db: DbClient, reason: string): Promise<void> {
  await db.rpc("open_v10_lane_circuit", { p_reason: reason.slice(0, 500) });
  await db.from("v10_lane_executor_runtime").update({
    last_error: reason.slice(0, 1000),
    consecutive_failures: 1,
    updated_at: new Date().toISOString(),
  }).eq("singleton", true);
}

function portfolioPositions(portfolio: any): any[] {
  return Array.isArray(portfolio?.positions) ? portfolio.positions : [];
}
function activePosition(row: any): boolean {
  return finite(row?.quantity ?? row?.positionAmt) > 0;
}
async function latestSnapshot(db: DbClient): Promise<any> {
  const { data, error } = await db.from("trading_account_snapshots")
    .select(
      "captured_at,total_equity_quote,available_quote,positions,positions_complete,positions_revision",
    )
    .eq("exchange", "binance_futures")
    .order("captured_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) throw new Error(`V10_SNAPSHOT_READ_FAILED:${error?.message || "missing"}`);
  if (data.positions_complete !== true) throw new Error("V10_FUTURES_POSITIONS_INCOMPLETE");
  const ageMs = freshSnapshotAgeMs(String(data.captured_at));
  if (ageMs > MAX_SNAPSHOT_AGE_MS) throw new Error(`V10_FUTURES_SNAPSHOT_STALE:${ageMs}`);
  return { ...data, ageMs };
}

async function executorPreflight(db: DbClient, symbol = "BTCUSDT"): Promise<JsonRecord> {
  const [{ data: flag, error: flagError }, snapshot] = await Promise.all([
    db.from("v10_lane_flags")
      .select(
        "lane,validated,shadow_enabled,live_enabled,notional_usdt,leverage,engine_revision,spec_sha256,max_concurrent,max_aggregate_notional_usdt",
      )
      .eq("lane", "RANGE").single(),
    latestSnapshot(db),
  ]);
  if (flagError || !flag) throw new Error(`V10_RANGE_FLAG_READ_FAILED:${flagError?.message}`);
  if (
    flag.validated !== true || flag.engine_revision !== SIGNAL_REVISION ||
    flag.spec_sha256 !== SIGNAL_SPEC_SHA256
  ) throw new Error("V10_RANGE_IDENTITY_NOT_VALIDATED");
  if (!isV10LaneLiveEligible("RANGE")) throw new Error("V10_RANGE_EXIT_POLICY_NOT_LIVE_ELIGIBLE");

  const [portfolio, quote, symbolInfo] = await Promise.all([
    gateway({ action: "p10_portfolio" }),
    gateway({ action: "quote", market: symbol }),
    gateway({ action: "symbol_info", market: symbol }),
  ]);
  const bestBid = finite(quote?.best_bid);
  const bestAsk = finite(quote?.best_ask);
  const spreadBps = bestBid > 0 && bestAsk > 0 ? (bestAsk / bestBid - 1) * 10_000 : Infinity;
  if (!(bestBid > 0 && bestAsk > 0) || spreadBps > MAX_SPREAD_BPS) {
    throw new Error(`V10_PREFLIGHT_QUOTE_INVALID:${spreadBps}`);
  }
  if (!(finite(symbolInfo?.quantity_step ?? symbolInfo?.step_size) > 0)) {
    throw new Error("V10_PREFLIGHT_SYMBOL_RULES_INVALID");
  }
  const margin = finite(flag.notional_usdt);
  const leverage = finite(flag.leverage);
  const liveAvailable = finite(portfolio?.available_quote, Number.NaN);
  if (!Array.isArray(portfolio?.positions) || !Number.isFinite(liveAvailable)) {
    throw new Error("V10_PREFLIGHT_LIVE_PORTFOLIO_INCOMPLETE");
  }
  const available = Math.min(finite(snapshot.available_quote), liveAvailable);
  const required = margin + margin * leverage * ENTRY_FEE_BUFFER_RATE;
  if (!(margin === 40 && leverage === 3)) {
    throw new Error(`V10_RANGE_RISK_CONTRACT_MISMATCH:${margin}x${leverage}`);
  }
  if (available + 1e-8 < required) {
    throw new Error(`V10_RANGE_AVAILABLE_MARGIN_INSUFFICIENT:${available}<${required}`);
  }

  return {
    ok: true,
    engine: ENGINE_REVISION,
    signalRevision: SIGNAL_REVISION,
    exitRevision: V10_EXIT_ENGINE_REVISION,
    lane: "RANGE",
    marginUsdt: margin,
    leverage,
    orderNotionalUsdt: margin * leverage,
    availableUsdt: available,
    liveAvailableUsdt: liveAvailable,
    snapshotAgeMs: snapshot.ageMs,
    positionsComplete: snapshot.positions_complete,
    externalPositions: portfolioPositions(portfolio).filter(activePosition).length,
    quote: { symbol, bestBid, bestAsk, spreadBps },
    symbolRules: {
      quantityStep: finite(symbolInfo?.quantity_step ?? symbolInfo?.step_size),
      minNotional: finite(symbolInfo?.min_notional),
    },
  };
}

function fillPositionPayload(
  signal: ClaimedSignal,
  intent: any,
  fill: GatewayFill,
): JsonRecord {
  const openedAt = new Date().toISOString();
  const expectedExitAt = new Date(
    Date.parse(signal.signal_bar_at) + finite(signal.hold_hours) * 3_600_000,
  ).toISOString();
  const policy = getV10ExitPolicy(signal.lane);
  const entryBbPos = finite(
    signal.features?.bbPos ?? signal.features?.bb_pos ?? signal.features?.entryBbPos,
    Number.NaN,
  );
  if (!Number.isFinite(entryBbPos)) throw new Error("V10_ENTRY_BB_POSITION_MISSING");
  return {
    signal_id: signal.signal_id,
    lane: signal.lane,
    fingerprint: signal.fingerprint,
    symbol: signal.symbol,
    side: "LONG",
    quantity: fill.executedQuantity,
    original_quantity: fill.executedQuantity,
    remaining_quantity: fill.executedQuantity,
    entry_price: fill.averagePrice,
    entry_notional_usdt: fill.executedNotional || fill.executedQuantity * fill.averagePrice,
    leverage: finite(signal.leverage),
    entry_order_id: fill.exchangeOrderId || intent.client_order_id,
    entry_client_order_id: intent.client_order_id,
    opened_at: openedAt,
    expected_exit_at: expectedExitAt,
    state: "OPEN",
    peak_price: fill.averagePrice,
    exit_policy_key: policy.key,
    exit_policy_revision: V10_EXIT_ENGINE_REVISION,
    exit_policy_spec_sha256: V10_EXIT_SPEC_SHA256,
    exit_state: initialV10ExitState(fill.averagePrice, entryBbPos),
    risk_backstop_at: new Date(Date.parse(expectedExitAt) + V10_EXIT_BAR_INTERVAL_MS).toISOString(),
    reconciliation: {
      entry_intent_id: intent.id,
      entry_status: fill.status,
      paid_fee_quote: fill.paidFeeQuote,
      executor_revision: ENGINE_REVISION,
    },
  };
}

async function finalizeEntryFill(
  db: DbClient,
  signal: ClaimedSignal,
  intent: any,
  fill: GatewayFill,
): Promise<any> {
  if (!(fill.executedQuantity > 0 && fill.averagePrice > 0)) {
    throw new Error("V10_ENTRY_FILL_INCOMPLETE");
  }
  const positionPayload = fillPositionPayload(signal, intent, fill);
  const { data: existingPosition, error: lookupError } = await db.from("v10_lane_positions")
    .select("*").eq("signal_id", signal.signal_id).maybeSingle();
  if (lookupError) throw new Error(`V10_POSITION_LOOKUP_FAILED:${lookupError.message}`);
  let position = existingPosition;
  if (!position) {
    const inserted = await db.from("v10_lane_positions")
      .insert(positionPayload).select("*").single();
    if (inserted.error?.code === "23505") {
      const raced = await db.from("v10_lane_positions")
        .select("*").eq("signal_id", signal.signal_id).single();
      if (raced.error) throw new Error(`V10_POSITION_RACE_LOOKUP_FAILED:${raced.error.message}`);
      position = raced.data;
    } else if (inserted.error) {
      throw new Error(`V10_POSITION_WRITE_FAILED:${inserted.error.message}`);
    } else {
      position = inserted.data;
    }
  }
  await db.from("v10_lane_order_intents").update({
    exchange_order_id: fill.exchangeOrderId,
    requested_qty: fill.executedQuantity,
    state: "FILLED",
    response_payload: fill.raw,
    updated_at: new Date().toISOString(),
  }).eq("id", intent.id);
  await db.from("v10_lane_claims").update({
    claim_state: "FILLED",
    order_ref: fill.exchangeOrderId || intent.client_order_id,
    position_id: position.id,
    updated_at: new Date().toISOString(),
  }).eq("signal_id", signal.signal_id);
  return position;
}

async function executeClaimedEntry(db: DbClient, signal: ClaimedSignal): Promise<JsonRecord> {
  if (signal.lane !== "RANGE" || signal.side !== "LONG") {
    await db.from("v10_lane_claims").update({
      claim_state: "REJECTED",
      reject_reason: "V10_EXECUTOR_RANGE_LONG_ONLY",
      updated_at: new Date().toISOString(),
    }).eq("signal_id", signal.signal_id);
    return { entered: false, reason: "V10_EXECUTOR_RANGE_LONG_ONLY" };
  }

  const { data: p10SameMarket } = await db.from("trading_positions")
    .select("id").eq("exchange", "binance_futures").eq("market", signal.symbol)
    .in("state", [
      "ENTRY_PENDING",
      "OPEN",
      "EXITING",
      "RECONCILING",
      "RECONCILIATION_FAILED",
      "MANUAL_INTERVENTION_REQUIRED",
    ]).limit(1);
  if (p10SameMarket?.length) {
    await db.from("v10_lane_claims").update({
      claim_state: "REJECTED",
      reject_reason: "P10_MARKET_ALREADY_TRACKED",
      updated_at: new Date().toISOString(),
    }).eq("signal_id", signal.signal_id);
    return { entered: false, reason: "P10_MARKET_ALREADY_TRACKED" };
  }

  const snapshot = await latestSnapshot(db);
  const [portfolio, quote, info] = await Promise.all([
    gateway({ action: "p10_portfolio" }),
    gateway({ action: "quote", market: signal.symbol }),
    gateway({ action: "symbol_info", market: signal.symbol }),
  ]);
  const externalSame = portfolioPositions(portfolio).find((row) =>
    String(row?.market || row?.symbol || "").toUpperCase() === signal.symbol.toUpperCase() &&
    activePosition(row)
  );
  if (externalSame) throw new Error("V10_EXTERNAL_MARKET_POSITION_ALREADY_OPEN");

  const bestBid = finite(quote?.best_bid);
  const bestAsk = finite(quote?.best_ask);
  const spreadBps = bestBid > 0 && bestAsk > 0 ? (bestAsk / bestBid - 1) * 10_000 : Infinity;
  if (!(bestBid > 0 && bestAsk > 0) || spreadBps > MAX_SPREAD_BPS) {
    throw new Error(`V10_ENTRY_SPREAD_BLOCK:${spreadBps}`);
  }
  const margin = finite(signal.notional_usdt);
  const leverage = finite(signal.leverage);
  if (!(margin === 40 && leverage === 3)) throw new Error("V10_ENTRY_RISK_CONTRACT_MISMATCH");
  const targetNotional = margin * leverage;
  const requiredAvailable = margin + targetNotional * ENTRY_FEE_BUFFER_RATE;
  const liveAvailable = finite(portfolio?.available_quote, Number.NaN);
  if (!Array.isArray(portfolio?.positions) || !Number.isFinite(liveAvailable)) {
    throw new Error("V10_ENTRY_LIVE_PORTFOLIO_INCOMPLETE");
  }
  const available = Math.min(finite(snapshot.available_quote), liveAvailable);
  if (available + 1e-8 < requiredAvailable) {
    throw new Error("V10_ENTRY_AVAILABLE_MARGIN_INSUFFICIENT");
  }
  const step = finite(info?.quantity_step ?? info?.step_size);
  const minNotional = Math.max(1, finite(info?.min_notional, 5));
  const quantity = floorToStep(targetNotional / bestAsk, step);
  const estimatedNotional = quantity * bestAsk;
  if (!(quantity > 0 && estimatedNotional >= minNotional)) {
    throw new Error("V10_ENTRY_QUANTITY_BELOW_EXCHANGE_MINIMUM");
  }

  const clientOrderId = v10ClientOrderId("v10e", signal.signal_id);
  const requestPayload = {
    action: "create_order",
    leverage,
    order: {
      market: signal.symbol,
      side: "BUY",
      type: "MARKET",
      quantity,
      identifier: clientOrderId,
      position_side: "LONG",
      position_effect: "OPEN",
    },
    wait_for_final_ms: 4000,
  };
  const { data: intent, error: intentError } = await db.from("v10_lane_order_intents")
    .insert({
      signal_id: signal.signal_id,
      lane: signal.lane,
      fingerprint: signal.fingerprint,
      symbol: signal.symbol,
      intent: "OPEN_LONG",
      client_order_id: clientOrderId,
      notional_usdt: targetNotional,
      requested_qty: quantity,
      state: "PLANNED",
      request_payload: {
        ...requestPayload,
        margin_usdt: margin,
        best_ask: bestAsk,
        spread_bps: spreadBps,
        snapshot_at: snapshot.captured_at,
        live_available_usdt: liveAvailable,
      },
    }).select("*").single();
  if (intentError) throw new Error(`V10_ENTRY_INTENT_FAILED:${intentError.message}`);

  let submitted = false;
  try {
    submitted = true;
    const payload = await gateway(requestPayload);
    const fill = parseGatewayFill(payload);
    await db.from("v10_lane_order_intents").update({
      state: fill.executedQuantity > 0 ? "FILLED" : "SUBMITTED",
      exchange_order_id: fill.exchangeOrderId,
      response_payload: payload,
      updated_at: new Date().toISOString(),
    }).eq("id", intent.id);
    await db.from("v10_lane_claims").update({
      claim_state: fill.executedQuantity > 0 ? "FILLED" : "ORDERED",
      order_ref: fill.exchangeOrderId || clientOrderId,
      updated_at: new Date().toISOString(),
    }).eq("signal_id", signal.signal_id);
    if (fill.executedQuantity > 0) {
      const position = await finalizeEntryFill(db, signal, intent, fill);
      return {
        entered: true,
        signalId: signal.signal_id,
        symbol: signal.symbol,
        positionId: position.id,
        quantity: fill.executedQuantity,
        entryPrice: fill.averagePrice,
        marginUsdt: margin,
        leverage,
      };
    }
    if (isTerminalNoFill(fill)) {
      await db.from("v10_lane_order_intents").update({
        state: "REJECTED",
        reject_reason: `TERMINAL_NO_FILL:${fill.status}`,
        updated_at: new Date().toISOString(),
      }).eq("id", intent.id);
      await db.from("v10_lane_claims").update({
        claim_state: "REJECTED",
        reject_reason: `TERMINAL_NO_FILL:${fill.status}`,
        updated_at: new Date().toISOString(),
      }).eq("signal_id", signal.signal_id);
      return { entered: false, reason: `TERMINAL_NO_FILL:${fill.status}` };
    }
    return { entered: false, reconciling: true, signalId: signal.signal_id };
  } catch (error) {
    const message = errorMessage(error);
    await db.from("v10_lane_order_intents").update({
      state: submitted ? "RECONCILIATION_FAILED" : "REJECTED",
      reject_reason: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", intent.id);
    await db.from("v10_lane_claims").update({
      claim_state: submitted ? "ORDERED" : "REJECTED",
      reject_reason: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("signal_id", signal.signal_id);
    if (submitted) await openCircuit(db, `V10_ENTRY_SUBMISSION_AMBIGUOUS:${message}`);
    throw error;
  }
}

function parseBinanceKlines(payload: unknown): { closed: V10RawBar[]; all: V10RawBar[] } {
  if (!Array.isArray(payload)) throw new Error("BINANCE_KLINES_NOT_ARRAY");
  const now = Date.now();
  const all: V10RawBar[] = [];
  const closed: V10RawBar[] = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const bar: V10RawBar = {
      openTimeMs: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    };
    const closeTimeMs = Number(row[6]);
    if (!Object.values(bar).every(Number.isFinite) || !Number.isFinite(closeTimeMs)) continue;
    all.push(bar);
    if (closeTimeMs < now) closed.push(bar);
  }
  return { closed, all };
}
async function fetchKlines(symbol: string): Promise<{ closed: V10RawBar[]; all: V10RawBar[] }> {
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", "160");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`BINANCE_KLINES_HTTP_${res.status}`);
    return parseBinanceKlines(await res.json());
  } finally {
    clearTimeout(timer);
  }
}
function nextOpenMap(allBars: readonly V10RawBar[]): Map<number, number> {
  const ordered = [...allBars].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const result = new Map<number, number>();
  for (let index = 0; index + 1 < ordered.length; index++) {
    result.set(ordered[index].openTimeMs, ordered[index + 1].open);
  }
  return result;
}
function completedAtIso(openTimeMs: number): string {
  return new Date(openTimeMs + V10_EXIT_BAR_INTERVAL_MS).toISOString();
}
function featureNumber(features: JsonRecord | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finite(features?.[key], Number.NaN);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function loadV10RegimeSource(db: DbClient): Promise<{
  rows: JsonRecord[];
  sourceError: string | null;
}> {
  const since = new Date(Date.now() - P10_MARKET_RISK_CONFIG.historyMaxAgeMs).toISOString();
  const { data, error } = await db.from("market_regime_observations")
    .select(
      "id,observation_bucket,observed_at,model_revision,predicted_regime,bull_score,confidence,sample_size,trading_influence,features",
    )
    .eq("model_revision", P10_MARKET_RISK_CONFIG.modelRevision)
    .eq("trading_influence", true)
    .gte("observed_at", since)
    .order("observed_at", { ascending: false })
    .limit(16);
  return {
    rows: (data || []) as JsonRecord[],
    sourceError: error ? error.message : null,
  };
}

function latestCompleted15mCloseMs(nowMs = Date.now()): number {
  return Math.floor(nowMs / V10_EXIT_BAR_INTERVAL_MS) * V10_EXIT_BAR_INTERVAL_MS;
}

async function evaluateLiveExits(
  db: DbClient,
  regimeSource: { rows: JsonRecord[]; sourceError: string | null },
): Promise<JsonRecord> {
  const { data: positions, error } = await db.from("v10_lane_positions")
    .select("*").eq("state", "OPEN").order("opened_at", { ascending: true }).limit(20);
  if (error) throw new Error(`V10_EXIT_POSITION_READ_FAILED:${error.message}`);
  if (!positions?.length) {
    return { evaluatedPositions: 0, decisions: 0, regimeTransitionExitTriggered: false };
  }

  const signalIds = [...new Set((positions as PositionRow[]).map((row) => row.signal_id))];
  const { data: signals, error: signalError } = await db.from("v10_lane_signals")
    .select("id,features").in("id", signalIds);
  if (signalError) throw new Error(`V10_EXIT_SIGNAL_READ_FAILED:${signalError.message}`);
  const signalMap = new Map((signals || []).map((row: any) => [row.id, row.features || {}]));
  let decisions = 0;
  let regimeTransitionExitTriggered = false;

  for (let position of positions as PositionRow[]) {
    if (!isV10LaneLiveEligible(position.lane)) {
      await openCircuit(db, `V10_UNVALIDATED_LIVE_POSITION:${position.lane}`);
      continue;
    }
    const policy = getV10ExitPolicy(position.lane);
    const entryPrice = finite(position.entry_price);
    const openedAtMs = Date.parse(position.opened_at);
    const features = signalMap.get(position.signal_id) || {};
    const entryBbPos = featureNumber(features, "bbPos", "bb_pos", "entryBbPos", "entry_bb_pos");
    if (!(entryPrice > 0) || !Number.isFinite(openedAtMs) || entryBbPos === null) {
      await openCircuit(db, `V10_EXIT_ENTRY_STATE_MISSING:${position.id}`);
      continue;
    }
    let state = position.exit_state && Object.keys(position.exit_state).length
      ? position.exit_state as V10ExitState
      : initialV10ExitState(entryPrice, entryBbPos);
    if (state.terminal) continue;

    const klines = await fetchKlines(position.symbol);
    const nextOpens = nextOpenMap(klines.all);
    const bars = prepareV10ExitBars(klines.closed).filter((bar) =>
      bar.openTimeMs >= openedAtMs - V10_EXIT_BAR_INTERVAL_MS &&
      (state.lastEvaluatedBarOpenMs === null || bar.openTimeMs > state.lastEvaluatedBarOpenMs)
    );
    let lastCompleted: string | null = position.last_exit_evaluated_bar_at;
    let lastReason: string | null = null;
    let lastTrigger: number | null = null;

    for (const bar of bars) {
      const stateBefore = state;
      const regimeSnapshot = buildV10RegimeSnapshot(
        regimeSource.rows,
        bar.openTimeMs + V10_EXIT_BAR_INTERVAL_MS,
        regimeSource.sourceError,
      );
      const transition = evaluateV10RegimeTransition({
        lane: position.lane,
        previousState: (state as JsonRecord).regimeTransition,
        completedBarOpenMs: bar.openTimeMs,
        snapshot: regimeSnapshot,
      });
      const transitionState = {
        ...state,
        regimeTransition: transition.nextState,
      } as V10ExitState & JsonRecord;
      const transitionExit = V10_REGIME_TRANSITION_LIVE_EXIT_COMPILED && transition.forceFullExit;
      const result: any = transitionExit
        ? {
          action: "FULL_NEXT_OPEN",
          reason: "REGIME_TRANSITION_EXIT",
          fraction: transitionState.remainingFraction,
          triggerPrice: null,
          executeAtNextOpen: true,
          nextState: {
            ...transitionState,
            terminal: true,
            lastEvaluatedBarOpenMs: bar.openTimeMs,
          },
          diagnostics: {
            ...transition.diagnostics,
            transitionReason: transition.reason,
            transitionLiveExitCompiled: V10_REGIME_TRANSITION_LIVE_EXIT_COMPILED,
          },
        }
        : evaluateV10ExitBar(
          {
            lane: position.lane,
            entryPrice,
            openedAtMs,
            leverage: position.leverage,
            state: transitionState,
          },
          bar,
          { liveMode: true },
        );
      if (transitionExit) regimeTransitionExitTriggered = true;
      state = result.nextState;
      const triggerPrice = result.executeAtNextOpen
        ? nextOpens.get(bar.openTimeMs) ?? null
        : result.triggerPrice;
      const completedBarAt = completedAtIso(bar.openTimeMs);
      const { error: decisionError } = await db.from("v10_lane_exit_decisions").upsert({
        position_id: position.id,
        signal_id: position.signal_id,
        lane: position.lane,
        fingerprint: position.fingerprint,
        exit_policy_key: policy.key,
        exit_policy_revision: V10_EXIT_ENGINE_REVISION,
        exit_policy_spec_sha256: V10_EXIT_SPEC_SHA256,
        completed_bar_at: completedBarAt,
        action: result.action,
        fraction: result.fraction,
        trigger_price: triggerPrice,
        reason: result.reason,
        state_before: stateBefore,
        state_after: {
          ...state,
          diagnostics: result.diagnostics,
          executorRevision: ENGINE_REVISION,
        },
        is_shadow: false,
        order_intent_id: null,
      }, {
        onConflict: "position_id,completed_bar_at,exit_policy_spec_sha256",
        ignoreDuplicates: true,
      });
      if (decisionError) throw new Error(`V10_EXIT_DECISION_WRITE_FAILED:${decisionError.message}`);
      decisions += 1;
      lastCompleted = completedBarAt;
      lastReason = result.reason;
      lastTrigger = triggerPrice;
      if (result.action === "RISK_CIRCUIT") {
        await openCircuit(db, `V10_EXIT_RISK_CIRCUIT:${result.reason}`);
        break;
      }
      if (state.terminal) break;
    }

    const { error: updateError } = await db.from("v10_lane_positions").update({
      exit_state: state,
      t1_completed: Boolean(state.t1Completed),
      peak_price: finite(state.peakPrice, entryPrice),
      last_exit_evaluated_bar_at: lastCompleted,
      last_exit_decision_at: lastReason ? new Date().toISOString() : null,
      exit_reason: lastReason,
      exit_trigger_price: lastTrigger,
      updated_at: new Date().toISOString(),
    }).eq("id", position.id);
    if (updateError) throw new Error(`V10_EXIT_STATE_WRITE_FAILED:${updateError.message}`);
  }
  return { evaluatedPositions: positions.length, decisions, regimeTransitionExitTriggered };
}

async function finalizeExitFill(
  db: DbClient,
  decision: any,
  intent: any,
  position: PositionRow,
  fill: GatewayFill,
): Promise<JsonRecord> {
  if (!(fill.executedQuantity > 0 && fill.averagePrice > 0)) {
    throw new Error("V10_EXIT_FILL_INCOMPLETE");
  }
  const remainingBefore = Math.max(
    0,
    finite(position.remaining_quantity, finite(position.quantity)),
  );
  const remainingAfter = Math.max(0, remainingBefore - fill.executedQuantity);
  const step = finite(intent?.request_payload?.quantity_step, 1e-8);
  const closed = remainingAfter < Math.max(step / 2, 1e-12);
  const pnl = (fill.averagePrice - finite(position.entry_price)) * fill.executedQuantity -
    fill.paidFeeQuote;
  const realizedPnl = finite(position.realized_pnl_usdt) + pnl;

  const { error: positionError } = await db.from("v10_lane_positions").update({
    remaining_quantity: closed ? 0 : remainingAfter,
    state: closed ? "CLOSED" : "OPEN",
    exit_price: fill.averagePrice,
    exit_order_id: fill.exchangeOrderId || intent.client_order_id,
    exit_client_order_id: intent.client_order_id,
    closed_at: closed ? new Date().toISOString() : null,
    realized_pnl_usdt: realizedPnl,
    reconciliation: {
      executor_revision: ENGINE_REVISION,
      exit_intent_id: intent.id,
      exit_decision_id: decision.id,
      exit_status: fill.status,
      paid_fee_quote: fill.paidFeeQuote,
    },
    updated_at: new Date().toISOString(),
  }).eq("id", position.id);
  if (positionError) throw new Error(`V10_EXIT_POSITION_WRITE_FAILED:${positionError.message}`);

  await db.from("v10_lane_order_intents").update({
    state: "FILLED",
    exchange_order_id: fill.exchangeOrderId,
    response_payload: fill.raw,
    updated_at: new Date().toISOString(),
  }).eq("id", intent.id);
  if (closed) {
    await db.from("v10_lane_claims").update({
      claim_state: "CLOSED",
      updated_at: new Date().toISOString(),
    }).eq("signal_id", position.signal_id);
  }
  return {
    closed,
    remainingQuantity: closed ? 0 : remainingAfter,
    exitPrice: fill.averagePrice,
    realizedPnlUsdt: realizedPnl,
  };
}

async function processExitDecisions(db: DbClient): Promise<JsonRecord[]> {
  const { data: decisions, error } = await db.from("v10_lane_exit_decisions")
    .select("*").eq("is_shadow", false).is("order_intent_id", null)
    .in("action", [
      "PARTIAL_AT_TRIGGER",
      "FULL_AT_TRIGGER",
      "PARTIAL_NEXT_OPEN",
      "FULL_NEXT_OPEN",
    ])
    .order("created_at", { ascending: true }).limit(20);
  if (error) throw new Error(`V10_EXIT_DECISION_READ_FAILED:${error.message}`);
  const results: JsonRecord[] = [];

  for (const decision of decisions || []) {
    const { data: position, error: positionError } = await db.from("v10_lane_positions")
      .select("*").eq("id", decision.position_id).eq("state", "OPEN").maybeSingle();
    if (positionError) throw new Error(`V10_EXIT_POSITION_LOAD_FAILED:${positionError.message}`);
    if (!position) continue;
    const info = await gateway({ action: "symbol_info", market: position.symbol });
    const step = finite(info?.quantity_step ?? info?.step_size);
    const remaining = finite(position.remaining_quantity, finite(position.quantity));
    const quantity = floorToStep(
      Math.min(remaining, remaining * finite(decision.fraction, 1)),
      step,
    );
    if (!(quantity > 0)) {
      await openCircuit(db, `V10_EXIT_ZERO_QUANTITY:${decision.id}`);
      continue;
    }
    const clientOrderId = v10ClientOrderId(
      "v10x",
      `${decision.id}${String(position.id).replaceAll("-", "")}`,
    );
    const requestPayload = {
      action: "create_order",
      order: {
        market: position.symbol,
        side: "SELL",
        type: "MARKET",
        quantity,
        identifier: clientOrderId,
        position_side: "LONG",
        position_effect: "CLOSE",
      },
      wait_for_final_ms: 4000,
    };
    const { data: intent, error: intentError } = await db.from("v10_lane_order_intents")
      .insert({
        signal_id: position.signal_id,
        lane: position.lane,
        fingerprint: position.fingerprint,
        symbol: position.symbol,
        intent: "CLOSE_LONG",
        client_order_id: clientOrderId,
        notional_usdt: Math.max(1, quantity * finite(decision.trigger_price, position.entry_price)),
        requested_qty: quantity,
        state: "PLANNED",
        exit_decision_id: decision.id,
        request_payload: {
          ...requestPayload,
          quantity_step: step,
          trigger_price: decision.trigger_price,
          decision_action: decision.action,
          decision_reason: decision.reason,
        },
      }).select("*").single();
    if (intentError) throw new Error(`V10_EXIT_INTENT_FAILED:${intentError.message}`);

    const { error: linkError } = await db.from("v10_lane_exit_decisions")
      .update({ order_intent_id: intent.id }).eq("id", decision.id);
    if (linkError) throw new Error(`V10_EXIT_DECISION_LINK_FAILED:${linkError.message}`);

    let submitted = false;
    try {
      submitted = true;
      const payload = await gateway(requestPayload);
      const fill = parseGatewayFill(payload);
      await db.from("v10_lane_order_intents").update({
        state: fill.executedQuantity > 0 ? "FILLED" : "SUBMITTED",
        exchange_order_id: fill.exchangeOrderId,
        response_payload: payload,
        updated_at: new Date().toISOString(),
      }).eq("id", intent.id);
      if (fill.executedQuantity > 0) {
        results.push({
          decisionId: decision.id,
          positionId: position.id,
          ...(await finalizeExitFill(db, decision, intent, position as PositionRow, fill)),
        });
      } else if (isTerminalNoFill(fill)) {
        await db.from("v10_lane_order_intents").update({
          state: "RECONCILIATION_FAILED",
          reject_reason: `V10_EXIT_TERMINAL_NO_FILL:${fill.status}`,
          updated_at: new Date().toISOString(),
        }).eq("id", intent.id);
        await openCircuit(db, `V10_EXIT_TERMINAL_NO_FILL:${decision.id}:${fill.status}`);
      } else {
        results.push({ decisionId: decision.id, reconciling: true });
      }
    } catch (error) {
      const message = errorMessage(error);
      await db.from("v10_lane_order_intents").update({
        state: submitted ? "RECONCILIATION_FAILED" : "REJECTED",
        reject_reason: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", intent.id);
      await openCircuit(db, `V10_EXIT_SUBMISSION_AMBIGUOUS:${message}`);
      throw error;
    }
  }
  return results;
}

async function reconcileSubmittedIntents(db: DbClient): Promise<JsonRecord[]> {
  const { data: intents, error } = await db.from("v10_lane_order_intents")
    .select("*").in("state", ["SUBMITTED", "RECONCILIATION_FAILED"])
    .order("created_at", { ascending: true }).limit(20);
  if (error) throw new Error(`V10_RECONCILIATION_READ_FAILED:${error.message}`);
  const results: JsonRecord[] = [];
  for (const intent of intents || []) {
    try {
      const payload = await gateway({
        action: "get_order",
        identifier: intent.client_order_id,
        market: intent.symbol,
      });
      const fill = parseGatewayFill(payload);
      if (fill.executedQuantity > 0) {
        if (intent.intent === "OPEN_LONG") {
          const { data: signal, error: signalError } = await db.from("v10_lane_signals")
            .select("*").eq("id", intent.signal_id).single();
          if (signalError) throw new Error(`V10_RECON_SIGNAL_FAILED:${signalError.message}`);
          const position = await finalizeEntryFill(
            db,
            {
              ...signal,
              signal_id: signal.id,
              notional_usdt: finite(intent.request_payload?.margin_usdt, 40),
              leverage: finite(intent.request_payload?.leverage, 3),
            } as ClaimedSignal,
            intent,
            fill,
          );
          results.push({ intentId: intent.id, reconciled: "ENTRY", positionId: position.id });
        } else {
          const { data: decision, error: decisionError } = await db.from("v10_lane_exit_decisions")
            .select("*").eq("id", intent.exit_decision_id).single();
          if (decisionError) throw new Error(`V10_RECON_DECISION_FAILED:${decisionError.message}`);
          const { data: position, error: positionError } = await db.from("v10_lane_positions")
            .select("*").eq("signal_id", intent.signal_id).single();
          if (positionError) throw new Error(`V10_RECON_POSITION_FAILED:${positionError.message}`);
          results.push({
            intentId: intent.id,
            reconciled: "EXIT",
            ...(await finalizeExitFill(db, decision, intent, position as PositionRow, fill)),
          });
        }
      } else if (isTerminalNoFill(fill)) {
        await db.from("v10_lane_order_intents").update({
          state: "REJECTED",
          reject_reason: `TERMINAL_NO_FILL:${fill.status}`,
          response_payload: payload,
          updated_at: new Date().toISOString(),
        }).eq("id", intent.id);
        if (intent.intent === "OPEN_LONG") {
          await db.from("v10_lane_claims").update({
            claim_state: "REJECTED",
            reject_reason: `TERMINAL_NO_FILL:${fill.status}`,
            updated_at: new Date().toISOString(),
          }).eq("signal_id", intent.signal_id);
        } else {
          await openCircuit(db, `V10_EXIT_RECONCILIATION_NO_FILL:${intent.id}`);
        }
      }
    } catch (error) {
      results.push({ intentId: intent.id, error: errorMessage(error) });
    }
  }
  return results;
}

async function runExecutor(db: DbClient): Promise<JsonRecord> {
  const { data: runtime, error: runtimeError } = await db.from("v10_lane_executor_runtime")
    .select("*").eq("singleton", true).single();
  if (runtimeError) throw new Error(`V10_EXECUTOR_RUNTIME_READ_FAILED:${runtimeError.message}`);
  if (
    runtime.engine_revision !== ENGINE_REVISION ||
    runtime.signal_revision !== SIGNAL_REVISION ||
    runtime.signal_spec_sha256 !== SIGNAL_SPEC_SHA256
  ) throw new Error("V10_EXECUTOR_IDENTITY_MISMATCH");
  if (runtime.live_enabled !== true) {
    return { ok: true, skipped: "EXECUTOR_LIVE_DISABLED", engine: ENGINE_REVISION };
  }

  const reconciliations = await reconcileSubmittedIntents(db);
  const regimeSource = await loadV10RegimeSource(db);
  const currentRegime = buildV10RegimeSnapshot(
    regimeSource.rows,
    latestCompleted15mCloseMs(),
    regimeSource.sourceError,
  );
  const exitEvaluation = await evaluateLiveExits(db, regimeSource);
  const exits = await processExitDecisions(db);

  let entry: JsonRecord | null = null;
  if (currentRegime.blockNewEntries) {
    entry = { entered: false, reason: "V10_REGIME_UNKNOWN_ENTRY_BLOCK" };
  } else if (exitEvaluation.regimeTransitionExitTriggered) {
    entry = { entered: false, reason: "V10_REGIME_TRANSITION_REENTRY_COOLDOWN" };
  } else {
    const { data: claimed, error: claimError } = await db.rpc("claim_v10_lane_signal_v3");
    if (claimError) throw new Error(`V10_SIGNAL_CLAIM_FAILED:${claimError.message}`);
    const signal = Array.isArray(claimed) ? claimed[0] as ClaimedSignal | undefined : undefined;
    if (signal) entry = await executeClaimedEntry(db, signal);
  }

  await db.from("v10_lane_executor_runtime").update({
    last_success_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    last_entry_at: entry?.entered ? new Date().toISOString() : runtime.last_entry_at,
    last_exit_at: exits.some((row) => row.closed || row.remainingQuantity != null)
      ? new Date().toISOString()
      : runtime.last_exit_at,
    updated_at: new Date().toISOString(),
  }).eq("singleton", true);

  return {
    ok: true,
    engine: ENGINE_REVISION,
    lane: "RANGE",
    reconciliations,
    exitEvaluation,
    exits,
    entry,
    regime: { ...currentRegime, transitionRevision: V10_REGIME_TRANSITION_REVISION },
  };
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = env("SUPABASE_URL");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return response(500, { ok: false, error: "SUPABASE_ENV_MISSING" });
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (!(await authorized(db, req))) return response(401, { ok: false, error: "UNAUTHORIZED" });

  const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
  try {
    if (String(body?.mode || "").toLowerCase() === "preflight") {
      return response(200, await executorPreflight(db, String(body?.symbol || "BTCUSDT")));
    }
    return response(200, await runExecutor(db));
  } catch (error) {
    const message = errorMessage(error);
    try {
      await db.from("v10_lane_executor_runtime").update({
        last_error: message.slice(0, 1000),
        consecutive_failures: 1,
        updated_at: new Date().toISOString(),
      }).eq("singleton", true);
    } catch {
      // The response still has to preserve the original executor failure.
    }
    return response(500, { ok: false, engine: ENGINE_REVISION, error: message });
  }
});
