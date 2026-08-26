import type { P10ExitDecision } from "./p10-policy.ts";

export const S096_SHORT_STRATEGY_KEY = "S096_RSI_MOMENTUM_FAST";
// Keep the strategy identity stable so already-open S096 positions remain on the fixed SHORT exit path.
export const S096_SHORT_REVISION = "S096-LIVE-1.0.0";
export const S096_ENTRY_QUALITY_REVISION = "S096-ANTICHASE-20260826";
export const S096_RESEARCH_PROTOCOL = "SHORT_V4_S37_PLUS_100_AUDITED_FINAL_REPLAY";
export const S096_RESEARCH_REGISTRY_SHA256 =
  "7710581b06e91eef4dcdf2008f03e82a76c13406d3095811c50341f2d4598598";

// Frozen research definition. Do not mutate these fields to tune production behavior.
export const S096_SHORT_CONFIG = Object.freeze({
  stopAtr: 1.25,
  targetR: 1.5,
  maxEntryGapAtr: 0.5,
  maxInitialRiskPct: 5.0,
  maxHoldBars: 96,
  minHistoryBars: 106,
  minVolumeRatio: 1.0,
  minQuoteVolumeMean20: 500_000,
  minAtrPct: 0.15,
  maxAtrPct: 6.0,
  minRet24Pct: -20.0,
  maxRet24Pct: -0.2,
  minRsi14: 14.0,
  maxRsi14: 40.0,
  maxBtcRet24Pct: 0.0,
  rsiFallingBars: 3,
});

// Live execution-quality overlay. Research identity stays frozen while production rejects
// capitulation chasing that has shown negative realized expectancy in live fills.
export const S096_LIVE_ENTRY_QUALITY_CONFIG = Object.freeze({
  minRet3Pct: -5.0,
  minRet6Pct: -8.0,
  minRet12Pct: -12.0,
  minRet24Pct: -12.0,
  minRsi14: 30.0,
  minCloseLocation: 0.15,
});

export type S096PreparedBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  atr14: number;
  rsi14: number;
  ret24Pct: number;
  volumeRatio: number;
  quoteVolumeMean20: number;
  efficiency24?: number;
};

export type S096SignalCheck = {
  score: number;
  rel24: number;
  dl: number;
  atrPct: number;
  rsiPath: readonly [number, number, number, number];
};

export type CombinedSignalCandidate<TLongCheck> =
  | {
    side: "LONG";
    check: NonNullable<TLongCheck>;
    strategyKey: string;
    strategyRevision: string;
    stopAtr: number;
  }
  | {
    side: "SHORT";
    check: S096SignalCheck;
    strategyKey: typeof S096_SHORT_STRATEGY_KEY;
    strategyRevision: typeof S096_SHORT_REVISION;
    stopAtr: typeof S096_SHORT_CONFIG.stopAtr;
  };

const finite = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const pct = (now: number, before: number) => before > 0 ? (now / before - 1) * 100 : 0;

/**
 * Applies the frozen S096 signal-bar rules plus a production anti-chase overlay.
 * The prior 14-RSI lower bound repeatedly admitted assets after most of the decline had
 * already happened; live entries now require room for continuation instead of selling capitulation.
 */
export function checkS096ShortSignal(
  bars: readonly S096PreparedBar[],
  btcRet24Pct: number,
): S096SignalCheck | null {
  if (bars.length < S096_SHORT_CONFIG.minHistoryBars) return null;
  const b = bars.at(-1)!;
  const previous = bars.at(-2)!;
  const rsiPath = [b.rsi14, previous.rsi14, bars.at(-3)!.rsi14, bars.at(-4)!.rsi14] as const;
  const required = [
    b.open,
    b.high,
    b.low,
    b.close,
    b.atr14,
    previous.atr14,
    b.rsi14,
    b.ret24Pct,
    b.volumeRatio,
    b.quoteVolumeMean20,
    btcRet24Pct,
    ...rsiPath,
  ];
  if (!required.every(Number.isFinite)) return null;
  if (btcRet24Pct > S096_SHORT_CONFIG.maxBtcRet24Pct) return null;
  if (!(b.atr14 > 0 && previous.atr14 > 0 && b.close > 0 && b.high > b.low)) return null;
  if (b.volumeRatio < S096_SHORT_CONFIG.minVolumeRatio) return null;
  if (b.quoteVolumeMean20 < S096_SHORT_CONFIG.minQuoteVolumeMean20) return null;

  const atrPct = b.atr14 / b.close * 100;
  if (atrPct < S096_SHORT_CONFIG.minAtrPct || atrPct > S096_SHORT_CONFIG.maxAtrPct) {
    return null;
  }
  if (S096_SHORT_CONFIG.stopAtr * atrPct > S096_SHORT_CONFIG.maxInitialRiskPct) return null;
  if (
    b.ret24Pct < S096_SHORT_CONFIG.minRet24Pct ||
    b.ret24Pct > S096_SHORT_CONFIG.maxRet24Pct
  ) return null;
  if (b.rsi14 < S096_SHORT_CONFIG.minRsi14 || b.rsi14 > S096_SHORT_CONFIG.maxRsi14) {
    return null;
  }
  if (!(b.close < b.open)) return null;
  if (!(rsiPath[0] < rsiPath[1] && rsiPath[1] < rsiPath[2] && rsiPath[2] < rsiPath[3])) {
    return null;
  }

  const ret3Pct = pct(b.close, bars.at(-4)!.close);
  const ret6Pct = pct(b.close, bars.at(-7)!.close);
  const ret12Pct = pct(b.close, bars.at(-13)!.close);
  const closeLocation = (b.close - b.low) / (b.high - b.low);
  if (
    ret3Pct < S096_LIVE_ENTRY_QUALITY_CONFIG.minRet3Pct ||
    ret6Pct < S096_LIVE_ENTRY_QUALITY_CONFIG.minRet6Pct ||
    ret12Pct < S096_LIVE_ENTRY_QUALITY_CONFIG.minRet12Pct ||
    b.ret24Pct < S096_LIVE_ENTRY_QUALITY_CONFIG.minRet24Pct ||
    b.rsi14 < S096_LIVE_ENTRY_QUALITY_CONFIG.minRsi14 ||
    closeLocation < S096_LIVE_ENTRY_QUALITY_CONFIG.minCloseLocation
  ) return null;

  return {
    score: -b.ret24Pct + b.volumeRatio * 0.25 + finite(b.efficiency24),
    rel24: btcRet24Pct - b.ret24Pct,
    dl: 1 - closeLocation,
    atrPct,
    rsiPath,
  };
}

/**
 * Keeps the existing I46 LONG candidate authoritative and introduces S096 only as the
 * Binance Futures fallback. The two research score scales are intentionally never compared.
 */
export function selectCombinedLongS096Candidate<TLongCheck>(input: {
  venue: string;
  bars: readonly S096PreparedBar[];
  btcRet24Pct: number;
  longCheck: TLongCheck | null;
  longStrategyKey: string;
  longStrategyRevision: string;
  longStopAtr: number;
}): CombinedSignalCandidate<TLongCheck> | null {
  if (input.longCheck) {
    return {
      side: "LONG",
      check: input.longCheck as NonNullable<TLongCheck>,
      strategyKey: input.longStrategyKey,
      strategyRevision: input.longStrategyRevision,
      stopAtr: input.longStopAtr,
    };
  }
  if (input.venue !== "binance_futures") return null;
  const shortCheck = checkS096ShortSignal(input.bars, input.btcRet24Pct);
  return shortCheck
    ? {
      side: "SHORT",
      check: shortCheck,
      strategyKey: S096_SHORT_STRATEGY_KEY,
      strategyRevision: S096_SHORT_REVISION,
      stopAtr: S096_SHORT_CONFIG.stopAtr,
    }
    : null;
}

export function isS096SignalEvidence(evidence: unknown): boolean {
  const row = evidence && typeof evidence === "object" ? evidence as Record<string, unknown> : {};
  return row.entry_strategy_key === S096_SHORT_STRATEGY_KEY &&
    row.entry_strategy_revision === S096_SHORT_REVISION;
}

/** Fixed SHORT policies use the post-fill stop, never the stale pre-fill trailing field. */
export function resolveFixedShortCurrentStop(
  persistedStopPrice: unknown,
  _preFillTrailingStop: unknown,
): number {
  return finite(persistedStopPrice);
}

export function planS096ShortEntry(referenceClose: number, atr14: number, entryPrice: number) {
  const risk = S096_SHORT_CONFIG.stopAtr * finite(atr14);
  const gapAtr = atr14 > 0 ? Math.abs(entryPrice - referenceClose) / atr14 : Infinity;
  const riskPct = entryPrice > 0 ? risk / entryPrice * 100 : Infinity;
  const allowed = referenceClose > 0 && atr14 > 0 && entryPrice > 0 &&
    gapAtr <= S096_SHORT_CONFIG.maxEntryGapAtr &&
    riskPct <= S096_SHORT_CONFIG.maxInitialRiskPct;
  return {
    allowed,
    reason: allowed
      ? null
      : gapAtr > S096_SHORT_CONFIG.maxEntryGapAtr
      ? `entry gap ${gapAtr.toFixed(4)} ATR exceeds ${S096_SHORT_CONFIG.maxEntryGapAtr}`
      : riskPct > S096_SHORT_CONFIG.maxInitialRiskPct
      ? `initial stop risk ${riskPct.toFixed(4)}% exceeds ${S096_SHORT_CONFIG.maxInitialRiskPct}%`
      : "invalid S096 entry plan",
    side: "SHORT" as const,
    entryPrice,
    initialRisk: risk,
    riskPct,
    stopPrice: entryPrice + risk,
    partialTarget: entryPrice - S096_SHORT_CONFIG.targetR * risk,
    finalTarget: entryPrice - S096_SHORT_CONFIG.targetR * risk,
  };
}

export function evaluateS096ShortExit(input: {
  entryPrice: number;
  initialRisk: number;
  currentStop: number;
  executablePrice: number;
  openedAtMs: number;
  nowMs: number;
  lastPolicyBarTime: number;
  latestCompletedBarTime?: number | null;
}): P10ExitDecision {
  const policyBarTime = Math.max(
    finite(input.lastPolicyBarTime),
    finite(input.latestCompletedBarTime),
  );
  if (input.executablePrice >= input.currentStop) {
    return {
      action: "STOP",
      reason: "S096_STOP_1P25_ATR",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  const target = input.entryPrice - S096_SHORT_CONFIG.targetR * input.initialRisk;
  if (input.executablePrice <= target) {
    return {
      action: "TARGET_2",
      reason: "S096_FIXED_1P5R",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  if (input.nowMs - input.openedAtMs >= S096_SHORT_CONFIG.maxHoldBars * 3_600_000) {
    return {
      action: "TIME",
      reason: "S096_MAX_HOLD_96H",
      fraction: 1,
      nextStop: input.currentStop,
      policyBarTime,
    };
  }
  return {
    action: "NONE",
    reason: null,
    fraction: 0,
    nextStop: input.currentStop,
    policyBarTime,
  };
}
