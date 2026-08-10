import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { spotSplitExitDecision } from "./spot-exit-policy.ts";

function decide(overrides: Partial<Parameters<typeof spotSplitExitDecision>[0]> = {}) {
  return spotSplitExitDecision({
    residualStage: false,
    grossReturnPct: 0,
    peakGrossReturnPct: 0,
    residualNetReturnPct: 0,
    safetyRequested: false,
    ...overrides,
  });
}

Deno.test("spot first tranche sells 50% at +5%", () => {
  assertEquals(decide({ grossReturnPct: 5 }).fraction, 0.5);
  assertEquals(decide({ grossReturnPct: 5 }).reason, "HALF_HOLD_TAKE_PROFIT_5");
});

Deno.test("spot hard stop closes 100% at -4%", () => {
  assertEquals(decide({ grossReturnPct: -4 }).fraction, 1);
  assertEquals(decide({ grossReturnPct: -4 }).reason, "HALF_HOLD_STOP_LOSS_4");
});

Deno.test("spot residual at a +5% peak protects at +3.5%", () => {
  const hold = decide({ residualStage: true, grossReturnPct: 3.6, peakGrossReturnPct: 5 });
  assertEquals(hold.action, "NONE");
  assertEquals(hold.residualProtectPct, 3.5);
  const exit = decide({ residualStage: true, grossReturnPct: 3.5, peakGrossReturnPct: 5 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
});

Deno.test("spot residual follows peak minus 1.5 percentage points", () => {
  const exit = decide({ residualStage: true, grossReturnPct: 6.5, peakGrossReturnPct: 8 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.reason, "RESIDUAL_PROTECTED_TRAIL_EXIT");
  assertEquals(exit.residualProtectPct, 6.5);
});

Deno.test("spot residual floor never goes below +3%", () => {
  const exit = decide({ residualStage: true, grossReturnPct: 3, peakGrossReturnPct: 4 });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.residualProtectPct, 3);
});
