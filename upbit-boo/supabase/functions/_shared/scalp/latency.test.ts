import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookTimestampOf,
  DEFAULT_LATENCY_COST,
  evaluateLatencySlo,
  latencyCostBps,
  latencyCostFromNoiseBandBps,
  LatencyTrace,
  percentile,
  segmentsOf,
  shrunkLatencyCostBps,
  summarize,
} from "./latency.ts";

Deno.test("percentile uses nearest rank and never invents a value", () => {
  const values = [10, 20, 30, 40, 50];
  assertEquals(percentile(values, 0.50), 30);
  assertEquals(percentile(values, 0.95), 50);
  assertEquals(percentile(values, 1), 50);
  assertEquals(percentile(values, 0), 10);
  // Every returned value must be one that was actually observed.
  for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    assert(values.includes(percentile(values, q)), `p${q} returned an unobserved value`);
  }
});

Deno.test("percentile and summarize survive empty and dirty input", () => {
  assertEquals(percentile([], 0.95), 0);
  assertEquals(summarize([]).count, 0);
  const summary = summarize([5, NaN, 15, Infinity, 25]);
  assertEquals(summary.count, 3);
  assertEquals(summary.max, 25);
});

Deno.test("segments derive every interval and tolerate missing stages", () => {
  const full = segmentsOf({
    book_captured: 1_000,
    quote_received: 1_120,
    decision_made: 1_180,
    order_submitted: 1_250,
    order_acked: 1_600,
  });
  assertEquals(full.bookToQuoteMs, 120);
  assertEquals(full.quoteToDecisionMs, 60);
  assertEquals(full.decisionToOrderMs, 70);
  assertEquals(full.orderRoundTripMs, 350);
  assertEquals(full.tickToDecisionMs, 180);
  assertEquals(full.tickToOrderMs, 250);
  assertEquals(full.tickToAckMs, 600);

  // Binance depth carries no timestamp; everything anchored on it must be null, not zero.
  const partial = segmentsOf({ quote_received: 1_120, decision_made: 1_180 });
  assertEquals(partial.tickToOrderMs, null);
  assertEquals(partial.quoteToDecisionMs, 60);
});

Deno.test("clock skew is clamped to zero rather than dropped", () => {
  // The exchange stamp can sit ahead of ours. That is a clock problem; recording it as a
  // negative latency would bias the percentiles downward and hide real delay.
  const segments = segmentsOf({ book_captured: 2_000, decision_made: 1_900 });
  assertEquals(segments.tickToDecisionMs, 0);
});

Deno.test("latency cost grows with the square root of delay, not linearly", () => {
  const sigma = 0.004; // 40bp over a 5m bar
  const at1s = latencyCostBps({ latencyMs: 1000, sigma, sigmaHorizonSeconds: 300 });
  const at4s = latencyCostBps({ latencyMs: 4000, sigma, sigmaHorizonSeconds: 300 });
  // Four times the delay should be roughly twice the cost.
  assertAlmostEquals(at4s / at1s, 2, 0.05);
});

Deno.test("latency cost scales with the symbol's own volatility", () => {
  const quiet = latencyCostBps({ latencyMs: 2000, sigma: 0.001, sigmaHorizonSeconds: 300 });
  const hot = latencyCostBps({ latencyMs: 2000, sigma: 0.010, sigmaHorizonSeconds: 300 });
  assert(hot > quiet * 5, "a ten-times more volatile book must cost far more to be late in");
  assert(DEFAULT_LATENCY_COST.unmeasuredBps === 0, "unmeasured latency must be telemetry-only");
});

Deno.test("latency cost is zero before usable measurements exist", () => {
  assertEquals(
    latencyCostBps({ latencyMs: 1000, sigma: 0, sigmaHorizonSeconds: 300 }),
    DEFAULT_LATENCY_COST.unmeasuredBps,
  );
  assertEquals(
    latencyCostBps({ latencyMs: NaN, sigma: 0.004, sigmaHorizonSeconds: 300 }),
    DEFAULT_LATENCY_COST.unmeasuredBps,
  );
});

Deno.test("a thin sample cannot move the cost on its own", () => {
  // Below minSamples the measurement is ignored entirely.
  assertEquals(shrunkLatencyCostBps(9, 5), DEFAULT_LATENCY_COST.unmeasuredBps);
  // Just over the threshold it is heavily shrunk toward the zero-cost prior.
  const thin = shrunkLatencyCostBps(9, 30);
  const thick = shrunkLatencyCostBps(9, 3000);
  assert(thin < thick, "more samples must move the estimate closer to the measurement");
  assert(thin < 9 && thick > 8, "shrinkage must be monotone in sample count");
});

Deno.test("SLO withholds a verdict until there is enough data", () => {
  const verdict = evaluateLatencySlo({
    tickToOrder: summarize([100, 200, 300]),
    quoteToDecision: summarize([10, 20, 30]),
    decisionsSeen: 3,
  });
  assertEquals(verdict.verdict, "INSUFFICIENT_DATA");
});

Deno.test("SLO flags a book that is stale by the time the order lands", () => {
  const slow = Array.from({ length: 50 }, (_, i) => 2000 + i * 100); // p95 ~ 6.7s
  const verdict = evaluateLatencySlo({
    tickToOrder: summarize(slow),
    quoteToDecision: summarize(Array.from({ length: 50 }, () => 50)),
    decisionsSeen: 50,
  });
  assertEquals(verdict.verdict, "BREACHED");
  assert(verdict.breaches.some((b) => b.includes("tick_to_order_p95")));
});

Deno.test("missing book timestamps are themselves reported as a breach", () => {
  // 40 timed decisions out of 200 taken: the other 160 cannot be audited for staleness
  // at all, which is precisely the pre-v6.5 state.
  const verdict = evaluateLatencySlo({
    tickToOrder: summarize(Array.from({ length: 40 }, () => 300)),
    quoteToDecision: summarize(Array.from({ length: 40 }, () => 50)),
    decisionsSeen: 200,
  });
  assertEquals(verdict.verdict, "BREACHED");
  assert(verdict.breaches.some((b) => b.includes("coverage")));
});

Deno.test("a healthy path passes", () => {
  const verdict = evaluateLatencySlo({
    tickToOrder: summarize(Array.from({ length: 100 }, (_, i) => 200 + (i % 20) * 10)),
    quoteToDecision: summarize(Array.from({ length: 100 }, () => 40)),
    decisionsSeen: 110,
  });
  assertEquals(verdict.verdict, "OK");
  assertEquals(verdict.breaches, []);
});

Deno.test("the trace never throws on missing or absurd stamps", () => {
  const trace = new LatencyTrace("d-1", "upbit", "KRW-ETH");
  trace.mark("book_captured", null);
  trace.mark("quote_received", 0);
  trace.mark("decision_made");
  const row = trace.toRow({ outcome: "ENTERED" });
  assertEquals(row.decision_id, "d-1");
  assertEquals(row.tick_to_order_ms, null);
  assertEquals(row.outcome, "ENTERED");
});

Deno.test("book timestamp extraction rejects implausible values", () => {
  assertEquals(bookTimestampOf(null), null);
  assertEquals(bookTimestampOf({ raw: { book: { timestamp: 12345 } } }), null); // seconds, not ms
  assertEquals(bookTimestampOf({ raw: { book: { timestamp: 1_800_000_000_000 } } }), 1_800_000_000_000);
  // The gateway's own receipt stamp is the fallback for Binance, which sends no timestamp.
  assertEquals(bookTimestampOf({ timing: { received_at_ms: 1_800_000_000_500 } }), 1_800_000_000_500);
});

Deno.test("noise-band latency cost scales the book's own measured excursion", () => {
  const band = 12; // bp of median adverse excursion over an 8s window
  const at8s = latencyCostFromNoiseBandBps({
    noiseBandBps: band, latencyMs: 8000, observationWindowMs: 8000,
  });
  // At exactly the observation horizon the penalty is the band itself.
  assertAlmostEquals(at8s, band, 1e-9);
  // At a quarter of the horizon it is half the band — sqrt scaling, not linear.
  const at2s = latencyCostFromNoiseBandBps({
    noiseBandBps: band, latencyMs: 2000, observationWindowMs: 8000,
  });
  assertAlmostEquals(at2s, band / 2, 1e-9);
  // A realistic 300ms path costs a small fraction of the band, not a flat 1bp.
  const at300ms = latencyCostFromNoiseBandBps({
    noiseBandBps: band, latencyMs: 300, observationWindowMs: 8000,
  });
  assert(at300ms > 2 && at300ms < 3);
});

Deno.test("noise-band cost falls back rather than returning zero on a missing band", () => {
  assertEquals(
    latencyCostFromNoiseBandBps({ noiseBandBps: 0, latencyMs: 300, observationWindowMs: 8000 }),
    DEFAULT_LATENCY_COST.unmeasuredBps,
  );
});

Deno.test("unmeasured latency is conservatively priced instead of silently charged at zero", async () => {
  const { resolveLatencyPenaltyBps } = await import("./latency.ts");
  const fromNoise = resolveLatencyPenaltyBps({
    noiseBandBps: 8,
    observationWindowMs: 8000,
    measured: false,
    measuredP95Ms: 0,
    measuredSamples: 0,
    operatorPriorBps: 0,
    assumedP95Ms: 1500,
    unmeasuredFloorBps: 1,
  });
  if (!(fromNoise.bps >= 1)) throw new Error(JSON.stringify(fromNoise));
  if (fromNoise.source !== "NOISE_BAND_X_ASSUMED_P95") throw new Error(JSON.stringify(fromNoise));

  const floorOnly = resolveLatencyPenaltyBps({
    noiseBandBps: 0,
    observationWindowMs: 8000,
    measured: false,
    measuredP95Ms: 0,
    measuredSamples: 0,
    operatorPriorBps: 0,
    assumedP95Ms: 1500,
    unmeasuredFloorBps: 1,
  });
  if (floorOnly.bps !== 1) throw new Error(JSON.stringify(floorOnly));
});
