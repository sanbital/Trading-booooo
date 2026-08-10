// Trading-booooo exchange trade sync v1.1.0
//
// Pulls Binance fills into `exchange_trade_fills` and settles `trading_positions`
// from them. Binance fills are the single source of truth: a position closes because
// the exchange says the coin is gone, never because a bot order state said so.
//
// v1.1.0 fixes the defect that produced ghost positions:
//   * The bot-order lookup used `.limit(5000)` on a table with ~2.8k rows. PostgREST
//     caps every response at db-max-rows (1000), so only the oldest ~1000 orders were
//     ever visible and every fill from a newer order was written unlinked and
//     `source='MANUAL'`. Orders are now fetched with explicit Range pagination.
//   * Nothing ever fed fills back into positions, so a fully-sold position stayed
//     OPEN forever and the autotrader retried its exit indefinitely. Each synced
//     market now runs `reconcile_positions_from_exchange_fills`, which re-links
//     fills and settles positions whose exchange inventory is exhausted.
// Both passes are idempotent, so re-running the sync cannot move a settled number.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Json = Record<string, unknown>;
type Trade = {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty?: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  realizedPnl?: string;
};
type BotOrder = {
  id: string;
  position_id: string | null;
  market: string;
  exchange_order_id: string | null;
  identifier: string;
};
type SyncState = { lastId: number | null; lastSynced: number; lastTradeAt: string | null };

const SB_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GW_URL =
  (Deno.env.get("BINANCE_ORDER_GATEWAY_URL") ?? Deno.env.get("ORDER_GATEWAY_URL") ?? "").replace(
    /\/$/,
    "",
  );
const GW_SECRET = Deno.env.get("BINANCE_GATEWAY_SHARED_SECRET") ??
  Deno.env.get("GATEWAY_SHARED_SECRET") ?? "";
const PUBLIC_URL = (Deno.env.get("BINANCE_BASE_URL") ?? "https://api.binance.com").replace(
  /\/$/,
  "",
);
const EXCHANGE = "binance", SCOPE = "spot", QUOTE = "USDT";
const BACKFILL_BATCH = 18, URGENT_BACKFILL_SLOTS = 6, MAX_FULL_SWEEP = 240;
// PostgREST returns at most db-max-rows (1000) per request no matter what `limit`
// says. Anything that must be complete has to be paged explicitly.
const PAGE_SIZE = 1000, MAX_ORDER_PAGES = 40;

const enc = new TextEncoder(), feeCache = new Map<string, number>();
let hmacKey: CryptoKey | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown, f = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
};

function reply(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sign(message: string) {
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
  return [...new Uint8Array(raw)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function gatewayOnce(command: Json) {
  const raw = JSON.stringify(command), ts = String(Date.now()), nonce = crypto.randomUUID();
  const signature = await sign(`${ts}\n${nonce}\n${raw}`);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${GW_URL}/v1/command`, {
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
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* keep raw text for the error message */ }
    if (!res.ok) {
      throw new Error(
        `GATEWAY_${res.status}:${
          (typeof parsed === "string" ? parsed : JSON.stringify(parsed)).slice(0, 500)
        }`,
      );
    }
    if (!parsed?.ok) throw new Error(`GATEWAY_RESPONSE:${String(parsed?.error ?? "INVALID")}`);
    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}

async function gateway(command: Json) {
  // Exponential backoff. A 429 answered by an immediate retry is what turns one
  // rate-limit into a burst of them.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await gatewayOnce(command);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const retry = /expired gateway request|GATEWAY_429|GATEWAY_418|LOCAL_RATE_GUARD/i.test(m);
      if (!retry || attempt === 2) throw e;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
}

async function publicGet(path: string, params: Record<string, string | number>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const res = await fetch(`${PUBLIC_URL}${path}?${q}`), text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* keep raw text for the error message */ }
  if (!res.ok) {
    throw new Error(
      `BINANCE_PUBLIC_${res.status}:${
        (typeof parsed === "string" ? parsed : JSON.stringify(parsed)).slice(0, 300)
      }`,
    );
  }
  return parsed;
}

function assets(symbol: string) {
  return symbol.endsWith(QUOTE)
    ? { base: symbol.slice(0, -QUOTE.length), quote: QUOTE }
    : { base: symbol, quote: QUOTE };
}

async function feeQuote(asset: string, amount: number, base: string, price: number, at: number) {
  if (!(amount > 0)) return 0;
  if (asset === QUOTE) return amount;
  if (asset === base) return amount * price;
  const minute = Math.floor(at / 60000) * 60000, key = `${asset}:${minute}`;
  if (feeCache.has(key)) return amount * (feeCache.get(key) ?? 0);
  try {
    const candles = await publicGet("/api/v3/klines", {
      symbol: `${asset}${QUOTE}`,
      interval: "1m",
      startTime: minute,
      endTime: minute + 59999,
      limit: 1,
    });
    const c = Array.isArray(candles) && Array.isArray(candles[0]) ? candles[0] : null;
    const bv = c ? num(c[5]) : 0, qv = c ? num(c[7]) : 0;
    const mark = bv > 0 && qv > 0 ? qv / bv : c ? num(c[4]) : 0;
    feeCache.set(key, mark);
    return amount * mark;
  } catch {
    feeCache.set(key, 0);
    return 0;
  }
}

function oldestFirst(stateMap: Map<string, SyncState>) {
  return (a: string, b: string) =>
    (stateMap.get(a)?.lastSynced ?? 0) - (stateMap.get(b)?.lastSynced ?? 0) || a.localeCompare(b);
}

// Complete order list, paged past the PostgREST row cap. Truncating this is what
// orphaned every fill placed after the table passed 1000 rows.
async function loadAllOrders(sb: any): Promise<BotOrder[]> {
  const rows: BotOrder[] = [];
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await sb
      .from("trading_orders")
      .select("id,position_id,market,exchange_order_id,identifier")
      .eq("exchange", EXCHANGE)
      .not("exchange_order_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`ORDERS:${error.message}`);
    const batch = (data ?? []) as BotOrder[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadFuturesOrders(sb: any): Promise<BotOrder[]> {
  const rows: BotOrder[] = [];
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await sb
      .from("trading_orders")
      .select("id,position_id,market,exchange_order_id,identifier")
      .eq("exchange", "binance_futures")
      .not("exchange_order_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`FUTURES_ORDERS:${error.message}`);
    const batch = (data ?? []) as BotOrder[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function futuresPositionForTrade(positions: any[], market: string, tradeTime: number): any | null {
  const candidates = positions
    .filter((p) =>
      String(p.market) === market &&
      Date.parse(String(p.opened_at || p.created_at || 0)) <= tradeTime
    )
    .sort((a, b) =>
      Date.parse(String(b.opened_at || b.created_at || 0)) -
      Date.parse(String(a.opened_at || a.created_at || 0))
    );
  return candidates[0] ?? null;
}

async function syncFuturesTrades(sb: any) {
  const [orders, posRes, stateRes] = await Promise.all([
    loadFuturesOrders(sb),
    sb.from("trading_positions")
      .select("id,market,base_asset,state,opened_at,closed_at,created_at,leverage")
      .eq("exchange", "binance_futures")
      .in("state", ["OPEN", "EXITING", "CLOSED"])
      .order("created_at", { ascending: true })
      .limit(1000),
    sb.from("exchange_trade_sync_state")
      .select("market,last_exchange_trade_id,last_synced_at,last_trade_at")
      .eq("exchange", "binance_futures")
      .eq("account_scope", "futures")
      .limit(1000),
  ]);
  if (posRes.error) throw new Error(`FUTURES_POSITIONS:${posRes.error.message}`);
  if (stateRes.error) throw new Error(`FUTURES_SYNC_STATE:${stateRes.error.message}`);
  const positions = posRes.data ?? [];
  const orderMap = new Map<string, BotOrder>();
  for (const o of orders) {
    if (o.exchange_order_id) orderMap.set(`${o.market}:${o.exchange_order_id}`, o);
  }
  const stateMap = new Map<string, SyncState>();
  for (const row of stateRes.data ?? []) {
    stateMap.set(String(row.market), {
      lastId: row.last_exchange_trade_id == null ? null : Number(row.last_exchange_trade_id),
      lastSynced: row.last_synced_at ? Date.parse(String(row.last_synced_at)) : 0,
      lastTradeAt: row.last_trade_at ? String(row.last_trade_at) : null,
    });
  }
  const markets = [
    ...new Set([
      ...orders.map((o) => String(o.market || "")),
      ...positions.map((p: any) => String(p.market || "")),
    ].filter((m) => m.endsWith(QUOTE))),
  ];
  let seen = 0, upserted = 0, settled = 0;
  const errors: Array<{ market: string; error: string }> = [];
  for (const market of markets) {
    try {
      const state = stateMap.get(market);
      const command: Json = {
        exchange: "binance_futures",
        action: "trade_history",
        market,
        limit: 1000,
      };
      if (state?.lastId != null) command.from_id = state.lastId + 1;
      const raw = await gateway(command) as Trade[];
      const trades = Array.isArray(raw) ? raw : [];
      seen += trades.length;
      let maxId = state?.lastId ?? null, maxAt = state?.lastTradeAt ?? null;
      const rows: Json[] = [], affected = new Set<string>();
      const a = assets(market);
      for (const t of trades) {
        const qty = num(t.qty), price = num(t.price), quoteAmount = num(t.quoteQty, qty * price);
        const feeAmount = num(t.commission),
          fq = await feeQuote(t.commissionAsset, feeAmount, a.base, price, t.time);
        const matched = orderMap.get(`${market}:${String(t.orderId)}`) ?? null;
        const fallbackPosition = matched?.position_id
          ? null
          : futuresPositionForTrade(positions, market, Number(t.time));
        const positionId = matched?.position_id ?? fallbackPosition?.id ?? null;
        if (positionId) affected.add(String(positionId));
        rows.push({
          exchange: "binance_futures",
          account_scope: "futures",
          market,
          exchange_trade_id: t.id,
          exchange_order_id: String(t.orderId),
          client_order_id: matched?.identifier ?? null,
          side: t.isBuyer ? "BUY" : "SELL",
          price,
          quantity: qty,
          quote_amount: quoteAmount,
          base_asset: a.base,
          quote_asset: a.quote,
          fee_asset: t.commissionAsset,
          fee_amount: feeAmount,
          fee_quote_amount: fq,
          is_maker: t.isMaker,
          source: matched ? "AUTOMATED" : "MANUAL",
          bot_order_id: matched?.id ?? null,
          position_id: positionId,
          realized_pnl_quote: t.realizedPnl == null ? null : num(t.realizedPnl),
          accounting_status: positionId ? "FUTURES_POSITION_LINKED" : "UNMATCHED",
          executed_at: new Date(t.time).toISOString(),
          raw_response: t as unknown as Json,
          updated_at: new Date().toISOString(),
        });
        if (maxId == null || t.id > maxId) {
          maxId = t.id;
          maxAt = new Date(t.time).toISOString();
        }
      }
      if (rows.length) {
        const u = await sb.from("exchange_trade_fills").upsert(rows, {
          onConflict: "exchange,account_scope,market,exchange_trade_id",
          ignoreDuplicates: false,
        });
        if (u.error) throw new Error(`FUTURES_FILL_UPSERT:${u.error.message}`);
        upserted += rows.length;
        for (const positionId of affected) {
          const settle = await sb.rpc("settle_futures_position_from_exchange_fills", {
            p_position_id: positionId,
          });
          if (settle.error) throw new Error(`FUTURES_SETTLE:${settle.error.message}`);
          settled++;
        }
      }
      const st = await sb.from("exchange_trade_sync_state").upsert({
        exchange: "binance_futures",
        account_scope: "futures",
        market,
        last_exchange_trade_id: maxId,
        last_trade_at: maxAt,
        last_synced_at: new Date().toISOString(),
        last_status: "SUCCESS",
        last_error: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "exchange,account_scope,market" });
      if (st.error) throw new Error(`FUTURES_STATE:${st.error.message}`);
    } catch (e) {
      errors.push({ market, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
  }
  return { markets: markets.length, seen, upserted, settled, errors };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return reply(204, {});
  if (req.method !== "POST") return reply(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  if (!SB_URL || !SB_KEY) return reply(500, { ok: false, error: "SUPABASE_ENV_MISSING" });
  if (!GW_URL || !GW_SECRET) return reply(500, { ok: false, error: "BINANCE_GATEWAY_ENV_MISSING" });

  const sb = createClient(SB_URL, SB_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: verifyError } = await sb.rpc("verify_exchange_trade_sync_token", {
    p_token: req.headers.get("x-sync-token") ?? "",
  });
  if (verifyError || verified !== true) return reply(401, { ok: false, error: "UNAUTHORIZED" });

  const owner = crypto.randomUUID();
  let lease = false, runId: string | undefined;
  try {
    const acquired = await sb.rpc("acquire_exchange_trade_sync_lease", {
      p_owner: owner,
      p_ttl_seconds: 110,
    });
    if (acquired.error) throw new Error(`LEASE:${acquired.error.message}`);
    lease = acquired.data === true;
    if (!lease) return reply(202, { ok: true, status: "SKIPPED_ALREADY_RUNNING" });

    const created = await sb.from("exchange_trade_sync_runs").insert({
      exchange: EXCHANGE,
      account_scope: SCOPE,
    }).select("id").single();
    runId = created.data?.id as string | undefined;
    if (!runId) {
      return reply(500, {
        ok: false,
        error: "RUN_LOG_CREATE_FAILED",
        detail: created.error?.message ?? null,
      });
    }

    const errors: Array<{ market: string; error: string }> = [];
    let succeeded = 0, seen = 0, upserted = 0, automated = 0, manual = 0, unmatched = 0;
    let positionsClosed = 0, fillsRelinked = 0;
    try {
      const account = await gateway({ exchange: EXCHANGE, action: "accounts" }) as {
        balances?: Array<{ asset: string; free: string; locked: string }>;
      };
      const [positionsRes, orders, statesRes, profilesRes] = await Promise.all([
        sb.from("trading_positions").select("market").eq("exchange", EXCHANGE).eq("state", "OPEN")
          .limit(500),
        loadAllOrders(sb),
        sb.from("exchange_trade_sync_state").select(
          "market,last_exchange_trade_id,last_synced_at,last_trade_at",
        ).eq("exchange", EXCHANGE).eq("account_scope", SCOPE).limit(1000),
        sb.from("lob_market_profiles").select("market").limit(1000),
      ]);
      if (positionsRes.error) throw new Error(`POSITIONS:${positionsRes.error.message}`);
      if (statesRes.error) throw new Error(`SYNC_STATE:${statesRes.error.message}`);

      const orderMap = new Map<string, BotOrder>();
      for (const o of orders) {
        if (o.exchange_order_id) orderMap.set(`${o.market}:${o.exchange_order_id}`, o);
      }

      const stateMap = new Map<string, SyncState>();
      for (const s of statesRes.data ?? []) {
        stateMap.set(String(s.market), {
          lastId: s.last_exchange_trade_id == null ? null : Number(s.last_exchange_trade_id),
          lastSynced: s.last_synced_at ? Date.parse(String(s.last_synced_at)) : 0,
          lastTradeAt: s.last_trade_at ? String(s.last_trade_at) : null,
        });
      }

      const urgent = new Set<string>(), all = new Set<string>();
      for (const p of positionsRes.data ?? []) {
        if (p.market) {
          urgent.add(String(p.market));
          all.add(String(p.market));
        }
      }
      for (const b of account?.balances ?? []) {
        if (num(b.free) + num(b.locked) > 0 && b.asset !== QUOTE) {
          urgent.add(`${b.asset}${QUOTE}`);
          all.add(`${b.asset}${QUOTE}`);
        }
      }
      for (const o of orders) if (o.market) all.add(String(o.market));
      for (const s of statesRes.data ?? []) if (s.market) all.add(String(s.market));
      for (const p of profilesRes.data ?? []) if (p.market) all.add(String(p.market));

      const candidates = [...all].filter((m) => m.endsWith(QUOTE));
      const unsynced = candidates.filter((m) => !stateMap.has(m));
      let markets: string[], selection: string;
      if (unsynced.length) {
        const chosen = new Set<string>();
        for (
          const m of candidates.filter((m) => urgent.has(m)).sort(oldestFirst(stateMap)).slice(
            0,
            URGENT_BACKFILL_SLOTS,
          )
        ) chosen.add(m);
        for (const m of unsynced.sort()) if (chosen.size < BACKFILL_BATCH) chosen.add(m);
        for (const m of candidates.sort(oldestFirst(stateMap))) {
          if (chosen.size < BACKFILL_BATCH) chosen.add(m);
        }
        markets = [...chosen];
        selection = "BACKFILL_WITH_URGENT_SLOTS";
      } else {
        markets = candidates.sort(oldestFirst(stateMap)).slice(0, MAX_FULL_SWEEP);
        selection = "FULL_ACCOUNT_SWEEP";
      }

      await sb.from("exchange_trade_sync_runs").update({
        markets_requested: markets.length,
        details: {
          selection,
          candidate_markets: candidates.length,
          unsynced_markets: unsynced.length,
          source: "binance-static-ip-gateway",
        },
      }).eq("id", runId);

      for (const market of markets) {
        try {
          const state = stateMap.get(market);
          const command: Json = {
            exchange: EXCHANGE,
            action: "trade_history",
            market,
            limit: 1000,
          };
          if (state?.lastId != null) command.from_id = state.lastId + 1;
          const raw = await gateway(command) as Trade[];
          await sleep(125);
          const trades = Array.isArray(raw) ? raw : [];
          seen += trades.length;
          let maxId = state?.lastId ?? null, maxAt = state?.lastTradeAt ?? null;
          const rows: Json[] = [], a = assets(market);

          for (const t of trades) {
            const qty = num(t.qty), price = num(t.price);
            const quoteAmount = num(t.quoteQty, qty * price), feeAmount = num(t.commission);
            const fq = await feeQuote(t.commissionAsset, feeAmount, a.base, price, t.time);
            const matched = orderMap.get(`${market}:${String(t.orderId)}`) ?? null;
            const source = matched ? "AUTOMATED" : "MANUAL";
            if (matched) automated++;
            else manual++;
            rows.push({
              exchange: EXCHANGE,
              account_scope: SCOPE,
              market,
              exchange_trade_id: t.id,
              exchange_order_id: String(t.orderId),
              client_order_id: matched?.identifier ?? null,
              side: t.isBuyer ? "BUY" : "SELL",
              price,
              quantity: qty,
              quote_amount: quoteAmount,
              base_asset: a.base,
              quote_asset: a.quote,
              fee_asset: t.commissionAsset,
              fee_amount: feeAmount,
              fee_quote_amount: fq,
              is_maker: t.isMaker,
              source,
              bot_order_id: matched?.id ?? null,
              position_id: matched?.position_id ?? null,
              executed_at: new Date(t.time).toISOString(),
              raw_response: t as unknown as Json,
              updated_at: new Date().toISOString(),
            });
            if (maxId == null || t.id > maxId) {
              maxId = t.id;
              maxAt = new Date(t.time).toISOString();
            }
          }

          if (rows.length) {
            const u = await sb.from("exchange_trade_fills").upsert(rows, {
              onConflict: "exchange,account_scope,market,exchange_trade_id",
              ignoreDuplicates: false,
            });
            if (u.error) throw new Error(`FILL_UPSERT:${u.error.message}`);
            upserted += rows.length;
            const acc = await sb.rpc("rebuild_exchange_trade_accounting", {
              p_exchange: EXCHANGE,
              p_account_scope: SCOPE,
              p_market: market,
            });
            if (acc.error) throw new Error(`ACCOUNTING:${acc.error.message}`);
            unmatched += num((acc.data as Json | null)?.unmatched);
          }

          // Settle positions from the fills we just recorded. Runs every market every
          // sweep, not only when new rows arrived, so a fill that landed unlinked in an
          // earlier run still gets re-linked and its position still gets settled.
          const recon = await sb.rpc("reconcile_positions_from_exchange_fills", {
            p_exchange: EXCHANGE,
            p_market: market,
          });
          if (recon.error) throw new Error(`RECONCILE:${recon.error.message}`);
          const reconData = (recon.data ?? {}) as Json;
          positionsClosed += num(reconData.positions_closed);
          fillsRelinked += num(reconData.fills_linked_to_orders) +
            num(reconData.fills_attributed_fifo);

          const st = await sb.from("exchange_trade_sync_state").upsert({
            exchange: EXCHANGE,
            account_scope: SCOPE,
            market,
            last_exchange_trade_id: maxId,
            last_trade_at: maxAt,
            last_synced_at: new Date().toISOString(),
            last_status: "SUCCESS",
            last_error: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: "exchange,account_scope,market" });
          if (st.error) throw new Error(`STATE_UPSERT:${st.error.message}`);
          succeeded++;
        } catch (e) {
          const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
          errors.push({ market, error: message.slice(0, 500) });
          await sb.from("exchange_trade_sync_state").upsert({
            exchange: EXCHANGE,
            account_scope: SCOPE,
            market,
            last_synced_at: new Date().toISOString(),
            last_status: "ERROR",
            last_error: message,
            updated_at: new Date().toISOString(),
          }, { onConflict: "exchange,account_scope,market" });
        }
      }

      const futuresSync = await syncFuturesTrades(sb).catch((e) => ({
        markets: 0,
        seen: 0,
        upserted: 0,
        settled: 0,
        errors: [{ market: "__FUTURES__", error: e instanceof Error ? e.message : String(e) }],
      }));
      if (futuresSync.errors.length) {
        for (const row of futuresSync.errors.slice(0, 10)) {
          errors.push({ market: `FUTURES:${row.market}`, error: row.error });
        }
      }
      let refreshed = 0;
      if (upserted > 0) {
        const refresh = await sb.rpc("refresh_real_trade_scorecards", {
          p_exchange: EXCHANGE,
          p_lookback: "8 days",
        });
        if (refresh.error) {
          errors.push({ market: "__SCORECARD__", error: refresh.error.message.slice(0, 500) });
        } else refreshed = num(refresh.data);
      }

      const status = errors.length === 0 ? "SUCCESS" : succeeded > 0 ? "PARTIAL" : "ERROR";
      await sb.from("exchange_trade_sync_runs").update({
        completed_at: new Date().toISOString(),
        status,
        markets_succeeded: succeeded,
        fills_seen: seen,
        fills_upserted: upserted,
        automated_fills: automated,
        manual_fills: manual,
        unmatched_fills: unmatched,
        error_message: errors.length
          ? errors.slice(0, 5).map((e) => `${e.market}:${e.error}`).join(" | ")
          : null,
        details: {
          errors: errors.slice(0, 25),
          scorecards_refreshed: refreshed,
          selection,
          candidate_markets: candidates.length,
          unsynced_markets: unsynced.length,
          orders_loaded: orders.length,
          positions_closed: positionsClosed,
          fills_relinked: fillsRelinked,
          futures_sync: futuresSync,
          source: "binance-static-ip-gateway",
        },
      }).eq("id", runId);

      return reply(status === "ERROR" ? 500 : 200, {
        ok: status !== "ERROR",
        status,
        run_id: runId,
        selection,
        markets_requested: markets.length,
        markets_succeeded: succeeded,
        fills_seen: seen,
        fills_upserted: upserted,
        automated_fills: automated,
        manual_fills: manual,
        unmatched_fills: unmatched,
        orders_loaded: orders.length,
        positions_closed: positionsClosed,
        fills_relinked: fillsRelinked,
        scorecards_refreshed: refreshed,
        futures_sync: futuresSync,
        errors: errors.slice(0, 10),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await sb.from("exchange_trade_sync_runs").update({
        completed_at: new Date().toISOString(),
        status: "ERROR",
        error_message: message.slice(0, 1000),
        details: { source: "binance-static-ip-gateway" },
      }).eq("id", runId);
      return reply(500, { ok: false, error: message, run_id: runId });
    }
  } finally {
    if (lease) await sb.rpc("release_exchange_trade_sync_lease", { p_owner: owner });
  }
});
