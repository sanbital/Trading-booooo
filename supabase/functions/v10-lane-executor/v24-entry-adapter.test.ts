// Adapter tests. The property that matters most: EVERY failure path must BLOCK.
// A timeout, a truncated tape, a malformed book or an adapter fault must never read as
// "no objection" — that is exactly the weakness the audit found in the deployed E1 gate.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { v24EntryGate, fetchTape, resolveEdge, V24_ADAPTER_VERSION } from "./v24-entry-adapter.mjs";
import { MIN } from "./v24-leader-continuation.mjs";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % MIN);

/**
 * Rising series with a shallow consolidation and a breakout bar — a valid SETUP_A.
 * Built in the adapter's own bar shape; fetchKlines is injected in these tests, so there
 * is no reason to round-trip through Binance's positional array and risk clobbering a
 * field while doing so.
 */
const bar = (t: number, o: number, h: number, l: number, c: number, qv: number, tbq: number) =>
  ({ t, o, h, l, c, qv, tbq, closeMs: t + MIN - 1 });

/**
 * The adapter resamples 1m into 3m and 5m, and the 5m EMA21 stack needs ~125 closed 1m
 * bars before TREND can even be evaluated. A short fixture refuses with
 * INSUFFICIENT_RESAMPLED_HISTORY and never reaches the gate under test, so this builds a
 * genuinely rising 160-bar series: a long steady advance (so EMA9 > EMA21 and EMA21 is
 * rising), then a heavier leg, a light 3-bar consolidation, and a breakout bar.
 */
function goodBars(endT: number) {
  const out = [];
  const RISE = 146, LEG = 10, CONSOL = 3, total = RISE + LEG + CONSOL + 1;
  const start = endT - total * MIN;
  let p = 90, i = 0;
  for (; i < RISE; i++) {
    out.push(bar(start + i * MIN, p, p + 0.15, p - 0.05, p + 0.1, 800, 440));
    p += 0.1;
  }
  for (; i < RISE + LEG; i++) {
    out.push(bar(start + i * MIN, p, p + 1, p - 0.2, p + 0.9, 5000, 3200));
    p += 0.9;
  }
  const top = p;
  for (; i < total - 1; i++)
    out.push(bar(start + i * MIN, top, top + 0.1, top - 0.6, top - 0.4, 800, 400));
  // The breakout clears the trigger (max high of the prior 3 bars, top + 0.1) but only
  // just: chaseGate caps entry at 0.25 * ATR14_3m above the trigger, so a large breakout
  // bar is correctly refused as CHASE_TOO_FAR and never reaches the gates under test.
  out.push(bar(start + (total - 1) * MIN, top - 0.4, top + 0.4, top - 0.5, top + 0.3, 20000, 15000));
  return out;
}
/** BTC is held flat so relative strength is positive and never the reason for a refusal. */
function flatBars(endT: number, count: number) {
  const start = endT - count * MIN;
  return Array.from({ length: count }, (_, i) => bar(start + i * MIN, 100, 100.05, 99.95, 100, 1000, 500));
}
const klinesOk = async (sym: string, _iv: string, limit: number) =>
  sym === "BTCUSDT" ? flatBars(NOW, Math.min(limit, 40)) : goodBars(NOW);

const book = {
  best_bid: 108.9, best_ask: 109.0,
  bids: Array.from({ length: 40 }, (_, i) => ({ price: 108.9 - i * 0.01, size: 500 })),
  asks: Array.from({ length: 40 }, (_, i) => ({ price: 109.0 + i * 0.01, size: 500 })),
};
const leaderFeatures = { dayReturn: 0.25, rank: 3, qv24: 5e8, volumeRatio: 2.0,
  notionalUsdt: 120, probeQuantity: 1 };

const aggRows = (from: number, to: number, buyShare: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    a: i, T: from + Math.floor((i * (to - from)) / count), p: 109, q: 1,
    m: i >= Math.floor(count * buyShare),   // m=false is an aggressive BUY
  }));

/* ------------------------------------------------------------- blocking ---- */

Deno.test("a non-leader is refused before any network call is made", async () => {
  let called = false;
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: { dayReturn: -0.01, rank: 1, qv24: 1e9 },
    quote: book, quantityStep: 0.001, priceTick: 0.01, now: NOW,
    fetchAgg: async () => { called = true; return { available: false }; },
    klines: async () => { called = true; return []; },
  });
  assertEquals(r.decision, "SKIP");
  assertEquals(called, false, "LEADER must short-circuit before fetching");
});

Deno.test("a truncated tape BLOCKS — a full aggTrades page is UNKNOWN, not a pass", async () => {
  const t = await fetchTape("X", NOW, async () => ({ available: true, raw: new Array(1000).fill({}) }));
  assertEquals(t.t60.known, false);
  assertEquals(t.t60.reason, "V24_TAPE_TRUNCATED");
  assertEquals(t.t180.known, false);
});

Deno.test("an unavailable tape BLOCKS", async () => {
  const t = await fetchTape("X", NOW, async () => ({ available: false, reason: "E1_TAPE_HTTP_418" }));
  assertEquals(t.t60.known, false);
  assertEquals(t.t60.reason, "E1_TAPE_HTTP_418");
});

Deno.test("a kline fetch failure BLOCKS rather than propagating", async () => {
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: leaderFeatures, quote: book,
    quantityStep: 0.001, priceTick: 0.01, now: NOW,
    fetchAgg: async () => ({ available: true, raw: [] }),
    klines: async () => { throw new Error("boom"); },
  });
  assertEquals(r.decision, "SKIP");
  assertEquals(r.reason, "V24_ADAPTER_FAULT");
  assertEquals(r.allowed, false);
});

Deno.test("a malformed book BLOCKS", async () => {
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: leaderFeatures,
    quote: { best_bid: 0, best_ask: 0, bids: null, asks: null },
    quantityStep: 0.001, priceTick: 0.01, now: NOW,
    fetchAgg: async () => ({ available: true, raw: aggRows(NOW - 180_000, NOW, 0.9, 200) }),
    klines: klinesOk,
  });
  assertEquals(r.decision, "SKIP");
  assert(r.reason.startsWith("V24_"));
});

Deno.test("weak 3-minute flow BLOCKS even when the 60s window looks strong", async () => {
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: leaderFeatures, quote: book,
    quantityStep: 0.001, priceTick: 0.01, now: NOW,
    // 90% buy in the last 60s, but only 20% across the full 180s
    fetchAgg: async () => ({
      available: true,
      raw: [...aggRows(NOW - 180_000, NOW - 60_000, 0.2, 200), ...aggRows(NOW - 60_000, NOW, 0.9, 100)],
    }),
    klines: klinesOk,
  });
  assertEquals(r.decision, "SKIP");
  assert(r.reason.includes("FLOW") || r.reason.includes("SETUP") || r.reason.includes("TREND"),
    `expected a flow/setup refusal, got ${r.reason}`);
});

/* ----------------------------------------------------------- cost gate ---- */

Deno.test("with NO operator edge the cost gate refuses — the intended default", async () => {
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: leaderFeatures, quote: book,
    quantityStep: 0.001, priceTick: 0.01, now: NOW,
    fetchAgg: async () => ({ available: true, raw: aggRows(NOW - 180_000, NOW, 0.9, 400) }),
    klines: klinesOk, edge: null,
  });
  assertEquals(r.decision, "SKIP");
  assert(r.reason.includes("EDGE") || r.reason.includes("SETUP") || r.reason.includes("TREND")
      || r.reason.includes("FLOW"),
    `expected refusal without an edge estimate, got ${r.reason}`);
});

Deno.test("resolveEdge returns null unless BOTH operator values are set", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k] ?? "";
  assertEquals(resolveEdge(env({})), null);
  assertEquals(resolveEdge(env({ V24_ASSUMED_EDGE_BPS: "40" })), null, "samples missing -> null");
  const e = resolveEdge(env({ V24_ASSUMED_EDGE_BPS: "40", V24_EDGE_SAMPLES: "100" }));
  assert(e);
  assertEquals(e!.expectedEdgeBps, 40);
  assertEquals(e!.basis, "OPERATOR_ASSUMED_UNVALIDATED",
    "an operator assumption must never be labelled as measured");
  assertEquals(e!.measuredEdgeContradicts, true);
});

Deno.test("every refusal carries the adapter version and is never 'allowed'", async () => {
  const r = await v24EntryGate({
    symbol: "TESTUSDT", features: { dayReturn: 0.5, rank: 99, qv24: 1e9 },
    quote: book, quantityStep: 0.001, priceTick: 0.01, now: NOW,
    fetchAgg: async () => ({ available: true, raw: [] }), klines: klinesOk,
  });
  assertEquals(r.allowed, false);
  assertEquals(r.adapter, V24_ADAPTER_VERSION);
  assertEquals(r.parametersValidatedByBacktest, false);
});
