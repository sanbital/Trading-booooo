// Regression cover for the 2026-09-19 operator instruction: keep the number of
// concurrent entry slots and the leverage exactly as they were, and change only
// the target margin one slot posts, from 30 to 200 USDT. This file exists
// because that instruction has two failure modes an ordinary "change the
// constant" edit would not catch:
//
//   - MAX_SLOTS or leverage drifting along with the margin edit (they must not);
//   - a duplicate sizing multiplier stacking on top of the contract, e.g. the
//     margin being applied twice (200 * leverage * leverage) or a retry
//     re-sizing and re-dispatching the same signal as a second order.
//
// index.ts cannot be imported here (it pulls supabase-js from a CDN), so MAX_SLOTS
// and leverage are read from the source text, exactly like margin-config.test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planSlotEntry, SLOT_SIZING_CONTRACT, slotSizingBounds } from "../_shared/leader-slot-sizing.mjs";
import { POLICY } from "../_shared/leader-momentum-v17.mjs";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// TEST 1 -- max concurrent slots is unchanged by this margin-only resize.
Deno.test("TEST 1: MAX_SLOTS is unchanged at 10", () => {
  const maxSlots = Number(SOURCE.match(/const MAX_SLOTS=(\d+)/)?.[1] ?? NaN);
  assertEquals(maxSlots, 10, "the operator instruction keeps slot count as-is");
  assertEquals(POLICY.maxSlots, 10, "the policy's own copy must agree");
});

// TEST 2 -- leverage is unchanged by this margin-only resize.
Deno.test("TEST 2: leverage is unchanged at 3x", () => {
  assertEquals(SLOT_SIZING_CONTRACT.leverage, 3, "the operator instruction keeps leverage as-is");
  assertEquals(POLICY.leverage, 3, "the policy's own copy must agree");
  assert(
    /const MARGIN=SLOT_SIZING_CONTRACT\.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT\.leverage,NOTIONAL=MARGIN\*LEV;/
      .test(SOURCE),
    "the executor must read leverage from the contract, not a literal",
  );
});

// TEST 3 -- leverage 3x, a 100 USDT symbol: target notional ~600, quantity ~6.
Deno.test("TEST 3: a 100 USDT symbol at 3x sizes to ~600 USDT notional, ~6 quantity", () => {
  const plan = planSlotEntry({ ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 5 });
  assertEquals(plan.targetNotionalUsdt, 600);
  assert(Math.abs(plan.quantity - 6) < 0.01, `quantity ${plan.quantity} must be ~6`);
  assert(Math.abs(plan.referenceNotionalUsdt - 600) < 1, `notional ${plan.referenceNotionalUsdt} must be ~600`);
  assert(plan.orderMarginUsdt <= slotSizingBounds().maxOrderMarginUsdt + 1e-9);
});

// TEST 4 -- a 2 USDT symbol: target notional ~600, quantity ~300, stepSize-normalised.
Deno.test("TEST 4: a 2 USDT symbol at 3x sizes to ~600 USDT notional, ~300 quantity", () => {
  const plan = planSlotEntry({ ask: 2, quantityStep: 0.01, priceTick: 0.0001, minNotionalUsdt: 5 });
  assertEquals(plan.targetNotionalUsdt, 600);
  assert(Math.abs(plan.quantity - 300) < 1, `quantity ${plan.quantity} must be ~300`);
  // Exchange stepSize normalisation: the quantity must be an exact multiple of the step.
  const remainder = Math.abs(plan.quantity / 0.01 - Math.round(plan.quantity / 0.01));
  assertEquals(remainder < 1e-9, true, "quantity must be stepSize-aligned");
  assert(plan.orderMarginUsdt <= slotSizingBounds().maxOrderMarginUsdt + 1e-9);
});

// TEST 7 -- a retry must not stack a second multiplier and must not dispatch a
// second order. Sizing is a pure function of (ask, filters), so the same signal
// sized twice -- as a retry would -- produces the identical quantity, never
// 200 * leverage * leverage or any other compounding. Duplicate dispatch itself
// is prevented downstream by the deterministic client order id derived from the
// signal id (see cid(), which does not depend on quantity or margin at all), so
// a retried dispatch reuses the same identifier rather than creating a new order.
Deno.test("TEST 7: re-sizing the same signal on retry is idempotent, not compounding", () => {
  const input = { ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 5 };
  const first = planSlotEntry(input);
  const second = planSlotEntry(input);
  assertEquals(second.quantity, first.quantity, "retry must size identically, not stack a multiplier");
  assertEquals(second.orderMarginUsdt, first.orderMarginUsdt);
  // The margin actually charged is bounded at ~1x the configured slot, never
  // margin * leverage * leverage (a classic double-apply bug).
  const doubled = SLOT_SIZING_CONTRACT.targetMarginUsdt * SLOT_SIZING_CONTRACT.leverage *
    SLOT_SIZING_CONTRACT.leverage;
  assert(first.orderMarginUsdt < doubled, "margin must not be leverage-multiplied twice");
  assert(
    first.orderMarginUsdt <= slotSizingBounds().maxOrderMarginUsdt + 1e-9,
    "margin must stay within the single configured slot ceiling",
  );

  // The dispatch identifier is a pure function of the signal id alone.
  const cidSrc = SOURCE.match(/function cid\(p,x\)\{([^}]+)\}/)?.[1] ?? "";
  assert(cidSrc.length > 0, "cid() must exist");
  assert(!/quantity|amount|margin/i.test(cidSrc), "the order identifier must not depend on sizing");
});

// Cross-check: the fixed 200-per-slot example from the operator instruction,
// end to end against the contract's own bounds (no exchange filters binding).
Deno.test("a 200 USDT slot at 3x targets exactly 600 USDT notional", () => {
  const bounds = slotSizingBounds();
  assertEquals(bounds.targetNotionalUsdt, 600);
  assertEquals(SLOT_SIZING_CONTRACT.targetMarginUsdt, 200);
  assertEquals(SLOT_SIZING_CONTRACT.targetMarginUsdt * SLOT_SIZING_CONTRACT.leverage, 600);
});
