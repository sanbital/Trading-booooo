import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { halfHoldRecoveryExitDecision } from "./recovery-exit-policy.ts";

function decide(overrides: Record<string, unknown> = {}) {
  return halfHoldRecoveryExitDecision({
    residualStage: false,
    recoveryMode: false,
    grossReturnPct: 0,
    residualNetReturnPct: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    safetyRequested: false,
    ...overrides,
  });
}

Deno.test("normal winner sells first half at +5%", () => {
  assertEquals(decide({ grossReturnPct: 5 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "HALF_HOLD_TAKE_PROFIT_5",
  });
});

Deno.test("failed first leg sells only first half at -4%", () => {
  assertEquals(decide({ grossReturnPct: -4 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "HALF_HOLD_STOP_LOSS_4",
  });
});

Deno.test("normal residual preserves +10% take profit", () => {
  assertEquals(decide({ residualStage: true, residualNetReturnPct: 10 }), {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_TAKE_PROFIT_10",
  });
});

Deno.test("normal residual preserves -4% stop", () => {
  assertEquals(decide({ residualStage: true, residualNetReturnPct: -4 }), {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_STOP_LOSS_4",
  });
});

Deno.test("recovery residual ignores +10 threshold until total net is positive", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      residualNetReturnPct: 12,
      executableNetAllowed: false,
      expectedNetProfitQuote: -0.01,
    }),
    {
      action: "NONE",
      fraction: 0,
      reason: "RECOVERY_AWAITING_NET_POSITIVE",
    },
  );
});

Deno.test("recovery residual ignores ordinary -4 residual stop", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      residualNetReturnPct: -8,
      executableNetAllowed: false,
      expectedNetProfitQuote: -5,
    }),
    {
      action: "NONE",
      fraction: 0,
      reason: "RECOVERY_AWAITING_NET_POSITIVE",
    },
  );
});

Deno.test("recovery residual exits all as soon as total executable net turns positive", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      residualNetReturnPct: 4.2,
      executableNetAllowed: true,
      expectedNetProfitQuote: 0.02,
    }),
    {
      action: "STOP",
      fraction: 1,
      reason: "RECOVERY_NET_POSITIVE_EXIT",
    },
  );
});

Deno.test("first tranche still blocks non-price safety exit inside threshold band", () => {
  assertEquals(decide({ grossReturnPct: -1, safetyRequested: true }), {
    action: "NONE",
    fraction: 0,
    reason: "HALF_HOLD_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT",
  });
});
