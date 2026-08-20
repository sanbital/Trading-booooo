// Binance source-of-truth feed for the operator dashboard.
// No PnL, return, average-cost, or settlement calculations are performed here.
// Trade rows are the exact records previously returned by Binance Spot GET /api/v3/myTrades
// through the static-IP gateway and persisted by exchange-trade-sync.

type JsonRecord = Record<string, any>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUTOTRADE_TOKEN = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || "").trim();
const DASHBOARD_TOKEN = ((Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN")) || "").trim();
const DASHBOARD_ORIGIN = ((Deno.env.get("ALLOWED_ORIGINS") || "").split(",")[0] || "*").trim();
const REVISION = "1-BINANCE-RAW-SOURCE";

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index++) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

function authorized(request: Request): boolean {
  const provided = (request.headers.get("x-autotrade-token") || "").trim();
  if (!provided) return false;
  return (AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, provided)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, provided));
}

const CORS_HEADERS = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
  "access-control-max-age": "86400",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}

function dbHeaders(): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    "cache-control": "no-cache",
  };
}

async function db(path: string): Promise<any[]> {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: dbHeaders(),
    cache: "no-store",
  });
  const text = await result.text();
  let data: any = [];
  try { data = text ? JSON.parse(text) : []; } catch { data = text; }
  if (!result.ok) throw new Error(`database ${result.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return reply({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return reply({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return reply({ ok: false, error: "missing Supabase configuration" }, 500);

  const requestBody = await request.json().catch(() => ({} as JsonRecord));
  const requestedLimit = Math.trunc(Number(requestBody?.limit ?? 500));
  const limit = Math.max(1, Math.min(1000, Number.isFinite(requestedLimit) ? requestedLimit : 500));
  const market = String(requestBody?.market || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const marketFilter = market ? `&market=eq.${encodeURIComponent(market)}` : "";

  try {
    const [fills, snapshots, runs] = await Promise.all([
      db(
        `exchange_trade_fills?exchange=eq.binance&account_scope=eq.spot${marketFilter}` +
          `&select=market,exchange_trade_id,exchange_order_id,side,price,quantity,quote_amount,fee_asset,fee_amount,is_maker,source,executed_at,raw_response` +
          `&order=executed_at.desc,exchange_trade_id.desc&limit=${limit}`,
      ),
      db(
        "trading_account_snapshots?exchange=eq.binance&select=captured_at,balances&order=captured_at.desc&limit=1",
      ),
      db(
        "exchange_trade_sync_runs?exchange=eq.binance&account_scope=eq.spot&select=started_at,completed_at,status,markets_requested,markets_succeeded,fills_seen,fills_upserted,error_message&order=started_at.desc&limit=1",
      ),
    ]);

    return reply({
      ok: true,
      revision: REVISION,
      data_source: "BINANCE_SPOT_API_V3_MYTRADES",
      calculation_policy: "NONE",
      generated_at: new Date().toISOString(),
      account_snapshot: snapshots[0] || null,
      sync_run: runs[0] || null,
      trades: fills.map((row) => ({
        market: row.market,
        exchange_trade_id: row.exchange_trade_id,
        exchange_order_id: row.exchange_order_id,
        side: row.side,
        price: row.price,
        quantity: row.quantity,
        quote_amount: row.quote_amount,
        fee_asset: row.fee_asset,
        fee_amount: row.fee_amount,
        is_maker: row.is_maker,
        source: row.source,
        executed_at: row.executed_at,
        binance: row.raw_response,
      })),
    });
  } catch (error) {
    return reply({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      revision: REVISION,
    }, 500);
  }
});
