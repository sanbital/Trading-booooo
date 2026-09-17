// R5 is UNCHANGED by the entry-timing work. These tests pin it anyway, because the
// new entry is only worth shipping if the exit it hands off to still behaves exactly
// as it did -- and because the replay that justifies the entry change depends on
// every one of these levels being what it claims to be.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EXIT_REVIEW_R5, nextExitReviewed } from "./leader-exit-review.mjs";
import { POLICY } from "./leader-momentum-v17.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-09-17T12:00:00.000Z");
const ENTRY = 100;
const policy = { ...POLICY, ...EXIT_REVIEW_R5 };

// deno-lint-ignore no-explicit-any
function position(over: Record<string, unknown> = {}): any {
  return {
    entryPrice: ENTRY, entryAt: T0, peakPrice: ENTRY, lastHighAt: T0,
    stopPrice: ENTRY * (1 - POLICY.stopPct), entryFee: 0.045, quantity: 0.9, ...over,
  };
}
// deno-lint-ignore no-explicit-any
const step = (p: any, bid: number, at: number) => nextExitReviewed(p, bid, at, policy);

// ---------------------------------------------------------------- 31
Deno.test("CASE 31: the initial stop is -2.5% and fires there", () => {
  assertEquals(POLICY.stopPct, 0.025);
  const held = step(position(), 97.6, T0 + MIN);
  assertEquals(held.action, "HOLD");
  assertEquals(held.stopPrice, 97.5);
  const hit = step(position(), 97.5, T0 + MIN);
  assertEquals(hit.action, "CLOSE");
  assertEquals(hit.reason, "V17_HARD_STOP");
});

// ---------------------------------------------------------------- 32
Deno.test("CASE 32: a +1% excursion arms the risk cut at -1.2%", () => {
  assertEquals(EXIT_REVIEW_R5.riskCutArmPct, 0.01);
  assertEquals(EXIT_REVIEW_R5.riskCutLevelPct, 0.012);
  const armed = step(position(), 101, T0 + 2 * MIN);
  assertEquals(armed.action, "HOLD");
  assertEquals(Math.round(armed.stopPrice * 1e6) / 1e6, 98.8);
  assert(armed.stopPrice > ENTRY * (1 - POLICY.stopPct), "the stop rose off the -2.5% floor");
  assert(armed.stopPrice < ENTRY, "and the risk cut sits BELOW entry, not at breakeven");
});

// ---------------------------------------------------------------- 33
Deno.test("CASE 33: ten minutes without a +1% excursion arms the same risk cut", () => {
  assertEquals(EXIT_REVIEW_R5.failCutAfterMs, 600_000);
  const early = step(position(), 100.2, T0 + 9 * MIN);
  assertEquals(early.stopPrice, 97.5, "before 10 minutes the -2.5% floor still stands");
  const late = step(position(), 100.2, T0 + 10 * MIN);
  assertEquals(Math.round(late.stopPrice * 1e6) / 1e6, 98.8,
    "at 10 minutes the loss cap reaches -1.2% even without a favourable excursion");
});

// ---------------------------------------------------------------- 34
Deno.test("CASE 34: the stop never moves down", () => {
  // Peak 103 armed the trailing stop; a later, lower peak must not lower it.
  const armedHigh = step(position(), 103, T0 + 5 * MIN);
  assert(armedHigh.stopPrice > 100);
  const after = step(
    position({ peakPrice: armedHigh.peakPrice, stopPrice: armedHigh.stopPrice, lastHighAt: T0 + 5 * MIN }),
    100.5, T0 + 6 * MIN,
  );
  assertEquals(after.stopPrice, armedHigh.stopPrice, "a retrace cannot ratchet the stop back down");
  // And an explicitly lower remembered stop is refused in favour of the policy floor.
  const tampered = step(position({ stopPrice: 50 }), 100.2, T0 + MIN);
  assertEquals(tampered.stopPrice, 97.5);
});

// ---------------------------------------------------------------- 35
Deno.test("CASE 35: a +2% excursion locks half the gain", () => {
  assertEquals(EXIT_REVIEW_R5.profitLockArmPct, 0.02);
  assertEquals(EXIT_REVIEW_R5.profitLockCapture, 0.5);
  const locked = step(position(), 102, T0 + 3 * MIN);
  assertEquals(locked.action, "HOLD");
  assertEquals(locked.stopPrice, ENTRY + (102 - ENTRY) * 0.5);
  assert(locked.stopPrice > ENTRY, "the lock is above entry, unlike the risk cut");
});

// ---------------------------------------------------------------- 36
Deno.test("CASE 36: +3% arms the 1.5% trailing stop", () => {
  assertEquals(POLICY.trailArmPct, 0.03);
  assertEquals(POLICY.trailGapPct, 0.015);
  const armed = step(position(), 103, T0 + 4 * MIN);
  assertEquals(armed.armed, true);
  // The stop is the HIGHEST armed level, not the trailing one in isolation. At
  // exactly +3% the +2% profit lock (101.5) is still above the 1.5% trail (101.455),
  // so the lock governs -- which is the intended ratchet, not a bug.
  assertEquals(armed.stopPrice, Math.max(103 * (1 - POLICY.trailGapPct), ENTRY + 3 * 0.5));
  assertEquals(armed.stopPrice, 101.5);
  // Once the move is large enough the trail overtakes the lock and governs alone.
  const far = step(position(), 110, T0 + 4 * MIN);
  assertEquals(Math.round(far.stopPrice * 1e6) / 1e6, Math.round(110 * 0.985 * 1e6) / 1e6);
  assert(far.stopPrice > ENTRY + 10 * 0.5, "the trail is above the lock by then");
  const below = step(position(), 102.9, T0 + 4 * MIN);
  assertEquals(below.armed, false, "2.9% does not arm the trail");
});

// ---------------------------------------------------------------- 37
Deno.test("CASE 37: 45 minutes without a new peak is a stale exit", () => {
  assertEquals(POLICY.staleMs, 2_700_000);
  const fresh = step(position({ lastHighAt: T0 }), 100.5, T0 + 44 * MIN);
  assertEquals(fresh.action, "HOLD");
  const stale = step(position({ peakPrice: 101, lastHighAt: T0 }), 100.5, T0 + 45 * MIN);
  assertEquals(stale.action, "CLOSE");
  assertEquals(stale.reason, "V17_MOMENTUM_STALE");
});

// ---------------------------------------------------------------- 38
Deno.test("CASE 38: six hours is the hard hold limit", () => {
  assertEquals(POLICY.maxHoldMs, 21_600_000);
  const held = step(position({ lastHighAt: T0 + 5 * 3600_000 }), 100.5, T0 + 6 * 3600_000 - 1);
  assertEquals(held.action, "HOLD");
  const out = step(position({ lastHighAt: T0 + 5 * 3600_000 }), 100.5, T0 + 6 * 3600_000);
  assertEquals(out.action, "CLOSE");
  assertEquals(out.reason, "V17_MAX_HOLD");
});

Deno.test("R5's identity is the one the new entry hands off to", () => {
  assertEquals(EXIT_REVIEW_R5.policyVersion, "V17_EXIT_R5_TAIL");
  // If any of these move, the replay that justified the entry change is invalidated.
  assertEquals(
    JSON.stringify({
      stopPct: POLICY.stopPct, trailArmPct: POLICY.trailArmPct, trailGapPct: POLICY.trailGapPct,
      staleMs: POLICY.staleMs, maxHoldMs: POLICY.maxHoldMs,
      riskCutArmPct: EXIT_REVIEW_R5.riskCutArmPct, riskCutLevelPct: EXIT_REVIEW_R5.riskCutLevelPct,
      failCutAfterMs: EXIT_REVIEW_R5.failCutAfterMs,
      profitLockArmPct: EXIT_REVIEW_R5.profitLockArmPct,
      profitLockCapture: EXIT_REVIEW_R5.profitLockCapture,
    }),
    JSON.stringify({
      stopPct: 0.025, trailArmPct: 0.03, trailGapPct: 0.015, staleMs: 2_700_000,
      maxHoldMs: 21_600_000, riskCutArmPct: 0.01, riskCutLevelPct: 0.012,
      failCutAfterMs: 600_000, profitLockArmPct: 0.02, profitLockCapture: 0.5,
    }),
  );
});
