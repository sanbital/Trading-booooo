// Trading-booooo v7.5.2 — position value reconciliation against the real account.
//
// Two operator-reported defects produced this module.
//
//   1. A manually sold coin (binance:BICO) kept showing in "현재 포지션" and in the trade
//      list because the ledger still carried `remaining_quantity`. The bot's own account
//      reconciliation only reacts after three consecutive mismatch observations, so the
//      dashboard kept displaying a holding that no longer exists.
//   2. Manual sells never reached "거래소별 누적 성과": `manualReconcileAccounting` books
//      `realized_pnl_quote = 0`, and the performance API trusts that zero for CLOSED rows.
//
// Both are answered by the same question — how much of this position does the exchange
// actually still hold, and is what is left worth anything? The operator's rule for the
// second half is absolute: anything worth a dollar or less is not a position.

export type Exchange = "upbit" | "binance" | "binance_futures";

/**
 * "1달러 이하는 그냥 없는 포지션으로 간주" — the operator's rule, expressed in each
 * exchange's quote currency. The KRW figure is the round-number equivalent of USD 1.
 */
export const POSITION_DUST_QUOTE: Record<Exchange, number> = {
  upbit: 1400,
  binance: 1,
  binance_futures: 1,
};

/**
 * A balance snapshot older than this cannot be used to declare a holding gone. When the
 * gateway is down the snapshot freezes, and a frozen snapshot must never be read as
 * "the coin left the account".
 */
export const BALANCE_SNAPSHOT_MAX_AGE_MS = 600_000;

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function dustQuoteFor(exchange: string): number {
  return exchange === "upbit" ? POSITION_DUST_QUOTE.upbit : POSITION_DUST_QUOTE.binance;
}

export function baseAssetOf(
  exchange: string,
  market: string,
  fallback?: string | null,
): string {
  const explicit = String(fallback || "").toUpperCase();
  if (explicit) return explicit;
  const normalized = String(market || "").toUpperCase();
  if (exchange === "upbit") return normalized.split("-")[1] || normalized;
  return normalized.endsWith("USDT") ? normalized.slice(0, -4) : normalized;
}

/**
 * `trading_account_snapshots.balances` is the gateway portfolio row list. Free and locked
 * are summed on purpose: a resting take-profit the bot placed itself locks the base asset,
 * and that is still our coin.
 */
export function snapshotBalanceMap(balances: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(balances)) return map;
  for (const row of balances) {
    const asset = String(row?.currency ?? row?.asset ?? "").toUpperCase();
    if (!asset) continue;
    const total = Math.max(0, finite(row?.balance ?? row?.free)) + Math.max(0, finite(row?.locked));
    map.set(asset, (map.get(asset) || 0) + total);
  }
  return map;
}

export function snapshotIsUsable(
  snapshot: { captured_at?: unknown; balances?: unknown } | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = BALANCE_SNAPSHOT_MAX_AGE_MS,
): boolean {
  if (!snapshot) return false;
  if (!Array.isArray(snapshot.balances) || snapshot.balances.length === 0) return false;
  const capturedAt = Date.parse(String(snapshot.captured_at || ""));
  if (!Number.isFinite(capturedAt)) return false;
  return nowMs - capturedAt <= maxAgeMs;
}

/**
 * Hands out the observed exchange balance to the ledger rows that claim it. Several open
 * positions can share one base asset; each one may only claim what is still unassigned,
 * so a single balance can never be counted twice.
 */
export function createBalanceAllocator(balances: Map<string, number>) {
  const unassigned = new Map(balances);
  return (asset: string, requested: number): number => {
    const key = String(asset || "").toUpperCase();
    if (!key) return 0;
    const available = Math.max(0, unassigned.get(key) || 0);
    const granted = Math.min(Math.max(0, finite(requested)), available);
    unassigned.set(key, available - granted);
    return granted;
  };
}

export interface HoldingInput {
  /** Quantity the position ledger still claims. */
  ledgerQuantity: number;
  /** Quantity the exchange actually reports for this position, or null when unknown. */
  exchangeQuantity: number | null;
  /** Mark price in the quote currency. */
  price: number;
  /** Value below which a holding is not a position. */
  dustQuote: number;
}

export interface Holding {
  ledgerQuantity: number;
  /** What the account can actually deliver for this position. */
  effectiveQuantity: number;
  /** Ledger quantity that is no longer in the account — a manual sell or withdrawal. */
  missingQuantity: number;
  effectiveValueQuote: number;
  /** True when nothing worth keeping is left; the row must not be shown as a position. */
  isDust: boolean;
  /** True when a fresh balance snapshot backed the comparison. */
  balanceKnown: boolean;
  /** True when the exchange is short of the ledger beyond rounding. */
  vanished: boolean;
}

export function resolveHolding(input: HoldingInput): Holding {
  const ledger = Math.max(0, finite(input.ledgerQuantity));
  const price = Math.max(0, finite(input.price));
  const dust = Math.max(0, finite(input.dustQuote));
  const balanceKnown = input.exchangeQuantity !== null && input.exchangeQuantity !== undefined;
  const effective = balanceKnown
    ? Math.min(ledger, Math.max(0, finite(input.exchangeQuantity)))
    : ledger;
  const missing = Math.max(0, ledger - effective);
  const value = effective * price;
  return {
    ledgerQuantity: ledger,
    effectiveQuantity: effective,
    missingQuantity: missing,
    effectiveValueQuote: value,
    // A position with no usable price cannot be judged worthless; only a priced holding
    // can fall below the dust floor.
    isDust: price > 0 && value < dust,
    balanceKnown,
    vanished: balanceKnown && missing > Math.max(1e-12, ledger * 1e-7),
  };
}

export interface ManualExitInput {
  /** Quantity that left the account outside the bot's own orders. */
  missingQuantity: number;
  markPrice: number;
  /** Per-side fee rate as a percentage, e.g. 0.1 for Binance. */
  feePctPerSide: number;
  /**
   * Gross value already recorded by the engine at detection time. When present it wins
   * over quantity × price, because it was marked when the coin actually left rather than
   * at whatever the price happens to be now.
   */
  grossProceedsQuote?: number | null;
}

export interface ManualExitEstimate {
  grossProceedsQuote: number;
  feeQuote: number;
  netProceedsQuote: number;
  basis: "MARK_PRICE_LESS_TAKER_FEE";
}

/**
 * A manual sell leaves no fill record for us to read, so its proceeds can only be
 * estimated. Marking the missing quantity at the last observed price less one taker fee
 * is the closest honest reconstruction; it is labelled as an estimate everywhere it
 * surfaces so it is never mistaken for a verified fill.
 */
export function estimateManualExit(input: ManualExitInput): ManualExitEstimate {
  const quantity = Math.max(0, finite(input.missingQuantity));
  const price = Math.max(0, finite(input.markPrice));
  const recorded = Math.max(0, finite(input.grossProceedsQuote));
  const gross = recorded > 0 ? recorded : quantity * price;
  const fee = gross * Math.max(0, finite(input.feePctPerSide)) / 100;
  return {
    grossProceedsQuote: gross,
    feeQuote: fee,
    netProceedsQuote: Math.max(0, gross - fee),
    basis: "MARK_PRICE_LESS_TAKER_FEE",
  };
}
