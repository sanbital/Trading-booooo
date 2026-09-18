import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateDesiredSlots,
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
  currentSlots: 4,
  currentScanUniverse: 60,
  currentEvaluationIntervalSeconds: 60,
  averageHoldingMinutes: 15,
  pFillLowerBound: 0.5,
  edgeSamples: 0,
  measuredEdgeLowerBound: null as number | null,
  currentRelaxation: 99,
};

Deno.test("being under target increases capacity without relaxing quality", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 1 }, cfg);
  assertAlmostEquals(d.observedRate, 1, 1e-9);
  assertEquals(d.relaxation, 0);
  assert(d.desiredSlots >= base.currentSlots);
  assert(d.scanUniverse > base.currentScanUniverse);
  assert(d.evaluationIntervalSeconds < base.currentEvaluationIntervalSeconds);
  assertEquals(d.reason, "below_target_increasing_capacity");
});

Deno.test("hitting target releases excess capacity but respects formula slot need", () => {
  const d = evaluateRateControl({ ...base, entriesInWindow: 8, currentSlots: 10 }, cfg);
  const floor = calculateDesiredSlots(5, 15, cfg.targetUtilization, cfg.minSlots, cfg.maxSlots);
  assert(d.desiredSlots >= floor);
  assert(d.desiredSlots < 10);
  assertEquals(d.relaxation, 0);
  assertEquals(d.reason, "at_or_above_target_releasing_capacity");
});

Deno.test("fill probability changes required attempts, not the gate", () => {
  const low = evaluateRateControl({ ...base, pFillLowerBound: 0.25 }, cfg);
  const high = evaluateRateControl({ ...base, pFillLowerBound: 0.8 }, cfg);
  assert(low.attemptsRequiredPerHour > high.attemptsRequiredPerHour);
  assertEquals(low.relaxation, 0);
  assertEquals(high.relaxation, 0);
});

Deno.test("stale callers cannot relax minimum edge", () => {
  assertAlmostEquals(relaxedMinimumEdge(0.0002, 99, 0.0008), 0.0002, 1e-12);
  assertAlmostEquals(relaxedMinimumEdge(0.0002, 0, 0.0008), 0.0002, 1e-12);
});

Deno.test("size remains small until positive lower-bound evidence exists", () => {
  assertEquals(sizeForEvidence(0, null, cfg), cfg.unprovenSizeFraction);
  assertEquals(sizeForEvidence(1000, null, cfg), cfg.unprovenSizeFraction);
  assertEquals(sizeForEvidence(1000, -0.001, cfg), cfg.unprovenSizeFraction);
  const early = sizeForEvidence(100, 0.001, cfg);
  const later = sizeForEvidence(400, 0.001, cfg);
  assert(later > early);
  assertAlmostEquals(later, 1, 1e-9);
});

Deno.test("measured negative edge freezes capacity push", () => {
  const d = evaluateRateControl({ ...base, edgeSamples: 1000, measuredEdgeLowerBound: -0.02 }, cfg);
  assertEquals(d.edgeNegative, true);
  assertEquals(d.relaxation, 0);
  assertEquals(d.desiredSlots, base.currentSlots);
  assertEquals(d.reason, "measured_edge_negative_capacity_frozen");
});

Deno.test("desired slots follow Little's-law style capacity formula", () => {
  assertEquals(calculateDesiredSlots(5, 15, 0.70, 2, 12), 2);
  assertEquals(calculateDesiredSlots(10, 30, 0.70, 2, 12), 8);
});

Deno.test("config clamps hostile overrides and ordering", () => {
  const c = resolveRateControlConfig({
    targetTradesPerHour: 9999,
    minSlots: 10,
    maxSlots: 2,
    minScanUniverse: 300,
    maxScanUniverse: 20,
    unprovenSizeFraction: 9,
  });
  assert(c.targetTradesPerHour <= 60);
  assert(c.maxSlots >= c.minSlots);
  assert(c.maxScanUniverse >= c.minScanUniverse);
  assert(c.unprovenSizeFraction <= 1);
});
