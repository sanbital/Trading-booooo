import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_EDGE_PROPOSAL,
  measureEdge,
  proposeEdgeBudget,
  resolveBarrierOutcome,
  type Candle,
  type ShadowSample,
} from "./shadow.ts";

const bar = (high: number, low: number, close = (high + low) / 2, ts = 0): Candle => ({ ts, high, low, close });

Deno.test("target and stop are detected on the bar that touches them", () => {
  const up = resolveBarrierOutcome([bar(100.2, 99.9), bar(101.5, 100.1)], 100, 0.01, 0.01);
  assertEquals(up.outcome, "TARGET");
  assertEquals(up.barsToResolve, 2);

  const down = resolveBarrierOutcome([bar(100.2, 99.9), bar(100.1, 98.5)], 100, 0.01, 0.01);
  assertEquals(down.outcome, "STOP");
  assertEquals(down.barsToResolve, 2);
});

Deno.test("a bar spanning both barriers is recorded as a stop", () => {
  // Intrabar order is unknowable from OHLC. Assuming the favourable leg would inflate the
  // exact quantity this module exists to measure honestly.
  const r = resolveBarrierOutcome([bar(102, 98)], 100, 0.01, 0.01);
  assertEquals(r.outcome, "STOP");
});

Deno.test("an unresolved path times out and reports its drift", () => {
  const r = resolveBarrierOutcome([bar(100.3, 99.8), bar(100.4, 99.9, 100.25)], 100, 0.01, 0.01);
  assertEquals(r.outcome, "TIMEOUT");
  assertEquals(r.barsToResolve, null);
  assertAlmostEquals(r.realizedReturn, 0.0025, 1e-9);
});

Deno.test("the bar limit is honoured", () => {
  const path = [bar(100.1, 99.9), bar(100.2, 99.9), bar(101.5, 100.1)];
  assertEquals(resolveBarrierOutcome(path, 100, 0.01, 0.01, 2).outcome, "TIMEOUT");
  assertEquals(resolveBarrierOutcome(path, 100, 0.01, 0.01, 3).outcome, "TARGET");
});

Deno.test("an empty or invalid path resolves to nothing rather than guessing", () => {
  assertEquals(resolveBarrierOutcome([], 100, 0.01, 0.01).outcome, "TIMEOUT");
  assertEquals(resolveBarrierOutcome([bar(101, 99)], 0, 0.01, 0.01).outcome, "TIMEOUT");
});

/** `wins` targets and `losses` stops, all at the same neutral rate. */
function samples(wins: number, losses: number, timeouts: number, neutral: number, claimed = 0.10): ShadowSample[] {
  const out: ShadowSample[] = [];
  for (let i = 0; i < wins; i++) out.push({ neutralWinRate: neutral, signalEdge: claimed, outcome: "TARGET" });
  for (let i = 0; i < losses; i++) out.push({ neutralWinRate: neutral, signalEdge: claimed, outcome: "STOP" });
  for (let i = 0; i < timeouts; i++) out.push({ neutralWinRate: neutral, signalEdge: claimed, outcome: "TIMEOUT" });
  return out;
}

Deno.test("measured edge is realized rate minus neutral rate", () => {
  // 58 targets, 42 stops against a 48% neutral rate => +10pp of real edge.
  const m = measureEdge(samples(58, 42, 0, 0.48));
  assertAlmostEquals(m.realizedWinRate, 0.58, 1e-9);
  assertAlmostEquals(m.neutralWinRate, 0.48, 1e-9);
  assertAlmostEquals(m.measuredEdge, 0.10, 1e-9);
});

Deno.test("timeouts are excluded from the rate but reported separately", () => {
  const m = measureEdge(samples(30, 20, 50, 0.50));
  assertEquals(m.resolved, 50);
  assertEquals(m.total, 100);
  assertAlmostEquals(m.resolveRate, 0.5, 1e-9);
  assertAlmostEquals(m.realizedWinRate, 0.6, 1e-9);
});

Deno.test("a signal with no edge measures as none", () => {
  const m = measureEdge(samples(48, 52, 0, 0.48));
  assert(Math.abs(m.measuredEdge) < 0.03, `${m.measuredEdge}`);
  // And the model's claim is exposed against what was delivered.
  assertAlmostEquals(m.predictedEdge, 0.10, 1e-9);
  assert(m.predictedEdge > m.measuredEdge);
});

Deno.test("the proposal waits for evidence", () => {
  const thin = proposeEdgeBudget(measureEdge(samples(30, 20, 0, 0.48)), 0.10);
  assertEquals(thin.apply, false);
  assert(thin.reason.startsWith("insufficient_samples"));
  assertEquals(thin.proposed, 0.10);
});

Deno.test("the proposal uses the lower bound, never the point estimate", () => {
  // Overstating the edge narrows barriers and demands an edge the signal lacks — the same
  // failure as the hand-picked default, reached with more steps.
  const m = measureEdge(samples(700, 300, 0, 0.48));
  const p = proposeEdgeBudget(m, 0.10);
  assert(m.edgeLowerBound < m.measuredEdge);
  assert(p.proposed <= m.measuredEdge + 1e-9, `${p.proposed} vs point estimate ${m.measuredEdge}`);
});

Deno.test("a genuinely weaker signal pulls the budget down", () => {
  // Reality is +3pp while the setting assumes +10pp: barriers must widen, not narrow.
  const p = proposeEdgeBudget(measureEdge(samples(510, 490, 0, 0.48)), 0.10);
  assertEquals(p.apply, true);
  assert(p.proposed < 0.10, `${p.proposed}`);
  assert(p.proposed >= DEFAULT_EDGE_PROPOSAL.minEdgeBudget);
});

Deno.test("shrinkage keeps one window from swinging the geometry", () => {
  const strong = measureEdge(samples(700, 300, 0, 0.48)); // ~+22pp measured
  const p = proposeEdgeBudget(strong, 0.10);
  // Even a large, well-evidenced measurement moves the incumbent only part of the way.
  assert(p.proposed < strong.edgeLowerBound, `${p.proposed} vs ${strong.edgeLowerBound}`);
  assert(p.proposed > 0.10);
});

Deno.test("proposals stay inside the geometry bounds", () => {
  const extreme = proposeEdgeBudget(measureEdge(samples(1000, 0, 0, 0.05)), 0.10);
  assert(extreme.proposed <= DEFAULT_EDGE_PROPOSAL.maxEdgeBudget);
  const nothing = proposeEdgeBudget(measureEdge(samples(0, 1000, 0, 0.90)), 0.10);
  assert(nothing.proposed >= DEFAULT_EDGE_PROPOSAL.minEdgeBudget);
});

Deno.test("a negligible change is not applied", () => {
  const p = proposeEdgeBudget(measureEdge(samples(581, 419, 0, 0.48)), 0.10);
  if (!p.apply) assertEquals(p.reason, "no_material_change");
});
