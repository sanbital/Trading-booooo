type P10DurableExitEvidence = {
  rows: readonly unknown[];
  summary: {
    valid: boolean;
    reason: string | null;
  };
};

type P10DurableFirstOptions<TDurable extends P10DurableExitEvidence, TApplied, TOrderPayload> = {
  loadDurableFills: () => Promise<TDurable>;
  canApplyDurableFills?: (durable: TDurable) => boolean;
  applyDurableFills: (durable: TDurable) => Promise<TApplied>;
  lookupOrder: () => Promise<TOrderPayload>;
};

export type P10DurableFirstResult<TApplied, TOrderPayload> =
  | {
    source: "DURABLE_FILLS";
    applied: TApplied;
  }
  | {
    source: "ORDER_LOOKUP";
    payload: TOrderPayload;
  };

const P10_TERMINAL_PARTIAL_ORDER_STATES = new Set([
  "CANCELED",
  "CANCELLED",
  "DONE",
  "EXCHANGE_CANCELLED",
  "EXCHANGE_DONE",
  "EXCHANGE_PARTIAL_CANCELLED",
  "FILLED",
  "PARTIALLY_FILLED_CANCELED",
]);

const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * A full requested quantity is self-completing. A smaller aggregate needs an already
 * persisted terminal order quantity; otherwise more trade rows may still arrive.
 */
export function p10DurableExitQuantityComplete(input: {
  durableExecutedVolume: unknown;
  requestedVolume: unknown;
  persistedExecutedVolume: unknown;
  orderState: unknown;
  quantityStep?: unknown;
}): boolean {
  const durable = Math.max(0, finite(input.durableExecutedVolume));
  const requested = Math.max(0, finite(input.requestedVolume));
  const persisted = Math.max(0, finite(input.persistedExecutedVolume));
  const toleranceFor = (expected: number) =>
    Math.max(
      0.0000000001,
      Math.abs(expected) * 0.0000001,
      Math.max(0, finite(input.quantityStep)) * 0.5,
    );
  if (durable > 0 && requested > 0 && Math.abs(durable - requested) <= toleranceFor(requested)) {
    return true;
  }
  return durable > 0 && persisted > 0 &&
    P10_TERMINAL_PARTIAL_ORDER_STATES.has(String(input.orderState || "").toUpperCase()) &&
    Math.abs(durable - persisted) <= toleranceFor(persisted);
}

/**
 * Durable trade fills are local settlement evidence and must be consumed before a
 * fallible exchange-order lookup. Invalid linked evidence fails closed rather than
 * falling through to a gateway response that could hide a lineage error.
 */
export async function settleP10ExitBeforeOrderLookup<
  TDurable extends P10DurableExitEvidence,
  TApplied,
  TOrderPayload,
>(
  options: P10DurableFirstOptions<TDurable, TApplied, TOrderPayload>,
): Promise<P10DurableFirstResult<TApplied, TOrderPayload>> {
  const durable = await options.loadDurableFills();
  if (durable.rows.length) {
    if (!durable.summary.valid) {
      throw new Error(durable.summary.reason || "linked exit fills are invalid");
    }
    if (!options.canApplyDurableFills || options.canApplyDurableFills(durable)) {
      return {
        source: "DURABLE_FILLS",
        applied: await options.applyDurableFills(durable),
      };
    }
  }
  return {
    source: "ORDER_LOOKUP",
    payload: await options.lookupOrder(),
  };
}
