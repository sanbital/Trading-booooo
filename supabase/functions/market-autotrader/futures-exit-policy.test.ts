import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_FUTURES_LEVERAGE,
  FUTURES_MIN_ENTRY_MARGIN_USDT,
  futuresEntryMinimums,
  futuresPriceReturnPctForRoe,
  futuresRecoveryLatched,
  futuresRoePct,
  futuresSplitExitDecision,
  normalizeFuturesLeverage,
} from "./futures-exit-policy.ts";

function decide(overrides: Record<string, unknown> = {}) {
  const decision = futuresSplitExitDecision({
    residualStage: false,
    recoveryMode: false,
    leverage: DEFAULT_FUTURES_LEVERAGE,
    grossReturnPct: 0,
    netReturnPct: 0,
    executableNetAllowed: false,
    expectedNetProfitQuote: -1,
    safetyRequested: false,
    ...overrides,
  });
  return { action: decision.action, fraction: decision.fraction, reason: decision.reason };
}

Deno.test("default leverage is 3x", () => {
  assertEquals(DEFAULT_FUTURES_LEVERAGE, 3);
  assertEquals(normalizeFuturesLeverage(undefined), 3);
  assertEquals(normalizeFuturesLeverage(0), 3);
  assertEquals(normalizeFuturesLeverage(-5), 3);
  assertEquals(normalizeFuturesLeverage(1000), 20);
  assertEquals(normalizeFuturesLeverage(5), 5);
});

Deno.test("the futures entry floor is 50 USDT of margin, not 50 USDT of notional", () => {
  assertEquals(FUTURES_MIN_ENTRY_MARGIN_USDT, 50);
  assertEquals(futuresEntryMinimums(3, 5), {
    marginQuote: 50,
    notionalQuote: 150,
    leverage: 3,
  });
  assertEquals(futuresEntryMinimums(5, 5), {
    marginQuote: 50,
    notionalQuote: 250,
    leverage: 5,
  });
});

Deno.test("a higher venue notional filter raises margin without weakening either floor", () => {
  assertEquals(futuresEntryMinimums(3, 180), {
    marginQuote: 60,
    notionalQuote: 180,
    leverage: 3,
  });
});

Deno.test("ROE is the price return multiplied by leverage", () => {
  assertEquals(futuresRoePct(-4, 3), -12);
  assertEquals(futuresRoePct(5, 3), 15);
  assertEquals(futuresRoePct(10, 3), 30);
  // An unusable leverage value must not collapse the multiplier to 1.
  assertEquals(futuresRoePct(-4, 0), -12);
});

Deno.test("at 3x the ROE gates are -4% / +5% / +10% on price", () => {
  assertEquals(futuresPriceReturnPctForRoe(-12, 3), -4);
  assertEquals(futuresPriceReturnPctForRoe(15, 3), 5);
  assertEquals(futuresPriceReturnPctForRoe(30, 3), 10);
});

Deno.test("half take profit at +15% ROE", () => {
  assertEquals(decide({ grossReturnPct: 5 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "FUTURES_HALF_TAKE_PROFIT_ROE_15",
  });
});

Deno.test("half stop loss at -12% ROE", () => {
  assertEquals(decide({ grossReturnPct: -4 }), {
    action: "STOP",
    fraction: 0.5,
    reason: "FUTURES_HALF_STOP_LOSS_ROE_12",
  });
});

Deno.test("inside the band nothing is sold", () => {
  assertEquals(decide({ grossReturnPct: 3 }), {
    action: "NONE",
    fraction: 0,
    reason: "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12",
  });
  assertEquals(decide({ grossReturnPct: -3 }), {
    action: "NONE",
    fraction: 0,
    reason: "FUTURES_HALF_AWAITING_ROE_15_OR_ROE_MINUS_12",
  });
});

Deno.test("a -4% price move at 1x is not a stop; the same move at 3x is", () => {
  assertEquals(decide({ grossReturnPct: -4, leverage: 1 }).action, "NONE");
  assertEquals(decide({ grossReturnPct: -4, leverage: 3 }).action, "STOP");
});

Deno.test("clean residual takes profit at +30% ROE", () => {
  assertEquals(decide({ residualStage: true, grossReturnPct: 10, netReturnPct: 9.89 }), {
    action: "STOP",
    fraction: 1,
    reason: "FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30",
  });
});

Deno.test("clean residual below +30% ROE keeps holding", () => {
  assertEquals(decide({ residualStage: true, grossReturnPct: 9.99, netReturnPct: 9.88 }), {
    action: "NONE",
    fraction: 0,
    reason: "FUTURES_RESIDUAL_AWAITING_TP_ROE_30",
  });
});

Deno.test("clean residual +30% gate is not delayed by fees", () => {
  const decision = futuresSplitExitDecision({
    residualStage: true,
    recoveryMode: false,
    leverage: 3,
    grossReturnPct: 10,
    // Both-side fees make net ROE slightly lower, but the requested price gate is still
    // exactly +10% at 3x.
    netReturnPct: 9.89,
    executableNetAllowed: true,
    expectedNetProfitQuote: 1,
  });
  assertEquals(decision.roePct, 30);
  assert(decision.netRoePct < 30);
  assertEquals(decision.reason, "FUTURES_RESIDUAL_TAKE_PROFIT_ROE_30");
});

Deno.test("recovery residual waits while it is still underwater", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      netReturnPct: -6,
      executableNetAllowed: false,
      expectedNetProfitQuote: -3,
    }),
    {
      action: "NONE",
      fraction: 0,
      reason: "FUTURES_RECOVERY_AWAITING_NET_POSITIVE",
    },
  );
});

Deno.test("recovery residual sells everything the moment its net turns positive", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      netReturnPct: 0.3,
      executableNetAllowed: true,
      expectedNetProfitQuote: 0.04,
    }),
    {
      action: "STOP",
      fraction: 1,
      reason: "FUTURES_RECOVERY_NET_POSITIVE_EXIT",
    },
  );
});

Deno.test("recovery residual does not sell on an unexecutable positive mark", () => {
  assertEquals(
    decide({
      residualStage: true,
      recoveryMode: true,
      netReturnPct: 2,
      executableNetAllowed: false,
      expectedNetProfitQuote: 5,
    }).action,
    "NONE",
  );
});

Deno.test("recovery residual ignores the +30% ROE take profit and uses the flip instead", () => {
  const decision = decide({
    residualStage: true,
    recoveryMode: true,
    netReturnPct: 12,
    executableNetAllowed: false,
    expectedNetProfitQuote: -0.01,
  });
  assertEquals(decision.reason, "FUTURES_RECOVERY_AWAITING_NET_POSITIVE");
});

Deno.test("recovery latches on the first negative residual observation and never clears", () => {
  assert(!futuresRecoveryLatched({ residualStage: true, alreadyLatched: false, netReturnPct: 2 }));
  assert(
    futuresRecoveryLatched({ residualStage: true, alreadyLatched: false, netReturnPct: -0.1 }),
  );
  assert(futuresRecoveryLatched({ residualStage: true, alreadyLatched: true, netReturnPct: 40 }));
  // Before the split the first-leg thresholds own the decision, so nothing latches.
  assert(
    !futuresRecoveryLatched({ residualStage: false, alreadyLatched: false, netReturnPct: -9 }),
  );
});

Deno.test("thresholds still override a non-price safety request inside the band", () => {
  assertEquals(decide({ grossReturnPct: -1, safetyRequested: true }), {
    action: "NONE",
    fraction: 0,
    reason: "FUTURES_HALF_THRESHOLD_OVERRIDES_NON_PRICE_SAFETY_EXIT",
  });
});

Deno.test("the audit record carries the leverage-applied returns", () => {
  const decision = futuresSplitExitDecision({
    residualStage: false,
    recoveryMode: false,
    leverage: 3,
    grossReturnPct: 5,
    netReturnPct: 4.9,
    executableNetAllowed: false,
    expectedNetProfitQuote: 0,
  });
  assertEquals(decision.leverage, 3);
  assertEquals(decision.roePct, 15);
  assertEquals(Math.round(decision.netRoePct * 100) / 100, 14.7);
});
