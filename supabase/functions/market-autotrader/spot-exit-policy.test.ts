import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { spotSplitExitDecision } from "./spot-exit-policy.ts";

function decide(overrides: Partial<Parameters<typeof spotSplitExitDecision>[0]> = {}) {
  return spotSplitExitDecision({
    residualStage: false,
    grossReturnPct: 0,
    peakGrossReturnPct: 0,
    residualNetReturnPct: 0,
    heldSeconds: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    preT1ProfitProtectionHit: false,
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

Deno.test("spot 180m recovery exits 100% only on executable positive net", () => {
  const before = decide({
    heldSeconds: 10_799,
    grossReturnPct: 1,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.2,
  });
  assertEquals(before.action, "NONE");

  const exit = decide({
    heldSeconds: 10_800,
    grossReturnPct: 1,
    executableNetAllowed: true,
    expectedNetProfitQuote: 0.2,
  });
  assertEquals(exit.action, "STOP");
  assertEquals(exit.fraction, 1);
  assertEquals(exit.reason, "STALE_RECOVERY_NET_POSITIVE_EXIT_180M");

  const blocked = decide({
    heldSeconds: 10_800,
    grossReturnPct: 1,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(blocked.action, "NONE");
  assertEquals(blocked.reason, "STALE_RECOVERY_AWAITING_POSITIVE_NET_180M");
});

Deno.test("spot +5 target keeps precedence after 180m", () => {
  const d = decide({
    heldSeconds: 20_000,
    grossReturnPct: 5,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "HALF_HOLD_TAKE_PROFIT_5");
});

Deno.test("spot pre-T1 earned profit floor closes 100%", () => {
  const d = decide({ grossReturnPct: 2, peakGrossReturnPct: 3, preT1ProfitProtectionHit: true });
  assertEquals(d.action, "STOP");
  assertEquals(d.fraction, 1);
  assertEquals(d.reason, "PRE_T1_PROFIT_PROTECTION_EXIT");
});

Deno.test("spot +5 target keeps precedence over pre-T1 protection", () => {
  const d = decide({ grossReturnPct: 5.2, preT1ProfitProtectionHit: true });
  assertEquals(d.fraction, 0.5);
  assertEquals(d.reason, "HALF_HOLD_TAKE_PROFIT_5");
});
