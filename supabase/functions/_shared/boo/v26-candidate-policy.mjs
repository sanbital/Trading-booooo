/**
 * V26 pre-registered candidate deltas.
 *
 * This module is pure and side-effect free so research replay and a future
 * production activation can call the identical rules. None of these candidates
 * is live merely because this file exists; activation requires a matching,
 * unrevoked approval identity and ENFORCE mode.
 */
export const V26_CANDIDATE_POLICY_VERSION = "BOO-V26-CANDIDATES-PREREG-1";

const BASE = Object.freeze({
  minDayReturn: 0.03,
  maxDayReturn: 0.08,
  minVolumeRatio: 1.30,
  structuralStop: false,
  earlyFailureExit: false,
  marketParticipation: false,
});

export const V26_CANDIDATES = Object.freeze({
  C0: Object.freeze({ ...BASE, id: "C0" }),
  C1: Object.freeze({ ...BASE, id: "C1", structuralStop: true }),
  C2: Object.freeze({ ...BASE, id: "C2", structuralStop: true, earlyFailureExit: true }),
  C3: Object.freeze({ ...BASE, id: "C3", structuralStop: true, marketParticipation: true }),
  C4: Object.freeze({ ...BASE, id: "C4", structuralStop: true, earlyFailureExit: true, marketParticipation: true }),
  C5: Object.freeze({ ...BASE, id: "C5", maxDayReturn: 0.05, structuralStop: true }),
});

export const STRUCTURAL_STOP = Object.freeze({
  atrFraction: 0.10,
  minimumTicks: 2,
});

export const EARLY_FAILURE = Object.freeze({
  minCompletedBars: 3,
  maxHoldingMs: 5 * 60_000,
  maxMfeR: 0.25,
  takerBuyQuoteRatioMax: 0.50,
});

export const MARKET_PARTICIPATION = Object.freeze({
  minBtcReturn60m: 0,
  minRising30mFraction: 0.50,
});

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const minute = 60_000;

function floorTick(value, tick) {
  if (!(finite(value) && value > 0 && finite(tick) && tick > 0)) return Number.NaN;
  return Math.floor((value + tick * 1e-10) / tick) * tick;
}

/**
 * C1+ structural stop:
 * setupLow - max(2 ticks, 0.1 * completed 5m ATR14).
 * The result is rounded DOWN for a long protective trigger, never inward.
 */
export function structuralStopPrice({ setupLow, priceTick, atr5m14 }) {
  if (!(finite(setupLow) && setupLow > 0 && finite(priceTick) && priceTick > 0 &&
        finite(atr5m14) && atr5m14 > 0)) {
    return { status: "UNKNOWN", reason: "STRUCTURAL_STOP_INPUT_MISSING", price: null };
  }
  const buffer = Math.max(STRUCTURAL_STOP.minimumTicks * priceTick,
    STRUCTURAL_STOP.atrFraction * atr5m14);
  const raw = setupLow - buffer;
  const price = floorTick(raw, priceTick);
  if (!(price > 0 && price < setupLow)) {
    return { status: "UNKNOWN", reason: "STRUCTURAL_STOP_INVALID", price: null };
  }
  return { status: "OK", reason: null, price, raw, buffer };
}

function completed1m(bar, now) {
  if (!bar || typeof bar !== "object") return null;
  const openTime = Number(bar.openTime ?? bar.t ?? bar[0]);
  const high = Number(bar.high ?? bar.h ?? bar[2]);
  const close = Number(bar.close ?? bar.c ?? bar[4]);
  const closeTime = Number(bar.closeTime ?? bar.ct ?? bar[6] ?? (openTime + minute - 1));
  const quote = Number(bar.quoteVolume ?? bar.qv ?? bar[7]);
  const takerBuyQuote = Number(bar.takerBuyQuote ?? bar.tb ?? bar[10]);
  if (![openTime, high, close, closeTime, quote, takerBuyQuote].every(Number.isFinite) ||
      !Number.isSafeInteger(openTime) || openTime % minute !== 0 ||
      closeTime !== openTime + minute - 1 || closeTime >= now ||
      !(high > 0 && close > 0 && quote > 0 && takerBuyQuote >= 0 && takerBuyQuote <= quote * (1 + 1e-9))) {
    return null;
  }
  return { openTime, high, close, closeTime, quote, takerBuyQuote };
}

/**
 * C2/C4 early-failure decision. It uses only bars fully completed by now.
 * No terminal/final MFE is accepted as an input.
 */
export function earlyFailureDecision({
  entryPrice,
  initialStopPrice,
  signalReference,
  entryAt,
  now,
  completedBars,
}) {
  if (![entryPrice, initialStopPrice, signalReference, entryAt, now].every(finite) ||
      !(entryPrice > initialStopPrice && initialStopPrice > 0 && signalReference > 0) ||
      !Number.isSafeInteger(entryAt) || !Number.isSafeInteger(now) || now < entryAt) {
    return { action: "UNKNOWN", reason: "EARLY_FAILURE_INPUT_MISSING" };
  }
  const heldMs = now - entryAt;
  if (heldMs > EARLY_FAILURE.maxHoldingMs) {
    return { action: "HOLD", reason: "EARLY_FAILURE_WINDOW_EXPIRED" };
  }
  const bars = (completedBars ?? []).map((b) => completed1m(b, now)).filter(Boolean)
    .filter((b) => b.openTime >= entryAt)
    .sort((a,b) => a.openTime - b.openTime);
  if (bars.length < EARLY_FAILURE.minCompletedBars) {
    return { action: "UNKNOWN", reason: "EARLY_FAILURE_INSUFFICIENT_COMPLETED_BARS" };
  }
  for (let i=1;i<bars.length;i++) {
    if (bars[i].openTime - bars[i-1].openTime !== minute) {
      return { action: "UNKNOWN", reason: "EARLY_FAILURE_BAR_GAP" };
    }
  }

  const R = entryPrice - initialStopPrice;
  const mfe = Math.max(0, ...bars.map((b) => b.high - entryPrice));
  const last3 = bars.slice(-3), last2 = bars.slice(-2);
  const quote = last3.reduce((s,b)=>s+b.quote,0);
  const takerBuyQuote = last3.reduce((s,b)=>s+b.takerBuyQuote,0);
  if (!(quote > 0)) return { action: "UNKNOWN", reason: "EARLY_FAILURE_TAKER_DATA_MISSING" };
  const takerBuyRatio = takerBuyQuote / quote;

  const conditions = Object.freeze({
    mfeBelowQuarterR: mfe < EARLY_FAILURE.maxMfeR * R,
    lastTwoBelowReference: last2.every((b) => b.close < signalReference),
    latestCloseLower: last2[1].close < last2[0].close,
    takerBuyRatioBelowHalf: takerBuyRatio < EARLY_FAILURE.takerBuyQuoteRatioMax,
  });
  return {
    action: Object.values(conditions).every(Boolean) ? "CLOSE" : "HOLD",
    reason: Object.values(conditions).every(Boolean) ? "V26_EARLY_FAILURE" : "EARLY_FAILURE_CONDITIONS_NOT_MET",
    observedMfe: mfe,
    initialRiskR: R,
    takerBuyRatio,
    completedBars: bars.length,
    conditions,
  };
}

/**
 * C3/C4 market participation gate. Missing historical breadth is UNKNOWN; it is
 * never backfilled from a future observer state.
 */
export function marketParticipationDecision({
  btcReturn60m,
  rising30mCount,
  liquidUniverseCount,
}) {
  if (!(finite(btcReturn60m) && Number.isInteger(rising30mCount) &&
        Number.isInteger(liquidUniverseCount) && liquidUniverseCount > 0 &&
        rising30mCount >= 0 && rising30mCount <= liquidUniverseCount)) {
    return { status: "UNKNOWN", allowed: false, reason: "MARKET_PARTICIPATION_DATA_MISSING" };
  }
  const risingFraction = rising30mCount / liquidUniverseCount;
  const allowed = btcReturn60m >= MARKET_PARTICIPATION.minBtcReturn60m &&
    risingFraction >= MARKET_PARTICIPATION.minRising30mFraction;
  return {
    status: "KNOWN",
    allowed,
    reason: allowed ? "MARKET_PARTICIPATION_PASS" : "MARKET_PARTICIPATION_FAIL",
    btcReturn60m,
    risingFraction,
  };
}
