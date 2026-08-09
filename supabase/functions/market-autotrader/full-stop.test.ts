import { FULL_STOP_REASON, fullStopLossDecision } from "./full-stop.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("-4% net loss exits the entire position in the first stop decision", () => {
  const decision = fullStopLossDecision({
    entryPrice: 100,
    executableExitPrice: 96,
    sellFeeRate: 0,
  });

  assert(decision.action === "STOP", "the -4% boundary must trigger");
  assert(decision.fraction === 1, "a stop must sell 100%, not the old 50% tranche");
  assert(decision.reason === FULL_STOP_REASON, "the full-stop audit reason must be stable");
});

Deno.test("exit fees make the -4% net stop trigger before a -4% gross move", () => {
  const decision = fullStopLossDecision({
    entryPrice: 100,
    executableExitPrice: 96.05,
    sellFeeRate: 0.001,
  });

  assert(decision.netReturnPct < -4, "the executable return must include the exit fee");
  assert(decision.action === "STOP", "fee-adjusted -4% must trigger the full stop");
  assert(decision.fraction === 1, "the fee-adjusted stop must sell the full position");
});

Deno.test("a price still above the fee-adjusted boundary remains open", () => {
  const decision = fullStopLossDecision({
    entryPrice: 100,
    executableExitPrice: 96.2,
    sellFeeRate: 0.001,
  });

  assert(decision.netReturnPct > -4, "test setup must remain above the boundary");
  assert(decision.action === "NONE", "the stop must not fire early");
  assert(decision.fraction === 0, "a hold decision must not request a sell");
});
