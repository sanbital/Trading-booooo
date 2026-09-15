import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  capitalSupportedSlotCount,
  calculateOrderNotional,
  enforceMinimumExecutableNotional,
} from "./risk-allocator.ts";

Deno.test("more slots do not increase total exposure cap", () => {
  const make = (slots: number) =>
    calculateOrderNotional({
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

Deno.test("slot count contracts only enough to support the operator minimum", () => {
  assertEquals(capitalSupportedSlotCount(78_000, 1, 3, 40_001), 1);
  assertEquals(capitalSupportedSlotCount(123_000, 1, 3, 40_001), 3);
  assertEquals(capitalSupportedSlotCount(1_000_000, 0.8, 8, 40_001), 8);
});

Deno.test("operator minimum lifts evidence sizing without crossing hard ceilings", () => {
  const decision = calculateOrderNotional({
    managedCapitalQuote: 123_000,
    maxStrategyExposureFraction: 1,
    desiredSlots: 3,
    perTradeLossBudgetQuote: 6_150,
    stopPct: 0.01,
    estimatedExitCostPct: 0.001,
    depthLimitedNotional: 1_000_000,
    exchangeLimitedNotional: 1_000_000,
    sizeFraction: 0.35,
  });
  assertAlmostEquals(decision.notionalQuote, 14_350, 1e-9);
  assertEquals(enforceMinimumExecutableNotional(decision, 40_000, 123_000), 40_000);
});

Deno.test("operator minimum never overrides a slot, depth, or balance ceiling", () => {
  const decision = calculateOrderNotional({
    managedCapitalQuote: 110_000,
    maxStrategyExposureFraction: 1,
    desiredSlots: 3,
    perTradeLossBudgetQuote: 100_000,
    stopPct: 0.01,
    estimatedExitCostPct: 0,
    depthLimitedNotional: 38_000,
    exchangeLimitedNotional: 1_000_000,
    sizeFraction: 0.35,
  });
  assert(enforceMinimumExecutableNotional(decision, 40_000, 110_000) < 40_000);
  assertEquals(
    enforceMinimumExecutableNotional(decision, 40_000, 20_000),
    decision.notionalQuote,
  );
});
