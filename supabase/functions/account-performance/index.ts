// Trading-booooo read-only account equity performance API.
// Dashboard/accounting only. This function never places, changes, or cancels orders.
//
// Equity change is not a return. Over one recent day the futures wallet went 67 → 619 USDT
// because capital was transferred in, and reporting that delta over the starting equity put
// a four-figure percentage on the dashboard that no trade produced. The engine records every
// detected deposit, withdrawal and transfer in `trading_cash_flows`, so this API now reports
// the equity change with that movement removed — `trading_*` — beside the raw equity figures,
// which keep their existing field names for compatibility.

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

import { netCapitalFlowQuote, tradingReturn } from "../market-autotrader/capital-flow.ts";

function kstDayStartIso(nowMs = Date.now()): string {
  const offset = 9 * 60 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const startUtc = Math.floor((nowMs + offset) / day) * day - offset;
  return new Date(startUtc).toISOString();
}

async function cashFlows(exchange: string, startIso: string) {
  const url = `${SUPABASE_URL}/rest/v1/trading_cash_flows?exchange=eq.${exchange}` +
    `&detected_at=gte.${encodeURIComponent(startIso)}&select=flow_type,amount_quote`;
  const response = await fetch(url, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) return [];
  return Array.isArray(data) ? data : [];
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

function metric(exchange: string, start: any, current: any, flowRows: unknown[] = []) {
  const startEquity = num(start?.total_equity_quote);
  const currentEquity = num(current?.total_equity_quote);
  const valid = startEquity != null && startEquity > 0 && currentEquity != null;
  const flow = netCapitalFlowQuote(flowRows as any[]);
  const change = valid ? currentEquity! - startEquity! : null;
  const pct = valid ? change! / startEquity! * 100 : null;
  const traded = valid
    ? tradingReturn({
      startEquityQuote: startEquity!,
      currentEquityQuote: currentEquity!,
      netCapitalFlowQuote: flow,
    })
    : null;
  return {
    exchange,
    start_snapshot_at: start?.captured_at || null,
    current_snapshot_at: current?.captured_at || null,
    start_equity_quote: round(startEquity),
    current_equity_quote: round(currentEquity),
    equity_change_quote: round(change),
    // Raw equity movement, deposits and withdrawals included. Kept under its original name
    // so existing readers do not break; it is a balance delta, not a strategy result.
    account_return_pct: round(pct, 4),
    capital_flow_quote: round(valid ? flow : null),
    trading_pnl_quote: round(traded?.tradingPnlQuote ?? null),
    trading_return_pct: round(traded?.tradingReturnPct ?? null, 4),
    capital_flow_detected: valid && Math.abs(flow) > 0,
    valid,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "POST only" }, 405);
  if (!authorized(req)) return out({ ok: false, error: "unauthorized" }, 401);
  try {
    const dayStart = kstDayStartIso();
    const [spotStart, spotCurrent, futuresStart, futuresCurrent, spotFlows, futuresFlows] =
      await Promise.all([
        snapshot("binance", "asc", dayStart),
        snapshot("binance", "desc"),
        snapshot("binance_futures", "asc", dayStart),
        snapshot("binance_futures", "desc"),
        cashFlows("binance", dayStart),
        cashFlows("binance_futures", dayStart),
      ]);
    const spot = metric("binance", spotStart, spotCurrent, spotFlows);
    const futures = metric("binance_futures", futuresStart, futuresCurrent, futuresFlows);
    const combinedValid = spot.valid && futures.valid;
    const combinedStart = combinedValid ? Number(spot.start_equity_quote) + Number(futures.start_equity_quote) : null;
    const combinedCurrent = combinedValid ? Number(spot.current_equity_quote) + Number(futures.current_equity_quote) : null;
    const combinedChange = combinedValid ? combinedCurrent! - combinedStart! : null;
    const combinedPct = combinedValid && combinedStart! > 0 ? combinedChange! / combinedStart! * 100 : null;
    const combinedFlow = netCapitalFlowQuote([...spotFlows, ...futuresFlows] as any[]);
    const combinedTraded = combinedValid
      ? tradingReturn({
        startEquityQuote: combinedStart!,
        currentEquityQuote: combinedCurrent!,
        netCapitalFlowQuote: combinedFlow,
      })
      : null;
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
          capital_flow_quote: round(combinedValid ? combinedFlow : null),
          trading_pnl_quote: round(combinedTraded?.tradingPnlQuote ?? null),
          trading_return_pct: round(combinedTraded?.tradingReturnPct ?? null, 4),
          capital_flow_detected: combinedValid && Math.abs(combinedFlow) > 0,
          valid: combinedValid,
        },
      },
      definitions: {
        account_return_pct: "(current equity - first equity snapshot at/after 00:00 KST) / start equity * 100. Balance movement, NOT a trading return: deposits, withdrawals and internal transfers are included in it.",
        capital_flow_quote: "net deposits minus withdrawals recorded in trading_cash_flows over the same window",
        trading_pnl_quote: "equity change with capital movement removed: realized plus unrealized trading result",
        trading_return_pct: "trading_pnl_quote / (start equity + capital added during the window) * 100",
        note: "Use trading_return_pct for strategy performance. account_return_pct answers a different question — how much the account balance moved — and a deposit will move it without a single trade.",
      },
    });
  } catch (error) {
    return out({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
