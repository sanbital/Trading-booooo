/** V17 exit shadow worker — phase 1 of the sub-second event host.
 *
 * Ingests Binance USDⓈ-M aggTrade / kline_1m, normalizes them into the event shape
 * leader-exit-r4 expects, and runs the R4 decision engine on live data.
 *
 * It DECIDES ONLY. There is deliberately no broker, no signer, no order path and no
 * position write here: nothing in this module can reach an exchange or a database.
 * Its output is a decision log used to compare shadow decisions against what the live
 * one-minute executor actually did, which is the gate for promoting to phase 2.
 *
 * The offline measurement this design rests on (642,410 real aggregate trades across
 * nine V17 positions): aggregate-trade ids were contiguous on every symbol, the median
 * inter-trade gap was 0-44ms, gaps over the 3s evidence window covered 0.60% of
 * observed time, and a 10s confirmation window could complete 95.5-100% of the time.
 * The counters below re-measure exactly those quantities on live data so the assumption
 * is checked in production rather than trusted.
 */
// The decision engine is INJECTED, never imported. The gateway image is built from the
// gateway/ directory alone, so it cannot reach supabase/functions/_shared, and copying
// the engine in would let the shadow drift away from the engine the executor runs.
// Injection keeps one copy of the engine and lets this module be hosted either side.

export function streamsFor(symbols) {
  const seen = new Set();
  for (const s of symbols) {
    const sym = String(s || "").toUpperCase();
    if (!/^[A-Z0-9]+USDT$/.test(sym)) throw new Error(`INVALID_SHADOW_SYMBOL:${sym}`);
    seen.add(sym);
  }
  return [...seen].flatMap((s) => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@kline_1m`]);
}

/** Binance stream payload -> engine event. Returns null for anything not usable.
 * Unclosed candles are dropped: a running bar has no final close and must never
 * move a close-based protection level. */
export function toEvent(message, receivedAt) {
  const d = message?.data ?? message;
  if (!d || typeof d !== "object") return null;
  if (d.e === "aggTrade") {
    const price = Number(d.p), at = Number(d.T), sequence = Number(d.a);
    if (!(price > 0) || !Number.isFinite(at) || !Number.isSafeInteger(sequence)) return null;
    return { symbol: String(d.s).toUpperCase(), type: "tick", price, at, sequence, receivedAt };
  }
  if (d.e === "kline") {
    const k = d.k;
    if (!k || k.x !== true) return null; // only closed candles
    const close = Number(k.c), closeAt = Number(k.T);
    if (!(close > 0) || !Number.isFinite(closeAt)) return null;
    return { symbol: String(d.s).toUpperCase(), type: "bar", close, closeAt, receivedAt };
  }
  return null;
}

function newCoverage() {
  return {
    ticks: 0,
    bars: 0,
    gapsOverWindow: 0,
    maxGapMs: 0,
    sequenceBreaks: 0,
    staleEvents: 0,
    lastTickAt: null,
    confirmationsStarted: 0,
    confirmationsCompleted: 0,
    confirmationsReset: 0,
    breachSince: null,
  };
}

/** Mirrors the engine's own gap accounting so the promotion decision can be made on
 * measured coverage rather than on the assumption that the feed is dense enough. */
function trackCoverage(cov, event, out, { maxDataAgeMs, confirmMs }) {
  // A completed confirmation is visible only as an emitted signal: when the engine
  // confirms, it marks the leg closed and leaves breachSince set, so watching for
  // breachSince to return to null counts resets and never counts completions.
  for (const s of out?.signals ?? []) {
    if (/^R3_CONFIRMED/.test(s.reason)) cov.confirmationsCompleted++;
  }
  if (event.type === "bar") {
    cov.bars++;
    return;
  }
  cov.ticks++;
  if (cov.lastTickAt !== null) {
    const gap = event.at - cov.lastTickAt;
    if (gap > cov.maxGapMs) cov.maxGapMs = gap;
    if (gap > maxDataAgeMs) cov.gapsOverWindow++;
  }
  cov.lastTickAt = event.at;
  if (out?.dataGap) cov.staleEvents++;
  const breach = out?.state?.risk?.breachSince ?? null;
  if (breach !== null && cov.breachSince === null) cov.confirmationsStarted++;
  else if (breach === null && cov.breachSince !== null) {
    // A breach that cleared without reaching the confirmation window was reset by a
    // data gap or by price reclaiming the level; both mean "no exit", not "exit late".
    if (event.at - cov.breachSince < confirmMs) cov.confirmationsReset++;
    else cov.confirmationsCompleted++;
  }
  cov.breachSince = breach;
}

/**
 * @param {object} deps
 * @param {(streams:string[])=>{close:()=>void}} deps.connect  opens the stream; must call
 *        deps.onMessage for each payload. Injected so tests drive it without a socket.
 * @param {()=>Promise<Array>} deps.listPositions  positions to shadow. Each needs
 *        {symbol, entryPrice, entryAt, quantity, entryFee, quantityStep}.
 * @param {(decision:object)=>void} deps.emit  decision sink (log line, ring buffer).
 */
export function createShadowWorker({
  engine,
  connect,
  listPositions,
  emit = () => {},
  report = () => {},
  clock = Date.now,
  policy,
  timers = globalThis,
  // Must equal R3_CANDIDATE.maxDataAgeMs / lossConfirmMs. These only drive the coverage
  // counters; the engine enforces its own copies when it decides.
  maxDataAgeMs = 3000,
  confirmMs = 10000,
  refreshMs = 15000,
}) {
  if (typeof connect !== "function" || typeof listPositions !== "function") {
    throw new Error("SHADOW_WORKER_DEPS");
  }
  const { newR4State, nextR4Exit, r4PolicyKey, R4_CANDIDATE } = engine ?? {};
  for (const [name, fn] of [["newR4State", newR4State], ["nextR4Exit", nextR4Exit], ["r4PolicyKey", r4PolicyKey]]) {
    if (typeof fn !== "function") throw new Error(`SHADOW_WORKER_ENGINE:${name}`);
  }
  policy = policy ?? R4_CANDIDATE;
  if (!policy) throw new Error("SHADOW_WORKER_POLICY");
  const tracked = new Map(); // symbol -> {state, coverage, position, skipped}
  let socket = null, running = false, refreshTimer = null, subscribed = "";

  function admit(p) {
    const symbol = String(p.symbol || "").toUpperCase();
    const entry = {
      // newR3State rejects a missing positionId, so omitting it here would silently
      // shunt every position into "skipped" and the shadow would observe nothing.
      positionId: p.positionId ?? p.id ?? symbol,
      entryPrice: Number(p.entryPrice),
      entryAt: Number(p.entryAt),
      quantity: Number(p.quantity),
      entryFee: Number(p.entryFee),
      quantityStep: Number(p.quantityStep),
    };
    try {
      return {
        symbol,
        state: newR4State(entry, policy),
        coverage: newCoverage(),
        policyKey: r4PolicyKey(policy),
        skipped: null,
      };
    } catch (error) {
      // A position too small to split, or one with unusable entry data, is recorded as
      // skipped rather than silently dropped: phase 2 has to decide what to do with it.
      return { symbol, state: null, coverage: newCoverage(), skipped: String(error.message || error) };
    }
  }

  async function refresh() {
    let positions;
    try {
      positions = await listPositions();
    } catch (error) {
      report({ kind: "SHADOW_POSITIONS_FAILED", error: String(error.message || error) });
      return;
    }
    const live = new Set();
    for (const p of positions ?? []) {
      const symbol = String(p.symbol || "").toUpperCase();
      live.add(symbol);
      if (!tracked.has(symbol)) {
        const t = admit(p);
        tracked.set(symbol, t);
        report({ kind: t.skipped ? "SHADOW_SKIPPED" : "SHADOW_TRACKING", symbol, reason: t.skipped });
      }
    }
    for (const symbol of [...tracked.keys()]) {
      if (!live.has(symbol)) {
        report({ kind: "SHADOW_RELEASED", symbol, coverage: tracked.get(symbol).coverage });
        tracked.delete(symbol);
      }
    }
    const wanted = tracked.size ? streamsFor([...tracked.keys()]).join("/") : "";
    if (wanted !== subscribed) {
      if (socket) socket.close();
      socket = wanted ? connect(wanted.split("/")) : null;
      subscribed = wanted;
    }
  }

  function onMessage(message) {
    const receivedAt = clock();
    const event = toEvent(message, receivedAt);
    if (!event) return;
    const t = tracked.get(event.symbol);
    if (!t || !t.state) return;
    let out;
    try {
      out = nextR4Exit(t.state, event, policy);
    } catch (error) {
      // A malformed event must not kill the worker or, worse, be mistaken for a decision.
      report({ kind: "SHADOW_EVENT_REJECTED", symbol: event.symbol, error: String(error.message || error) });
      return;
    }
    // A duplicate or out-of-order event carries no new evidence. Counting it would
    // inflate the density measurement that decides whether the 10s confirmation is
    // feasible, which is the one number this phase exists to establish.
    if (out.ignored) return;
    trackCoverage(t.coverage, event, out, { maxDataAgeMs, confirmMs });
    t.state = out.state;
    for (const signal of out.signals ?? []) {
      emit({
        kind: "SHADOW_EXIT_SIGNAL",
        symbol: event.symbol,
        leg: signal.leg,
        reason: signal.reason,
        at: signal.at,
        quantity: signal.quantity,
        observedPrice: event.type === "tick" ? event.price : event.close,
        eventType: event.type,
        sequence: event.sequence ?? null,
        coverageBroken: t.state.coverageBroken === true,
        decidedAt: receivedAt,
        // Nothing acts on this. Phase 2 is what turns a signal into an intent.
        executed: false,
      });
    }
  }

  return {
    onMessage,
    async start() {
      if (running) return;
      running = true;
      await refresh();
      refreshTimer = timers.setInterval(() => {
        refresh().catch((error) => report({ kind: "SHADOW_REFRESH_FAILED", error: String(error) }));
      }, refreshMs);
      if (typeof refreshTimer?.unref === "function") refreshTimer.unref();
    },
    stop() {
      running = false;
      if (refreshTimer) timers.clearInterval(refreshTimer);
      refreshTimer = null;
      if (socket) socket.close();
      socket = null;
      subscribed = "";
    },
    /** Read-only view for the comparison that gates promotion to phase 2. */
    snapshot() {
      return [...tracked.entries()].map(([symbol, t]) => ({
        symbol,
        skipped: t.skipped,
        coverage: { ...t.coverage },
        riskClosed: t.state?.risk?.closed ?? null,
        runnerClosed: t.state?.runnerClosed ?? null,
        peak: t.state?.peak ?? null,
      }));
    },
  };
}
