// Trading-booooo performance API v6.11.0 — performance freshness revision r2.
// The dashboard is built only from actual LIVE fills. PostgREST is paged explicitly so
// the default 1,000-row response cap cannot freeze the trade list at an old timestamp.

import { type JsonRecord as TimeJsonRecord, resolveLifecycleTimes } from "./time-integrity.ts";
import { collectPages } from "./rest-pagination.ts";

type JsonRecord = Record<string, any>;
type Exchange = "upbit" | "binance";

const VERSION = "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION";
const PERFORMANCE_REVISION = "6.11.0-r4-TRADING-DB-LOAD-SHED";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";
const REST_PAGE_SIZE = 1000;
const PERFORMANCE_CACHE_TTL_MS = 120_000;
const PERFORMANCE_LOAD_SHED = true;
let performanceCache: { body: JsonRecord; cachedAt: number } | null = null;
let performanceRefreshInFlight = false;

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
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
      expires: "0",
    },
  });
}

function dbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
    "cache-control": "no-cache",
    pragma: "no-cache",
    ...extra,
  };
}

async function dbPage(path: string, from: number, to: number): Promise<any[]> {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: dbHeaders({
      Range: `${from}-${to}`,
      "Range-Unit": "items",
    }),
    cache: "no-store",
  });
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

async function dbAll(path: string, maxRows: number): Promise<any[]> {
  return collectPages(
    (from, to) => dbPage(path, from, to),
    { pageSize: REST_PAGE_SIZE, maxRows },
  );
}

async function dbLimited(path: string): Promise<any[]> {
  return dbPage(path, 0, REST_PAGE_SIZE - 1);
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

function groupBy<T extends JsonRecord>(rows: T[], key: string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = String(row[key] || "");
    if (!value) continue;
    const current = grouped.get(value) || [];
    current.push(row);
    grouped.set(value, current);
  }
  return grouped;
}

function calculateTrade(
  position: JsonRecord,
  positionOrders: JsonRecord[],
  fillsByOrder: Map<string, JsonRecord[]>,
  snapshot: JsonRecord | null,
): { quality: string; trade: JsonRecord | null } {
  const buys = positionOrders.filter((order) =>
    String(order.side).toUpperCase() === "BUY" && String(order.purpose).toUpperCase() === "ENTRY"
  );
  const sells = positionOrders.filter((order) => String(order.side).toUpperCase() === "SELL");
  const fillsForOrders = (orders: JsonRecord[]) => orders.flatMap((order) =>
    fillsByOrder.get(String(order.id || "")) || []
  );
  const entryFills = fillsForOrders(buys);
  const exitFills = fillsForOrders(sells);
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
    return (fillsByOrder.get(String(order.id || "")) || []).reduce(
      (sum, fill) => sum + Math.max(0, numeric(fill.fee_quote_estimate)),
      0,
    );
  };
  const sumFills = (rows: JsonRecord[], key: string) =>
    rows.reduce((sum, fill) => sum + Math.max(0, numeric(fill[key])), 0);

  // Actual fill economics are the source of truth. This also includes partially filled orders
  // that later ended in EXCHANGE_CANCELLED, which the old APPLIED-only query omitted.
  const entryVolume = sumFills(entryFills, "volume");
  const entryFunds = sumFills(entryFills, "funds_quote");
  const entryFees = buys.reduce((sum, order) => sum + feeForOrder(order), 0);
  if (!(entryVolume > 0 && entryFunds > 0)) {
    return { quality: "ENTRY_ECONOMICS_MISSING", trade: null };
  }

  const exitVolume = sumFills(exitFills, "volume");
  const exitFunds = sumFills(exitFills, "funds_quote");
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
    fee_verified_trade_count:
      exchangeTrades.filter((trade) =>
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
  if (PERFORMANCE_LOAD_SHED) {
    return response({
      ok: false,
      status: "TEMPORARY_LOAD_SHED",
      error: "Performance aggregation is temporarily paused to protect live trading database capacity.",
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
      retry_after_seconds: 300,
      trading_impact: "NONE",
    }, 503);
  }

  const now = Date.now();
  if (performanceCache && now - performanceCache.cachedAt < PERFORMANCE_CACHE_TTL_MS) {
    return response({
      ...performanceCache.body,
      cache_status: "HIT",
      cache_age_seconds: Math.floor((now - performanceCache.cachedAt) / 1000),
      cache_ttl_seconds: PERFORMANCE_CACHE_TTL_MS / 1000,
    });
  }
  if (performanceRefreshInFlight) {
    if (performanceCache) {
      return response({
        ...performanceCache.body,
        cache_status: "STALE_WHILE_REFRESH",
        cache_age_seconds: Math.floor((now - performanceCache.cachedAt) / 1000),
        cache_ttl_seconds: PERFORMANCE_CACHE_TTL_MS / 1000,
      });
    }
    return response({
      ok: false,
      error: "performance refresh already in progress",
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
      retry_after_seconds: 5,
    }, 503);
  }

  performanceRefreshInFlight = true;
  try {
    const [positions, orders, fills, snapshots, objectiveRows] = await Promise.all([
      dbAll(
        "trading_positions?is_paper=eq.false&state=in.(OPEN,EXITING,CLOSED)&select=*&order=created_at.asc,id.asc",
        10_000,
      ),
      dbAll("trading_orders?select=*&order=requested_at.asc,id.asc", 50_000),
      dbAll("trading_fills?select=*&order=executed_at.asc,id.asc", 100_000),
      dbLimited("trading_account_snapshots?select=*&order=captured_at.desc&limit=500"),
      dbAll(
        "trading_joint_objective_snapshots?engine_version=in.(6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE,6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION)&select=*&order=captured_at.asc,id.asc",
        10_000,
      ).catch(() => []),
    ]);

    const latest = latestSnapshots(snapshots);
    const ordersByPosition = groupBy(orders, "position_id");
    const fillsByOrder = groupBy(fills, "order_id");
    const qualityCounts: Record<string, number> = {};
    const trades: JsonRecord[] = [];

    for (const position of positions) {
      const result = calculateTrade(
        position,
        ordersByPosition.get(String(position.id || "")) || [],
        fillsByOrder,
        latest[position.exchange as Exchange],
      );
      qualityCounts[result.quality] = (qualityCounts[result.quality] || 0) + 1;
      if (
        result.trade &&
        (result.trade.is_closed || result.trade.remaining_quantity > 0 ||
          result.trade.reserved_quote > 0)
      ) {
        trades.push(result.trade);
      }
    }

    trades.sort((left, right) =>
      new Date(right.entry_at || 0).getTime() - new Date(left.entry_at || 0).getTime()
    );
    const newestTrade = trades[0] || null;
    const newestExitAt = trades.reduce<string | null>((latestAt, trade) => {
      if (!trade.exit_at) return latestAt;
      if (!latestAt) return trade.exit_at;
      return new Date(trade.exit_at).getTime() > new Date(latestAt).getTime()
        ? trade.exit_at
        : latestAt;
    }, null);

    console.log("market-performance snapshot", {
      revision: PERFORMANCE_REVISION,
      positions: positions.length,
      orders: orders.length,
      fills: fills.length,
      trades: trades.length,
      newest_entry_at: newestTrade?.entry_at || null,
      newest_exit_at: newestExitAt,
    });

    const body: JsonRecord = {
      ok: true,
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
      generated_at: new Date().toISOString(),
      source_counts: {
        positions: positions.length,
        orders: orders.length,
        fills: fills.length,
        trades: trades.length,
      },
      newest_entry_at: newestTrade?.entry_at || null,
      newest_exit_at: newestExitAt,
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
        pagination: "PostgREST 응답을 1,000행 단위로 끝까지 페이지 조회",
        joint_objective:
          "외부 현금흐름을 제거한 계좌 로그성장률·승률·관리자본 회전율을 각각 보존·개선하는 Pareto 계약",
        excluded_states: [
          "CANCELLED_WITHOUT_FILL",
          "ENTRY_TEST_REJECTED",
          "ENTRY_REJECTED",
          "ENTRY_NOT_FILLED",
          "ORPHAN_ENTRY_PENDING",
        ],
      },
    };
    performanceCache = { body, cachedAt: Date.now() };
    return response({
      ...body,
      cache_status: "MISS",
      cache_age_seconds: 0,
      cache_ttl_seconds: PERFORMANCE_CACHE_TTL_MS / 1000,
    });
  } catch (error) {
    console.error("market-performance failed", error);
    if (performanceCache) {
      return response({
        ...performanceCache.body,
        cache_status: "STALE_ON_ERROR",
        cache_age_seconds: Math.floor((Date.now() - performanceCache.cachedAt) / 1000),
        cache_ttl_seconds: PERFORMANCE_CACHE_TTL_MS / 1000,
        cache_error: error instanceof Error ? error.message : String(error),
      });
    }
    return response({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
    }, 500);
  } finally {
    performanceRefreshInFlight = false;
  }
});
