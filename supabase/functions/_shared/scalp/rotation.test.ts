import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_ROTATION_CONFIG,
  evaluateRotation,
  expectedResolutionSeconds,
  type HeldPositionRate,
  rateBpsPerSecond,
  remainingValueBps,
} from "./rotation.ts";

function held(overrides: Partial<HeldPositionRate> = {}): HeldPositionRate {
  return {
    positionId: "p-1",
    exchange: "upbit",
    market: "KRW-ETH",
    remainingEvBps: 2,
    expectedSecondsToResolve: 120,
    exitCostBps: 3,
    ageSeconds: 300,
    state: "OPEN",
    ...overrides,
  };
}

Deno.test("a slot is valued in bps per second, not bps", () => {
  // 10bp over 300s is worse than 4bp over 60s, even though it is the larger number.
  assert(rateBpsPerSecond(4, 60) > rateBpsPerSecond(10, 300));
  assertEquals(rateBpsPerSecond(5, 0), 0);
});

Deno.test("a clearly better book displaces a dead position", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 20, expectedSecondsToResolve: 60 },
    [held({ remainingEvBps: 0.5, expectedSecondsToResolve: 200 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, true);
  assertEquals(decision.displace?.market, "KRW-ETH");
  assertEquals(decision.switchingCostBps, 5);
  assertEquals(decision.netCandidateEvBps, 15);
});

Deno.test("a marginally better book does not — hysteresis blocks churn on noise", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 12, expectedSecondsToResolve: 120 },
    [held({ remainingEvBps: 8, expectedSecondsToResolve: 120, exitCostBps: 3 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  // Candidate nets 7bp/120s = 0.058bp/s vs incumbent 8bp/120s = 0.067bp/s. Worse, in fact,
  // once the switching cost is paid — which is the entire point of charging it.
  assertEquals(decision.rotate, false);
  assert(decision.improvementBpsPerSecond < 0);
});

Deno.test("switching cost can consume the whole edge", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 4, expectedSecondsToResolve: 60 },
    [held({ exitCostBps: 3 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, false);
  assert(decision.reason.includes("switching cost"));
  assert(decision.netCandidateEvBps < 0);
});

Deno.test("a young position is protected from displacement", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 50, expectedSecondsToResolve: 30 },
    [held({ remainingEvBps: 0.1, ageSeconds: 10 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, false);
  assert(decision.reason.includes("old enough"));
});

Deno.test("only settled positions may be displaced", () => {
  for (const state of ["ENTRY_PENDING", "EXITING", "RECONCILING"]) {
    const decision = evaluateRotation(
      { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 50, expectedSecondsToResolve: 30 },
      [held({ state, remainingEvBps: 0.1 })],
      { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
    );
    assertEquals(decision.rotate, false, `${state} must not be rotatable`);
  }
});

Deno.test("the worst slot is displaced, not the first one that qualifies", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 30, expectedSecondsToResolve: 60 },
    [
      held({ positionId: "p-mediocre", market: "KRW-LINK", remainingEvBps: 6, expectedSecondsToResolve: 120 }),
      held({ positionId: "p-dead", market: "KRW-AVAX", remainingEvBps: 0.2, expectedSecondsToResolve: 300 }),
    ],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, true);
  assertEquals(decision.displace?.positionId, "p-dead");
});

Deno.test("a position expected to lose is escaped, and the bar stays positive", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 20, expectedSecondsToResolve: 60 },
    [held({ remainingEvBps: -6, expectedSecondsToResolve: 120 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, true);
  assert(decision.requiredImprovementBpsPerSecond > 0, "required bar must never go negative");
});

Deno.test("the hourly rotation budget is a hard stop", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: 100, expectedSecondsToResolve: 10 },
    [held({ remainingEvBps: 0.01 })],
    {
      candidateEntryCostBps: 2,
      rotationsInLastHour: DEFAULT_ROTATION_CONFIG.maxRotationsPerHour,
    },
  );
  assertEquals(decision.rotate, false);
  assert(decision.reason.includes("budget"));
});

Deno.test("a negative-EV candidate is never rotated into", () => {
  const decision = evaluateRotation(
    { exchange: "upbit", market: "KRW-DOGE", evLowerBoundBps: -1, expectedSecondsToResolve: 60 },
    [held({ remainingEvBps: -50 })],
    { candidateEntryCostBps: 2, rotationsInLastHour: 0 },
  );
  assertEquals(decision.rotate, false);
});

Deno.test("expected resolution time follows the barrier product over variance", () => {
  const tight = expectedResolutionSeconds(10, 10, 1);
  const wide = expectedResolutionSeconds(20, 20, 1);
  // Doubling both barriers should roughly quadruple the time — the W^2 relationship the
  // throughput optimum is built on.
  assertEquals(Math.round(wide / tight), 4);
  // A more volatile book resolves faster.
  assert(expectedResolutionSeconds(10, 10, 2) < tight);
  // Degenerate input falls back to the ceiling rather than returning zero, which would
  // make a candidate look infinitely fast.
  assertEquals(expectedResolutionSeconds(0, 10, 1), 600);
});

Deno.test("remaining value uses the remaining barriers, not the entry ones", () => {
  // Opened at 100, target 101, stop 99.5. Price now 100.8 — nearly there.
  const near = remainingValueBps({
    currentPrice: 100.8, targetPrice: 101, stopPrice: 99.5,
    entryPTarget: 0.40, entryNeutralWinRate: 0.33,
    heldSeconds: 0, edgeHalfLifeSeconds: 90,
  });
  // 20bp of upside left against 129bp of downside: the geometry is now heavily
  // favourable on probability and thin on payoff. Both must be reflected.
  assert(near.remainingUpsideBps < near.remainingDownsideBps);
  assert(near.pTargetNow > 0.8, "a target nearly touched must be highly likely");
});

Deno.test("a stale signal decays to pure geometry", () => {
  const common = {
    currentPrice: 100, targetPrice: 101, stopPrice: 99.5,
    entryPTarget: 0.55, entryNeutralWinRate: 0.33, edgeHalfLifeSeconds: 90,
  };
  const fresh = remainingValueBps({ ...common, heldSeconds: 0 });
  const stale = remainingValueBps({ ...common, heldSeconds: 900 }); // ten half-lives
  assert(fresh.pTargetNow > stale.pTargetNow);
  // After ten half-lives essentially nothing of the claimed edge survives.
  assertAlmostEquals(stale.pTargetNow, 1 / 3, 0.01);
});

Deno.test("a position through its barrier does not report negative distance", () => {
  const through = remainingValueBps({
    currentPrice: 102, targetPrice: 101, stopPrice: 99.5,
    entryPTarget: 0.40, entryNeutralWinRate: 0.33,
    heldSeconds: 10, edgeHalfLifeSeconds: 90,
  });
  assertEquals(through.remainingUpsideBps, 0);
  assert(through.remainingDownsideBps > 0);
});

Deno.test("degenerate prices yield zero rather than NaN", () => {
  const bad = remainingValueBps({
    currentPrice: 0, targetPrice: 101, stopPrice: 99.5,
    entryPTarget: 0.4, entryNeutralWinRate: 0.33, heldSeconds: 0, edgeHalfLifeSeconds: 90,
  });
  assertEquals(bad.remainingEvBps, 0);
});
