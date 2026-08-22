// Trading-booooo — the SCAN gate and the order engine must price a new slot identically.
//
// The order path was already correct: `p10ExactFuturesTicketCapital` posts exactly the
// operator's configured margin (200 USDT at 3x ≈ 600 USDT notional) and returns 0 when the
// wallet cannot fund it. The SCAN circuit, however, compared available margin against
// `FUTURES_MIN_ENTRY_MARGIN_USDT` — the venue's floor, not this strategy's ticket — so with
// 105 USDT of free margin against a 200 USDT ticket it still published allowNewEntry=true
// and advertised a slot no order could ever fill.
//
// This module holds the shared predicate. It takes the ticket capital from the same helper
// the engine sizes with, so the two can never drift apart again.

export interface EntryMarginGateInput {
  /** Margin the venue reports as usable, after the managed-capital allocation. */
  availableQuote: number;
  /** Margin one new slot needs, from the engine's own sizing helper. */
  requiredQuote: number;
  /** Extra headroom the engine applies on top of the ticket, if any. */
  bufferQuote?: number;
  openPositions: number;
  maxPositions: number;
}

export interface EntryMarginGate {
  allowed: boolean;
  availableQuote: number;
  requiredQuote: number;
  /** requiredQuote + buffer: what the wallet actually has to show. */
  requiredAvailableQuote: number;
  shortfallQuote: number;
  freeSlots: number;
  reason: string | null;
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const INSUFFICIENT_FUTURES_MARGIN_REASON =
  "insufficient available margin for next futures slot";
export const NO_FREE_SLOT_REASON = "maximum open positions reached";

export function evaluateEntryMarginGate(input: EntryMarginGateInput): EntryMarginGate {
  const available = Math.max(0, finite(input.availableQuote));
  const required = Math.max(0, finite(input.requiredQuote));
  const buffer = Math.max(0, finite(input.bufferQuote));
  const requiredAvailable = required + buffer;
  const open = Math.max(0, Math.floor(finite(input.openPositions)));
  const max = Math.max(0, Math.floor(finite(input.maxPositions)));
  const freeSlots = Math.max(0, max - open);
  // Rounding on the venue side must never turn a wallet that is one satoshi short into a
  // permitted entry, so the comparison keeps only float tolerance.
  const funded = requiredAvailable > 0 && available + 1e-9 >= requiredAvailable;
  const reason = freeSlots <= 0
    ? NO_FREE_SLOT_REASON
    : funded
    ? null
    : INSUFFICIENT_FUTURES_MARGIN_REASON;
  return {
    allowed: reason === null,
    availableQuote: available,
    requiredQuote: required,
    requiredAvailableQuote: requiredAvailable,
    shortfallQuote: Math.max(0, requiredAvailable - available),
    freeSlots,
    reason,
  };
}
