import {
  BASE_COST_BPS,
  type Candidate,
  type PreparedBar,
  type SignalDecision,
  type StructuralPoint,
  type TacticalContext,
} from "./types.ts";
import { FIFTEEN_MINUTE_BARS_7D } from "./indicators.ts";

/**
 * This registry is deliberately small and pre-committed before any V5 result is
 * read.  Each family changes one primary entry threshold around a baseline;
 * exits stay fixed inside the family so a neighbourhood check remains useful.
 */
export const V5_CANDIDATE_REGISTRY_REVISION = "V6_PRECOMMITTED_RANGE_EDGE_SCORE_20260829_A";

const BULL_EXIT = {
  breakEvenAtR: 0.8,
  breakEvenLockR: 0.1,
  trailStartR: 1.5,
  trailAtr: 1.5,
  peakTightenR: 2.5,
  peakTrailAtr: 1.15,
};

const RANGE_EXIT = {
  initialStopAtr: 0.65,
  maxHoldBars: 4,
  profitLockAtR: 0.35,
  profitLockR: 0.10,
  // V6 realizes the small mean-reversion edge before the observed giveback.
  partialTakeAtr: 0.25,
  partialTakeFraction: 0.70,
  noResponseBars: 2,
  portfolioBreakEvenAfterPartial: 1,
  rangeBreakBufferAtr: 0.10,
};

const BEAR_EXIT = {
  initialStopAtr: 0.65,
  targetR: 0.75,
  maxHoldBars: 4,
  timeStopBars: 3,
  minMfeAtTimeStopR: 0.2,
  profitLockAtR: 0.4,
  profitLockR: 0.15,
};

const COMMON = {
  minQv24: 2_000_000,
  minValidMarkets: 250,
  minHistoryBars: FIFTEEN_MINUTE_BARS_7D,
};

const BULL_BASE = {
  ...COMMON,
  ...BULL_EXIT,
  maxAbsRet24: 0.35,
  minPositiveBreadth6h: 0.48,
  minStructuralBreadthVelocity: -0.01,
  minEmaSlopeAtr: 0.015,
  minMomentumAtr: 0.15,
  minVolumeRatio: 1.05,
  minRsi: 52,
  maxRsi: 76,
  maxStochPercentile: 0.9,
  maxEmaDistanceAtr: 2.1,
};

const RANGE_BASE = {
  ...COMMON,
  ...RANGE_EXIT,
  maxAbsRet24: 0.25,
  maxAdx: 23,
  maxEmaSeparationAtr: 0.70,
  minAtrPercentile: 0.10,
  maxAtrPercentile: 0.90,
  minRangeWidthAtr: 1.80,
  maxRangeWidthAtr: 6.00,
  maxRsiPercentile: 0.45,
  minRsiPercentile: 0.55,
  minBreadthVelocity: -0.005,
  maxBreadthVelocity: 0.005,
  minVolumeRatio: 0.55,
  recoveryVolumeRatio: 0.90,
  bandTouchToleranceAtr: 0.12,
  maxSwingBreakAtr: 0.12,
  minTargetAtr: 0.65,
  costMultiple: 3,
  partialCostMultiple: 1.25,
  minConfirmationScore: 3,
};

const BEAR_BASE = {
  ...COMMON,
  ...BEAR_EXIT,
  maxAbsRet24: 0.35,
  minDropAtr: 0.8,
  minReboundAtr: 0.6,
  retestToleranceAtr: 0.35,
  minRebreakAtr: 0.05,
  minVolumeRatio: 0.75,
  maxEmaDistanceAtr: 1.5,
  minBreadthDeterioration: 0.005,
  costMultiple: 3,
};

function makeCandidate(
  name: string,
  family: Candidate["family"],
  side: Candidate["side"],
  state: Candidate["state"],
  neighborGroup: string,
  parameters: Record<string, number>,
): Candidate {
  return { name, family, side, state, neighborGroup, parameters };
}

const PRECOMMITTED_GRID: Candidate[] = [
  ...[0.04, 0.08, 0.12].map((minBreakoutAtr) =>
    makeCandidate(
      `V5_BULL_DONCHIAN_B${String(Math.round(minBreakoutAtr * 1000)).padStart(3, "0")}`,
      "DONCHIAN_BREAKOUT",
      "LONG",
      "BULL_TREND",
      "BULL_DONCHIAN_BREAK_STRENGTH",
      {
        ...BULL_BASE,
        initialStopAtr: 1.6,
        maxHoldBars: 192,
        minRsi: 55,
        maxRsi: 78,
        minVolumeRatio: 0.95,
        maxEmaDistanceAtr: 1.8,
        minBreakoutAtr,
      },
    )
  ),
  ...[0.45, 0.6, 0.75].map((minMomentumAtr) =>
    makeCandidate(
      `V5_BULL_MOMENTUM_M${String(Math.round(minMomentumAtr * 100)).padStart(2, "0")}`,
      "MOMENTUM_ACCELERATION",
      "LONG",
      "BULL_TREND",
      "BULL_MOMENTUM_STRENGTH",
      {
        ...BULL_BASE,
        initialStopAtr: 1.6,
        maxHoldBars: 160,
        minRsi: 57,
        maxRsi: 82,
        minVolumeRatio: 1.15,
        maxStochPercentile: 0.95,
        maxEmaDistanceAtr: 2,
        minMomentumAtr,
      },
    )
  ),
  ...[0.12, 0.18, 0.24].map((maxCompressionPercentile) =>
    makeCandidate(
      `V5_BULL_COMPRESSION_P${String(Math.round(maxCompressionPercentile * 100)).padStart(2, "0")}`,
      "COMPRESSION_BREAKOUT",
      "LONG",
      "BULL_TREND",
      "BULL_COMPRESSION_PERCENTILE",
      {
        ...BULL_BASE,
        initialStopAtr: 1.5,
        maxHoldBars: 160,
        minRsi: 52,
        maxRsi: 80,
        minVolumeRatio: 1.05,
        maxEmaDistanceAtr: 1.8,
        minBandBreakAtr: 0.02,
        maxCompressionPercentile,
      },
    )
  ),
  ...[0.20, 0.25, 0.30].map((maxRangePosition) =>
    makeCandidate(
      `V6_RANGE_LONG_EDGE_P${String(Math.round(maxRangePosition * 100)).padStart(2, "0")}`,
      "RANGE_CYCLE",
      "LONG",
      "RANGE_UP_CYCLE",
      "RANGE_LONG_EDGE_LOCATION",
      { ...RANGE_BASE, maxRangePosition },
    )
  ),
  ...[0.80, 0.75, 0.70].map((minRangePosition) =>
    makeCandidate(
      `V6_RANGE_SHORT_EDGE_P${String(Math.round(minRangePosition * 100)).padStart(2, "0")}`,
      "RANGE_CYCLE",
      "SHORT",
      "RANGE_DOWN_CYCLE",
      "RANGE_SHORT_EDGE_LOCATION",
      { ...RANGE_BASE, minRangePosition },
    )
  ),
  ...[0, 0.05, 0.1].map((minRebreakAtr) =>
    makeCandidate(
      `V5_BEAR_REBREAK_B${String(Math.round(minRebreakAtr * 100)).padStart(2, "0")}`,
      "BEAR_REBREAK",
      "SHORT",
      "BEAR_REBREAK",
      "BEAR_REBREAK_STRENGTH",
      { ...BEAR_BASE, minRebreakAtr },
    )
  ),
  ...[0.45, 0.75].map((minReboundAtr) =>
    makeCandidate(
      `V5_BEAR_REBREAK_RB_A${String(Math.round(minReboundAtr * 100)).padStart(2, "0")}`,
      "BEAR_REBREAK",
      "SHORT",
      "BEAR_REBREAK",
      "BEAR_REBOUND_SIZE",
      { ...BEAR_BASE, minReboundAtr },
    )
  ),
];

const FROZEN_GRID: readonly Candidate[] = Object.freeze(
  PRECOMMITTED_GRID.map((candidate) =>
    Object.freeze({
      ...candidate,
      parameters: Object.freeze({ ...candidate.parameters }),
    })
  ),
);

function canonicalRegistry(candidates: readonly Candidate[]): string {
  return JSON.stringify(
    [...candidates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((candidate) => ({
        name: candidate.name,
        family: candidate.family,
        side: candidate.side,
        state: candidate.state,
        neighborGroup: candidate.neighborGroup,
        parameters: Object.fromEntries(
          Object.entries(candidate.parameters).sort(([a], [b]) => a.localeCompare(b)),
        ),
      })),
  );
}

/** Stable input for a SHA-256 registry hash stored with every research job. */
export const CANDIDATE_REGISTRY_HASH_INPUT = `${V5_CANDIDATE_REGISTRY_REVISION}\n${
  canonicalRegistry(FROZEN_GRID)
}`;

/** Returns a detached copy; callers cannot mutate the pre-committed registry. */
export function candidates(): Candidate[] {
  return FROZEN_GRID.map((candidate) => ({
    ...candidate,
    parameters: { ...candidate.parameters },
  }));
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function parameter(candidate: Candidate, key: string): number {
  const value = candidate.parameters[key];
  if (!finite(value)) throw new Error(`candidate ${candidate.name} missing ${key}`);
  return value;
}

function reject(
  candidate: Candidate,
  tactical: TacticalContext,
  reasons: string[],
): SignalDecision {
  return {
    ok: false,
    state: tactical?.state ?? candidate.state,
    phase: tactical?.phase ?? "NEUTRAL",
    reasons,
  };
}

function accept(
  tactical: TacticalContext,
  reasons: string[],
  stopHint?: number,
  targetHint?: number,
): SignalDecision {
  return {
    ok: true,
    state: tactical.state,
    phase: tactical.phase,
    ...(finite(stopHint ?? Number.NaN) ? { stopHint } : {}),
    ...(finite(targetHint ?? Number.NaN) ? { targetHint } : {}),
    reasons,
  };
}

function expectedStructural(candidate: Candidate): "BULL" | "RANGE" | "BEAR" {
  if (
    candidate.family === "DONCHIAN_BREAKOUT" ||
    candidate.family === "MOMENTUM_ACCELERATION" ||
    candidate.family === "COMPRESSION_BREAKOUT"
  ) return "BULL";
  if (candidate.family === "RANGE_CYCLE") return "RANGE";
  return "BEAR";
}

function commonFailures(
  current: PreparedBar,
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
): string[] {
  const failures: string[] = [];
  const expected = expectedStructural(candidate);
  if (!finite(current.atr) || current.atr <= 0 || !finite(current.close) || current.close <= 0) {
    failures.push("INVALID_PRICE_OR_ATR");
  }
  if (index < parameter(candidate, "minHistoryBars")) {
    failures.push("SEVEN_DAY_CAUSAL_HISTORY_REQUIRED");
  }
  if (
    !finite(current.ret24h) || !finite(current.atrPercentile7d) ||
    !finite(current.rsiPercentile7d) || !finite(current.stochPercentile7d) ||
    !finite(current.vwap96) || !finite(current.dayOpen)
  ) failures.push("INVALID_CAUSAL_HISTORY_FEATURES");
  if (structural.time > current.time) failures.push("FUTURE_STRUCTURAL_POINT");
  if (structural.regime !== expected || tactical.structural !== expected) {
    failures.push(`STRUCTURAL_${expected}_REQUIRED`);
  }
  if (candidate.state !== tactical.state) failures.push(`STATE_${candidate.state}_REQUIRED`);
  // Preserve the pre-existing BULL baselines: their validated edge was defined
  // by structural BULL + the 15m/30m accelerating phase + the family-specific
  // breakout/momentum condition.  We still compute and retain the real 5m
  // context for diagnostics, but do not silently replace those baselines with
  // a new mandatory 5m filter.  The unvalidated RANGE/BEAR families remain
  // confirmation-gated.
  if (expected === "BEAR" && !tactical.fiveMinuteConfirmed) {
    failures.push("FIVE_MINUTE_CONFIRMATION_REQUIRED");
  }
  if (structural.validMarkets < parameter(candidate, "minValidMarkets")) {
    failures.push("INSUFFICIENT_MARKET_BREADTH");
  }
  if (current.qv24 < parameter(candidate, "minQv24")) failures.push("QUOTE_VOLUME_TOO_LOW");
  if (Math.abs(current.ret24h) > parameter(candidate, "maxAbsRet24")) {
    failures.push("EXTREME_MOVER_EXCLUDED");
  }
  return failures;
}

function bullDecision(
  bars: readonly PreparedBar[],
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
): SignalDecision {
  const current = bars[index];
  const previous = bars[index - 1];
  if (!previous) return reject(candidate, tactical, ["COMPLETED_PRIOR_BAR_REQUIRED"]);
  const failures = commonFailures(current, index, candidate, tactical, structural);

  // EXTENDED and DECELERATING never open a baseline BULL position.  A future
  // re-acceleration candidate must be a separate pre-committed family.
  if (tactical.phase !== "ACCELERATING" || tactical.state !== "BULL_TREND") {
    failures.push("BULL_ACCELERATING_ONLY");
  }
  if (!(current.close > current.ema20 && current.ema20 > current.ema50)) {
    failures.push("BULL_EMA_ALIGNMENT_REQUIRED");
  }
  if (current.ema20SlopeAtr < parameter(candidate, "minEmaSlopeAtr")) {
    failures.push("EMA20_SLOPE_TOO_WEAK");
  }
  const momentumAtr = current.ret4 * current.close / current.atr;
  if (momentumAtr < parameter(candidate, "minMomentumAtr")) failures.push("MOMENTUM_TOO_WEAK");
  if (current.volumeRatio < parameter(candidate, "minVolumeRatio")) {
    failures.push("VOLUME_EXPANSION_REQUIRED");
  }
  if (
    current.rsi < parameter(candidate, "minRsi") || current.rsi > parameter(candidate, "maxRsi")
  ) {
    failures.push("RSI_NOT_IN_BULL_WINDOW");
  }
  if (current.stochPercentile7d > parameter(candidate, "maxStochPercentile")) {
    failures.push("DYNAMIC_STOCH_OVERHEATED");
  }
  const emaDistanceAtr = (current.close - current.ema20) / current.atr;
  if (emaDistanceAtr > parameter(candidate, "maxEmaDistanceAtr")) {
    failures.push("EMA_DISTANCE_EXTENDED");
  }
  if (current.close <= current.open) failures.push("BULLISH_CLOSE_REQUIRED");
  if (
    structural.positiveBreadth6h < parameter(candidate, "minPositiveBreadth6h") ||
    structural.breadthVelocity < parameter(candidate, "minStructuralBreadthVelocity")
  ) failures.push("BULL_BREADTH_CONFIRMATION_REQUIRED");

  if (candidate.family === "DONCHIAN_BREAKOUT") {
    const breakoutAtr = (current.close - current.high20Prev) / current.atr;
    if (
      current.close <= current.high20Prev || breakoutAtr < parameter(candidate, "minBreakoutAtr")
    ) {
      failures.push("COMPLETED_DONCHIAN_BREAKOUT_REQUIRED");
    }
  } else if (candidate.family === "MOMENTUM_ACCELERATION") {
    if (current.ret2 <= 0 || momentumAtr < parameter(candidate, "minMomentumAtr")) {
      failures.push("MOMENTUM_ACCELERATION_REQUIRED");
    }
  } else if (candidate.family === "COMPRESSION_BREAKOUT") {
    const bandBreakAtr = (current.close - previous.bbUpper) / current.atr;
    if (
      previous.bbCompressionPercentile7d > parameter(candidate, "maxCompressionPercentile") ||
      current.close <= previous.bbUpper ||
      bandBreakAtr < parameter(candidate, "minBandBreakAtr")
    ) failures.push("PRIOR_COMPRESSION_BREAKOUT_REQUIRED");
  } else {
    failures.push("BULL_FAMILY_REQUIRED");
  }

  if (failures.length) return reject(candidate, tactical, failures);
  return accept(
    tactical,
    ["STRUCTURAL_BULL", "TACTICAL_ACCELERATING", candidate.family],
    current.close - parameter(candidate, "initialStopAtr") * current.atr,
  );
}

function nearestTargetAbove(current: PreparedBar): number | null {
  const anchors = [current.vwap96, current.dayOpen, current.bbMid, current.rangeMid20Prev]
    .filter((value) => finite(value) && value > current.close)
    .sort((a, b) => a - b);
  return anchors[0] ?? null;
}

function nearestTargetBelow(current: PreparedBar): number | null {
  const anchors = [current.vwap96, current.dayOpen, current.bbMid, current.rangeMid20Prev]
    .filter((value) => finite(value) && value < current.close)
    .sort((a, b) => b - a);
  return anchors[0] ?? null;
}

function rangeDecision(
  bars: readonly PreparedBar[],
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
): SignalDecision {
  const current = bars[index];
  const previous = bars[index - 1];
  if (!previous) return reject(candidate, tactical, ["COMPLETED_PRIOR_BAR_REQUIRED"]);
  const failures = commonFailures(current, index, candidate, tactical, structural);
  if (candidate.family !== "RANGE_CYCLE") failures.push("RANGE_FAMILY_REQUIRED");

  const isLong = candidate.side === "LONG";
  const expectedPhase = isLong ? "UP_CYCLE" : "DOWN_CYCLE";
  const expectedState = isLong ? "RANGE_UP_CYCLE" : "RANGE_DOWN_CYCLE";
  if (tactical.phase !== expectedPhase || tactical.state !== expectedState) {
    failures.push(isLong ? "RANGE_UP_CYCLE_ONLY" : "RANGE_DOWN_CYCLE_ONLY");
  }

  const emaSeparationAtr = Math.abs(current.ema20 - current.ema50) / current.atr;
  if (
    current.adx > parameter(candidate, "maxAdx") ||
    emaSeparationAtr > parameter(candidate, "maxEmaSeparationAtr")
  ) failures.push("TRENDLESS_STRUCTURE_REQUIRED");
  if (
    current.atrPercentile7d < parameter(candidate, "minAtrPercentile") ||
    current.atrPercentile7d > parameter(candidate, "maxAtrPercentile")
  ) failures.push("ATR_PERCENTILE_OUTSIDE_WINDOW");

  const rangeWidth = current.high20Prev - current.low20Prev;
  const rangeWidthAtr = rangeWidth / current.atr;
  if (
    !(rangeWidth > 0) || rangeWidthAtr < parameter(candidate, "minRangeWidthAtr") ||
    rangeWidthAtr > parameter(candidate, "maxRangeWidthAtr")
  ) {
    failures.push("RANGE_WIDTH_OUTSIDE_EDGE_WINDOW");
  }
  const rangePosition = rangeWidth > 0 ? (current.close - current.low20Prev) / rangeWidth : 0.5;
  if (isLong) {
    if (rangePosition > parameter(candidate, "maxRangePosition")) {
      failures.push("LONG_NOT_AT_RANGE_LOWER_EDGE");
    }
  } else if (rangePosition < parameter(candidate, "minRangePosition")) {
    failures.push("SHORT_NOT_AT_RANGE_UPPER_EDGE");
  }

  const stochTurn = isLong
    ? previous.stochK <= previous.stochD && current.stochK > current.stochD
    : previous.stochK >= previous.stochD && current.stochK < current.stochD;
  const rsiTurn = isLong
    ? current.rsiSlope2 > 0 && current.rsiPercentile7d <= parameter(candidate, "maxRsiPercentile")
    : current.rsiSlope2 < 0 && current.rsiPercentile7d >= parameter(candidate, "minRsiPercentile");
  const tolerance = parameter(candidate, "bandTouchToleranceAtr") * current.atr;
  const bandReclaim = isLong
    ? current.low <= current.bbLower + tolerance && current.close > current.bbLower
    : current.high >= current.bbUpper - tolerance && current.close < current.bbUpper;
  const reversalCandle = isLong
    ? current.close > current.open && current.close > previous.close
    : current.close < current.open && current.close < previous.close;
  const breadthTurn = isLong
    ? tactical.breadthVelocity >= parameter(candidate, "minBreadthVelocity") &&
      tactical.localBreadth <= 0.72
    : tactical.breadthVelocity <= parameter(candidate, "maxBreadthVelocity") &&
      tactical.localBreadth >= 0.28;
  const volumeRecovery = current.volumeRatio >= parameter(candidate, "recoveryVolumeRatio");

  const score = Number(stochTurn) + Number(rsiTurn) + Number(bandReclaim) +
    Number(reversalCandle) + Number(breadthTurn || volumeRecovery) +
    Number(tactical.fiveMinuteConfirmed);
  const requiredScore = parameter(candidate, "minConfirmationScore") +
    (tactical.fiveMinuteConfirmed ? 0 : 1);
  if (!stochTurn || score < requiredScore) {
    failures.push(`RANGE_REVERSAL_SCORE_${score}_BELOW_${requiredScore}`);
  }

  if (current.volumeRatio < parameter(candidate, "minVolumeRatio")) {
    failures.push("RANGE_VOLUME_TOO_LOW");
  }
  const maxSwingBreakAtr = parameter(candidate, "maxSwingBreakAtr");
  if (isLong) {
    if (
      current.low < current.low20Prev - maxSwingBreakAtr * current.atr ||
      current.close < current.low8Prev - maxSwingBreakAtr * current.atr
    ) failures.push("STRONG_RANGE_LOW_BREAK_EXCLUDED");
  } else if (
    current.high > current.high20Prev + maxSwingBreakAtr * current.atr ||
    current.close > current.high8Prev + maxSwingBreakAtr * current.atr
  ) failures.push("STRONG_RANGE_HIGH_BREAK_EXCLUDED");

  const target = isLong ? nearestTargetAbove(current) : nearestTargetBelow(current);
  if (target === null) {
    failures.push("NO_REALIZABLE_MEAN_REVERSION_TARGET");
  } else {
    const move = isLong ? target - current.close : current.close - target;
    const moveAtr = move / current.atr;
    const moveBps = move / current.close * 10_000;
    if (
      moveAtr < parameter(candidate, "minTargetAtr") ||
      moveBps < BASE_COST_BPS * parameter(candidate, "costMultiple")
    ) failures.push("TARGET_ROOM_BELOW_ATR_OR_COST_GATE");
  }

  const partialMoveBps = parameter(candidate, "partialTakeAtr") * current.atr / current.close *
    10_000;
  if (partialMoveBps < BASE_COST_BPS * parameter(candidate, "partialCostMultiple")) {
    failures.push("PARTIAL_REALIZATION_BELOW_COST_GATE");
  }

  if (failures.length) return reject(candidate, tactical, failures);
  const stop = isLong
    ? current.close - parameter(candidate, "initialStopAtr") * current.atr
    : current.close + parameter(candidate, "initialStopAtr") * current.atr;
  return accept(
    tactical,
    [
      "STRUCTURAL_RANGE",
      isLong ? "LOWER_EDGE" : "UPPER_EDGE",
      `REVERSAL_SCORE_${score}`,
      tactical.fiveMinuteConfirmed ? "FIVE_MINUTE_CONFIRM" : "FIFTEEN_MINUTE_STRONG_CONFIRM",
      "COST_GATE",
    ],
    stop,
    target ?? undefined,
  );
}

function bearDecision(
  bars: readonly PreparedBar[],
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
): SignalDecision {
  const current = bars[index];
  const completed = bars.slice(Math.max(0, index - 8), index);
  const previous = completed.at(-1);
  if (!previous || completed.length < 6) {
    return reject(candidate, tactical, ["EIGHT_BAR_COMPLETED_SETUP_REQUIRED"]);
  }
  const failures = commonFailures(current, index, candidate, tactical, structural);
  if (candidate.side !== "SHORT" || candidate.family !== "BEAR_REBREAK") {
    failures.push("BEAR_SHORT_FAMILY_REQUIRED");
  }
  if (tactical.phase !== "REBREAK" || tactical.state !== "BEAR_REBREAK") {
    failures.push("BEAR_REBREAK_ONLY_REBOUND_MUST_WAIT");
  }
  if (!(current.ema20 < current.ema50) || current.ema20SlopeAtr >= 0) {
    failures.push("BEAR_EMA_ALIGNMENT_REQUIRED");
  }

  let troughIndex = 0;
  for (let i = 1; i < completed.length; i++) {
    if (completed[i].low < completed[troughIndex].low) troughIndex = i;
  }
  const trough = completed[troughIndex];
  const afterTrough = completed.slice(troughIndex + 1);
  const dropAtr = (completed[0].close - trough.low) / current.atr;
  const reboundPeak = afterTrough.length
    ? Math.max(...afterTrough.map((bar) => bar.high))
    : trough.high;
  const reboundAtr = (reboundPeak - trough.low) / current.atr;
  if (dropAtr < parameter(candidate, "minDropAtr")) failures.push("PRIOR_DROP_REQUIRED");
  if (afterTrough.length < 2 || reboundAtr < parameter(candidate, "minReboundAtr")) {
    failures.push("COMPLETED_REBOUND_REQUIRED");
  }

  const retestTolerance = parameter(candidate, "retestToleranceAtr") * current.atr;
  const breakdownLevel = trough.low8Prev;
  const touched = (bar: PreparedBar, level: number) =>
    finite(level) && bar.high >= level - retestTolerance && bar.low <= level + retestTolerance;
  const retested = afterTrough.some((bar) =>
    touched(bar, bar.ema20) || touched(bar, bar.vwap96) || touched(bar, breakdownLevel)
  );
  if (!retested) failures.push("EMA_VWAP_OR_BREAKDOWN_RETEST_REQUIRED");

  const stochRolled = (previous.stochK >= previous.stochD && current.stochK < current.stochD) ||
    (current.stochK < current.stochD && current.stochK < previous.stochK);
  if (!stochRolled || current.rsiSlope2 >= 0) failures.push("OSCILLATOR_ROLLOVER_REQUIRED");
  if (current.close >= current.open || current.close >= previous.close) {
    failures.push("BEARISH_FAILURE_CANDLE_REQUIRED");
  }
  const bullishImpulseBars = afterTrough.filter((bar) =>
    bar.close > bar.open && bar.volumeRatio >= parameter(candidate, "minVolumeRatio")
  );
  const lastBullishImpulse = bullishImpulseBars.at(-1)?.volumeRatio ?? Number.POSITIVE_INFINITY;
  const priorBullishPeak = bullishImpulseBars.length >= 2
    ? Math.max(...bullishImpulseBars.slice(0, -1).map((bar) => bar.volumeRatio))
    : Number.NEGATIVE_INFINITY;
  const buyingImpulseFaded = bullishImpulseBars.length >= 2 &&
    lastBullishImpulse < priorBullishPeak;
  if (!buyingImpulseFaded || current.volumeRatio < parameter(candidate, "minVolumeRatio")) {
    failures.push("BUYING_IMPULSE_FADE_AND_SELL_VOLUME_REQUIRED");
  }

  const brokenLevels = [current.low8Prev, current.low20Prev]
    .filter((level) => finite(level) && current.close < level);
  const rebreakAtr = brokenLevels.length
    ? Math.max(...brokenLevels.map((level) => (level - current.close) / current.atr))
    : Number.NEGATIVE_INFINITY;
  if (rebreakAtr < parameter(candidate, "minRebreakAtr")) {
    failures.push("COMPLETED_PRIOR_LOW_OR_DONCHIAN_REBREAK_REQUIRED");
  }
  if (current.close >= current.ema20) failures.push("REBREAK_MUST_CLOSE_BELOW_EMA20");
  const emaDistanceAtr = (current.ema20 - current.close) / current.atr;
  if (emaDistanceAtr > parameter(candidate, "maxEmaDistanceAtr")) {
    failures.push("SHORT_CHASE_DISTANCE_EXCEEDED");
  }

  const breadthDeterioration = parameter(candidate, "minBreadthDeterioration");
  if (
    tactical.breadthVelocity > -breadthDeterioration ||
    structural.breadthVelocity > 0 ||
    structural.negativeBreadth6h <= structural.positiveBreadth6h
  ) failures.push("BREADTH_REDETERIORATION_REQUIRED");

  const expectedTargetBps = parameter(candidate, "targetR") *
    parameter(candidate, "initialStopAtr") *
    current.atr / current.close * 10_000;
  if (expectedTargetBps < BASE_COST_BPS * parameter(candidate, "costMultiple")) {
    failures.push("BEAR_TARGET_BELOW_COST_GATE");
  }

  if (failures.length) return reject(candidate, tactical, failures);
  const risk = parameter(candidate, "initialStopAtr") * current.atr;
  return accept(
    tactical,
    ["STRUCTURAL_BEAR", "COMPLETED_REBOUND", "RETEST", "REBREAK", "BREADTH_REDETERIORATION"],
    current.close + risk,
    current.close - parameter(candidate, "targetR") * risk,
  );
}

/**
 * Pure, causal entry evaluator.  It may read bar `index` after that bar has
 * closed and bars `< index`; it never reads `index + 1` or any future context.
 * The simulator must therefore place the earliest fill at `index + 1` open.
 */
export function signalDecision(
  bars: readonly PreparedBar[],
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
): SignalDecision {
  if (!Number.isInteger(index) || index < 0 || index >= bars.length) {
    return reject(candidate, tactical, ["INVALID_SIGNAL_INDEX"]);
  }
  const current = bars[index];
  if (
    candidate.family === "DONCHIAN_BREAKOUT" ||
    candidate.family === "MOMENTUM_ACCELERATION" ||
    candidate.family === "COMPRESSION_BREAKOUT"
  ) return bullDecision(bars, index, candidate, tactical, structural);
  if (candidate.family === "RANGE_CYCLE") {
    return rangeDecision(bars, index, candidate, tactical, structural);
  }
  return bearDecision(bars, index, candidate, tactical, structural);
}
