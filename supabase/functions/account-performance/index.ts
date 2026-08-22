// Trading-booooo read-only account performance API.
// Dashboard/accounting only. This function never places, changes, or cancels orders.
// Trading performance is derived from the verified fill ledger, never raw equity deltas.

const REVISION = "2026-08-22-r2-FILL-PNL-CASHFLOW-EXCLUDED";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/$/, "");
const SERVICE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUTOTRADE_TOKEN = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || "").trim();
const DASHBOARD_TOKEN = ((Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN")) || "").trim();
const DASHBOARD_ORIGIN = ((Deno.env.get("ALLOWED_ORIGINS") || "").split(",")[0] || "*").trim();

const CORS = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number | null, digits = 8): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    const n = num(value);
    if (n != null && n > 0) return n;
  }
  return null;
}

function safeEqual(a0: string, b0: string): boolean {
  const a = new TextEncoder().encode(a0), b = new TextEncoder().encode(b0);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function authorized(req: Request): boolean {
  const token = (req.headers.get("x-autotrade-token") || "").trim();
  return Boolean(token) && (
    (AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, token)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, token))
  );
}

function out(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function kstDayStartIso(nowMs = Date.now()): string {
  const offset = 9 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const startUtc = Math.floor((nowMs + offset) / day) * day - offset;
  return new Date(startUtc).toISOString();
}

async function snapshot(
  exchange: "binance" | "binance_futures",
  order: "asc" | "desc",
  startIso?: string,
) {
  const filter = startIso ? `&captured_at=gte.${encodeURIComponent(startIso)}` : "";
  const url = `${SUPABASE_URL}/rest/v1/trading_account_snapshots?exchange=eq.${exchange}${filter}&select=exchange,captured_at,total_equity_quote,capital_base_quote,managed_capital_quote&order=captured_at.${order}&limit=1`;
  const response = await fetch(url, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`snapshot ${exchange} ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data[0] || null) : null;
}

async function performance(token: string) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/market-performance`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autotrade-token": token,
      apikey: SERVICE_KEY,
    },
    body: "{}",
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(`market-performance ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function startCapital(snapshot: any): number | null {
  return firstPositive(
    snapshot?.capital_base_quote,
    snapshot?.managed_capital_quote,
    snapshot?.total_equity_quote,
  );
}

function metric(exchange: string, start: any, current: any, perf: any) {
  const startEquity = num(start?.total_equity_quote);
  const currentEquity = num(current?.total_equity_quote);
  const startCapitalQuote = startCapital(start);
  const todayTradingPnl = num(perf?.today_net_pnl_quote);
  const rawEquityChange = startEquity != null && currentEquity != null
    ? currentEquity - startEquity
    : null;
  const rawEquityPct = startEquity != null && startEquity > 0 && rawEquityChange != null
    ? rawEquityChange / startEquity * 100
    : null;
  const valid = startCapitalQuote != null && startCapitalQuote > 0 && currentEquity != null && todayTradingPnl != null;
  const returnPct = valid ? todayTradingPnl! / startCapitalQuote! * 100 : null;

  return {
    exchange,
    start_snapshot_at: start?.captured_at || null,
    current_snapshot_at: current?.captured_at || null,
    start_equity_quote: round(startEquity),
    start_capital_quote: round(startCapitalQuote),
    current_equity_quote: round(currentEquity),
    equity_change_quote: round(todayTradingPnl),
    performance_change_quote: round(todayTradingPnl),
    today_trading_pnl_quote: round(todayTradingPnl),
    account_return_pct: round(returnPct, 4),
    raw_equity_change_quote: round(rawEquityChange),
    raw_equity_change_pct: round(rawEquityPct, 4),
    return_source: "market-performance.today_net_pnl_quote",
    cash_flows_excluded: true,
    valid,
  };
}

function combinedMetric(spotStart: any, spotCurrent: any, futuresStart: any, futuresCurrent: any, perf: any) {
  const spotStartCapital = startCapital(spotStart);
  const futuresStartCapital = startCapital(futuresStart);
  const startCapitalQuote = spotStartCapital != null && futuresStartCapital != null
    ? spotStartCapital + futuresStartCapital
    : null;
  const spotStartEquity = num(spotStart?.total_equity_quote);
  const futuresStartEquity = num(futuresStart?.total_equity_quote);
  const startEquity = spotStartEquity != null && futuresStartEquity != null
    ? spotStartEquity + futuresStartEquity
    : null;
  const spotCurrentEquity = num(spotCurrent?.total_equity_quote);
  const futuresCurrentEquity = num(futuresCurrent?.total_equity_quote);
  const currentEquity = spotCurrentEquity != null && futuresCurrentEquity != null
    ? spotCurrentEquity + futuresCurrentEquity
    : null;
  const todayTradingPnl = num(perf?.today_net_pnl_quote);
  const rawEquityChange = startEquity != null && currentEquity != null
    ? currentEquity - startEquity
    : null;
  const rawEquityPct = startEquity != null && startEquity > 0 && rawEquityChange != null
    ? rawEquityChange / startEquity * 100
    : null;
  const valid = startCapitalQuote != null && startCapitalQuote > 0 && currentEquity != null && todayTradingPnl != null;
  const returnPct = valid ? todayTradingPnl! / startCapitalQuote! * 100 : null;

  return {
    exchange: "binance_combined",
    start_snapshot_at: [spotStart?.captured_at, futuresStart?.captured_at].filter(Boolean).sort()[0] || null,
    current_snapshot_at: [spotCurrent?.captured_at, futuresCurrent?.captured_at].filter(Boolean).sort().slice(-1)[0] || null,
    start_equity_quote: round(startEquity),
    start_capital_quote: round(startCapitalQuote),
    current_equity_quote: round(currentEquity),
    equity_change_quote: round(todayTradingPnl),
    performance_change_quote: round(todayTradingPnl),
    today_trading_pnl_quote: round(todayTradingPnl),
    account_return_pct: round(returnPct, 4),
    raw_equity_change_quote: round(rawEquityChange),
    raw_equity_change_pct: round(rawEquityPct, 4),
    return_source: "market-performance.exchanges.binance.today_net_pnl_quote",
    cash_flows_excluded: true,
    valid,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "POST only" }, 405);
  if (!authorized(req)) return out({ ok: false, error: "unauthorized" }, 401);

  try {
    const token = (req.headers.get("x-autotrade-token") || "").trim();
    const dayStart = kstDayStartIso();
    const [spotStart, spotCurrent, futuresStart, futuresCurrent, perf] = await Promise.all([
      snapshot("binance", "asc", dayStart),
      snapshot("binance", "desc"),
      snapshot("binance_futures", "asc", dayStart),
      snapshot("binance_futures", "desc"),
      performance(token),
    ]);

    const spot = metric("binance", spotStart, spotCurrent, perf?.exchanges?.binance_spot);
    const futures = metric("binance_futures", futuresStart, futuresCurrent, perf?.exchanges?.binance_futures);
    const combined = combinedMetric(
      spotStart,
      spotCurrent,
      futuresStart,
      futuresCurrent,
      perf?.exchanges?.binance,
    );

    return out({
      ok: true,
      revision: REVISION,
      generated_at: new Date().toISOString(),
      window: "KST_TODAY",
      window_start_at: dayStart,
      quote_currency: "USDT",
      venues: {
        binance_spot: spot,
        binance_futures: futures,
        binance: combined,
      },
      definitions: {
        account_return_pct: "verified KST-today trading PnL / start capital * 100",
        performance_change_quote: "verified fill-ledger trading PnL for KST today",
        cash_flow_policy: "deposits, withdrawals, transfers, and manual asset removals are excluded from trading performance",
        raw_equity_change: "audit-only balance movement; never used as trading PnL or account_return_pct",
      },
    });
  } catch (error) {
    return out({
      ok: false,
      revision: REVISION,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
