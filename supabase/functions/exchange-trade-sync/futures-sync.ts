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
export async function readLeaderMarketRows(sb: any): Promise<{
  leaderOrders: FuturesMarketRow[]; leaderPositions: FuturesMarketRow[];
}> {
  async function pages(table: string): Promise<FuturesMarketRow[]> {
    const rows: FuturesMarketRow[] = [], pageSize = 500;
    for (let offset = 0; offset < 500000; offset += pageSize) {
      const r = await sb.from(table).select("id,symbol")
        .order("id", { ascending: true }).range(offset, offset + pageSize - 1);
      if (r.error || !Array.isArray(r.data))
        throw new Error(`LEADER_MARKETS:${table}:${r.error?.message ?? "INVALID_ROWS"}`);
      rows.push(...r.data);
      if (r.data.length < pageSize) return rows;
    }
    throw new Error(`LEADER_MARKETS:${table}:PAGE_BUDGET_EXCEEDED`);
  }
  const [leaderOrders, leaderPositions] = await Promise.all([
    pages("v11_long_regime_orders"), pages("v11_long_regime_positions"),
  ]);
  return { leaderOrders, leaderPositions };
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
