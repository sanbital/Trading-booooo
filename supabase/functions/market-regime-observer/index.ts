// @ts-nocheck -- This edge function is intentionally maintained as bundled JavaScript-compatible TypeScript.
// Trading-booooo market regime observer v2 + C43 dynamic horizon forecast.
// Observation and P10 exit-risk input. It never changes entries, sizing, leverage, or orders directly.

const MODEL_REVISION = "MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET";
const STRUCTURAL_CANDIDATE_ID = "C01_LEGACY_SHAPE_V1";
const FORECAST_CANDIDATE_ID = "C43_PHASE_TREE_PERSISTENCE_STRUCT_PERSIST";
const FORECAST_REVISION = "C43-DYNAMIC-HORIZON-FORECAST-v1";
const RESEARCH_RUN_ID = "384c6838-b9d3-4677-9da2-644dc54e2a98";
const HORIZONS = [30, 120, 360];
const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const DASHBOARD_TOKEN = (Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN") || "").trim();
const ALLOWED_ORIGIN = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",")[0].trim() || "*";
const BS = "https://api.binance.com";
const BF = "https://fapi.binance.com";
const UP = "https://api.upbit.com";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type, x-autotrade-token, x-regime-token, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function requiredEnv(n) { const v = (Deno.env.get(n) || "").trim(); if (!v) throw new Error(`missing ${n}`); return v; }
function finite(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo = 0, hi = 100) { return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo)); }
function mean(xs) { const a = xs.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function stddev(xs) { const a = xs.filter(Number.isFinite); if (!a.length) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); }
function returnPct(n, p) { return n > 0 && p > 0 ? (n / p - 1) * 100 : 0; }
function momentumScore(r, f) { return clamp(50 + (r / Math.max(0.01, f)) * 50); }
function regimeOf(s) { return s >= 72 ? "STRONG_BULL" : s >= 58 ? "BULL" : s >= 42 ? "NEUTRAL" : "RISK_OFF"; }
function actualRegime(s) { return s >= 75 ? "STRONG_BULL" : s >= 60 ? "BULL" : s >= 40 ? "NEUTRAL" : "RISK_OFF"; }
function ordinal(r) { return ({ RISK_OFF: 0, NEUTRAL: 1, BULL: 2, STRONG_BULL: 3 })[r] ?? 1; }
function direction(r) { return r === "RISK_OFF" ? -1 : r === "NEUTRAL" ? 0 : 1; }
function constantTimeEqual(l, r) { const e = new TextEncoder(), a = e.encode(l), b = e.encode(r), n = Math.max(a.length, b.length); let d = a.length ^ b.length; for (let i = 0; i < n; i++) d |= (a[i] || 0) ^ (b[i] || 0); return d === 0; }
function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }

async function db(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`database ${r.status}: ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : null;
}
async function regimeTokenAllowed(req) {
  const got = (req.headers.get("x-regime-token") || "").trim();
  if (got.length < 32) return false;
  const rows = await db("edge_internal_tokens?name=eq.market-regime-observer&select=token&limit=1").catch(() => []);
  const want = String(rows?.[0]?.token || "").trim();
  return want.length >= 32 && constantTimeEqual(got, want);
}
function dashboardAllowed(req) { const got = (req.headers.get("x-autotrade-token") || "").trim(); return DASHBOARD_TOKEN.length >= 32 && got.length > 0 && constantTimeEqual(DASHBOARD_TOKEN, got); }

async function fetchJson(url, attempts = 3) {
  let last = "unknown";
  for (let i = 0; i < attempts; i++) {
    const c = new AbortController(); const tm = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch(url, { signal: c.signal, headers: { accept: "application/json", "user-agent": "Trading-booooo-regime-observer-c43/1" } });
      const t = await r.text();
      if (r.ok) return t ? JSON.parse(t) : null;
      last = `HTTP ${r.status}: ${t.slice(0, 180)}`;
      if (![418, 429].includes(r.status) && r.status < 500) throw new Error(last);
    } catch (e) { last = e instanceof Error ? e.message : String(e); if (i + 1 >= attempts) throw e; }
    finally { clearTimeout(tm); }
    await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  throw new Error(last);
}

async function binanceTickers(v) {
  const fut = v === "binance_futures", base = fut ? BF : BS;
  const [info, tickers] = await Promise.all([fetchJson(`${base}${fut ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo"}`), fetchJson(`${base}${fut ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr"}`)]);
  const active = new Set((Array.isArray(info?.symbols) ? info.symbols : []).filter((r) => r?.status === "TRADING" && r?.quoteAsset === "USDT" && (fut ? r?.contractType === "PERPETUAL" : r?.isSpotTradingAllowed !== false)).map((r) => String(r.symbol)));
  return (Array.isArray(tickers) ? tickers : []).filter((r) => active.has(String(r.symbol))).map((r) => ({ market: String(r.symbol), price: finite(r.lastPrice), ret24: finite(r.priceChangePercent), quoteVolume: finite(r.quoteVolume) })).filter((r) => r.price > 0);
}
async function upbitTickers() {
  const info = await fetchJson(`${UP}/v1/market/all?isDetails=true`);
  const markets = (Array.isArray(info) ? info : []).map((r) => String(r.market || "")).filter((m) => m.startsWith("KRW-")).sort();
  const out = [];
  for (let i = 0; i < markets.length; i += 80) {
    const rows = await fetchJson(`${UP}/v1/ticker?markets=${encodeURIComponent(markets.slice(i, i + 80).join(","))}`);
    for (const r of Array.isArray(rows) ? rows : []) out.push({ market: String(r.market || ""), price: finite(r.trade_price), ret24: finite(r.signed_change_rate) * 100, quoteVolume: finite(r.acc_trade_price_24h) });
  }
  return out.filter((r) => r.market && r.price > 0);
}
function priceMap(v, rows) { const p = v === "binance_spot" ? "BS:" : v === "binance_futures" ? "BF:" : "UP:", o = {}; for (const r of rows) o[p + r.market] = r.price; return o; }
function breadthFromReturns(returns, h) {
  const a = returns.filter(Number.isFinite); if (!a.length) return { sample_size: 0, positive_fraction: 0.5, clipped_mean_pct: 0, gain_tail_fraction: 0, loss_tail_fraction: 0, score: 50 };
  const clip = h === 30 ? 5 : 20, tail = h === 30 ? 1.5 : 8, scale = h === 30 ? 1.2 : 8;
  const pos = a.filter((x) => x > 0).length / a.length, gain = a.filter((x) => x >= tail).length / a.length, loss = a.filter((x) => x <= -tail).length / a.length, clipped = mean(a.map((x) => Math.max(-clip, Math.min(clip, x))));
  return { sample_size: a.length, positive_fraction: pos, clipped_mean_pct: clipped, gain_tail_fraction: gain, loss_tail_fraction: loss, score: clamp(0.52 * pos * 100 + 0.33 * momentumScore(clipped, scale) + 0.15 * clamp(50 + (gain - loss) * 90)) };
}
function compareVenue(base, now, prefix, h) {
  const clip = h === 30 ? 5 : h === 120 ? 8 : 12, tail = h === 30 ? 1.5 : h === 120 ? 3 : 5, raw = [];
  for (const [k, p] of Object.entries(base || {})) { if (!k.startsWith(prefix)) continue; const n = finite(now[k]); if (p > 0 && n > 0) raw.push(returnPct(n, p)); }
  const pos = raw.length ? raw.filter((x) => x > 0).length / raw.length : 0.5, gain = raw.length ? raw.filter((x) => x >= tail).length / raw.length : 0, loss = raw.length ? raw.filter((x) => x <= -tail).length / raw.length : 0, clipped = raw.length ? mean(raw.map((x) => Math.max(-clip, Math.min(clip, x)))) : 0;
  return { sample_size: raw.length, positive_fraction: pos, clipped_mean_pct: clipped, gain_tail_fraction: gain, loss_tail_fraction: loss, score: h === 30 ? clamp(0.52 * pos * 100 + 0.33 * momentumScore(clipped, 1.2) + 0.15 * clamp(50 + (gain - loss) * 90)) : null };
}
async function priorV2(nowMs) {
  const earliest = new Date(nowMs - 35 * 60000).toISOString(), latest = new Date(nowMs - 25 * 60000).toISOString();
  const rows = await db(`market_regime_observations?model_revision=eq.${encodeURIComponent(MODEL_REVISION)}&observed_at=gte.${encodeURIComponent(earliest)}&observed_at=lte.${encodeURIComponent(latest)}&select=observed_at,liquid_prices&order=observed_at.asc&limit=5`).catch(() => []);
  if (!rows?.length) return null;
  return [...rows].sort((a, b) => Math.abs((nowMs - Date.parse(a.observed_at)) / 60000 - 30) - Math.abs((nowMs - Date.parse(b.observed_at)) / 60000 - 30))[0];
}
async function researchFallback30() {
  const latest = await db(`regime_v2_feature_aggregates?run_id=eq.${RESEARCH_RUN_ID}&horizon_minutes=eq.30&select=bucket&order=bucket.desc&limit=1`).catch(() => []), bucket = latest?.[0]?.bucket;
  if (!bucket) return { score: 50, bucket: null };
  const rows = await db(`regime_v2_feature_aggregates?run_id=eq.${RESEARCH_RUN_ID}&horizon_minutes=eq.30&bucket=eq.${encodeURIComponent(bucket)}&select=*`).catch(() => []);
  const scores = (rows || []).map((r) => { const n = Math.max(1, finite(r.sample_count)), pos = finite(r.positive_count) / n, gain = finite(r.gain_tail_count) / n, loss = finite(r.loss_tail_count) / n, clipped = finite(r.sum_clipped_return) / n; return 0.52 * pos * 100 + 0.33 * momentumScore(clipped, 1.2) + 0.15 * clamp(50 + (gain - loss) * 90); });
  return { score: scores.length ? mean(scores) : 50, bucket };
}
function klineReturns(rows, up = false) {
  const b = (Array.isArray(rows) ? rows : []).map((r) => up ? { t: Date.parse(String(r.candle_date_time_utc || "") + "Z"), c: finite(r.trade_price) } : { t: finite(r?.[0]), c: finite(r?.[4]) }).filter((r) => r.t > 0 && r.c > 0).sort((a, b) => a.t - b.t);
  const last = b.at(-1)?.c || 0, ret = (back) => b.length > back && last > 0 ? returnPct(last, b[b.length - 1 - back].c) : 0;
  return { r30: ret(1), r120: ret(4), r360: ret(12), r1440: ret(48) };
}
async function benchmarkScore() {
  const boundary = Math.floor(Date.now() / 1800000) * 1800000, end = boundary - 1;
  const defs = [["binance_spot", "BTCUSDT", "BTC", 1], ["binance_spot", "ETHUSDT", "ETH", 0.75], ["binance_spot", "SOLUSDT", "SOL", 0.5], ["binance_futures", "BTCUSDT", "BTC", 1], ["binance_futures", "ETHUSDT", "ETH", 0.75], ["binance_futures", "SOLUSDT", "SOL", 0.5], ["upbit_spot", "KRW-BTC", "BTC", 1], ["upbit_spot", "KRW-ETH", "ETH", 0.75], ["upbit_spot", "KRW-SOL", "SOL", 0.5]];
  const rows = await Promise.all(defs.map(async ([v, m, a, w]) => { let raw; if (v === "upbit_spot") raw = await fetchJson(`${UP}/v1/candles/minutes/30?market=${encodeURIComponent(m)}&count=49&to=${encodeURIComponent(new Date(boundary).toISOString())}`); else { const base = v === "binance_futures" ? BF : BS, path = v === "binance_futures" ? "/fapi/v1/klines" : "/api/v3/klines"; raw = await fetchJson(`${base}${path}?symbol=${m}&interval=30m&limit=49&endTime=${end}`); } const r = klineReturns(raw, v === "upbit_spot"), score = 0.16 * momentumScore(r.r30, 1) + 0.28 * momentumScore(r.r120, 2.5) + 0.31 * momentumScore(r.r360, 4.5) + 0.25 * momentumScore(r.r1440, 8); return { venue: v, market: m, asset: a, weight: w, score, ...r }; }));
  const den = rows.reduce((s, r) => s + r.weight, 0); return { score: den ? rows.reduce((s, r) => s + r.score * r.weight, 0) / den : 50, rows };
}
function benchmarkPriceMap(bs, bf, up) { const o = {}; for (const [prefix, rows, names] of [["BS:", bs, new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"])], ["BF:", bf, new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"])], ["UP:", up, new Set(["KRW-BTC", "KRW-ETH", "KRW-SOL"])]] ) for (const r of rows) if (names.has(r.market)) o[prefix + r.market] = r.price; return o; }
function weightedBenchmarkForward(base, now) { let total = 0, den = 0; for (const [k, p] of Object.entries(base || {})) { const n = finite(now[k]); if (!(p > 0 && n > 0)) continue; const w = k.includes("BTC") ? 1 : k.includes("ETH") ? 0.75 : 0.5; total += returnPct(n, p) * w; den += w; } return den ? total / den : 0; }

function binanceStateFromFeatures(observedAt, features) {
  const b30 = features?.breadth_30m, b24 = features?.breadth_24h; if (!b30 || !b24) return null;
  const s30 = finite(b30?.binance_spot?.positive_fraction, -1), f30 = finite(b30?.binance_futures?.positive_fraction, -1), s24 = finite(b24?.binance_spot?.positive_fraction, -1), f24 = finite(b24?.binance_futures?.positive_fraction, -1); if ([s30, f30, s24, f24].some((x) => x < 0)) return null;
  const ts = Date.parse(observedAt); if (!Number.isFinite(ts)) return null;
  return { observedAt, ts, breadth30: mean([s30, f30]) * 100, breadth24: mean([s24, f24]) * 100 };
}
function nearestPrior(states, ts, minutes, tolerance = 12) { const target = ts - minutes * 60000, candidates = states.filter((x) => x.ts < ts && Math.abs(x.ts - target) <= tolerance * 60000); return candidates.sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target))[0] || null; }
function benchmarkHorizonScore(rows, key, scale) { const a = (rows || []).filter((r) => r.venue === "binance_spot" || r.venue === "binance_futures"); let total = 0, den = 0; for (const r of a) { const w = finite(r.weight, 1); total += momentumScore(finite(r[key]), scale) * w; den += w; } return den ? total / den : 50; }
function c43PhaseTree30(cur, states) {
  const p30 = nearestPrior(states, cur.ts, 30), p60 = states.filter((x) => x.ts < cur.ts && x.ts >= cur.ts - 65 * 60000), p120 = states.filter((x) => x.ts <= cur.ts && x.ts >= cur.ts - 125 * 60000);
  const vel = p30 ? cur.breadth30 - p30.breadth30 : 0, peak60 = p60.length ? Math.max(...p60.map((x) => x.breadth30)) : cur.breadth30, drop60 = Math.max(0, peak60 - cur.breadth30), low120 = p120.length ? Math.min(...p120.map((x) => x.breadth30)) : cur.breadth30, rebound120 = Math.max(0, cur.breadth30 - low120);
  let score = 50, phase = "STABLE";
  if (cur.breadth30 <= 35 && (drop60 >= 20 || vel <= -18)) { score = 68; phase = "CAPITULATION_REBOUND"; }
  else if (drop60 >= 38) { score = 66; phase = "DEEP_DROP_REBOUND"; }
  else if (cur.breadth30 >= 82 && vel >= 16) { score = 38; phase = "OVEREXTENSION_ROLLOVER"; }
  else if (cur.breadth30 >= 65 && rebound120 >= 18 && vel >= -8) { score = 64; phase = "RECOVERY_CONTINUATION"; }
  else if (cur.breadth30 >= 60 && vel >= 12) { score = 62; phase = "IMPULSE_CONTINUATION"; }
  else if (cur.breadth30 >= 38 && cur.breadth30 <= 58 && vel <= -16 && drop60 >= 12 && drop60 < 35) { score = 34; phase = "ROLLOVER_CONTINUATION"; }
  else if (rebound120 >= 28 && cur.breadth30 >= 48) { score = 61; phase = "REBOUND_CONFIRMED"; }
  else if (vel >= 18) { score = 58; phase = "ACCELERATING"; }
  else if (vel <= -18) { score = 42; phase = "DECELERATING"; }
  return { score: clamp(score), phase, vel30_pp: vel, peak60_pct: peak60, drop60_pp: drop60, low120_pct: low120, rebound120_pp: rebound120 };
}
function forecastItem(horizon, score, model, details) {
  const edge = Math.abs(score - 50), probability = clamp(50 + edge * 0.9, 50, 70) / 100, dir = score >= 58 ? "UP" : score <= 42 ? "DOWN" : "NO_EDGE";
  const confidence = dir === "NO_EDGE" ? "LOW" : probability >= 0.64 ? "HIGH" : probability >= 0.57 ? "MEDIUM" : "LOW";
  return { horizon_minutes: horizon, status: dir === "NO_EDGE" ? "NO_EDGE" : "ACTIVE", direction: dir, probability: dir === "NO_EDGE" ? null : probability, confidence, market_score: score, model, details };
}
async function c43Overlay(observedAt, currentB30, currentB24, structuralScore, benchRows) {
  const current = binanceStateFromFeatures(observedAt, { breadth_30m: currentB30, breadth_24h: currentB24 });
  const since = new Date(Date.parse(observedAt) - 430 * 60000).toISOString();
  const rows = await db(`market_regime_observations?model_revision=eq.${encodeURIComponent(MODEL_REVISION)}&observed_at=gte.${encodeURIComponent(since)}&observed_at=lt.${encodeURIComponent(observedAt)}&select=observed_at,features&order=observed_at.asc&limit=120`).catch(() => []);
  const historical = (rows || []).map((r) => binanceStateFromFeatures(String(r.observed_at || ""), r.features || {})).filter(Boolean), states = current ? [...historical, current].sort((a, b) => a.ts - b.ts) : historical;
  if (!current) return { model_revision: FORECAST_REVISION, candidate_id: FORECAST_CANDIDATE_ID, phase: "UNKNOWN", forecast: { model_revision: FORECAST_REVISION, candidate_id: FORECAST_CANDIDATE_ID, policy: "DYNAMIC_HORIZON", horizons: HORIZONS.map((h) => ({ horizon_minutes: h, status: "NO_EDGE", direction: "NO_EDGE", probability: null, confidence: "LOW" })) }, trading_influence: true };
  const p30 = c43PhaseTree30(current, states);
  const b2 = benchmarkHorizonScore(benchRows, "r120", 2.5), b6 = benchmarkHorizonScore(benchRows, "r360", 4.5), b24 = benchmarkHorizonScore(benchRows, "r1440", 8);
  const score120 = clamp(0.42 * structuralScore + 0.28 * current.breadth24 + 0.20 * b2 + 0.10 * b6);
  const score360 = clamp(0.52 * structuralScore + 0.28 * current.breadth24 + 0.12 * b6 + 0.08 * b24);
  const h30 = forecastItem(30, p30.score, "PHASE_TREE", p30), h120 = forecastItem(120, score120, "PERSISTENCE", { structural_score: structuralScore, breadth24_pct: current.breadth24, benchmark_2h_score: b2, benchmark_6h_score: b6 }), h360 = forecastItem(360, score360, "STRUCT_PERSIST", { structural_score: structuralScore, breadth24_pct: current.breadth24, benchmark_6h_score: b6, benchmark_24h_score: b24 });
  return {
    model_revision: FORECAST_REVISION,
    candidate_id: FORECAST_CANDIDATE_ID,
    phase: p30.phase,
    current_binance_breadth_30m_pct: current.breadth30,
    current_binance_breadth_24h_pct: current.breadth24,
    recent_60m_peak_breadth_pct: p30.peak60_pct,
    drop_from_60m_peak_pp: p30.drop60_pp,
    low_since_latest_signal_pct: p30.low120_pct,
    signal: { observed_at: observedAt, breadth_30m_pct: current.breadth30, breadth_24h_pct: current.breadth24, prior_60m_peak_pct: p30.peak60_pct, drop_from_peak_pp: p30.drop60_pp, age_minutes: 0 },
    thresholds: { up_score: 58, down_score: 42, no_edge_between: [42, 58] },
    forecast: {
      model_revision: FORECAST_REVISION,
      candidate_id: FORECAST_CANDIDATE_ID,
      policy: "DYNAMIC_HORIZON_RECOMPUTE_EACH_OBSERVATION",
      signal_observed_at: observedAt,
      signal_age_minutes: 0,
      horizons: [h30, h120, h360],
      evidence: {
        source: "BINANCE_SPOT_PLUS_USDTM_FULL_MARKET_48H_FORWARD_COMPARISON",
        comparison_candidates: 51,
        winner_rank: 1,
        validation_samples: { next_30m: 93, next_2h: 87, next_6h: 71 },
        directional_accuracy: { next_30m: 0.452, next_2h: 0.575, next_6h: 0.761, overall: 0.582 },
        high_confidence_accuracy: 0.637,
        note: "C43 separates 30m/2h/6h models and recomputes from live market state; displayed probabilities are conservative confidence mappings, not fixed historical priors."
      }
    },
    trading_influence: true,
  };
}

async function collectSnapshot() {
  const observedAt = new Date().toISOString(), nowMs = Date.parse(observedAt);
  const [bs, bf, up, bench, prior] = await Promise.all([binanceTickers("binance_spot"), binanceTickers("binance_futures"), upbitTickers(), benchmarkScore(), priorV2(nowMs)]);
  if (bs.length < 100 || bf.length < 100 || up.length < 40) throw new Error(`universe too small spot=${bs.length} futures=${bf.length} upbit=${up.length}`);
  const maps = { ...priceMap("binance_spot", bs), ...priceMap("binance_futures", bf), ...priceMap("upbit_spot", up) }, b24 = { binance_spot: breadthFromReturns(bs.map((x) => x.ret24), 1440), binance_futures: breadthFromReturns(bf.map((x) => x.ret24), 1440), upbit_spot: breadthFromReturns(up.map((x) => x.ret24), 1440) }, g1440 = mean(Object.values(b24).map((x) => x.score));
  let b30 = null, g30 = 50, fallback = null;
  if (prior?.liquid_prices && Object.keys(prior.liquid_prices).length) {
    const parts = {}; for (const [prefix, venue] of [["BS:", "binance_spot"], ["BF:", "binance_futures"], ["UP:", "upbit_spot"]]) parts[venue] = compareVenue(prior.liquid_prices, maps, prefix, 30);
    if (parts.binance_spot.sample_size >= 80 && parts.binance_futures.sample_size >= 80 && parts.upbit_spot.sample_size >= 40) { g30 = mean(Object.values(parts).map((x) => x.score)); b30 = parts; }
  }
  if (!b30) { fallback = await researchFallback30(); g30 = fallback.score; }
  const raw = 0.50 * bench.score + 0.30 * g30 + 0.20 * g1440, bullScore = clamp(50 + (raw - 50) * 0.88), components = [bench.score, g30, g1440], nearest = Math.min(Math.abs(bullScore - 42), Math.abs(bullScore - 58), Math.abs(bullScore - 72), 20), agreement = 1 - clamp(stddev(components) / 35, 0, 1), confidence = clamp((0.45 + 0.35 * (nearest / 20) + 0.20 * agreement) * (b30 ? 1 : 0.82), 0.35, 0.95);
  const overlay = await c43Overlay(observedAt, b30, b24, bullScore, bench.rows);
  const tradingInfluence = Boolean(b30);
  return { observedAt, allPrices: maps, benchmarkPrices: benchmarkPriceMap(bs, bf, up), sampleSize: bs.length + bf.length + up.length, bullScore, confidence, regime: regimeOf(bullScore), features: { candidate_id: STRUCTURAL_CANDIDATE_ID, forecast_candidate_id: FORECAST_CANDIDATE_ID, evidence_run_id: RESEARCH_RUN_ID, source: "BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE", universe: { binance_spot: bs.length, binance_futures: bf.length, upbit_spot: up.length, total: bs.length + bf.length + up.length }, benchmark: { score: bench.score, markets: bench.rows }, breadth_30m: b30, breadth_30m_fallback: b30 ? null : { score: g30, research_bucket: fallback?.bucket || null }, breadth_24h: b24, component_scores: { benchmark: bench.score, breadth_30m: g30, breadth_24h: g1440, raw }, weights: { benchmark: 0.50, breadth_30m: 0.30, breadth_24h: 0.20, sensitivity: 0.88 }, thresholds: { risk_off_below: 42, bull: 58, strong_bull: 72 }, training_ground_truth_thresholds: { risk_off_below: 40, bull: 60, strong_bull: 75 }, momentum_phase: { ...overlay, trading_influence: tradingInfluence }, conditional_forecast: overlay.forecast, trading_influence: tradingInfluence } };
}

async function persistObservation(s) {
  const bucketMs = Math.floor(Date.parse(s.observedAt) / 300000) * 300000 + 2000, bucket = new Date(bucketMs).toISOString();
  const inserted = await db("market_regime_observations?on_conflict=observation_bucket", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ observation_bucket: bucket, observed_at: s.observedAt, model_revision: MODEL_REVISION, predicted_regime: s.regime, bull_score: s.bullScore, confidence: s.confidence, sample_size: s.sampleSize, features: s.features, benchmark_prices: s.benchmarkPrices, liquid_prices: s.allPrices, trading_influence: s.features?.trading_influence === true }) });
  if (inserted?.[0]) return inserted[0];
  return (await db(`market_regime_observations?observation_bucket=eq.${encodeURIComponent(bucket)}&select=*&limit=1`))?.[0] || {};
}
async function evaluateDue(s) {
  const nowMs = Date.parse(s.observedAt); let inserted = 0;
  for (const h of HORIZONS) {
    const earliest = new Date(nowMs - (h + 12) * 60000).toISOString(), latest = new Date(nowMs - h * 60000).toISOString();
    const obs = await db(`market_regime_observations?model_revision=eq.${encodeURIComponent(MODEL_REVISION)}&observed_at=gte.${encodeURIComponent(earliest)}&observed_at=lte.${encodeURIComponent(latest)}&select=id,observed_at,predicted_regime,bull_score,benchmark_prices,liquid_prices,features&order=observed_at.asc`).catch(() => []);
    for (const o of obs || []) {
      if (!o.liquid_prices || Object.keys(o.liquid_prices).length < 100) continue;
      const parts = [compareVenue(o.liquid_prices, s.allPrices, "BS:", h), compareVenue(o.liquid_prices, s.allPrices, "BF:", h), compareVenue(o.liquid_prices, s.allPrices, "UP:", h)];
      if (parts[0].sample_size < 80 || parts[1].sample_size < 80 || parts[2].sample_size < 40) continue;
      const pos = mean(parts.map((x) => x.positive_fraction)), clipped = mean(parts.map((x) => x.clipped_mean_pct)), benchForward = weightedBenchmarkForward(o.benchmark_prices || {}, s.benchmarkPrices), scale = Math.sqrt(120 / h), realized = clamp(50 + scale * benchForward * 14 + scale * clipped * 18 + (pos - 0.5) * 50), actual = actualRegime(realized), pred = String(o.predicted_regime), actualH = (nowMs - Date.parse(o.observed_at)) / 60000;
      const forecastAtObs = o?.features?.conditional_forecast?.horizons?.find((x) => finite(x.horizon_minutes) === h) || null;
      const result = await db("market_regime_outcomes?on_conflict=observation_id,horizon_minutes", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ observation_id: o.id, horizon_minutes: h, evaluated_at: s.observedAt, actual_horizon_minutes: actualH, realized_regime: actual, realized_bull_score: realized, exact_match: pred === actual, directional_match: direction(pred) === direction(actual), regime_distance: Math.abs(ordinal(pred) - ordinal(actual)), forward_benchmark_pct: benchForward, forward_median_pct: clipped, forward_positive_fraction: pos, sample_size: parts.reduce((z, x) => z + x.sample_size, 0), details: { model_revision: MODEL_REVISION, candidate_id: STRUCTURAL_CANDIDATE_ID, forecast_revision: forecastAtObs?.model ? FORECAST_REVISION : null, forecast_candidate_id: o?.features?.forecast_candidate_id || null, forecast_at_observation: forecastAtObs, predicted_bull_score: finite(o.bull_score), validation_basis: "forward full-market Binance spot + futures + Upbit breadth and 9 benchmark prices", trading_influence: true } }) });
      if (result?.length) inserted++;
    }
  }
  return inserted;
}
function summarizeAccuracy(rows, h) { const a = rows.filter((r) => finite(r.horizon_minutes) === h && r?.details?.model_revision === MODEL_REVISION); if (!a.length) return { samples: 0, exact_rate: null, directional_rate: null, avg_regime_distance: null }; return { samples: a.length, exact_rate: a.filter((r) => r.exact_match === true).length / a.length, directional_rate: a.filter((r) => r.directional_match === true).length / a.length, avg_regime_distance: a.reduce((s, r) => s + finite(r.regime_distance), 0) / a.length }; }
async function statusPayload() {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const [latest, recent, outcomes] = await Promise.all([db(`market_regime_observations?model_revision=eq.${encodeURIComponent(MODEL_REVISION)}&select=id,observation_bucket,observed_at,model_revision,predicted_regime,bull_score,confidence,sample_size,features,trading_influence,created_at&order=observed_at.desc&limit=1`).catch(() => []), db(`market_regime_observations?model_revision=eq.${encodeURIComponent(MODEL_REVISION)}&select=id,observed_at,predicted_regime,bull_score,confidence,features&order=observed_at.desc&limit=8`).catch(() => []), db(`market_regime_outcomes?evaluated_at=gte.${encodeURIComponent(since)}&select=*&order=evaluated_at.desc&limit=5000`).catch(() => [])]);
  const accuracy = {}; for (const h of HORIZONS) accuracy[String(h)] = summarizeAccuracy(outcomes || [], h);
  const outcomeBy = new Map(); for (const o of outcomes || []) { if (o?.details?.model_revision !== MODEL_REVISION) continue; const k = String(o.observation_id || ""), a = outcomeBy.get(k) || []; a.push(o); outcomeBy.set(k, a); }
  return { ok: true, model_revision: MODEL_REVISION, candidate_id: STRUCTURAL_CANDIDATE_ID, phase_model_revision: FORECAST_REVISION, forecast_candidate_id: FORECAST_CANDIDATE_ID, trading_influence: true, weights_locked: true, learning_phase: "LIVE_FORWARD_VALIDATION", minimum_samples_before_review: 200, latest: latest?.[0] || null, accuracy, recent: (recent || []).map((r) => ({ ...r, outcomes: (outcomeBy.get(String(r.id)) || []).sort((a, b) => finite(a.horizon_minutes) - finite(b.horizon_minutes)) })), phase_backtest: { model_revision: FORECAST_REVISION, candidate_id: FORECAST_CANDIDATE_ID, target: "dynamic 30m phase-tree + 2h persistence + 6h structural persistence", full_market: { binance_spot: 484, binance_futures: 527, interval_minutes: 30, evaluation_hours: 48 }, comparison_candidates: 51, validation_samples: { 30: 93, 120: 87, 360: 71 }, directional_accuracy: { 30: 0.452, 120: 0.575, 360: 0.761, overall: 0.582 }, high_confidence_accuracy: 0.637, previous_r60d12_replaced: true, trading_influence: true }, backtest_test: { c43_48h: { 30: { samples: 93, directional_rate: 0.452 }, 120: { samples: 87, directional_rate: 0.575 }, 360: { samples: 71, directional_rate: 0.761 }, overall_directional_rate: 0.582, robust_score: 54.05 }, previous_c00_r60d12_48h: { 30: { samples: 93, directional_rate: 0.398 }, 120: { samples: 87, directional_rate: 0.161 }, 360: { samples: 71, directional_rate: 0.746 }, overall_directional_rate: 0.414, robust_score: 40.56 } }, note: "C00 structural diagnosis remains unchanged. Only the R60-D12 fixed forecast overlay was replaced by C43 dynamic horizon forecasting. P10 exit-risk influence is active for newly persisted observations." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({})), action = String(body.action || "status").toLowerCase();
    if (action === "status") { const internal = await regimeTokenAllowed(req).catch(() => false); if (!dashboardAllowed(req) && !internal) return json({ error: "unauthorized" }, 401); return json(await statusPayload()); }
    if (!(await regimeTokenAllowed(req))) return json({ error: "unauthorized" }, 401);
    if (!["tick", "observe", "evaluate"].includes(action)) return json({ error: "unsupported action" }, 400);
    const s = await collectSnapshot(); let evaluated = 0, observation = null;
    if (action === "tick" || action === "evaluate") evaluated = await evaluateDue(s);
    if (action === "tick" || action === "observe") observation = await persistObservation(s);
    return json({ ok: true, action, evaluated, observation: observation ? { id: observation.id, observed_at: observation.observed_at, predicted_regime: observation.predicted_regime, bull_score: observation.bull_score, confidence: observation.confidence, momentum_phase: s.features?.momentum_phase?.phase || null, conditional_forecast: s.features?.conditional_forecast || null } : null, status: await statusPayload() });
  } catch (e) { console.error("market regime observer C43 failed", e); return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
});
