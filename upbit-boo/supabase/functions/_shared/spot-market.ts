// Trading-booooo v6.5.2-GUARD — canonical spot-market routing and failure isolation.
//
// A gateway route is a pair, not two independent strings:
//   upbit           <-> KRW-BASE
//   binance         <-> BASEUSDT   (spot)
//   binance_futures <-> BASEUSDT   (USDⓈ-M perpetual)
//
// The two Binance venues share a symbol grammar and nothing else: they are separate
// hosts, separate wallets and separate positions, so the routing pair still has to be
// carried around as a pair.
//
// The gateway has always enforced that invariant. The scanner and autotrader did not,
// which let one malformed database row reach the gateway and reject an entire monitor
// Promise.all. Keep this module free of I/O so every producer and consumer can apply the
// same check before a network request or database insert.

export type SpotExchange = "upbit" | "binance" | "binance_futures";

const SPOT_EXCHANGES: readonly string[] = ["upbit", "binance", "binance_futures"];

export type SpotMarketValidation =
  | { ok: true; exchange: SpotExchange; market: string }
  | { ok: false; exchange: string; market: string; reason: string };

// Single-character base assets are valid exchange symbols (for example KRW-A / KRW-T).
// Require at least one base character while retaining uppercase alphanumeric routing only.
const UPBIT_MARKET = /^KRW-[A-Z0-9]{1,20}$/;
const BINANCE_MARKET = /^[A-Z0-9]{1,24}USDT$/;

export function validateSpotMarket(exchange: unknown, market: unknown): SpotMarketValidation {
  const venue = typeof exchange === "string" ? exchange : String(exchange ?? "");
  const symbol = typeof market === "string" ? market : String(market ?? "");

  if (!SPOT_EXCHANGES.includes(venue)) {
    return {
      ok: false,
      exchange: venue,
      market: symbol,
      reason: `unsupported exchange "${venue || "(empty)"}"`,
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
  const canonicalVenue = venue as SpotExchange;
  if (!valid) {
    return {
      ok: false,
      exchange: venue,
      market: symbol,
      reason: venue === "upbit"
        ? `upbit market "${symbol || "(empty)"}" must match KRW-BASE`
        : `${venue} market "${symbol || "(empty)"}" must match BASEUSDT`,
    };
  }
  return { ok: true, exchange: canonicalVenue, market: symbol };
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
