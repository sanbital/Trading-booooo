import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  committedRegimeOf,
  instantaneousRegimeOf,
  REGIME_BANDS,
  REGIME_DWELL,
} from "./regime-hysteresis.ts";

Deno.test("cold start falls back to the unsmoothed classifier", () => {
  assertEquals(committedRegimeOf(59, null, []), "BULL");
  assertEquals(committedRegimeOf(59, "BULL", []), "BULL");
  assertEquals(committedRegimeOf(41, undefined, [41]), "RISK_OFF");
  assertEquals(committedRegimeOf(59, "NOT_A_REGIME", [59]), "BULL");
});

Deno.test("a score inside the band holds the committed label on both sides", () => {
  // 59 sits above the 58 predicted threshold but below the 60 ground truth: neither side moves.
  assertEquals(committedRegimeOf(59, "NEUTRAL", [59]), "NEUTRAL");
  assertEquals(committedRegimeOf(59, "BULL", [59]), "BULL");
  assertEquals(committedRegimeOf(41, "NEUTRAL", [41]), "NEUTRAL");
  assertEquals(committedRegimeOf(41, "RISK_OFF", [41]), "RISK_OFF");
});

Deno.test("promotion needs the ground truth threshold on every dwell observation", () => {
  assertEquals(committedRegimeOf(61, "NEUTRAL", [59]), "NEUTRAL");
  assertEquals(committedRegimeOf(61, "NEUTRAL", [61]), "BULL");
  assertEquals(committedRegimeOf(76, "BULL", [70]), "BULL");
  assertEquals(committedRegimeOf(76, "BULL", [75]), "STRONG_BULL");
});

Deno.test("demotion needs the predicted threshold on every dwell observation", () => {
  assertEquals(committedRegimeOf(57, "BULL", [59]), "BULL");
  assertEquals(committedRegimeOf(57, "BULL", [57]), "NEUTRAL");
  assertEquals(committedRegimeOf(39, "NEUTRAL", [41]), "NEUTRAL");
  assertEquals(committedRegimeOf(39, "NEUTRAL", [39]), "RISK_OFF");
});

/** Walks a score path the way the observer does, newest score first in the prior window. */
function walk(path: readonly number[], seed: number, committed = "NEUTRAL") {
  let previous: number[] = [seed], flips = 0;
  const labels = path.map((score) => {
    const next = committedRegimeOf(score, committed, previous);
    if (next !== committed) flips++;
    committed = next;
    previous = [score, ...previous];
    return committed;
  });
  return { labels, flips, committed };
}

Deno.test("the live oscillation that motivated the band no longer relabels the market", () => {
  // 2026-09-01 06:00-07:15 UTC: 60.2 -> 52.6 -> 47.7 crossed the 58 line inside twenty minutes,
  // out of a market that had been printing in the low 50s.
  const observed = [60.2, 52.6, 47.7];
  const banded = walk(observed, 54);
  // The lone 60.2 print no longer opens a BULL lane on its own.
  assertEquals(banded.committed, "NEUTRAL");
  assertEquals(banded.flips, 0);
  // Without the band the same series relabels the market on the way up and again on the way down.
  const stepped = [54, ...observed].map(instantaneousRegimeOf);
  assertEquals(stepped, ["NEUTRAL", "BULL", "NEUTRAL", "NEUTRAL"]);
});

Deno.test("a sustained move still promotes, it is only delayed by the dwell", () => {
  assertEquals(walk([61, 62, 63], 54).labels, ["NEUTRAL", "BULL", "BULL"]);
  // And a sustained collapse still demotes on the second confirming observation.
  // A collapse demotes one boundary at a time, each on its own second confirming observation:
  // 41 sits inside the 40/42 band and holds NEUTRAL until 39 and 38 confirm together.
  assertEquals(
    walk([57, 56, 41, 39, 38], 62, "BULL").labels,
    ["BULL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "RISK_OFF"],
  );
});

Deno.test("bands are ordered, non-overlapping, and bracket the predicted thresholds", () => {
  assertEquals(REGIME_DWELL, 2);
  for (const band of REGIME_BANDS) assert(band.up > band.down);
  for (let i = 1; i < REGIME_BANDS.length; i++) {
    assert(REGIME_BANDS[i].down > REGIME_BANDS[i - 1].up);
  }
  // A committed level can never exceed what a monotone score path supports.
  assertEquals(committedRegimeOf(100, "RISK_OFF", [100]), "STRONG_BULL");
  assertEquals(committedRegimeOf(0, "STRONG_BULL", [0]), "RISK_OFF");
});
