import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LATE_RECOVERY_THRESHOLDS,
  lateRecoveryDecision,
  updatePost180RunningTrough,
} from "./late-recovery-policy.ts";

function decide(overrides: Record<string, unknown> = {}) {
  return lateRecoveryDecision({
    heldSeconds: 460,
    absoluteMaxHoldingSeconds: 600,
    residualStage: false,
    existingAction: "NONE",
    entryPrice: 100,
    runningTroughPrice: 97,
    executablePrice: 97.5,
    executableDepthSufficient: true,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    ...overrides,
  } as any);
}

Deno.test("late recovery thresholds preserve 180 tracking, 460 activation and 33 percent recovery", () => {
  assertEquals(LATE_RECOVERY_THRESHOLDS.troughTrackingStartSeconds, 180);
  assertEquals(LATE_RECOVERY_THRESHOLDS.startSeconds, 460);
  assertEquals(LATE_RECOVERY_THRESHOLDS.drawdownRecoveryRatio, 0.33);
});

Deno.test("post-180 trough never resets upward", () => {
  assertEquals(updatePost180RunningTrough(97, 98), 97);
  assertEquals(updatePost180RunningTrough(97, 96.5), 96.5);
  assertEquals(updatePost180RunningTrough(0, 98), 98);
});

Deno.test("existing safety or profit decision always wins", () => {
  const result = decide({
    existingAction: "STOP",
    executableNetAllowed: true,
    expectedNetProfitQuote: 10,
    executablePrice: 101,
  });
  assertEquals(result.action, "NONE");
  assertEquals(result.reason, "LATE_RECOVERY_EXISTING_DECISION_PRESERVED");
});

Deno.test("earned residual winner is never demoted into late recovery", () => {
  const result = decide({ residualStage: true, executablePrice: 99.5 });
  assertEquals(result.action, "NONE");
  assertEquals(result.reason, "LATE_RECOVERY_RESIDUAL_WINNER_PRESERVED");
});

Deno.test("late recovery cannot fire before 460 seconds", () => {
  const result = decide({
    heldSeconds: 459.999,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(result.action, "NONE");
  assertEquals(result.reason, "LATE_RECOVERY_INACTIVE");
});

Deno.test("600 second hard timeout keeps ownership at the boundary", () => {
  const result = decide({
    heldSeconds: 600,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(result.action, "NONE");
  assertEquals(result.reason, "LATE_RECOVERY_INACTIVE");
});

Deno.test("executable non-negative net exits the whole pre-T1 position after 460s", () => {
  const result = decide({
    heldSeconds: 460,
    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
    executablePrice: 100.1,
  });
  assertEquals(result.action, "STOP");
  assertEquals(result.fraction, 1);
  assertEquals(result.reason, "LATE_RECOVERY_NET_POSITIVE_EXIT");
});

Deno.test("one-third drawdown recovery exits while net remains negative", () => {
  const result = decide({
    entryPrice: 100,
    runningTroughPrice: 97,
    executablePrice: 98,
    expectedNetProfitQuote: -0.1,
  });
  assertEquals(result.action, "STOP");
  assertEquals(result.reason, "LATE_RECOVERY_DRAWDOWN_33_EXIT");
  assertEquals(Math.round((result.recoveryRatio || 0) * 1000), 333);
});

Deno.test("recovery below 33 percent keeps holding", () => {
  const result = decide({
    entryPrice: 100,
    runningTroughPrice: 97,
    executablePrice: 97.98,
    expectedNetProfitQuote: -0.1,
  });
  assertEquals(result.action, "NONE");
  assertEquals(result.reason, "LATE_RECOVERY_AWAITING_RECOVERY");
});

Deno.test("drawdown recovery requires full executable depth", () => {
  const result = decide({
    entryPrice: 100,
    runningTroughPrice: 97,
    executablePrice: 99,
    executableDepthSufficient: false,
    expectedNetProfitQuote: -0.1,
  });
  assertEquals(result.action, "NONE");
});

Deno.test("invalid denominator cannot trigger a recovery exit", () => {
  const result = decide({
    entryPrice: 100,
    runningTroughPrice: 100,
    executablePrice: 100.5,
    expectedNetProfitQuote: -0.1,
  });
  assertEquals(result.action, "NONE");
});
