// The per-slot margin used to live in FOUR places that had to agree: the MARGIN
// constant in index.ts, trading_settings.binance_futures_allocation_usdt,
// leader-momentum-v17's POLICY.marginUsdt, and the targetMarginUsdt stamped on every
// generated signal. On 2026-09-16 the operator moved the slot 40 -> 30; the first two
// followed and the last two did not, so every signal written after the cutover
// carried targetMarginUsdt=40 while orders were sized for 30.
//
// Three of those four now read one contract. The fourth is the live DB, which must
// stay a runtime comparison: the executor refuses to trade when code and settings
// disagree (V17_MARGIN_CONFIG_MISMATCH), which fails as a FULL STOP on entries rather
// than as a silent resize. These tests pin both halves.
//
// index.ts cannot be imported here (it pulls supabase-js from a CDN), so the wiring is
// read from the source text. That is the point: this test exists to catch an edit.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SLOT_SIZING_CONTRACT, slotSizingBounds } from "../_shared/leader-slot-sizing.mjs";
import { entryFresh, POLICY } from "../_shared/leader-momentum-v17.mjs";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const GENERATOR = await Deno.readTextFile(
  new URL("../v10-lane-signal-generator/index.ts", import.meta.url),
);

Deno.test("margin: the executor declares no slot size of its own", () => {
  // A literal here is how the four copies drifted apart in the first place.
  assertEquals(
    SOURCE.match(/const MARGIN=\d/g),
    null,
    "MARGIN must be a view onto the contract, not a literal",
  );
  assert(
    /const MARGIN=SLOT_SIZING_CONTRACT\.targetMarginUsdt,LEV=SLOT_SIZING_CONTRACT\.leverage,NOTIONAL=MARGIN\*LEV;/
      .test(SOURCE),
    "the executor must read the slot from the contract",
  );
});

// CASE 14 -- what the signal generator stamps on every row it writes.
Deno.test("CASE 14: generated signals carry targetMarginUsdt = 30, from the contract", () => {
  assert(
    /targetMarginUsdt:POLICY\.marginUsdt/.test(GENERATOR),
    "the generator must stamp the policy's margin",
  );
  assertEquals(POLICY.marginUsdt, SLOT_SIZING_CONTRACT.targetMarginUsdt);
  assertEquals(POLICY.marginUsdt, 30, "operator instruction, 2026-09-16");
  assertEquals(POLICY.leverage, 3);
  assertEquals(POLICY.marginUsdt * POLICY.leverage, 90, "notional per slot");
});

// CASE 15 -- and it stamps WHICH contract, so a pre-resize row is identifiable.
Deno.test("CASE 15: executor and generator name the same sizing contract version", () => {
  assert(
    /sizingContractVersion:POLICY\.sizingContractVersion/.test(GENERATOR),
    "the generator must stamp the contract version on the signal",
  );
  assert(
    /sizing_contract_version:SLOT_SIZING_CONTRACT\.version/.test(SOURCE),
    "the executor must stamp the contract version on the order intent",
  );
  assertEquals(POLICY.sizingContractVersion, SLOT_SIZING_CONTRACT.version);
});

// CASE 12 / CASE 13 -- the code-vs-DB guard, which is the half that must NOT be
// unified away: a live settings row must never silently resize a running order.
Deno.test("CASE 12/13: the runtime guard comparing code to DB allocation is intact", () => {
  assert(SOURCE.includes("V17_MARGIN_CONFIG_MISMATCH"), "the code-vs-DB guard was removed");
  assert(
    /binance_futures_allocation_usdt\)-MARGIN\)>1e-9/.test(SOURCE),
    "the guard no longer compares the DB allocation against MARGIN",
  );
  // The comparison itself, run here on the values it is given.
  const guard = (dbAllocation: number) =>
    !Number.isFinite(Number(dbAllocation)) ||
      Math.abs(Number(dbAllocation) - SLOT_SIZING_CONTRACT.targetMarginUsdt) > 1e-9
      ? "V17_MARGIN_CONFIG_MISMATCH"
      : null;
  assertEquals(guard(40), "V17_MARGIN_CONFIG_MISMATCH", "CASE 12: DB 40 vs code 30 is refused");
  assertEquals(guard(30), null, "CASE 13: DB 30 vs code 30 proceeds");
  assertEquals(guard(Number.NaN), "V17_MARGIN_CONFIG_MISMATCH", "an unreadable setting fails closed");
});

Deno.test("margin: a 30 USDT slot still needs headroom above the cash buffer", () => {
  const margin = SLOT_SIZING_CONTRACT.targetMarginUsdt;
  const cashBuffer = Number(SOURCE.match(/ENTRY_CASH_BUFFER_USDT=(\.?\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const maxOrderMargin = slotSizingBounds(SLOT_SIZING_CONTRACT).maxOrderMarginUsdt;
  assert(Number.isFinite(cashBuffer));
  // The slot overshoot allowance is still 0.25 USDT, expressed relatively so it
  // survives the next resize instead of silently becoming a different fraction.
  assert(Math.abs(maxOrderMargin - 30.25) < 1e-9, `${maxOrderMargin}`);
  // Equity observed on 2026-09-16 was 38.3699 USDT. Record what this sizing
  // implies so the number is visible rather than inferred later.
  const equityObserved = 38.3699;
  const needed = maxOrderMargin + cashBuffer;
  assert(
    needed < equityObserved,
    `a ${margin} USDT slot needs ${needed.toFixed(4)} USDT, which must fit inside ` +
      `the observed ${equityObserved} equity for entries to resume`,
  );
  assert(margin * 2 > equityObserved, "two concurrent slots must not fit at this equity");
});

// CASE 7 / 8 / 9 -- the entry-age and drift policy is UNCHANGED by this work. The
// stale-signal fix is in scheduling, not in the threshold, so these pin the threshold.
Deno.test("CASE 8: a signal older than 120s is still SIGNAL_STALE_OR_FUTURE", () => {
  assertEquals(POLICY.maxEntryAgeMs, 120_000, "the entry-age policy must not be relaxed");
  const close = 1_000_000_000_000;
  const features = { strategy: "LEADER_MOMENTUM_V17", signal5Close: close, referenceClose: 100 };
  assertEquals(entryFresh(features, close + 120_001, 100), "SIGNAL_STALE_OR_FUTURE");
  assertEquals(entryFresh(features, close - 1, 100), "SIGNAL_STALE_OR_FUTURE", "no lookahead");
});

Deno.test("CASE 9: a signal inside 120s is not classified stale", () => {
  const close = 1_000_000_000_000;
  const features = { strategy: "LEADER_MOMENTUM_V17", signal5Close: close, referenceClose: 100 };
  assertEquals(entryFresh(features, close + 119_999, 100), null);
  assertEquals(entryFresh(features, close, 100), null);
  assertEquals(entryFresh(features, close + 120_000, 100), null, "the boundary is inclusive");
});

Deno.test("CASE 7: a price more than 1% from referenceClose is still ENTRY_DRIFT", () => {
  assertEquals(POLICY.maxEntryDriftPct, 0.01, "the drift limit must not be relaxed");
  const close = 1_000_000_000_000;
  const features = { strategy: "LEADER_MOMENTUM_V17", signal5Close: close, referenceClose: 100 };
  assertEquals(entryFresh(features, close + 1000, 101.01), "ENTRY_DRIFT");
  assertEquals(entryFresh(features, close + 1000, 98.99), "ENTRY_DRIFT");
  assertEquals(entryFresh(features, close + 1000, 100.99), null, "just inside 1% is allowed");
  // 101/100-1 is 0.010000000000000009 in float64, so the exact boundary lands on the
  // refusing side. Recorded rather than papered over: the limit is not widened here.
  assertEquals(entryFresh(features, close + 1000, 101), "ENTRY_DRIFT");
});

Deno.test("the sizing skips are symbol-scoped, so one bad symbol never halts the run", () => {
  const list = SOURCE.match(/const ENTRY_SKIP_SYMBOL_SCOPED=\/\^\(([^)]+)\)/)?.[1] ?? "";
  for (
    const reason of [
      "MIN_NOTIONAL_EXCEEDS_MARGIN_BUDGET",
      "QTY_STEP_EXCEEDS_MARGIN_BUDGET",
      "IOC_PRICE_CAP_EXCEEDED",
      "SIGNAL_STALE_OR_FUTURE",
      "ENTRY_DRIFT",
    ]
  ) {
    assert(list.includes(reason), `${reason} must be a symbol-scoped skip`);
  }
  // And the reasons the old code used are still recognised, for rows already written.
  for (const legacy of ["ENTRY_GRANULARITY_BPS", "ENTRY_SLOT_GRANULARITY_MARGIN"]) {
    assert(list.includes(legacy), `${legacy} must still classify pre-existing rows`);
  }
});
