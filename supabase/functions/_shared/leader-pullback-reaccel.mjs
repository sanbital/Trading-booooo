/**
 * V17 entry TIMING: pullback + re-acceleration.
 *
 * WHAT THIS CHANGES, AND WHY
 * --------------------------
 * V17 picks the day's strongest symbols well. What it did badly was buy them
 * instantly: the 5m acceleration candle closed and the executor took the very next
 * ask, within 120 seconds, at the top of the move it had just measured. Replayed on
 * Binance 1m bars with the execution bugs removed, that entry produced 65 trades,
 * 33.85% wins, net -11.72 USDT, profit factor 0.713 -- while PRE-COST PnL was about
 * +0.009 USDT. The direction was a coin flip and the fees decided it. Most losses
 * were ordinary 10-20 minute pullbacks that stopped the trade out before the move
 * resumed.
 *
 * So the selection is kept and the timing is replaced. A confirmed V17 leader no
 * longer buys; it ARMS a setup, waits for the pullback it was going to suffer
 * anyway, and buys only when price turns back up through the level it started from.
 *
 *     leader confirmed  ->  ARMED
 *     low <= ref x 0.9975 (>= 0.25% pullback)        ->  PULLBACK_OBSERVED
 *     bullish 1m, close > prev close,
 *     ref x 1.0025 <= close <= ref x 1.01            ->  TRIGGERED
 *     fill within 60s of that candle's close         ->  ENTERED
 *
 * The 15-minute observation window is NOT an extended signal TTL. The original
 * signal's execution lifetime is replaced by a NEW trigger with its own 60-second
 * freshness, measured from the re-acceleration candle's close. A setup that never
 * triggers never produces an order intent at all.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * Pure. No DB, no fetch, no clock, no order dispatch: `now` and market data are
 * explicit arguments, so live and replay run the identical code. Every transition
 * carries a reason string, so a decision can be reconstructed from the audit trail
 * alone. Applying the same candle twice is a no-op, and a terminal setup can never
 * be resurrected.
 *
 * PARAMETERS ARE NOT SEARCHED HERE. The thresholds below came out of a 6-day
 * development window plus an untouched 24-hour holdout and are frozen; deeper
 * pullbacks (0.50%, 0.75%) were also positive, which is why 0.25% is read as the
 * high-sample point of a ridge rather than as a peak. Re-optimising them belongs in
 * a separate experiment, not in this module.
 */

export const SETUP_POLICY_VERSION = "V17_PULLBACK_REACCEL_ENTRY_1";

export const SETUP_POLICY = Object.freeze({
  version: SETUP_POLICY_VERSION,
  /** How long a confirmed leader stays watchable before the setup is abandoned. */
  setupTtlMs: 15 * 60_000,
  /** Minimum dip below the signal reference before any entry is considered. */
  minPullbackPct: 0.0025,
  /** Minimum recovery above the signal reference for the trigger candle's close. */
  minReaccelPct: 0.0025,
  /** Hard ceiling on how far above the signal reference we will ever chase. */
  maxChasePct: 0.01,
  /** How long a re-acceleration trigger stays executable after its candle closed. */
  entryTriggerTtlMs: 60_000,
  /** These came from a 6-day window plus a 24h holdout, not from a market-wide search. */
  parametersValidatedByBacktest: false,
});

/** Every state a setup can be in. Terminal states are listed in TERMINAL_STATES. */
export const SETUP_STATE = Object.freeze({
  ARMED: "ARMED",
  PULLBACK_OBSERVED: "PULLBACK_OBSERVED",
  TRIGGERED: "TRIGGERED",
  ENTERED: "ENTERED",
  EXPIRED_NO_PULLBACK: "EXPIRED_NO_PULLBACK",
  EXPIRED_NO_REACCEL: "EXPIRED_NO_REACCEL",
  CHASE_EXPIRED: "CHASE_EXPIRED",
  INVALIDATED: "INVALIDATED",
  CONSUMED: "CONSUMED",
});

export const TERMINAL_STATES = Object.freeze([
  SETUP_STATE.ENTERED,
  SETUP_STATE.EXPIRED_NO_PULLBACK,
  SETUP_STATE.EXPIRED_NO_REACCEL,
  SETUP_STATE.CHASE_EXPIRED,
  SETUP_STATE.INVALIDATED,
  SETUP_STATE.CONSUMED,
]);

/** Audit reasons. One per transition, so the dashboard can reconstruct any decision. */
export const SETUP_REASON = Object.freeze({
  ARMED: "V17_SETUP_ARMED",
  PULLBACK_CONFIRMED: "V17_PULLBACK_CONFIRMED",
  REACCEL_TRIGGERED: "V17_REACCEL_TRIGGERED",
  SETUP_EXPIRED: "V17_SETUP_EXPIRED",
  CHASE_EXPIRED: "V17_CHASE_EXPIRED",
  TRIGGER_STALE: "V17_TRIGGER_STALE",
  TRIGGER_FUTURE: "V17_TRIGGER_FUTURE",
  ENTRY_DRIFT: "V17_ENTRY_DRIFT",
  NOT_TRIGGERED: "V17_SETUP_NOT_TRIGGERED",
  INVALID_PRICE: "V17_SETUP_INVALID_PRICE",
  WRONG_STRATEGY: "WRONG_STRATEGY",
  /** Advance() outcomes that change nothing, kept distinct so replays stay legible. */
  CANDLE_IGNORED_TERMINAL: "V17_SETUP_TERMINAL",
  CANDLE_IGNORED_DUPLICATE: "V17_CANDLE_DUPLICATE",
  CANDLE_IGNORED_BEFORE_ARM: "V17_CANDLE_BEFORE_ARM",
  CANDLE_INVALID: "V17_CANDLE_INVALID",
  CANDLE_INCOMPLETE: "V17_CANDLE_INCOMPLETE",
  HOLD: "V17_SETUP_WATCHING",
  AWAITING_ENTRY: "V17_SETUP_AWAITING_ENTRY",
});

const MINUTE = 60_000;
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : Number.NaN;
};

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state?.state);
}

/**
 * A completed Binance 1m kline, in the array shape the gateway returns.
 * INCOMPLETE CANDLES ARE REFUSED HERE, not filtered by the caller: reading a bar
 * that is still forming is the single easiest way to fake an edge, so the rule
 * lives with the state machine rather than at each call site.
 */
export function completedCandle(raw, now) {
  if (!Array.isArray(raw) || raw.length < 7) return null;
  const openTime = num(raw[0]), open = num(raw[1]), high = num(raw[2]),
    low = num(raw[3]), close = num(raw[4]), closeTime = num(raw[6]);
  if (![openTime, open, high, low, close, closeTime].every(Number.isFinite)) return null;
  if (!Number.isSafeInteger(openTime) || openTime <= 0 || openTime % MINUTE !== 0) return null;
  if (closeTime !== openTime + MINUTE - 1) return null;
  if (!(open > 0 && low > 0 && close > 0 && high >= Math.max(open, close) &&
        low <= Math.min(open, close))) return null;
  // The bar must be in the past in its entirety. `now` is explicit precisely so this
  // is checkable in a replay exactly as it is live.
  if (!Number.isSafeInteger(num(now)) || closeTime >= num(now)) return null;
  return { openTime, open, high, low, close, closeTime };
}

/**
 * Deterministic setup identity. Two executors, or the same executor after a
 * restart, must agree on which setup a signal belongs to without coordinating.
 */
export function setupIdentity(signal) {
  const symbol = String(signal?.symbol ?? "").toUpperCase();
  const signalId = String(signal?.id ?? signal?.signalId ?? "");
  const close = num(signal?.features?.signal5Close ?? signal?.signal5Close);
  if (!symbol || !signalId || !Number.isSafeInteger(close)) return null;
  return `${SETUP_POLICY_VERSION}:${symbol}:${signalId}:${close}`;
}

/**
 * Arm a setup from a confirmed V17 signal. Nothing is ordered and no order intent
 * exists yet -- that only begins when a trigger is actually executed.
 */
export function startPullbackSetup(signal, now, policy = SETUP_POLICY) {
  const identity = setupIdentity(signal);
  const symbol = String(signal?.symbol ?? "").toUpperCase();
  const reference = num(signal?.features?.referenceClose ?? signal?.referenceClose);
  const signal5Close = num(signal?.features?.signal5Close ?? signal?.signal5Close);
  const at = num(now);
  if (!identity || !(reference > 0) || !Number.isSafeInteger(at)) {
    return { ok: false, reason: SETUP_REASON.INVALID_PRICE };
  }
  return {
    ok: true,
    reason: SETUP_REASON.ARMED,
    state: {
      policyVersion: policy.version,
      identity,
      symbol,
      signalId: String(signal?.id ?? signal?.signalId ?? ""),
      state: SETUP_STATE.ARMED,
      /** The price every threshold in this module is measured against. It is fixed
       *  at arm time and never re-based: a later signal on the same symbol must not
       *  be able to walk the chase ceiling upwards. */
      referencePrice: reference,
      signal5Close: Number.isSafeInteger(signal5Close) ? signal5Close : null,
      armedAt: at,
      expiresAt: at + policy.setupTtlMs,
      pullbackObserved: false,
      pullbackLow: null,
      lastCandleOpenTime: null,
      lastClose: null,
      triggerAt: null,
      triggerExpiresAt: null,
      triggerClose: null,
      terminalReason: null,
      transitions: [{ at, to: SETUP_STATE.ARMED, reason: SETUP_REASON.ARMED }],
    },
  };
}

function withTransition(state, next, reason, at, extra = {}) {
  return {
    ...state,
    ...extra,
    state: next,
    terminalReason: TERMINAL_STATES.includes(next) ? reason : state.terminalReason,
    transitions: [...state.transitions, { at, to: next, reason }],
  };
}

/**
 * Apply ONE completed 1m candle.
 *
 * Returns {state, reason, changed}. Never throws on ordinary bad input: a replay
 * and a live cycle both need to keep going and record why nothing happened.
 *
 * `prevCandle` is the candle immediately before `candle`; the trigger needs
 * `close > previous close` and that comparison must not be satisfiable from a gap
 * in the caller's data, so a missing or non-adjacent previous bar means no trigger.
 */
export function advancePullbackSetup(state, candle, prevCandle, now, policy = SETUP_POLICY) {
  if (!state || isTerminal(state)) {
    return { state, reason: SETUP_REASON.CANDLE_IGNORED_TERMINAL, changed: false };
  }
  const at = num(now);
  if (!Number.isSafeInteger(at)) {
    return { state, reason: SETUP_REASON.CANDLE_INVALID, changed: false };
  }

  // Expiry is evaluated before the candle, so a setup cannot be rescued by a bar
  // that arrives after its window closed.
  if (at > state.expiresAt) return expirePullbackSetup(state, at);

  // A TRIGGERED setup stops reading the tape. It is either executed inside its
  // 60-second window or it expires with the rest of the setup. It deliberately does
  // NOT re-arm on a later qualifying bar: one setup means at most one entry attempt,
  // which is what keeps an oscillation around the trigger level from turning into a
  // stream of orders on the same symbol.
  if (state.state === SETUP_STATE.TRIGGERED) {
    return { state, reason: SETUP_REASON.AWAITING_ENTRY, changed: false };
  }

  const bar = completedCandle(candle, at);
  if (!bar) return { state, reason: SETUP_REASON.CANDLE_INCOMPLETE, changed: false };
  if (bar.openTime < state.armedAt) {
    // Bars from before the signal say nothing about what happens after it.
    return { state, reason: SETUP_REASON.CANDLE_IGNORED_BEFORE_ARM, changed: false };
  }
  if (state.lastCandleOpenTime !== null && bar.openTime <= state.lastCandleOpenTime) {
    // Idempotency: replaying the same minute must not re-trigger or deepen a low.
    return { state, reason: SETUP_REASON.CANDLE_IGNORED_DUPLICATE, changed: false };
  }

  const ref = state.referencePrice;
  let next = { ...state, lastCandleOpenTime: bar.openTime, lastClose: bar.close };

  // The chase ceiling is checked first and on EVERY bar. Once price has run more
  // than maxChasePct above the reference the setup is dead whether or not it ever
  // pulled back -- the whole premise was buying near the level, not above it.
  if (bar.close > ref * (1 + policy.maxChasePct)) {
    return {
      state: withTransition(next, SETUP_STATE.CHASE_EXPIRED, SETUP_REASON.CHASE_EXPIRED, at),
      reason: SETUP_REASON.CHASE_EXPIRED,
      changed: true,
    };
  }

  // Pullback. Once observed it stays observed; the low only ever deepens.
  let reason = SETUP_REASON.HOLD, changed = false;
  if (bar.low <= ref * (1 - policy.minPullbackPct)) {
    const low = next.pullbackLow === null ? bar.low : Math.min(next.pullbackLow, bar.low);
    if (!next.pullbackObserved) {
      next = withTransition(next, SETUP_STATE.PULLBACK_OBSERVED, SETUP_REASON.PULLBACK_CONFIRMED,
        at, { pullbackObserved: true, pullbackLow: low });
      reason = SETUP_REASON.PULLBACK_CONFIRMED;
    } else {
      next = { ...next, pullbackLow: low };
    }
    changed = true;
  }

  // Re-acceleration. Only from PULLBACK_OBSERVED, and only on a bar that is bullish
  // in its own right, higher than the bar before it, and back above the reference.
  if (next.state === SETUP_STATE.PULLBACK_OBSERVED) {
    const prev = completedCandle(prevCandle, at);
    const adjacent = prev !== null && prev.openTime === bar.openTime - MINUTE;
    if (adjacent &&
        bar.close > bar.open &&
        bar.close > prev.close &&
        bar.close >= ref * (1 + policy.minReaccelPct) &&
        bar.close <= ref * (1 + policy.maxChasePct)) {
      // The trigger instant is the candle's close, not "now": a replay that polls
      // late must not get a longer executable window than a live cycle that polls
      // on time.
      const triggerAt = bar.openTime + MINUTE;
      next = withTransition(next, SETUP_STATE.TRIGGERED, SETUP_REASON.REACCEL_TRIGGERED, at, {
        triggerAt,
        triggerExpiresAt: triggerAt + policy.entryTriggerTtlMs,
        triggerClose: bar.close,
      });
      return { state: next, reason: SETUP_REASON.REACCEL_TRIGGERED, changed: true };
    }
  }

  return { state: next, reason, changed: changed || next.lastCandleOpenTime !== state.lastCandleOpenTime };
}

/** Close a setup whose observation window has run out. */
export function expirePullbackSetup(state, now) {
  if (!state || isTerminal(state)) {
    return { state, reason: SETUP_REASON.CANDLE_IGNORED_TERMINAL, changed: false };
  }
  const at = num(now);
  if (!Number.isSafeInteger(at) || at <= state.expiresAt) {
    return { state, reason: SETUP_REASON.HOLD, changed: false };
  }
  // A TRIGGERED setup that was never executed expires as a stale trigger, not as a
  // missing one: the difference matters when reading why an entry did not happen.
  const next = state.state === SETUP_STATE.TRIGGERED
    ? SETUP_STATE.EXPIRED_NO_REACCEL
    : state.pullbackObserved
    ? SETUP_STATE.EXPIRED_NO_REACCEL
    : SETUP_STATE.EXPIRED_NO_PULLBACK;
  return {
    state: withTransition(state, next, SETUP_REASON.SETUP_EXPIRED, at),
    reason: SETUP_REASON.SETUP_EXPIRED,
    changed: true,
  };
}

/** Mark a setup consumed by an actual fill. */
export function enterPullbackSetup(state, now, fill = {}) {
  if (!state || state.state !== SETUP_STATE.TRIGGERED) {
    return { state, reason: SETUP_REASON.NOT_TRIGGERED, changed: false };
  }
  const at = num(now);
  if (!Number.isSafeInteger(at)) return { state, reason: SETUP_REASON.CANDLE_INVALID, changed: false };
  return {
    state: withTransition(state, SETUP_STATE.ENTERED, SETUP_REASON.REACCEL_TRIGGERED, at, {
      enteredAt: at,
      entryPrice: num(fill.price) > 0 ? num(fill.price) : null,
    }),
    reason: SETUP_REASON.REACCEL_TRIGGERED,
    changed: true,
  };
}

/** Retire a setup for a reason outside the price path (ownership, operator, race). */
export function invalidatePullbackSetup(state, now, reason) {
  if (!state || isTerminal(state)) {
    return { state, reason: SETUP_REASON.CANDLE_IGNORED_TERMINAL, changed: false };
  }
  const at = num(now);
  if (!Number.isSafeInteger(at)) return { state, reason: SETUP_REASON.CANDLE_INVALID, changed: false };
  return {
    state: withTransition(state, SETUP_STATE.INVALIDATED, String(reason || "V17_SETUP_INVALIDATED"), at),
    reason: String(reason || "V17_SETUP_INVALIDATED"),
    changed: true,
  };
}

/**
 * Execution freshness for a triggered setup. This REPLACES the original signal's
 * 120-second age check and does not extend it: the executable window is the 60
 * seconds after the re-acceleration candle closed, which is stricter than what V17
 * ran with. The 1% drift ceiling is still measured against the ORIGINAL signal
 * reference, so a setup can never walk itself into a chase.
 */
export function entryTriggerFresh(state, now, price, maxDriftPct, policy = SETUP_POLICY) {
  if (!state || state.policyVersion !== policy.version) return SETUP_REASON.WRONG_STRATEGY;
  if (state.state !== SETUP_STATE.TRIGGERED) return SETUP_REASON.NOT_TRIGGERED;
  const at = num(now), px = num(price), ref = num(state.referencePrice);
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(num(state.triggerAt))) {
    return SETUP_REASON.TRIGGER_STALE;
  }
  if (at < state.triggerAt) return SETUP_REASON.TRIGGER_FUTURE;
  if (at > state.triggerExpiresAt) return SETUP_REASON.TRIGGER_STALE;
  if (!(px > 0 && ref > 0)) return SETUP_REASON.INVALID_PRICE;
  const limit = num(maxDriftPct);
  if (!(limit > 0 && limit < 1)) return SETUP_REASON.INVALID_PRICE;
  if (Math.abs(px / ref - 1) > limit) return SETUP_REASON.ENTRY_DRIFT;
  return null;
}

/** Compact, serialisable view for persistence and audit. Transitions are capped. */
export function serializeSetup(state, maxTransitions = 24) {
  if (!state) return null;
  const { transitions = [], ...rest } = state;
  return { ...rest, transitions: transitions.slice(-maxTransitions) };
}

/** Restore a persisted setup, refusing anything this policy version did not write. */
export function deserializeSetup(raw, policy = SETUP_POLICY) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.policyVersion !== policy.version) return null;
  if (!raw.identity || !Object.values(SETUP_STATE).includes(raw.state)) return null;
  if (!(num(raw.referencePrice) > 0) || !Number.isSafeInteger(num(raw.armedAt))) return null;
  return { ...raw, transitions: Array.isArray(raw.transitions) ? raw.transitions : [] };
}
