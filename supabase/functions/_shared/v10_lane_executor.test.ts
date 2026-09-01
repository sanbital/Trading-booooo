import {
  floorToStep,
  freshSnapshotAgeMs,
  isTerminalNoFill,
  parseGatewayFill,
  v10ClientOrderId,
} from "./v10_lane_executor.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(floorToStep(1.23456, 0.001) === 1.234, "quantity floors to venue step");
assert(floorToStep(0, 0.001) === 0, "zero quantity remains zero");
const id = v10ClientOrderId("v10e", "17ce7b34-7483-4836-9c61-a0050a6fac14");
assert(id.startsWith("tb-v10e-") && id.length <= 36, "client order id is gateway compatible");

const fill = parseGatewayFill({
  order: { status: "FILLED", exchange_order_id: "123" },
  fill: { executedVolume: "2", averagePrice: "10", executedFunds: "20", paidFeeQuote: "0.01" },
});
assert(fill.executedQuantity === 2 && fill.averagePrice === 10, "gateway fill parsed");
assert(fill.exchangeOrderId === "123" && fill.executedNotional === 20, "gateway ids parsed");
assert(isTerminalNoFill(parseGatewayFill({ status: "CANCELED", executed_volume: 0 })),
  "terminal zero fill detected");
assert(freshSnapshotAgeMs("2026-09-01T00:00:00Z", Date.parse("2026-09-01T00:00:30Z")) === 30_000,
  "snapshot freshness measured");
