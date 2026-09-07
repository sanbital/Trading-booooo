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
  quote?: string;
}): string[] {
  const quote = input.quote ?? "USDT";
  return [
    ...new Set([
      ...openPortfolioMarkets(input.portfolioPositions, quote),
      ...input.orders.map(normalizedMarket),
      ...input.positions.map(normalizedMarket),
      ...input.syncStates.map(normalizedMarket),
    ].filter((market) => market.endsWith(quote))),
  ];
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
