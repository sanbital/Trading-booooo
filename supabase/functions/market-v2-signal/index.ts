import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  detectLatestP10Signal,
  P10_REVISION,
  P10_STRATEGY_KEY,
  type P10Bar,
  type P10Venue,
} from "../_shared/p10-policy.ts";

const NAME = "market-v2-signal";
const HOUR_MS = 3_600_000;
const HISTORY_BARS = 200;
const UPBIT = "https://api.upbit.com";
const BINANCE_SPOT = "https://api.binance.com";
const BINANCE_FUTURES = "https://fapi.binance.com";

interface Ticker {
  market: string;
  lastPrice: number;
  return24hPct: number;
  quoteVolume24h: number;
}

const env = (name: string) => (Deno.env.get(name) || "").trim();
const finite = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

async function fetchJson(url: string, timeoutMs = 15_000, attempts = 3): Promise<any> {
  let lastError: unknown = new Error("request failed");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "trading-booooo-p10-signal/1.0",
        },
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;
      const retryable = response.status === 418 || response.status === 429 ||
        response.status >= 500;
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      if (!retryable || attempt + 1 >= attempts) throw lastError;
      const retryAfter = finite(response.headers.get("retry-after")) * 1_000;
      await sleep(Math.max(retryAfter, 500 * 2 ** attempt));
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) throw error;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

let nextUpbitRequestAt = 0;
let upbitGate: Promise<void> = Promise.resolve();
async function upbitFetchJson(url: string) {
  const slot = upbitGate.then(async () => {
    const waitMs = Math.max(0, nextUpbitRequestAt - Date.now());
    if (waitMs) await sleep(waitMs);
    // Five quotation calls per second leaves capacity for the order engine.
    nextUpbitRequestAt = Date.now() + 200;
  });
  upbitGate = slot.catch(() => undefined);
  await slot;
  return await fetchJson(url, 15_000, 3);
}

function serviceHeaders(extra: Record<string, string> = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY unavailable");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    accept: "application/json",
    ...extra,
  };
}

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const base = env("SUPABASE_URL");
  if (!base) throw new Error("SUPABASE_URL unavailable");
  const response = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders((init.headers || {}) as Record<string, string>),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`REST ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function authorize(request: Request) {
  const supplied = (request.headers.get("x-v2-signal-token") || "").trim();
  const rows = await rest("edge_internal_tokens?name=eq.market-v2-signal&select=token&limit=1");
  const expected = String(rows?.[0]?.token || "");
  if (!supplied || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function insertReturning(table: string, row: Record<string, unknown>) {
  const result = await rest(table, {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return result?.[0];
}

async function insertRows(table: string, rows: Record<string, unknown>[]) {
  for (let index = 0; index < rows.length; index += 250) {
    await rest(table, {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(index, index + 250)),
    });
  }
}

async function patchRun(id: string, body: Record<string, unknown>) {
  const result = await rest(`v2_live_signal_runs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  return result?.[0];
}

async function registerLiveStrategy(venue: P10Venue) {
  await rest("v2_strategy_registry?on_conflict=venue", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      venue,
      revision: P10_REVISION,
      mode: "LIVE_LIMITED",
      cutover_eligible: true,
      evidence: {
        strategy_key: P10_STRATEGY_KEY,
        data_scope: "ALL_ACTIVE_MARKETS",
        execution: "NEXT_BAR_OPEN_GAP_CAPPED",
      },
      updated_at: new Date().toISOString(),
    }),
  });
}

function binanceVenueConfig(venue: P10Venue) {
  const futures = venue === "binance_futures";
  return {
    base: futures ? BINANCE_FUTURES : BINANCE_SPOT,
    exchangeInfo: futures ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo",
    tickers: futures ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr",
    klines: futures ? "/fapi/v1/klines" : "/api/v3/klines",
  };
}

async function binanceTickers(venue: P10Venue): Promise<Ticker[]> {
  const config = binanceVenueConfig(venue);
  const [info, tickers] = await Promise.all([
    fetchJson(`${config.base}${config.exchangeInfo}`),
    fetchJson(`${config.base}${config.tickers}`),
  ]);
  const active = new Set(
    (Array.isArray(info?.symbols) ? info.symbols : [])
      .filter((row: any) =>
        row?.status === "TRADING" && row?.quoteAsset === "USDT" &&
        (venue !== "binance_spot" || row?.isSpotTradingAllowed !== false) &&
        (venue !== "binance_futures" || row?.contractType === "PERPETUAL")
      )
      .map((row: any) => String(row?.symbol || "")),
  );
  return (Array.isArray(tickers) ? tickers : [])
    .filter((row: any) => active.has(String(row?.symbol || "")))
    .map((row: any) => ({
      market: String(row.symbol),
      lastPrice: finite(row.lastPrice),
      return24hPct: finite(row.priceChangePercent),
      quoteVolume24h: finite(row.quoteVolume),
    }))
    .filter((row: Ticker) => row.market && row.lastPrice > 0)
    .sort((left: Ticker, right: Ticker) => left.market.localeCompare(right.market));
}

async function upbitTickers(): Promise<Ticker[]> {
  const rows = await upbitFetchJson(`${UPBIT}/v1/market/all?isDetails=true`);
  const markets = (Array.isArray(rows) ? rows : [])
    .map((row: any) => String(row?.market || ""))
    .filter((market: string) => market.startsWith("KRW-"))
    .sort();
  const output: Ticker[] = [];
  for (let index = 0; index < markets.length; index += 80) {
    const chunk = markets.slice(index, index + 80);
    const tickers = await upbitFetchJson(
      `${UPBIT}/v1/ticker?markets=${encodeURIComponent(chunk.join(","))}`,
    );
    for (const row of Array.isArray(tickers) ? tickers : []) {
      output.push({
        market: String(row?.market || ""),
        lastPrice: finite(row?.trade_price),
        return24hPct: finite(row?.signed_change_rate) * 100,
        quoteVolume24h: finite(row?.acc_trade_price_24h),
      });
    }
  }
  return output.filter((row) => row.market && row.lastPrice > 0)
    .sort((left, right) => left.market.localeCompare(right.market));
}

async function universeTickers(venue: P10Venue) {
  return venue === "upbit_spot" ? await upbitTickers() : await binanceTickers(venue);
}

function binanceBar(row: any[]): P10Bar {
  return {
    time: finite(row?.[0]),
    open: finite(row?.[1]),
    high: finite(row?.[2]),
    low: finite(row?.[3]),
    close: finite(row?.[4]),
    volume: finite(row?.[5]),
    quoteVolume: finite(row?.[7]),
  };
}

function upbitBar(row: any): P10Bar {
  return {
    time: Date.parse(String(row?.candle_date_time_utc || "") + "Z"),
    open: finite(row?.opening_price),
    high: finite(row?.high_price),
    low: finite(row?.low_price),
    close: finite(row?.trade_price),
    volume: finite(row?.candle_acc_trade_volume),
    quoteVolume: finite(row?.candle_acc_trade_price),
  };
}

function dedupeBars(rows: P10Bar[]) {
  const byTime = new Map<number, P10Bar>();
  for (const row of rows) {
    if (row.time > 0 && row.close > 0) byTime.set(row.time, row);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

async function marketBars(venue: P10Venue, market: string, end: number) {
  if (venue === "upbit_spot") {
    const to = new Date(end + 1).toISOString();
    const payload = await upbitFetchJson(
      `${UPBIT}/v1/candles/minutes/60?market=${encodeURIComponent(market)}` +
        `&count=${HISTORY_BARS}&to=${encodeURIComponent(to)}`,
    );
    return dedupeBars((Array.isArray(payload) ? payload : []).map(upbitBar));
  }
  const config = binanceVenueConfig(venue);
  const payload = await fetchJson(
    `${config.base}${config.klines}?symbol=${encodeURIComponent(market)}` +
      `&interval=1h&endTime=${end}&limit=${HISTORY_BARS}`,
  );
  return dedupeBars((Array.isArray(payload) ? payload : []).map(binanceBar));
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return output;
}

async function runVenue(venue: P10Venue) {
  const run = await insertReturning("v2_live_signal_runs", {
    revision: P10_REVISION,
    venue,
    mode: "LIVE_LIMITED",
    status: "RUNNING",
    metadata: { strategy_key: P10_STRATEGY_KEY },
  });
  const runId = String(run?.id || "");
  if (!runId) throw new Error("failed to create signal run");
  const errors: Array<{ market: string; error: string }> = [];
  try {
    const tickers = await universeTickers(venue);
    await insertRows(
      "v2_live_universe_snapshots",
      tickers.map((row) => ({
        run_id: runId,
        venue,
        market: row.market,
        last_price: row.lastPrice,
        return_24h_pct: row.return24hPct,
        quote_volume_24h: row.quoteVolume24h,
        // All active markets are deep-analyzed in P10. The legacy column is retained.
        deep_selected: true,
        selection_rank: null,
      })),
    );
    const end = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 1;
    const benchmarkMarket = venue === "upbit_spot" ? "KRW-BTC" : "BTCUSDT";
    const benchmarkBars = await marketBars(venue, benchmarkMarket, end);
    if (benchmarkBars.length < 106) {
      throw new Error(`benchmark history insufficient: ${benchmarkBars.length}`);
    }
    const analyzed = await mapConcurrent(
      tickers,
      venue === "upbit_spot" ? 4 : 12,
      async (ticker) => {
        try {
          const bars = ticker.market === benchmarkMarket
            ? benchmarkBars
            : await marketBars(venue, ticker.market, end);
          if (bars.length < 106) throw new Error(`history insufficient: ${bars.length}`);
          return {
            ticker,
            bars,
            signal: detectLatestP10Signal(venue, bars, benchmarkBars),
          };
        } catch (error) {
          errors.push({
            market: ticker.market,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    );
    const completed = analyzed.filter(Boolean) as Array<{
      ticker: Ticker;
      bars: P10Bar[];
      signal: ReturnType<typeof detectLatestP10Signal>;
    }>;
    const signalRows = completed.flatMap((item) =>
      item.signal
        ? [{
          run_id: runId,
          venue,
          market: item.ticker.market,
          config_key: P10_STRATEGY_KEY,
          scenario_number: 10,
          family: "DONCHIAN_BREAKOUT",
          side: item.signal.side,
          signal_time: new Date(item.signal.signalTime).toISOString(),
          score: item.signal.score,
          reference_close: item.signal.referenceClose,
          stop_reference: item.signal.stopReference,
          max_hold_bars: 96,
          evidence: {
            revision: P10_REVISION,
            strategyKey: P10_STRATEGY_KEY,
            atr14: item.signal.atr14,
            benchmark: item.signal.benchmark,
            asset: item.signal.asset,
            ticker: {
              return24hPct: item.ticker.return24hPct,
              quoteVolume24h: item.ticker.quoteVolume24h,
            },
            nextBarEntry: true,
            maxEntryGapAtr: 0.50,
            stopAtr: 2.00,
            partialAtR: 2.00,
            partialFraction: 0.40,
            targetR: 4.00,
            trailAtr: 2.50,
            breakEvenAtR: 1.50,
            exitOnEma20: true,
            lossTimeStopBars: 24,
            maxHoldBars: 96,
          },
        }]
        : []
    );
    if (signalRows.length) await insertRows("v2_live_signals", signalRows);
    const positive24h = tickers.filter((row) => row.return24hPct > 0).length;
    await registerLiveStrategy(venue);
    return await patchRun(runId, {
      status: "COMPLETED",
      total_markets: tickers.length,
      universe_scanned: tickers.length,
      deep_analyzed: completed.length,
      positive_24h: positive24h,
      positive_share_24h: tickers.length ? positive24h / tickers.length : 0,
      signal_count: signalRows.length,
      error_count: errors.length,
      completed_at: new Date().toISOString(),
      metadata: {
        strategy_key: P10_STRATEGY_KEY,
        revision: P10_REVISION,
        independentVenueScan: true,
        spotSignalMirroring: false,
        currentCandleExcluded: true,
        fullUniverseHistory: true,
        allActiveMarketsEvaluated: true,
        errors: errors.slice(0, 50),
        orderWrites: 0,
      },
    });
  } catch (error) {
    await patchRun(runId, {
      status: "FAILED",
      error_count: Math.max(1, errors.length),
      completed_at: new Date().toISOString(),
      metadata: {
        strategy_key: P10_STRATEGY_KEY,
        errors: [
          ...errors,
          { market: "_RUN_", error: error instanceof Error ? error.message : String(error) },
        ].slice(0, 50),
      },
    }).catch(() => undefined);
    throw error;
  }
}

async function status() {
  return await rest(
    `v2_live_signal_runs?revision=eq.${encodeURIComponent(P10_REVISION)}` +
      "&select=*&order=started_at.desc&limit=12",
  );
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  try {
    if (!await authorize(request)) return json({ ok: false, error: "unauthorized" }, 401);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const action = String(body?.action || "status");
    if (action === "status") {
      return json({
        ok: true,
        name: NAME,
        revision: P10_REVISION,
        strategy_key: P10_STRATEGY_KEY,
        runs: await status(),
      });
    }
    if (action !== "run") return json({ ok: false, error: "invalid action" }, 400);
    const venue = String(body?.venue || "") as P10Venue;
    if (!["upbit_spot", "binance_spot", "binance_futures"].includes(venue)) {
      return json({ ok: false, error: "invalid venue" }, 400);
    }
    const result = await runVenue(venue);
    return json({
      ok: true,
      name: NAME,
      revision: P10_REVISION,
      strategy_key: P10_STRATEGY_KEY,
      run: result,
    });
  } catch (error) {
    return json({
      ok: false,
      name: NAME,
      revision: P10_REVISION,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
