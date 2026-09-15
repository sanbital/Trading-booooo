/**
 * V24 ENTRY ADAPTER — wires the V24 leader-continuation core into the live executor.
 *
 * Shape deliberately matches the existing QV3 and E1 gates in openBull(): it is a
 * confirmation layer applied to a signal the V17 generator has already produced. It can
 * only NARROW V17's signals, never create its own — generating V24 signals outright would
 * require changing v10-lane-signal-generator as well.
 *
 * This module never submits an order and never mutates a position. It returns a decision
 * and the evidence behind it. Every failure path returns a BLOCKING decision: a fetch
 * timeout, a truncated tape or a malformed book must never read as "no objection".
 *
 * COST-EDGE INPUT — read this before enabling.
 * V24's cost gate requires an expected edge backed by >= 30 samples. No estimator for that
 * exists, and the estimate that *can* be built from the measured data is NEGATIVE
 * (see research/v24/HYPOTHESIS_TEST_20260915.md: top-10 KST gainers touch -1% before +1%
 * in 63.7% of cases, and every TP/SL pairing tested falls 25-50 points short of its
 * break-even first-touch rate). So with no override the gate blocks every entry, which is
 * the correct behaviour for a rule that refuses to trade without evidence.
 *
 * An operator who wants to trade anyway must state the assumption explicitly via
 * V24_ASSUMED_EDGE_BPS and V24_EDGE_SAMPLES. That assumption is stamped on every decision
 * as OPERATOR_ASSUMED_UNVALIDATED so it can never be mistaken in the audit trail for a
 * measured edge. It is not a validated parameter and this module does not present it as one.
 */
import {
  V24_POLICY, V24_VERSION, MIN, closedBars, resample, atrWilder, emaSeries, rvol1,
  setupA, chaseGate, trendGate, leaderGate, structuralStop, sizePosition,
  costEdgeGate, orderFlowGate, tapeWindow, bookMetrics, executionCostBps, absorptionFlag,
} from "./v24-leader-continuation.mjs";

export const V24_ADAPTER_VERSION = "V24_ENTRY_ADAPTER_1";

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };

/** Gateway quote levels arrive as {price,size}; the core reads [price,qty]/{price,qty}. */
function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return null;
  const out = [];
  for (const lv of levels) {
    const p = n(lv?.price ?? lv?.[0]), q = n(lv?.size ?? lv?.qty ?? lv?.[1]);
    if (!(p > 0) || !(q >= 0)) return null;
    out.push([p, q]);
  }
  return out;
}

/** Public klines. No authenticated endpoint, no gateway dependency. */
export async function fetchKlines(symbol, interval, limit, fetchImpl = fetch, timeoutMs = 2500) {
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", String(symbol));
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const c = new AbortController(), t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: c.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw Error(`V24_KLINES_HTTP_${r.status}`);
    const raw = await r.json();
    if (!Array.isArray(raw)) throw Error("V24_KLINES_SHAPE");
    return raw.map((b) => ({
      t: Number(b[0]), o: Number(b[1]), h: Number(b[2]), l: Number(b[3]), c: Number(b[4]),
      qv: Number(b[7]), tbq: Number(b[10]), closeMs: Number(b[6]),
    }));
  } finally { clearTimeout(t); }
}

/**
 * Aggressive buy/sell split over the last 180 s, with the 60 s window derived from the
 * same rows so only one request is made. Binance caps aggTrades at 1000 rows; on a hot
 * leader 180 s can exceed that, and a truncated tape is UNKNOWN, not a pass.
 */
export async function fetchTape(symbol, now, fetchAgg) {
  const start180 = now - 180_000, start60 = now - 60_000;
  const res = await fetchAgg(symbol, start180, now);
  if (!res || res.available === false || !Array.isArray(res.raw))
    return { t60: { known: false, reason: res?.reason ?? "V24_TAPE_UNAVAILABLE" },
             t180: { known: false, reason: res?.reason ?? "V24_TAPE_UNAVAILABLE" } };
  if (res.raw.length >= V24_POLICY.tapeRowCap)
    return { t60: { known: false, reason: "V24_TAPE_TRUNCATED" },
             t180: { known: false, reason: "V24_TAPE_TRUNCATED" }, rows: res.raw.length };
  return {
    t60: tapeWindow(res.raw, start60, now),
    t180: tapeWindow(res.raw, start180, now),
    rows: res.raw.length,
  };
}

function blocked(reason, extra = {}) {
  return {
    version: V24_VERSION, adapter: V24_ADAPTER_VERSION,
    decision: "SKIP", allowed: false, reason, reasonCodes: [reason],
    parametersValidatedByBacktest: false, executionEnabled: false, ...extra,
  };
}

/**
 * Evaluate one V17 signal against the V24 entry rule.
 *
 * LEADER is taken from the signal's own features rather than re-ranked here: the executor
 * already trusts those, and re-deriving a rank from a different snapshot would let the
 * gate disagree with the signal it is gating for a reason unrelated to V24.
 */
export async function v24EntryGate({
  symbol, features, quote, quantityStep, priceTick, now,
  fetchAgg, klines = fetchKlines, edge,
}) {
  try {
    const L = leaderGate({
      dayReturn: n(features?.dayReturn), rank: n(features?.rank),
      quoteVolume24h: n(features?.qv24),
    });
    if (!L.pass) return blocked(`V24_${L.reason}`);

    const [own, btc] = await Promise.all([
      klines(symbol, "1m", 400),
      klines("BTCUSDT", "1m", 40),
    ]);
    const c1 = closedBars(own, now, MIN);
    if (c1.length < 30) return blocked("V24_INSUFFICIENT_1M_HISTORY", { bars: c1.length });

    const c3 = resample(c1, 3).filter((b) => b.closeMs < now);
    const c5 = resample(c1, 5).filter((b) => b.closeMs < now);
    const b5 = resample(closedBars(btc, now, MIN), 5).filter((b) => b.closeMs < now);
    if (c5.length < 25 || c3.length < 16) return blocked("V24_INSUFFICIENT_RESAMPLED_HISTORY");

    const closes5 = c5.map((b) => b.c);
    const e9 = emaSeries(closes5, 9), e21 = emaSeries(closes5, 21);
    const atr3 = atrWilder(c3, 14);
    if (!atr3.known || e21.length < 4 || !e9.length) return blocked("V24_INDICATORS_UNKNOWN");

    const r15 = c5.length >= 4 ? c5.at(-1).c / c5.at(-4).c - 1 : null;
    const btcR15 = b5.length >= 4 ? b5.at(-1).c / b5.at(-4).c - 1 : null;
    const rv1 = rvol1(c1);

    const f = {
      closed1m: c1, closed3m: c3, closed5m: c5,
      last5mClose: c5.at(-1).c, ema9_5m: e9.at(-1), ema21_5m: e21.at(-1),
      ema21_5m_prev3: e21.at(-4), ema21_3m_series: emaSeries(c3.map((b) => b.c), 21),
      atr14_3m: atr3.value, rvol1: rv1.known ? rv1.value : null,
      rvol15: n(features?.volumeRatio), rs15: r15 !== null && btcR15 !== null ? r15 - btcR15 : null,
      return15m: r15,
    };

    const T = trendGate(f);
    if (!T.pass) return blocked(`V24_${T.reason}`);

    // SETUP_B needs a 10-second dwell proof that a one-minute executor cycle cannot
    // produce, so only path A is reachable live today. That is a stated limitation, not
    // an implicit pass: B is simply never claimed.
    const a = setupA(f);
    if (!a.pass) return blocked(`V24_${a.reason}`);

    const price = c1.at(-1).c;
    const C = chaseGate(a, price, f.atr14_3m);
    if (!C.pass) return blocked(`V24_${C.reason}`, { setupType: "A" });

    const tape = await fetchTape(symbol, now, fetchAgg);
    const book = bookMetrics({
      bestBid: n(quote?.best_bid), bestAsk: n(quote?.best_ask),
      bids: normalizeLevels(quote?.bids), asks: normalizeLevels(quote?.asks),
    }, n(features?.probeQuantity) > 0 ? n(features.probeQuantity) : 1);
    if (!book.known) return blocked(`V24_${book.reason}`, { setupType: "A" });

    // Instantaneous book imbalance. The rule asks for a 30 s time-weighted average; the
    // executor's one-minute cycle observes a single snapshot, so this is a WEAKER input
    // than specified and is labelled as such rather than passed off as the real thing.
    const F = orderFlowGate({
      t60: tape.t60, t180: tape.t180, imbalance30sAvg: book.imbalance25,
      price, triggerLevel: a.triggerLevel,
    });
    if (!F.pass) {
      return blocked(`V24_${F.reason}`, {
        setupType: "A", flowCodes: F.codes, tapeRows: tape.rows ?? null,
        imbalanceBasis: "INSTANTANEOUS_SNAPSHOT_NOT_30S_TWA",
      });
    }

    const cost = executionCostBps(book, 0.0005, 0.0005);
    if (!cost.known) return blocked("V24_COST_UNKNOWN", { setupType: "A" });

    const stop = structuralStop(a.setupLow, f.atr14_3m, n(priceTick));
    if (!stop.known || !(stop.value < price))
      return blocked("V24_STOP_UNKNOWN", { setupType: "A" });

    const E = costEdgeGate({
      expectedEdgeBps: edge?.expectedEdgeBps, samples: edge?.samples,
      costBps: cost.value, spreadBps: book.spreadBps,
      notionalUsdt: n(features?.notionalUsdt), bidDepth25: book.bidDepth25,
      askDepth25: book.askDepth25,
    });
    if (!E.pass) {
      return blocked(`V24_${E.reason}`, {
        setupType: "A", costBps: cost.value, initialStop: stop.value,
        edgeBasis: edge?.basis ?? "NO_EDGE_ESTIMATE_AVAILABLE",
      });
    }

    return {
      version: V24_VERSION, adapter: V24_ADAPTER_VERSION,
      decision: "ENTER", allowed: true, reason: "V24_ENTRY_CONFIRMED",
      reasonCodes: ["V24_LEADER", "V24_TREND", "V24_SETUP_A", "V24_FLOW_CONFIRMED", "V24_COST_EDGE_OK"],
      setupId: `${symbol}:A:${a.triggerBarT}`, setupType: "A",
      triggerLevel: a.triggerLevel, setupLow: a.setupLow, initialStop: stop.value,
      costBps: cost.value, netEdgeBps: E.netEdgeBps, atr14_3m: f.atr14_3m,
      buyShare60s: tape.t60.buyShare, buyShare180s: tape.t180.buyShare,
      imbalance25: book.imbalance25, spreadBps: book.spreadBps,
      absorption: absorptionFlag(tape.t60, price / c1.at(-2).c - 1),
      edgeBasis: edge?.basis ?? null,
      imbalanceBasis: "INSTANTANEOUS_SNAPSHOT_NOT_30S_TWA",
      setupPathsAvailable: "A_ONLY_B_NEEDS_SUBMINUTE_DWELL",
      parametersValidatedByBacktest: false, executionEnabled: true,
    };
  } catch (e) {
    // An adapter fault must never read as approval, and must never propagate into the
    // executor's protection or reconciliation paths.
    return blocked("V24_ADAPTER_FAULT", { detail: String(e?.message ?? e).slice(0, 200) });
  }
}

/**
 * Resolves the operator's edge assumption from the environment. Returns null when unset,
 * which makes costEdgeGate refuse — the intended default.
 */
export function resolveEdge(env) {
  // Number("") is 0, not NaN, so an unset variable would otherwise resolve to a
  // zero-edge object and silently look like a configured assumption.
  const rawBps = String(env("V24_ASSUMED_EDGE_BPS") ?? "").trim();
  const rawSamples = String(env("V24_EDGE_SAMPLES") ?? "").trim();
  if (rawBps === "" || rawSamples === "") return null;
  const bps = Number(rawBps), samples = Number(rawSamples);
  if (!Number.isFinite(bps) || !Number.isFinite(samples) || samples <= 0) return null;
  return {
    expectedEdgeBps: bps, samples,
    basis: "OPERATOR_ASSUMED_UNVALIDATED",
    measuredEdgeContradicts: true,
    note: "Full-market test found no positive edge; this value is an operator assumption.",
  };
}
