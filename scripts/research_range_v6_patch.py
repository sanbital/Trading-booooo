from pathlib import Path
import re

ROOT = Path('supabase/functions/regime-router-v5-research')

def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {text.count(old)}')
    return text.replace(old, new, 1)

def sub_once(text: str, pattern: str, replacement: str, label: str) -> str:
    out, n = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, got {n}')
    return out

# ---- types.ts ----
p = ROOT / 'types.ts'
s = p.read_text()
s = replace_once(
    s,
    'export const V5_REVISION = "REGIME_ROUTER_V5_STRUCTURAL_TACTICAL_RANGE_EXIT_V2_15M_120D_RSWF";',
    'export const V5_REVISION = "REGIME_ROUTER_V6_RANGE_EDGE_SCORE_15M_120D_RSWF";',
    'types revision',
)
s = replace_once(s, '  | "UP_CYCLE"\n  | "REBOUND"', '  | "UP_CYCLE"\n  | "DOWN_CYCLE"\n  | "REBOUND"', 'down tactical phase')
s = replace_once(s, '  | "RANGE_UP_CYCLE"\n  | "BEAR_REBOUND"', '  | "RANGE_UP_CYCLE"\n  | "RANGE_DOWN_CYCLE"\n  | "BEAR_REBOUND"', 'down router state')
p.write_text(s)

# ---- tactical.ts ----
p = ROOT / 'tactical.ts'
s = p.read_text()
s = replace_once(
    s,
    '  if (structural === "RANGE" && phase === "UP_CYCLE") return "RANGE_UP_CYCLE";\n',
    '  if (structural === "RANGE" && phase === "UP_CYCLE") return "RANGE_UP_CYCLE";\n  if (structural === "RANGE" && phase === "DOWN_CYCLE") return "RANGE_DOWN_CYCLE";\n',
    'range down state map',
)
s = replace_once(
    s,
    '    case "UP_CYCLE":\n      return point.rsiSlope > 0 && point.stochK > point.stochD && point.ret3Atr >= 0;\n',
    '    case "UP_CYCLE":\n      return point.rsiSlope > 0 && point.stochK > point.stochD && point.ret3Atr >= 0;\n    case "DOWN_CYCLE":\n      return point.rsiSlope < 0 && point.stochK < point.stochD && point.ret3Atr <= 0;\n',
    'range down 5m support',
)
new_classify_range = r'''function classifyRange(
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
'''
s = sub_once(s, r'function classifyRange\(.*?\n\}\n\nfunction classifyBear', new_classify_range + '\nfunction classifyBear', 'classifyRange')
p.write_text(s)

# ---- strategies.ts ----
p = ROOT / 'strategies.ts'
s = p.read_text()
s = replace_once(
    s,
    '  "V5_PRECOMMITTED_NEIGHBOURHOOD_20260829_RANGE_EXIT_V2_A";',
    '  "V6_PRECOMMITTED_RANGE_EDGE_SCORE_20260829_A";',
    'registry revision',
)
new_range_exit = '''const RANGE_EXIT = {
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
'''
s = sub_once(s, r'const RANGE_EXIT = \{.*?\n\};\n\nconst BEAR_EXIT', new_range_exit + '\nconst BEAR_EXIT', 'range exit block')
new_range_base = '''const RANGE_BASE = {
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
'''
s = sub_once(s, r'const RANGE_BASE = \{.*?\n\};\n\nconst BEAR_BASE', new_range_base + '\nconst BEAR_BASE', 'range base block')
start = s.index('  ...[0.12, 0.15, 0.18].map((maxStochPercentile) =>')
end = s.index('  ...[0, 0.05, 0.1].map((minRebreakAtr) =>', start)
new_grid = '''  ...[0.20, 0.25, 0.30].map((maxRangePosition) =>
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
'''
s = s[:start] + new_grid + s[end:]
s = replace_once(
    s,
    '  if (expected !== "BULL" && !tactical.fiveMinuteConfirmed) {\n    failures.push("FIVE_MINUTE_CONFIRMATION_REQUIRED");\n  }',
    '  if (expected === "BEAR" && !tactical.fiveMinuteConfirmed) {\n    failures.push("FIVE_MINUTE_CONFIRMATION_REQUIRED");\n  }',
    'range 5m softening',
)
s = replace_once(
    s,
    '''function nearestTargetAbove(current: PreparedBar): number | null {
  const anchors = [current.vwap96, current.dayOpen, current.bbMid, current.rangeMid20Prev]
    .filter((value) => finite(value) && value > current.close)
    .sort((a, b) => a - b);
  return anchors[0] ?? null;
}
''',
    '''function nearestTargetAbove(current: PreparedBar): number | null {
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
''',
    'nearest lower target',
)
new_range_decision = r'''function rangeDecision(
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
  if (!(rangeWidth > 0) || rangeWidthAtr < parameter(candidate, "minRangeWidthAtr") ||
      rangeWidthAtr > parameter(candidate, "maxRangeWidthAtr")) {
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
    ? tactical.breadthVelocity >= parameter(candidate, "minBreadthVelocity") && tactical.localBreadth <= 0.72
    : tactical.breadthVelocity <= parameter(candidate, "maxBreadthVelocity") && tactical.localBreadth >= 0.28;
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

  const partialMoveBps = parameter(candidate, "partialTakeAtr") * current.atr / current.close * 10_000;
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
'''
s = sub_once(s, r'function rangeDecision\(.*?\n\}\n\nfunction bearDecision', new_range_decision + '\nfunction bearDecision', 'rangeDecision')
p.write_text(s)

# ---- simulator.ts ----
p = ROOT / 'simulator.ts'
s = p.read_text()
s = replace_once(
    s,
    '''  if (input.candidate.family === "BEAR_REBREAK" && input.candidate.side !== "SHORT") {
    throw new Error("BEAR_REBREAK candidates must be SHORT");
  }
  if (input.candidate.family !== "BEAR_REBREAK" && input.candidate.side !== "LONG") {
    throw new Error("BULL and RANGE candidates must be LONG");
  }
''',
    '''  if (input.candidate.family === "BEAR_REBREAK" && input.candidate.side !== "SHORT") {
    throw new Error("BEAR_REBREAK candidates must be SHORT");
  }
  if (
    input.candidate.family !== "BEAR_REBREAK" && input.candidate.family !== "RANGE_CYCLE" &&
    input.candidate.side !== "LONG"
  ) {
    throw new Error("BULL candidates must be LONG");
  }
''',
    'simulator side invariant',
)
s = replace_once(
    s,
    '''  if (candidate.family === "RANGE_CYCLE") {
    if (r >= finite(p.profitLockAtR, 0.55)) {
      stop = Math.max(stop, entry + finite(p.profitLockR, 0.08) * risk);
    }
    return stop;
  }
''',
    '''  if (candidate.family === "RANGE_CYCLE") {
    if (r >= finite(p.profitLockAtR, 0.55)) {
      stop = candidate.side === "LONG"
        ? Math.max(stop, entry + finite(p.profitLockR, 0.08) * risk)
        : Math.min(stop, entry - finite(p.profitLockR, 0.08) * risk);
    }
    return stop;
  }
''',
    'range stop symmetry',
)
s = replace_once(
    s,
    '''  if (candidate.family === "RANGE_CYCLE") {
    if (tactical.structural !== "RANGE") return "REGIME_EXIT";
    // UP_CYCLE is a cross event, not a state that must repeat every bar. A
    // subsequent NEUTRAL bar therefore remains held; only an observed rollover
    // (or deceleration if a classifier emits it) closes the cycle early.
    return tactical.phase === "ROLL_OVER" || tactical.phase === "DECELERATING"
      ? "CYCLE_EXIT"
      : null;
  }
''',
    '''  if (candidate.family === "RANGE_CYCLE") {
    if (tactical.structural !== "RANGE") return "REGIME_EXIT";
    if (candidate.side === "LONG") {
      return tactical.phase === "ROLL_OVER" || tactical.phase === "DOWN_CYCLE" ||
          tactical.phase === "DECELERATING"
        ? "CYCLE_EXIT"
        : null;
    }
    return tactical.phase === "UP_CYCLE" || tactical.phase === "REBOUND"
      ? "CYCLE_EXIT"
      : null;
  }
''',
    'range exit symmetry',
)
s = replace_once(
    s,
    '''  if (candidate.family === "RANGE_CYCLE") {
    // A next-open gap through the mean-reversion anchor destroys the location
    // edge. Do not silently replace that anchor with a newly invented 1R target.
    return Number.isFinite(hinted) && hinted > entry ? hinted : null;
  }
''',
    '''  if (candidate.family === "RANGE_CYCLE") {
    // A next-open gap through the mean-reversion anchor destroys the location edge.
    if (!Number.isFinite(hinted)) return null;
    return candidate.side === "LONG" ? (hinted > entry ? hinted : null) : (hinted < entry ? hinted : null);
  }
''',
    'range target symmetry',
)
new_range_sim = r'''function simulateRangeExitV2(
  input: SimulationInput,
  signalIndex: number,
  split: TradeSplit,
  decision: SignalDecision,
  tacticalAt: (index: number) => TacticalContext,
  policy: HoldingPolicy,
  baseCostBps: number,
  stressCostBps: number,
  entryIndex: number,
  entry: number,
  signalAtr: number,
  target: number,
  initialStop: number,
): SimulatedTrade | null {
  const bars = input.bars;
  const candidate = input.candidate;
  const p = candidate.parameters;
  const isLong = candidate.side === "LONG";
  const partialTakeAtr = Math.max(0.05, finite(p.partialTakeAtr, 0.25));
  const partialFraction = Math.max(0.05, Math.min(0.95, finite(p.partialTakeFraction, 0.70)));
  const noResponseBars = boundedInteger(p.noResponseBars, 2, 1, policy.maxHoldBars);
  const breakBuffer = Math.max(0, finite(p.rangeBreakBufferAtr, 0.10));
  const partialTarget = isLong
    ? entry + partialTakeAtr * signalAtr
    : entry - partialTakeAtr * signalAtr;
  if (isLong ? !(partialTarget > entry && partialTarget < target) : !(partialTarget < entry && partialTarget > target)) {
    return null;
  }

  let stop = initialStop;
  let best = entry;
  let worst = entry;
  let pendingReason: string | null = null;
  let partialTaken = false;
  let remainingFraction = 1;
  let realizedGrossBps = 0;

  const includePoint = (price: number) => {
    if (isLong) {
      best = Math.max(best, price);
      worst = Math.min(worst, price);
    } else {
      best = Math.min(best, price);
      worst = Math.max(worst, price);
    }
  };

  const grossAt = (price: number) => isLong
    ? (price / entry - 1) * 10_000
    : (entry - price) / entry * 10_000;

  const takePartial = () => {
    if (partialTaken) return;
    includePoint(partialTarget);
    const partialGrossBps = grossAt(partialTarget);
    realizedGrossBps += partialFraction * partialGrossBps;
    remainingFraction = 1 - partialFraction;
    partialTaken = true;
    if (finite(p.portfolioBreakEvenAfterPartial, 1) > 0 && remainingFraction > 0) {
      const requiredResidualGrossBps = Math.max(0, (baseCostBps - realizedGrossBps) / remainingFraction);
      const protected = isLong
        ? entry * (1 + requiredResidualGrossBps / 10_000)
        : entry * (1 - requiredResidualGrossBps / 10_000);
      stop = isLong ? Math.max(stop, protected) : Math.min(stop, protected);
    }
  };

  const finish = (exitIndex: number, exit: number, reason: string, atOpen: boolean): SimulatedTrade => {
    includePoint(exit);
    const residualGrossBps = grossAt(exit);
    const grossBps = realizedGrossBps + remainingFraction * residualGrossBps;
    const netBps = grossBps - baseCostBps;
    const stressNetBps = grossBps - stressCostBps;
    const mfeBps = isLong
      ? Math.max(0, (best / entry - 1) * 10_000)
      : Math.max(0, (entry - best) / entry * 10_000);
    const maeBps = isLong
      ? Math.max(0, (1 - worst / entry) * 10_000)
      : Math.max(0, (worst / entry - 1) * 10_000);
    const holdBars = Math.max(1, exitIndex - entryIndex + (atOpen ? 0 : 1));
    return {
      exitIndex,
      trade: {
        market: input.market,
        candidate: candidate.name,
        family: candidate.family,
        state: decision.state,
        fold: input.fold.id,
        split,
        side: candidate.side,
        signalTime: bars[signalIndex].time,
        entryTime: bars[entryIndex].time,
        exitTime: bars[exitIndex].time,
        grossBps,
        netBps,
        stressNetBps,
        mfeBps,
        maeBps,
        mfeCapture: mfeBps > 1e-9 ? netBps / mfeBps : null,
        givebackBps: Math.max(0, mfeBps - netBps),
        holdBars,
        exitReason: reason,
      },
    };
  };

  for (let j = entryIndex; j <= entryIndex + policy.maxHoldBars; j++) {
    const bar = bars[j];
    if (!bar) return null;
    if (pendingReason) return finish(j, bar.open, pendingReason, true);

    const stopGap = isLong ? bar.open <= stop : bar.open >= stop;
    if (stopGap) return finish(j, bar.open, "STOP_GAP", true);
    const targetGap = isLong ? bar.open >= target : bar.open <= target;
    const partialGap = isLong ? bar.open >= partialTarget : bar.open <= partialTarget;
    if (!partialTaken && targetGap) {
      takePartial();
      return finish(j, target, "TARGET", true);
    }
    if (!partialTaken && partialGap) takePartial();
    if (partialTaken && targetGap) return finish(j, target, "TARGET", true);
    includePoint(bar.open);

    const stopTouched = isLong ? bar.low <= stop : bar.high >= stop;
    if (stopTouched) return finish(j, stop, "STOP", false);

    const partialTouched = isLong ? bar.high >= partialTarget : bar.low <= partialTarget;
    if (!partialTaken && partialTouched) {
      takePartial();
      const protectedStopTouched = isLong ? bar.low <= stop : bar.high >= stop;
      if (protectedStopTouched) return finish(j, stop, "STOP", false);
      const targetTouchedAfterPartial = isLong ? bar.high >= target : bar.low <= target;
      if (targetTouchedAfterPartial) return finish(j, target, "TARGET", false);
    } else if (partialTaken) {
      const targetTouched = isLong ? bar.high >= target : bar.low <= target;
      if (targetTouched) return finish(j, target, "TARGET", false);
    }
    includePoint(bar.high);
    includePoint(bar.low);

    const rangeBroken = isLong
      ? Number.isFinite(bar.low20Prev) && bar.close < bar.low20Prev - breakBuffer * bar.atr
      : Number.isFinite(bar.high20Prev) && bar.close > bar.high20Prev + breakBuffer * bar.atr;
    pendingReason = rangeBroken ? "RANGE_BREAK_EXIT" : closeGeneratedExit(candidate, tacticalAt(j), bar);
    const heldBars = j - entryIndex + 1;
    if (!pendingReason && !partialTaken && heldBars >= noResponseBars) pendingReason = "TIME_STOP";
    if (!pendingReason && heldBars >= policy.maxHoldBars) pendingReason = "MAX_HOLD";
  }
  return null;
}
'''
s = sub_once(s, r'function simulateRangeExitV2\(.*?\n\}\n\nfunction simulateOne', new_range_sim + '\nfunction simulateOne', 'range simulator')
s = replace_once(
    s,
    '''  if (candidate.family === "RANGE_CYCLE") {
    const targetRoom = target! - entry;
    const targetBps = (target! / entry - 1) * 10_000;
    if (
      targetRoom < finite(candidate.parameters.minTargetAtr, 0.75) * signalAtr ||
      targetBps < baseCostBps * finite(candidate.parameters.costMultiple, 4)
    ) return null;
''',
    '''  if (candidate.family === "RANGE_CYCLE") {
    const targetRoom = candidate.side === "LONG" ? target! - entry : entry - target!;
    const targetBps = targetRoom / entry * 10_000;
    if (
      targetRoom < finite(candidate.parameters.minTargetAtr, 0.75) * signalAtr ||
      targetBps < baseCostBps * finite(candidate.parameters.costMultiple, 4)
    ) return null;
''',
    'range next-open target room symmetry',
)
p.write_text(s)

print('RANGE V6 patch prepared')
