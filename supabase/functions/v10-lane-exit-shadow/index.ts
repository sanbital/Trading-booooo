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
  V10_EXIT_BAR_INTERVAL_MS,
  V10_EXIT_ENGINE_REVISION,
  V10_EXIT_LIVE_ORDER_ROUTING_COMPILED,
  V10_EXIT_SPEC_SHA256,
  type V10Lane,
} from "../_shared/v10_lane_exit_config.ts";

interface PositionRow {
  id: string;
  signal_id: string;
  lane: V10Lane;
  fingerprint: string;
  symbol: string;
  entry_price: number | string;
  leverage: number;
  opened_at: string;
}
interface SignalRow { id: string; features: Record<string, unknown> | null }
interface ShadowStateRow {
  position_id: string;
  state: V10ExitState;
  last_evaluated_bar_at: string | null;
  terminal: boolean;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function featureNumber(features: Record<string, unknown> | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(features?.[key]);
    if (value !== null) return value;
  }
  return null;
}
function parseBinanceKlines(payload: unknown): { closed: V10RawBar[]; all: V10RawBar[] } {
  if (!Array.isArray(payload)) throw new Error("BINANCE_KLINES_NOT_ARRAY");
  const now = Date.now();
  const all: V10RawBar[] = [];
  const closed: V10RawBar[] = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const bar: V10RawBar = {
      openTimeMs: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]),
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
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`BINANCE_KLINES_HTTP_${res.status}`);
    return parseBinanceKlines(await res.json());
  } finally { clearTimeout(timeout); }
}
function nextOpenMap(allBars: readonly V10RawBar[]): Map<number, number> {
  const ordered = [...allBars].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const output = new Map<number, number>();
  for (let i = 0; i + 1 < ordered.length; i++) output.set(ordered[i].openTimeMs, ordered[i + 1].open);
  return output;
}
function completedAtIso(openTimeMs: number): string {
  return new Date(openTimeMs + V10_EXIT_BAR_INTERVAL_MS).toISOString();
}

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return response(500, { error: "SUPABASE_ENV_MISSING" });

  const authorization = req.headers.get("authorization");
  const internalSecret = Deno.env.get("V10_EXIT_INTERNAL_SECRET");
  const authorized = authorization === `Bearer ${serviceRoleKey}` ||
    (internalSecret && req.headers.get("x-v10-exit-secret") === internalSecret);
  if (!authorized) return response(401, { error: "UNAUTHORIZED" });

  let requestedMode = "shadow";
  let requestedLimit = 50;
  if (req.method !== "GET") {
    const body = await req.json().catch(() => ({}));
    requestedMode = String(body?.mode ?? "shadow").toLowerCase();
    requestedLimit = Math.max(1, Math.min(50, Number(body?.limit ?? 50)));
  }

  if (requestedMode !== "shadow" || V10_EXIT_LIVE_ORDER_ROUTING_COMPILED) {
    return response(409, {
      error: "LIVE_ORDER_ROUTING_NOT_COMPILED", requestedMode,
      compiled: V10_EXIT_LIVE_ORDER_ROUTING_COMPILED,
    });
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: runtime, error: runtimeError } = await db
    .from("v10_lane_exit_runtime")
    .select("shadow_enabled,live_enabled,engine_revision,spec_sha256")
    .eq("singleton", true).single();
  if (runtimeError) return response(500, { error: "RUNTIME_READ_FAILED", detail: runtimeError.message });
  if (!runtime?.shadow_enabled) return response(200, { skipped: "SHADOW_DISABLED", revision: V10_EXIT_ENGINE_REVISION });
  if (runtime.engine_revision !== V10_EXIT_ENGINE_REVISION || runtime.spec_sha256 !== V10_EXIT_SPEC_SHA256) {
    return response(409, {
      error: "EXIT_POLICY_IDENTITY_MISMATCH",
      expected: { revision: V10_EXIT_ENGINE_REVISION, sha256: V10_EXIT_SPEC_SHA256 },
      actual: { revision: runtime.engine_revision, sha256: runtime.spec_sha256 },
    });
  }

  const { data: positions, error: positionError } = await db
    .from("v10_lane_positions")
    .select("id,signal_id,lane,fingerprint,symbol,entry_price,leverage,opened_at")
    .eq("state", "OPEN").order("opened_at", { ascending: true }).limit(requestedLimit);
  if (positionError) return response(500, { error: "POSITION_READ_FAILED", detail: positionError.message });

  if (!positions?.length) {
    await db.from("v10_lane_exit_runtime").update({
      last_success_at: new Date().toISOString(), last_error: null,
      consecutive_failures: 0, updated_at: new Date().toISOString(),
    }).eq("singleton", true);
    return response(200, {
      ok: true, evaluatedPositions: 0, liveOrdersSubmitted: 0,
      revision: V10_EXIT_ENGINE_REVISION, elapsedMs: Date.now() - startedAt,
    });
  }

  const signalIds = [...new Set((positions as PositionRow[]).map((p) => p.signal_id))];
  const positionIds = (positions as PositionRow[]).map((p) => p.id);
  const [{ data: signals, error: signalError }, { data: shadowRows, error: shadowError }] = await Promise.all([
    db.from("v10_lane_signals").select("id,features").in("id", signalIds),
    db.from("v10_lane_exit_shadow_state")
      .select("position_id,state,last_evaluated_bar_at,terminal").in("position_id", positionIds),
  ]);
  if (signalError || shadowError) {
    return response(500, {
      error: "DEPENDENCY_READ_FAILED", signal: signalError?.message ?? null,
      shadow: shadowError?.message ?? null,
    });
  }

  const signalMap = new Map((signals as SignalRow[] ?? []).map((row) => [row.id, row]));
  const shadowMap = new Map((shadowRows as ShadowStateRow[] ?? []).map((row) => [row.position_id, row]));
  const summary: Record<string, unknown>[] = [];
  let lastCompletedBarAt: string | null = null;
  let totalDecisions = 0;

  try {
    for (const position of positions as PositionRow[]) {
      const policy = getV10ExitPolicy(position.lane);
      const entryPrice = asNumber(position.entry_price);
      const openedAtMs = Date.parse(position.opened_at);
      const signal = signalMap.get(position.signal_id);
      const priorShadow = shadowMap.get(position.id);
      const entryBbPos = priorShadow?.state?.entryBbPos ?? featureNumber(
        signal?.features ?? null, "bb_pos", "bbPos", "entry_bb_pos", "entryBbPos",
      );
      if (entryPrice === null || !Number.isFinite(openedAtMs) || entryBbPos === null) {
        summary.push({ positionId: position.id, symbol: position.symbol, lane: position.lane, error: "ENTRY_STATE_MISSING" });
        continue;
      }

      let state = priorShadow?.state ?? initialV10ExitState(entryPrice, entryBbPos);
      if (priorShadow?.terminal || state.terminal) {
        summary.push({ positionId: position.id, symbol: position.symbol, lane: position.lane, skipped: "TERMINAL" });
        continue;
      }

      const klines = await fetchKlines(position.symbol);
      const nextOpens = nextOpenMap(klines.all);
      const prepared = prepareV10ExitBars(klines.closed);
      const bars = prepared.filter((bar) =>
        bar.openTimeMs >= openedAtMs - V10_EXIT_BAR_INTERVAL_MS &&
        (state.lastEvaluatedBarOpenMs === null || bar.openTimeMs > state.lastEvaluatedBarOpenMs)
      );

      let positionDecisions = 0;
      let terminalReason: string | null = null;
      for (const bar of bars) {
        const stateBefore = state;
        const result = evaluateV10ExitBar({
          lane: position.lane, entryPrice, openedAtMs, leverage: position.leverage, state,
        }, bar, { liveMode: false });
        state = result.nextState;
        const nextOpen = result.executeAtNextOpen ? nextOpens.get(bar.openTimeMs) ?? null : result.triggerPrice;
        const completedBarAt = completedAtIso(bar.openTimeMs);
        const { error: decisionError } = await db.from("v10_lane_exit_decisions").upsert({
          position_id: position.id, signal_id: position.signal_id, lane: position.lane,
          fingerprint: position.fingerprint, exit_policy_key: policy.key,
          exit_policy_revision: V10_EXIT_ENGINE_REVISION,
          exit_policy_spec_sha256: V10_EXIT_SPEC_SHA256,
          completed_bar_at: completedBarAt, action: result.action,
          fraction: result.fraction, trigger_price: nextOpen, reason: result.reason,
          state_before: stateBefore,
          state_after: { ...state, diagnostics: result.diagnostics, researchRevision: policy.researchRevision },
          is_shadow: true, order_intent_id: null,
        }, {
          onConflict: "position_id,completed_bar_at,exit_policy_spec_sha256", ignoreDuplicates: true,
        });
        if (decisionError) throw new Error(`DECISION_WRITE_FAILED:${decisionError.message}`);
        totalDecisions += 1;
        positionDecisions += 1;
        lastCompletedBarAt = completedBarAt;
        if (state.terminal || result.action === "RISK_CIRCUIT") {
          terminalReason = result.reason;
          break;
        }
      }

      const { error: stateError } = await db.from("v10_lane_exit_shadow_state").upsert({
        position_id: position.id, policy_key: policy.key,
        policy_revision: V10_EXIT_ENGINE_REVISION, spec_sha256: V10_EXIT_SPEC_SHA256,
        state,
        last_evaluated_bar_at: state.lastEvaluatedBarOpenMs === null
          ? priorShadow?.last_evaluated_bar_at ?? null
          : completedAtIso(state.lastEvaluatedBarOpenMs),
        terminal: state.terminal, terminal_reason: terminalReason,
        updated_at: new Date().toISOString(),
      }, { onConflict: "position_id" });
      if (stateError) throw new Error(`SHADOW_STATE_WRITE_FAILED:${stateError.message}`);
      summary.push({
        positionId: position.id, symbol: position.symbol, lane: position.lane,
        policy: policy.key, validated: policy.validated, decisions: positionDecisions,
        terminal: state.terminal, terminalReason,
      });
    }

    await db.from("v10_lane_exit_runtime").update({
      last_completed_bar_at: lastCompletedBarAt, last_success_at: new Date().toISOString(),
      last_error: null, consecutive_failures: 0, updated_at: new Date().toISOString(),
    }).eq("singleton", true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.rpc("record_v10_lane_exit_runtime_failure", { p_error: message }).catch(() => undefined);
    return response(500, {
      error: "V10_EXIT_SHADOW_RUN_FAILED", detail: message, liveOrdersSubmitted: 0,
      revision: V10_EXIT_ENGINE_REVISION,
    });
  }

  return response(200, {
    ok: true, mode: "shadow", evaluatedPositions: positions.length,
    decisions: totalDecisions, liveOrdersSubmitted: 0,
    liveOrderRoutingCompiled: V10_EXIT_LIVE_ORDER_ROUTING_COMPILED,
    revision: V10_EXIT_ENGINE_REVISION, specSha256: V10_EXIT_SPEC_SHA256,
    elapsedMs: Date.now() - startedAt, positions: summary,
  });
});
