import {
  evaluateEntryPayoff,
  payoffAwareDeployment,
  summarizeRealizedPayoff,
} from "./payoff-governor.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

Deno.test("realized payoff summary is fee-net and JSON-safe", () => {
  const summary = summarizeRealizedPayoff([10, 5, -20, -10]);
  near(summary.meanNetBps || 0, -3.75);
  near(summary.meanWinBps || 0, 7.5);
  near(summary.meanLossBps || 0, 15);
  near(summary.payoffRatio || 0, 0.5);
  near(summary.profitFactor || 0, 0.5);
  assert(Number.isFinite(summary.meanLowerBoundBps));
  assert(!JSON.stringify(summary).includes("Infinity"));
});

Deno.test("mature adverse payoff evidence ranks lower without deleting turnover", () => {
  const decision = payoffAwareDeployment({
    samples: 140,
    observedMultiplier: 0.70,
    profitableRate: 0.16,
    meanNetBps: -11,
    profitFactor: 0.42,
    payoffRatio: 0.55,
    meanLowerBoundBps: -16,
    medianHoldSeconds: 151,
  });
  assert(decision.gateWeight === 1);
  assert(decision.gateMultiplier === 1);
  assert(decision.rankingQuality < 1);
});

Deno.test("thin adverse sample preserves turnover and exploration", () => {
  const decision = payoffAwareDeployment({
    samples: 25,
    observedMultiplier: 0.40,
    profitableRate: 0.16,
    meanNetBps: -12,
    profitFactor: 0.30,
    payoffRatio: 0.40,
    meanLowerBoundBps: -25,
    medianHoldSeconds: 150,
  });
  assert(decision.gateWeight > 0 && decision.gateWeight < 0.10);
  assert(decision.gateMultiplier > 0.95);
});

Deno.test("fast profitable evidence ranks higher without unbounded permission", () => {
  const decision = payoffAwareDeployment({
    samples: 150,
    observedMultiplier: 1.15,
    profitableRate: 0.58,
    meanNetBps: 8,
    profitFactor: 1.45,
    payoffRatio: 1.20,
    meanLowerBoundBps: 2,
    medianHoldSeconds: 90,
  });
  assert(decision.gateMultiplier > 1);
  assert(decision.gateMultiplier <= 1.30);
  assert(decision.rankingQuality > 1);
  assert(decision.rankingQuality <= 2);
});

Deno.test("fee-thin or asymmetric entry geometry is rejected", () => {
  const decision = evaluateEntryPayoff({
    targetBps: 20,
    stopBps: 35,
    targetReturnNetBps: 1,
    stopReturnNetBps: -48,
    minNetProfitBps: 2,
    maxStopToTargetRatio: 1.35,
    minNetRewardRiskRatio: 0.80,
  });
  assert(!decision.allowed);
  assert(decision.reasons.includes("TARGET_NET_CUSHION_TOO_SMALL"));
  assert(decision.warnings.includes("STOP_TARGET_ASYMMETRY"));
  assert(decision.warnings.includes("NET_PAYOFF_TOO_WEAK"));
});

Deno.test("payoff shape cannot veto an otherwise positive target branch", () => {
  const decision = evaluateEntryPayoff({
    targetBps: 20,
    stopBps: 35,
    targetReturnNetBps: 3,
    stopReturnNetBps: -48,
    minNetProfitBps: 2,
    maxStopToTargetRatio: 1.35,
    minNetRewardRiskRatio: 0.80,
  });
  assert(decision.allowed);
  assert(decision.warnings.includes("STOP_TARGET_ASYMMETRY"));
  assert(decision.warnings.includes("NET_PAYOFF_TOO_WEAK"));
});

Deno.test("balanced fee-adjusted entry geometry passes", () => {
  const decision = evaluateEntryPayoff({
    targetBps: 45,
    stopBps: 35,
    targetReturnNetBps: 24,
    stopReturnNetBps: -28,
    minNetProfitBps: 2,
    maxStopToTargetRatio: 1.35,
    minNetRewardRiskRatio: 0.80,
  });
  assert(decision.allowed, decision.reasons.join(","));
  assert(decision.netRewardRiskRatio >= 0.80);
});
