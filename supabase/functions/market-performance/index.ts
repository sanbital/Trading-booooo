// Trading-booooo performance API v6.10.0 — fill-time integrity revision r6.
// Read-only authenticated endpoint. A trade exists only when an actual ENTRY fill exists.
// Closed trades additionally require an actual SELL fill. Mutable order timestamps are never
// used as market lifecycle timestamps.

import {
  type JsonRecord as TimeJsonRecord,
  resolveLifecycleTimes,
} from "./time-integrity.ts";

type JsonRecord = Record<string, any>;
type Exchange = "upbit" | "binance";

const VERSION = "6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE";
const PERFORMANCE_REVISION = "6.10.0-r6-FILL-TIME-INTEGRITY";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";

function env(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

function numeric(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
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
  if (!result.ok) {
    throw new Error(
      `database ${result.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
  }
  return Array.isArray(data) ? data : [];
}

function kstDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}

function latestSnapshots(rows: JsonRecord[]): Record<Exchange, JsonRecord | null> {
  const latest: Record<Exchange, JsonRecord | null> = { upbit: null, binance: null };
  for (const row of rows) {
    const exchange = String(row.exchange || "") as Exchange;
    if ((exchange === "upbit" || exchange === "binance") && !latest[exchange]) {
      latest[exchange] = row;
    }
  }
  return latest;
}

function orderFills(orderIds: Set<string>, fills: JsonRecord[]): JsonRecord[] {
  return fills.filter((fill) => orderIds.has(String(fill.order_id || "")));
}

function calculateTrade(
  position: JsonRecord,
  orders: JsonRecord[],
  fills: JsonRecord[],
  snapshot: JsonRecord | null,
): { quality: string; trade: JsonRecord | null } {
  const positionOrders = orders.filter((order) => order.position_id === position.id);
  const buys = positionOrders.filter((order) =>
    String(order.side).toUpperCase() === "BUY" && String(order.purpose).toUpperCase() === "ENTRY"
  );
  const sells = positionOrders.filter((order) => String(order.side).toUpperCase() === "SELL");
  const entryOrderIds = new Set(buys.map((order) => String(order.id)));
  const exitOrderIds = new Set(sells.map((order) => String(order.id)));
  const entryFills = orderFills(entryOrderIds, fills);
  const exitFills = orderFills(exitOrderIds, fills);
  const lifecycle = resolveLifecycleTimes({
    state: position.state,
    entryFills: entryFills as TimeJsonRecord[],
    exitFills: exitFills as TimeJsonRecord[],
  });

  if (lifecycle.quality !== "FILL_VERIFIED") {
    return { quality: lifecycle.quality, trade: null };
  }

  const feeForOrder = (order: JsonRecord) => {
    const orderFee = Math.max(0, numeric(order.paid_fee_quote));
    if (orderFee > 0) return orderFee;
    return fills.filter((fill) => fill.order_id === order.id).reduce(
      (sum, fill) => sum + Math.max(0, numeric(fill.fee_quote_estimate)),
      0,
    );
  };

  const entryVolume = buys.reduce((sum, order) => sum + Math.max(0, numeric(order.executed_volume)), 0);
  const entryFunds = buys.reduce(
    (sum, order) => sum + Math.max(0, numeric(order.executed_funds_quote)),
    0,
  );
  const entryFees = buys.reduce((sum, order) => sum + feeForOrder(order), 0);
  if (!(entryVolume > 0 && entryFunds > 0)) {
    return { quality: "ENTRY_ECONOMICS_MISSING", trade: null };
  }

  const exitVolume = sells.reduce((sum, order) => sum + Math.max(0, numeric(order.executed_volume)), 0);
  const exitFunds = sells.reduce(
    (sum, order) => sum + Math.max(0, numeric(order.executed_funds_quote)),
    0,
  );
  const exitFees = sells.reduce((sum, order) => sum + feeForOrder(order), 0);
  const remainingQuantity = Math.max(
    0,
    numeric(position.remaining_quantity, Math.max(0, entryVolume - exitVolume)),
  );
  const residualQuantity = position.state === "CLOSED"
    ? Math.max(0, numeric(position.residual_quantity))
    : 0;
  const snapshotPrice = numeric(snapshot?.prices?.[position.market]);
  const averageEntryPrice = numeric(position.average_entry_price, entryFunds / entryVolume);
  const averageExitPrice = exitVolume > 0 ? exitFunds / exitVolume : null;
  const currentPrice = position.state === "CLOSED"
    ? numeric(averageExitPrice, averageEntryPrice)
    : numeric(snapshotPrice, averageEntryPrice);
  const residualValueQuote = position.state === "CLOSED"
    ? Math.max(0, numeric(position.residual_value_quote, residualQuantity * currentPrice))
    : 0;
  const currentValue = position.state === "CLOSED"
    ? residualValueQuote
    : remainingQuantity * currentPrice;
  const totalFees = entryFees + exitFees;
  const grossPnl = exitFunds + currentValue - entryFunds;
  const calculatedNetPnl = exitFunds - exitFees + currentValue - entryFunds - entryFees;
  const netPnl = position.state === "CLOSED"
    ? numeric(position.realized_pnl_quote, calculatedNetPnl)
    : calculatedNetPnl;
  const investedCost = entryFunds + entryFees;
  const returnPct = investedCost > 0 ? netPnl / investedCost * 100 : 0;

  return {
    quality: lifecycle.quality,
    trade: {
      id: position.id,
      exchange: position.exchange,
      quote_currency: position.quote_currency,
      market: position.market,
      state: position.state,
      close_reason: position.close_reason || null,
      entry_at: lifecycle.entryAt,
      exit_at: lifecycle.exitAt,
      duration_seconds: lifecycle.durationSeconds,
      duration_quality: lifecycle.quality,
      entry_time_source: "TRADING_FILLS_MIN_EXECUTED_AT",
      exit_time_source: position.state === "CLOSED" ? "TRADING_FILLS_MAX_EXECUTED_AT" : null,
      entry_fill_count: lifecycle.entryFillCount,
      exit_fill_count: lifecycle.exitFillCount,
      entry_quantity: entryVolume,
      remaining_quantity: remainingQuantity,
      residual_quantity: residualQuantity,
      residual_value_quote: residualValueQuote,
      accounting_version: position.accounting_version || null,
      accounting_quality: position.metadata?.exit_residual_accounting?.quality || null,
      fee_accounting_version: position.fee_accounting_version || null,
      fee_accounting_quality: position.fee_accounting_quality || null,
      reserved_quote: Math.max(0, numeric(position.reserved_quote)),
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
      lifecycle_quality: "FILL_VERIFIED",
    },
  };
}

function aggregate(
  exchange: Exchange,
  trades: JsonRecord[],
  snapshot: JsonRecord | null,
  objectiveRows: JsonRecord[] = [],
): JsonRecord {
  const exchangeTrades = trades.filter((trade) => trade.exchange === exchange);
  const closed = exchangeTrades.filter((trade) => trade.is_closed);
  const open = exchangeTrades.filter((trade) => trade.is_open);
  const todayKey = kstDayKey(new Date());
  const todayClosed = closed.filter((trade) => kstDayKey(trade.exit_at || "") === todayKey);
  const todayOpened = open.filter((trade) => kstDayKey(trade.entry_at || "") === todayKey);
  const sum = (rows: JsonRecord[], key: string) =>
    rows.reduce((total, row) => total + numeric(row[key]), 0);
  const closedNet = sum(closed, "net_pnl_quote");
  const openNet = sum(open, "net_pnl_quote");
  const cumulativeNet = closedNet + openNet;
  const investedAll = sum(exchangeTrades, "invested_cost_quote");
  const investedOpen = sum(open, "invested_cost_quote");
  const wins = closed.filter((trade) => numeric(trade.net_pnl_quote) > 0);
  const losses = closed.filter((trade) => numeric(trade.net_pnl_quote) < 0);
  const grossProfit = sum(wins, "net_pnl_quote");
  const grossLoss = Math.abs(sum(losses, "net_pnl_quote"));
  const holdSamples = closed
    .map((trade) => numeric(trade.duration_seconds, Number.NaN))
    .filter(Number.isFinite);
  const todayNet = sum(todayClosed, "net_pnl_quote") + sum(todayOpened, "net_pnl_quote");
  const todayInvested = sum(todayClosed, "invested_cost_quote") +
    sum(todayOpened, "invested_cost_quote");
  const objective = objectiveRows
    .filter((row) => row.exchange === exchange)
    .sort((a, b) =>
      new Date(a.captured_at || 0).getTime() - new Date(b.captured_at || 0).getTime()
    );
  const firstObjective = objective[0] || null;
  const lastObjective = objective.at(-1) || null;
  const observationHours = firstObjective && lastObjective
    ? Math.max(
      0,
      (new Date(lastObjective.captured_at).getTime() -
        new Date(firstObjective.captured_at).getTime()) / 3_600_000,
    )
    : 0;
  const startEquity = numeric(firstObjective?.total_equity_quote);
  const endEquity = numeric(lastObjective?.total_equity_quote);
  const rawAccountLogGrowth = startEquity > 0 && endEquity > 0
    ? Math.log(endEquity / startEquity)
    : 0;
  let flowAdjustedAccountLogGrowth = 0;
  let managedCapitalHours = 0;
  let exposureHours = 0;
  for (let index = 1; index < objective.length; index++) {
    const previous = objective[index - 1];
    const current = objective[index];
    const previousAt = new Date(previous.captured_at || 0).getTime();
    const currentAt = new Date(current.captured_at || 0).getTime();
    const intervalHours = Math.max(0, (currentAt - previousAt) / 3_600_000);
    const previousEquity = Math.max(0, numeric(previous.total_equity_quote));
    const adjustedEndingEquity = numeric(current.total_equity_quote) -
      numeric(current.external_flow_quote);
    if (previousEquity > 0 && adjustedEndingEquity > 0) {
      flowAdjustedAccountLogGrowth += Math.log(adjustedEndingEquity / previousEquity);
    }
    const managed = Math.max(0, numeric(previous.managed_capital_quote));
    const exposure = Math.max(
      0,
      numeric(previous.filled_exposure_quote) + numeric(previous.reserved_exposure_quote),
    );
    managedCapitalHours += managed * intervalHours;
    exposureHours += exposure * intervalHours;
  }
  const windowStartMs = firstObjective ? new Date(firstObjective.captured_at || 0).getTime() : 0;
  const windowEndMs = lastObjective ? new Date(lastObjective.captured_at || 0).getTime() : 0;
  const windowTrades = exchangeTrades.filter((trade) => {
    const entryMs = new Date(trade.entry_at || 0).getTime();
    return Number.isFinite(entryMs) && entryMs >= windowStartMs && entryMs <= windowEndMs;
  });
  const accountCapitalTurnoverPerHour = managedCapitalHours > 0
    ? sum(windowTrades, "entry_funds_quote") / managedCapitalHours
    : 0;

  return {
    exchange,
    quote_currency: exchange === "upbit" ? "KRW" : "USDT",
    current_equity_quote: numeric(snapshot?.total_equity_quote),
    managed_capital_quote: numeric(snapshot?.managed_capital_quote),
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
    average_hold_seconds: holdSamples.length > 0
      ? holdSamples.reduce((a, b) => a + b, 0) / holdSamples.length
      : null,
    raw_account_log_growth: rawAccountLogGrowth,
    account_log_growth: flowAdjustedAccountLogGrowth,
    account_log_growth_per_hour: observationHours > 0
      ? flowAdjustedAccountLogGrowth / observationHours
      : 0,
    capital_utilization: managedCapitalHours > 0 ? exposureHours / managedCapitalHours : 0,
    account_capital_turns_per_hour: accountCapitalTurnoverPerHour,
    objective_observation_hours: observationHours,
    fee_verified_trade_count: exchangeTrades.filter((trade) =>
      ["EXACT", "AGGREGATE_EXACT", "THIRD_ASSET_MARKED", "BASE_ASSET_ACCOUNTED"].includes(
        String(trade.fee_accounting_quality || ""),
      )
    ).length,
    fill_time_verified_trade_count: exchangeTrades.length,
    return_basis: "ACTUAL_ENTRY_COST_WEIGHTED",
    time_basis: "TRADING_FILLS_EXECUTED_AT",
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") return response({ ok: false, error: "POST only" }, 405);
  if (!authorized(request)) return response({ ok: false, error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return response({ ok: false, error: "missing Supabase configuration" }, 500);
  }

  try {
    const [positions, orders, fills, snapshots, objectiveRows] = await Promise.all([
      db("trading_positions?is_paper=eq.false&state=in.(OPEN,EXITING,CLOSED)&select=*&order=created_at.desc&limit=2000"),
      db("trading_orders?state=eq.APPLIED&select=*&order=requested_at.asc&limit=10000"),
      db("trading_fills?select=*&order=executed_at.asc&limit=20000"),
      db("trading_account_snapshots?select=*&order=captured_at.desc&limit=500"),
      db("trading_joint_objective_snapshots?engine_version=eq.6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE&select=*&order=captured_at.desc&limit=5000")
        .catch(() => []),
    ]);

    const latest = latestSnapshots(snapshots);
    const qualityCounts: Record<string, number> = {};
    const trades: JsonRecord[] = [];
    for (const position of positions) {
      const result = calculateTrade(
        position,
        orders,
        fills,
        latest[position.exchange as Exchange],
      );
      qualityCounts[result.quality] = (qualityCounts[result.quality] || 0) + 1;
      if (result.trade &&
        (result.trade.is_closed || result.trade.remaining_quantity > 0 || result.trade.reserved_quote > 0)) {
        trades.push(result.trade);
      }
    }
    trades.sort((left, right) =>
      new Date(right.entry_at || 0).getTime() - new Date(left.entry_at || 0).getTime()
    );

    return response({
      ok: true,
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
      generated_at: new Date().toISOString(),
      exchanges: {
        upbit: aggregate("upbit", trades, latest.upbit, objectiveRows),
        binance: aggregate("binance", trades, latest.binance, objectiveRows),
      },
      trades,
      lifecycle_quality_counts: qualityCounts,
      excluded_trade_count: Object.entries(qualityCounts)
        .filter(([quality]) => quality !== "FILL_VERIFIED")
        .reduce((sum, [, count]) => sum + count, 0),
      definitions: {
        cumulative_return_pct: "누적 순손익 / 실제 진입원가 합계",
        current_open_return_pct: "현재 열린 포지션 순손익 / 열린 포지션 실제 진입원가",
        net_pnl_quote: "청산대금-청산수수료+현재평가액-진입대금-진입수수료",
        trade_time: "ENTRY fill 최소 executed_at부터 SELL fill 최대 executed_at까지",
        lifecycle_requirement:
          "ENTRY fill 필수, CLOSED 포지션은 SELL fill 필수, 시간 역전 거래 제외",
        joint_objective:
          "외부 현금흐름을 제거한 계좌 로그성장률·승률·관리자본 회전율을 각각 보존·개선하는 Pareto 계약",
        excluded_states: [
          "CANCELLED",
          "ENTRY_TEST_REJECTED",
          "ENTRY_REJECTED",
          "ENTRY_NOT_FILLED",
          "ORPHAN_ENTRY_PENDING",
        ],
      },
    });
  } catch (error) {
    console.error("market-performance failed", error);
    return response({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
    }, 500);
  }
});
