// Regression suite for the V24 leader-continuation core.
// Every test here corresponds to a failure mode that would silently corrupt either the
// backtest or live trading: time leakage, unit confusion, sign inversion, double-charged
// costs, a stop that moves the wrong way, or missing data read as a pass.
import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  kstDayStart, closedBars, resample, atrWilder, rvol1, rvol15, tapeWindow, walkBook,
  depthWithin, bookMetrics, executionCostBps, dayReturn, rankLeaders, leaderGate,
  buildFeatures, trendGate, setupA, setupB, chaseGate, orderFlowGate, structuralStop,
  sizePosition, costEdgeGate, netRealisable, profitLockFloor, trailLevel, momentumBreak,
  earlyFailure, timeStop, evaluateEntry, evaluateExit, reentryAllowed, V24_POLICY, MIN, M5, M15,
} from "./v24-leader-continuation.mjs";

const bar = (t, o, h, l, c, qv = 1000, tbq = 600, step = MIN) =>
  ({ t, o, h, l, c, qv, tbq, closeMs: t + step - 1 });

/* ---------------------------------------------------------------- time ---- */

Deno.test("kstDayStart: KST midnight is UTC 15:00 of the previous day", () => {
  const kstMidnight = Date.parse("2026-09-10T00:00:00+09:00");
  assertEquals(kstDayStart(kstMidnight), kstMidnight);
  assertEquals(new Date(kstDayStart(kstMidnight)).toISOString(), "2026-09-09T15:00:00.000Z");
  // One ms before KST midnight still belongs to the previous KST day.
  assertEquals(kstDayStart(kstMidnight - 1), kstMidnight - 86_400_000);
});

Deno.test("kstDayStart is NOT the UTC day start", () => {
  const utcNoon = Date.parse("2026-09-10T12:00:00Z");
  assert(kstDayStart(utcNoon) !== Date.parse("2026-09-10T00:00:00Z"));
  assertEquals(kstDayStart(utcNoon), Date.parse("2026-09-09T15:00:00Z"));
});

Deno.test("closedBars: a bar whose closeMs equals now is still OPEN and invisible", () => {
  const t = 60_000;
  const bars = [bar(t, 1, 2, 0.5, 1.5)];
  assertEquals(closedBars(bars, t + MIN - 1, MIN).length, 0, "closeMs === now must not be visible");
  assertEquals(closedBars(bars, t + MIN, MIN).length, 1, "closeMs < now is visible");
});

Deno.test("closedBars rejects a future bar (no look-ahead)", () => {
  const now = 10 * MIN;
  const bars = [bar(5 * MIN, 1, 1, 1, 1), bar(20 * MIN, 9, 9, 9, 9)];
  const got = closedBars(bars, now, MIN);
  assertEquals(got.length, 1);
  assertEquals(got[0].t, 5 * MIN);
});

Deno.test("resample only emits fully populated buckets", () => {
  const b = [bar(0, 1, 2, 1, 2), bar(MIN, 2, 3, 2, 3), bar(2 * MIN, 3, 4, 3, 4), bar(3 * MIN, 4, 5, 4, 5)];
  const r3 = resample(b, 3);
  assertEquals(r3.length, 1, "the trailing partial 3m bucket must not be emitted");
  assertEquals(r3[0].h, 4);
  assertEquals(r3[0].l, 1);
  assertEquals(r3[0].c, 4);
});

/* ----------------------------------------------------------- indicators ---- */

Deno.test("atrWilder is in PRICE units and needs period+1 bars", () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i * MIN, 100, 102, 98, 100));
  const a = atrWilder(bars, 14);
  assert(a.known);
  assertAlmostEquals(a.value, 4, 1e-9, "TR of a 98..102 bar is 4 price units");
  assertEquals(atrWilder(bars.slice(0, 14), 14).known, false, "14 bars gives only 13 TRs");
});

Deno.test("rvol1/rvol15 exclude the current bucket from the denominator", () => {
  const bars = Array.from({ length: 21 }, (_, i) => bar(i * MIN, 1, 1, 1, 1, i === 20 ? 500 : 100));
  const v = rvol1(bars);
  assert(v.known);
  assertAlmostEquals(v.value, 5, 1e-9, "500 / median(20 x 100) = 5, current bar not in median");
});

Deno.test("indicators return UNKNOWN rather than a neutral default", () => {
  assertEquals(atrWilder([], 14).known, false);
  assertEquals(rvol1([bar(0, 1, 1, 1, 1)]).known, false);
  assertEquals(rvol15([]).known, false);
});

/* ----------------------------------------------------------------- tape ---- */

Deno.test("aggTrade m=true is an aggressive SELL, m=false an aggressive BUY", () => {
  const rows = [
    { a: 1, T: 10, p: 100, q: 1, m: false }, // aggressive buy  -> 100
    { a: 2, T: 20, p: 100, q: 3, m: true },  // aggressive sell -> 300
  ];
  const w = tapeWindow(rows, 0, 100, { ...V24_POLICY, minTapeTrades60s: 1, minTapeQuote60s: 1 });
  assert(w.known);
  assertEquals(w.buyQuote, 100);
  assertEquals(w.sellQuote, 300);
  assertAlmostEquals(w.buyShare, 0.25, 1e-12);
  assertEquals(w.delta, -200, "delta must be signed buy-minus-sell, not an absolute");
});

Deno.test("tape window is half-open [start,end) and de-duplicates by aggId", () => {
  const rows = [
    { a: 1, T: 0, p: 10, q: 1, m: false },
    { a: 1, T: 0, p: 10, q: 1, m: false }, // duplicate delivery
    { a: 2, T: 100, p: 10, q: 1, m: false }, // == end, excluded
  ];
  const w = tapeWindow(rows, 0, 100, { ...V24_POLICY, minTapeTrades60s: 1, minTapeQuote60s: 1 });
  assertEquals(w.aggCount, 1);
});

Deno.test("a thin tape is UNKNOWN/insufficient, never 'not weak so pass'", () => {
  const rows = [{ a: 1, T: 5, p: 1, q: 1, m: false }];
  const w = tapeWindow(rows, 0, 100);
  assertEquals(w.sufficient, false);
  const gate = orderFlowGate({ t60: w, t180: w, imbalance30sAvg: 0.9, price: 2, triggerLevel: 1 });
  assertEquals(gate.pass, false);
  assertEquals(gate.reason, "FLOW_SAMPLE_INSUFFICIENT");
});

Deno.test("empty tape is UNKNOWN and blocks entry", () => {
  const w = tapeWindow([], 0, 100);
  assertEquals(w.known, false);
  assertEquals(orderFlowGate({ t60: w, t180: w, imbalance30sAvg: 1, price: 2, triggerLevel: 1 }).pass, false);
});

/* ----------------------------------------------------------------- book ---- */

Deno.test("walkBook returns UNKNOWN when depth cannot fill the quantity", () => {
  const asks = [[100, 1], [101, 1]];
  assertEquals(walkBook(asks, 5).known, false, "insufficient depth is NOT fillable");
  const ok = walkBook(asks, 2);
  assert(ok.known);
  assertAlmostEquals(ok.value, 100.5, 1e-12);
});

Deno.test("depthWithin measures a band around mid, in USDT", () => {
  const bids = [[99.9, 10], [99.0, 10]];
  const d = depthWithin(bids, 100, 25, "bid"); // 25bps below 100 = 99.75
  assert(d.known);
  assertAlmostEquals(d.value, 999, 1e-9, "only the 99.9 level is inside the band");
});

Deno.test("executionCostBps does NOT double-count spread on top of the walked VWAPs", () => {
  const book = {
    bestBid: 99.9, bestAsk: 100.1,
    bids: [[99.9, 1000]], asks: [[100.1, 1000]],
  };
  const bm = bookMetrics(book, 1);
  assert(bm.known);
  const c = executionCostBps(bm, 0, 0, { ...V24_POLICY, latencyReserveBps: 0 });
  assert(c.known);
  const impact = (100.1 - 99.9) / 100 * 10_000; // 20 bps == the spread itself
  assertAlmostEquals(c.value, impact, 1e-9, "walked spread already contains the spread cost");
});

Deno.test("executionCostBps adds fees once, for both legs", () => {
  const book = { bestBid: 100, bestAsk: 100, bids: [[100, 1000]], asks: [[100, 1000]] };
  const bm = bookMetrics(book, 1);
  const c = executionCostBps(bm, 0.00045, 0.00045, { ...V24_POLICY, latencyReserveBps: 0 });
  assert(c.known);
  assertAlmostEquals(c.value, 9, 1e-9, "4.5bps + 4.5bps round trip");
});

Deno.test("an invalid/sequence-broken book is UNKNOWN", () => {
  assertEquals(bookMetrics({ bestBid: 0, bestAsk: 1 }, 1).known, false);
  assertEquals(bookMetrics({ bestBid: 1, bestAsk: 2, sequenceOk: false, bids: [], asks: [] }, 1).known, false);
});

/* --------------------------------------------------------------- leader ---- */

Deno.test("dayReturn uses the KST day open, and is UNKNOWN when that bar is absent", () => {
  const now = Date.parse("2026-09-10T03:00:00Z");
  const dayStart = kstDayStart(now - 1);
  const bars = [
    { t: dayStart, o: 100, h: 100, l: 100, c: 100, qv: 1, closeMs: dayStart + M15 - 1 },
    { t: dayStart + M15, o: 100, h: 110, l: 100, c: 110, qv: 1, closeMs: dayStart + 2 * M15 - 1 },
  ];
  const d = dayReturn(closedBars(bars, now, M15), now);
  assert(d.known);
  assertAlmostEquals(d.value.r, 0.10, 1e-12);
  // remove the day-open bar -> UNKNOWN, not "use whatever is first"
  const d2 = dayReturn(closedBars(bars.slice(1), now, M15), now);
  assertEquals(d2.known, false);
});

Deno.test("rankLeaders is deterministic and rejects mixed snapshot times", () => {
  const rows = [
    { symbol: "BBB", dayReturn: 0.10, asOf: 1 },
    { symbol: "AAA", dayReturn: 0.10, asOf: 1 },
    { symbol: "CCC", dayReturn: 0.20, asOf: 1 },
  ];
  const r = rankLeaders(rows);
  assertEquals(r.map((x) => x.symbol), ["CCC", "AAA", "BBB"], "ties break on symbol, stably");
  let threw = false;
  try { rankLeaders([{ symbol: "A", dayReturn: 1, asOf: 1 }, { symbol: "B", dayReturn: 1, asOf: 2 }]); }
  catch { threw = true; }
  assert(threw, "mixed asOf must throw, never be silently ranked together");
});

Deno.test("leaderGate does not reject a symbol merely for being up a lot", () => {
  const base = { rank: 1, quoteVolume24h: 50e6 };
  for (const r of [0.2, 0.4, 0.8, 1.5]) {
    assertEquals(leaderGate({ ...base, dayReturn: r }).pass, true, `+${r * 100}% must stay eligible`);
  }
  assertEquals(leaderGate({ ...base, dayReturn: -0.01 }).pass, false);
  assertEquals(leaderGate({ ...base, dayReturn: 0.3, rank: 11 }).pass, false);
});

/* ---------------------------------------------------------------- trend ---- */

Deno.test("trendGate blocks on UNKNOWN inputs", () => {
  assertEquals(trendGate({}).pass, false);
  assertEquals(trendGate({}).reason, "TREND_UNKNOWN");
});

Deno.test("trendGate passes a clean uptrend and fails a rolling-over EMA", () => {
  const ok = { last5mClose: 110, ema9_5m: 108, ema21_5m: 105, ema21_5m_prev3: 104, rs15: 0.01, rvol15: 2 };
  assertEquals(trendGate(ok).pass, true);
  assertEquals(trendGate({ ...ok, ema21_5m_prev3: 106 }).reason, "EMA21_NOT_RISING");
  assertEquals(trendGate({ ...ok, rvol15: 1.0 }).reason, "VOLUME_ACCELERATION");
  assertEquals(trendGate({ ...ok, rs15: -0.01 }).reason, "RELATIVE_STRENGTH");
});

/* ---------------------------------------------------------------- setup ---- */

// 12 flat base bars, 10 rising leg bars on heavy volume, 3 quiet consolidation bars,
// then one breakout bar. 26 closed bars -- enough for the 25-bar history floor and for
// RVOL1's 20-bar median.
function pullbackSeries() {
  const out = [];
  let p = 99;
  for (let i = 0; i < 12; i++) out.push(bar(i * MIN, p, p + 0.2, p - 0.2, p, 800, 400));
  p = 100;
  for (let i = 12; i < 22; i++) { out.push(bar(i * MIN, p, p + 1, p - 0.2, p + 0.9, 5000, 3200)); p += 0.9; }
  const top = p;
  for (let i = 22; i < 25; i++) out.push(bar(i * MIN, top, top + 0.1, top - 0.6, top - 0.4, 800, 400));
  out.push(bar(25 * MIN, top - 0.4, top + 2.0, top - 0.5, top + 1.8, 20000, 15000));
  return out;
}

Deno.test("setupA accepts a shallow consolidation break (no deep retracement required)", () => {
  const bars = pullbackSeries();
  const now = 26 * MIN;
  const f = buildFeatures({ bars1m: bars, bars15m: [], btc5m: [], now });
  const s = setupA(f);
  assertEquals(s.pass, true, `expected SETUP_A, got ${s.reason}`);
  assertEquals(s.setupType, "A");
  assert(s.setupLow > 0);
  assert(s.triggerLevel > 0);
});

Deno.test("setupA rejects when the pullback traded HEAVIER than the leg", () => {
  const bars = pullbackSeries();
  for (let i = 22; i < 25; i++) bars[i].qv = 99_000;
  const f = buildFeatures({ bars1m: bars, bars15m: [], btc5m: [], now: 26 * MIN });
  assertEquals(setupA(f).reason, "PULLBACK_VOLUME_NOT_LIGHTER");
});

Deno.test("setupB requires explicit hold proof; a missing proof is not an implicit pass", () => {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 21; i++) { bars.push(bar(i * MIN, p, p + 0.3, p - 0.3, p, 1000, 600)); }
  bars.push(bar(21 * MIN, p, p + 5, p - 0.1, p + 4, 9000, 7000));
  const f = buildFeatures({ bars1m: bars, bars15m: [], btc5m: [], now: 22 * MIN });
  assertEquals(setupB(f, undefined).reason, "HOLD_PROOF_MISSING");
  assertEquals(setupB(f, { heldMs: 3000, minPrice: 1e9 }).reason, "HOLD_TOO_SHORT");
});

Deno.test("chaseGate caps how far past the trigger we will pay", () => {
  const s = { triggerLevel: 100 };
  assertEquals(chaseGate(s, 100.2, 4).pass, true, "0.05 ATR above trigger is fine");
  assertEquals(chaseGate(s, 102, 4).reason, "CHASE_TOO_FAR", "0.5 ATR is beyond the 0.25 cap");
  assertEquals(chaseGate(s, 100.2, NaN).pass, false, "unknown ATR must not pass");
});

/* ----------------------------------------------------------- order flow ---- */

Deno.test("a strong 10s/60s burst cannot override 3-minute selling", () => {
  const t60 = { known: true, buyShare: 0.90, delta: 5000, sufficient: true, aggCount: 50, totalQuote: 1e5 };
  const t180 = { known: true, buyShare: 0.40, delta: -9000, sufficient: true, aggCount: 150, totalQuote: 3e5 };
  const g = orderFlowGate({ t60, t180, imbalance30sAvg: 0.5, price: 101, triggerLevel: 100 });
  assertEquals(g.pass, false);
  assert(g.codes.includes("BUY_SHARE_180S"));
});

Deno.test("orderFlowGate requires price to still hold the trigger", () => {
  const t60 = { known: true, buyShare: 0.8, delta: 100, sufficient: true };
  const t180 = { known: true, buyShare: 0.6, delta: 100, sufficient: true };
  const g = orderFlowGate({ t60, t180, imbalance30sAvg: 0.3, price: 99, triggerLevel: 100 });
  assertEquals(g.pass, false);
  assert(g.codes.includes("PRICE_LOST_TRIGGER"));
});

/* ------------------------------------------------------------ risk/size ---- */

Deno.test("structuralStop sits below the setup low and rounds DOWN for a LONG", () => {
  const s = structuralStop(100, 5, 0.1); // pad = max(0.2, 1.0) = 1.0
  assert(s.known);
  assertAlmostEquals(s.value, 99.0, 1e-9);
  const tiny = structuralStop(100, 0.001, 0.1); // pad = max(0.2, 0.0002) = 0.2
  assertAlmostEquals(tiny.value, 99.8, 1e-9);
});

Deno.test("sizePosition shrinks quantity instead of tightening the stop", () => {
  const common = {
    entryPrice: 100, maxNotionalUsdt: 120, leverage: 3, availableMarginUsdt: 40,
    bidDepth25: 1e9, askDepth25: 1e9, qtyStep: 0.001, minNotionalUsdt: 5,
    entryFeeRate: 0.00045, exitFeeRate: 0.00045,
  };
  const wide = sizePosition({ ...common, stopPrice: 97, riskBudgetUsdt: 1 });
  const tight = sizePosition({ ...common, stopPrice: 99.5, riskBudgetUsdt: 1 });
  assert(wide.ok && tight.ok);
  assert(wide.quantity < tight.quantity, "a wider stop must produce a SMALLER position");
  assertEquals(wide.binding, "RISK");
});

Deno.test("sizePosition refuses a stop wider than the policy maximum", () => {
  const r = sizePosition({
    entryPrice: 100, stopPrice: 90, riskBudgetUsdt: 100, maxNotionalUsdt: 120, leverage: 3,
    availableMarginUsdt: 40, bidDepth25: 1e9, askDepth25: 1e9, qtyStep: 0.001,
    minNotionalUsdt: 5, entryFeeRate: 0.00045, exitFeeRate: 0.00045,
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "STOP_TOO_WIDE");
});

Deno.test("sizePosition is capped by book depth", () => {
  const r = sizePosition({
    entryPrice: 100, stopPrice: 99, riskBudgetUsdt: 1e6, maxNotionalUsdt: 1e6, leverage: 3,
    availableMarginUsdt: 1e6, bidDepth25: 1000, askDepth25: 1000, qtyStep: 0.001,
    minNotionalUsdt: 5, entryFeeRate: 0, exitFeeRate: 0,
  });
  assert(r.ok);
  assertEquals(r.binding, "LIQUIDITY");
  assertAlmostEquals(r.notionalUsdt, 50, 1e-6, "5% of the thinner 1000 USDT side");
});

Deno.test("costEdgeGate refuses to invent a win probability from a small sample", () => {
  const base = { costBps: 10, spreadBps: 5, notionalUsdt: 100, bidDepth25: 1e6, askDepth25: 1e6 };
  assertEquals(costEdgeGate({ ...base, expectedEdgeBps: 100, samples: 5 }).reason, "EDGE_SAMPLE_INSUFFICIENT");
  assertEquals(costEdgeGate({ ...base, expectedEdgeBps: 15, samples: 100 }).reason, "EDGE_BELOW_COST_MULTIPLE");
  assertEquals(costEdgeGate({ ...base, expectedEdgeBps: 25, samples: 100 }).pass, true);
});

Deno.test("costEdgeGate blocks a wide spread and an oversized order", () => {
  const base = { expectedEdgeBps: 1000, samples: 500, costBps: 10, bidDepth25: 1e6, askDepth25: 1e6 };
  assertEquals(costEdgeGate({ ...base, spreadBps: 50, notionalUsdt: 10 }).reason, "SPREAD");
  assertEquals(costEdgeGate({ ...base, spreadBps: 5, notionalUsdt: 1e6 }).reason, "ORDER_TOO_LARGE_FOR_BOOK");
});

/* ------------------------------------------------------------------ P&L ---- */

Deno.test("netRealisable charges the exit fee once and never re-charges fill slippage", () => {
  const g = netRealisable({
    entryPrice: 100, remainingQty: 1, sellVwap: 110, realisedGross: 0,
    feesPaid: 0.045, fundingCashflow: 0, exitFeeRate: 0.00045, latencyReserveBps: 0,
  });
  assert(g.known);
  assertAlmostEquals(g.value, 10 - 0.045 - 110 * 0.00045, 1e-9);
});

Deno.test("netRealisable is UNKNOWN when the remainder cannot be priced", () => {
  const g = netRealisable({
    entryPrice: 100, remainingQty: 1, sellVwap: null, realisedGross: 0,
    feesPaid: 0, exitFeeRate: 0.00045,
  });
  assertEquals(g.known, false, "no executable exit price -> UNKNOWN, not 0");
});

Deno.test("funding is a SIGNED cashflow: positive funding is a cost for a LONG", () => {
  const paid = netRealisable({
    entryPrice: 100, remainingQty: 1, sellVwap: 100, realisedGross: 0, feesPaid: 0,
    fundingCashflow: -0.5, exitFeeRate: 0, latencyReserveBps: 0,
  });
  const received = netRealisable({
    entryPrice: 100, remainingQty: 1, sellVwap: 100, realisedGross: 0, feesPaid: 0,
    fundingCashflow: +0.5, exitFeeRate: 0, latencyReserveBps: 0,
  });
  assertAlmostEquals(paid.value, -0.5, 1e-12);
  assertAlmostEquals(received.value, 0.5, 1e-12);
});

/* ----------------------------------------------------------- profit lock ---- */

Deno.test("profit lock does not arm on a small excursion", () => {
  const f = profitLockFloor(0.5, 3);       // M = 0.5R
  assertEquals(f.value, 0, "below 1R there is no lock and no forced scratch");
});

Deno.test("profit lock arms at 1R and captures 60% at 2R, ratcheting only upward", () => {
  assertAlmostEquals(profitLockFloor(3, 3).value, 0.6, 1e-12, "1R -> floor 0.20R");
  assertAlmostEquals(profitLockFloor(6, 3).value, 3.6, 1e-12, "2R -> floor 0.60*M");
  assertAlmostEquals(profitLockFloor(3, 3, 5).value, 5, 1e-12, "an existing higher floor is never lowered");
});

Deno.test("trailLevel never lowers a LONG's protection", () => {
  const t = trailLevel({ confirmedHigherLow: 100, peakPrice: 120, atr3m: 5, priorStop: 118, tick: 0.01 });
  assert(t.known);
  assertAlmostEquals(t.value, 118, 1e-9, "candidates 99 and 110 both lose to the prior 118");
});

Deno.test("trailLevel rounds a SELL trigger UP so rounding cannot widen the loss", () => {
  const t = trailLevel({ confirmedHigherLow: 100.004, peakPrice: 100.004, atr3m: 1e-9, priorStop: null, tick: 0.01 });
  assert(t.known);
  assert(t.value >= 100.004 - 1e-9);
  assertAlmostEquals(t.value, 100.01, 1e-9);
});

/* ------------------------------------------------------------ exit rules ---- */

Deno.test("momentumBreak needs structure AND flow, not two readings of one EMA", () => {
  const t60weak = { known: true, buyShare: 0.30 };
  const t180ok = { known: true, buyShare: 0.70 };
  // structure broken but flow fine -> no break
  assertEquals(momentumBreak({
    last1mClose: 90, supportLow: 95, t60: { known: true, buyShare: 0.8 },
    imbalance30sAvg: 0.3, closed3m: [], ema21_3mSeries: [], t180: t180ok,
  }).broken, false);
  // structure broken and flow weak -> break
  assertEquals(momentumBreak({
    last1mClose: 90, supportLow: 95, t60: t60weak, imbalance30sAvg: -0.3,
    closed3m: [], ema21_3mSeries: [], t180: t180ok,
  }).broken, true);
});

Deno.test("earlyFailure needs corroboration, not a single lost tick", () => {
  const base = {
    heldMs: 60_000, price: 99, triggerLevel: 100, setupLow: 98,
    t60: { known: true, buyShare: 0.30 }, t180: { known: true, buyShare: 0.80 },
    imbalance30sAvg: 0.2, bidDepth25: 1000, bidDepth25Baseline: 1000,
  };
  assertEquals(earlyFailure(base).fail, false, "lost level + weak 60s alone is not enough");
  assertEquals(earlyFailure({ ...base, bidDepth25: 500 }).fail, true, "bid depth halved corroborates");
  assertEquals(earlyFailure({ ...base, imbalance30sAvg: -0.3 }).fail, true);
});

Deno.test("earlyFailure only applies inside the failure window", () => {
  const late = {
    heldMs: 10 * MIN, price: 99, triggerLevel: 100, setupLow: 98,
    t60: { known: true, buyShare: 0.1 }, t180: { known: true, buyShare: 0.1 },
    imbalance30sAvg: -0.9, bidDepth25: 1, bidDepth25Baseline: 1000,
  };
  assertEquals(earlyFailure(late).fail, false);
});

Deno.test("timeStop does not fire merely because profit is small", () => {
  const base = { heldMs: 6 * MIN, M: 0.1, R0: 3, priceHoldsTrigger: true, t180: { known: true, buyShare: 0.3 } };
  assertEquals(timeStop(base).exit, false, "structure still holding -> not a time stop");
  assertEquals(timeStop({ ...base, priceHoldsTrigger: false }).exit, true);
  assertEquals(timeStop({ ...base, priceHoldsTrigger: false, t180: { known: true, buyShare: 0.9 } }).exit, false,
    "3m flow still buying -> give it room");
});

Deno.test("evaluateExit puts the hard stop ahead of every confirmation", () => {
  const d = evaluateExit({
    position: { entryPrice: 100, remainingQty: 1, R0: 3, entryAt: 0, stopPrice: 98, setupLow: 98 },
    now: 30_000, exitFeeRate: 0.00045,
    book: { bestBid: 97, bestAsk: 97.1, bids: [[97, 100]], asks: [[97.1, 100]] },
    t60: { known: true, buyShare: 0.99 }, t180: { known: true, buyShare: 0.99 },
    imbalance30sAvg: 0.9, features: {},
  });
  assertEquals(d.action, "EXIT");
  assertEquals(d.reason, "V24_STRUCTURAL_STOP");
});

Deno.test("evaluateExit holds a healthy trade and reports G/M", () => {
  const d = evaluateExit({
    position: { entryPrice: 100, remainingQty: 1, R0: 3, entryAt: 0, stopPrice: 98, setupLow: 98, peakPrice: 101 },
    now: 30_000, exitFeeRate: 0.00045, priceTick: 0.01,
    book: { bestBid: 101, bestAsk: 101.1, bids: [[101, 100]], asks: [[101.1, 100]] },
    t60: { known: true, buyShare: 0.7 }, t180: { known: true, buyShare: 0.6 },
    imbalance30sAvg: 0.2, features: { atr14_3m: 1, closed1m: [], closed3m: [], ema21_3m_series: [] },
  });
  assert(["HOLD", "UPDATE_PROTECTION"].includes(d.action));
  assert(d.G !== null);
});

Deno.test("evaluateExit never lowers the stop when it raises protection", () => {
  const d = evaluateExit({
    position: {
      entryPrice: 100, remainingQty: 1, R0: 3, entryAt: 0, stopPrice: 99.5,
      setupLow: 98, peakPrice: 110, confirmedHigherLow: 105,
    },
    now: 10 * MIN, exitFeeRate: 0.00045, priceTick: 0.01,
    book: { bestBid: 109, bestAsk: 109.1, bids: [[109, 100]], asks: [[109.1, 100]] },
    t60: { known: true, buyShare: 0.7 }, t180: { known: true, buyShare: 0.6 },
    imbalance30sAvg: 0.2, features: { atr14_3m: 1, closed1m: [], closed3m: [], ema21_3m_series: [] },
  });
  if (d.action === "UPDATE_PROTECTION") assert(d.stopPrice > 99.5, "protection must move up, never down");
});

/* --------------------------------------------------------------- re-entry ---- */

Deno.test("no immediate re-entry on the same setup after a stop-out", () => {
  const t60 = { known: true, buyShare: 0.9 };
  assertEquals(reentryAllowed({ lastExitAt: 0, now: 60_000, lastSetupId: "X", candidateSetupId: "X", t60 }).reason, "COOLDOWN");
  assertEquals(reentryAllowed({ lastExitAt: 0, now: 10 * MIN, lastSetupId: "X", candidateSetupId: "X", t60 }).reason, "SAME_SETUP");
  assertEquals(reentryAllowed({ lastExitAt: 0, now: 10 * MIN, lastSetupId: "X", candidateSetupId: "Y", t60 }).allowed, true);
  assertEquals(reentryAllowed({
    lastExitAt: 0, now: 10 * MIN, lastSetupId: "X", candidateSetupId: "Y",
    t60: { known: true, buyShare: 0.1 },
  }).reason, "FLOW_NOT_RECOVERED");
});

/* ------------------------------------------------------------ end-to-end ---- */

Deno.test("evaluateEntry returns SKIP with a stage and reason, never a bare boolean", () => {
  const r = evaluateEntry({
    symbol: "TESTUSDT", now: 16 * MIN, dataQuality: "OK",
    leader: { dayReturn: -0.01, rank: 1, quoteVolume24h: 1e8 },
    features: {}, sizing: {}, entryFeeRate: 0.00045, exitFeeRate: 0.00045,
  });
  assertEquals(r.decision, "SKIP");
  assertEquals(r.state, "UNIVERSE");
  assertEquals(r.reason, "DAY_RETURN_NOT_POSITIVE");
  assert(Array.isArray(r.reasonCodes));
});

Deno.test("evaluateEntry refuses to trade on degraded data", () => {
  const r = evaluateEntry({
    symbol: "TESTUSDT", now: 1, dataQuality: "STALE",
    leader: { dayReturn: 0.5, rank: 1, quoteVolume24h: 1e9 },
    features: {}, sizing: {},
  });
  assertEquals(r.decision, "SKIP");
  assertEquals(r.reason, "DATA_STALE");
});
