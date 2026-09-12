// Trading-booooo v7.5.2 — what "현재 포지션" may show.
//
// The ledger and the account disagree whenever the operator sells by hand: the coin is
// gone but `remaining_quantity` survives until the reconciliation loop has confirmed the
// mismatch three cycles running. Until then the dashboard displayed a holding that does
// not exist (binance:BICO, 2026-08-06). The newest balance snapshot settles it here, and
// the operator's own rule finishes the job — anything worth a dollar or less is not a
// position.
//
// A stale or unreadable snapshot yields no allocator and every row keeps its ledger
// quantity: a gateway outage must never blank the position table.

import {
  baseAssetOf,
  createBalanceAllocator,
  dustQuoteFor,
  type Exchange,
  resolveHolding,
  snapshotBalanceMap,
  snapshotIsUsable,
} from "../_shared/position-value.ts";

type JsonRecord = Record<string, any>;

export const POSITION_DISPLAY_REVISION = "7.5.2-DUST-AND-MANUAL-EXIT";

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export interface SettledPositionRow extends JsonRecord {
  reason: "MANUAL_SELL_RECONCILED" | "DUST_BELOW_MIN_VALUE";
}

export interface DisplayPositionResult {
  positions: JsonRecord[];
  /** Rows the ledger still carries but the account no longer backs. Reported, not hidden. */
  settled: SettledPositionRow[];
  rule: JsonRecord;
}

export function resolveDisplayPositions(
  rows: JsonRecord[],
  snapshots: JsonRecord[],
  nowMs = Date.now(),
): DisplayPositionResult {
  const latestByExchange = new Map<Exchange, JsonRecord>();
  for (const snapshot of snapshots || []) {
    const exchange = String(snapshot?.exchange || "") as Exchange;
    if ((exchange === "upbit" || exchange === "binance") && !latestByExchange.has(exchange)) {
      latestByExchange.set(exchange, snapshot);
    }
  }
  const allocators = new Map<Exchange, ReturnType<typeof createBalanceAllocator>>();
  for (const [exchange, snapshot] of latestByExchange) {
    if (!snapshotIsUsable(snapshot, nowMs)) continue;
    allocators.set(exchange, createBalanceAllocator(snapshotBalanceMap(snapshot.balances)));
  }

  const tracked = (rows || []).filter((row) =>
    row.state === "ENTRY_PENDING" || finite(row.remaining_quantity) > 0 ||
    finite(row.reserved_quote) > 0
  );
  // Oldest first, so the oldest claim on a shared base asset is served first.
  const ordered = [...tracked].sort((left, right) =>
    new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime()
  );
  const settled: SettledPositionRow[] = [];
  const dropped = new Set<string>();
  for (const row of ordered) {
    // A reservation is quote currency we have committed, not a base-asset holding, so a
    // pending entry is never judged by the balance comparison.
    if (row.state === "ENTRY_PENDING" || finite(row.reserved_quote) > 0) continue;
    const exchange = row.exchange as Exchange;
    const snapshot = latestByExchange.get(exchange);
    const allocate = allocators.get(exchange);
    // A price from a snapshot we already rejected as stale must not decide that a
    // position is worthless. The position's own cost basis is the conservative fallback:
    // every entry clears the exchange minimum, so only a genuinely tiny remainder can
    // fall under the floor on that basis.
    const price = Math.max(
      0,
      allocate
        ? finite(snapshot?.prices?.[row.market], finite(row.average_entry_price))
        : finite(row.average_entry_price),
    );
    const ledgerQuantity = finite(row.remaining_quantity);
    const holding = resolveHolding({
      ledgerQuantity,
      exchangeQuantity: allocate
        ? allocate(baseAssetOf(exchange, row.market, row.base_asset), ledgerQuantity)
        : null,
      price,
      dustQuote: dustQuoteFor(exchange),
    });
    if (!holding.isDust) continue;
    dropped.add(String(row.id));
    settled.push({
      id: row.id,
      exchange: row.exchange,
      market: row.market,
      state: row.state,
      ledger_quantity: holding.ledgerQuantity,
      account_quantity: holding.effectiveQuantity,
      missing_quantity: holding.missingQuantity,
      value_quote: holding.effectiveValueQuote,
      dust_threshold_quote: dustQuoteFor(exchange),
      balance_verified: holding.balanceKnown,
      reason: holding.vanished ? "MANUAL_SELL_RECONCILED" : "DUST_BELOW_MIN_VALUE",
      balance_snapshot_at: snapshot?.captured_at || null,
    });
  }

  return {
    positions: tracked.filter((row) => !dropped.has(String(row.id))),
    settled,
    rule: {
      revision: POSITION_DISPLAY_REVISION,
      dust_threshold_quote: { upbit: dustQuoteFor("upbit"), binance: dustQuoteFor("binance") },
      balance_readable: {
        upbit: allocators.has("upbit"),
        binance: allocators.has("binance"),
      },
      description:
        "평가액 1달러(업비트 1,400원) 미만이거나 거래소 잔고가 없는 행은 포지션이 아닙니다",
    },
  };
}
