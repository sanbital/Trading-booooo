/**
 * Research candidate R1 (brief section 5) as a pure function.
 *
 * "Enter strong names that are already up a lot on the day, hold while they
 *  stay strong, leave when the reason to be long is gone."
 *
 * This is a RESEARCH CANDIDATE.  Nothing in here is a validated parameter set,
 * and the numbers are the brief's starting values, not fitted ones.  The entry
 * gate refuses to trade it until a validation record exists that references
 * this file's hash (see entry-gate.mjs `validation_approved`).
 *
 * Purity: the strategy returns intents.  It never sends an order, never reads a
 * clock it was not given, and never sees a bar that was not final at the
 * decision time it was handed.  `availableAt` on every bar is what makes the
 * replay and the live path agree -- a bar is usable only once its close time
 * AND its arrival time have both passed.
 *
 * VARIABLE PROVENANCE (section 11):
 *   dayOpenKst     source: 1m klines, first bar with openTime >= KST midnight.
 *                  unit: quote price. missing -> candidate excluded (never
 *                  carried over from yesterday).
 *   dayChangePct   source: derived (lastClose/dayOpenKst - 1). unit: fraction.
 *   ema20_15m      source: 15m klines, closed bars only. unit: quote price.
 *   ema20_5m       source: 5m klines, closed bars only. unit: quote price.
 *   atr14_5m       source: 5m klines, Wilder ATR over 14 closed bars.
 *   atr14_1m       source: 1m klines, Wilder ATR over 14 closed bars.
 *   tickSize       source: exchangeInfo PRICE_FILTER.tickSize (never
 *                  pricePrecision).
 */

import { Dec, dec, ZERO } from "./decimal.mjs";

export const R1_VERSION = "BOO-R1-RESEARCH-CANDIDATE-1";

export const R1_PARAMS = Object.freeze({
  topGainerRank: 10,
  emaPeriod: 20,
  emaSlopeLookbackBars: 3,
  breakoutLookbackBars5m: 6,
  triggerLookbackBars1m: 3,
  entryCeilingAtrMult: "0.25", // trigger + 0.25 * ATR14_1m
  setupTtlMs: 30 * 60 * 1000, // 30 min from pullback start
  signalTtlMs: 60 * 1000, // 60 s from breakout bar availability
  initialStopAtrMult: "0.10", // setup_low - max(2 ticks, 0.10*ATR14_5m)
  initialStopMinTicks: 2,
  trailAtrMult: "0.10", // 3-bar low - max(2 ticks, 0.10*ATR14_5m)
  trailMinTicks: 2,
  trailArmAtR: "1.0", // arm at >= 1R of executable net profit
  trendBreakLookbackBars5m: 3,
  earlyFailureMinHoldMs: 3 * 60 * 1000,
  earlyFailureMfeR: "0.25",
  earlyFailureDownCloses1m: 3,
});

export const STRATEGY_EXIT_REASON = Object.freeze({
  INITIAL_STOP: "INITIAL_STOP",
  PROFIT_TRAIL: "PROFIT_TRAIL",
  TREND_BREAK: "TREND_BREAK",
  EARLY_FAILURE: "EARLY_FAILURE",
});

export const EXECUTION_EXIT_ROUTE = Object.freeze({
  NATIVE_STOP: "NATIVE_STOP",
  MARKET: "MARKET",
  IOC: "IOC",
});

export const SETUP_STATE = Object.freeze({
  NONE: "NONE",
  IMPULSE: "IMPULSE", // 5m breakout confirmed, waiting for pullback
  PULLBACK: "PULLBACK", // pullback in progress, tracking setup_low
  ARMED: "ARMED", // pullback ended, trigger price fixed
  CONSUMED: "CONSUMED", // used (entered, stopped, or expired) -- never reusable
  INVALID: "INVALID",
});

// --------------------------------------------------------------------------
// Bar helpers.  Every function takes ONLY bars that were final and available
// at `asOf`; `usableBars` is the single chokepoint that enforces it.
// --------------------------------------------------------------------------

/**
 * Bars that a decision at `asOf` is allowed to see.
 *
 * A bar qualifies when it is closed (closeTime <= asOf) AND it had actually
 * arrived (availableAt <= asOf).  Section 8 forbids using an unfinished bar's
 * running value, and section 7 forbids letting a late arrival back-date itself
 * into a decision it could not have informed.
 */
/** @param {any} bars @param {number} asOf @returns {any[]} */
export function usableBars(bars, asOf) {
  const out = [];
  for (const b of bars ?? []) {
    const closeTime = Number(b.closeTime);
    const availableAt = Number(b.availableAt ?? b.closeTime);
    if (!Number.isFinite(closeTime) || !Number.isFinite(availableAt)) continue;
    if (b.final === false) continue;
    if (closeTime <= asOf && availableAt <= asOf) out.push(b);
  }
  out.sort((a, b) => Number(a.openTime) - Number(b.openTime));
  return out;
}

/** Wilder EMA over closes. Returns array aligned to `bars`, null before seed. */
/** @param {any} bars @param {number} period @returns {any[]} */
export function emaSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let acc = ZERO;
  for (let i = 0; i < period; i++) acc = acc.add(dec(bars[i].close));
  let prev = acc.div(dec(period));
  out[period - 1] = prev;
  const k = dec(2).div(dec(period + 1));
  for (let i = period; i < bars.length; i++) {
    prev = dec(bars[i].close).sub(prev).mul(k).add(prev);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR over `period` closed bars. Returns null when under-seeded. */
export function atr(bars, period) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = dec(bars[i].high), l = dec(bars[i].low), pc = dec(bars[i - 1].close);
    tr.push(h.sub(l).max(h.sub(pc).abs()).max(l.sub(pc).abs()));
  }
  if (tr.length < period) return null;
  let acc = ZERO;
  for (let i = 0; i < period; i++) acc = acc.add(tr[i]);
  let a = acc.div(dec(period));
  for (let i = period; i < tr.length; i++) {
    a = a.mul(dec(period - 1)).add(tr[i]).div(dec(period));
  }
  return a;
}

/** KST calendar-day open. Returns null when the day's first bar is absent. */
export function kstDayOpen(bars1m, asOf) {
  const usable = usableBars(bars1m, asOf);
  if (!usable.length) return null;
  const KST_OFFSET = 9 * 3600 * 1000;
  const dayIndex = Math.floor((asOf + KST_OFFSET) / 86400000);
  const dayStartUtc = dayIndex * 86400000 - KST_OFFSET;
  // The bar that OPENS the KST day. If the feed does not contain it, the day
  // open is missing -- section 5-1 forbids substituting yesterday's.
  const first = usable.find((b) => Number(b.openTime) === dayStartUtc);
  return first ? dec(first.open) : null;
}

/**
 * Same-day gain ranking.  `asOf` decides what was knowable; a symbol without a
 * KST day open is EXCLUDED, not defaulted.
 */
/** @param {any} universe @param {number} asOf @param {number} [topN] @returns {any} */
export function rankDayGainers(universe, asOf, topN = R1_PARAMS.topGainerRank) {
  const scored = [];
  const missing = [];
  for (const u of universe ?? []) {
    const open = kstDayOpen(u.bars1m, asOf);
    const usable = usableBars(u.bars1m, asOf);
    if (!open || !open.isPos() || !usable.length) {
      missing.push({ symbol: u.symbol, reason: "KST_DAY_OPEN_MISSING" });
      continue;
    }
    const last = dec(usable[usable.length - 1].close);
    scored.push({ symbol: u.symbol, dayChange: last.div(open).sub(dec(1)), dayOpen: open, last });
  }
  scored.sort((a, b) => b.dayChange.cmp(a.dayChange) || (a.symbol < b.symbol ? -1 : 1));
  return {
    ranked: scored.slice(0, topN).map((s, i) => ({ ...s, rank: i + 1 })),
    excluded: missing,
    asOf,
  };
}

// --------------------------------------------------------------------------
// Entry structure
// --------------------------------------------------------------------------

/** 15m uptrend structure (section 5-1). */
/** @param {any} bars15m @param {number} asOf @returns {any} */
export function fifteenMinuteStructure(bars15m, asOf) {
  const bars = usableBars(bars15m, asOf);
  const need = R1_PARAMS.emaPeriod + R1_PARAMS.emaSlopeLookbackBars + 6;
  if (bars.length < need) return { ok: false, reason: "INSUFFICIENT_15M_BARS" };
  const ema = emaSeries(bars, R1_PARAMS.emaPeriod);
  const i = bars.length - 1;
  const emaNow = ema[i];
  const emaPrev = ema[i - R1_PARAMS.emaSlopeLookbackBars];
  if (!emaNow || !emaPrev) return { ok: false, reason: "EMA_UNSEEDED" };
  if (!dec(bars[i].close).gt(emaNow)) return { ok: false, reason: "CLOSE_BELOW_EMA20" };
  if (!emaNow.gt(emaPrev)) return { ok: false, reason: "EMA20_NOT_RISING" };
  // Last 3 closed lows must not be below the 3 before them.
  let lowRecent = null, lowPrior = null;
  for (let k = i - 2; k <= i; k++) lowRecent = lowRecent ? lowRecent.min(bars[k].low) : dec(bars[k].low);
  for (let k = i - 5; k <= i - 3; k++) lowPrior = lowPrior ? lowPrior.min(bars[k].low) : dec(bars[k].low);
  if (!lowRecent.gte(lowPrior)) return { ok: false, reason: "HIGHER_LOWS_BROKEN" };
  return { ok: true, ema20: emaNow, ema20Prev: emaPrev, lowRecent, lowPrior };
}

/**
 * Advance the per-symbol setup state machine by one 5m bar.
 *
 * `state` is the persisted setup row (or null).  The function is total: given
 * the same inputs it always returns the same next state, regardless of how
 * many times it is called, which is what makes the shadow and the replay agree
 * and what stops a restart from resurrecting a consumed setup.
 *
 * Section 5-1: an invalidated setup ENDS.  It is never retroactively repaired,
 * and a CONSUMED setup is never reopened -- only a brand new impulse leg plus a
 * brand new pullback creates a new setup_id.
 */
/** @param {any} args @returns {any} */
export function advanceSetup({ state, bars5m, bars1m, asOf, tickSize, symbol }) {
  const bars = usableBars(bars5m, asOf);
  const need = R1_PARAMS.breakoutLookbackBars5m + R1_PARAMS.emaPeriod + 2;
  if (bars.length < need) {
    return { ...(state ?? { state: SETUP_STATE.NONE }), reason: "INSUFFICIENT_5M_BARS" };
  }
  const i = bars.length - 1;
  const bar = bars[i];
  const ema = emaSeries(bars, R1_PARAMS.emaPeriod);
  const emaNow = ema[i];
  const atr5 = atr(bars, 14);
  if (!emaNow || !atr5) {
    return { ...(state ?? { state: SETUP_STATE.NONE }), reason: "INDICATORS_UNSEEDED" };
  }

  let s = state && state.state !== SETUP_STATE.INVALID
    ? { ...state }
    : { state: SETUP_STATE.NONE, symbol };

  // One bar, one transition.
  //
  // The caller polls far more often than the 5m bar closes, so without this the
  // SAME closed bar would drive a transition on every poll: an IMPULSE could
  // become a PULLBACK and then arm, all from one bar, because each call re-reads
  // that bar as if it were new. Advancing only when the newest closed bar is one
  // we have not already consumed makes the machine a function of the bar series
  // rather than of the polling rate, which is also what lets the replay and the
  // shadow agree.
  if (Number(s.lastBarCloseTime) === Number(bar.closeTime)) {
    return { ...s, reason: "BAR_ALREADY_PROCESSED" };
  }
  const stamp = (next) => ({ ...next, lastBarCloseTime: Number(bar.closeTime) });

  // A consumed setup is terminal. Only a fresh impulse can create a new one,
  // and it must carry a new setupId.
  if (s.state === SETUP_STATE.CONSUMED) s = { state: SETUP_STATE.NONE, symbol };

  // TTL: the 30-minute clock runs from pullback START, and data lateness never
  // extends it (section 5-1).
  if (
    (s.state === SETUP_STATE.PULLBACK || s.state === SETUP_STATE.ARMED) &&
    Number.isFinite(Number(s.pullbackStartedAt)) &&
    asOf - Number(s.pullbackStartedAt) > R1_PARAMS.setupTtlMs
  ) {
    return stamp({ ...s, state: SETUP_STATE.CONSUMED, reason: "SETUP_TTL_EXPIRED", consumedAt: asOf });
  }

  const close = dec(bar.close);
  const prevClose = dec(bars[i - 1].close);
  const open = dec(bar.open);

  // --- impulse detection: close breaks the prior 6 closed bars' high --------
  let priorHigh = null;
  for (let k = i - R1_PARAMS.breakoutLookbackBars5m; k <= i - 1; k++) {
    if (k < 0) break;
    priorHigh = priorHigh ? priorHigh.max(bars[k].high) : dec(bars[k].high);
  }
  const brokeOut = priorHigh && close.gt(priorHigh);

  if (s.state === SETUP_STATE.NONE && brokeOut) {
    // Impulse leg reference low: the lowest low of the breakout leg, measured
    // over the lookback window that was broken.
    let legLow = dec(bar.low);
    for (let k = i - R1_PARAMS.breakoutLookbackBars5m; k <= i; k++) {
      if (k < 0) continue;
      legLow = legLow.min(dec(bars[k].low));
    }
    return stamp({
      state: SETUP_STATE.IMPULSE,
      symbol,
      setupId: `${symbol}:${bar.closeTime}:${R1_VERSION}`,
      impulseBarCloseTime: bar.closeTime,
      impulseAt: asOf,
      legLow,
      atr5m: atr5,
      reason: "IMPULSE_CONFIRMED",
    });
  }

  if (s.state === SETUP_STATE.IMPULSE) {
    // Pullback starts at the first closed 5m bar that closes below the prior close.
    if (close.lt(prevClose)) {
      return stamp({
        ...s,
        state: SETUP_STATE.PULLBACK,
        pullbackStartedAt: asOf,
        pullbackStartBarCloseTime: bar.closeTime,
        setupLow: dec(bar.low),
        atr5m: atr5,
        reason: "PULLBACK_STARTED",
      });
    }
    // Still impulsing; refresh the leg low downward only.
    return stamp({ ...s, legLow: dec(s.legLow).min(dec(bar.low)), atr5m: atr5, reason: "IMPULSE_CONTINUES" });
  }

  if (s.state === SETUP_STATE.PULLBACK) {
    // Validity: the impulse leg's reference low must hold, and each judged bar
    // must close at or above its own EMA20 at that moment.
    if (dec(bar.low).lt(dec(s.legLow))) {
      return stamp({ ...s, state: SETUP_STATE.CONSUMED, reason: "LEG_LOW_BROKEN", consumedAt: asOf });
    }
    if (close.lt(emaNow)) {
      return stamp({ ...s, state: SETUP_STATE.CONSUMED, reason: "CLOSE_BELOW_EMA20", consumedAt: asOf });
    }
    const setupLow = dec(s.setupLow ?? bar.low).min(dec(bar.low));
    // Pullback ends on a green 5m bar that also closes above the prior close.
    const green = close.gt(open);
    if (green && close.gt(prevClose)) {
      const trigger = triggerPrice(bars1m, asOf, tickSize);
      if (!trigger.ok) return stamp({ ...s, setupLow, atr5m: atr5, reason: trigger.reason });
      return stamp({
        ...s,
        state: SETUP_STATE.ARMED,
        setupLow,
        atr5m: atr5,
        armedAt: asOf,
        triggerPrice: trigger.price,
        triggerFixedFromCloseTime: trigger.fromCloseTime,
        reason: "PULLBACK_ENDED_ARMED",
      });
    }
    return stamp({ ...s, setupLow, atr5m: atr5, reason: "PULLBACK_CONTINUES" });
  }

  if (s.state === SETUP_STATE.ARMED) {
    // Structure must keep holding while armed, but the trigger price itself is
    // FIXED (section 5-1): it is never re-derived downward to chase price.
    if (dec(bar.low).lt(dec(s.legLow))) {
      return stamp({ ...s, state: SETUP_STATE.CONSUMED, reason: "LEG_LOW_BROKEN", consumedAt: asOf });
    }
    return stamp({ ...s, atr5m: atr5, reason: "ARMED_HOLDING" });
  }

  return stamp({ ...s, reason: "NO_CHANGE" });
}

/** trigger = highest high of the last 3 available closed 1m bars + 1 tick. */
/** @param {any} bars1m @param {number} asOf @param {any} tickSize @returns {any} */
export function triggerPrice(bars1m, asOf, tickSize) {
  const bars = usableBars(bars1m, asOf);
  if (bars.length < R1_PARAMS.triggerLookbackBars1m) {
    return { ok: false, reason: "INSUFFICIENT_1M_BARS_FOR_TRIGGER" };
  }
  let hi = null;
  for (let k = bars.length - R1_PARAMS.triggerLookbackBars1m; k < bars.length; k++) {
    hi = hi ? hi.max(dec(bars[k].high)) : dec(bars[k].high);
  }
  const tick = dec(tickSize);
  if (!tick.isPos()) return { ok: false, reason: "TICK_SIZE_INVALID" };
  return { ok: true, price: hi.add(tick), fromCloseTime: bars[bars.length - 1].closeTime };
}

/**
 * Entry trigger check on 1m bars (section 5-1).
 *
 * Fires when the trigger sits strictly between the previous closed 1m close
 * and the newest closed 1m close: prevClose < trigger <= lastClose.  It also
 * returns the ceiling price, above which the entry must NOT be taken however
 * attractive the move looks.
 */
/** @param {any} args @returns {any} */
export function entryTrigger({ setup, bars1m, asOf, tickSize }) {
  if (!setup || setup.state !== SETUP_STATE.ARMED) {
    return { fire: false, reason: "SETUP_NOT_ARMED" };
  }
  const bars = usableBars(bars1m, asOf);
  if (bars.length < 2) return { fire: false, reason: "INSUFFICIENT_1M_BARS" };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // Two separate checks, because they guard opposite mistakes.
  //
  // 1. Lookahead: a bar we had not received yet cannot inform this decision.
  const availableAt = Number(last.availableAt ?? last.closeTime);
  if (availableAt > asOf) {
    return { fire: false, reason: "BAR_NOT_YET_AVAILABLE", availableAt, asOf };
  }
  // 2. Freshness: measured from the bar's CLOSE, not from when we happened to
  //    collect it. Measuring from arrival would let a slow collector resurrect
  //    a twenty-minute-old breakout as if it were new, which is precisely what
  //    section 5-1 forbids ("데이터 수집 지연이 신호 유효시간을 연장하지 않음").
  //    Anchoring to closeTime means lateness consumes the window instead.
  const ageMs = asOf - Number(last.closeTime);
  if (ageMs > R1_PARAMS.signalTtlMs) {
    return { fire: false, reason: "SIGNAL_TTL_EXPIRED", ageMs };
  }

  const trig = dec(setup.triggerPrice);
  const lastClose = dec(last.close);
  const prevClose = dec(prev.close);
  if (!(prevClose.lt(trig) && trig.lte(lastClose))) {
    return { fire: false, reason: "TRIGGER_NOT_CROSSED" };
  }

  const atr1 = atr(bars, 14);
  if (!atr1) return { fire: false, reason: "ATR14_1M_UNSEEDED" };
  // BUY limit rounds DOWN to the tick so the ceiling is never exceeded.
  const ceiling = trig.add(atr1.mul(dec(R1_PARAMS.entryCeilingAtrMult))).floorStep(tickSize);

  return {
    fire: true,
    triggerPrice: trig,
    entryCeiling: ceiling,
    atr14_1m: atr1,
    barCloseTime: last.closeTime,
    availableAt,
    setupId: setup.setupId,
  };
}

/** Initial structural stop: setup_low - max(2 ticks, 0.10 * ATR14_5m). */
/** @param {any} args @returns {any} */
export function initialStop({ setupLow, atr14_5m, tickSize }) {
  const tick = dec(tickSize);
  const pad = tick.mul(dec(R1_PARAMS.initialStopMinTicks))
    .max(dec(atr14_5m).mul(dec(R1_PARAMS.initialStopAtrMult)));
  // Align DOWN so tick alignment can only widen the stop.
  return {
    price: dec(setupLow).sub(pad).floorStep(tickSize),
    padding: pad,
    basis: { setupLow: dec(setupLow).toString(), atr14_5m: dec(atr14_5m).toString(), tickSize: tick.toString() },
  };
}

// --------------------------------------------------------------------------
// Exits
// --------------------------------------------------------------------------

/**
 * Executable net liquidation value of the whole position.
 *
 * Section 5-2: this is what the position is worth if it were closed NOW into
 * the real book, minus fees already paid, minus the fee the exit would cost,
 * minus funding actually paid.  Costs already inside the VWAP are not charged
 * again.  When there is no book, the answer is "unknown" -- NOT zero, and NOT
 * an assumed mid.
 */
/** @param {any} args @returns {any} */
export function executableNetValue({
  quantity,
  bookBids,
  entryVwap,
  feesPaid,
  exitFeeRate,
  fundingPaid,
  walk,
}) {
  const walkFn = walk ?? defaultWalk;
  const w = walkFn(bookBids, quantity);
  if (!w) return { known: false, reason: "NO_EXECUTABLE_BID_DEPTH" };
  const proceeds = w.notional;
  const exitFee = proceeds.mul(dec(exitFeeRate));
  const cost = dec(quantity).mul(dec(entryVwap));
  const net = proceeds.sub(cost).sub(dec(feesPaid)).sub(exitFee).sub(dec(fundingPaid));
  return { known: true, net, exitVwap: w.vwap, proceeds, exitFee };
}

function defaultWalk(levels, quantity) {
  const q = dec(quantity);
  if (!q.isPos()) return null;
  let remaining = q, cost = ZERO;
  for (const l of levels ?? []) {
    const p = dec(l[0]), sz = dec(l[1]);
    if (!p.isPos() || !sz.isPos()) continue;
    const take = sz.min(remaining);
    cost = cost.add(take.mul(p));
    remaining = remaining.sub(take);
    if (!remaining.isPos()) return { vwap: cost.div(q), notional: cost };
  }
  return null;
}

/**
 * Profit-protection trail (section 5-2).
 *
 * Armed only once OBSERVED executable net profit has reached 1R.  R is the
 * ORIGINAL planned loss budget fixed at entry and is never redefined when the
 * stop moves up or the size shrinks.
 *
 * The trail reads the last 3 closed 5m bars -- but only bars that formed AFTER
 * entry.  Section 5-2 forbids mistaking a pre-entry bar for post-entry
 * structure; when there are not yet 3 post-entry bars the trail is WITHHELD
 * (returns null) rather than computed from whatever is available.
 */
/** @param {any} args @returns {any} */
export function profitTrailStop({ position, bars5m, asOf, tickSize }) {
  const bars = usableBars(bars5m, asOf).filter((b) => Number(b.openTime) >= Number(position.entryAt));
  if (bars.length < 3) return { armed: false, reason: "INSUFFICIENT_POST_ENTRY_5M_BARS", stop: null };
  const R = dec(position.initialR);
  if (!R.isPos()) return { armed: false, reason: "R_INVALID", stop: null };
  const peak = position.peakExecutableNet === null || position.peakExecutableNet === undefined
    ? null
    : dec(position.peakExecutableNet);
  if (peak === null) return { armed: false, reason: "MFE_UNOBSERVED", stop: null };
  if (peak.lt(R.mul(dec(R1_PARAMS.trailArmAtR)))) {
    return { armed: false, reason: "PROFIT_BELOW_1R", stop: null };
  }
  const atr5 = atr(usableBars(bars5m, asOf), 14);
  if (!atr5) return { armed: false, reason: "ATR14_5M_UNSEEDED", stop: null };
  let low = null;
  for (let k = bars.length - 3; k < bars.length; k++) {
    low = low ? low.min(dec(bars[k].low)) : dec(bars[k].low);
  }
  const tick = dec(tickSize);
  const pad = tick.mul(dec(R1_PARAMS.trailMinTicks)).max(atr5.mul(dec(R1_PARAMS.trailAtrMult)));
  const candidate = low.sub(pad).floorStep(tickSize);
  const current = dec(position.currentStop);
  // Ratchet: the stop only ever moves up.
  if (candidate.lte(current)) return { armed: true, reason: "TRAIL_NOT_HIGHER", stop: null };
  return { armed: true, reason: "TRAIL_RAISED", stop: candidate };
}

/** TREND_BREAK: last closed 5m close below the 3 closed 5m bars before it. */
/** @param {any} args @returns {any} */
export function trendBreak({ bars5m, asOf }) {
  const bars = usableBars(bars5m, asOf);
  if (bars.length < R1_PARAMS.trendBreakLookbackBars5m + 1) {
    return { broken: false, reason: "INSUFFICIENT_5M_BARS" };
  }
  const i = bars.length - 1;
  let low = null;
  for (let k = i - R1_PARAMS.trendBreakLookbackBars5m; k <= i - 1; k++) {
    low = low ? low.min(dec(bars[k].low)) : dec(bars[k].low);
  }
  return dec(bars[i].close).lt(low)
    ? { broken: true, reason: "CLOSE_BELOW_PRIOR_3_LOWS", referenceLow: low }
    : { broken: false, reason: "TREND_INTACT", referenceLow: low };
}

/** Early-failure candidate (section 5-3). All four conditions required. */
/** @param {any} args @returns {any} */
export function earlyFailure({ position, bars1m, asOf, tickSize }) {
  const heldMs = asOf - Number(position.entryAt);
  if (!(heldMs >= R1_PARAMS.earlyFailureMinHoldMs)) {
    return { failed: false, reason: "HOLD_TOO_SHORT" };
  }
  // No observed MFE means the condition is NOT satisfied. Section 5-3 forbids
  // waving it through, and section 8 forbids filling it with a zero.
  if (position.peakExecutableNet === null || position.peakExecutableNet === undefined) {
    return { failed: false, reason: "MFE_UNOBSERVED" };
  }
  const R = dec(position.initialR);
  if (!R.isPos()) return { failed: false, reason: "R_INVALID" };
  if (dec(position.peakExecutableNet).gte(R.mul(dec(R1_PARAMS.earlyFailureMfeR)))) {
    return { failed: false, reason: "MFE_ABOVE_THRESHOLD" };
  }
  const bars = usableBars(bars1m, asOf);
  const n = R1_PARAMS.earlyFailureDownCloses1m;
  if (bars.length < n) return { failed: false, reason: "INSUFFICIENT_1M_BARS" };
  const trig = dec(position.triggerPrice);
  const tick = dec(tickSize);
  if (!dec(bars[bars.length - 1].close).lt(trig.sub(tick))) {
    return { failed: false, reason: "CLOSE_NOT_BELOW_TRIGGER" };
  }
  for (let k = bars.length - n + 1; k < bars.length; k++) {
    if (!dec(bars[k].close).lt(dec(bars[k - 1].close))) {
      return { failed: false, reason: "CLOSES_NOT_MONOTONE_DOWN" };
    }
  }
  return { failed: true, reason: "EARLY_FAILURE_CONFIRMED", heldMs };
}

/**
 * Single exit intent for a bar.
 *
 * Priority (section 5-3): initial hard stop, then the raised profit stop, then
 * trend break, then early failure.  Simultaneous conditions COLLAPSE into one
 * intent -- the caller must never emit two closes for one position.
 */
/** @param {any} args @returns {any} */
export function decideExit({ position, bars1m, bars5m, asOf, tickSize, lastPrice }) {
  const contributing = [];

  const px = lastPrice === undefined || lastPrice === null ? null : dec(lastPrice);
  const initial = dec(position.initialStop);
  const current = dec(position.currentStop);

  // 1. Initial hard stop.
  if (px && px.lte(initial)) {
    contributing.push(STRATEGY_EXIT_REASON.INITIAL_STOP);
    return intent(STRATEGY_EXIT_REASON.INITIAL_STOP, EXECUTION_EXIT_ROUTE.NATIVE_STOP, contributing, {
      stop: initial,
    });
  }
  // 2. Raised profit-protection stop.
  if (px && current.gt(initial) && px.lte(current)) {
    contributing.push(STRATEGY_EXIT_REASON.PROFIT_TRAIL);
    return intent(STRATEGY_EXIT_REASON.PROFIT_TRAIL, EXECUTION_EXIT_ROUTE.NATIVE_STOP, contributing, {
      stop: current,
    });
  }
  // 3. Trend break.
  const tb = trendBreak({ bars5m, asOf });
  if (tb.broken) contributing.push(STRATEGY_EXIT_REASON.TREND_BREAK);
  // 4. Early failure.
  const ef = earlyFailure({ position, bars1m, asOf, tickSize });
  if (ef.failed) contributing.push(STRATEGY_EXIT_REASON.EARLY_FAILURE);

  if (tb.broken) {
    return intent(STRATEGY_EXIT_REASON.TREND_BREAK, EXECUTION_EXIT_ROUTE.MARKET, contributing, tb);
  }
  if (ef.failed) {
    return intent(STRATEGY_EXIT_REASON.EARLY_FAILURE, EXECUTION_EXIT_ROUTE.MARKET, contributing, ef);
  }
  return { exit: false, contributing, strategyExitReason: null, executionExitRoute: null };
}

function intent(reason, route, contributing, evidence) {
  return {
    exit: true,
    // Full-size exit only. Section 5-2 forbids adding partial take-profit
    // without its own experiment.
    fraction: "1",
    strategyExitReason: reason,
    executionExitRoute: route,
    contributing,
    evidence,
    version: R1_VERSION,
  };
}
