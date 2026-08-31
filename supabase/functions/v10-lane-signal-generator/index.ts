import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  admitLaneCandidates,
  BAR_MS,
  computeBtcContext,
  computeLaneFeatures,
  evaluateLane,
  expectedEntryBarAt,
  expectedExitBarAt,
  LANE_CONFIG,
  LaneBar,
  LaneDecision,
  MAX_CONCURRENT_TOTAL,
  REQUIRED_BARS,
  V10_LANES_REVISION,
  V10_LANES_SPEC_SHA256,
  V10_LANES_UNIVERSE,
} from "../_shared/v10_lanes_v3.ts";

const BINANCE_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
] as const;
const FETCH_LIMIT = 1500;
const MAX_DATA_AGE_MS = 3 * 60 * 1000;

interface RecentSignal {
  lane: string;
  symbol: string;
  signal_bar_at: string;
  hold_hours: number;
  fingerprint: string;
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mapLimit<T, U>(items: readonly T[], limit: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return result;
}

async function fetchJson(urlPath: string): Promise<unknown> {
  let lastError = "UNKNOWN";
  for (const base of BINANCE_BASES) {
    try {
      const result = await fetch(`${base}${urlPath}`, {
        headers: { "user-agent": "Trading-booooo-V10-Lanes/3.0.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) {
        lastError = `${base}:${result.status}:${await result.text()}`;
        continue;
      }
      return await result.json();
    } catch (error) {
      lastError = `${base}:${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`BINANCE_FETCH_FAILED:${lastError}`);
}

function parseKline(row: unknown): LaneBar {
  if (!Array.isArray(row) || row.length < 8) throw new Error("INVALID_BINANCE_KLINE");
  const parsed: LaneBar = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    quoteVolume: Number(row[7]),
  };
  if (!Number.isFinite(parsed.openTime + parsed.open + parsed.high + parsed.low + parsed.close + parsed.quoteVolume)) {
    throw new Error("NON_FINITE_BINANCE_KLINE");
  }
  return parsed;
}

async function fetchClosedBars(symbol: string, signalOpenTime: number): Promise<LaneBar[]> {
  const byTime = new Map<number, LaneBar>();
  let endTime = signalOpenTime + BAR_MS - 1;
  for (let page = 0; page < 2; page += 1) {
    const params = new URLSearchParams({
      symbol,
      interval: "15m",
      limit: String(FETCH_LIMIT),
      endTime: String(endTime),
    });
    const payload = await fetchJson(`/fapi/v1/klines?${params}`);
    if (!Array.isArray(payload) || payload.length === 0) throw new Error(`EMPTY_KLINES:${symbol}`);
    for (const raw of payload) {
      const bar = parseKline(raw);
      if (bar.openTime <= signalOpenTime) byTime.set(bar.openTime, bar);
    }
    const oldest = Math.min(...payload.map((raw) => Number((raw as unknown[])[0])));
    endTime = oldest - 1;
  }
  const bars = [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
  if (bars.length < REQUIRED_BARS) throw new Error(`INSUFFICIENT_KLINES:${symbol}:${bars.length}`);
  if (bars[bars.length - 1].openTime !== signalOpenTime) {
    throw new Error(`LATEST_COMPLETED_BAR_MISSING:${symbol}:${bars[bars.length - 1].openTime}:${signalOpenTime}`);
  }
  return bars.slice(-Math.max(REQUIRED_BARS, 2940));
}

Deno.serve(async (request) => {
  const invocationId = crypto.randomUUID();
  const cronSecret = Deno.env.get("V10_LANE_CRON_SECRET");
  if (!cronSecret) return response(503, { ok: false, invocationId, error: "V10_LANE_CRON_SECRET_MISSING" });
  if (request.headers.get("x-v10-cron-secret") !== cronSecret) {
    return response(401, { ok: false, invocationId, error: "UNAUTHORIZED" });
  }
  if (request.method !== "POST") return response(405, { ok: false, invocationId, error: "METHOD_NOT_ALLOWED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return response(503, { ok: false, invocationId, error: "SUPABASE_RUNTIME_SECRET_MISSING" });
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const now = Date.now();
    const currentOpenTime = Math.floor(now / BAR_MS) * BAR_MS;
    const signalOpenTime = currentOpenTime - BAR_MS;
    const completedAt = signalOpenTime + BAR_MS;
    if (now - completedAt > MAX_DATA_AGE_MS) {
      return response(409, { ok: false, invocationId, error: "INVOCATION_OUTSIDE_ENTRY_WINDOW", signalOpenTime, ageMs: now - completedAt });
    }

    const symbols = ["BTCUSDT", ...V10_LANES_UNIVERSE];
    const rows = await mapLimit(symbols, 4, async (symbol) => [symbol, await fetchClosedBars(symbol, signalOpenTime)] as const);
    const barsBySymbol = new Map(rows);
    const btcBars = barsBySymbol.get("BTCUSDT");
    if (!btcBars) throw new Error("BTC_BARS_MISSING");
    const btcContext = computeBtcContext(btcBars);

    const { data: flags, error: flagsError } = await supabase
      .from("v10_lane_flags")
      .select("lane,shadow_enabled,live_enabled,max_concurrent,notional_usdt");
    if (flagsError) throw new Error(`FLAGS_READ_FAILED:${flagsError.message}`);
    const flagByLane = new Map((flags ?? []).map((row) => [String(row.lane), row]));

    const fingerprints = Object.values(LANE_CONFIG).map((config) => config.fingerprint);
    const { data: versions, error: versionsError } = await supabase
      .from("v10_lane_strategy_versions")
      .select("fingerprint,lane,revision")
      .in("fingerprint", fingerprints);
    if (versionsError) throw new Error(`VERSIONS_READ_FAILED:${versionsError.message}`);
    const registered = new Set((versions ?? []).map((row) => String(row.fingerprint)));

    const evaluated: LaneDecision[] = [];
    const dataErrors: Record<string, string> = {};
    for (const symbol of V10_LANES_UNIVERSE) {
      const assetBars = barsBySymbol.get(symbol);
      if (!assetBars) {
        dataErrors[symbol] = "BARS_MISSING";
        continue;
      }
      try {
        const features = computeLaneFeatures(symbol, assetBars, btcBars, true);
        evaluated.push(evaluateLane(features));
      } catch (error) {
        dataErrors[symbol] = error instanceof Error ? error.message : String(error);
      }
    }

    const route = evaluated[0]?.lane ?? (btcContext.btc72 < -0.05 ? "BEAR" : btcContext.btc72 <= 0.04 ? "RANGE" : btcContext.btc72 > 0.05 ? "BULL" : "CASH");
    if (route === "CASH") {
      return response(200, { ok: true, invocationId, engine: V10_LANES_REVISION, specSha256: V10_LANES_SPEC_SHA256, route, inserted: 0, dataErrors });
    }

    const config = LANE_CONFIG[route];
    const flag = flagByLane.get(route);
    if (!registered.has(config.fingerprint)) {
      return response(200, { ok: true, invocationId, route, inserted: 0, blocked: "STRATEGY_NOT_VALIDATED_OR_REGISTERED", fingerprint: config.fingerprint });
    }
    if (!flag || (!flag.shadow_enabled && !flag.live_enabled)) {
      return response(200, { ok: true, invocationId, route, inserted: 0, blocked: "LANE_DISABLED", fingerprint: config.fingerprint });
    }
    if (flag.live_enabled && Deno.env.get("V10_LANE_EXECUTION_BRIDGE_ENABLED") !== "true") {
      return response(503, { ok: false, invocationId, route, error: "LIVE_FLAG_WITHOUT_EXECUTION_BRIDGE" });
    }

    const since = new Date(signalOpenTime - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from("v10_lane_signals")
      .select("lane,symbol,signal_bar_at,hold_hours,fingerprint")
      .gte("signal_bar_at", since)
      .in("fingerprint", fingerprints);
    if (recentError) throw new Error(`RECENT_SIGNALS_READ_FAILED:${recentError.message}`);
    const recentSignals = (recent ?? []) as RecentSignal[];
    const active = recentSignals
      .filter((row) => Date.parse(row.signal_bar_at) + Number(row.hold_hours) * 60 * 60 * 1000 > signalOpenTime)
      .map((row) => ({ symbol: row.symbol, exitBarAt: Date.parse(row.signal_bar_at) + Number(row.hold_hours) * 60 * 60 * 1000 }));

    const cooldownEligible = evaluated.filter((decision) => {
      if (!decision.eligible || decision.lane !== route || !decision.fingerprint || !decision.cooldownHours) return false;
      const last = recentSignals
        .filter((row) => row.fingerprint === decision.fingerprint && row.symbol === decision.features.symbol)
        .reduce((latest, row) => Math.max(latest, Date.parse(row.signal_bar_at)), 0);
      return last === 0 || signalOpenTime - last >= decision.cooldownHours * 60 * 60 * 1000;
    });
    const capacity = Math.min(MAX_CONCURRENT_TOTAL, Number(flag.max_concurrent ?? MAX_CONCURRENT_TOTAL));
    const admitted = admitLaneCandidates(cooldownEligible, active, signalOpenTime, capacity);

    const signalRows = await Promise.all(admitted.map(async (decision) => {
      const featurePayload = {
        engineRevision: V10_LANES_REVISION,
        specSha256: V10_LANES_SPEC_SHA256,
        btc72: decision.features.btc72,
        btc30d: decision.features.btc30d,
        atr: decision.features.atr,
        atrBaseline: decision.features.atrBaseline,
        atrRatio: decision.features.atrRatio,
        bbPos: decision.features.bbPos,
        bbPos1hAgo: decision.features.bbPos1hAgo,
        assetRet24h: decision.features.assetRet24h,
        quoteVolume24h: decision.features.quoteVolume24h,
        decisionReason: decision.reason,
        inputSha256: await sha256(decision.features),
        invocationId,
      };
      return {
        fingerprint: decision.fingerprint,
        lane: decision.lane,
        exchange: "BINANCE_USDS_M",
        symbol: decision.features.symbol,
        side: "LONG",
        signal_bar_at: new Date(signalOpenTime).toISOString(),
        entry_bar_at: new Date(expectedEntryBarAt(signalOpenTime)).toISOString(),
        hold_hours: decision.holdHours,
        features: featurePayload,
        is_shadow: !flag.live_enabled,
      };
    }));

    if (signalRows.length > 0) {
      const { error: insertError } = await supabase.from("v10_lane_signals").upsert(signalRows, {
        onConflict: "fingerprint,exchange,symbol,lane,side,signal_bar_at",
        ignoreDuplicates: true,
      });
      if (insertError) throw new Error(`SIGNAL_INSERT_FAILED:${insertError.message}`);
    }

    return response(200, {
      ok: true,
      invocationId,
      engine: V10_LANES_REVISION,
      specSha256: V10_LANES_SPEC_SHA256,
      route,
      fingerprint: config.fingerprint,
      signalOpenTime,
      evaluated: evaluated.length,
      eligible: cooldownEligible.length,
      admitted: admitted.map((decision) => decision.features.symbol),
      inserted: signalRows.length,
      shadow: !flag.live_enabled,
      activeBefore: active.length,
      expectedExits: admitted.map((decision) => ({ symbol: decision.features.symbol, exitBarAt: expectedExitBarAt(signalOpenTime, decision.holdHours ?? 0) })),
      dataErrors,
    });
  } catch (error) {
    return response(500, {
      ok: false,
      invocationId,
      engine: V10_LANES_REVISION,
      specSha256: V10_LANES_SPEC_SHA256,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
