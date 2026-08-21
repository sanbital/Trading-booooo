// Trading-booooo read-only account equity performance API.
// Dashboard/accounting only. This function never places, changes, or cancels orders.

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

async function snapshot(exchange: "binance" | "binance_futures", order: "asc" | "desc", startIso?: string) {
  const filter = startIso ? `&captured_at=gte.${encodeURIComponent(startIso)}` : "";
  const url = `${SUPABASE_URL}/rest/v1/trading_account_snapshots?exchange=eq.${exchange}${filter}&select=exchange,captured_at,total_equity_quote,managed_capital_quote&order=captured_at.${order}&limit=1`;
  const response = await fetch(url, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`snapshot ${exchange} ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data[0] || null) : null;
}

function metric(exchange: string, start: any, current: any) {
  const startEquity = num(start?.total_equity_quote);
  const currentEquity = num(current?.total_equity_quote);
  const valid = startEquity != null && startEquity > 0 && currentEquity != null;
  const change = valid ? currentEquity! - startEquity! : null;
  const pct = valid ? change! / startEquity! * 100 : null;
  return {
    exchange,
    start_snapshot_at: start?.captured_at || null,
    current_snapshot_at: current?.captured_at || null,
    start_equity_quote: round(startEquity),
    current_equity_quote: round(currentEquity),
    equity_change_quote: round(change),
    account_return_pct: round(pct, 4),
    valid,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "POST only" }, 405);
  if (!authorized(req)) return out({ ok: false, error: "unauthorized" }, 401);
  try {
    const dayStart = kstDayStartIso();
    const [spotStart, spotCurrent, futuresStart, futuresCurrent] = await Promise.all([
      snapshot("binance", "asc", dayStart),
      snapshot("binance", "desc"),
      snapshot("binance_futures", "asc", dayStart),
      snapshot("binance_futures", "desc"),
    ]);
    const spot = metric("binance", spotStart, spotCurrent);
    const futures = metric("binance_futures", futuresStart, futuresCurrent);
    const combinedValid = spot.valid && futures.valid;
    const combinedStart = combinedValid ? Number(spot.start_equity_quote) + Number(futures.start_equity_quote) : null;
    const combinedCurrent = combinedValid ? Number(spot.current_equity_quote) + Number(futures.current_equity_quote) : null;
    const combinedChange = combinedValid ? combinedCurrent! - combinedStart! : null;
    const combinedPct = combinedValid && combinedStart! > 0 ? combinedChange! / combinedStart! * 100 : null;
    return out({
      ok: true,
      generated_at: new Date().toISOString(),
      window: "KST_TODAY",
      window_start_at: dayStart,
      quote_currency: "USDT",
      venues: {
        binance_spot: spot,
        binance_futures: futures,
        binance: {
          exchange: "binance_combined",
          start_snapshot_at: [spot.start_snapshot_at, futures.start_snapshot_at].filter(Boolean).sort()[0] || null,
          current_snapshot_at: [spot.current_snapshot_at, futures.current_snapshot_at].filter(Boolean).sort().slice(-1)[0] || null,
          start_equity_quote: round(combinedStart),
          current_equity_quote: round(combinedCurrent),
          equity_change_quote: round(combinedChange),
          account_return_pct: round(combinedPct, 4),
          valid: combinedValid,
        },
      },
      definitions: {
        account_return_pct: "(current equity - first equity snapshot at/after 00:00 KST) / start equity * 100",
        note: "Account equity change can include funding, deposits, withdrawals, and transfers; it is intentionally separate from strategy ROI.",
      },
    });
  } catch (error) {
    return out({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
