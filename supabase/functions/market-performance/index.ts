// Trading-booooo performance API v6.11.0 — exchange-fill accounting revision r10.
// Performance only. This function never places, changes, or cancels an order.
// Binance source of truth is the complete exchange_trade_fills ledger.
// Upbit keeps the existing trading_fills accounting path.

import {
  allocateBinanceExit,
  settleBinanceFills,
} from "./binance-settlement.ts";

type JsonRecord = Record<string, any>;
type Exchange = "upbit" | "binance";

const VERSION = "6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION";
const PERFORMANCE_REVISION = "6.11.0-r10-EXCHANGE-FILL-DIRECT-SETTLEMENT";
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const AUTOTRADE_TOKEN = env("AUTOTRADE_ACCESS_TOKEN");
const DASHBOARD_TOKEN = env("DASHBOARD_ACCESS_TOKEN") || env("LEARNING_ACCESS_TOKEN");
const DASHBOARD_ORIGIN = env("ALLOWED_ORIGINS").split(",")[0] || "*";
const PAGE_SIZE = 1000;
const CACHE_TTL_MS = 30_000;
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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: dbHeaders({ Range: `${from}-${to}`, "Range-Unit": "items" }),
    cache: "no-store",
  });
  const text = await r.text(); let data: any;
  try { data = text ? JSON.parse(text) : []; } catch { data = text; }
  if (!r.ok) throw new Error(`database ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}
async function all(path: string, maxRows: number): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const batch = await page(path, from, Math.min(maxRows - 1, from + PAGE_SIZE - 1));
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}
async function limited(path: string): Promise<any[]> { return page(path, 0, PAGE_SIZE - 1); }
function groupBy<T extends JsonRecord>(rows: T[], key: string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const row of rows) {
    const k = String(row[key] || ""); if (!k) continue;
    const a = m.get(k) || []; a.push(row); m.set(k, a);
  }
  return m;
}
function sum(rows: JsonRecord[], key: string): number { return rows.reduce((s, r) => s + Math.max(0, num(r[key])), 0); }
function earliest(rows: JsonRecord[], key = "executed_at"): string | null {
  const xs = rows.map(r => Date.parse(String(r[key] || ""))).filter(Number.isFinite);
  return xs.length ? new Date(Math.min(...xs)).toISOString() : null;
}
function latest(rows: JsonRecord[], key = "executed_at"): string | null {
  const xs = rows.map(r => Date.parse(String(r[key] || ""))).filter(Number.isFinite);
  return xs.length ? new Date(Math.max(...xs)).toISOString() : null;
}
function duration(a: string | null, b: string | null): number | null {
  if (!a || !b) return null; const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? Math.round((y - x) / 1000) : null;
}
function quoteCurrency(exchange: Exchange): string { return exchange === "upbit" ? "KRW" : "USDT"; }
function latestSnapshots(rows: JsonRecord[]): Record<Exchange, JsonRecord | null> {
  const result: Record<Exchange, JsonRecord | null> = { upbit: null, binance: null };
  for (const row of rows) {
    const e = String(row.exchange) as Exchange;
    if ((e === "upbit" || e === "binance") && !result[e]) result[e] = row;
  }
  return result;
}
function baseAsset(position: JsonRecord): string {
  if (position.base_asset) return String(position.base_asset).toUpperCase();
  const market = String(position.market || "").toUpperCase();
  if (position.exchange === "binance" && market.endsWith("USDT")) return market.slice(0, -4);
  if (position.exchange === "upbit" && market.startsWith("KRW-")) return market.slice(4);
  return market;
}
function snapshotBalance(snapshot: JsonRecord | null, asset: string): number | null {
  if (!snapshot || !snapshot.balances) return null;
  const target = asset.toUpperCase();
  const raw = snapshot.balances;
  if (Array.isArray(raw)) {
    const row = raw.find((v: any) => String(v?.asset ?? v?.currency ?? "").toUpperCase() === target);
    if (!row) return 0;
    return Math.max(0, num(row.free ?? row.balance)) + Math.max(0, num(row.locked));
  }
  if (typeof raw === "object") {
    const value = raw[target] ?? raw[asset];
    if (value == null) return 0;
    if (typeof value === "object") return Math.max(0, num(value.free ?? value.balance)) + Math.max(0, num(value.locked));
    return Math.max(0, num(value));
  }
  return null;
}
function markPrice(snapshot: JsonRecord | null, market: string, fallback: number): number {
  const mark = num(snapshot?.prices?.[market], fallback);
  return mark > 0 ? mark : fallback;
}

// Existing bot-fill path retained for Upbit. No trading decisions are made here.
function buildUpbitRows(
  position: JsonRecord,
  orders: JsonRecord[],
  fillsByOrder: Map<string, JsonRecord[]>,
  snapshot: JsonRecord | null,
): { rows: JsonRecord[]; quality: string } {
  const entryOrders = orders.filter(o => String(o.side).toUpperCase() === "BUY" && String(o.purpose).toUpperCase() === "ENTRY");
  const sellOrders = orders.filter(o => String(o.side).toUpperCase() === "SELL");
  const entryFills = entryOrders.flatMap(o => fillsByOrder.get(String(o.id || "")) || []);
  const entryQty = sum(entryFills, "volume"), entryFunds = sum(entryFills, "funds_quote");
  if (!(entryQty > 0 && entryFunds > 0)) return { rows: [], quality: "ENTRY_FILL_MISSING" };
  const entryAt = earliest(entryFills), avgEntry = entryFunds / entryQty;
  const entryFee = entryOrders.reduce((s, o) => s + Math.max(0, num(o.paid_fee_quote)), 0);
  const entryFeePerUnit = entryQty > 0 ? entryFee / entryQty : 0;
  const rows: JsonRecord[] = [];
  let soldQty = 0;
  const populated = sellOrders.map(order => ({ order, fills: fillsByOrder.get(String(order.id || "")) || [] }))
    .filter(x => sum(x.fills, "volume") > 0 && sum(x.fills, "funds_quote") > 0);
  for (let idx = 0; idx < populated.length; idx++) {
    const { order, fills } = populated[idx];
    const qty = sum(fills, "volume"), proceeds = sum(fills, "funds_quote"); soldQty += qty;
    const exitFee = Math.max(0, num(order.paid_fee_quote)) || sum(fills, "fee_quote_estimate");
    const cost = avgEntry * qty, allocatedEntryFee = entryFeePerUnit * qty;
    const pnl = proceeds - exitFee - allocatedEntryFee - cost;
    const exitAt = latest(fills);
    rows.push({
      id: `${position.id}:sell:${order.id}`, position_id: position.id, execution_order_id: order.id,
      row_type: "REALIZED_EXIT", exchange: "upbit", quote_currency: position.quote_currency || "KRW", market: position.market,
      state: "CLOSED", position_state: position.state, position_closed: String(position.state).toUpperCase() === "CLOSED",
      is_open: false, is_closed: true, immutable: String(position.state).toUpperCase() === "CLOSED",
      entry_at: entryAt, exit_at: exitAt, duration_seconds: duration(entryAt, exitAt), quantity: qty,
      average_entry_price: avgEntry, average_exit_price: proceeds / qty, entry_funds_quote: cost, exit_funds_quote: proceeds,
      invested_cost_quote: cost, total_fees_quote: allocatedEntryFee + exitFee,
      net_pnl_quote: pnl, return_pct: cost > 0 ? pnl / cost * 100 : 0,
      close_reason: order.purpose || position.close_reason || "SELL", fill_count: fills.length,
      position_exit_index: idx + 1, position_exit_count: populated.length,
      accounting_quality: "TRADING_FILL_VERIFIED", pnl_source: "TRADING_FILLS",
    });
  }
  const remaining = Math.max(0, entryQty - soldQty);
  if (remaining > 0 && String(position.state).toUpperCase() !== "CLOSED") {
    const held = snapshotBalance(snapshot, baseAsset(position));
    const qty = held == null ? remaining : Math.min(remaining, held);
    if (qty > 0) {
      const mark = markPrice(snapshot, position.market, avgEntry), cost = avgEntry * qty, fee = entryFeePerUnit * qty;
      rows.push({
        id: `${position.id}:open`, position_id: position.id, execution_order_id: null, row_type: "OPEN_REMAINDER",
        exchange: "upbit", quote_currency: position.quote_currency || "KRW", market: position.market,
        state: "OPEN", position_state: position.state, position_closed: false, is_open: true, is_closed: false, immutable: false,
        entry_at: entryAt, exit_at: null, duration_seconds: duration(entryAt, new Date().toISOString()), quantity: qty,
        average_entry_price: avgEntry, average_exit_price: null, current_price: mark, entry_funds_quote: cost, exit_funds_quote: 0,
        invested_cost_quote: cost, current_value_quote: qty * mark, total_fees_quote: fee,
        net_pnl_quote: qty * mark - cost - fee, return_pct: cost > 0 ? (qty * mark - cost - fee) / cost * 100 : 0,
        accounting_quality: held == null ? "TRADING_FILL_LEDGER_ONLY" : "TRADING_FILL_PLUS_BALANCE_VERIFIED", pnl_source: "MARK_TO_MARKET",
      });
    }
  }
  return { rows, quality: rows.length ? "TRADING_FILL_VERIFIED" : "NO_PERFORMANCE_ROW" };
}

function groupExitFills(fills: JsonRecord[]): JsonRecord[][] {
  const groups = new Map<string, JsonRecord[]>();
  for (const fill of fills) {
    const key = String(fill.exchange_order_id || `trade:${fill.exchange_trade_id || fill.id}`);
    const rows = groups.get(key) || []; rows.push(fill); groups.set(key, rows);
  }
  return [...groups.values()].sort((a, b) => Date.parse(String(latest(a) || 0)) - Date.parse(String(latest(b) || 0)));
}

function buildBinanceRows(position: JsonRecord, fills: JsonRecord[], snapshot: JsonRecord | null): { rows: JsonRecord[]; quality: string } {
  const sorted = [...fills].sort((a, b) => Date.parse(String(a.executed_at || 0)) - Date.parse(String(b.executed_at || 0)));
  const buys = sorted.filter(f => String(f.side).toUpperCase() === "BUY");
  const sells = sorted.filter(f => String(f.side).toUpperCase() === "SELL");
  const settlement = settleBinanceFills(sorted);
  const entryQty = settlement.entryQuantity;
  const entryFunds = settlement.entryFundsQuote;
  const entryFees = settlement.entryFeesQuote;
  if (!(entryQty > 0 && entryFunds > 0)) return { rows: [], quality: "EXCHANGE_ENTRY_FILL_MISSING" };

  const entryAt = earliest(buys), avgEntry = entryFunds / entryQty;
  const groups = groupExitFills(sells);
  const soldQty = settlement.soldQuantity;
  const closed = String(position.state).toUpperCase() === "CLOSED";
  const rows: JsonRecord[] = [];

  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx], qty = sum(group, "quantity"), proceeds = sum(group, "quote_amount"), sellFee = sum(group, "fee_quote_amount");
    if (!(qty > 0 && proceeds > 0)) continue;
    const allocation = allocateBinanceExit({
      settlement,
      quantity: qty,
      proceedsQuote: proceeds,
      sellFeeQuote: sellFee,
    });
    const cost = allocation.costQuote;
    const pnl = allocation.pnlQuote;
    const exitAt = latest(group);
    const orderId = group[0]?.exchange_order_id || null;
    rows.push({
      id: `${position.id}:exchange-sell:${orderId || group[0]?.exchange_trade_id || idx}`,
      position_id: position.id, execution_order_id: group[0]?.bot_order_id || null, exchange_order_id: orderId,
      row_type: "REALIZED_EXIT", exchange: "binance", quote_currency: position.quote_currency || "USDT", market: position.market,
      state: "CLOSED", position_state: position.state, position_closed: closed, is_open: false, is_closed: true, immutable: closed,
      entry_at: entryAt, exit_at: exitAt, duration_seconds: duration(entryAt, exitAt), quantity: qty,
      average_entry_price: avgEntry, average_exit_price: proceeds / qty, current_price: proceeds / qty,
      entry_funds_quote: cost, exit_funds_quote: proceeds, invested_cost_quote: cost,
      total_fees_quote: allocation.totalFeesQuote, net_pnl_quote: pnl,
      return_pct: allocation.returnPct,
      position_realized_pnl_quote: closed ? settlement.realizedPnlQuote : null,
      position_realized_return_pct: closed ? settlement.realizedReturnPct : null,
      position_realized_cost_quote: closed ? settlement.realizedCostQuote : null,
      settlement_adjustment_quote: 0,
      close_reason: position.close_reason || "EXCHANGE_FILL_RECONCILED",
      fill_count: group.length, position_exit_index: idx + 1, position_exit_count: groups.length,
      exchange_trade_ids: group.map(f => f.exchange_trade_id).filter((v: unknown) => v != null),
      actual_fill_only: true, balance_verified: true,
      accounting_quality: closed ? "SETTLED_EXCHANGE_FILL_DIRECT" : "EXCHANGE_FILL_PARTIAL_EXIT",
      fee_accounting_quality: group.every(f => f.fee_quote_amount != null) ? "EXCHANGE_RECORDED_FEE" : "FEE_PARTIAL",
      pnl_source: "EXCHANGE_TRADE_FILLS_DIRECT",
    });
  }

  const ledgerRemaining = Math.max(0, entryQty - soldQty);
  if (!closed && ledgerRemaining > 0) {
    const held = snapshotBalance(snapshot, baseAsset(position));
    const qty = held == null ? ledgerRemaining : Math.min(ledgerRemaining, held);
    if (qty > 0) {
      const mark = markPrice(snapshot, position.market, avgEntry), cost = avgEntry * qty, fee = entryQty > 0 ? entryFees * qty / entryQty : 0;
      const value = qty * mark, pnl = value - cost - fee;
      rows.push({
        id: `${position.id}:open`, position_id: position.id, execution_order_id: null, row_type: "OPEN_REMAINDER",
        exchange: "binance", quote_currency: position.quote_currency || "USDT", market: position.market,
        state: "OPEN", position_state: position.state, position_closed: false, is_open: true, is_closed: false, immutable: false,
        entry_at: entryAt, exit_at: null, duration_seconds: duration(entryAt, new Date().toISOString()), quantity: qty,
        remaining_quantity: qty, ledger_remaining_quantity: ledgerRemaining,
        average_entry_price: avgEntry, average_exit_price: null, current_price: mark,
        entry_funds_quote: cost, exit_funds_quote: 0, invested_cost_quote: cost, current_value_quote: value,
        total_fees_quote: fee, net_pnl_quote: pnl, return_pct: cost > 0 ? pnl / cost * 100 : 0,
        balance_verified: held != null, balance_discrepancy_quantity: held == null ? null : Math.max(0, ledgerRemaining - held),
        accounting_quality: held == null ? "EXCHANGE_FILL_LEDGER_ONLY" : "EXCHANGE_FILL_PLUS_BALANCE_VERIFIED",
        pnl_source: "MARK_TO_MARKET",
      });
    }
  }
  return { rows, quality: rows.length ? "EXCHANGE_FILL_VERIFIED" : "NO_PERFORMANCE_ROW" };
}

function kstDay(v: string | null): string {
  if (!v) return ""; const d = new Date(v); if (Number.isNaN(d.getTime())) return "";
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth()+1).padStart(2,"0")}-${String(k.getUTCDate()).padStart(2,"0")}`;
}
function aggregate(exchange: Exchange, rows: JsonRecord[], snapshot: JsonRecord | null): JsonRecord {
  const xs = rows.filter(r => r.exchange === exchange), realisedRows = xs.filter(r => r.row_type === "REALIZED_EXIT"), open = xs.filter(r => r.is_open);
  const s = (a: JsonRecord[], k: string) => a.reduce((z, r) => z + num(r[k]), 0);
  const realised = s(realisedRows, "net_pnl_quote"), unrealised = s(open, "net_pnl_quote"), total = realised + unrealised;
  const invested = s(realisedRows, "invested_cost_quote") + s(open, "invested_cost_quote"), investedOpen = s(open, "invested_cost_quote");
  const closedPositions = new Map<string, { pnl: number; cost: number }>();
  for (const row of realisedRows.filter(r => r.position_closed)) {
    const key = String(row.position_id), prev = closedPositions.get(key) || { pnl: 0, cost: 0 };
    prev.pnl += num(row.net_pnl_quote); prev.cost += Math.max(0, num(row.invested_cost_quote)); closedPositions.set(key, prev);
  }
  const closed = [...closedPositions.values()], wins = closed.filter(r => r.pnl > 0), losses = closed.filter(r => r.pnl < 0);
  const gp = wins.reduce((z, r) => z + r.pnl, 0), gl = Math.abs(losses.reduce((z, r) => z + r.pnl, 0));
  const today = kstDay(new Date().toISOString());
  const todayRows = realisedRows.filter(r => kstDay(r.exit_at) === today);
  return {
    exchange, quote_currency: quoteCurrency(exchange), current_equity_quote: num(snapshot?.total_equity_quote), managed_capital_quote: num(snapshot?.managed_capital_quote),
    realized_net_pnl_quote: realised, open_net_pnl_quote: unrealised, cumulative_net_pnl_quote: total,
    cumulative_return_pct: invested > 0 ? total / invested * 100 : 0, current_open_return_pct: investedOpen > 0 ? unrealised / investedOpen * 100 : 0,
    today_net_pnl_quote: s(todayRows, "net_pnl_quote"), today_return_pct: s(todayRows, "invested_cost_quote") > 0 ? s(todayRows, "net_pnl_quote") / s(todayRows, "invested_cost_quote") * 100 : 0,
    total_fees_quote: s(xs, "total_fees_quote"), realized_exit_count: realisedRows.length, closed_trade_count: closed.length, open_trade_count: open.length,
    win_count: wins.length, loss_count: losses.length, win_rate_pct: closed.length ? wins.length / closed.length * 100 : 0,
    profit_factor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    average_return_pct: closed.length ? closed.reduce((z, r) => z + (r.cost > 0 ? r.pnl / r.cost * 100 : 0), 0) / closed.length : 0,
    return_basis: "ACTUAL_EXIT_COST_WEIGHTED", source_of_truth: exchange === "binance" ? "EXCHANGE_TRADE_FILLS" : "TRADING_FILLS",
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
    const [positions, orders, botFills, exchangeFills, snapshots] = await Promise.all([
      all("trading_positions?is_paper=eq.false&state=in.(OPEN,EXITING,CLOSED)&select=id,exchange,quote_currency,market,base_asset,state,close_reason,opened_at,closed_at,realized_proceeds_quote,realized_cost_quote,paid_fees_quote,realized_pnl_quote,realized_return_pct,remaining_quantity,created_at&order=created_at.asc,id.asc", 10000),
      all("trading_orders?select=id,position_id,exchange,side,purpose,paid_fee_quote,requested_at&order=requested_at.asc,id.asc", 50000),
      all("trading_fills?select=id,order_id,trade_id,price,volume,funds_quote,fee_quote_estimate,executed_at&order=executed_at.asc,id.asc", 100000),
      all("exchange_trade_fills?exchange=eq.binance&position_id=not.is.null&select=id,position_id,side,exchange_trade_id,exchange_order_id,bot_order_id,price,quantity,quote_amount,base_asset,fee_asset,fee_amount,fee_quote_amount,realized_cost_quote,realized_proceeds_quote,realized_pnl_quote,accounting_status,source,executed_at&order=executed_at.asc,exchange_trade_id.asc", 150000),
      limited("trading_account_snapshots?select=exchange,captured_at,total_equity_quote,managed_capital_quote,prices,balances&order=captured_at.desc&limit=10"),
    ]);
    const latestSnap = latestSnapshots(snapshots), ordersByPosition = groupBy(orders, "position_id"), botFillsByOrder = groupBy(botFills, "order_id"), exchangeFillsByPosition = groupBy(exchangeFills, "position_id");
    const trades: JsonRecord[] = [], quality: Record<string, number> = {};
    for (const p of positions) {
      const exchange = String(p.exchange) as Exchange;
      const result = exchange === "binance"
        ? buildBinanceRows(p, exchangeFillsByPosition.get(String(p.id)) || [], latestSnap.binance)
        : buildUpbitRows(p, ordersByPosition.get(String(p.id)) || [], botFillsByOrder, latestSnap.upbit);
      quality[result.quality] = (quality[result.quality] || 0) + 1;
      trades.push(...result.rows);
    }
    trades.sort((a,b) => new Date(b.exit_at || b.entry_at || 0).getTime() - new Date(a.exit_at || a.entry_at || 0).getTime());
    const resultBody = {
      ok: true, version: VERSION, performance_revision: PERFORMANCE_REVISION, generated_at: new Date().toISOString(),
      source_of_truth: { binance: "exchange_trade_fills direct settlement", upbit: "trading_fills" },
      source_counts: { positions: positions.length, orders: orders.length, trading_fills: botFills.length, exchange_trade_fills: exchangeFills.length, performance_rows: trades.length },
      account_reconciliation: {
        balance_snapshot_at: { upbit: latestSnap.upbit?.captured_at || null, binance: latestSnap.binance?.captured_at || null },
        rule: "balances may verify/cap open quantity only; CLOSED economics never use current price or current balance",
      },
      exchanges: { upbit: aggregate("upbit", trades, latestSnap.upbit), binance: aggregate("binance", trades, latestSnap.binance) },
      trades, lifecycle_quality_counts: quality,
      definitions: {
        closed_trade: "CLOSED 포지션의 확정 손익/수익률은 trading_positions 정산값을 고정 사용",
        binance_exit: "Binance SELL은 exchange_trade_fills를 exchange_order_id별로 묶어 분할매도를 각각 표시",
        split_exit: "한 주문 내부의 거래소 fill 분할은 합산하고, 별도 SELL 주문은 별도 행으로 표시",
        open_row: "실제 BUY/SELL fill 잔량만 현재가 평가",
        immutable: "CLOSED 행은 현재가·현재잔고로 재계산하지 않음",
      },
    };
    cache = { body: resultBody, at: Date.now() };
    return out({ ...resultBody, cache_status: "MISS", cache_age_seconds: 0 });
  } catch (error) {
    console.error("market-performance r9 failed", error);
    if (cache) return out({ ...cache.body, cache_status: "STALE_ON_ERROR", cache_error: error instanceof Error ? error.message : String(error) });
    return out({ ok: false, error: error instanceof Error ? error.message : String(error), performance_revision: PERFORMANCE_REVISION }, 500);
  } finally { refreshing = false; }
});
