// Trading-booooo market regime observer v1.
// IMPORTANT: learning/observation only. Nothing in this function changes trading settings,
// entry gates, exits, position size, or order frequency.

const MODEL_REVISION = "MARKET-REGIME-OBSERVER-v1";
const HORIZONS = [30, 120, 360] as const;
const LIQUID_UNIVERSE_SIZE = 120;
const MIN_QUOTE_VOLUME_USDT = 1_000_000;
const SUPABASE_URL = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const DASHBOARD_TOKEN = (Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN") || "").trim();
const ALLOWED_ORIGIN = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",")[0].trim() || "*";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type, x-autotrade-token, x-regime-token, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Json = Record<string, any>;
type Regime = "STRONG_BULL" | "BULL" | "NEUTRAL" | "RISK_OFF";
type Snapshot = {
  observedAt: string;
  tickers: Json[];
  allPrices: Record<string, number>;
  liquidPrices: Record<string, number>;
  benchmarkPrices: Record<string, number>;
  sampleSize: number;
  features: Json;
  bullScore: number;
  confidence: number;
  regime: Regime;
};

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function clamp(value: number, low = 0, high = 100): number {
  return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stddev(values: number[]): number {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return 0;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length);
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`database ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function regimeTokenAllowed(request: Request): Promise<boolean> {
  const supplied = (request.headers.get("x-regime-token") || "").trim();
  if (supplied.length < 32) return false;
  const rows = await db(
    "edge_internal_tokens?name=eq.market-regime-observer&select=token&limit=1",
  ).catch(() => []);
  const expected = String(rows?.[0]?.token || "").trim();
  return expected.length >= 32 && constantTimeEqual(expected, supplied);
}

function dashboardAllowed(request: Request): boolean {
  const supplied = (request.headers.get("x-autotrade-token") || "").trim();
  return DASHBOARD_TOKEN.length >= 32 && supplied.length > 0 && constantTimeEqual(DASHBOARD_TOKEN, supplied);
}

async function binanceJson(path: string): Promise<any> {
  const hosts = ["https://api.binance.com", "https://data-api.binance.vision"];
  let lastError = "unknown";
  for (const host of hosts) {
    try {
      const response = await fetch(`${host}${path}`, {
        headers: { accept: "application/json", "user-agent": "Trading-booooo-regime-observer/1" },
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `${host} ${response.status}: ${text.slice(0, 180)}`;
        continue;
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Binance public market data unavailable: ${lastError}`);
}

const EXCLUDED_BASES = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "TRY", "JPY", "GBP",
  "AUD", "BRL", "RUB", "UAH", "BIDR", "IDRT", "NGN", "ZAR", "MXN", "PLN", "RON", "ARS",
]);

function usableUsdtTicker(row: Json): boolean {
  const symbol = String(row?.symbol || "").toUpperCase();
  if (!symbol.endsWith("USDT") || symbol.length <= 4) return false;
  const base = symbol.slice(0, -4);
  if (EXCLUDED_BASES.has(base)) return false;
  if (/UP$|DOWN$|BULL$|BEAR$/.test(base)) return false;
  return finite(row.lastPrice) > 0 && finite(row.quoteVolume) >= MIN_QUOTE_VOLUME_USDT;
}

function momentumScore(returnPct: number, fullScalePct: number): number {
  return clamp(50 + (returnPct / Math.max(0.01, fullScalePct)) * 50);
}

function regimeOf(score: number): Regime {
  if (score >= 75) return "STRONG_BULL";
  if (score >= 60) return "BULL";
  if (score >= 40) return "NEUTRAL";
  return "RISK_OFF";
}

function regimeOrdinal(regime: Regime): number {
  return ({ RISK_OFF: 0, NEUTRAL: 1, BULL: 2, STRONG_BULL: 3 })[regime];
}

function directionOf(regime: Regime): -1 | 0 | 1 {
  return regime === "RISK_OFF" ? -1 : regime === "NEUTRAL" ? 0 : 1;
}

function returnPct(current: number, previous: number): number {
  return current > 0 && previous > 0 ? (current / previous - 1) * 100 : 0;
}

function closesOf(klines: any[]): number[] {
  return Array.isArray(klines) ? klines.map((row) => finite(row?.[4])).filter((value) => value > 0) : [];
}

function barReturn(closes: number[], barsBack: number): number {
  if (closes.length < 2) return 0;
  const last = closes[closes.length - 1];
  const index = Math.max(0, closes.length - 1 - barsBack);
  return returnPct(last, closes[index]);
}

function comparePriceMaps(
  base: Record<string, number>,
  current: Record<string, number>,
): { returns: number[]; positiveFraction: number; medianPct: number; count: number } {
  const returns: number[] = [];
  for (const [symbol, basePrice] of Object.entries(base || {})) {
    const currentPrice = finite(current?.[symbol]);
    if (basePrice > 0 && currentPrice > 0) returns.push(returnPct(currentPrice, basePrice));
  }
  return {
    returns,
    positiveFraction: returns.length ? returns.filter((value) => value > 0).length / returns.length : 0.5,
    medianPct: median(returns),
    count: returns.length,
  };
}

async function priorObservation(nowMs: number): Promise<Json | null> {
  const cutoff = new Date(nowMs - 25 * 60_000).toISOString();
  const rows = await db(
    `market_regime_observations?observed_at=lte.${encodeURIComponent(cutoff)}` +
      "&select=observed_at,liquid_prices&order=observed_at.desc&limit=1",
  ).catch(() => []);
  const row = rows?.[0] || null;
  if (!row) return null;
  const ageMinutes = (nowMs - Date.parse(row.observed_at)) / 60_000;
  return ageMinutes >= 25 && ageMinutes <= 45 ? row : null;
}

async function collectSnapshot(): Promise<Snapshot> {
  const observedAt = new Date().toISOString();
  const nowMs = Date.parse(observedAt);
  const [tickersRaw, btcKlines, ethKlines, solKlines, prior] = await Promise.all([
    binanceJson("/api/v3/ticker/24hr"),
    binanceJson("/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=49"),
    binanceJson("/api/v3/klines?symbol=ETHUSDT&interval=5m&limit=49"),
    binanceJson("/api/v3/klines?symbol=SOLUSDT&interval=5m&limit=49"),
    priorObservation(nowMs),
  ]);
  const tickers = (Array.isArray(tickersRaw) ? tickersRaw : []).filter(usableUsdtTicker);
  const byVolume = [...tickers].sort((a, b) => finite(b.quoteVolume) - finite(a.quoteVolume));
  const liquid = byVolume.slice(0, LIQUID_UNIVERSE_SIZE);
  if (liquid.length < 30) throw new Error(`liquid universe too small: ${liquid.length}`);

  const allPrices: Record<string, number> = {};
  for (const row of tickers) allPrices[String(row.symbol)] = finite(row.lastPrice);
  const liquidPrices: Record<string, number> = {};
  for (const row of liquid) liquidPrices[String(row.symbol)] = finite(row.lastPrice);
  const benchmarkPrices = {
    BTCUSDT: finite(allPrices.BTCUSDT),
    ETHUSDT: finite(allPrices.ETHUSDT),
    SOLUSDT: finite(allPrices.SOLUSDT),
  };

  const returns24h = liquid.map((row) => finite(row.priceChangePercent));
  const positive24h = returns24h.filter((value) => value > 0).length / returns24h.length;
  const gt3 = returns24h.filter((value) => value >= 3).length / returns24h.length;
  const lt3 = returns24h.filter((value) => value <= -3).length / returns24h.length;
  const median24h = median(returns24h);

  const btc = closesOf(btcKlines);
  const eth = closesOf(ethKlines);
  const sol = closesOf(solKlines);
  const benchmark = {
    btc_15m_pct: barReturn(btc, 3),
    btc_1h_pct: barReturn(btc, 12),
    btc_4h_pct: barReturn(btc, 48),
    eth_15m_pct: barReturn(eth, 3),
    eth_1h_pct: barReturn(eth, 12),
    eth_4h_pct: barReturn(eth, 48),
    sol_15m_pct: barReturn(sol, 3),
    sol_1h_pct: barReturn(sol, 12),
    sol_4h_pct: barReturn(sol, 48),
  };

  const benchmarkScore =
    0.15 * momentumScore(benchmark.btc_15m_pct, 1.0) +
    0.10 * momentumScore(benchmark.eth_15m_pct, 1.2) +
    0.05 * momentumScore(benchmark.sol_15m_pct, 1.5) +
    0.20 * momentumScore(benchmark.btc_1h_pct, 2.0) +
    0.15 * momentumScore(benchmark.eth_1h_pct, 2.5) +
    0.10 * momentumScore(benchmark.sol_1h_pct, 3.0) +
    0.15 * momentumScore(benchmark.btc_4h_pct, 4.0) +
    0.10 * momentumScore(benchmark.eth_4h_pct, 5.0);

  const breadth24hScore =
    0.55 * positive24h * 100 +
    0.25 * momentumScore(median24h, 3.0) +
    0.20 * clamp(50 + (gt3 - lt3) * 100);

  const breadth30m = prior
    ? comparePriceMaps(prior.liquid_prices || {}, allPrices)
    : { returns: [] as number[], positiveFraction: 0.5, medianPct: 0, count: 0 };
  const breadth30mScore = breadth30m.count >= 30
    ? 0.65 * breadth30m.positiveFraction * 100 + 0.35 * momentumScore(breadth30m.medianPct, 1.0)
    : null;

  const bullScore = breadth30mScore == null
    ? 0.60 * benchmarkScore + 0.40 * breadth24hScore
    : 0.50 * benchmarkScore + 0.30 * breadth30mScore + 0.20 * breadth24hScore;
  const components = [benchmarkScore, breadth24hScore, ...(breadth30mScore == null ? [] : [breadth30mScore])];
  const nearestBoundary = Math.min(Math.abs(bullScore - 40), Math.abs(bullScore - 60), Math.abs(bullScore - 75), 25);
  const boundaryConfidence = nearestBoundary / 25;
  const agreement = 1 - clamp(stddev(components) / 35, 0, 1);
  const confidence = clamp(
    (0.45 + 0.35 * boundaryConfidence + 0.20 * agreement) * (breadth30mScore == null ? 0.88 : 1),
    0.35,
    0.95,
  );

  return {
    observedAt,
    tickers,
    allPrices,
    liquidPrices,
    benchmarkPrices,
    sampleSize: liquid.length,
    bullScore: clamp(bullScore),
    confidence,
    regime: regimeOf(bullScore),
    features: {
      benchmark,
      breadth_24h: {
        positive_fraction: positive24h,
        gain_3pct_fraction: gt3,
        loss_3pct_fraction: lt3,
        median_return_pct: median24h,
      },
      breadth_30m: breadth30m.count >= 30
        ? {
          positive_fraction: breadth30m.positiveFraction,
          median_return_pct: breadth30m.medianPct,
          sample_size: breadth30m.count,
          baseline_at: prior?.observed_at || null,
        }
        : null,
      component_scores: {
        benchmark: benchmarkScore,
        breadth_24h: breadth24hScore,
        breadth_30m: breadth30mScore,
      },
      fixed_weights: breadth30mScore == null
        ? { benchmark: 0.60, breadth_24h: 0.40, breadth_30m: 0 }
        : { benchmark: 0.50, breadth_24h: 0.20, breadth_30m: 0.30 },
      thresholds: { strong_bull: 75, bull: 60, neutral: 40 },
      source: "BINANCE_LIQUID_USDT_SPOT_BREADTH",
      universe_rule: `top ${LIQUID_UNIVERSE_SIZE} USDT pairs by 24h quote volume, min ${MIN_QUOTE_VOLUME_USDT} USDT`,
      trading_influence: false,
    },
  };
}

async function persistObservation(snapshot: Snapshot): Promise<Json> {
  const bucketMs = Math.floor(Date.parse(snapshot.observedAt) / 300_000) * 300_000;
  const observationBucket = new Date(bucketMs).toISOString();
  const inserted = await db("market_regime_observations?on_conflict=observation_bucket", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      observation_bucket: observationBucket,
      observed_at: snapshot.observedAt,
      model_revision: MODEL_REVISION,
      predicted_regime: snapshot.regime,
      bull_score: snapshot.bullScore,
      confidence: snapshot.confidence,
      sample_size: snapshot.sampleSize,
      features: snapshot.features,
      benchmark_prices: snapshot.benchmarkPrices,
      liquid_prices: snapshot.liquidPrices,
      trading_influence: false,
    }),
  });
  if (inserted?.[0]) return inserted[0];
  const existing = await db(
    `market_regime_observations?observation_bucket=eq.${encodeURIComponent(observationBucket)}` +
      "&select=*&limit=1",
  );
  return existing?.[0] || {};
}

function weightedBenchmarkForward(base: Record<string, number>, current: Record<string, number>): number {
  const values: Array<[string, number]> = [["BTCUSDT", 0.45], ["ETHUSDT", 0.35], ["SOLUSDT", 0.20]];
  let totalWeight = 0;
  let total = 0;
  for (const [symbol, weight] of values) {
    const prior = finite(base?.[symbol]);
    const now = finite(current?.[symbol]);
    if (prior > 0 && now > 0) {
      total += returnPct(now, prior) * weight;
      totalWeight += weight;
    }
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}

async function evaluateDue(snapshot: Snapshot): Promise<number> {
  const nowMs = Date.parse(snapshot.observedAt);
  let insertedCount = 0;
  for (const horizon of HORIZONS) {
    const earliest = new Date(nowMs - (horizon + 12) * 60_000).toISOString();
    const latest = new Date(nowMs - horizon * 60_000).toISOString();
    const observations = await db(
      `market_regime_observations?observed_at=gte.${encodeURIComponent(earliest)}` +
        `&observed_at=lte.${encodeURIComponent(latest)}` +
        "&select=id,observed_at,predicted_regime,bull_score,benchmark_prices,liquid_prices" +
        "&order=observed_at.asc",
    ).catch(() => []);
    for (const observation of observations || []) {
      const comparison = comparePriceMaps(observation.liquid_prices || {}, snapshot.allPrices);
      if (comparison.count < 30) continue;
      const benchmarkForward = weightedBenchmarkForward(
        observation.benchmark_prices || {},
        snapshot.benchmarkPrices,
      );
      const scale = Math.sqrt(120 / horizon);
      const realizedScore = clamp(
        50 +
          scale * benchmarkForward * 14 +
          scale * comparison.medianPct * 18 +
          (comparison.positiveFraction - 0.5) * 50,
      );
      const realizedRegime = regimeOf(realizedScore);
      const predictedRegime = String(observation.predicted_regime) as Regime;
      const actualHorizon = (nowMs - Date.parse(observation.observed_at)) / 60_000;
      const result = await db("market_regime_outcomes?on_conflict=observation_id,horizon_minutes", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({
          observation_id: observation.id,
          horizon_minutes: horizon,
          evaluated_at: snapshot.observedAt,
          actual_horizon_minutes: actualHorizon,
          realized_regime: realizedRegime,
          realized_bull_score: realizedScore,
          exact_match: predictedRegime === realizedRegime,
          directional_match: directionOf(predictedRegime) === directionOf(realizedRegime),
          regime_distance: Math.abs(regimeOrdinal(predictedRegime) - regimeOrdinal(realizedRegime)),
          forward_benchmark_pct: benchmarkForward,
          forward_median_pct: comparison.medianPct,
          forward_positive_fraction: comparison.positiveFraction,
          sample_size: comparison.count,
          details: {
            model_revision: MODEL_REVISION,
            scale,
            predicted_bull_score: finite(observation.bull_score),
            validation_basis: "forward BTC/ETH/SOL + liquid-universe median/breadth",
            trading_influence: false,
          },
        }),
      });
      if (result?.length) insertedCount += 1;
    }
  }
  return insertedCount;
}

function summarizeAccuracy(outcomes: Json[], horizon: number): Json {
  const rows = outcomes.filter((row) => finite(row.horizon_minutes) === horizon);
  if (!rows.length) return { samples: 0, exact_rate: null, directional_rate: null };
  return {
    samples: rows.length,
    exact_rate: rows.filter((row) => row.exact_match === true).length / rows.length,
    directional_rate: rows.filter((row) => row.directional_match === true).length / rows.length,
    avg_regime_distance: rows.reduce((sum, row) => sum + finite(row.regime_distance), 0) / rows.length,
  };
}

async function statusPayload(): Promise<Json> {
  const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  const [latestRows, recentRows, outcomes] = await Promise.all([
    db("market_regime_observations?select=*&order=observed_at.desc&limit=1").catch(() => []),
    db(
      "market_regime_observations?select=id,observed_at,predicted_regime,bull_score,confidence" +
        "&order=observed_at.desc&limit=8",
    ).catch(() => []),
    db(
      `market_regime_outcomes?evaluated_at=gte.${encodeURIComponent(since)}` +
        "&select=observation_id,horizon_minutes,evaluated_at,realized_regime,realized_bull_score,exact_match,directional_match,regime_distance" +
        "&order=evaluated_at.desc&limit=5000",
    ).catch(() => []),
  ]);
  const accuracy: Json = {};
  for (const horizon of HORIZONS) accuracy[String(horizon)] = summarizeAccuracy(outcomes || [], horizon);
  const validationReady = HORIZONS.every((horizon) => finite(accuracy[String(horizon)]?.samples) >= 200);
  const outcomeByObservation = new Map<string, Json[]>();
  for (const outcome of outcomes || []) {
    const key = String(outcome.observation_id || "");
    const list = outcomeByObservation.get(key) || [];
    list.push(outcome);
    outcomeByObservation.set(key, list);
  }
  const recent = (recentRows || []).map((row: Json) => ({
    ...row,
    outcomes: (outcomeByObservation.get(String(row.id)) || []).sort(
      (a, b) => finite(a.horizon_minutes) - finite(b.horizon_minutes),
    ),
  }));
  return {
    ok: true,
    model_revision: MODEL_REVISION,
    trading_influence: false,
    weights_locked: true,
    learning_phase: validationReady ? "FORWARD_VALIDATION" : "COLLECTING_BASELINE",
    minimum_samples_before_review: 200,
    latest: latestRows?.[0] || null,
    accuracy,
    recent,
    note: "Market regime is observation-only and is not read by entry or exit logic.",
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await request.json().catch(() => ({})) as Json;
    const action = String(body.action || "status").toLowerCase();
    if (action === "status") {
      const internal = await regimeTokenAllowed(request).catch(() => false);
      if (!dashboardAllowed(request) && !internal) return json({ error: "unauthorized" }, 401);
      return json(await statusPayload());
    }
    if (!(await regimeTokenAllowed(request))) return json({ error: "unauthorized" }, 401);
    if (!["tick", "observe", "evaluate"].includes(action)) return json({ error: "unsupported action" }, 400);

    const snapshot = await collectSnapshot();
    let evaluated = 0;
    let observation: Json | null = null;
    if (action === "tick" || action === "evaluate") evaluated = await evaluateDue(snapshot);
    if (action === "tick" || action === "observe") observation = await persistObservation(snapshot);
    return json({
      ok: true,
      action,
      evaluated,
      observation: observation
        ? {
          id: observation.id,
          observed_at: observation.observed_at,
          predicted_regime: observation.predicted_regime,
          bull_score: observation.bull_score,
          confidence: observation.confidence,
        }
        : null,
      status: await statusPayload(),
    });
  } catch (error) {
    console.error("market regime observer failed", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
