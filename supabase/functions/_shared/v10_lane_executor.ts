export interface GatewayFill {
  status: string;
  exchangeOrderId: string | null;
  executedQuantity: number;
  averagePrice: number;
  executedNotional: number;
  paidFeeQuote: number;
  raw: unknown;
}

export function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function floorToStep(value: number, step: number): number {
  if (!(value > 0) || !(step > 0)) return 0;
  const precision = Math.min(12, Math.max(0, Math.ceil(-Math.log10(step)) + 2));
  return Number((Math.floor((value + step * 1e-9) / step) * step).toFixed(precision));
}

export function v10ClientOrderId(prefix: "v10e" | "v10x", identity: string): string {
  const compact = identity.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `tb-${prefix}-${compact.slice(0, 24)}`.slice(0, 36);
}

export function parseGatewayFill(payload: any): GatewayFill {
  const order = payload?.order ?? payload ?? {};
  const fill = payload?.fill ?? {};
  const executedQuantity = Math.max(
    0,
    finite(fill.executedVolume ?? fill.executed_quantity ?? order.executed_volume ?? order.executedQty),
  );
  const averagePrice = Math.max(
    0,
    finite(fill.averagePrice ?? fill.average_price ?? order.average_price ?? order.avgPrice),
  );
  const executedNotional = Math.max(
    0,
    finite(
      fill.executedFunds ?? fill.executed_funds ?? order.executed_funds,
      executedQuantity * averagePrice,
    ),
  );
  return {
    status: String(order?.status ?? payload?.status ?? "UNKNOWN").toUpperCase(),
    exchangeOrderId: order?.exchange_order_id == null
      ? (order?.orderId == null ? null : String(order.orderId))
      : String(order.exchange_order_id),
    executedQuantity,
    averagePrice,
    executedNotional,
    paidFeeQuote: Math.max(
      0,
      finite(fill.paidFeeQuote ?? fill.paidFee ?? order.paid_fee ?? order.commission),
    ),
    raw: payload,
  };
}

export function isTerminalNoFill(fill: GatewayFill): boolean {
  return fill.executedQuantity <= 0 &&
    ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED", "PARTIALLY_FILLED_CANCELED"]
      .includes(fill.status);
}

export function freshSnapshotAgeMs(capturedAt: string, nowMs = Date.now()): number {
  const captured = Date.parse(capturedAt);
  return Number.isFinite(captured) ? Math.max(0, nowMs - captured) : Number.POSITIVE_INFINITY;
}
