export type FuturesSnapshotSide = "LONG" | "SHORT";

export const FUTURES_POSITION_SNAPSHOT_REVISION = "1-DIRECTIONAL-FUTURES-POSITIONS";

export type AuthenticatedFuturesSnapshot = {
  positions: Array<Record<string, unknown>> | null;
  complete: boolean;
};

function optionalFinite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the authoritative position payload used by database zero reconciliation.
 *
 * `accounts`/`balances` is intentionally LONG-only because it emulates spot inventory.
 * Futures reconciliation therefore needs the gateway's complete signed position list.
 * One malformed row makes the whole payload non-authoritative: silently filtering a row
 * could turn a live contract into an apparent zero position.
 */
export function authenticatedFuturesSnapshot(
  exchange: string,
  portfolio: unknown,
): AuthenticatedFuturesSnapshot {
  if (exchange !== "binance_futures" || !portfolio || typeof portfolio !== "object") {
    return { positions: null, complete: false };
  }

  const raw = (portfolio as Record<string, unknown>).positions;
  if (!Array.isArray(raw)) return { positions: null, complete: false };

  const positions: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { positions: null, complete: false };
    }
    const row = item as Record<string, unknown>;
    const market = String(row.market || "").trim().toUpperCase();
    const side = String(row.side || "").trim().toUpperCase() as FuturesSnapshotSide;
    const quantity = Number(row.quantity);
    if (
      !/^[A-Z0-9]{1,24}USDT$/.test(market) ||
      (side !== "LONG" && side !== "SHORT") ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return { positions: null, complete: false };
    }
    const suppliedBaseAsset = String(row.base_asset || "").trim().toUpperCase();

    positions.push({
      market,
      base_asset: suppliedBaseAsset || market.slice(0, -4),
      side,
      quantity,
      entry_price: optionalFinite(row.entry_price),
      leverage: optionalFinite(row.leverage),
      margin_type: row.margin_type == null ? null : String(row.margin_type).toUpperCase(),
      unrealized_pnl_quote: optionalFinite(row.unrealized_pnl_quote),
      initial_margin_quote: optionalFinite(row.initial_margin_quote),
      liquidation_price: optionalFinite(row.liquidation_price),
    });
  }

  return { positions, complete: true };
}
