// Trading-booooo v6.5.1-GUARD — canonical spot-market routing and failure isolation.
//
// A gateway route is a pair, not two independent strings:
//   upbit   <-> KRW-BASE
//   binance <-> BASEUSDT
//
// The gateway has always enforced that invariant. The scanner and autotrader did not,
// which let one malformed database row reach the gateway and reject an entire monitor
// Promise.all. Keep this module free of I/O so every producer and consumer can apply the
// same check before a network request or database insert.

export type SpotExchange = "upbit" | "binance";

export type SpotMarketValidation =
  | { ok: true; exchange: SpotExchange; market: string }
  | { ok: false; exchange: string; market: string; reason: string };

const UPBIT_MARKET = /^KRW-[A-Z0-9]{2,20}$/;
const BINANCE_MARKET = /^[A-Z0-9]{2,24}USDT$/;

export function validateSpotMarket(exchange: unknown, market: unknown): SpotMarketValidation {
  const venue = typeof exchange === "string" ? exchange : String(exchange ?? "");
  const symbol = typeof market === "string" ? market : String(market ?? "");

  if (venue !== "upbit" && venue !== "binance") {
    return {
      ok: false,
      exchange: venue,
      market: symbol,
      reason: `unsupported spot exchange "${venue || "(empty)"}"`,
    };
  }
  if (symbol !== symbol.trim() || symbol !== symbol.toUpperCase()) {
    return {
      ok: false,
      exchange: venue,
      market: symbol,
      reason: `${venue} market is not canonical uppercase text`,
    };
  }

  const valid = venue === "upbit" ? UPBIT_MARKET.test(symbol) : BINANCE_MARKET.test(symbol);
  if (!valid) {
    return {
      ok: false,
      exchange: venue,
      market: symbol,
      reason: venue === "upbit"
        ? `upbit market "${symbol || "(empty)"}" must match KRW-BASE`
        : `binance market "${symbol || "(empty)"}" must match BASEUSDT`,
    };
  }
  return { ok: true, exchange: venue, market: symbol };
}

export type SettledSpotMarketRead<T, Q> =
  | {
    ok: true;
    item: T;
    exchange: SpotExchange;
    market: string;
    value: Q;
  }
  | {
    ok: false;
    item: T;
    error: string;
  };

/**
 * Run independent spot-market reads without allowing one bad row or one failed venue call
 * to reject the whole batch. Promise.allSettled is intentional: monitor safety depends on
 * every healthy position still reaching its exit logic when a neighbour cannot be quoted.
 */
export async function settleSpotMarketReads<
  T extends { exchange: unknown; market: unknown },
  Q,
>(
  items: T[],
  read: (exchange: SpotExchange, market: string, item: T) => Promise<Q>,
): Promise<Array<SettledSpotMarketRead<T, Q>>> {
  const pending = items.map(async (item) => {
    const route = validateSpotMarket(item.exchange, item.market);
    if (!route.ok) throw new Error(route.reason);
    const value = await read(route.exchange, route.market, item);
    return { item, exchange: route.exchange, market: route.market, value };
  });
  const settled = await Promise.allSettled(pending);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return { ok: true, ...result.value };
    return {
      ok: false,
      item: items[index],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}
