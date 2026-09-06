// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const REVISION = "V16-MOMENTUM-CONTINUATION-SHADOW-1.0.0";
const OBSERVER_REVISION = "MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET";
const BASES = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"];
const BAR5 = 5 * 60_000;
const INTENDED_NOTIONAL_USDT = 120;
const STAGE1_CONCURRENCY = 24;
const MICRO_CONCURRENCY = 8;
const SHORTLIST_LIMIT = 30;

const env = (name: string) => (Deno.env.get(name) || "").trim();
const num = (v: unknown, fallback = Number.NaN) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
const median = (xs: number[]) => {
  if (!xs.length) return Number.NaN;
  const a = [...xs].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
function eq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
async function fetchJson(path: string, timeout = 12_000) {
  let last = "UNKNOWN";
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, {
        headers: { accept: "application/json", "user-agent": "Trading-booooo-v16-shadow/1.0" },
        signal: AbortSignal.timeout(timeout),
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
async function mapLimit<T, U>(items: T[], limit: number, fn: (x: T) => Promise<U>): Promise<U[]> {
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

type Member = { symbol: string; qv24: number; r24: number; last: number };
type Bar = { t: number; o: number; h: number; l: number; c: number; q: number; tbq: number };

async function discoverUniverse(): Promise<Member[]> {
  const [info, tickers] = await Promise.all([
    fetchJson("/fapi/v1/exchangeInfo"),
    fetchJson("/fapi/v1/ticker/24hr"),
  ]);
  const active = new Set((info?.symbols || []).filter((x: any) =>
    x?.status === "TRADING" && x?.quoteAsset === "USDT" && x?.contractType === "PERPETUAL"
  ).map((x: any) => String(x.symbol || "").toUpperCase()).filter(Boolean));
  return (Array.isArray(tickers) ? tickers : []).map((x: any) => ({
    symbol: String(x?.symbol || "").toUpperCase(),
    qv24: num(x?.quoteVolume, 0),
    r24: num(x?.priceChangePercent, 0) / 100,
    last: num(x?.lastPrice, 0),
  })).filter((x: Member) => active.has(x.symbol) && x.last > 0)
    .sort((a: Member, b: Member) => a.symbol.localeCompare(b.symbol));
}
function parseBar(r: any[]): Bar {
  return { t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), q: num(r[7], 0), tbq: num(r[10], 0) };
}
async function bars(symbol: string, interval: "5m" | "15m", limit: number, endTime: number): Promise<Bar[]> {
  const raw = await fetchJson(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}&endTime=${endTime}`);
  return (Array.isArray(raw) ? raw : []).map(parseBar).filter((b: Bar) => b.t > 0 && b.c > 0 && b.h > 0 && b.l > 0);
}
function atr14(a: Bar[], i: number) {
  const tr: number[] = [];
  for (let k = Math.max(1, i - 13); k <= i; k++) {
    tr.push(Math.max(a[k].h - a[k].l, Math.abs(a[k].h - a[k - 1].c), Math.abs(a[k].l - a[k - 1].c)));
  }
  return mean(tr);
}
function stageOne(member: Member, a: Bar[]) {
  if (a.length < 100) throw new Error(`INSUFFICIENT_5M:${a.length}`);
  const i = a.length - 1, cur = a[i];
  const ret15 = cur.c / a[i - 3].c - 1;
  const ret60 = cur.c / a[i - 12].c - 1;
  const ret180 = cur.c / a[i - 36].c - 1;
  const qMed = median(a.slice(i - 20, i).map((b) => b.q).filter((x) => x > 0));
  const qvRatio = qMed > 0 ? cur.q / qMed : 0;
  const takerBuyShare = cur.q > 0 ? cur.tbq / cur.q : .5;
  const range = Math.max(cur.h - cur.l, cur.c * 1e-9);
  const closeLocation = clamp((cur.c - cur.l) / range, 0, 1);
  const upperWick = clamp((cur.h - Math.max(cur.o, cur.c)) / range, 0, 1);
  const atr = atr14(a, i);

  const start = Math.max(0, i - 96);
  let priorHigh = -Infinity, priorHighIndex = -1;
  for (let k = start; k < i; k++) {
    if (a[k].h >= priorHigh) { priorHigh = a[k].h; priorHighIndex = k; }
  }
  const ageBars = i - priorHighIndex;
  const postHigh = priorHighIndex >= 0 ? a.slice(priorHighIndex + 1, i + 1) : [];
  const pullbackLow = postHigh.length ? Math.min(...postHigh.map((b) => b.l)) : cur.l;
  const pullbackDepth = priorHigh > 0 ? Math.max(0, (priorHigh - pullbackLow) / priorHigh) : 0;
  const breakoutBps = priorHigh > 0 ? (cur.c / priorHigh - 1) * 10000 : 0;
  const antiChaseAtr = atr > 0 ? Math.max(0, cur.c - priorHigh) / atr : Number.NaN;

  let state: string | null = null;
  if (cur.c > priorHigh && ageBars >= 2 && pullbackDepth >= .0025 && pullbackDepth <= .18) state = "BREAKOUT_RECLAIM";
  else if (cur.c > priorHigh && ageBars >= 1) state = "DIRECT_BREAKOUT";
  else if (priorHigh > 0 && cur.c >= priorHigh * .992 && ageBars >= 2 && pullbackDepth >= .0025) state = "WATCH_BREAKOUT";
  else if (ret15 >= .008 || ret60 >= .02 || (ret60 > 0 && qvRatio >= 2)) state = "RISING";
  if (!state) return null;

  let score = state === "BREAKOUT_RECLAIM" ? 35 : state === "DIRECT_BREAKOUT" ? 28 : state === "WATCH_BREAKOUT" ? 18 : 10;
  score += clamp(ret60 * 250, 0, 20);
  score += clamp((qvRatio - 1) * 8, 0, 15);
  score += clamp((takerBuyShare - .50) * 80, 0, 12);
  score += clamp((closeLocation - .50) * 20, 0, 10);
  if (pullbackDepth >= .005 && pullbackDepth <= .08) score += 5;
  if (Number.isFinite(antiChaseAtr) && antiChaseAtr <= 1.25) score += 5;
  if (upperWick > .45) score -= 8;
  if (Number.isFinite(antiChaseAtr) && antiChaseAtr > 2.5) score -= 8;

  return {
    symbol: member.symbol,
    state,
    score: clamp(score, 0, 100),
    signalBarAt: cur.t,
    referenceClose: cur.c,
    metrics: {
      ret15, ret60, ret180,
      qv5: cur.q,
      qvRatio,
      qv24: member.qv24,
      r24: member.r24,
      takerBuyShare,
      closeLocation,
      upperWick,
      atr14: atr,
      priorHigh,
      priorHighAgeBars: ageBars,
      pullbackLow,
      pullbackDepth,
      breakoutBps,
      antiChaseAtr,
    },
  };
}
function sumDepth(levels: any[], mid: number, side: "bid" | "ask", bps: number) {
  let quote = 0;
  for (const row of levels || []) {
    const p = num(row?.[0]), q = num(row?.[1]);
    if (!(p > 0 && q > 0)) continue;
    const dist = side === "bid" ? (mid - p) / mid * 10000 : (p - mid) / mid * 10000;
    if (dist <= bps + 1e-9) quote += p * q;
  }
  return quote;
}
function expectedBuySlippageBps(asks: any[], notional: number) {
  if (!asks?.length || !(notional > 0)) return Number.POSITIVE_INFINITY;
  const best = num(asks[0]?.[0]);
  let remain = notional, qty = 0, cost = 0;
  for (const row of asks) {
    const p = num(row?.[0]), q = num(row?.[1]);
    if (!(p > 0 && q > 0)) continue;
    const levelQuote = p * q, takeQuote = Math.min(remain, levelQuote);
    const takeQty = takeQuote / p;
    cost += takeQuote;
    qty += takeQty;
    remain -= takeQuote;
    if (remain <= 1e-9) break;
  }
  if (remain > 1e-6 || !(qty > 0) || !(best > 0)) return Number.POSITIVE_INFINITY;
  return ((cost / qty) / best - 1) * 10000;
}
async function micro(symbol: string, endTime: number, stage: any) {
  const [m15, oi, book] = await Promise.all([
    bars(symbol, "15m", 40, endTime),
    fetchJson(`/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=6`).catch(() => []),
    fetchJson(`/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`).catch(() => ({ bids: [], asks: [] })),
  ]);
  const bids = Array.isArray(book?.bids) ? book.bids : [], asks = Array.isArray(book?.asks) ? book.asks : [];
  const bid = num(bids?.[0]?.[0]), ask = num(asks?.[0]?.[0]);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number.NaN;
  const spreadBps = mid > 0 ? (ask - bid) / mid * 10000 : Number.POSITIVE_INFINITY;
  const bid10 = mid > 0 ? sumDepth(bids, mid, "bid", 10) : 0;
  const ask10 = mid > 0 ? sumDepth(asks, mid, "ask", 10) : 0;
  const depthImbalance10 = bid10 + ask10 > 0 ? (bid10 - ask10) / (bid10 + ask10) : 0;
  const slippageBps120 = expectedBuySlippageBps(asks, INTENDED_NOTIONAL_USDT);

  const oiRows = Array.isArray(oi) ? oi : [];
  const oiNow = oiRows.length ? num(oiRows.at(-1)?.sumOpenInterest) : Number.NaN;
  const oiPrev15 = oiRows.length >= 4 ? num(oiRows.at(-4)?.sumOpenInterest) : Number.NaN;
  const oiDelta15 = oiNow > 0 && oiPrev15 > 0 ? oiNow / oiPrev15 - 1 : Number.NaN;
  const m15Ret60 = m15.length >= 5 ? m15.at(-1)!.c / m15.at(-5)!.c - 1 : Number.NaN;

  let confirmations = 0;
  if (stage.metrics.takerBuyShare >= .52) confirmations++;
  if (!Number.isFinite(oiDelta15) || oiDelta15 >= 0) confirmations++;
  if (spreadBps <= 5) confirmations++;
  if (slippageBps120 <= 8) confirmations++;
  if (depthImbalance10 >= -.25) confirmations++;
  const microConfirm = confirmations >= 4;

  return {
    microConfirm,
    microstructure: {
      confirmations,
      intendedNotionalUsdt: INTENDED_NOTIONAL_USDT,
      bestBid: bid,
      bestAsk: ask,
      spreadBps,
      bidDepth5: mid > 0 ? sumDepth(bids, mid, "bid", 5) : 0,
      askDepth5: mid > 0 ? sumDepth(asks, mid, "ask", 5) : 0,
      bidDepth10: bid10,
      askDepth10: ask10,
      bidDepth20: mid > 0 ? sumDepth(bids, mid, "bid", 20) : 0,
      askDepth20: mid > 0 ? sumDepth(asks, mid, "ask", 20) : 0,
      depthImbalance10,
      expectedBuySlippageBps: slippageBps120,
      oiNow,
      oiDelta15,
      m15Ret60,
    },
  };
}
function regimeModifier(regime: string) {
  const r = regime.toUpperCase();
  if (r === "BULL" || r === "STRONG_BULL") return "WIDE";
  if (r === "RISK_OFF" || r === "BEAR") return "TIGHT";
  return "MEDIUM";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { ok: false, error: "POST_ONLY" });
  const U = env("SUPABASE_URL"), K = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!U || !K) return reply(500, { ok: false, error: "SUPABASE_ENV_MISSING" });
  const db = createClient(U, K, { auth: { persistSession: false, autoRefreshToken: false } });
  const got = (req.headers.get("x-v16-shadow-token") || "").trim();
  const token = await db.from("edge_internal_tokens").select("token").eq("name", "v16-momentum-shadow").maybeSingle();
  const expected = String(token.data?.token || "").trim();
  if (token.error || !got || !expected || !eq(got, expected)) return reply(401, { ok: false, error: "UNAUTHORIZED" });

  const now = Date.now(), currentOpen = Math.floor(now / BAR5) * BAR5, endTime = currentOpen - 1;
  try {
    const [members, obs] = await Promise.all([
      discoverUniverse(),
      db.from("market_regime_observations")
        .select("observed_at,predicted_regime,confidence,bull_score")
        .eq("model_revision", OBSERVER_REVISION)
        .eq("trading_influence", true)
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const regime = String(obs.data?.predicted_regime || "UNKNOWN").toUpperCase();
    const modifier = regimeModifier(regime);

    const scanned = await mapLimit(members, STAGE1_CONCURRENCY, async (member) => {
      try {
        const a = await bars(member.symbol, "5m", 120, endTime);
        return { candidate: stageOne(member, a), error: null };
      } catch (e) {
        return { candidate: null, error: `${member.symbol}:${e instanceof Error ? e.message : String(e)}` };
      }
    });
    const stage1 = scanned.map((x) => x.candidate).filter(Boolean).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const shortlist = stage1.slice(0, SHORTLIST_LIMIT);
    const enriched = await mapLimit(shortlist, MICRO_CONCURRENCY, async (c) => {
      try {
        const m = await micro(c.symbol, endTime, c);
        const state = m.microConfirm && ["BREAKOUT_RECLAIM", "DIRECT_BREAKOUT"].includes(c.state) ? "MICRO_CONFIRM" : c.state;
        return { ...c, state, ...m, microError: null };
      } catch (e) {
        return { ...c, microConfirm: false, microstructure: {}, microError: e instanceof Error ? e.message : String(e) };
      }
    });

    const errors = scanned.map((x) => x.error).filter(Boolean);
    const run = await db.from("v16_momentum_shadow_runs").insert({
      revision: REVISION,
      regime,
      regime_modifier: modifier,
      universe_count: members.length,
      stage1_count: stage1.length,
      candidate_count: enriched.length,
      data_error_count: errors.length,
      summary: {
        regimeIsEntryGate: false,
        opportunityAuthority: "ASSET_LOCAL_5M_15M",
        intendedNotionalUsdt: INTENDED_NOTIONAL_USDT,
        observerObservedAt: obs.data?.observed_at || null,
        observerConfidence: obs.data?.confidence ?? null,
        topStates: enriched.slice(0, 10).map((x) => ({ symbol: x.symbol, state: x.state, score: x.score, microConfirm: x.microConfirm })),
        errorSample: errors.slice(0, 20),
      },
    }).select("id,run_at").single();
    if (run.error || !run.data) throw new Error(`RUN_WRITE:${run.error?.message || "missing"}`);

    if (enriched.length) {
      const rows = enriched.map((x) => ({
        run_id: run.data.id,
        observed_at: run.data.run_at,
        signal_bar_at: new Date(x.signalBarAt).toISOString(),
        symbol: x.symbol,
        state: x.state,
        opportunity_score: x.score,
        micro_confirm: !!x.microConfirm,
        regime,
        regime_modifier: modifier,
        metrics: { ...x.metrics, referenceClose: x.referenceClose, microError: x.microError || null },
        microstructure: x.microstructure || {},
      }));
      const w = await db.from("v16_momentum_shadow_candidates").insert(rows);
      if (w.error) throw new Error(`CANDIDATE_WRITE:${w.error.message}`);
    }

    return reply(200, {
      ok: true,
      revision: REVISION,
      shadowOnly: true,
      liveOrdersSubmitted: 0,
      regime,
      regimeModifier: modifier,
      regimeIsEntryGate: false,
      universe: members.length,
      stage1: stage1.length,
      candidates: enriched.length,
      dataErrors: errors.length,
      topCandidates: enriched.slice(0, 15).map((x) => ({
        symbol: x.symbol,
        state: x.state,
        score: Number(x.score.toFixed(2)),
        microConfirm: !!x.microConfirm,
        ret15: x.metrics.ret15,
        ret60: x.metrics.ret60,
        pullbackDepth: x.metrics.pullbackDepth,
        breakoutBps: x.metrics.breakoutBps,
        takerBuyShare: x.metrics.takerBuyShare,
        spreadBps: x.microstructure?.spreadBps ?? null,
        expectedBuySlippageBps: x.microstructure?.expectedBuySlippageBps ?? null,
        oiDelta15: x.microstructure?.oiDelta15 ?? null,
      })),
    });
  } catch (e) {
    return reply(500, { ok: false, revision: REVISION, shadowOnly: true, error: e instanceof Error ? e.message : String(e) });
  }
});
