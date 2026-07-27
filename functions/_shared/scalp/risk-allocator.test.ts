import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateOrderNotional } from "./risk-allocator.ts";

Deno.test("more slots do not increase total exposure cap", () => {
  const make = (slots: number) => calculateOrderNotional({
    managedCapitalQuote: 1_000_000,
    maxStrategyExposureFraction: 0.8,
    desiredSlots: slots,
    perTradeLossBudgetQuote: 100_000,
    stopPct: 0.01,
    estimatedExitCostPct: 0.001,
    depthLimitedNotional: 1_000_000,
    exchangeLimitedNotional: 1_000_000,
    sizeFraction: 1,
  });
  const two = make(2);
  const eight = make(8);
  assertEquals(two.totalExposureCap, eight.totalExposureCap);
  assertAlmostEquals(eight.slotCap * 8, eight.totalExposureCap, 1e-9);
  assertAlmostEquals(two.slotCap * 2, two.totalExposureCap, 1e-9);
});

Deno.test("sizeFraction applies to slot-normal not total capital", () => {
  const d = calculateOrderNotional({
    managedCapitalQuote: 1_000_000,
    maxStrategyExposureFraction: 1,
    desiredSlots: 10,
    perTradeLossBudgetQuote: 100_000,
    stopPct: 0.01,
    estimatedExitCostPct: 0,
    depthLimitedNotional: 1_000_000,
    exchangeLimitedNotional: 1_000_000,
    sizeFraction: 0.35,
  });
  assertAlmostEquals(d.notionalQuote, 35_000, 1e-9);
});
