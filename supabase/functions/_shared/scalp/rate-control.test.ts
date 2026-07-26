import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_RATE_CONTROL,
  evaluateRateControl,
  relaxedMinimumEdge,
  resolveRateControlConfig,
  sizeForEvidence,
} from "./rate-control.ts";

const cfg = { ...DEFAULT_RATE_CONTROL, targetTradesPerHour: 5 };
const base = {
  entriesInWindow: 0,
  observedMinutes: 60,
  currentRelaxation: 0,
  edgeSamples: 0,
  measuredEdgeLowerBound: null as number | null,
};

Deno.test("being under target relaxes the threshold", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 1 }, cfg);
  assertAlmostEquals(d.observedRate, 1, 1e-9);
  assert(d.relaxation > 0);
  assertEquals(d.reason, "below_target_relaxing");
});

Deno.test("relaxation accumulates but is capped", () => {
  let relaxation = 0;
  for (let i = 0; i < 50; i++) {
    relaxation = evaluateRateControl({ ...base, entriesInWindow: 0, currentRelaxation: relaxation }, cfg).relaxation;
  }
  assertEquals(relaxation, cfg.maxRelaxationCostMultiple);
  assertEquals(
    evaluateRateControl({ ...base, currentRelaxation: relaxation }, cfg).reason,
    "below_target_at_max_relaxation",
  );
});

Deno.test("hitting the target tightens back", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 8, currentRelaxation: 1.0 }, cfg);
  assert(d.relaxation < 1.0);
  assertEquals(d.reason, "at_or_above_target_tightening");
});

Deno.test("the controller settles rather than oscillating to an extreme", () => {
  // Feed a rate that responds to relaxation and check it converges near the target.
  let relaxation = 0;
  let rate = 0.5;
  for (let i = 0; i < 200; i++) {
    const d = evaluateRateControl(
      { ...base, entriesInWindow: Math.round(rate), currentRelaxation: relaxation },
      cfg,
    );
    relaxation = d.relaxation;
    rate = 0.5 + relaxation * 4; // more relaxation, more entries
  }
  assert(Math.abs(rate - cfg.targetTradesPerHour) < 1.5, `settled at ${rate}`);
  assert(relaxation <= cfg.maxRelaxationCostMultiple);
});

Deno.test("the relaxed threshold never goes below zero", () => {
  // The controller may remove the margin above cost; it may not make the engine accept a
  // trade it expects to lose money on.
  assertEquals(relaxedMinimumEdge(0.0002, 99, 0.0008), 0);
  assertAlmostEquals(relaxedMinimumEdge(0.0002, 0.125, 0.0008), 0.0001, 1e-12);
  assertAlmostEquals(relaxedMinimumEdge(0.0002, 0, 0.0008), 0.0002, 1e-12);
});

Deno.test("size is small while the edge is unmeasured", () => {
  assertEquals(sizeForEvidence(0, null, cfg), cfg.unprovenSizeFraction);
  assertEquals(sizeForEvidence(1000, null, cfg), cfg.unprovenSizeFraction);
});

Deno.test("size grows with evidence once the edge is positive", () => {
  const early = sizeForEvidence(100, 0.05, cfg);
  const later = sizeForEvidence(400, 0.05, cfg);
  assert(early > cfg.unprovenSizeFraction - 1e-9);
  assert(later > early);
  assertAlmostEquals(later, 1, 1e-9);
  // And never beyond full size.
  assertAlmostEquals(sizeForEvidence(100_000, 0.05, cfg), 1, 1e-9);
});

Deno.test("a measured negative edge keeps size small and stops the push", () => {
  const d = evaluateRateControl(
    { ...base, entriesInWindow: 0, currentRelaxation: 1.2, edgeSamples: 1000, measuredEdgeLowerBound: -0.02 },
    cfg,
  );
  assertEquals(d.edgeNegative, true);
  assertEquals(d.relaxation, 0);
  assertEquals(d.reason, "measured_edge_negative");
  assertEquals(d.sizeFraction, cfg.unprovenSizeFraction);
});

Deno.test("a thin negative reading does not stop the controller", () => {
  // Two hundred samples is not enough to conclude the signal is worthless.
  const d = evaluateRateControl(
    { ...base, entriesInWindow: 0, edgeSamples: 20, measuredEdgeLowerBound: -0.02 },
    cfg,
  );
  assertEquals(d.edgeNegative, false);
  assert(d.relaxation > 0);
});

Deno.test("a zero target disables the controller without disabling trading", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 0 }, { ...cfg, targetTradesPerHour: 0 });
  assertEquals(d.relaxation, 0);
  assertEquals(d.reason, "rate_target_disabled");
});

Deno.test("a short observation window is annualised, not treated as a full hour", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 2, observedMinutes: 12 }, cfg);
  assertAlmostEquals(d.observedRate, 10, 1e-9);
  assertEquals(d.reason, "at_or_above_target_tightening");
});

Deno.test("config clamps hostile overrides", () => {
  const c = resolveRateControlConfig({ targetTradesPerHour: 9999, maxRelaxationCostMultiple: -5, unprovenSizeFraction: 9 });
  assert(c.targetTradesPerHour <= 60);
  assert(c.maxRelaxationCostMultiple >= 0);
  assert(c.unprovenSizeFraction <= 1);
});
