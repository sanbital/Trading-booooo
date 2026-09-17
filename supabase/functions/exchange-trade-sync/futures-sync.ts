export type FuturesMarketRow = {
  market?: unknown;
  symbol?: unknown;
  quantity?: unknown;
  positionAmt?: unknown;
  position_amount?: unknown;
};

function normalizedMarket(row: FuturesMarketRow): string {
  return String(row.market ?? row.symbol ?? "").trim().toUpperCase();
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function openPortfolioMarkets(
  positions: readonly FuturesMarketRow[],
  quote = "USDT",
): string[] {
  return positions.flatMap((row) => {
    const market = normalizedMarket(row);
    const quantity = Math.abs(finite(row.quantity ?? row.positionAmt ?? row.position_amount));
    return market.endsWith(quote) && quantity > 1e-12 ? [market] : [];
  });
}

export function futuresMarketUniverse(input: {
  portfolioPositions: readonly FuturesMarketRow[];
  orders: readonly FuturesMarketRow[];
  positions: readonly FuturesMarketRow[];
  syncStates: readonly FuturesMarketRow[];
  leaderOrders?: readonly FuturesMarketRow[];
  leaderPositions?: readonly FuturesMarketRow[];
  quote?: string;
}): string[] {
  const quote = input.quote ?? "USDT";
  return [
    ...new Set([
      ...openPortfolioMarkets(input.portfolioPositions, quote),
      ...input.orders.map(normalizedMarket),
      ...input.positions.map(normalizedMarket),
      ...input.syncStates.map(normalizedMarket),
      ...(input.leaderOrders ?? []).map(normalizedMarket),
      ...(input.leaderPositions ?? []).map(normalizedMarket),
    ].filter((market) => market.endsWith(quote))),
  ];
}

// V17 positions can open and close between full account sweeps. Their symbols must
// survive a flat portfolio even when no legacy trading_positions/orders row exists.
// These rows select collection markets ONLY; they never establish fill ownership.
//
// `state` and `closed_at` are selected as well because they decide PRIORITY: a
// position that closed after its market was last synced is the exact shape that
// loses its exit fills, so it must be collected before the long tail.
export async function readLeaderMarketRows(sb: any): Promise<{
  leaderOrders: FuturesMarketRow[]; leaderPositions: FuturesMarketRow[];
}> {
  async function pages(table: string, columns: string): Promise<FuturesMarketRow[]> {
    const rows: FuturesMarketRow[] = [], pageSize = 500;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      const r = await sb.from(table).select(columns)
        .order("id", { ascending: true }).range(offset, offset + pageSize - 1);
      if (r.error || !Array.isArray(r.data))
        throw new Error(`LEADER_MARKETS:${table}:${r.error?.message ?? "INVALID_ROWS"}`);
      rows.push(...r.data);
      if (r.data.length < pageSize) return rows;
    }
    throw new Error(`LEADER_MARKETS:${table}:PAGE_BUDGET_EXCEEDED`);
  }
  const [leaderOrders, leaderPositions] = await Promise.all([
    pages("v11_long_regime_orders", "id,symbol,state,updated_at"),
    pages("v11_long_regime_positions", "id,symbol,state,closed_at"),
  ]);
  return { leaderOrders, leaderPositions };
}

/** Order states that still owe the ledger a fill. */
const UNSETTLED_ORDER_STATES = new Set([
  "PLANNED",
  "DISPATCHED",
  "RECONCILIATION_PENDING",
  "RECONCILIATION_FAILED",
]);

export type MarketPriority = {
  markets: string[];
  /** Markets whose sync failure must fail the RUN, not just be collected. */
  required: Set<string>;
  tiers: { exposure: string[]; settlement: string[]; tail: string[] };
  selection: string;
};

/**
 * Order the futures market sweep by need, and mark which markets are mandatory.
 *
 * WHY THIS EXISTS. On 2026-09-16 the futures sweep iterated `futuresMarketUniverse()`
 * in raw Set order, unbounded, inside a one-minute invocation. With 162 markets the
 * tail never got reached: 12 markets had not synced in over six hours while
 * `cron.job_run_details` reported 120/120 successes, because per-market failures
 * were collected into `errors[]` and the function still returned ok. Three closed
 * positions (哈基米USDT, ARKUSDT, CVCUSDT) permanently lost their exit fills that
 * way -- 8.00447003 USDT that cannot be reconstructed from the database at all.
 *
 * The spot path already had this shape (urgent -> unsynced -> oldest-first,
 * bounded); the futures path never got it. This closes that gap.
 *
 * Tiers:
 *   0 EXPOSURE   - the exchange says we hold it right now.
 *   1 SETTLEMENT - a position closed since this market was last synced, an order
 *                  is still unsettled, or the market has never been synced at all.
 *   2 TAIL       - everything else, oldest-sync-first, bounded.
 *
 * Tiers 0 and 1 are REQUIRED: they are the markets whose fills we know we are
 * missing, so a failure there is a run failure rather than a log line.
 */
export function prioritizeFuturesMarkets(input: {
  universe: readonly string[];
  portfolioPositions: readonly FuturesMarketRow[];
  leaderPositions?: readonly FuturesMarketRow[];
  leaderOrders?: readonly FuturesMarketRow[];
  positions?: readonly FuturesMarketRow[];
  syncStates: readonly { market?: unknown; last_synced_at?: unknown }[];
  quote?: string;
  maxMarkets?: number;
}): MarketPriority {
  const quote = input.quote ?? "USDT";
  const maxMarkets = input.maxMarkets ?? 60;

  const lastSynced = new Map<string, number>();
  for (const s of input.syncStates ?? []) {
    const m = String(s.market ?? "");
    if (!m) continue;
    const t = s.last_synced_at ? Date.parse(String(s.last_synced_at)) : 0;
    lastSynced.set(m, Number.isFinite(t) ? t : 0);
  }

  const universe = [...new Set(input.universe)].filter((m) => m.endsWith(quote));
  const inUniverse = new Set(universe);

  const exposure = new Set<string>();
  for (const row of input.portfolioPositions ?? []) {
    const m = normalizedMarket(row);
    const q = Math.abs(finite(row.quantity ?? row.positionAmt ?? row.position_amount));
    if (m && q > 1e-12) exposure.add(m);
  }

  const settlement = new Set<string>();
  // A market we have NEVER synced cannot have had its fills collected. CVCUSDT
  // sat in exactly this state: no sync-state row, so no fills, ever.
  for (const m of universe) if (!lastSynced.has(m)) settlement.add(m);

  for (const p of input.leaderPositions ?? []) {
    const m = normalizedMarket(p);
    if (!m || !inUniverse.has(m)) continue;
    const closedAt = (p as any).closed_at ? Date.parse(String((p as any).closed_at)) : NaN;
    const state = String((p as any).state ?? "").toUpperCase();
    if (state && state !== "CLOSED") {
      settlement.add(m); // still open in our books: its fills are still arriving
    } else if (Number.isFinite(closedAt) && closedAt >= (lastSynced.get(m) ?? 0)) {
      // Closed at or after the last successful sync -> its exit fills are the
      // ones at risk of never being collected.
      settlement.add(m);
    }
  }
  for (const o of input.leaderOrders ?? []) {
    const m = normalizedMarket(o);
    if (!m || !inUniverse.has(m)) continue;
    if (UNSETTLED_ORDER_STATES.has(String((o as any).state ?? "").toUpperCase())) settlement.add(m);
  }
  for (const p of input.positions ?? []) {
    const m = normalizedMarket(p);
    if (!m || !inUniverse.has(m)) continue;
    const state = String((p as any).state ?? "").toUpperCase();
    if (state === "OPEN" || state === "EXITING") settlement.add(m);
  }

  for (const m of exposure) settlement.delete(m);

  const oldestFirst = (a: string, b: string) =>
    (lastSynced.get(a) ?? 0) - (lastSynced.get(b) ?? 0) || a.localeCompare(b);

  const tier0 = [...exposure].filter((m) => inUniverse.has(m)).sort(oldestFirst);
  const tier1 = [...settlement].sort(oldestFirst);
  const covered = new Set([...tier0, ...tier1]);
  const tier2 = universe.filter((m) => !covered.has(m)).sort(oldestFirst);

  // The required tiers are never truncated: if they alone exceed the budget the
  // tail simply does not run this cycle. Dropping a required market to make room
  // for a routine refresh is the trade that produced the missing fills.
  const required = new Set([...tier0, ...tier1]);
  const tailBudget = Math.max(0, maxMarkets - required.size);
  const markets = [...tier0, ...tier1, ...tier2.slice(0, tailBudget)];

  return {
    markets,
    required,
    tiers: { exposure: tier0, settlement: tier1, tail: tier2.slice(0, tailBudget) },
    selection: required.size >= maxMarkets ? "REQUIRED_ONLY_BUDGET_EXHAUSTED" : "PRIORITIZED_SWEEP",
  };
}

export type SyncCounters = {
  markets: number;
  succeeded: number;
  seen: number;
  upserted: number;
  automated: number;
  manual: number;
  unmatched: number;
};

export type FuturesOrderDiagnosticRequest = {
  market: string;
  orderId: string;
};

export function futuresOrderDiagnosticRequest(body: Record<string, unknown>):
  | { ok: true; value: FuturesOrderDiagnosticRequest }
  | { ok: false; error: string } {
  const market = String(body.market ?? "").trim().toUpperCase();
  const orderId = String(body.order_id ?? "").trim();
  if (!/^[A-Z0-9]{5,20}$/.test(market) || !market.endsWith("USDT")) {
    return { ok: false, error: "INVALID_FUTURES_MARKET" };
  }
  if (!/^\d{1,20}$/.test(orderId)) return { ok: false, error: "INVALID_FUTURES_ORDER_ID" };
  return { ok: true, value: { market, orderId } };
}

export function exactFuturesOrderHistory(
  rows: unknown,
  orderId: string,
): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) =>
      row && typeof row === "object" && String((row as any).orderId ?? "") === orderId
    )
    .map((row) => {
      const source = row as Record<string, unknown>;
      return {
        symbol: source.symbol ?? null,
        orderId: source.orderId ?? null,
        clientOrderId: source.clientOrderId ?? null,
        side: source.side ?? null,
        positionSide: source.positionSide ?? null,
        type: source.type ?? null,
        origType: source.origType ?? null,
        status: source.status ?? null,
        timeInForce: source.timeInForce ?? null,
        price: source.price ?? null,
        avgPrice: source.avgPrice ?? null,
        origQty: source.origQty ?? null,
        executedQty: source.executedQty ?? null,
        cumQuote: source.cumQuote ?? null,
        reduceOnly: source.reduceOnly ?? null,
        closePosition: source.closePosition ?? null,
        time: source.time ?? null,
        updateTime: source.updateTime ?? null,
      };
    });
}

export function combineSyncCounters(spot: SyncCounters, futures: SyncCounters): SyncCounters {
  return {
    markets: spot.markets + futures.markets,
    succeeded: spot.succeeded + futures.succeeded,
    seen: spot.seen + futures.seen,
    upserted: spot.upserted + futures.upserted,
    automated: spot.automated + futures.automated,
    manual: spot.manual + futures.manual,
    unmatched: spot.unmatched + futures.unmatched,
  };
}
