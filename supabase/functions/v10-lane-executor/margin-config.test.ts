// The per-slot margin lives in TWO places that must agree: the MARGIN constant
// in index.ts and trading_settings.binance_futures_allocation_usdt. The executor
// enforces the agreement at runtime (V17_MARGIN_CONFIG_MISMATCH), which fails
// safe -- but it fails as a FULL STOP on entries, not as a resize. Changing one
// without the other therefore silently halts the bot.
//
// index.ts cannot be imported here (it pulls supabase-js from a CDN), so the
// constant is read from the source text. That is the point: this test exists to
// catch an edit, and an edit is a text change.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SOURCE = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

/** The single declaration of per-slot margin and leverage. */
function readConstants() {
  const m = SOURCE.match(/const MARGIN=(\d+(?:\.\d+)?),LEV=(\d+(?:\.\d+)?),NOTIONAL=MARGIN\*LEV/);
  if (!m) throw new Error("MARGIN/LEV declaration not found or reshaped");
  return { margin: Number(m[1]), lev: Number(m[2]) };
}

Deno.test("margin: the declaration exists exactly once and parses", () => {
  const occurrences = SOURCE.match(/const MARGIN=/g) ?? [];
  assertEquals(occurrences.length, 1, "MARGIN must be declared exactly once");
  const { margin, lev } = readConstants();
  assert(Number.isFinite(margin) && margin > 0);
  assert(Number.isFinite(lev) && lev > 0);
});

Deno.test("margin: the operator-agreed per-slot size is 30 USDT at 3x", () => {
  const { margin, lev } = readConstants();
  // Operator instruction, 2026-09-16: reduce per-slot margin 40 -> 30.
  // If this is changed again, trading_settings.binance_futures_allocation_usdt
  // MUST be updated in the same cutover or every entry stops.
  assertEquals(margin, 30);
  assertEquals(lev, 3);
  assertEquals(margin * lev, 90, "notional per slot");
});

Deno.test("margin: the runtime guard comparing code to DB is still present", () => {
  // If this guard is ever removed, the code and the DB can silently disagree
  // and the executor will size from the constant while the operator believes
  // the DB value is in force.
  assert(
    SOURCE.includes("V17_MARGIN_CONFIG_MISMATCH"),
    "the code-vs-DB margin guard was removed",
  );
  assert(
    /binance_futures_allocation_usdt\)-MARGIN\)>1e-9/.test(SOURCE),
    "the guard no longer compares the DB allocation against MARGIN",
  );
});

Deno.test("margin: a 30 USDT slot still needs headroom above the cash buffer", () => {
  const { margin, lev } = readConstants();
  const buffer = Number(SOURCE.match(/ENTRY_CASH_BUFFER_USDT=(\.?\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const marginBuffer = Number(SOURCE.match(/MAX_MARGIN_BUFFER_USDT=(\.?\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  assert(Number.isFinite(buffer) && Number.isFinite(marginBuffer));
  // Equity observed on 2026-09-16 was 38.3699 USDT. Record what this sizing
  // implies so the number is visible rather than inferred later.
  const equityObserved = 38.3699;
  const needed = margin + marginBuffer + buffer;
  assert(
    needed < equityObserved,
    `a ${margin} USDT slot needs ${needed.toFixed(4)} USDT, which must fit inside ` +
      `the observed ${equityObserved} equity for entries to resume`,
  );
  // And only one slot fits: 2 x 30 = 60 > 38.37.
  assert(margin * 2 > equityObserved, "two concurrent slots must not fit at this equity");
  assertEquals(margin * lev, 90);
});
