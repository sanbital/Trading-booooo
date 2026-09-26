/**
 * V17 LIVE MOMENTUM CHASE (2026-09-25).
 *
 * V17_CHASE_EXPIRED was one terminal verdict: the first completed 1m bar that closed more
 * than SETUP_POLICY.maxChasePct above the signal reference ended the setup, whatever the
 * market was doing. Measured from the price a chase entry would actually pay (the chase bar
 * close, not the signal reference the missed-opportunity journal used), the 379 chase
 * rejections of 2026-09-18..24 lost on average (-0.41 / -0.79 USDT per 450 USDT trade at
 * 30 / 60 min, simple 2.5% stop model). Split by the market state at the chase bar:
 *   DEAD  (volume fading, sellers, close low in range, lower low or 60m trend down)
 *         n=148, -1.27 USDT/trade at 60 min  -> still rejected here, as before;
 *   LIVE  (volume, close near the high, buyer tape, no lower low, 60m trend up)
 *         n=135, -0.39 USDT/trade            -> about the level of the average trigger
 *         GPT already buys (-0.48), so code no longer rejects it: it becomes a trigger and
 *         GPT decides with the late-entry context (breakout, peak, stop distance, slippage).
 * The thresholds below are the plain readings of those words (1, 0.5, 0.7, the same
 * direction rules FD1 publishes), not values searched on that sample.
 *
 * Pure: no fetch, no clock, no DB. The executor supplies completed Binance 1m klines.
 * The frozen setup state machine (leader-pullback-reaccel.mjs) is not modified: it still
 * produces CHASE_EXPIRED; this module only reads that verdict and, for a LIVE or UNCERTAIN
 * chase, derives a TRIGGERED state that the unchanged admission chain then evaluates.
 */
export const LIVE_CHASE_VERSION = "V17_LIVE_CHASE_1";
export const LIVE_CHASE_MODE = "LIVE_MOMENTUM_CHASE";
export const LIVE_CHASE_REASON = "V17_LIVE_CHASE_TRIGGERED";
export const CHASE_STATE = Object.freeze({ DEAD: "DEAD", LIVE: "LIVE", UNCERTAIN: "UNCERTAIN" });
/** (2026-09-26) Data failures are the only chase verdicts that still end a candidate. A DEAD
 * verdict computed on real bars (volume fading, sellers, failing breakout, lower low, trend
 * down) is evidence the AI weighs; the >maxLiveChasePct range stays an execution limit. */
export const CHASE_DATA_FAILURES = Object.freeze(["CHASE_INPUT_INVALID", "CHASE_DATA_UNAVAILABLE"]);
export const chaseEvidenceUsable = (c) => [CHASE_STATE.LIVE, CHASE_STATE.UNCERTAIN, CHASE_STATE.DEAD].includes(c?.state) &&
  Array.isArray(c?.reasons) && !c.reasons.some((r) => CHASE_DATA_FAILURES.includes(r));

export const LIVE_CHASE_POLICY = Object.freeze({
  version: LIVE_CHASE_VERSION,
  /** Bars fetched ending at the chase bar: a 60-minute trend plus the 5-bar windows. */
  lookbackBars: 66,
  minBars: 61,
  /** Mean 1m quote volume of the last 5 bars over the 55 before (FD1 volume_ratio_5m_vs_60m). */
  volumeRatioMin: 1,
  /** Taker-buy quote share of the last 5 bars (FD1 taker_buy_ratio_5m). */
  takerShareMin: 0.5,
  /** Close position inside the last 5 bars' range: >=0.7 holding the breakout, <0.5 failing. */
  closeLocationLive: 0.7,
  closeLocationDead: 0.5,
  /** Bars before the chase bar whose high is the breakout level. */
  breakoutLookbackBars: 15,
  /** Safety ceiling above the signal reference: a chase this far is never offered. */
  maxLiveChasePct: 0.05,
});

const MINUTE = 60_000;
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

function candles(raw, lastOpen) {
  if (!Array.isArray(raw)) return null;
  const xs = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 11) return null;
    const t = num(b[0]), o = num(b[1]), h = num(b[2]), l = num(b[3]), c = num(b[4]), end = num(b[6]),
      q = num(b[7]), buy = num(b[10]);
    if (![t, o, h, l, c, end, q, buy].every(Number.isFinite)) return null;
    if (t > lastOpen) continue; // nothing after the chase bar is read
    if (!(t % MINUTE === 0 && end === t + MINUTE - 1 && l > 0 && h >= Math.max(o, c) && l <= Math.min(o, c) &&
      q >= 0 && buy >= 0 && buy <= q * (1 + 1e-9))) return null;
    xs.push({ t, o, h, l, c, q, buy });
  }
  xs.sort((a, b) => a.t - b.t);
  for (let i = 1; i < xs.length; i++) if (xs[i].t - xs[i - 1].t !== MINUTE) return null;
  return xs.length && xs.at(-1).t === lastOpen ? xs : null;
}

/**
 * Market state at the chase bar. Missing or malformed data is DEAD: the existing
 * rejection stays the default, it is never converted into a trigger.
 * @returns {version,state,reasons[],metrics{}}
 */
export function classifyChase(raw, { referencePrice, chaseBarOpenTime, policy = LIVE_CHASE_POLICY }) {
  const ref = num(referencePrice), open = num(chaseBarOpenTime), out = (state, reasons, metrics = {}) =>
    ({ version: policy.version, state, reasons, metrics });
  if (!(ref > 0) || !Number.isSafeInteger(open) || open % MINUTE !== 0) return out(CHASE_STATE.DEAD, ["CHASE_INPUT_INVALID"]);
  const xs = candles(raw, open);
  if (!xs || xs.length < policy.minBars) return out(CHASE_STATE.DEAD, ["CHASE_DATA_UNAVAILABLE"]);
  const bar = xs.at(-1), last5 = xs.slice(-5), prior55 = xs.slice(-60, -5), prev5 = xs.slice(-10, -5);
  const mean = (a) => a.reduce((s, x) => s + x.q, 0) / a.length;
  const q5 = last5.reduce((s, x) => s + x.q, 0), hi5 = Math.max(...last5.map((x) => x.h)), lo5 = Math.min(...last5.map((x) => x.l));
  const pre = xs.slice(-1 - policy.breakoutLookbackBars, -1), breakout = Math.max(...pre.map((x) => x.h));
  const peak = Math.max(...xs.slice(-60).map((x) => x.h)), range = bar.h - bar.l;
  const metrics = {
    chase_close: bar.c,
    chase_pct: bar.c / ref - 1,
    volume_ratio_5m_vs_60m: mean(prior55) > 0 ? mean(last5) / mean(prior55) : null,
    taker_buy_ratio_5m: q5 > 0 ? last5.reduce((s, x) => s + x.buy, 0) / q5 : null,
    close_location_5m: hi5 > lo5 ? (bar.c - lo5) / (hi5 - lo5) : 1,
    higher_low: Math.min(...last5.map((x) => x.l)) >= Math.min(...prev5.map((x) => x.l)),
    return_60m: bar.c / xs.at(-61).c - 1,
    breakout_price: breakout,
    distance_from_breakout: bar.c / breakout - 1,
    recent_peak: peak,
    distance_from_peak: bar.c / peak - 1,
    chase_bar_upper_wick: range > 0 ? (bar.h - Math.max(bar.o, bar.c)) / range : 0,
  };
  const m = metrics, dead = [];
  if (m.chase_pct > policy.maxLiveChasePct) dead.push("CHASE_EXTREME");
  if (!(m.volume_ratio_5m_vs_60m >= policy.volumeRatioMin)) dead.push("VOLUME_FADING");
  if (!(m.taker_buy_ratio_5m >= policy.takerShareMin)) dead.push("TAPE_SELLERS");
  if (!(m.close_location_5m >= policy.closeLocationDead)) dead.push("BREAKOUT_FAILING");
  if (!m.higher_low) dead.push("LOWER_LOW");
  if (!(m.return_60m > 0)) dead.push("TREND_DOWN");
  if (dead.length) return out(CHASE_STATE.DEAD, dead, metrics);
  if (m.close_location_5m >= policy.closeLocationLive) return out(CHASE_STATE.LIVE, ["MOMENTUM_SUSTAINED"], metrics);
  return out(CHASE_STATE.UNCERTAIN, ["CLOSE_MID_RANGE"], metrics);
}

/**
 * A LIVE or UNCERTAIN chase becomes a trigger at the chase bar's close with the same
 * 60-second executable window every V17 trigger has. Anything else -- a DEAD chase, a
 * state that is not the chase verdict, a window that already closed -- returns null and
 * the caller keeps the CHASE_EXPIRED rejection.
 */
export function liveChaseTrigger(state, classification, { now, setupPolicy, policy = LIVE_CHASE_POLICY }) {
  const at = num(now), open = num(state?.lastCandleOpenTime), ref = num(state?.referencePrice), px = num(state?.lastClose);
  if (state?.state !== "CHASE_EXPIRED" || state.terminalReason !== "V17_CHASE_EXPIRED") return null;
  if (!chaseEvidenceUsable(classification) || classification.version !== policy.version) return null;
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(open) || !(ref > 0 && px > 0)) return null;
  if (!(px > ref * (1 + setupPolicy.maxChasePct) && px <= ref * (1 + policy.maxLiveChasePct))) return null;
  const triggerAt = open + MINUTE, triggerExpiresAt = triggerAt + setupPolicy.entryTriggerTtlMs;
  if (at < triggerAt || at >= triggerExpiresAt || triggerAt > num(state.expiresAt)) return null;
  return {
    ...state,
    state: "TRIGGERED",
    terminalReason: null,
    triggerAt,
    triggerExpiresAt,
    triggerClose: px,
    triggerMode: LIVE_CHASE_MODE,
    chase: { version: policy.version, state: classification.state, reasons: classification.reasons,
      metrics: classification.metrics, evaluatedAt: at },
    transitions: [...(state.transitions ?? []), { at, to: "TRIGGERED", reason: LIVE_CHASE_REASON }],
  };
}

/** The DEAD (or unusable) outcome keeps the original rejection, now with its evidence. */
export function deadChaseState(state, classification, now, why = null) {
  const reasons = why ? [why] : classification?.reasons ?? ["CHASE_UNCLASSIFIED"];
  const kind = why ? "STALE" : "DEAD";
  return {
    ...state,
    chase: { version: classification?.version ?? LIVE_CHASE_VERSION, state: classification?.state ?? CHASE_STATE.DEAD,
      reasons, metrics: classification?.metrics ?? {}, evaluatedAt: num(now) },
    terminalReason: `V17_CHASE_EXPIRED:${kind}:${reasons.join("+")}`.slice(0, 200),
  };
}

/**
 * Execution-window provenance of a LIVE chase trigger: the trigger is exactly the chase
 * bar recorded by the frozen state machine, the selector read the same bar, and the
 * transition log shows the CHASE_EXPIRED observation followed by this module's trigger.
 */
export function liveChaseTimingValid(row, setupPolicy, policy = LIVE_CHASE_POLICY) {
  const s = row?.features?.v17Setup, source = row?.features?.b06133?.source;
  if (s?.triggerMode !== LIVE_CHASE_MODE || s.chase?.version !== policy.version ||
    !chaseEvidenceUsable(s.chase) || !Array.isArray(source?.prebars)) return false;
  const trigger = num(s.triggerAt), ref = num(s.referencePrice), px = num(s.triggerClose);
  if (!Number.isSafeInteger(trigger) || trigger % MINUTE !== 0 || !(ref > 0) || !(px > 0) ||
    num(source.decisionAt) !== trigger || num(s.lastCandleOpenTime) !== trigger - MINUTE || num(s.lastClose) !== px ||
    !(px > ref * (1 + setupPolicy.maxChasePct) && px <= ref * (1 + policy.maxLiveChasePct))) return false;
  const bar = source.prebars.at(-1);
  if (!bar || num(bar.openTime) !== trigger - MINUTE || num(bar.closeTime) !== trigger - 1 || num(bar.close) !== px) return false;
  const tr = Array.isArray(s.transitions) ? s.transitions : [];
  const chaseAt = tr.findIndex((t) => t?.to === "CHASE_EXPIRED" && t.reason === "V17_CHASE_EXPIRED");
  const trigAt = tr.findIndex((t) => t?.to === "TRIGGERED" && t.reason === LIVE_CHASE_REASON);
  return chaseAt >= 0 && trigAt > chaseAt && num(tr[trigAt].at) >= trigger && num(tr[trigAt].at) <= num(s.expiresAt);
}

/**
 * Late-entry context shown to GPT for a LIVE chase candidate (packet.chase). Built from
 * the classifier evidence plus the snapshot's own facts; every field is a fact, not advice.
 */
export function chaseContext(chase, facts, { referencePrice, stopPct }) {
  if (!chase || typeof chase !== "object") return null;
  const v = facts?.values ?? {}, price = num(facts?.quality?.last_close), m = chase.metrics ?? {};
  const pct = (a, b) => (a > 0 && b > 0 ? a / b - 1 : null);
  return {
    chase_state: chase.state,
    chase_reasons: chase.reasons ?? [],
    current_price: Number.isFinite(price) ? price : null,
    signal_reference_price: num(referencePrice) > 0 ? num(referencePrice) : null,
    distance_from_reference_pct: pct(price, num(referencePrice)),
    breakout_price: num(m.breakout_price) > 0 ? num(m.breakout_price) : null,
    distance_from_breakout_pct: pct(price, num(m.breakout_price)),
    recent_peak: num(m.recent_peak) > 0 ? num(m.recent_peak) : null,
    distance_from_peak_pct: pct(price, num(m.recent_peak)),
    // Remaining-upside proxy: how far the prior 4h high still is above the price (0 = at or above it).
    room_to_4h_high_pct: Number.isFinite(num(v.distance_high_4h)) ? Math.max(0, -num(v.distance_high_4h)) : null,
    stop_distance_pct: num(stopPct) > 0 ? num(stopPct) : null,
    expected_slippage_bps: Number.isFinite(num(v.est_buy_slippage_bps)) ? num(v.est_buy_slippage_bps) : null,
    at_chase_bar: { volume_ratio_5m_vs_60m: m.volume_ratio_5m_vs_60m ?? null, taker_buy_ratio_5m: m.taker_buy_ratio_5m ?? null,
      close_location_5m: m.close_location_5m ?? null, higher_low: m.higher_low ?? null, return_60m: m.return_60m ?? null,
      chase_bar_upper_wick: m.chase_bar_upper_wick ?? null },
  };
}
