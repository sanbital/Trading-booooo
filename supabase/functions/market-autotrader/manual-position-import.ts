// Trading-booooo v7.5.2 r2 — display-only import of exchange-side manual buys.
//
// Manual holdings deliberately never become `trading_positions` rows. Persisting them in
// that table would put them inside the monitor, exit, rate-limit and learning queries. The
// status endpoint instead derives the unassigned part of each fresh exchange balance after
// subtracting live bot positions and residual inventory. The resulting rows have the same
// display shape as a position, but are explicitly read-only and cannot be traded by the bot.

import {
  baseAssetOf,
  dustQuoteFor,
  type Exchange,
  snapshotBalanceMap,
  snapshotIsUsable,
} from "../_shared/position-value.ts";

type JsonRecord = Record<string, any>;

export const MANUAL_POSITION_IMPORT_REVISION = "7.5.2-r2-MANUAL-BUY-IMPORT";

function finite(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function marketOf(exchange: Exchange, asset: string): string {
  return exchange === "upbit" ? `KRW-${asset}` : `${asset}USDT`;
}

function quoteAssetOf(exchange: Exchange): "KRW" | "USDT" {
  return exchange === "upbit" ? "KRW" : "USDT";
}

function claimKey(exchange: Exchange, asset: string): string {
  return `${exchange}:${String(asset || "").toUpperCase()}`;
}

interface ManualFillInventory {
  quantity: number;
  costQuote: number;
  firstBuyAt: string | null;
  lastBuyAt: string | null;
  fillCount: number;
}

/**
 * Reconstruct the remaining cost basis of fills that the exchange identified as manual.
 * A sell removes inventory at the current weighted-average cost. This is display metadata
 * only; realized strategy performance never consumes it.
 */
export function manualFillInventory(
  fills: JsonRecord[],
): Map<string, ManualFillInventory> {
  const result = new Map<string, ManualFillInventory>();
  const ordered = [...(fills || [])].sort((left, right) => {
    const time = Date.parse(String(left?.executed_at || "")) -
      Date.parse(String(right?.executed_at || ""));
    if (Number.isFinite(time) && time !== 0) return time;
    return finite(left?.exchange_trade_id) - finite(right?.exchange_trade_id);
  });

  for (const fill of ordered) {
    if (String(fill?.source || "").toUpperCase() !== "MANUAL" || fill?.position_id) continue;
    const exchange = String(fill?.exchange || "") as Exchange;
    if (exchange !== "upbit" && exchange !== "binance") continue;
    const market = String(fill?.market || "").toUpperCase();
    if (!market) continue;
    const key = `${exchange}:${market}`;
    const inventory = result.get(key) || {
      quantity: 0,
      costQuote: 0,
      firstBuyAt: null,
      lastBuyAt: null,
      fillCount: 0,
    };
    const side = String(fill?.side || "").toUpperCase();
    const quantity = Math.max(0, finite(fill?.quantity));
    const baseAsset = String(fill?.base_asset || baseAssetOf(exchange, market)).toUpperCase();
    const feeAsset = String(fill?.fee_asset || "").toUpperCase();
    const feeAmount = Math.max(0, finite(fill?.fee_amount));
    const feeQuote = Math.max(0, finite(fill?.fee_quote_amount));

    if (side === "BUY" && quantity > 0) {
      const baseFee = feeAsset !== "" && feeAsset === baseAsset;
      const received = Math.max(0, quantity - (baseFee ? feeAmount : 0));
      if (!(received > 0)) continue;
      const quoteAmount = Math.max(
        0,
        finite(fill?.quote_amount, finite(fill?.price) * quantity),
      );
      inventory.quantity += received;
      inventory.costQuote += quoteAmount + (baseFee ? 0 : feeQuote);
      const executedAt = String(fill?.executed_at || "") || null;
      inventory.firstBuyAt ||= executedAt;
      inventory.lastBuyAt = executedAt;
      inventory.fillCount++;
    } else if (side === "SELL" && quantity > 0 && inventory.quantity > 0) {
      const sold = Math.min(quantity, inventory.quantity);
      const averageCost = inventory.costQuote / inventory.quantity;
      inventory.quantity = Math.max(0, inventory.quantity - sold);
      inventory.costQuote = Math.max(0, inventory.costQuote - averageCost * sold);
      inventory.fillCount++;
      if (inventory.quantity <= 1e-12) {
        inventory.quantity = 0;
        inventory.costQuote = 0;
      }
    }
    result.set(key, inventory);
  }
  return result;
}

export interface ResolveManualPositionsInput {
  trackedPositions: JsonRecord[];
  snapshots: JsonRecord[];
  residualInventory?: JsonRecord[];
  manualFills?: JsonRecord[];
  nowMs?: number;
}

export interface ManualPositionImportResult {
  positions: JsonRecord[];
  rule: JsonRecord;
}

export function resolveManualPositions(
  input: ResolveManualPositionsInput,
): ManualPositionImportResult {
  const nowMs = input.nowMs ?? Date.now();
  const latestByExchange = new Map<Exchange, JsonRecord>();
  for (const snapshot of input.snapshots || []) {
    const exchange = String(snapshot?.exchange || "") as Exchange;
    if (
      (exchange === "upbit" || exchange === "binance") &&
      !latestByExchange.has(exchange) && snapshotIsUsable(snapshot, nowMs)
    ) latestByExchange.set(exchange, snapshot);
  }

  const claimed = new Map<string, number>();
  const pendingAssets = new Set<string>();
  for (const row of input.trackedPositions || []) {
    if (row?.is_paper === true) continue;
    const exchange = String(row?.exchange || "") as Exchange;
    if (exchange !== "upbit" && exchange !== "binance") continue;
    const asset = baseAssetOf(exchange, String(row?.market || ""), row?.base_asset);
    const key = claimKey(exchange, asset);
    claimed.set(key, (claimed.get(key) || 0) + Math.max(0, finite(row?.remaining_quantity)));
    if (String(row?.state || "") === "ENTRY_PENDING" || finite(row?.reserved_quote) > 0) {
      pendingAssets.add(key);
    }
  }
  for (const row of input.residualInventory || []) {
    const exchange = String(row?.exchange || "") as Exchange;
    if (exchange !== "upbit" && exchange !== "binance") continue;
    const asset = baseAssetOf(exchange, String(row?.market || ""), row?.asset);
    const key = claimKey(exchange, asset);
    claimed.set(key, (claimed.get(key) || 0) + Math.max(0, finite(row?.remaining_quantity)));
  }

  const fillInventory = manualFillInventory(input.manualFills || []);
  const positions: JsonRecord[] = [];
  for (const [exchange, snapshot] of latestByExchange) {
    const quoteAsset = quoteAssetOf(exchange);
    const balances = snapshotBalanceMap(snapshot?.balances);
    const accountRows = new Map<string, JsonRecord>();
    for (const row of Array.isArray(snapshot?.balances) ? snapshot.balances : []) {
      const asset = String(row?.currency ?? row?.asset ?? "").toUpperCase();
      if (asset) accountRows.set(asset, row);
    }

    for (const [asset, totalQuantity] of balances) {
      if (!asset || asset === quoteAsset) continue;
      const key = claimKey(exchange, asset);
      if (pendingAssets.has(key)) continue;
      const trackedQuantity = Math.max(0, claimed.get(key) || 0);
      const quantity = Math.max(0, totalQuantity - trackedQuantity);
      if (!(quantity > 1e-12)) continue;

      const market = marketOf(exchange, asset);
      const accountRow = accountRows.get(asset) || {};
      const accountAverage = exchange === "upbit"
        ? Math.max(0, finite(accountRow?.avg_buy_price))
        : 0;
      const price = Math.max(0, finite(snapshot?.prices?.[market], accountAverage));
      const valueQuote = price > 0 ? quantity * price : null;
      if (valueQuote !== null && valueQuote < dustQuoteFor(exchange)) continue;

      const inventory = fillInventory.get(`${exchange}:${market}`) || null;
      const fillAverage = inventory && inventory.quantity > 0
        ? inventory.costQuote / inventory.quantity
        : 0;
      const averageEntryPrice = fillAverage > 0
        ? fillAverage
        : accountAverage > 0
        ? accountAverage
        : null;
      const fillCoverage = inventory && quantity > 0
        ? Math.min(1, inventory.quantity / quantity)
        : 0;
      const costBasisSource = fillAverage > 0
        ? (fillCoverage >= 0.95 ? "MANUAL_FILL_LEDGER" : "PARTIAL_MANUAL_FILL_LEDGER")
        : accountAverage > 0
        ? "EXCHANGE_ACCOUNT_AVERAGE"
        : "UNASSIGNED_ACCOUNT_BALANCE";
      const capturedAt = String(snapshot?.captured_at || new Date(nowMs).toISOString());

      positions.push({
        id: `manual:${exchange}:${market}`,
        exchange,
        quote_currency: quoteAsset,
        market,
        base_asset: asset,
        state: "MANUAL",
        is_paper: false,
        is_manual: true,
        source: "MANUAL",
        management_scope: "DISPLAY_ONLY",
        initial_quantity: quantity,
        remaining_quantity: quantity,
        reserved_quote: 0,
        reserved_quantity: 0,
        average_entry_price: averageEntryPrice,
        planned_entry_price: averageEntryPrice,
        stop_price: null,
        target_1: null,
        target_2: null,
        max_holding_at: null,
        created_at: inventory?.firstBuyAt || capturedAt,
        updated_at: capturedAt,
        metadata: {
          exclude_from_learning: true,
          auto_exit_enabled: false,
          manual_import: {
            revision: MANUAL_POSITION_IMPORT_REVISION,
            import_basis: "UNASSIGNED_EXCHANGE_BALANCE",
            cost_basis_source: costBasisSource,
            account_quantity: totalQuantity,
            tracked_quantity: trackedQuantity,
            imported_quantity: quantity,
            mark_price: price || null,
            value_quote: valueQuote,
            manual_fill_quantity: inventory?.quantity || 0,
            manual_fill_count: inventory?.fillCount || 0,
            manual_fill_coverage: fillCoverage,
            last_manual_buy_at: inventory?.lastBuyAt || null,
            balance_snapshot_at: capturedAt,
          },
        },
      });
    }
  }

  return {
    positions: positions.sort((left, right) =>
      String(left.exchange).localeCompare(String(right.exchange)) ||
      String(left.market).localeCompare(String(right.market))
    ),
    rule: {
      revision: MANUAL_POSITION_IMPORT_REVISION,
      mode: "DISPLAY_ONLY",
      excludes: ["AUTOMATIC_EXIT", "ENTRY_LIMITS", "PERFORMANCE", "LEARNING"],
      description: "거래소 잔고에서 봇 포지션과 잔여재고를 뺀 보유분만 수동 포지션으로 표시합니다",
    },
  };
}
