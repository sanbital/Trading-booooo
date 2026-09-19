/**
 * V26 pre-registered candidate deltas.
 *
 * This module is pure and side-effect free so research replay and a future
 * production activation can call the identical rules. None of these candidates
 * is live merely because this file exists; activation requires a matching,
 * unrevoked approval identity and ENFORCE mode.
 */
export const V26_CANDIDATE_POLICY_VERSION = "BOO-V26-CANDIDATES-PREREG-19";

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
  pullbackAbsorption: false,
  relativeStrengthResidual: false,
  sweepReclaim: false,
  freshLeaderRotation: false,
  accountFeasibleLadder: false,
  twoPulseReset: false,
  liquidityAdjustedEfficiency: false,
  selectiveLeaderRegime: false,
  distributedTrend: false,
  breakoutRetestHold2m: false,
  controlledPullbackReclaim3m: false,
  breakoutAcceptance3m: false,
  sellerExhaustion: false,
  volumeDryupReaccel: false,
  buyerNotionalEscalation: false,
  crossSectionalPullbackQuality: false,
  crossSectionalBuyerFlowAcceleration: false,
  crossSectionalExecutionValue: false,
  crossSectionalCompressionExpansion60m: false,
  compressionExpansionQueueWinner: false,
  compressionExpansionCycleAuction: false,
  compressionExpansionSetupReservation: false,
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
  C16: Object.freeze({
    ...BASE, id: "C16", structuralStop: true, pullbackAbsorption: true,
  }),
  C17: Object.freeze({
    ...BASE, id: "C17", structuralStop: true, relativeStrengthResidual: true,
  }),
  C18: Object.freeze({
    ...BASE, id: "C18", structuralStop: true, sweepReclaim: true,
  }),
  C19: Object.freeze({
    ...BASE, id: "C19", structuralStop: true, freshLeaderRotation: true,
  }),
  C20: Object.freeze({
    ...BASE, id: "C20", structuralStop: true, accountFeasibleLadder: true,
  }),
  C21: Object.freeze({
    ...BASE, id: "C21", structuralStop: true, twoPulseReset: true,
  }),
  C22: Object.freeze({
    ...BASE, id: "C22", structuralStop: true, liquidityAdjustedEfficiency: true,
  }),
  C23: Object.freeze({
    ...BASE, id: "C23", structuralStop: true, selectiveLeaderRegime: true,
  }),
  C24: Object.freeze({
    ...BASE, id: "C24", structuralStop: true, distributedTrend: true,
  }),
  C25: Object.freeze({
    ...BASE, id: "C25", structuralStop: true, breakoutRetestHold2m: true,
  }),
  C26: Object.freeze({
    ...BASE, id: "C26", structuralStop: true, controlledPullbackReclaim3m: true,
  }),
  C27: Object.freeze({
    ...BASE, id: "C27", structuralStop: true, breakoutAcceptance3m: true,
  }),
  C28: Object.freeze({
    ...BASE, id: "C28", structuralStop: true, sellerExhaustion: true,
  }),
  C29: Object.freeze({
    ...BASE, id: "C29", structuralStop: true, volumeDryupReaccel: true,
  }),
  C30: Object.freeze({
    ...BASE, id: "C30", structuralStop: true, buyerNotionalEscalation: true,
  }),
  C31: Object.freeze({
    ...BASE, id: "C31", structuralStop: true, crossSectionalPullbackQuality: true,
  }),
  C32: Object.freeze({
    ...BASE, id: "C32", structuralStop: true, crossSectionalBuyerFlowAcceleration: true,
  }),
  C33: Object.freeze({
    ...BASE, id: "C33", structuralStop: true, crossSectionalExecutionValue: true,
  }),
  C34: Object.freeze({
    ...BASE, id: "C34", structuralStop: true, crossSectionalCompressionExpansion60m: true,
  }),
  C35: Object.freeze({
    ...BASE, id: "C35", structuralStop: true, crossSectionalCompressionExpansion60m: true,
    compressionExpansionQueueWinner: true,
  }),
  C36: Object.freeze({
    ...BASE, id: "C36", structuralStop: true, crossSectionalCompressionExpansion60m: true,
    compressionExpansionCycleAuction: true,
  }),
  C37: Object.freeze({
    ...BASE, id: "C37", structuralStop: true, crossSectionalCompressionExpansion60m: true,
    compressionExpansionSetupReservation: true,
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

/** C16: sellers are absorbed during the pullback, then price and buyer share reclaim together. */
export function pullbackAbsorptionDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<6||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C16_ABSORPTION_INPUT_MISSING"};
  const xs=bars.slice(-6).map((b,i)=>researchBar(b,triggerAt-(6-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C16_ABSORPTION_BAR_INVALID"};
  const pullback=xs.slice(0,5),trigger=xs[5];
  const downBars=pullback.filter(x=>x.close<x.open);
  const pullbackBuyRatio=pullback.reduce((s,x)=>s+x.ratio*x.quote,0)/pullback.reduce((s,x)=>s+x.quote,0);
  const priorBuyRatio=pullback.reduce((s,x)=>s+x.ratio,0)/pullback.length;
  const conditions=Object.freeze({
    actualPullback:downBars.length>=2,
    aggregateSellingAbsorbed:pullbackBuyRatio>=0.45,
    higherLowsIntoTrigger:xs[3].low<=xs[4].low&&xs[4].low<=trigger.low,
    referenceReclaimed:trigger.close>=signalReference,
    localClosesBroken:trigger.close>Math.max(...pullback.slice(-3).map(x=>x.close)),
    buyerShareShift:trigger.ratio>priorBuyRatio&&trigger.ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C16_ABSORPTION_PASS":"C16_ABSORPTION_FAIL",conditions,pullbackBuyRatio,triggerBuyRatio:trigger.ratio};
}

/** C17: leadership must be a fresh residual acceleration over BTC, not raw beta. */
export function relativeStrengthResidualDecision({return30m,return60m,btcReturn30m,btcReturn60m}) {
  if(![return30m,return60m,btcReturn30m,btcReturn60m].every(finite))
    return {action:"UNKNOWN",reason:"C17_RELATIVE_STRENGTH_INPUT_MISSING"};
  const residual30=return30m-btcReturn30m,residual60=return60m-btcReturn60m;
  const prior30=return60m-return30m;
  const conditions=Object.freeze({
    positiveCurrentMomentum:return30m>0&&return60m>0,
    outperformingBtc30:residual30>0,
    outperformingBtc60:residual60>0,
    currentHalfAccelerating:return30m>prior30,
    residualConcentratedNow:residual30>=residual60/2,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C17_RELATIVE_STRENGTH_PASS":"C17_RELATIVE_STRENGTH_FAIL",conditions,residual30,residual60,prior30};
}

/** C18: a completed close below reference is swept, rejected and reclaimed with buyers. */
export function sweepReclaimDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<6||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C18_SWEEP_INPUT_MISSING"};
  const xs=bars.slice(-6).map((b,i)=>researchBar(b,triggerAt-(6-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C18_SWEEP_BAR_INVALID"};
  const pre=xs.slice(0,5),trigger=xs[5],sweeps=pre.filter(x=>x.low<signalReference&&x.close<signalReference);
  const minLow=Math.min(...pre.map(x=>x.low)),minIndex=pre.findIndex(x=>x.low===minLow);
  const conditions=Object.freeze({
    completedBreakdownObserved:sweeps.length>=1,
    sweepPrecedesRecovery:minIndex<=3,
    recoveryClosesRising:pre[4].close>pre[3].close&&trigger.close>pre[4].close,
    referenceReclaimed:trigger.close>signalReference,
    microSwingBroken:trigger.close>Math.max(pre[3].high,pre[4].high),
    flowReversal:Math.min(...pre.map(x=>x.ratio))<0.50&&trigger.ratio>=0.60,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C18_SWEEP_PASS":"C18_SWEEP_FAIL",conditions,minIndex,triggerBuyRatio:trigger.ratio};
}

/** C19: a fresh cross-sectional leader rotates into the top ten with confirmed buyer flow. */
export function freshLeaderRotationDecision({
  currentRank,priorRanks,return30m,return60m,triggerAt,now,bar,
}) {
  if(!finite(currentRank)||!Array.isArray(priorRanks)||priorRanks.length!==2||
      !priorRanks.every(x=>x===null||finite(x))||![return30m,return60m].every(finite)||
      !Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now))
    return {action:"UNKNOWN",reason:"C19_ROTATION_INPUT_MISSING"};
  const trigger=researchBar(bar,triggerAt-minute,now);
  if(!trigger)return {action:"UNKNOWN",reason:"C19_ROTATION_BAR_INVALID"};
  const latestPrior=priorRanks[0],priorHalf=return60m-return30m;
  const range=trigger.high-trigger.low;
  const closeLocation=range>0?(trigger.close-trigger.low)/range:0;
  const conditions=Object.freeze({
    currentTopTen:currentRank<=10,
    priorRankObserved:finite(latestPrior),
    freshRankJump:finite(latestPrior)&&latestPrior-currentRank>=4,
    recentReturnPositive:return30m>0,
    currentHalfAccelerating:return30m>priorHalf,
    buyerConfirmed:trigger.ratio>=0.55,
    closeInUpperRange:closeLocation>=0.65,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C19_ROTATION_PASS":"C19_ROTATION_FAIL",conditions,closeLocation,triggerBuyRatio:trigger.ratio};
}

function ceilStep(value,step){
  if(!(finite(value)&&value>=0&&finite(step)&&step>0))return Number.NaN;
  return Math.ceil((value-step*1e-10)/step)*step;
}

/**
 * C20: a higher-low ladder is admitted only when the exchange minimum order
 * fits the unchanged 30 USDT / 0.25% risk budget under baseline costs.
 */
export function accountFeasibleLadderDecision({
  triggerAt,now,bars,signalReference,entryPrice,stopPrice,filters,
  equity=30,riskFraction=0.0025,takerFee=0.0005,entryBps=3,stopBps=10,
  fundingAllowanceRate=0.001,
}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<4||
      ![signalReference,entryPrice,stopPrice,equity,riskFraction,takerFee,entryBps,stopBps,fundingAllowanceRate].every(finite)||
      !(signalReference>0&&entryPrice>stopPrice&&stopPrice>0&&equity>0&&riskFraction>0)||!filters)
    return {action:"UNKNOWN",reason:"C20_FEASIBLE_LADDER_INPUT_MISSING"};
  const xs=bars.slice(-4).map((b,i)=>researchBar(b,triggerAt-(4-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C20_FEASIBLE_LADDER_BAR_INVALID"};
  const minNotional=Number(filters.minNotional),minQty=Number(filters.minQty),stepSize=Number(filters.stepSize);
  if(![minNotional,minQty,stepSize].every(finite)||!(minNotional>0&&minQty>0&&stepSize>0))
    return {action:"UNKNOWN",reason:"C20_FEASIBLE_LADDER_FILTERS_INVALID"};
  const entryExec=entryPrice*(1+entryBps/10_000),stopExec=stopPrice*(1-stopBps/10_000);
  const minimumQty=ceilStep(Math.max(minQty,minNotional/entryExec),stepSize);
  const minimumOrderLoss=minimumQty*((entryExec-stopExec)+entryExec*takerFee+stopExec*takerFee+entryExec*fundingAllowanceRate);
  const riskBudget=equity*riskFraction;
  const conditions=Object.freeze({
    risingLows:xs[1].low<=xs[2].low&&xs[2].low<=xs[3].low,
    lastTwoHoldReference:xs.slice(-2).every(x=>x.close>=signalReference),
    buyerDominantTrigger:xs[3].ratio>=0.55,
    minimumOrderWithinRisk:minimumOrderLoss<=riskBudget,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C20_FEASIBLE_LADDER_PASS":"C20_FEASIBLE_LADDER_FAIL",conditions,minimumQty,minimumOrderLoss,riskBudget};
}

/** C21: an impulse, orderly reset and second buyer-led pulse form one entry pattern. */
export function twoPulseResetDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<8||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C21_TWO_PULSE_INPUT_MISSING"};
  const xs=bars.slice(-8).map((b,i)=>researchBar(b,triggerAt-(8-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C21_TWO_PULSE_BAR_INVALID"};
  const first=xs.slice(0,3),reset=xs.slice(3,6),second=xs.slice(6,8);
  const firstAdvance=first[2].close/first[0].open-1;
  const firstHigh=Math.max(...first.map(x=>x.high));
  const firstRange=Math.max(...first.map(x=>x.high))-Math.min(...first.map(x=>x.low));
  const resetRange=Math.max(...reset.map(x=>x.high))-Math.min(...reset.map(x=>x.low));
  const resetBuy=reset.reduce((s,x)=>s+x.ratio*x.quote,0)/reset.reduce((s,x)=>s+x.quote,0);
  const secondBuy=second.reduce((s,x)=>s+x.ratio*x.quote,0)/second.reduce((s,x)=>s+x.quote,0);
  const conditions=Object.freeze({
    firstPulsePositive:firstAdvance>0,
    resetRangeContracts:firstRange>0&&resetRange<firstRange,
    resetHoldsReference:Math.min(...reset.map(x=>x.low))>=signalReference,
    secondPulseRising:second[1].close>second[0].close,
    firstPulseHighBroken:second[1].close>firstHigh,
    buyerFlowReexpands:secondBuy>resetBuy&&secondBuy>=0.57,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C21_TWO_PULSE_PASS":"C21_TWO_PULSE_FAIL",conditions,firstAdvance,resetRangeRatio:firstRange>0?resetRange/firstRange:null,resetBuy,secondBuy};
}

/** C22: current strength must be efficient relative to the contemporaneous leader set. */
export function liquidityAdjustedEfficiencyDecision({
  return30m,return60m,return30mPercentile,volumeRatioPercentile,efficiencyPercentile,
  triggerAt,now,bar,
}) {
  if(![return30m,return60m,return30mPercentile,volumeRatioPercentile,efficiencyPercentile].every(finite)||
      !Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now))
    return {action:"UNKNOWN",reason:"C22_EFFICIENCY_INPUT_MISSING"};
  const trigger=researchBar(bar,triggerAt-minute,now);
  if(!trigger)return {action:"UNKNOWN",reason:"C22_EFFICIENCY_BAR_INVALID"};
  const range=trigger.high-trigger.low;
  const closeLocation=range>0?(trigger.close-trigger.low)/range:0;
  const conditions=Object.freeze({
    positiveThirtyAndSixty:return30m>0&&return60m>0,
    upperLeaderReturn:return30mPercentile>=0.65,
    upperLeaderParticipation:volumeRatioPercentile>=0.65,
    nonWastefulVolume:efficiencyPercentile>=0.50,
    buyerConfirmed:trigger.ratio>=0.55,
    closeInUpperRange:closeLocation>=0.60,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C22_EFFICIENCY_PASS":"C22_EFFICIENCY_FAIL",conditions,closeLocation,triggerBuyRatio:trigger.ratio};
}

/** C23: enter only an exceptional efficient leader while the contemporaneous leader set is narrow. */
export function selectiveLeaderRegimeDecision({
  return30m,return60m,return30mPercentile,efficiencyPercentile,leaderBreadth30m,
  triggerAt,now,bar,
}) {
  if(![return30m,return60m,return30mPercentile,efficiencyPercentile,leaderBreadth30m].every(finite)||
      !Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now))
    return {action:"UNKNOWN",reason:"C23_SELECTIVE_INPUT_MISSING"};
  const trigger=researchBar(bar,triggerAt-minute,now);
  if(!trigger)return {action:"UNKNOWN",reason:"C23_SELECTIVE_BAR_INVALID"};
  const conditions=Object.freeze({
    narrowLeaderRegime:leaderBreadth30m<=0.50,
    exceptionalRecentLeader:return30mPercentile>=0.80,
    efficientLeader:efficiencyPercentile>=0.65,
    positiveThirtyAndSixty:return30m>0&&return60m>0,
    buyerConfirmed:trigger.ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C23_SELECTIVE_PASS":"C23_SELECTIVE_FAIL",conditions,triggerBuyRatio:trigger.ratio};
}

/** C24: broad leader participation plus a distributed, non-single-candle ascent. */
export function distributedTrendDecision({triggerAt,now,bars,signalReference,leaderBreadth30m}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length<6||
      !(finite(signalReference)&&signalReference>0&&finite(leaderBreadth30m)))
    return {action:"UNKNOWN",reason:"C24_DISTRIBUTED_INPUT_MISSING"};
  const xs=bars.slice(-6).map((b,i)=>researchBar(b,triggerAt-(6-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C24_DISTRIBUTED_BAR_INVALID"};
  const returns=xs.slice(1).map((x,i)=>x.close/xs[i].close-1);
  const positive=returns.filter(x=>x>0),sumPositive=positive.reduce((s,x)=>s+x,0);
  const ranges=xs.map(x=>x.high-x.low),sumRanges=ranges.reduce((s,x)=>s+x,0);
  const weightedBuy=xs.reduce((s,x)=>s+x.ratio*x.quote,0)/xs.reduce((s,x)=>s+x.quote,0);
  const conditions=Object.freeze({
    broadLeaderRegime:leaderBreadth30m>=0.60,
    distributedPositiveCloses:positive.length>=4,
    positiveWindow:xs.at(-1).close>xs[0].open,
    noSingleReturnDominates:sumPositive>0&&Math.max(...positive)/sumPositive<=0.55,
    noSingleRangeDominates:sumRanges>0&&Math.max(...ranges)/sumRanges<=0.40,
    referenceHeld:Math.min(...xs.slice(-3).map(x=>x.close))>=signalReference,
    aggregateBuyerSupport:weightedBuy>=0.52,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C24_DISTRIBUTED_PASS":"C24_DISTRIBUTED_FAIL",conditions,returns,weightedBuy};
}

/** C25: wait for a completed retest, then require buyer-led recovery above the breakout. */
export function breakoutRetestHold2mDecision({triggerAt,now,bars,signalReference,setupLow,triggerClose,triggerHigh}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==2||
      ![signalReference,setupLow,triggerClose,triggerHigh].every(finite)||
      !(signalReference>0&&setupLow>0&&triggerClose>0&&triggerHigh>0)||now<triggerAt+2*minute)
    return {action:"UNKNOWN",reason:"C25_RETEST_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt+i*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C25_RETEST_BAR_INVALID"};
  const conditions=Object.freeze({
    firstBarRetestsBreakout:xs[0].low<=triggerClose,
    retestPreservesSetup:xs[0].low>=setupLow,
    retestClosesAboveReference:xs[0].close>=signalReference,
    recoveryFormsHigherLow:xs[1].low>=xs[0].low,
    recoveryBreaksTriggerHigh:xs[1].close>triggerHigh,
    buyerShareRises:xs[1].ratio>xs[0].ratio,
    recoveryBuyerDominant:xs[1].ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C25_RETEST_PASS":"C25_RETEST_FAIL",conditions,bars:xs};
}

/** C26: a controlled two-bar pullback must reclaim on a stronger third completed bar. */
export function controlledPullbackReclaim3mDecision({triggerAt,now,bars,signalReference,setupLow,triggerClose}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==3||
      ![signalReference,setupLow,triggerClose].every(finite)||!(signalReference>0&&setupLow>0&&triggerClose>0)||
      now<triggerAt+3*minute)return {action:"UNKNOWN",reason:"C26_RECLAIM_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt+i*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C26_RECLAIM_BAR_INVALID"};
  const early=xs.slice(0,2),earlyQuote=early.reduce((s,x)=>s+x.quote,0);
  const earlyBuy=early.reduce((s,x)=>s+x.ratio*x.quote,0)/earlyQuote;
  const conditions=Object.freeze({
    setupNeverInvalidated:xs.every(x=>x.low>=setupLow),
    controlledPullbackOccurs:early.some(x=>x.close<triggerClose&&x.close>=signalReference),
    finalReclaimsTrigger:xs[2].close>triggerClose,
    finalLeadsAllCloses:xs[2].close>Math.max(xs[0].close,xs[1].close),
    buyerFlowReclaims:xs[2].ratio>earlyBuy,
    finalBuyerDominant:xs[2].ratio>=0.58,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C26_RECLAIM_PASS":"C26_RECLAIM_FAIL",conditions,earlyBuy,bars:xs};
}

/** C27: require three completed minutes of price acceptance above the breakout. */
export function breakoutAcceptance3mDecision({triggerAt,now,bars,signalReference,triggerHigh}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==3||
      ![signalReference,triggerHigh].every(finite)||!(signalReference>0&&triggerHigh>0)||now<triggerAt+3*minute)
    return {action:"UNKNOWN",reason:"C27_ACCEPTANCE_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt+i*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C27_ACCEPTANCE_BAR_INVALID"};
  const quote=xs.reduce((s,x)=>s+x.quote,0);
  const weightedBuy=xs.reduce((s,x)=>s+x.ratio*x.quote,0)/quote;
  const finalRange=xs[2].high-xs[2].low;
  const finalLocation=finalRange>0?(xs[2].close-xs[2].low)/finalRange:0;
  const conditions=Object.freeze({
    referenceAccepted:xs.every(x=>x.low>=signalReference),
    repeatedClosesAboveBreakout:xs.filter(x=>x.close>triggerHigh).length>=2,
    finalCloseSustains:xs[2].close>=xs[0].close,
    finalCloseUpperHalf:finalLocation>=0.50,
    aggregateBuyerSupport:weightedBuy>=0.52,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C27_ACCEPTANCE_PASS":"C27_ACCEPTANCE_FAIL",conditions,weightedBuy,finalLocation,bars:xs};
}

/** C28: selling notional must fade during the pullback before a buyer-led trigger. */
export function sellerExhaustionDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==5||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C28_SELLER_EXHAUSTION_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt-(5-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C28_SELLER_EXHAUSTION_BAR_INVALID"};
  const pullback=xs.slice(0,4),trigger=xs[4];
  const selling=pullback.filter(x=>x.close<=x.open).map(x=>x.quote*(1-x.ratio));
  const earlyRange=(pullback[0].high-pullback[0].low)+(pullback[1].high-pullback[1].low);
  const lateRange=(pullback[2].high-pullback[2].low)+(pullback[3].high-pullback[3].low);
  const conditions=Object.freeze({
    repeatedSellingBars:selling.length>=2,
    sellerNotionalFades:selling.length>=2&&selling.at(-1)<selling[0],
    downsideRangeContracts:lateRange<earlyRange,
    closesPreserveReference:pullback.every(x=>x.close>=signalReference),
    triggerBreaksPullback:trigger.close>Math.max(...pullback.map(x=>x.high)),
    triggerBuyerDominant:trigger.ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C28_SELLER_EXHAUSTION_PASS":"C28_SELLER_EXHAUSTION_FAIL",conditions,selling,earlyRange,lateRange};
}

/** C29: volume must dry up in an orderly pullback, then re-expand on the trigger. */
export function volumeDryupReaccelDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==6||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C29_DRYUP_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt-(6-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C29_DRYUP_BAR_INVALID"};
  const impulse=xs.slice(0,3),pullback=xs.slice(3,5),trigger=xs[5];
  const impulseQuote=impulse.reduce((s,x)=>s+x.quote,0)/impulse.length;
  const pullbackQuote=pullback.reduce((s,x)=>s+x.quote,0)/pullback.length;
  const impulseRange=Math.max(...impulse.map(x=>x.high))-Math.min(...impulse.map(x=>x.low));
  const pullbackRange=Math.max(...pullback.map(x=>x.high))-Math.min(...pullback.map(x=>x.low));
  const conditions=Object.freeze({
    impulseAdvances:impulse.at(-1).close>impulse[0].open,
    pullbackVolumeDries:pullbackQuote<impulseQuote,
    pullbackRangeContracts:impulseRange>0&&pullbackRange<impulseRange,
    pullbackPreservesReference:pullback.every(x=>x.low>=signalReference),
    triggerVolumeReexpands:trigger.quote>pullbackQuote*1.25,
    triggerBreaksPullback:trigger.close>Math.max(...pullback.map(x=>x.high)),
    triggerBuyerDominant:trigger.ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C29_DRYUP_PASS":"C29_DRYUP_FAIL",conditions,impulseQuote,pullbackQuote,impulseRange,pullbackRange};
}

/** C30: absolute buyer notional, not just its ratio, must escalate into a clean break. */
export function buyerNotionalEscalationDecision({triggerAt,now,bars,signalReference}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==4||
      !(finite(signalReference)&&signalReference>0))return {action:"UNKNOWN",reason:"C30_BUYER_NOTIONAL_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt-(4-i)*minute,now));
  if(xs.some(x=>x===null))return {action:"UNKNOWN",reason:"C30_BUYER_NOTIONAL_BAR_INVALID"};
  const buy=xs.map(x=>x.quote*x.ratio),sell=xs.map(x=>x.quote*(1-x.ratio));
  const trigger=xs[3],prior=xs.slice(0,3);
  const range=trigger.high-trigger.low,closeLocation=range>0?(trigger.close-trigger.low)/range:0;
  const conditions=Object.freeze({
    buyerNotionalEscalates:buy[1]>buy[0]&&buy[2]>buy[1]&&buy[3]>buy[2],
    sellerNotionalContained:sell[3]<=Math.max(...sell.slice(0,3)),
    referenceHeld:xs.every(x=>x.close>=signalReference),
    triggerBreaksPriorHigh:trigger.close>Math.max(...prior.map(x=>x.high)),
    triggerClosesStrong:closeLocation>=0.65,
    triggerBuyerDominant:trigger.ratio>=0.55,
  });
  const allowed=Object.values(conditions).every(Boolean);
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C30_BUYER_NOTIONAL_PASS":"C30_BUYER_NOTIONAL_FAIL",conditions,buy,sell,closeLocation};
}

/**
 * Assign a causal rolling percentile to each completed setup score. A record can
 * see only records at or before its timestamp; equal-time records are all known
 * at the same queue decision. This is shared pure logic for replay/scanner use.
 */
export function rollingPullbackQualityPercentiles(records,{lookbackMs=7*24*60*minute,minObservations=20}={}) {
  if(!Array.isArray(records)||!(finite(lookbackMs)&&lookbackMs>0)||!Number.isSafeInteger(minObservations)||minObservations<1)
    return [];
  const xs=records.map(x=>({id:String(x?.id??""),at:Number(x?.at),score:Number(x?.score)}))
    .filter(x=>x.id&&Number.isSafeInteger(x.at)&&finite(x.score)).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  return xs.map(x=>{
    const pool=xs.filter(y=>y.at>=x.at-lookbackMs&&y.at<=x.at).map(y=>y.score);
    return {id:x.id,at:x.at,score:x.score,observations:pool.length,
      percentile:pool.length>=minObservations?pool.filter(v=>v<=x.score).length/pool.length:null};
  });
}

/** C31: select only the upper rolling cross-section of pullback recovery efficiency. */
export function crossSectionalPullbackQualityDecision({qualityPercentile,observations}) {
  if(!finite(qualityPercentile)||!Number.isSafeInteger(observations)||observations<20)
    return {action:"UNKNOWN",reason:"C31_PULLBACK_QUALITY_CONTEXT_MISSING"};
  const allowed=qualityPercentile>=0.60;
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C31_PULLBACK_QUALITY_PASS":"C31_PULLBACK_QUALITY_FAIL",
    qualityPercentile,observations,threshold:0.60};
}

/**
 * C32 score: buyer quote-volume acceleration relative to seller quote-volume
 * acceleration over two completed two-minute blocks. This continuous score is
 * ranked causally across contemporaneous candidates instead of requiring the
 * four absolute buyer-notional increases used by C30.
 */
export function buyerFlowAccelerationScore({triggerAt,now,bars}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==4)
    return {status:"UNKNOWN",reason:"C32_BUYER_FLOW_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt-(4-i)*minute,now));
  if(xs.some(x=>x===null))return {status:"UNKNOWN",reason:"C32_BUYER_FLOW_BAR_INVALID"};
  const buy=xs.map(x=>x.quote*x.ratio),sell=xs.map(x=>x.quote*(1-x.ratio));
  const mean=x=>(x[0]+x[1])/2;
  const priorBuy=mean(buy.slice(0,2)),recentBuy=mean(buy.slice(2,4));
  const priorSell=mean(sell.slice(0,2)),recentSell=mean(sell.slice(2,4));
  if(![priorBuy,recentBuy,priorSell,recentSell].every(x=>finite(x)&&x>0))
    return {status:"UNKNOWN",reason:"C32_BUYER_FLOW_NOTIONAL_INVALID"};
  const score=Math.log(recentBuy/priorBuy)-Math.log(recentSell/priorSell);
  return {status:"KNOWN",score,priorBuy,recentBuy,priorSell,recentSell};
}

/** C32: keep the upper rolling cross-section of relative buyer-flow acceleration. */
export function crossSectionalBuyerFlowDecision({flowPercentile,observations}) {
  if(!finite(flowPercentile)||!Number.isSafeInteger(observations)||observations<20)
    return {action:"UNKNOWN",reason:"C32_BUYER_FLOW_CONTEXT_MISSING"};
  const allowed=flowPercentile>=0.60;
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C32_BUYER_FLOW_PASS":"C32_BUYER_FLOW_FAIL",
    flowPercentile,observations,threshold:0.60};
}

/**
 * C33 score: completed breakout surplus per conservative executable downside.
 * All inputs exist at trigger completion; the next-bar open and later MFE are
 * deliberately excluded. Costs are fixed before outcomes are observed.
 */
export function executionAdjustedBreakoutScore({
  signalReference,triggerClose,structuralStop,takerFee=0.0005,
  entryBps=3,stopBps=10,fundingAllowanceRate=0.001,
}) {
  if(![signalReference,triggerClose,structuralStop,takerFee,entryBps,stopBps,fundingAllowanceRate].every(finite)||
      !(signalReference>0&&triggerClose>signalReference&&structuralStop>0&&structuralStop<triggerClose&&
        takerFee>=0&&entryBps>=0&&stopBps>=0&&fundingAllowanceRate>=0))
    return {status:"UNKNOWN",reason:"C33_EXECUTION_VALUE_INPUT_INVALID"};
  const breakoutSurplus=triggerClose-signalReference;
  const conservativeDownside=(triggerClose-structuralStop)+triggerClose*(2*takerFee+(entryBps+stopBps)/10_000+fundingAllowanceRate);
  if(!(conservativeDownside>0))return {status:"UNKNOWN",reason:"C33_EXECUTION_VALUE_DENOMINATOR_INVALID"};
  return {status:"KNOWN",score:breakoutSurplus/conservativeDownside,breakoutSurplus,conservativeDownside};
}

/** C33: retain the upper rolling cross-section of completed execution value. */
export function crossSectionalExecutionValueDecision({valuePercentile,observations}) {
  if(!finite(valuePercentile)||!Number.isSafeInteger(observations)||observations<20)
    return {action:"UNKNOWN",reason:"C33_EXECUTION_VALUE_CONTEXT_MISSING"};
  const allowed=valuePercentile>=0.60;
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C33_EXECUTION_VALUE_PASS":"C33_EXECUTION_VALUE_FAIL",
    valuePercentile,observations,threshold:0.60};
}

/**
 * C34 score: directional range expansion in the last completed five minutes
 * relative to the median normalized range of the prior eleven five-minute
 * blocks. Exactly sixty completed one-minute bars are used, so no future bar
 * or final excursion can enter the decision.
 */
export function compressionExpansion60mScore({triggerAt,now,bars}) {
  if(!Number.isSafeInteger(triggerAt)||!Number.isSafeInteger(now)||!Array.isArray(bars)||bars.length!==60)
    return {status:"UNKNOWN",reason:"C34_COMPRESSION_EXPANSION_INPUT_MISSING"};
  const xs=bars.map((b,i)=>researchBar(b,triggerAt-(60-i)*minute,now));
  if(xs.some(x=>x===null))return {status:"UNKNOWN",reason:"C34_COMPRESSION_EXPANSION_BAR_INVALID"};
  const blocks=[];
  for(let i=0;i<12;i++){
    const block=xs.slice(i*5,i*5+5),open=block[0].open,close=block[4].close;
    const high=Math.max(...block.map(x=>x.high)),low=Math.min(...block.map(x=>x.low));
    blocks.push({open,close,normalizedRange:(high-low)/open});
  }
  const prior=blocks.slice(0,11).map(x=>x.normalizedRange).sort((a,b)=>a-b);
  const medianPriorRange=prior[Math.floor(prior.length/2)],current=blocks[11];
  const directionalAdvance=current.close/current.open-1;
  if(!(medianPriorRange>0&&directionalAdvance>0))
    return {status:"UNKNOWN",reason:"C34_COMPRESSION_EXPANSION_NONPOSITIVE"};
  return {status:"KNOWN",score:directionalAdvance/medianPriorRange,directionalAdvance,medianPriorRange};
}

/** C34: keep the upper causal cross-section of fresh 60m compression breaks. */
export function crossSectionalCompressionExpansionDecision({expansionPercentile,observations}) {
  if(!finite(expansionPercentile)||!Number.isSafeInteger(observations)||observations<20)
    return {action:"UNKNOWN",reason:"C34_COMPRESSION_EXPANSION_CONTEXT_MISSING"};
  const allowed=expansionPercentile>=0.60;
  return {action:allowed?"ENTER":"REJECT",reason:allowed?"C34_COMPRESSION_EXPANSION_PASS":"C34_COMPRESSION_EXPANSION_FAIL",
    expansionPercentile,observations,threshold:0.60};
}

/**
 * C35: choose exactly one already-eligible C34 opportunity for each completed
 * trigger timestamp. Selection uses only the pre-entry C34 score; lexical id is
 * a deterministic tie-breaker. The caller remains responsible for applying the
 * unchanged C34 causal percentile gate before invoking this function.
 */
export function selectCompressionExpansionQueueWinners(records) {
  if(!Array.isArray(records))return [];
  const valid=records.filter(r=>r&&typeof r.id==="string"&&r.id.length>0&&
    Number.isSafeInteger(r.at)&&finite(r.score));
  const byAt=new Map();
  for(const record of valid){
    const current=byAt.get(record.at);
    if(!current||record.score>current.score||(record.score===current.score&&record.id<current.id))
      byAt.set(record.at,record);
  }
  return [...byAt.values()].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
}

/**
 * C36: run a causal auction after each completed scanner cycle. A trigger at
 * an exact cycle boundary belongs to the cycle that just completed. The
 * highest already-eligible C34 score wins and may enter at the cycle-end open;
 * lexical id breaks equal-score ties deterministically.
 */
export function selectCompressionExpansionCycleWinners(records,{cycleMs=15*minute}={}) {
  if(!Array.isArray(records)||!Number.isSafeInteger(cycleMs)||cycleMs<=0)return [];
  const valid=records.filter(r=>r&&typeof r.id==="string"&&r.id.length>0&&
    Number.isSafeInteger(r.at)&&r.at>0&&finite(r.score));
  const byCycleEnd=new Map();
  for(const record of valid){
    const cycleEnd=Math.ceil(record.at/cycleMs)*cycleMs;
    const current=byCycleEnd.get(cycleEnd);
    if(!current||record.score>current.score||(record.score===current.score&&record.id<current.id))
      byCycleEnd.set(cycleEnd,{...record,entryAt:cycleEnd});
  }
  return [...byCycleEnd.values()].sort((a,b)=>a.entryAt-b.entryAt||a.id.localeCompare(b.id));
}

/**
 * C37: reserve one setup from each simultaneously completed setup cohort.
 * Every score must be calculable at the setup timestamp, before pullback and
 * trigger observations. The reserved setup may then use the ordinary immediate
 * trigger path without the post-trigger delay introduced by C36.
 */
export function selectCompressionExpansionSetupReservations(records) {
  return selectCompressionExpansionQueueWinners(records);
}
