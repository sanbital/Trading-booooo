import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateS37ShortExit,
  isS37SignalEvidence,
  planS37ShortEntry,
  S37_SHORT_REVISION,
  S37_SHORT_STRATEGY_KEY,
} from "./s37-short-policy.ts";

Deno.test("S37 plans an exact 1.5 ATR stop and fixed 1R target", () => {
  const plan = planS37ShortEntry(100, 2, 99.5);
  assert(plan.allowed);
  assertEquals(plan.initialRisk, 3);
  assertEquals(plan.stopPrice, 102.5);
  assertEquals(plan.partialTarget, 96.5);
  assertEquals(plan.finalTarget, 96.5);
});

Deno.test("S37 rejects entries beyond the 0.5 ATR next-bar gap", () => {
  assertEquals(planS37ShortEntry(100, 2, 98.99).allowed, false);
});

Deno.test("S37 uses full exits only and stop wins a collision", () => {
  const stop = evaluateS37ShortExit({
    entryPrice: 100,
    initialRisk: 3,
    currentStop: 103,
    executablePrice: 103,
    openedAtMs: 0,
    nowMs: 1,
    lastPolicyBarTime: 0,
  });
  assertEquals(stop.action, "STOP");
  assertEquals(stop.fraction, 1);

  const target = evaluateS37ShortExit({
    entryPrice: 100,
    initialRisk: 3,
    currentStop: 103,
    executablePrice: 97,
    openedAtMs: 0,
    nowMs: 1,
    lastPolicyBarTime: 0,
  });
  assertEquals(target.action, "TARGET_2");
  assertEquals(target.fraction, 1);
});

Deno.test("S37 evidence requires the exact strategy and revision", () => {
  assert(isS37SignalEvidence({
    entry_strategy_key: S37_SHORT_STRATEGY_KEY,
    entry_strategy_revision: S37_SHORT_REVISION,
  }));
  assertEquals(isS37SignalEvidence({ entry_strategy_key: S37_SHORT_STRATEGY_KEY }), false);
});
