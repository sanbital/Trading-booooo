// Trading-booooo performance API v6.11.0 — actual-fill accounting revision r8.
// Source of truth: actual trading_fills. Each SELL order becomes an immutable realised row;
// only the unsold quantity remains an open mark-to-market row. Account balances are used
// only to verify/cap the remaining holding, never to invent realised PnL.

import { collectPages } from "./rest-pagination.ts";
import { baseAssetOf, createBalanceAllocator, snapshotBalanceMap, snapshotIsUsable } from "../_shared/position-value.ts";

type JsonRecord = Record<string, any>;
type Exchange = "upbit" | "binance";

const VERSION = "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION";
const PERFORMANCE_REVISION = "6.11.0-r8-ACTUAL-FILL-SPLIT-EXIT";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";
const PAGE_SIZE = 1000;
const CACHE_TTL_MS = 45_000;
let cache: { body: JsonRecord; at: number } | null = null;
let refreshing = false;

function env(name: string): string { return (Deno.env.get(name) || "").trim(); }
function num(v: unknown, fallback = 0): number { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function safeEqual(a0: string, b0: string): boolean {
  const a = new TextEncoder().encode(a0), b = new TextEncoder().encode(b0);
  const len = Math.max(a.length, b.length); let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}
function authorized(req: Request): boolean {
  const token = (req.headers.get("x-autotrade-token") || "").trim();
  return Boolean(token) && ((AUTOTRADE_TOKEN.length >= 32 && safeEqual(AUTOTRADE_TOKEN, token)) ||
    (DASHBOARD_TOKEN.length >= 32 && safeEqual(DASHBOARD_TOKEN, token)));
}
const CORS = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-autotrade-token, apikey, authorization",
};
function out(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function dbHeaders(extra: Record<string, string> = {}): HeadersInit {
  return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...extra };
}
async function page(path: string, from: number, to: number): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders({ Range: `${from}-${to}`, "Range-Unit": "items" }), cache: "no-store" });
  const text = await r.text(); let data: any;
  try { data = text ? JSON.parse(text) : []; } catch { data = text; }
  if (!r.ok) throw new Error(`database ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}
async function all(path: string, maxRows: number): Promise<any[]> {
  return collectPages((from, to) => page(path, from, to), { pageSize: PAGE_SIZE, maxRows });
}
async function limited(path: string): Promise<any[]> { return page(path, 0, PAGE_SIZE - 1); }
function groupBy<T extends JsonRecord>(rows: T[], key: string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const row of rows) { const k = String(row[key] || ""); if (!k) continue; const a = m.get(k) || []; a.push(row); m.set(k, a); }
  return m;
}
function sum(rows: JsonRecord[], key: string): number { return rows.reduce((s, r) => s + Math.max(0, num(r[key])), 0); }
function earliest(rows: JsonRecord[]): string | null {
  const xs = rows.map(r => Date.parse(String(r.executed_at || ""))).filter(Number.isFinite); return xs.length ? new Date(Math.min(...xs)).toISOString() : null;
}
function latest(rows: JsonRecord[]): string | null {
  const xs = rows.map(r => Date.parse(String(r.executed_at || ""))).filter(Number.isFinite); return xs.length ? new Date(Math.max(...xs)).toISOString() : null;
}
function duration(a: string | null, b: string | null): number | null {
  if (!a || !b) return null; const x = Date.parse(a), y = Date.parse(b); return Number.isFinite(x) && Number.isFinite(y) && y >= x ? Math.round((y - x) / 1000) : null;
}
function latestSnapshots(rows: JsonRecord[]): Record<Exchange, JsonRecord | null> {
  const result: Record<Exchange, JsonRecord | null> = { upbit: null, binance: null };
  for (const row of rows) { const e = String(row.exchange) as Exchange; if ((e === "upbit" || e === "binance") && !result[e]) result[e] = row; }
  return result;
}
function orderFee(order: JsonRecord, fillsByOrder: Map<string, JsonRecord[]>): number {
  const paid = Math.max(0, num(order.paid_fee_quote));
  return paid > 0 ? paid : sum(fillsByOrder.get(String(order.id || "")) || [], "fee_quote_estimate");
}
function quoteCurrency(exchange: Exchange): string { return exchange === "upbit" ? "KRW" : "USDT"; }

function buildRows(
  position: JsonRecord,
  orders: JsonRecord[],
  fillsByOrder: Map<string, JsonRecord[]>,
  snapshot: JsonRecord | null,
  allocateBalance: ((asset: string, requested: number) => number) | null,
): { rows: JsonRecord[]; quality: string } {
  const entryOrders = orders.filter(o => String(o.side).toUpperCase() === "BUY" && String(o.purpose).toUpperCase() === "ENTRY");
  const sellOrders = orders.filter(o => String(o.side).toUpperCase() === "SELL");
  const entryFills = entryOrders.flatMap(o => fillsByOrder.get(String(o.id || "")) || []);
  const entryQty = sum(entryFills, "volume"), entryFunds = sum(entryFills, "funds_quote");
  if (!(entryQty > 0 && entryFunds > 0)) return { rows: [], quality: "ENTRY_FILL_MISSING" };

  const entryAt = earliest(entryFills);
  const avgEntry = entryFunds / entryQty;
  const entryFeeTotal = entryOrders.reduce((s, o) => s + orderFee(o, fillsByOrder), 0);
  const entryFeePerUnit = entryQty > 0 ? entryFeeTotal / entryQty : 0;
  const rows: JsonRecord[] = [];
  let soldQty = 0;

  // One realised performance row per SELL ORDER. Multiple exchange fills belonging to the
  // same order are aggregated so exchange matching fragmentation is not mistaken for split selling.
  for (let idx = 0; idx < sellOrders.length; idx++) {
    const order = sellOrders[idx];
    const fills = fillsByOrder.get(String(order.id || "")) || [];
    const qty = sum(fills, "volume"), proceeds = sum(fills, "funds_quote");
    if (!(qty > 0 && proceeds > 0)) continue;
    soldQty += qty;
    const exitFee = orderFee(order, fillsByOrder);
    const allocatedEntryFunds = avgEntry * qty;
    const allocatedEntryFee = entryFeePerUnit * qty;
    const cost = allocatedEntryFunds + allocatedEntryFee;
    const pnl = proceeds - exitFee - cost;
    const exitAt = latest(fills);
    rows.push({
      id: `${position.id}:sell:${order.id}`,
      position_id: position.id,
      execution_order_id: order.id,
      row_type: "REALIZED_EXIT",
      exchange: position.exchange,
      quote_currency: position.quote_currency || quoteCurrency(position.exchange as Exchange),
      market: position.market,
      state: "CLOSED",
      is_open: false,
      is_closed: true,
      entry_at: entryAt,
      exit_at: exitAt,
      duration_seconds: duration(entryAt, exitAt),
      quantity: qty,
      entry_quantity: qty,
      remaining_quantity: 0,
      average_entry_price: avgEntry,
      average_exit_price: proceeds / qty,
      current_price: proceeds / qty,
      entry_funds_quote: allocatedEntryFunds,
      exit_funds_quote: proceeds,
      invested_cost_quote: cost,
      current_value_quote: 0,
      total_fees_quote: allocatedEntryFee + exitFee,
      net_pnl_quote: pnl,
      gross_pnl_quote: proceeds - allocatedEntryFunds,
      return_pct: cost > 0 ? pnl / cost * 100 : 0,
      close_reason: order.purpose || position.close_reason || "SELL",
      actual_fill_only: true,
      balance_verified: true,
      fill_count: fills.length,
      accounting_quality: "ACTUAL_SELL_FILL",
      fee_accounting_quality: order.paid_fee_quote && num(order.paid_fee_quote) > 0 ? "ORDER_PAID_FEE" : "FILL_FEE_ESTIMATE",
    });
  }

  const ledgerRemaining = Math.max(0, entryQty - soldQty);
  if (ledgerRemaining > 0 && String(position.state).toUpperCase() !== "CLOSED") {
    const exchange = position.exchange as Exchange;
    const asset = baseAssetOf(exchange, position.market, position.base_asset);
    const heldQty = allocateBalance ? allocateBalance(asset, ledgerRemaining) : ledgerRemaining;
    const mark = Math.max(0, num(snapshot?.prices?.[position.market], avgEntry));
    // Account balance can only cap/verify the unsold amount. Missing balance never creates a
    // synthetic sale or realised PnL row.
    if (heldQty > 0) {
      const allocatedEntryFunds = avgEntry * heldQty;
      const allocatedEntryFee = entryFeePerUnit * heldQty;
      const cost = allocatedEntryFunds + allocatedEntryFee;
      const value = heldQty * mark;
      const pnl = value - cost;
      rows.push({
        id: `${position.id}:open`,
        position_id: position.id,
        execution_order_id: null,
        row_type: "OPEN_REMAINDER",
        exchange,
        quote_currency: position.quote_currency || quoteCurrency(exchange),
        market: position.market,
        state: "OPEN",
        is_open: true,
        is_closed: false,
        entry_at: entryAt,
        exit_at: null,
        duration_seconds: entryAt ? duration(entryAt, new Date().toISOString()) : null,
        quantity: heldQty,
        entry_quantity: heldQty,
        remaining_quantity: heldQty,
        ledger_remaining_quantity: ledgerRemaining,
        average_entry_price: avgEntry,
        average_exit_price: null,
        current_price: mark,
        entry_funds_quote: allocatedEntryFunds,
        exit_funds_quote: 0,
        invested_cost_quote: cost,
        current_value_quote: value,
        total_fees_quote: allocatedEntryFee,
        net_pnl_quote: pnl,
        gross_pnl_quote: value - allocatedEntryFunds,
        return_pct: cost > 0 ? pnl / cost * 100 : 0,
        close_reason: null,
        actual_fill_only: true,
        balance_verified: Boolean(allocateBalance),
        balance_discrepancy_quantity: Math.max(0, ledgerRemaining - heldQty),
        accounting_quality: allocateBalance ? "ACTUAL_FILL_PLUS_BALANCE_VERIFIED" : "ACTUAL_FILL_LEDGER_ONLY",
        fee_accounting_quality: "ENTRY_FEE_ALLOCATED",
      });
    }
  }
  return { rows, quality: rows.length ? "ACTUAL_FILL_VERIFIED" : "NO_PERFORMANCE_ROW" };
}

function kstDay(v: string | null): string {
  if (!v) return ""; const d = new Date(v); if (Number.isNaN(d.getTime())) return ""; const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth()+1).padStart(2,"0")}-${String(k.getUTCDate()).padStart(2,"0")}`;
}
function aggregate(exchange: Exchange, rows: JsonRecord[], snapshot: JsonRecord | null): JsonRecord {
  const xs = rows.filter(r => r.exchange === exchange), closed = xs.filter(r => r.is_closed), open = xs.filter(r => r.is_open);
  const s = (a: JsonRecord[], k: string) => a.reduce((z, r) => z + num(r[k]), 0);
  const realised = s(closed, "net_pnl_quote"), unrealised = s(open, "net_pnl_quote"), total = realised + unrealised;
  const invested = s(xs, "invested_cost_quote"), investedOpen = s(open, "invested_cost_quote");
  const wins = closed.filter(r => num(r.net_pnl_quote) > 0), losses = closed.filter(r => num(r.net_pnl_quote) < 0);
  const gp = s(wins, "net_pnl_quote"), gl = Math.abs(s(losses, "net_pnl_quote"));
  const today = kstDay(new Date().toISOString());
  const todayRows = xs.filter(r => kstDay(r.exit_at || r.entry_at) === today);
  return {
    exchange,
    quote_currency: quoteCurrency(exchange),
    current_equity_quote: num(snapshot?.total_equity_quote),
    managed_capital_quote: num(snapshot?.managed_capital_quote),
    realized_net_pnl_quote: realised,
    open_net_pnl_quote: unrealised,
    cumulative_net_pnl_quote: total,
    cumulative_return_pct: invested > 0 ? total / invested * 100 : 0,
    current_open_return_pct: investedOpen > 0 ? unrealised / investedOpen * 100 : 0,
    today_net_pnl_quote: s(todayRows, "net_pnl_quote"),
    today_return_pct: s(todayRows, "invested_cost_quote") > 0 ? s(todayRows, "net_pnl_quote") / s(todayRows, "invested_cost_quote") * 100 : 0,
    total_fees_quote: s(xs, "total_fees_quote"),
    trade_count: xs.length,
    closed_trade_count: closed.length,
    open_trade_count: open.length,
    win_count: wins.length,
    loss_count: losses.length,
    win_rate_pct: closed.length ? wins.length / closed.length * 100 : 0,
    profit_factor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    average_return_pct: closed.length ? s(closed, "return_pct") / closed.length : 0,
    return_basis: "ACTUAL_FILL_COST_WEIGHTED",
    source_of_truth: "TRADING_FILLS",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "POST only" }, 405);
  if (!authorized(req)) return out({ ok: false, error: "unauthorized" }, 401);
  const bodyReq = await req.json().catch(() => ({}));
  const force = bodyReq?.force === true || String(bodyReq?.action || "") === "refresh";
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return out({ ...cache.body, cache_status: "HIT", cache_age_seconds: Math.floor((now-cache.at)/1000) });
  if (refreshing && cache) return out({ ...cache.body, cache_status: "STALE_WHILE_REFRESH" });
  refreshing = true;
  try {
    const [positions, orders, fills, snapshots] = await Promise.all([
      all("trading_positions?is_paper=eq.false&state=in.(OPEN,EXITING,CLOSED)&select=id,exchange,quote_currency,market,base_asset,state,close_reason,created_at&order=created_at.asc,id.asc", 10000),
      all("trading_orders?select=id,position_id,side,purpose,paid_fee_quote,requested_at&order=requested_at.asc,id.asc", 50000),
      all("trading_fills?select=id,order_id,trade_id,price,volume,funds_quote,fee_quote_estimate,executed_at&order=executed_at.asc,id.asc", 100000),
      limited("trading_account_snapshots?select=exchange,captured_at,total_equity_quote,managed_capital_quote,prices,balances&order=captured_at.desc&limit=10"),
    ]);
    const latestSnap = latestSnapshots(snapshots), ordersByPosition = groupBy(orders, "position_id"), fillsByOrder = groupBy(fills, "order_id");
    const allocators = new Map<Exchange, ReturnType<typeof createBalanceAllocator>>();
    const balanceReadable: Record<Exchange, boolean> = { upbit: false, binance: false };
    for (const e of ["upbit","binance"] as Exchange[]) {
      if (snapshotIsUsable(latestSnap[e])) { balanceReadable[e] = true; allocators.set(e, createBalanceAllocator(snapshotBalanceMap(latestSnap[e]?.balances))); }
    }
    const trades: JsonRecord[] = [], quality: Record<string, number> = {};
    for (const p of positions) {
      const e = p.exchange as Exchange;
      const result = buildRows(p, ordersByPosition.get(String(p.id)) || [], fillsByOrder, latestSnap[e], allocators.get(e) || null);
      quality[result.quality] = (quality[result.quality] || 0) + 1;
      trades.push(...result.rows);
    }
    trades.sort((a,b) => new Date(b.exit_at || b.entry_at || 0).getTime() - new Date(a.exit_at || a.entry_at || 0).getTime());
    const resultBody = {
      ok: true,
      version: VERSION,
      performance_revision: PERFORMANCE_REVISION,
      generated_at: new Date().toISOString(),
      source_of_truth: "trading_fills",
      source_counts: { positions: positions.length, orders: orders.length, fills: fills.length, performance_rows: trades.length },
      account_reconciliation: { balance_readable: balanceReadable, balance_snapshot_at: { upbit: latestSnap.upbit?.captured_at || null, binance: latestSnap.binance?.captured_at || null }, rule: "balance verifies/caps open quantity only; never estimates realised PnL" },
      exchanges: { upbit: aggregate("upbit", trades, latestSnap.upbit), binance: aggregate("binance", trades, latestSnap.binance) },
      trades,
      lifecycle_quality_counts: quality,
      definitions: {
        realised_row: "SELL order별 실제 fill 수량·대금·수수료로 확정",
        open_row: "실제 BUY fill - 실제 SELL fill 잔량만 현재가 평가",
        partial_exit: "분할 매도는 SELL order마다 별도 행",
        balance_rule: "계좌 잔고는 보유수량 검증에만 사용하며 손익을 추정하지 않음",
      },
    };
    cache = { body: resultBody, at: Date.now() };
    return out({ ...resultBody, cache_status: "MISS", cache_age_seconds: 0 });
  } catch (error) {
    console.error("market-performance r8 failed", error);
    if (cache) return out({ ...cache.body, cache_status: "STALE_ON_ERROR", cache_error: error instanceof Error ? error.message : String(error) });
    return out({ ok: false, error: error instanceof Error ? error.message : String(error), performance_revision: PERFORMANCE_REVISION }, 500);
  } finally { refreshing = false; }
});
