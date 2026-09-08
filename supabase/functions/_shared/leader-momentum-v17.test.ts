// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextExit, POLICY } from "./leader-momentum-v17.mjs";

const MIN = 60_000;
const AT = 1_788_834_000_000;
const ENTRY = 100;

// Walks a bid series through nextExit exactly as the executor does: peak, stop and lastHighAt
// are read back from the previous decision. Returns the first CLOSE, or null if it held.
function walk(bids: number[], policy = POLICY, stepMs = MIN) {
  let state = {
    entryPrice: ENTRY,
    entryAt: AT,
    peakPrice: ENTRY,
    stopPrice: ENTRY * (1 - policy.stopPct),
    lastHighAt: AT,
  };
  for (let i = 0; i < bids.length; i++) {
    const now = AT + (i + 1) * stepMs;
    const s = nextExit(state, bids[i], now, policy);
    if (s.action === "CLOSE") return { ...s, minute: i + 1, priceReturn: bids[i] / ENTRY - 1 };
    state = { ...state, peakPrice: s.peakPrice, stopPrice: s.stopPrice, lastHighAt: s.lastHighAt };
  }
  return null;
}

Deno.test("hard stop still fires at stopPct when the trade never shows profit", () => {
  const hit = walk([99.5, 99, 98, 97.4]);
  assertEquals(hit?.reason, "V17_HARD_STOP");
  assertEquals(hit?.minute, 4);
});

Deno.test("cost cap engages at lockArmPct and caps the loss at lockGivebackPct", () => {
  // Reaches +2.1% (>= lockArmPct .02) but never the .03 trail arm, then rolls over. Before the
  // cost cap this ran all the way to the -2.5% hard stop; this is the USELESSUSDT 06:16 loss.
  const hit = walk([100.9, 101.2, 102.1, 100.8, 99.9, 99.5]);
  assertEquals(hit?.reason, "V17_COST_CAP_STOP");
  assert(hit!.priceReturn > -POLICY.lockGivebackPct - 0.006, "capped well above the hard stop");
  assert(hit!.priceReturn < 0);
});

Deno.test("cost cap never arms below lockArmPct", () => {
  // Peaks at +1.9%, just under the cap. The hard stop remains the only floor.
  const hit = walk([101.9, 101, 100, 99, 98, 97.4]);
  assertEquals(hit?.reason, "V17_HARD_STOP");
});

Deno.test("the trail still overrides the cost cap once armed", () => {
  const hit = walk([103.5, 105, 106, 104.2, 103.9]);
  assertEquals(hit?.reason, "V17_TRAILING_STOP");
  // 106 peak, 1.5% gap -> 104.41, so the 104.2 tick closes it in profit.
  assertEquals(hit?.minute, 4);
  assert(hit!.priceReturn > 0.03);
});

Deno.test("no-progress closes a stalled entry near cost once noProgressMs elapses", () => {
  // 25 minutes of chop inside +/-1%. This is the INJ/AERO/AKE pattern: peak MFE never reaches
  // noProgressMfePct, so the momentum thesis is dead well before the -2.5% stop is reached.
  const bids = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 ? 0.5 : -0.4));
  const hit = walk(bids);
  assertEquals(hit?.reason, "V17_NO_PROGRESS");
  // Minute 20 is the deadline but the series is green there, so the close lands on minute 21 —
  // the first red evaluation at or after the deadline.
  assertEquals(hit?.minute, 21);
  assert(hit!.priceReturn > -0.01, "exits near cost, not at the hard stop");
});

Deno.test("no-progress does not cut a position that is green at the deadline", () => {
  // Same flat MFE, but the bid is above entry when the clock runs out: the engine holds.
  const bids = Array.from({ length: 22 }, () => 100.4);
  assertEquals(walk(bids), null);
});

Deno.test("no-progress does not cut a position that has already made its move", () => {
  // MFE clears lockArmPct early, so the clock never applies: the cap closes it, not the deadline.
  const hit = walk([100.2, 102.2, 101.5, ...Array.from({ length: 20 }, () => 99.6)]);
  assertEquals(hit?.reason, "V17_COST_CAP_STOP");
  assertEquals(hit?.minute, 4, "closed by the cap on the first red tick, long before the deadline");
});

Deno.test("a position between noProgressMfePct and lockArmPct is left alone by both rules", () => {
  // Peak +1.8% clears the no-progress bar but not the cost cap, so only the hard stop applies.
  // This gap is deliberate: it is the band where the trade is still working but unprotected.
  assertEquals(walk([100.2, 101.8, 101.5, ...Array.from({ length: 20 }, () => 99.6)]), null);
});

Deno.test("stops only ratchet upward across evaluations", () => {
  let state = { entryPrice: ENTRY, entryAt: AT, peakPrice: ENTRY, stopPrice: ENTRY * (1 - POLICY.stopPct), lastHighAt: AT };
  let previous = state.stopPrice;
  for (const [i, bid] of [101, 104, 106, 103.5, 101.5].entries()) {
    const s = nextExit(state, bid, AT + (i + 1) * MIN, POLICY);
    assert(s.stopPrice >= previous - 1e-12, `stop fell from ${previous} to ${s.stopPrice}`);
    previous = s.stopPrice;
    if (s.action === "CLOSE") break;
    state = { ...state, peakPrice: s.peakPrice, stopPrice: s.stopPrice, lastHighAt: s.lastHighAt };
  }
});

Deno.test("max hold and momentum stale still take precedence over holding", () => {
  const base = { entryPrice: ENTRY, entryAt: AT, peakPrice: ENTRY, stopPrice: ENTRY * (1 - POLICY.stopPct), lastHighAt: AT };
  // Green, so no-progress cannot fire; only the stale clock is left.
  const stale = nextExit({ ...base, peakPrice: 105 }, 104, AT + POLICY.staleMs, POLICY);
  assertEquals(stale.reason, "V17_MOMENTUM_STALE");
  const held = nextExit({ ...base, peakPrice: 105, lastHighAt: AT + POLICY.maxHoldMs }, 104, AT + POLICY.maxHoldMs, POLICY);
  assertEquals(held.reason, "V17_MAX_HOLD");
});

Deno.test("policy tiers are validated so the floors cannot reorder", () => {
  const pos = { entryPrice: ENTRY, entryAt: AT, peakPrice: ENTRY, stopPrice: 97.5, lastHighAt: AT };
  const bad = [
    { ...POLICY, lockArmPct: POLICY.trailArmPct + 0.001 }, // cap above the trail arm
    { ...POLICY, lockGivebackPct: POLICY.stopPct }, // cap floor at/below the hard stop
    { ...POLICY, lockGivebackPct: -0.001 },
    { ...POLICY, noProgressMs: 0 },
    { ...POLICY, noProgressMs: POLICY.maxHoldMs },
    { ...POLICY, noProgressMfePct: 0 },
  ];
  for (const p of bad) {
    let threw = "";
    try {
      nextExit(pos, 100, AT + MIN, p);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assertEquals(threw, "INVALID_EXIT_STATE");
  }
});

Deno.test("POLICY keeps the cost cap strictly between the hard stop and the trail arm", () => {
  assert(POLICY.lockGivebackPct < POLICY.stopPct);
  assert(POLICY.lockArmPct <= POLICY.trailArmPct);
  assert(POLICY.noProgressMs < POLICY.maxHoldMs);
});
