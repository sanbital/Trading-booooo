/**
 * V26 pre-registered candidate deltas.
 *
 * This module is pure and side-effect free so research replay and a future
 * production activation can call the identical rules. None of these candidates
 * is live merely because this file exists; activation requires a matching,
 * unrevoked approval identity and ENFORCE mode.
 */
export const V26_CANDIDATE_POLICY_VERSION = "BOO-V26-CANDIDATES-PREREG-8";

const BASE = Object.freeze({
  minDayReturn: 0.03,
  maxDayReturn: 0.08,
  minVolumeRatio: 1.30,
  structuralStop: false,
  earlyFailureExit: false,
  marketParticipation: false,
  entryConfirmation1m: false,
  breakoutContinuation1m: false,
  triggerQuality1m: false,
  antiExhaustion: false,
  accelerationReignition: false,
  compressionExpansion: false,
  rankPersistence: false,
  minRankOverride: null,
  maxRankOverride: null,
});

export const V26_CANDIDATES = Object.freeze({
  C0: Object.freeze({ ...BASE, id: "C0" }),
  C1: Object.freeze({ ...BASE, id: "C1", structuralStop: true }),
  C2: Object.freeze({ ...BASE, id: "C2", structuralStop: true, earlyFailureExit: true }),
  C3: Object.freeze({ ...BASE, id: "C3", structuralStop: true, marketParticipation: true }),
  C4: Object.freeze({ ...BASE, id: "C4", structuralStop: true, earlyFailureExit: true, marketParticipation: true }),
  C5: Object.freeze({ ...BASE, id: "C5", maxDayReturn: 0.05, structuralStop: true }),
  C6: Object.freeze({ ...BASE, id: "C6", structuralStop: true, entryConfirmation1m: true }),
  C7: Object.freeze({ ...BASE, id: "C7", structuralStop: true, breakoutContinuation1m: true }),
  C8: Object.freeze({ ...BASE, id: "C8", structuralStop: true, triggerQuality1m: true }),
  C9: Object.freeze({ ...BASE, id: "C9", maxDayReturn: 0.05, structuralStop: true, antiExhaustion: true }),
  C10: Object.freeze({
    ...BASE, id: "C10", maxDayReturn: 0.05, structuralStop: true,
    antiExhaustion: true, triggerQuality1m: true, minRankOverride: 6, maxRankOverride: 10,
  }),
  C11: Object.freeze({
    ...BASE, id: "C11", maxDayReturn: 0.05, structuralStop: true,
    antiExhaustion: true, triggerQuality1m: true, minRankOverride: 6, maxRankOverride: 10,
    earlyFailureExit: true,
  }),
  C12: Object.freeze({
    ...BASE, id: "C12", maxDayReturn: 0.05, structuralStop: true,
    antiExhaustion: true, antiExhaustionMinBuyRatio: 0.70,
  }),
  C13: Object.freeze({
    ...BASE, id: "C13", structuralStop: true, accelerationReignition: true,
  }),
  C14: Object.freeze({
    ...BASE, id: "C14", structuralStop: true, compressionExpansion: true,
  }),
  C15: Object.freeze({
    ...BASE, id: "C15", structuralStop: true, rankPersistence: true,
  }),
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

export const ENTRY_CONFIRMATION_1M = Object.freeze({
  minTakerBuyQuoteRatio: 0.50,
});

export const BREAKOUT_CONTINUATION_1M = Object.freeze({
  minTakerBuyQuoteRatio: 0.55,
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


/**
 * C6 one-minute confirmation gate.
 *
 * The re-acceleration trigger happens at the close of a completed 1m candle.
 * C6 deliberately does NOT enter there. It waits for exactly one more fully
 * completed 1m candle, then—only if the four frozen conditions below pass—
 * enters at the NEXT minute open. This preserves causal ordering and prevents
 * the confirmation candle's close/flow from being used to fill inside itself.
 */
export function entryConfirmation1mDecision({
  triggerAt,
  signalReference,
  triggerClose,
  setupLow,
  now,
  bar,
}) {
  if (![triggerAt, signalReference, triggerClose, setupLow, now].every(finite) ||
      !Number.isSafeInteger(triggerAt) || !Number.isSafeInteger(now) ||
      !(signalReference > 0 && triggerClose > 0 && setupLow > 0) || now < triggerAt + minute) {
    return { action: "UNKNOWN", reason: "C6_CONFIRMATION_INPUT_MISSING" };
  }
  if (!bar || typeof bar !== "object") {
    return { action: "UNKNOWN", reason: "C6_CONFIRMATION_BAR_MISSING" };
  }
  const openTime = Number(bar.openTime ?? bar.t ?? bar[0]);
  const low = Number(bar.low ?? bar.l ?? bar[3]);
  const close = Number(bar.close ?? bar.c ?? bar[4]);
  const closeTime = Number(bar.closeTime ?? bar.ct ?? bar[6] ?? (openTime + minute - 1));
  const quote = Number(bar.quoteVolume ?? bar.qv ?? bar[7]);
  const takerBuyQuote = Number(bar.takerBuyQuote ?? bar.tb ?? bar[10]);
  if (![openTime, low, close, closeTime, quote, takerBuyQuote].every(Number.isFinite) ||
      !Number.isSafeInteger(openTime) || openTime !== triggerAt ||
      closeTime !== openTime + minute - 1 || closeTime >= now ||
      !(low > 0 && close > 0 && quote > 0 && takerBuyQuote >= 0 &&
        takerBuyQuote <= quote * (1 + 1e-9))) {
    return { action: "UNKNOWN", reason: "C6_CONFIRMATION_BAR_INVALID" };
  }
  const takerBuyQuoteRatio = takerBuyQuote / quote;
  const conditions = Object.freeze({
    closeAboveSignalReference: close > signalReference,
    closeAtOrAboveTriggerClose: close >= triggerClose,
    takerBuyQuoteRatioAtLeastHalf:
      takerBuyQuoteRatio >= ENTRY_CONFIRMATION_1M.minTakerBuyQuoteRatio,
    setupLowNotRebroken: low >= setupLow,
  });
  const allowed = Object.values(conditions).every(Boolean);
  return {
    action: allowed ? "ENTER" : "REJECT",
    reason: allowed ? "C6_CONFIRMATION_PASS" : "C6_CONFIRMATION_FAIL",
    takerBuyQuoteRatio,
    conditions,
    confirmationOpenTime: openTime,
    confirmationClose: close,
  };
}


/**
 * C7 continuation confirmation.
 * After the re-acceleration trigger closes, wait exactly one full 1m candle.
 * Enter only at the following minute open when that confirmation candle:
 *  - closes above the trigger candle HIGH, not merely its close;
 *  - has >=55% taker-buy quote share;
 *  - never trades below the original signal reference.
 * This turns C7 into a continuation breakout test rather than a delayed C6.
 */
export function breakoutContinuation1mDecision({
  triggerAt,
  signalReference,
  triggerHigh,
  now,
  bar,
}) {
  if (![triggerAt, signalReference, triggerHigh, now].every(finite) ||
      !Number.isSafeInteger(triggerAt) || !Number.isSafeInteger(now) ||
      !(signalReference > 0 && triggerHigh > 0) || now < triggerAt + minute) {
    return { action: "UNKNOWN", reason: "C7_CONTINUATION_INPUT_MISSING" };
  }
  if (!bar || typeof bar !== "object") {
    return { action: "UNKNOWN", reason: "C7_CONTINUATION_BAR_MISSING" };
  }
  const openTime = Number(bar.openTime ?? bar.t ?? bar[0]);
  const low = Number(bar.low ?? bar.l ?? bar[3]);
  const close = Number(bar.close ?? bar.c ?? bar[4]);
  const closeTime = Number(bar.closeTime ?? bar.ct ?? bar[6] ?? (openTime + minute - 1));
  const quote = Number(bar.quoteVolume ?? bar.qv ?? bar[7]);
  const takerBuyQuote = Number(bar.takerBuyQuote ?? bar.tb ?? bar[10]);
  if (![openTime, low, close, closeTime, quote, takerBuyQuote].every(Number.isFinite) ||
      !Number.isSafeInteger(openTime) || openTime !== triggerAt ||
      closeTime !== openTime + minute - 1 || closeTime >= now ||
      !(low > 0 && close > 0 && quote > 0 && takerBuyQuote >= 0 &&
        takerBuyQuote <= quote * (1 + 1e-9))) {
    return { action: "UNKNOWN", reason: "C7_CONTINUATION_BAR_INVALID" };
  }
  const takerBuyQuoteRatio = takerBuyQuote / quote;
  const conditions = Object.freeze({
    closeBreaksTriggerHigh: close > triggerHigh,
    takerBuyQuoteRatioAtLeast55:
      takerBuyQuoteRatio >= BREAKOUT_CONTINUATION_1M.minTakerBuyQuoteRatio,
    noLossOfSignalReference: low >= signalReference,
  });
  const allowed = Object.values(conditions).every(Boolean);
  return {
    action: allowed ? "ENTER" : "REJECT",
    reason: allowed ? "C7_CONTINUATION_PASS" : "C7_CONTINUATION_FAIL",
    takerBuyQuoteRatio,
    conditions,
    confirmationOpenTime: openTime,
    confirmationClose: close,
  };
}


export const TRIGGER_QUALITY_1M = Object.freeze({
  minTakerBuyQuoteRatio: 0.55,
  minCloseLocation: 0.75,
});

/**
 * C8 trigger-quality gate.
 * Uses only the already-completed re-acceleration trigger candle, so the
 * decision remains causal and entry can still occur at the next minute open.
 * It requires buyer-dominant flow and a close in the top quartile of the
 * candle range, i.e. the trigger itself must finish strong rather than merely
 * satisfy the geometric re-acceleration rule.
 */
export function triggerQuality1mDecision({ triggerAt, bar }) {
  if (!Number.isSafeInteger(triggerAt) || !bar || typeof bar !== "object") {
    return { action: "UNKNOWN", reason: "C8_TRIGGER_QUALITY_INPUT_MISSING" };
  }
  const openTime = Number(bar.openTime ?? bar.t ?? bar[0]);
  const high = Number(bar.high ?? bar.h ?? bar[2]);
  const low = Number(bar.low ?? bar.l ?? bar[3]);
  const close = Number(bar.close ?? bar.c ?? bar[4]);
  const closeTime = Number(bar.closeTime ?? bar.ct ?? bar[6] ?? (openTime + minute - 1));
  const quote = Number(bar.quoteVolume ?? bar.qv ?? bar[7]);
  const takerBuyQuote = Number(bar.takerBuyQuote ?? bar.tb ?? bar[10]);
  if (![openTime, high, low, close, closeTime, quote, takerBuyQuote].every(Number.isFinite) ||
      openTime !== triggerAt - minute || closeTime !== triggerAt - 1 ||
      !(high >= close && close >= low && low > 0 && quote > 0 &&
        takerBuyQuote >= 0 && takerBuyQuote <= quote * (1 + 1e-9))) {
    return { action: "UNKNOWN", reason: "C8_TRIGGER_QUALITY_BAR_INVALID" };
  }
  const range = high - low;
  const closeLocation = range > 0 ? (close - low) / range : 1;
  const takerBuyQuoteRatio = takerBuyQuote / quote;
  const conditions = Object.freeze({
    takerBuyQuoteRatioAtLeast55:
      takerBuyQuoteRatio >= TRIGGER_QUALITY_1M.minTakerBuyQuoteRatio,
    closeInTopQuartile: closeLocation >= TRIGGER_QUALITY_1M.minCloseLocation,
  });
  const allowed = Object.values(conditions).every(Boolean);
  return {
    action: allowed ? "ENTER" : "REJECT",
    reason: allowed ? "C8_TRIGGER_QUALITY_PASS" : "C8_TRIGGER_QUALITY_FAIL",
    takerBuyQuoteRatio,
    closeLocation,
    conditions,
  };
}


export const ANTI_EXHAUSTION = Object.freeze({
  maxVolumeRatio: 4.0,
  minTriggerTakerBuyQuoteRatio: 0.60,
});

/**
 * C9 development hypothesis: keep the profitable C5 day-return cap, but refuse
 * blow-off volume and require buyer-dominant flow on the completed trigger bar.
 * Inputs are all known at the trigger close; no future candle is read.
 */
export function antiExhaustionDecision({ volumeRatio, triggerAt, bar, minTriggerTakerBuyQuoteRatio = ANTI_EXHAUSTION.minTriggerTakerBuyQuoteRatio }) {
  if (!(finite(volumeRatio) && volumeRatio >= 0) || !Number.isSafeInteger(triggerAt) ||
      !bar || typeof bar !== "object") {
    return { action: "UNKNOWN", reason: "C9_ANTI_EXHAUSTION_INPUT_MISSING" };
  }
  const openTime = Number(bar.openTime ?? bar.t ?? bar[0]);
  const closeTime = Number(bar.closeTime ?? bar.ct ?? bar[6] ?? (openTime + minute - 1));
  const quote = Number(bar.quoteVolume ?? bar.qv ?? bar[7]);
  const takerBuyQuote = Number(bar.takerBuyQuote ?? bar.tb ?? bar[10]);
  if (![openTime, closeTime, quote, takerBuyQuote].every(Number.isFinite) ||
      openTime !== triggerAt - minute || closeTime !== triggerAt - 1 ||
      !(quote > 0 && takerBuyQuote >= 0 && takerBuyQuote <= quote * (1 + 1e-9))) {
    return { action: "UNKNOWN", reason: "C9_ANTI_EXHAUSTION_BAR_INVALID" };
  }
  const takerBuyQuoteRatio = takerBuyQuote / quote;
  const conditions = Object.freeze({
    volumeNotBlowoff: volumeRatio <= ANTI_EXHAUSTION.maxVolumeRatio,
    buyerDominantTrigger:
      takerBuyQuoteRatio >= minTriggerTakerBuyQuoteRatio,
  });
  const allowed = Object.values(conditions).every(Boolean);
  return {
    action: allowed ? "ENTER" : "REJECT",
    reason: allowed ? "C9_ANTI_EXHAUSTION_PASS" : "C9_ANTI_EXHAUSTION_FAIL",
    takerBuyQuoteRatio,
    volumeRatio,
    conditions,
  };
}


/** C9: same C7 breakout test, but the confirmation minute may never lose trigger close. */
export function holdTriggerClose1mDecision(args) {
  const base = breakoutContinuation1mDecision(args);
  if (base.action !== "ENTER") return base;
  const low = Number(args?.bar?.low ?? args?.bar?.l ?? args?.bar?.[3]);
  const triggerClose = Number(args?.triggerClose);
  if (!(Number.isFinite(low) && Number.isFinite(triggerClose) && triggerClose > 0)) {
    return { action: "UNKNOWN", reason: "C9_TRIGGER_CLOSE_INPUT_MISSING" };
  }
  const allowed = low >= triggerClose;
  return {
    ...base,
    action: allowed ? "ENTER" : "REJECT",
    reason: allowed ? "C9_HOLD_TRIGGER_CLOSE_PASS" : "C9_HOLD_TRIGGER_CLOSE_FAIL",
    conditions: { ...base.conditions, lowAtOrAboveTriggerClose: allowed },
  };
}

/**
 * C10: require two consecutive completed 1m continuation bars after trigger.
 * Both must keep their lows above trigger close, close non-decreasing, and each
 * must have >=55% taker-buy quote share. Entry is at the third minute open.
 */
export function persistence2mDecision({
  triggerAt, signalReference, triggerClose, triggerHigh, now, bars,
}) {
  if (![triggerAt, signalReference, triggerClose, triggerHigh, now].every(finite) ||
      !Number.isSafeInteger(triggerAt) || !Number.isSafeInteger(now) ||
      !(signalReference > 0 && triggerClose > 0 && triggerHigh > 0) ||
      now < triggerAt + 2 * minute || !Array.isArray(bars) || bars.length < 2) {
    return { action: "UNKNOWN", reason: "C10_PERSISTENCE_INPUT_MISSING" };
  }
  const norm = bars.slice(0,2).map((bar,i) => {
    const openTime=Number(bar?.openTime ?? bar?.t ?? bar?.[0]);
    const low=Number(bar?.low ?? bar?.l ?? bar?.[3]);
    const close=Number(bar?.close ?? bar?.c ?? bar?.[4]);
    const closeTime=Number(bar?.closeTime ?? bar?.ct ?? bar?.[6] ?? (openTime+minute-1));
    const quote=Number(bar?.quoteVolume ?? bar?.qv ?? bar?.[7]);
    const takerBuyQuote=Number(bar?.takerBuyQuote ?? bar?.tb ?? bar?.[10]);
    if (![openTime,low,close,closeTime,quote,takerBuyQuote].every(Number.isFinite) ||
        openTime !== triggerAt + i*minute || closeTime !== openTime+minute-1 ||
        closeTime >= now || !(low>0&&close>0&&quote>0&&takerBuyQuote>=0&&takerBuyQuote<=quote*(1+1e-9))) return null;
    return {openTime,low,close,ratio:takerBuyQuote/quote};
  });
  if (norm.some(x=>x===null)) return { action:"UNKNOWN", reason:"C10_PERSISTENCE_BAR_INVALID" };
  const conditions=Object.freeze({
    firstBreaksTriggerHigh:norm[0].close>triggerHigh,
    bothHoldTriggerClose:norm.every(x=>x.low>=triggerClose),
    bothBuyDominant:norm.every(x=>x.ratio>=BREAKOUT_CONTINUATION_1M.minTakerBuyQuoteRatio),
    secondCloseNonDecreasing:norm[1].close>=norm[0].close,
    secondCloseAboveReference:norm[1].close>signalReference,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C10_PERSISTENCE_PASS":"C10_PERSISTENCE_FAIL",conditions,bars:norm};
}

function researchBar(bar, expectedOpen, now) {
  const openTime=Number(bar?.openTime ?? bar?.t ?? bar?.[0]);
  const open=Number(bar?.open ?? bar?.o ?? bar?.[1]);
  const high=Number(bar?.high ?? bar?.h ?? bar?.[2]);
  const low=Number(bar?.low ?? bar?.l ?? bar?.[3]);
  const close=Number(bar?.close ?? bar?.c ?? bar?.[4]);
  const closeTime=Number(bar?.closeTime ?? bar?.ct ?? bar?.[6] ?? (openTime+minute-1));
  const quote=Number(bar?.quoteVolume ?? bar?.qv ?? bar?.[7]);
  const takerBuyQuote=Number(bar?.takerBuyQuote ?? bar?.tb ?? bar?.[10]);
  if (![openTime,open,high,low,close,closeTime,quote,takerBuyQuote].every(Number.isFinite) ||
      openTime!==expectedOpen || closeTime!==openTime+minute-1 || closeTime>=now ||
      !(low>0&&high>=Math.max(open,close)&&low<=Math.min(open,close)&&quote>0&&
        takerBuyQuote>=0&&takerBuyQuote<=quote*(1+1e-9))) return null;
  return {openTime,open,high,low,close,quote,ratio:takerBuyQuote/quote};
}

/** C13: renewed price acceleration and rising buyer share into the trigger. */
export function accelerationReignitionDecision({triggerAt,now,bars,return5m,return15m}) {
  if (!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<4||
      ![return5m,return15m].every(finite)) return {action:"UNKNOWN",reason:"C13_ACCEL_INPUT_MISSING"};
  const xs=bars.slice(-4).map((b,i)=>researchBar(b,triggerAt-(4-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C13_ACCEL_BAR_INVALID"};
  const r=[xs[1].close/xs[0].close-1,xs[2].close/xs[1].close-1,xs[3].close/xs[2].close-1];
  const ratios=xs.map(x=>x.ratio);
  const conditions=Object.freeze({
    lastMinutePositive:r[2]>0,
    priceAccelerating:r[2]>(r[0]+r[1])/2,
    recentFiveDominatesPriorTen:return5m>Math.max(0,(return15m-return5m)/2),
    buyerShareRising:ratios[3]>=ratios[2]&&ratios[2]>=ratios[1],
    buyerShareImproved:ratios[3]-ratios[1]>=0.08,
    buyerDominantNow:ratios[3]>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C13_ACCEL_PASS":"C13_ACCEL_FAIL",conditions,returns1m:r,takerBuyRatios:ratios};
}

/** C14: a compact four-minute shelf followed by buyer-led range expansion. */
export function compressionExpansionDecision({triggerAt,now,bars}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<5)
    return {action:"UNKNOWN",reason:"C14_COMPRESSION_INPUT_MISSING"};
  const xs=bars.slice(-5).map((b,i)=>researchBar(b,triggerAt-(5-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C14_COMPRESSION_BAR_INVALID"};
  const shelf=xs.slice(0,4),trigger=xs[4],priorHigh=Math.max(...shelf.map(x=>x.high));
  const meanClose=shelf.reduce((s,x)=>s+x.close,0)/shelf.length;
  const shelfWidth=(Math.max(...shelf.map(x=>x.high))-Math.min(...shelf.map(x=>x.low)))/meanClose;
  const meanRange=shelf.reduce((s,x)=>s+(x.high-x.low),0)/shelf.length;
  const triggerRange=trigger.high-trigger.low;
  const closeLocation=triggerRange>0?(trigger.close-trigger.low)/triggerRange:0;
  const conditions=Object.freeze({
    shelfCompressed:shelfWidth<=0.008,
    rangeExpanded:triggerRange>=1.5*meanRange,
    priorHighBroken:trigger.close>priorHigh,
    buyerDominant:trigger.ratio>=0.60,
    closeNearHigh:closeLocation>=0.75,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C14_COMPRESSION_PASS":"C14_COMPRESSION_FAIL",conditions,shelfWidth,rangeExpansion:meanRange>0?triggerRange/meanRange:null,closeLocation,takerBuyRatio:trigger.ratio};
}

/** C15: persistent cross-sectional leadership, not a one-snapshot rank spike. */
export function rankPersistenceDecision({currentRank,priorRanks,return30m,return60m}) {
  if(!finite(currentRank)||!Array.isArray(priorRanks)||priorRanks.length!==2||
      !priorRanks.every(x=>x===null||finite(x))||![return30m,return60m].every(finite))
    return {action:"UNKNOWN",reason:"C15_RANK_INPUT_MISSING"};
  const observations=[currentRank,...priorRanks];
  const conditions=Object.freeze({
    topTenAtLeastTwoSnapshots:observations.filter(x=>finite(x)&&x<=10).length>=2,
    noCollapseFromObservedLeader:priorRanks.filter(finite).every(x=>currentRank<=x+3),
    currentContributionPositive:return30m>0,
    recentHalfDominates:return60m<=0?return30m>0:return30m>=0.55*return60m,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C15_RANK_PASS":"C15_RANK_FAIL",conditions,observations};
}
