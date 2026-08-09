import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { halfHoldRecoveryExitDecision } from "./recovery-exit-policy.ts";

Deno.test("the first -4% stop sells only the first 50% tranche", () => {
  const decision = halfHoldRecoveryExitDecision({
    residualStage: false,
    recoveryMode: false,
    grossReturnPct: -4,
    residualNetReturnPct: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
  });

  assertEquals(decision, {
    action: "STOP",
    fraction: 0.5,
    reason: "HALF_HOLD_STOP_LOSS_4",
  });
});

Deno.test("the normal residual half exits in full at either +10% or -4%", () => {
  const takeProfit = halfHoldRecoveryExitDecision({
    residualStage: true,
    recoveryMode: false,
    grossReturnPct: 5,
    residualNetReturnPct: 10,
    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
  });
  assertEquals(takeProfit, {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_TAKE_PROFIT_10",
  });

  const stopLoss = halfHoldRecoveryExitDecision({
    residualStage: true,
    recoveryMode: false,
    grossReturnPct: 5,
    residualNetReturnPct: -4,
    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
  });
  assertEquals(stopLoss, {
    action: "STOP",
    fraction: 1,
    reason: "RESIDUAL_STOP_LOSS_4",
  });
});
