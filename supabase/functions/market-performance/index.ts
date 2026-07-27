// Trading-booooo performance API v1.0.0
// Read-only, authenticated dashboard endpoint. Computes performance only from
// live positions backed by an APPLIED entry fill; rejected/cancelled/ghost rows
// never count as trades.

type JsonRecord = Record<string, any>;
type Exchange = "upbit" | "binance";

const VERSION = "1.0.0";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";

function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function dbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function db(path: string): Promise<any[]> {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders() });
  const text = await result.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = text;
  }
  if (!result.ok) throw new Error(`database ${result.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

function firstTime(...values: unknown[]): string | null {
  for (const value of values) {
    const date = new Date(String(value || ""));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function kstDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function durationSeconds(start: string | null, end: string | null): number | null {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function latestSnapshots(rows: JsonRecord[]): Record<Exchange, JsonRecord | null> {
  const latest: Record<Exchange, JsonRecord | null> = { upbit: null, binance: null };
  for (const row of rows) {
    const exchange = String(row.exchange || "") as Exchange;
    if ((exchange === "upbit" || exchange === "binance") && !latest[exchange]) latest[exchange] = row;
  }
  return latest;
}

function calculateTrade(position: JsonRecord, orders: JsonRecord[], snapshot: JsonRecord | null): JsonRecord | null {
  const positionOrders = orders.filter((order) => order.position_id === position.id);
  const buys = positionOrders.filter((order) => String(order.side).toUpperCase() === "BUY" && String(order.purpose).toUpperCase() === "ENTRY");
  const sells = positionOrders.filter((order) => String(order.side).toUpperCase() === "SELL");

  const entryVolume = buys.reduce((sum, order) => sum + Math.max(0, finite(order.executed_volume)), 0);
  const entryFunds = buys.reduce((sum, order) => sum + Math.max(0, finite(order.executed_funds_quote)), 0);
  const entryFees = buys.reduce((sum, order) => sum + Math.max(0, finite(order.paid_fee_quote)), 0);
  if (!(entryVolume > 0 && entryFunds > 0)) return null;

  const exitVolume = sells.reduce((sum, order) => sum + Math.max(0, finite(order.executed_volume)), 0);
  const exitFunds = sells.reduce((sum, order) => sum + Math.max(0, finite(order.executed_funds_quote)), 0);
  const exitFees = sells.reduce((sum, order) => sum + Math.max(0, finite(order.paid_fee_quote)), 0);
  const remainingQuantity = Math.max(0, finite(position.remaining_quantity, entryVolume - exitVolume));
  const residualQuantity = position.state === "CLOSED"
    ? Math.max(0, finite(position.residual_quantity))
    : 0;
  const snapshotPrice = finite(snapshot?.prices?.[position.market]);
  const averageEntryPrice = finite(position.average_entry_price, entryFunds / entryVolume);
  const currentPrice = position.state === "CLOSED"
    ? finite(sells.at(-1)?.average_fill_price, averageEntryPrice)
    : finite(snapshotPrice, averageEntryPrice);
  const residualValueQuote = position.state === "CLOSED"
    ? Math.max(0, finite(position.residual_value_quote, residualQuantity * currentPrice))
    : 0;
  const currentValue = remainingQuantity * currentPrice + residualValueQuote;
  const totalFees = entryFees + exitFees;
  const grossPnl = exitFunds + currentValue - entryFunds;
  const calculatedNetPnl = exitFunds - exitFees + currentValue - entryFunds - entryFees;
  const netPnl = position.state === "CLOSED"
    ? finite(position.realized_pnl_quote, calculatedNetPnl)
    : calculatedNetPnl;
  const investedCost = entryFunds + entryFees;
  const returnPct = investedCost > 0 ? netPnl / investedCost * 100 : 0;
  const averageExitPrice = exitVolume > 0 ? exitFunds / exitVolume : null;
  const entryAt = firstTime(
    buys[0]?.completed_at,
    buys[0]?.requested_at,
    buys[0]?.created_at,
    position.opened_at,
    position.created_at,
  );
  const exitAt = position.state === "CLOSED"
    ? firstTime(position.closed_at, sells.at(-1)?.completed_at, sells.at(-1)?.requested_at)
    : null;

  return {
    id: position.id,
    exchange: position.exchange,
    quote_currency: position.quote_currency,
    market: position.market,
    state: position.state,
    close_reason: position.close_reason || null,
    entry_at: entryAt,
    exit_at: exitAt,
    duration_seconds: durationSeconds(entryAt, exitAt),
    entry_quantity: entryVolume,
    remaining_quantity: remainingQuantity,
    residual_quantity: residualQuantity,
    residual_value_quote: residualValueQuote,
    accounting_version: position.accounting_version || null,
    average_entry_price: averageEntryPrice,
    average_exit_price: averageExitPrice,
    current_price: currentPrice,
    entry_funds_quote: entryFunds,
    invested_cost_quote: investedCost,
    exit_funds_quote: exitFunds,
    current_value_quote: currentValue,
    gross_pnl_quote: grossPnl,
    total_fees_quote: totalFees,
    net_pnl_quote: netPnl,
    return_pct: returnPct,
    is_open: position.state !== "CLOSED",
    is_closed: position.state === "CLOSED",
  };
}

function aggregate(exchange: Exchange, trades: JsonRecord[], snapshot: JsonRecord | null): JsonRecord {
  const exchangeTrades = trades.filter((trade) => trade.exchange === exchange);
  const closed = exchangeTrades.filter((trade) => trade.is_closed);
  const open = exchangeTrades.filter((trade) => trade.is_open);
  const todayKey = kstDayKey(new Date());
  const todayClosed = closed.filter((trade) => kstDayKey(trade.exit_at || "") === todayKey);
  const todayOpened = open.filter((trade) => kstDayKey(trade.entry_at || "") === todayKey);

  const sum = (rows: JsonRecord[], key: string) => rows.reduce((total, row) => total + finite(row[key]), 0);
  const closedNet = sum(closed, "net_pnl_quote");
  const openNet = sum(open, "net_pnl_quote");
  const cumulativeNet = closedNet + openNet;
  const investedAll = sum(exchangeTrades, "invested_cost_quote");
  const investedOpen = sum(open, "invested_cost_quote");
  const wins = closed.filter((trade) => finite(trade.net_pnl_quote) > 0);
  const losses = closed.filter((trade) => finite(trade.net_pnl_quote) < 0);
  const grossProfit = sum(wins, "net_pnl_quote");
  const grossLoss = Math.abs(sum(losses, "net_pnl_quote"));
  const holdSamples = closed.map((trade) => finite(trade.duration_seconds, NaN)).filter(Number.isFinite);
  const todayNet = sum(todayClosed, "net_pnl_quote") + sum(todayOpened, "net_pnl_quote");
  const todayInvested = sum(todayClosed, "invested_cost_quote") + sum(todayOpened, "invested_cost_quote");

  return {
    exchange,
    quote_currency: exchange === "upbit" ? "KRW" : "USDT",
    current_equity_quote: finite(snapshot?.total_equity_quote),
    managed_capital_quote: finite(snapshot?.managed_capital_quote),
    realized_net_pnl_quote: closedNet,
    open_net_pnl_quote: openNet,
    cumulative_net_pnl_quote: cumulativeNet,
    cumulative_return_pct: investedAll > 0 ? cumulativeNet / investedAll * 100 : 0,
    current_open_return_pct: investedOpen > 0 ? openNet / investedOpen * 100 : 0,
    today_net_pnl_quote: todayNet,
    today_return_pct: todayInvested > 0 ? todayNet / todayInvested * 100 : 0,
    total_fees_quote: sum(exchangeTrades, "total_fees_quote"),
    trade_count: exchangeTrades.length,
    closed_trade_count: closed.length,
    open_trade_count: open.length,
    win_count: wins.length,
    loss_count: losses.length,
    win_rate_pct: closed.length > 0 ? wins.length / closed.length * 100 : 0,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    average_return_pct: closed.length > 0 ? sum(closed, "return_pct") / closed.length : 0,
    average_hold_seconds: holdSamples.length > 0 ? holdSamples.reduce((a, b) => a + b, 0) / holdSamples.length : null,
    return_basis: "ACTUAL_ENTRY_COST_WEIGHTED",
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return response({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return response({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return response({ ok: false, error: "missing Supabase configuration" }, 500);

  try {
    const [positions, orders, snapshots] = await Promise.all([
      db("trading_positions?is_paper=eq.false&state=in.(OPEN,EXITING,CLOSED)&select=*&order=created_at.desc&limit=1000"),
      db("trading_orders?state=eq.APPLIED&select=*&order=requested_at.asc&limit=5000"),
      db("trading_account_snapshots?select=*&order=captured_at.desc&limit=200"),
    ]);

    const latest = latestSnapshots(snapshots);
    const trades = positions
      .map((position) => calculateTrade(position, orders, latest[position.exchange as Exchange]))
      // TS does not narrow through filter(Boolean); the predicate makes the null removal
      // visible to the type checker. Runtime behavior is unchanged.
      .filter((row): row is JsonRecord => Boolean(row))
      .sort((left: any, right: any) => new Date(right.entry_at || 0).getTime() - new Date(left.entry_at || 0).getTime());

    return response({
      ok: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      exchanges: {
        upbit: aggregate("upbit", trades, latest.upbit),
        binance: aggregate("binance", trades, latest.binance),
      },
      trades,
      definitions: {
        cumulative_return_pct: "누적 순손익 / 실제 진입원가 합계",
        current_open_return_pct: "현재 열린 포지션 순손익 / 열린 포지션 실제 진입원가",
        net_pnl_quote: "청산대금-청산수수료+현재평가액-진입대금-진입수수료",
        excluded_states: ["CANCELLED", "ENTRY_TEST_REJECTED", "ENTRY_REJECTED", "ENTRY_NOT_FILLED", "ORPHAN_ENTRY_PENDING"],
      },
    });
  } catch (error) {
    console.error("market-performance failed", error);
    return response({ ok: false, error: error instanceof Error ? error.message : String(error), version: VERSION }, 500);
  }
});
