// Raw Binance Spot Order History feed for the operator dashboard.
// Financial fields are not calculated, normalized, averaged, or reconstructed here.
// Recent symbols come from local routing metadata only; every displayed order field comes
// directly from Binance GET /api/v3/allOrders through the static-IP gateway.

type JsonRecord = Record<string, any>;

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SERVICE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const AUTOTRADE_TOKEN = (Deno.env.get("AUTOTRADE_ACCESS_TOKEN") || "").trim();
const DASHBOARD_TOKEN = ((Deno.env.get("DASHBOARD_ACCESS_TOKEN") || Deno.env.get("LEARNING_ACCESS_TOKEN")) || "").trim();
const GW_URL = ((Deno.env.get("BINANCE_ORDER_GATEWAY_URL") || Deno.env.get("ORDER_GATEWAY_URL")) || "").replace(/\/$/, "");
const GW_SECRET = (Deno.env.get("BINANCE_GATEWAY_SHARED_SECRET") || Deno.env.get("GATEWAY_SHARED_SECRET") || "").trim();
const DASHBOARD_ORIGIN = ((Deno.env.get("ALLOWED_ORIGINS") || "").split(",")[0] || "*").trim();
const REVISION = "1-BINANCE-ALLORDERS-RAW";
const enc = new TextEncoder();
let hmacKey: CryptoKey | null = null;

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

async function sign(message: string): Promise<string> {
  if (!hmacKey) {
    hmacKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(GW_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  const raw = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(message));
  return [...new Uint8Array(raw)].map(v => v.toString(16).padStart(2, "0")).join("");
}

async function gateway(command: JsonRecord): Promise<any> {
  const raw = JSON.stringify(command);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = await sign(`${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${GW_URL}/v1/command`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-gateway-ts": ts,
        "x-gateway-nonce": nonce,
        "x-gateway-signature": signature,
      },
      body: raw,
    });
    const text = await response.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(`gateway ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
    if (!parsed?.ok) throw new Error(`gateway response: ${String(parsed?.error || "invalid")}`);
    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}

async function db(path: string): Promise<any[]> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      "cache-control": "no-cache",
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: any = [];
  try { data = text ? JSON.parse(text) : []; } catch { data = text; }
  if (!response.ok) throw new Error(`database ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return reply({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return reply({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY || !GW_URL || !GW_SECRET) {
    return reply({ ok: false, error: "missing Binance source configuration" }, 500);
  }

  const body = await request.json().catch(() => ({} as JsonRecord));
  const lookbackHours = Math.max(1, Math.min(168, Math.trunc(Number(body.lookback_hours || 48)) || 48));
  const requestedLimit = Math.max(1, Math.min(500, Math.trunc(Number(body.limit || 200)) || 200));
  const cutoffIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const cutoffMs = Date.parse(cutoffIso);

  try {
    const [recentRoutingRows, snapshotRows] = await Promise.all([
      db(
        `trading_orders?exchange=eq.binance&requested_at=gte.${encodeURIComponent(cutoffIso)}` +
          `&exchange_order_id=not.is.null&select=market&order=requested_at.desc&limit=1000`,
      ),
      db("trading_account_snapshots?exchange=eq.binance&select=captured_at,balances&order=captured_at.desc&limit=1"),
    ]);

    const markets = [...new Set(recentRoutingRows.map(row => String(row.market || "").toUpperCase()).filter(Boolean))];
    const allOrders: any[] = [];
    const errors: Array<{ market: string; error: string }> = [];

    for (const market of markets) {
      try {
        const result = await gateway({
          exchange: "binance",
          action: "order_history",
          market,
          start_time: cutoffMs,
          limit: 1000,
        });
        if (Array.isArray(result)) allOrders.push(...result);
      } catch (error) {
        errors.push({ market, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const deduped = new Map<string, any>();
    for (const order of allOrders) {
      const symbol = String(order?.symbol || "");
      const orderId = String(order?.orderId ?? "");
      if (!symbol || !orderId) continue;
      deduped.set(`${symbol}:${orderId}`, order);
    }

    const orders = [...deduped.values()]
      .sort((a, b) => Number(b?.time || b?.updateTime || 0) - Number(a?.time || a?.updateTime || 0))
      .slice(0, requestedLimit);

    return reply({
      ok: true,
      revision: REVISION,
      data_source: "BINANCE_SPOT_API_V3_ALLORDERS",
      calculation_policy: "NONE",
      generated_at: new Date().toISOString(),
      account_snapshot: snapshotRows[0] || null,
      markets_queried: markets,
      errors,
      orders,
    });
  } catch (error) {
    return reply({
      ok: false,
      revision: REVISION,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
