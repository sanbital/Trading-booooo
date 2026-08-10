import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { spotSplitExitDecision } from "./spot-exit-policy.ts";

function decide(overrides: Partial<Parameters<typeof spotSplitExitDecision>[0]> = {}) {
  return spotSplitExitDecision({
    residualStage: false,
    grossReturnPct: 0,
    residualNetReturnPct: 0,
    safetyRequested: false,
    ...overrides,
  });
}
Deno.test("spot first tranche sells 50% at +5%", () => {
  assertEquals(decide({ grossReturnPct: 5 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "HALF_HOLD_TAKE_PROFIT_5",
  });
});
Deno.test("spot first tranche sells 50% at -4%", () => {
  assertEquals(decide({ grossReturnPct: -4 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "HALF_HOLD_STOP_LOSS_4",
  });
});
Deno.test("spot residual exits all at +10%", () => {
  assertEquals(decide({ residualStage: true, residualNetReturnPct: 10 }), {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_TAKE_PROFIT_10",
  });
});
Deno.test("spot residual exits all at -4%", () => {
  assertEquals(decide({ residualStage: true, residualNetReturnPct: -4 }), {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_STOP_LOSS_4",
  });
});
Deno.test("spot residual holds only inside -4% to +10%", () => {
  assertEquals(decide({ residualStage: true, residualNetReturnPct: 9.99 }).action, "NONE");
  assertEquals(decide({ residualStage: true, residualNetReturnPct: -3.99 }).action, "NONE");
});
