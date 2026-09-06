// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { discoverBinanceUsdtPerpetualUniverse } from "../_shared/binance-futures-universe.ts";

// Research/shadow version of V15 candidate discovery.
// The fixed 15-symbol list is removed. No order gateway calls are made in this branch.
const REV = "V15-RANGE-R7-DYNAMIC-UNIVERSE-SHADOW-1.0.0";
const PATCH = "DYNAMIC-USDM-PERP-UNIVERSE-SHADOW-20260906";
const SHADOW_ONLY = true;
const OBS = "MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const M15 = 900000;
const OBS_MAX = 12 * 60000;
const ATR_N = 56;
const ATR_BASE = 2880;
const BB_N = 80;
const QV_N = 96;
const R24_N = 96;
const BTC72_N = 288;
const REQ = 2938;
const MIN_QV = 50_000_000;
const MIN_ATR = 1.65;
const MAX_BB = -1.05;
const MIN_R24 = -.06;
const BTC72_MAX = .02;
const BASE = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"];

type Bar = { t: number; o: number; h: number; l: number; c: number; q: number };
type Feat = { symbol: string; signalBarAt: number; referenceClose: number; atrRatio: number; bbPos: number; qv24: number; r24: number };
function res(s: number, b: any) { return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function N(v: any, d = NaN) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function mean(a: number[]) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function sd(a: number[]) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function bar(r: any[]): Bar { return { t: N(r[0]), o: N(r[1]), h: N(r[2]), l: N(r[3]), c: N(r[4]), q: N(r[7]) }; }
function eq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const env = (n: string) => (Deno.env.get(n) || "").trim();

async function F(path: string) {
  let e = "";
  for (const b of BASE) {
    try {
      const r = await fetch(b + path, { headers: { "user-agent": "Trading-booooo-v15-dynamic-shadow/1" }, signal: AbortSignal.timeout(12000) });
      const t = await r.text();
      if (r.ok) return t ? JSON.parse(t) : [];
      e = `${r.status}:${t.slice(0, 120)}`;
    } catch (x) { e = String(x); }
  }
  throw Error(`BINANCE:${e}`);
}
async function pool<T, U>(a: T[], n: number, fn: (x: T) => Promise<U>): Promise<U[]> {
  const o = new Array<U>(a.length); let i = 0;
  async function w() { for (;;) { const j = i++; if (j >= a.length) return; o[j] = await fn(a[j]); } }
  await Promise.all(Array.from({ length: Math.min(n, a.length) }, () => w()));
  return o;
}
async function hist(s: string, t: number): Promise<Bar[]> {
  const m = new Map<number, Bar>(); let end = t + M15 - 1;
  for (let pg = 0; pg < 3 && m.size < REQ; pg++) {
    const x = (await F(`/fapi/v1/klines?symbol=${s}&interval=15m&limit=1500&endTime=${end}`)).map(bar);
    if (!x.length) break;
    for (const b of x) if (b.t <= t) m.set(b.t, b);
    end = Math.min(...x.map((z: Bar) => z.t)) - 1;
  }
  const a = [...m.values()].sort((a, b) => a.t - b.t);
  if (a.length < REQ || a.at(-1)?.t !== t) throw Error(`HIST:${s}:${a.length}`);
  return a.slice(-3000);
}
function atrs(b: Bar[]) {
  const tr = Array(b.length).fill(NaN), a = Array(b.length).fill(NaN); let sum = 0, c = 0;
  for (let i = 1; i < b.length; i++) tr[i] = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  for (let i = 0; i < b.length; i++) {
    if (Number.isFinite(tr[i])) { sum += tr[i]; c++; }
    const j = i - ATR_N;
    if (j >= 0 && Number.isFinite(tr[j])) { sum -= tr[j]; c--; }
    if (c === ATR_N) a[i] = sum / ATR_N;
  }
  return a;
}
function bbAt(b: Bar[], i: number, n: number) { const x = b.slice(i - n + 1, i + 1).map((z) => z.c); if (x.length !== n) return NaN; const s = sd(x); return s ? (b[i].c - mean(x)) / (2 * s) : NaN; }
function feat(s: string, b: Bar[]): Feat {
  const i = b.length - 1, a = atrs(b), base = a.slice(i - ATR_BASE, i);
  if (base.length !== ATR_BASE || base.some((x) => !Number.isFinite(x)) || !Number.isFinite(a[i])) throw Error(`ATR:${s}`);
  return { symbol: s, signalBarAt: b[i].t, referenceClose: b[i].c, atrRatio: a[i] / mean(base), bbPos: bbAt(b, i, BB_N), qv24: b.slice(i - QV_N + 1, i + 1).reduce((q, z) => q + z.q, 0), r24: b[i].c / b[i - R24_N].c - 1 };
}
function route(x: number) { return x < -.05 ? "BEAR" : x <= .04 ? "RANGE" : x > .05 ? "BULL" : "CASH"; }
function btcCtx(b: Bar[]) { const i = b.length - 1, cur = b[i].c / b[i - BTC72_N].c - 1, prev = b[i - 1].c / b[i - 1 - BTC72_N].c - 1; return { current: cur, previous: prev, confirmed: route(cur) === "RANGE" && route(prev) === "RANGE" }; }
async function auth(db: any, req: Request) { const got = (req.headers.get("x-v10-executor-token") || "").trim(), t = await db.from("edge_internal_tokens").select("token").eq("name", "v10-lane-executor").maybeSingle(); return !t.error && got && t.data?.token && eq(got, String(t.data.token)); }
async function marketAt(db: any, asOfMs: number) {
  const cutoffIso = new Date(asOfMs).toISOString();
  const q = await db.from("market_regime_observations").select("id,observed_at,predicted_regime,confidence,sample_size").eq("model_revision", OBS).eq("trading_influence", true).lte("observed_at", cutoffIso).order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (q.error) throw Error(`OBSERVER:${q.error.message}`);
  const o = q.data, age = o ? asOfMs - Date.parse(o.observed_at) : Infinity, healthy = !!o && age >= 0 && age <= OBS_MAX && N(o.sample_size, 0) >= 240 && N(o.confidence, 0) >= .60, regime = String(o?.predicted_regime || "CASH").toUpperCase();
  return { observer: o, asOf: cutoffIso, ageMs: age, healthy, regime, rangeEligible: healthy && ["NEUTRAL", "RANGE"].includes(regime) };
}

async function eligibleNow(db: any, nowMs = Date.now()) {
  const currentOpen = Math.floor(nowMs / M15) * M15, signalT = currentOpen - M15, signalClose = currentOpen;
  const [m, members] = await Promise.all([marketAt(db, signalClose), discoverBinanceUsdtPerpetualUniverse(MIN_QV)]);
  const universe = members.map((x) => x.symbol).filter((s) => s !== "BTCUSDT");
  const bt = await hist("BTCUSDT", signalT);
  const bc = btcCtx(bt);
  const rows: any[] = await pool(universe, 8, async (s) => {
    try { return { symbol: s, bars: await hist(s, signalT), error: null }; }
    catch (error) { return { symbol: s, bars: null, error: error instanceof Error ? error.message : String(error) }; }
  });
  const bm = new Map(rows.filter((x) => x.bars).map((x) => [x.symbol, x.bars]));
  const eligible: Feat[] = [], rejected: any[] = [];
  for (const s of universe) {
    const b = bm.get(s);
    if (!b) { rejected.push({ symbol: s, reason: "HISTORY" }); continue; }
    try {
      const f = feat(s, b); let reason = "ELIGIBLE";
      if (!m.rangeEligible) reason = "OBSERVER_NOT_RANGE";
      else if (!bc.confirmed || Math.abs(bc.current) > BTC72_MAX) reason = "BTC72_GATE";
      else if (f.qv24 < MIN_QV) reason = "QV24_LT_50M";
      else if (f.atrRatio < MIN_ATR) reason = "ATR_LT_1P65";
      else if (f.bbPos > MAX_BB) reason = "BB_GT_M1P05";
      else if (f.r24 < MIN_R24) reason = "R24_LT_M6PCT";
      if (reason === "ELIGIBLE") eligible.push(f); else rejected.push({ symbol: s, reason, atrRatio: f.atrRatio, bbPos: f.bbPos, qv24: f.qv24, r24: f.r24 });
    } catch (e) { rejected.push({ symbol: s, reason: String(e) }); }
  }
  eligible.sort((a, b) => a.bbPos - b.bbPos || b.atrRatio - a.atrRatio || a.symbol.localeCompare(b.symbol));
  return { signalT, signalClose, market: m, btc72: bc, members, universe, historyReady: bm.size, eligible, rejected };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return res(405, { ok: false, error: "POST_ONLY" });
  const U = env("SUPABASE_URL"), K = env("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(U, K, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!(await auth(db, req))) return res(401, { ok: false, error: "UNAUTHORIZED" });
  try {
    const e = await eligibleNow(db);
    return res(200, {
      ok: true,
      revision: REV,
      patch: PATCH,
      shadowOnly: SHADOW_ONLY,
      liveOrdersSubmitted: 0,
      fixedListPresent: false,
      signalBarAt: new Date(e.signalT).toISOString(),
      signalBarCloseAt: new Date(e.signalClose).toISOString(),
      dynamicUniverse: { discovered: e.members.length, historyReady: e.historyReady, minQuoteVolume24h: MIN_QV },
      market: e.market,
      btc72: e.btc72,
      eligible: e.eligible.length,
      topCandidates: e.eligible.slice(0, 20),
      rejectCounts: e.rejected.reduce((acc: any, x: any) => { acc[x.reason] = (acc[x.reason] || 0) + 1; return acc; }, {}),
      rejectedSample: e.rejected.slice(0, 50),
    });
  } catch (e) {
    return res(500, { ok: false, revision: REV, patch: PATCH, shadowOnly: SHADOW_ONLY, error: e instanceof Error ? e.message : String(e) });
  }
});
