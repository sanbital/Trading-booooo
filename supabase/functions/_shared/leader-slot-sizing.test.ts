// Regression cover for the 2026-09-16 slot resize that stopped every new entry,
// and pins for the 2026-09-24 margin-only resize (200 -> 150 USDT, leverage and
// MAX_SLOTS unchanged) that followed it.
//
// The executor moved from a 40 USDT slot (120 notional) to a 30 USDT slot (90
// notional). Nothing about the market changed. What changed is that the old sizing
// funded a FIXED 0.12 USDT notional buffer by RAISING the limit price, under a
// RELATIVE 12 bps cap:
//
//     requiredUpliftBps = 0.12 / sizedNotional * 10_000
//
// At 120 that is at most 10 bps -- under the cap, never fires. At 90 it is at most
// 13.33 bps -- over the cap. Between 2026-09-16 23:09 and 2026-09-17 13:05 that
// produced 20 ENTRY_GRANULARITY_BPS refusals at 12.479-13.199 bps, on symbols whose
// quantity step was fine enough that they should have been the EASIEST to size.
//
// The tests below pin both halves: an ordinary candidate is never refused by the
// arithmetic, and a genuinely unaffordable one still is, with a reason naming which.
// Every test against the PRODUCTION contract (i.e. not SLOT_40) now runs at the
// current 150 USDT / 3x slot: targetNotionalUsdt=450, maxOrderMarginUsdt=151.25
// (150 * (1 + (250/3)/10_000)), minOrderNotionalUsdt=225. The relative buffer and
// overshoot bps are unchanged by the resize, which is the point of expressing them
// relatively; only the USDT figures they resolve to have moved.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSlotSizingContract,
  ceilStep,
  ceilTick,
  floorStep,
  planSlotEntry,
  SLOT_SIZING_CONTRACT,
  SLOT_SIZING_REASON,
  SlotSizingError,
  slotSizingBounds,
} from "./leader-slot-sizing.mjs";
import { POLICY } from "./leader-momentum-v17.mjs";

/** The 40 USDT slot as it actually ran, for parity checks. 0.25/40 = 62.5 bps. */
// deno-lint-ignore no-explicit-any
const SLOT_40: any = Object.freeze({
  ...SLOT_SIZING_CONTRACT,
  targetMarginUsdt: 40,
  maxSlotOvershootBps: 62.5,
});

/** The refused-by-arithmetic check, exactly as the old executor computed it. */
function legacyRequiredUpliftBps(sizedNotionalUsdt: number, targetNotionalUsdt: number) {
  return ((targetNotionalUsdt + 0.12) / sizedNotionalUsdt - 1) * 10_000;
}

function skipReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as SlotSizingError).code ?? String(error);
  }
  throw new Error("expected a skip, got a plan");
}

Deno.test("the contract's structural invariants hold", () => {
  const checks = assertSlotSizingContract();
  assert(checks.length > 0);
  for (const check of checks) assert(check.ok, `${check.name} ${check.detail}`);
});

Deno.test("the 40 -> 30 regression is representable, and the contract refuses it", () => {
  // The exact arithmetic that broke production, stated as a property.
  assertEquals(Math.round(legacyRequiredUpliftBps(120, 120) * 100) / 100, 10);
  assertEquals(Math.round(legacyRequiredUpliftBps(90, 90) * 100) / 100, 13.33);
  assert(legacyRequiredUpliftBps(120, 120) <= SLOT_SIZING_CONTRACT.iocMaxBps, "safe at 120");
  assert(legacyRequiredUpliftBps(90, 90) > SLOT_SIZING_CONTRACT.iocMaxBps, "self-refusing at 90");
  // A contract whose buffer is paid for with price is rejected at assert time.
  assertEquals(
    skipReason(() =>
      assertSlotSizingContract({ ...SLOT_SIZING_CONTRACT, iocBaseBps: 13, iocMaxBps: 12 } as never)
    ),
    "SLOT_SIZING_CONTRACT_INVALID",
  );
});

// CASE 1 -- the previous slot still sizes an ordinary symbol, at its own budget.
Deno.test("CASE 1: a 40 USDT slot at 3x still admits an ordinary fine-step symbol", () => {
  const plan = planSlotEntry(
    { ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 5 },
    SLOT_40,
  );
  assertEquals(plan.targetNotionalUsdt, 120);
  assert(plan.referenceNotionalUsdt >= 120, "the slot is fully deployed");
  assert(plan.orderMarginUsdt <= 40.25 + 1e-9, "still inside the 0.25 USDT allowance");
  // And the legacy path would have admitted it too: the parity that matters is the
  // verdict, not the quantity -- the quantity now carries the buffer the price used to.
  assert(legacyRequiredUpliftBps(plan.referenceNotionalUsdt, 120) <= SLOT_40.iocMaxBps);
});

// CASE 2 -- the production slot, ordinary symbol.
Deno.test("CASE 2: a 150 USDT slot at 3x sizes a fine-step symbol normally", () => {
  const plan = planSlotEntry({ ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 5 });
  assertEquals(plan.targetNotionalUsdt, 450);
  assert(plan.referenceNotionalUsdt >= 450);
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9);
  assertEquals(plan.boundBy, "TARGET_NOTIONAL");
  assert(Math.abs(plan.quantity - 4.5) < 0.01, `TEST 3: quantity ${plan.quantity} must be ~4.5`);
});

// CASE 3 -- the band the 0.12 USDT buffer made unreachable.
Deno.test("CASE 3: no ask can make the contract refuse itself on price", () => {
  // Sweep the whole band where the old code needed 12-13.33 bps and refused, plus a
  // wide spread of ordinary asks and steps. Not one may produce a price-capped skip.
  let checked = 0;
  for (const step of [1, 0.1, 0.01, 0.001]) {
    for (let i = 0; i < 400; i++) {
      const ask = 0.0009 * (1 + i / 97) + step * 1e-6;
      const plan = planSlotEntry({ ask, quantityStep: step, priceTick: 0, minNotionalUsdt: 5 });
      assert(
        plan.iocBps <= SLOT_SIZING_CONTRACT.iocMaxBps,
        `${ask} needed ${plan.iocBps} bps`,
      );
      assert(
        Math.abs(plan.iocBps - SLOT_SIZING_CONTRACT.iocBaseBps) < 1e-6,
        `sizing must cost no uplift, got ${plan.iocBps}`,
      );
      assert(plan.referenceNotionalUsdt >= 450, "and the slot is still filled");
      checked++;
    }
  }
  assert(checked >= 1600);
});

// CASE 4 / CASE 5 -- the coarse-step boundary stays exactly where it was, in
// RELATIVE terms; the USDT ceiling it is measured against is now 151.25.
Deno.test("CASE 4: a coarse step inside the 151.25 USDT allowance is admitted", () => {
  // step*ask = 1.50 USDT of notional: the ceil can overshoot 450 by at most 1.50,
  // i.e. ~150.55 USDT of margin, inside the allowance.
  const plan = planSlotEntry({ ask: 1.5, quantityStep: 1, priceTick: 0.0001, minNotionalUsdt: 5 });
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9, `${plan.orderMarginUsdt}`);
  assert(plan.orderMarginUsdt > 150, "it does overshoot -- that is the point");
});

Deno.test("CASE 5: a coarse step past the allowance takes the lot below it", () => {
  // A step of 1 at 19.20 USDT: naive ceil(450.45/19.2)=24 lots costs 24*19.206/3 =
  // 153.648 USDT of margin, over the 151.25 ceiling. This used to end the symbol,
  // on the claim that the lot was unaffordable. It is not: 23 lots cost about 147.25 USDT
  // of margin, satisfy every exchange filter and carry about 98.1% of the slot. The
  // ceiling is what makes that admission safe, and it has not moved.
  const plan = planSlotEntry({ ask: 19.2, quantityStep: 1, priceTick: 0.001, minNotionalUsdt: 5 });
  assertEquals(plan.quantity, 23);
  assertEquals(plan.boundBy, "MARGIN_BUDGET_CAP");
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9, `${plan.orderMarginUsdt}`);
  assert(plan.slotFillBps > 9_800, `${plan.slotFillBps}`);
  // And the point that used to be the only one considered still overshoots, so this
  // is a wider search rather than a wider budget.
  assertEquals(24 * plan.limitPrice / 3 > slotSizingBounds().maxOrderMarginUsdt, true);
});

Deno.test("CASE 5b: a lot the slot cannot afford at ALL is still refused", () => {
  // The search only ever walks DOWN, so when even one lot is over the ceiling there
  // is nowhere to walk to. At 500 USDT a single lot needs ~166.72 against 151.25.
  const reason = skipReason(() =>
    planSlotEntry({ ask: 500, quantityStep: 1, priceTick: 0.01, minNotionalUsdt: 5 })
  );
  assertEquals(reason, SLOT_SIZING_REASON.QTY_STEP_EXCEEDS_MARGIN_BUDGET);
});

// CASE 6 -- an exchange minimum the slot cannot pay for.
Deno.test("CASE 6: a min notional above the slot budget is its own distinct skip", () => {
  const reason = skipReason(() =>
    planSlotEntry({ ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 1300 })
  );
  assertEquals(reason, SLOT_SIZING_REASON.MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET);
  // Distinct from the coarse-step skip: the two need different operator answers, so
  // they must never collapse into one code.
  assertEquals(
    new Set(Object.values(SLOT_SIZING_REASON)).size,
    Object.values(SLOT_SIZING_REASON).length,
    "every sizing reason names exactly one cause",
  );
});

Deno.test("a min quantity above the slot budget is reported as the exchange's minimum", () => {
  const reason = skipReason(() =>
    planSlotEntry({ ask: 100, quantityStep: 0.1, priceTick: 0.01, minNotionalUsdt: 5, minQuantity: 7 })
  );
  assertEquals(reason, SLOT_SIZING_REASON.MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET);
});

// CASE 16 / CASE 17 -- the two ends of the price range.
Deno.test("CASE 16: a low-price symbol rounds on its real lot step", () => {
  const plan = planSlotEntry({ ask: 0.0009023, quantityStep: 1, priceTick: 0.0000001, minNotionalUsdt: 5 });
  assertEquals(plan.quantity, ceilStep(slotSizingBounds().requiredNotionalUsdt / 0.0009023, 1));
  assertEquals(plan.quantity % 1, 0, "a whole number of lots");
  assert(plan.referenceNotionalUsdt >= 450);
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9);
});

Deno.test("CASE 17: a high-price symbol sizes on its own lot step, both ways", () => {
  // Fine enough step for the slot: 0.00001 x 64000 = 0.64 USDT of notional per lot,
  // well inside the 1.6667 USDT the slot may overshoot by. Admitted.
  const plan = planSlotEntry({ ask: 64000, quantityStep: 0.00001, priceTick: 0.1, minNotionalUsdt: 5 });
  assert(plan.referenceNotionalUsdt >= 450);
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9, `${plan.orderMarginUsdt}`);
  assert(plan.quantity * plan.limitPrice >= 5, "the exchange minimum is met at the ORDER price");

  // BTC's real 0.001 step at the same price is 64 USDT of notional per lot. A 650
  // USDT min-notional filter (roughly BTC's own minimum at this price) forces the
  // quantity up to where a 150 USDT slot cannot follow -- not because the step is
  // coarse, but because the exchange's own minimum outruns the budget. The refusal
  // names the binding constraint, because a coarse step and an unaffordable listing
  // need different operator answers.
  let refused = "";
  try {
    planSlotEntry({ ask: 64000, quantityStep: 0.001, priceTick: 0.1, minNotionalUsdt: 500 });
  } catch (error) {
    refused = String((error as SlotSizingError).message);
  }
  // Field 2 is still the margin the order would need. The labelled fields after it
  // are the ceiling that was exceeded and the lot step in force, so the refusal can
  // be read without recomputing the contract by hand.
  assertEquals(
    refused,
    "MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET:170.717867:max=151.250000:step=0.001:qty=0.008:px=64019.2",
  );
  // Without that filter the same step sizes multiple lots up toward the target.
  const coarse = planSlotEntry({ ask: 64000, quantityStep: 0.001, priceTick: 0.1, minNotionalUsdt: 5 });
  assertEquals(coarse.quantity, 0.007);
  assert(coarse.orderMarginUsdt <= 151.25 + 1e-9, `${coarse.orderMarginUsdt}`);
  assert(coarse.slotFillBps >= SLOT_SIZING_CONTRACT.minSlotFillBps, `${coarse.slotFillBps}`);
});

// CASE 5's shape (one lot below the point that overshot), re-derived for the
// current 150 USDT / 3x slot. Every QTY_STEP_EXCEEDS_MARGIN_BUDGET refusal a naive
// single-point sizer produces comes from evaluating exactly ONE point on the
// quantity lattice -- ceil(requiredNotional / ask) -- and ending the symbol when
// that point sits above the margin ceiling, instead of walking down to the largest
// admissible one. At ask 22.00, step 1: the naive point (21 lots) costs
// 21 * 22.0066 / 3 = 154.05 USDT of margin against a 151.25 ceiling; the lattice
// point below it (20 lots) costs 146.71 USDT and carries 99% of the slot.
Deno.test("one lot below the point that overshot is admitted, not refused", () => {
  const bounds = slotSizingBounds();
  const plan = planSlotEntry({ ask: 22.0, quantityStep: 1, priceTick: 0.0001, minNotionalUsdt: 5 });
  assertEquals(plan.quantity, 20);
  assertEquals(plan.boundBy, "MARGIN_BUDGET_CAP");
  assertEquals(plan.limitPrice, 22.0066);
  // The naive point is reproduced exactly, and is still over the ceiling: the
  // budget did not move, the search did.
  assertEquals(21 * plan.limitPrice / 3 > bounds.maxOrderMarginUsdt, true);
  assertEquals(plan.orderMarginUsdt <= bounds.maxOrderMarginUsdt + 1e-9, true);
  // It undershoots the target, which is exactly what the slot-fill floor is there to
  // bound -- and it is nowhere near it.
  assertEquals(20 * 22.0 < bounds.requiredNotionalUsdt, true);
  assert(plan.referenceNotionalUsdt >= bounds.minOrderNotionalUsdt, `${plan.referenceNotionalUsdt}`);
  assert(plan.slotFillBps > 9_700, `${plan.slotFillBps}`);
});

Deno.test("an exchange minimum above the target, but inside the budget, is honoured", () => {
  // The min-notional filter binds the quantity upward, and is measured against the
  // order's own price, which is what the exchange validates.
  const plan = planSlotEntry({ ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 452 });
  assertEquals(plan.boundBy, "EXCHANGE_MIN_NOTIONAL");
  assert(plan.orderNotionalUsdt >= 452, `${plan.orderNotionalUsdt}`);
  assert(plan.orderMarginUsdt <= 151.25 + 1e-9);
});

// CASE 14 / CASE 15 -- one contract, read by everything that sizes.
Deno.test("CASE 14/15: the V17 policy reads the slot from the contract, not a copy", () => {
  assertEquals(POLICY.marginUsdt, SLOT_SIZING_CONTRACT.targetMarginUsdt);
  assertEquals(POLICY.leverage, SLOT_SIZING_CONTRACT.leverage);
  assertEquals(POLICY.sizingContractVersion, SLOT_SIZING_CONTRACT.version);
  // The number the signal generator stamps on every row it writes.
  assertEquals(POLICY.marginUsdt, 150);
});

Deno.test("price rounding is separate from quantity rounding and goes UP for a BUY", () => {
  assertEquals(ceilTick(0.0009023 * 1.0003, 0.0000001), 0.0009026);
  assertEquals(ceilTick(100, 0.01), 100);
  assertEquals(ceilTick(100.001, 0.01), 100.01, "never below the marketable price");
  // No tick filter means no rounding, not a silent default tick.
  assertEquals(ceilTick(100.00123, 0), 100.00123);
  // Quantity rounds on the lot step, in both directions, per side.
  assertEquals(ceilStep(1.0001, 0.001), 1.001);
  assertEquals(floorStep(1.0019, 0.001), 1.001);
});

Deno.test("a tick so coarse it prices the BUY past the cap is its own skip", () => {
  // 1 USDT tick on a 100 USDT ask: the smallest valid marketable price is 101,
  // which is 100 bps above the ask. Paying that is not sizing's call to make.
  const reason = skipReason(() =>
    planSlotEntry({ ask: 100.0001, quantityStep: 0.001, priceTick: 1, minNotionalUsdt: 5 })
  );
  assertEquals(reason, SLOT_SIZING_REASON.IOC_PRICE_CAP_EXCEEDED);
});

Deno.test("invalid inputs are refused rather than sized around", () => {
  for (
    const bad of [
      { ask: 0, quantityStep: 1 },
      { ask: 100, quantityStep: 0 },
      { ask: Number.NaN, quantityStep: 1 },
      { ask: 100, quantityStep: 1, priceTick: -1 },
      { ask: 100, quantityStep: 1, minNotionalUsdt: -5 },
    ]
  ) {
    assertEquals(skipReason(() => planSlotEntry(bad)), SLOT_SIZING_REASON.INPUT_INVALID);
  }
});

Deno.test("the budget is charged at the order's own price, not at the ask", () => {
  // Every lot could fill at the cap, so that is the margin the slot must be able
  // to afford. Charging it at the ask would understate the requirement.
  const plan = planSlotEntry({ ask: 100, quantityStep: 0.001, priceTick: 0.01, minNotionalUsdt: 5 });
  assert(plan.orderMarginUsdt >= plan.referenceMarginUsdt);
  assertEquals(plan.orderNotionalUsdt, plan.quantity * plan.limitPrice);
  assertEquals(plan.orderMarginUsdt, plan.orderNotionalUsdt / SLOT_SIZING_CONTRACT.leverage);
});
