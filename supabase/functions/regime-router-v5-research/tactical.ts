import {
  BAR_MS,
  FIVE_MINUTE_MS,
  type FiveMinutePoint,
  type PreparedBar,
  type RouterState,
  type StructuralRegime,
  type TacticalContext,
  type TacticalPhase,
} from "./types.ts";

export interface TacticalInput {
  bars: readonly PreparedBar[];
  index: number;
  structural: StructuralRegime;
  /** Current completed 30-minute positive breadth, expressed as [0, 1]. */
  localBreadth: number;
  /** Causal change in local breadth versus its prior completed observation. */
  breadthVelocity: number;
  /** Optional real five-minute observation. No 5m proxy is derived when absent. */
  fiveMinute?: FiveMinutePoint | null;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/** Maps direction-independent tactical timing into the five explicit router states. */
export function mapRouterState(structural: StructuralRegime, phase: TacticalPhase): RouterState {
  if (structural === "BULL" && phase === "ACCELERATING") return "BULL_TREND";
  if (structural === "BULL" && phase === "DECELERATING") return "BULL_DECELERATING";
  if (structural === "RANGE" && phase === "UP_CYCLE") return "RANGE_UP_CYCLE";
  if (structural === "RANGE" && phase === "DOWN_CYCLE") return "RANGE_DOWN_CYCLE";
  if (structural === "BEAR" && phase === "REBOUND") return "BEAR_REBOUND";
  if (structural === "BEAR" && phase === "REBREAK") return "BEAR_REBREAK";
  return "NO_TRADE";
}

function isCausalFiveMinute(point: FiveMinutePoint | null | undefined, bar: PreparedBar): boolean {
  if (!point || !finite(point.time)) return false;
  // Both timestamps use Binance kline open time. The last causal child of a completed
  // 15m bar opens at +10m; +15m already belongs to the next (unknown) bar.
  return point.time >= bar.time && point.time <= bar.time + BAR_MS - FIVE_MINUTE_MS;
}

function fiveMinuteSupports(phase: TacticalPhase, point: FiveMinutePoint): boolean {
  switch (phase) {
    case "ACCELERATING":
      return point.ret3Atr > 0 && point.rsiSlope > 0 && point.ema20SlopeAtr >= 0 &&
        (point.breakout || point.volumeRatio >= 1);
    case "DECELERATING":
      return point.rsiSlope < 0 && point.stochK < point.stochD;
    case "UP_CYCLE":
      return point.rsiSlope > 0 && point.stochK > point.stochD && point.ret3Atr >= 0;
    case "DOWN_CYCLE":
      return point.rsiSlope < 0 && point.stochK < point.stochD && point.ret3Atr <= 0;
    case "REBOUND":
      return point.ret3Atr > 0 && point.rsiSlope > 0 && point.stochK >= point.stochD;
    case "ROLL_OVER":
      return point.rsiSlope < 0 && point.stochK < point.stochD;
    case "REBREAK":
      return point.rebreak && point.ret3Atr < 0 && point.rsiSlope < 0 &&
        point.stochK < point.stochD;
    case "EXTENDED":
      return point.stochK >= 80 || point.ret3Atr >= 0.8;
    case "PULLBACK":
      return point.ret3Atr < 0;
    case "NEUTRAL":
      return false;
  }
}

function neutral(input: TacticalInput, reasons: string[]): TacticalContext {
  return {
    phase: "NEUTRAL",
    state: "NO_TRADE",
    structural: input.structural,
    localBreadth: input.localBreadth,
    breadthVelocity: input.breadthVelocity,
    fiveMinuteConfirmed: false,
    reasons,
  };
}

function classifyBull(
  current: PreparedBar,
  previous: PreparedBar,
  breadthVelocity: number,
  reasons: string[],
): TacticalPhase {
  const atr = current.atr;
  // ret4 was calculated at this completed bar from its completed i-4 close.
  const momentum4Atr = atr > 0 && finite(current.ret4) && current.ret4 > -1
    ? (current.close - current.close / (1 + current.ret4)) / atr
    : 0;
  const stochRollover = previous.stochK >= previous.stochD && current.stochK < current.stochD;
  const momentumFading = current.rsiSlope2 < 0 || current.ret2 < 0 || current.ema20SlopeAtr <= 0;

  if (
    (breadthVelocity <= -0.025 && momentumFading) ||
    (stochRollover && current.rsiSlope2 < 0 && current.volumeRatio < previous.volumeRatio)
  ) {
    reasons.push("bull breadth or momentum is decelerating");
    return "DECELERATING";
  }

  const distanceFromEmaAtr = atr > 0 ? (current.close - current.ema20) / atr : Infinity;
  if (
    current.stochPercentile7d >= 0.85 || current.rsiPercentile7d >= 0.90 ||
    distanceFromEmaAtr >= 1.8
  ) {
    reasons.push("bull move is extended; suppress chase");
    return "EXTENDED";
  }

  const trendAligned = current.close > current.ema20 && current.ema20 > current.ema50 &&
    current.ema20SlopeAtr > 0;
  const momentumAligned = momentum4Atr >= 0.35 && current.rsiSlope2 > 0 &&
    current.volumeRatio >= 0.85;
  if (trendAligned && momentumAligned && breadthVelocity >= -0.01) {
    reasons.push("bull trend and tactical acceleration align");
    return "ACCELERATING";
  }

  if (
    current.close <= current.ema20 && current.close > current.ema50 &&
    current.ema20SlopeAtr >= 0
  ) {
    reasons.push("bull structure remains intact during pullback");
    return "PULLBACK";
  }

  reasons.push("bull structure has no actionable tactical timing");
  return "NEUTRAL";
}

function classifyRange(
  current: PreparedBar,
  previous: PreparedBar,
  localBreadth: number,
  breadthVelocity: number,
  reasons: string[],
): TacticalPhase {
  const emaSeparationAtr = current.atr > 0
    ? Math.abs(current.ema20 - current.ema50) / current.atr
    : Number.POSITIVE_INFINITY;
  const trendless = current.adx <= 25 && emaSeparationAtr <= 0.90;

  const stochasticCrossUp = previous.stochK <= previous.stochD && current.stochK > current.stochD;
  const lowerWashout = previous.stochPercentile7d <= 0.25 || current.stochPercentile7d <= 0.30;
  const belowMean = current.close < current.vwap96 || current.close < current.dayOpen ||
    current.close < current.rangeMid20Prev;
  const cycleUp = current.rsiSlope2 > 0 && current.close > current.open &&
    current.close > previous.close && breadthVelocity >= -0.005;
  const lowerNotBroken = !finite(current.low20Prev) ||
    current.close >= current.low20Prev - 0.12 * current.atr;

  if (
    trendless && stochasticCrossUp && lowerWashout && belowMean && cycleUp && lowerNotBroken &&
    localBreadth <= 0.78
  ) {
    reasons.push("range lower-side cycle turned upward; candidate scoring decides admission");
    return "UP_CYCLE";
  }

  const stochasticCrossDown = previous.stochK >= previous.stochD && current.stochK < current.stochD;
  const upperWashout = previous.stochPercentile7d >= 0.75 || current.stochPercentile7d >= 0.70;
  const aboveMean = current.close > current.vwap96 || current.close > current.dayOpen ||
    current.close > current.rangeMid20Prev;
  const cycleDown = current.rsiSlope2 < 0 && current.close < current.open &&
    current.close < previous.close && breadthVelocity <= 0.005;
  const upperNotBroken = !finite(current.high20Prev) ||
    current.close <= current.high20Prev + 0.12 * current.atr;

  if (
    trendless && stochasticCrossDown && upperWashout && aboveMean && cycleDown && upperNotBroken &&
    localBreadth >= 0.22
  ) {
    reasons.push("range upper-side cycle turned downward; candidate scoring decides admission");
    return "DOWN_CYCLE";
  }

  const rollOver = stochasticCrossDown && current.rsiSlope2 <= 0;
  if (rollOver) {
    reasons.push("range cycle rolled over");
    return "ROLL_OVER";
  }

  const breadthDecelerating = breadthVelocity <= 0 && current.rsiSlope2 <= 0 &&
    current.stochK < previous.stochK;
  if (breadthDecelerating) {
    reasons.push("range breadth and oscillator velocity are decelerating");
    return "DECELERATING";
  }

  reasons.push("range has no causal edge-cycle timing");
  return "NEUTRAL";
}

function classifyBear(
  current: PreparedBar,
  previous: PreparedBar,
  breadthVelocity: number,
  reasons: string[],
): TacticalPhase {
  const atr = current.atr;
  const trendDown = current.ema20 < current.ema50 && current.ema20SlopeAtr < 0;

  // The immediately completed bar must itself show a rebound from the completed
  // 8-bar low. An old high in the rolling window is not accepted as a retest.
  const reboundSizeAtr = atr > 0 ? (previous.high - current.low8Prev) / atr : 0;
  const precedingRebound = previous.close > previous.open &&
    previous.close >= current.low8Prev + 0.20 * atr;
  // A completed rebound bar is compared with indicator levels that existed on
  // that same bar, never with levels first known on the current failure bar.
  const touchedEma = previous.high >= previous.ema20 - 0.35 * atr;
  const touchedVwap = previous.high >= previous.vwap96 - 0.35 * atr;
  const stochRollover = previous.stochK >= previous.stochD && current.stochK < current.stochD;
  const failure = current.close < current.open && current.close < previous.close &&
    current.rsiSlope2 < 0 && stochRollover;
  // low8Prev is formed from bars ending at i-1; current high/low is never part of confirmation.
  const confirmedRebreak = finite(current.low8Prev) && current.close < current.low8Prev &&
    current.close < previous.low;

  if (
    trendDown && precedingRebound && reboundSizeAtr >= 0.45 && (touchedEma || touchedVwap) &&
    failure &&
    confirmedRebreak && breadthVelocity <= -0.02
  ) {
    reasons.push("bear rebound failed and a completed prior low was rebroken");
    return "REBREAK";
  }

  const declineHigh = current.high8Prev;
  const recentLow = current.low8Prev;
  const priorDeclineAtr = atr > 0 ? (declineHigh - recentLow) / atr : 0;
  const reboundFromLowAtr = atr > 0 ? (current.close - recentLow) / atr : 0;
  const risingCycle = current.close > previous.close && current.rsiSlope2 > 0 &&
    current.stochK >= current.stochD;
  const returningTowardMean = current.close < current.ema20 &&
    (Math.min(Math.abs(current.close - current.ema20), Math.abs(current.close - current.vwap96)) <=
      1.2 * atr);

  if (
    trendDown && priorDeclineAtr >= 0.65 && reboundFromLowAtr >= 0.20 && risingCycle &&
    returningTowardMean
  ) {
    reasons.push("bear decline is rebounding toward EMA/VWAP; short is prohibited");
    return "REBOUND";
  }

  if (trendDown && failure) {
    reasons.push("bear momentum rolled over without a completed-low rebreak");
    return "ROLL_OVER";
  }

  reasons.push("bear structure has neither a rebound nor confirmed rebreak");
  return "NEUTRAL";
}

/**
 * Classifies timing only. `structural` is supplied by the independent 6h/24h
 * classifier and is never inferred from these 15m bars.
 */
export function classifyTactical(input: TacticalInput): TacticalContext;
export function classifyTactical(
  structural: StructuralRegime,
  current: PreparedBar,
  previous: PreparedBar,
  localBreadth: number,
  breadthVelocity: number,
  fiveMinute?: FiveMinutePoint | null,
): TacticalContext;
export function classifyTactical(
  inputOrStructural: TacticalInput | StructuralRegime,
  currentArgument?: PreparedBar,
  previousArgument?: PreparedBar,
  localBreadthArgument?: number,
  breadthVelocityArgument?: number,
  fiveMinuteArgument?: FiveMinutePoint | null,
): TacticalContext {
  const input: TacticalInput = typeof inputOrStructural === "string"
    ? {
      structural: inputOrStructural,
      bars: previousArgument && currentArgument ? [previousArgument, currentArgument] : [],
      index: 1,
      localBreadth: localBreadthArgument ?? Number.NaN,
      breadthVelocity: breadthVelocityArgument ?? Number.NaN,
      fiveMinute: fiveMinuteArgument,
    }
    : inputOrStructural;
  const { bars, index, structural, localBreadth, breadthVelocity } = input;
  if (!Number.isInteger(index) || index < 1 || index >= bars.length) {
    return neutral(input, ["insufficient completed tactical history"]);
  }
  if (!finite(localBreadth) || !finite(breadthVelocity)) {
    return neutral(input, ["missing completed local breadth"]);
  }

  const current = bars[index];
  if (
    !(current.atr > 0) || !finite(current.rsi) || !finite(current.stochK) ||
    !finite(current.stochD) || !finite(current.ema20) || !finite(current.ema50)
  ) {
    return neutral(input, ["invalid tactical indicators"]);
  }

  const reasons: string[] = [];
  let phase: TacticalPhase;
  const previous = bars[index - 1];
  if (structural === "BULL") {
    phase = classifyBull(current, previous, breadthVelocity, reasons);
  } else if (structural === "RANGE") {
    phase = classifyRange(current, previous, localBreadth, breadthVelocity, reasons);
  } else if (structural === "BEAR") {
    phase = classifyBear(current, previous, breadthVelocity, reasons);
  } else {
    return neutral(input, ["structural regime is unknown"]);
  }

  const causalFiveMinute = isCausalFiveMinute(input.fiveMinute, current) ? input.fiveMinute! : null;
  const fiveMinuteConfirmed = causalFiveMinute
    ? fiveMinuteSupports(phase, causalFiveMinute)
    : false;
  if (input.fiveMinute && !causalFiveMinute) {
    reasons.push("non-causal or stale 5m observation ignored");
  } else if (!input.fiveMinute) reasons.push("5m observation unavailable; no proxy fabricated");
  else if (fiveMinuteConfirmed) reasons.push("actual completed 5m observation confirms phase");
  else reasons.push("actual completed 5m observation does not confirm phase");

  return {
    phase,
    state: mapRouterState(structural, phase),
    structural,
    localBreadth,
    breadthVelocity,
    fiveMinuteConfirmed,
    reasons,
  };
}

export const classifyTacticalPhase = classifyTactical;
