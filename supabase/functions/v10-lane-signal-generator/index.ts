// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { discoverBinanceUsdtPerpetualUniverse } from "../_shared/binance-futures-universe.ts";

// Research/shadow cutover: the arbitrary 15-symbol list is intentionally gone.
// This file does not write executable signals while the dynamic-universe change is being validated.
const REVISION = "V11-LONG-REGIME-DYNAMIC-UNIVERSE-SHADOW-1.0.0";
const PATCH = "DYNAMIC-USDM-PERP-UNIVERSE-SHADOW-20260906";
const SHADOW_ONLY = true;
const OBSERVER_REVISION = "MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const OBSERVER_SOURCE = "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE";
const BAR_MS = 15 * 60_000;
const ATR_BARS = 56;
const ATR_BASE_BARS = 2880;
const BB_BARS = 80;
const RET24_BARS = 96;
const QV24_BARS = 96;
const BTC72_BARS = 288;
const REQUIRED_BARS = ATR_BASE_BARS + ATR_BARS + 2;
const MIN_QV24 = 50_000_000;
const OBSERVER_MAX_AGE_MS = 12 * 60_000;
const BINANCE_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
];

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function finite(v: unknown, d = Number.NaN): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function record(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function mean(xs: number[]): number { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function sampleStd(xs: number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function routeFromBtc72(v: number): string {
  return v < -.05 ? "BEAR" : v <= .04 ? "RANGE" : v > .05 ? "BULL" : "CASH";
}
function observerRoute(v: unknown): string {
  const r = String(v || "").toUpperCase();
  return r === "RISK_OFF" ? "BEAR" : r === "NEUTRAL" ? "RANGE" :
    (r === "BULL" || r === "STRONG_BULL") ? "BULL" : "CASH";
}

async function fetchJson(path: string): Promise<any> {
  let last = "UNKNOWN";
  for (const base of BINANCE_BASES) {
    try {
      const r = await fetch(`${base}${path}`, {
        headers: { "user-agent": "Trading-booooo-v11-dynamic-shadow/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : null;
      last = `${base}:${r.status}:${text.slice(0, 180)}`;
    } catch (e) {
      last = `${base}:${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`BINANCE_FETCH_FAILED:${last}`);
}
function parseBar(row: any[]): any {
  if (!Array.isArray(row) || row.length < 11) throw new Error("INVALID_KLINE");
  const b = {
    openTime: finite(row[0]), open: finite(row[1]), high: finite(row[2]), low: finite(row[3]),
    close: finite(row[4]), closeTime: finite(row[6]), quoteVolume: finite(row[7]),
    takerBuyQuote: finite(row[10]),
  };
  if (!Object.values(b).every(Number.isFinite)) throw new Error("INVALID_KLINE_VALUES");
  return b;
}
async function fetchHistory(symbol: string, signalOpenTime: number): Promise<any[]> {
  const byTime = new Map<number, any>();
  let endTime = signalOpenTime + BAR_MS - 1;
  for (let page = 0; page < 3 && byTime.size < REQUIRED_BARS; page++) {
    const p = new URLSearchParams({ symbol, interval: "15m", limit: "1500", endTime: String(endTime) });
    const raw = await fetchJson(`/fapi/v1/klines?${p}`);
    if (!Array.isArray(raw) || !raw.length) throw new Error(`EMPTY_KLINES:${symbol}`);
    for (const row of raw) {
      const b = parseBar(row);
      if (b.openTime <= signalOpenTime) byTime.set(b.openTime, b);
    }
    endTime = Math.min(...raw.map((r: any[]) => finite(r[0]))) - 1;
  }
  const bars = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  if (bars.length < REQUIRED_BARS) throw new Error(`INSUFFICIENT_HISTORY:${symbol}:${bars.length}`);
  if (bars.at(-1)?.openTime !== signalOpenTime) throw new Error(`LATEST_COMPLETED_BAR_MISSING:${symbol}`);
  return bars.slice(-3000);
}
async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}
function buildAtr(bars: any[]): number[] {
  const tr = new Array(bars.length).fill(Number.NaN);
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }
  const atr = new Array(bars.length).fill(Number.NaN);
  let rolling = 0, count = 0;
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(tr[i])) { rolling += tr[i]; count++; }
    const out = i - ATR_BARS;
    if (out >= 0 && Number.isFinite(tr[out])) { rolling -= tr[out]; count--; }
    if (count === ATR_BARS) atr[i] = rolling / ATR_BARS;
  }
  return atr;
}
function bbAt(bars: any[], i: number): number {
  const xs = bars.slice(i - BB_BARS + 1, i + 1).map((b) => b.close);
  if (xs.length !== BB_BARS) return Number.NaN;
  const sd = sampleStd(xs);
  return sd > 0 ? (bars[i].close - mean(xs)) / (2 * sd) : Number.NaN;
}
function computeFeatures(symbol: string, bars: any[]): any {
  const i = bars.length - 1;
  const atrs = buildAtr(bars);
  const atr = atrs[i];
  const base = atrs.slice(i - ATR_BASE_BARS, i);
  if (base.length !== ATR_BASE_BARS || base.some((x) => !Number.isFinite(x))) {
    throw new Error(`ATR_BASE_INCOMPLETE:${symbol}`);
  }
  const atrBaseline = mean(base);
  const atrRatio = atr / atrBaseline;
  const bbPos = bbAt(bars, i);
  const r24 = bars[i].close / bars[i - RET24_BARS].close - 1;
  let qv24 = 0;
  for (let k = 0; k < QV24_BARS; k++) qv24 += bars[i - k].quoteVolume;
  const takerImb = bars[i].quoteVolume > 0 ? 2 * bars[i].takerBuyQuote / bars[i].quoteVolume - 1 : 0;
  return { symbol, signalBarAt: bars[i].openTime, referenceClose: bars[i].close, atr, atrBaseline, atrRatio, bbPos, r24, qv24, takerImb };
}
function eligible(lane: string, f: any): { ok: boolean; reason: string } {
  if (f.qv24 < MIN_QV24) return { ok: false, reason: "LIQUIDITY_BELOW_50M" };
  if (lane === "BULL") {
    if (f.atrRatio < 1.65) return { ok: false, reason: "BULL_ATR_RATIO" };
    if (f.bbPos > -.20) return { ok: false, reason: "BULL_PULLBACK_DEPTH" };
    if (f.r24 < -.02) return { ok: false, reason: "BULL_ASSET_24H" };
  } else if (lane === "RANGE") {
    if (f.atrRatio < 1.60) return { ok: false, reason: "RANGE_ATR_RATIO" };
    if (f.bbPos > -1.05) return { ok: false, reason: "RANGE_BB_DEPTH" };
  } else if (lane === "BEAR") {
    if (f.atrRatio < 1.60) return { ok: false, reason: "BEAR_ATR_RATIO" };
    if (f.bbPos > -1.15) return { ok: false, reason: "BEAR_BB_DEPTH" };
    if (f.takerImb > 0) return { ok: false, reason: "BEAR_SELL_PRESSURE_REQUIRED" };
  } else return { ok: false, reason: "NO_ACTIVE_REGIME" };
  return { ok: true, reason: `${lane}_ELIGIBLE` };
}
function observerHealthy(row: any, asOfMs: number): any {
  if (!row) return { ok: false, reason: "OBSERVER_MISSING" };
  const ts = Date.parse(String(row.observed_at || ""));
  const age = asOfMs - ts;
  if (!Number.isFinite(ts) || age < 0 || age > OBSERVER_MAX_AGE_MS) return { ok: false, reason: "OBSERVER_STALE" };
  if (finite(row.sample_size, 0) < 240) return { ok: false, reason: "OBSERVER_SAMPLE_SMALL" };
  const ft = record(row.features);
  if (ft.source !== OBSERVER_SOURCE) return { ok: false, reason: "OBSERVER_SOURCE_MISMATCH" };
  return { ok: true, reason: "OK", ageMs: age };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST_ONLY" });
  const url = (Deno.env.get("SUPABASE_URL") || "").trim();
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  if (!url || !key) return reply(500, { ok: false, error: "SUPABASE_ENV_MISSING" });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const supplied = (req.headers.get("x-v10-lane-token") || "").trim();
  const token = await db.from("edge_internal_tokens").select("token").eq("name", "v10-lane-signal-generator").maybeSingle();
  const expected = String(token.data?.token || "").trim();
  if (token.error || !supplied || !expected || !constantTimeEqual(supplied, expected)) {
    return reply(401, { ok: false, error: "UNAUTHORIZED" });
  }

  try {
    const now = Date.now();
    const currentOpen = Math.floor(now / BAR_MS) * BAR_MS;
    const signalOpen = currentOpen - BAR_MS;
    const signalClose = currentOpen;
    const signalCloseIso = new Date(signalClose).toISOString();

    const [members, obsQuery] = await Promise.all([
      discoverBinanceUsdtPerpetualUniverse(MIN_QV24),
      db.from("market_regime_observations")
        .select("id,observed_at,predicted_regime,bull_score,confidence,sample_size,features,trading_influence,model_revision")
        .eq("model_revision", OBSERVER_REVISION)
        .eq("trading_influence", true)
        .lte("observed_at", signalCloseIso)
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (obsQuery.error) throw new Error(`OBSERVER_READ:${obsQuery.error.message}`);

    const universe = members.map((x) => x.symbol).filter((s) => s !== "BTCUSDT");
    const btcBars = await fetchHistory("BTCUSDT", signalOpen);
    const historyRows = await mapLimit(universe, 8, async (symbol) => {
      try { return { symbol, bars: await fetchHistory(symbol, signalOpen), error: null }; }
      catch (error) { return { symbol, bars: null, error: error instanceof Error ? error.message : String(error) }; }
    });
    const histories = new Map(historyRows.filter((x) => x.bars).map((x) => [x.symbol, x.bars]));
    const dataErrors = historyRows.filter((x) => x.error).map((x) => ({ symbol: x.symbol, error: x.error }));

    const i = btcBars.length - 1;
    const btc72 = btcBars[i].close / btcBars[i - BTC72_BARS].close - 1;
    const btc72Prev = btcBars[i - 1].close / btcBars[i - 1 - BTC72_BARS].close - 1;
    const btcRoute = routeFromBtc72(btc72) === routeFromBtc72(btc72Prev) ? routeFromBtc72(btc72) : "CASH";
    const oHealth = observerHealthy(obsQuery.data, signalClose);
    const route = oHealth.ok ? observerRoute(obsQuery.data?.predicted_regime) : "CASH";

    const evaluated: any[] = [];
    const reasons: Record<string, number> = {};
    for (const symbol of universe) {
      const bars = histories.get(symbol);
      if (!bars) continue;
      try {
        const f = computeFeatures(symbol, bars);
        const e = eligible(route, f);
        evaluated.push({ ...f, eligible: e.ok, reason: e.reason });
        reasons[e.reason] = (reasons[e.reason] || 0) + 1;
      } catch (error) {
        const reason = `FEATURE_ERROR:${error instanceof Error ? error.message : String(error)}`;
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
    }
    const candidates = evaluated.filter((x) => x.eligible)
      .sort((a, b) => a.bbPos - b.bbPos || b.atrRatio - a.atrRatio || a.symbol.localeCompare(b.symbol));

    return reply(200, {
      ok: true,
      shadowOnly: SHADOW_ONLY,
      executableSignalWrites: 0,
      revision: REVISION,
      patch: PATCH,
      signalBarAt: new Date(signalOpen).toISOString(),
      signalBarCloseAt: signalCloseIso,
      dynamicUniverse: {
        discovered: members.length,
        historyReady: histories.size,
        excludedForHistory: dataErrors.length,
        minQuoteVolume24h: MIN_QV24,
        fixedListPresent: false,
      },
      route,
      observer: {
        observedAt: obsQuery.data?.observed_at || null,
        predicted: obsQuery.data?.predicted_regime || null,
        confidence: obsQuery.data?.confidence ?? null,
        health: oHealth,
      },
      btcDiagnostic: { btc72, btc72Prev, confirmedRoute: btcRoute },
      evaluated: evaluated.length,
      eligible: candidates.length,
      reasons,
      topCandidates: candidates.slice(0, 20),
      dataErrors: dataErrors.slice(0, 50),
    });
  } catch (error) {
    return reply(500, { ok: false, shadowOnly: SHADOW_ONLY, revision: REVISION, patch: PATCH, error: error instanceof Error ? error.message : String(error) });
  }
});
