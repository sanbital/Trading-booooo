import { signalDecision } from "./strategies.ts";
import { classifyTactical, type TacticalInput } from "./tactical.ts";
import { splitForFold } from "./folds.ts";
import {
  BASE_COST_BPS,
  type Candidate,
  type FiveMinutePoint,
  type FoldDefinition,
  type FoldSplit,
  type PreparedBar,
  type SignalDecision,
  STRESS_COST_BPS,
  type StructuralPoint,
  type TacticalContext,
  type V5Trade,
} from "./types.ts";

type TradeSplit = V5Trade["split"];

export type SignalEvaluator = (
  bars: readonly PreparedBar[],
  index: number,
  candidate: Candidate,
  tactical: TacticalContext,
  structural: StructuralPoint,
) => SignalDecision;

export interface SimulationDependencies {
  classifyTactical?: (input: TacticalInput) => TacticalContext;
  signalEvaluator?: SignalEvaluator;
}

export interface SimulationInput {
  market: string;
  bars: readonly PreparedBar[];
  /** Structural points must be aligned one-for-one with `bars` by timestamp. */
  structural: readonly StructuralPoint[];
  /** Completed 30m breadth aligned with `bars`; required by the default classifier. */
  localBreadth?: readonly number[];
  /** Causal 30m breadth change aligned with `bars`; required by the default classifier. */
  localBreadthVelocity?: readonly number[];
  /** Last completed causal 5m child observation; required by the default classifier. */
  fiveMinute?: readonly (FiveMinutePoint | null)[];
  candidate: Candidate;
  fold: FoldDefinition;
  baseCostBps?: number;
  stressCostBps?: number;
}

interface HoldingPolicy {
  initialStopAtr: number;
  maxHoldBars: number;
  targetR: number | null;
  timeStopBars: number | null;
  minMfeAtTimeStopR: number;
}

interface SimulatedTrade {
  trade: V5Trade;
  exitIndex: number;
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.round(finite(value, fallback))));
}

function isTradeSplit(split: FoldSplit): split is TradeSplit {
  return split === "TRAIN" || split === "VALIDATION" || split === "TEST";
}

/** Fold intervals are half-open and explicit gaps are labelled EMBARGO. */
export function foldSplitAt(time: number, fold: FoldDefinition): FoldSplit {
  return splitForFold(time, fold);
}

function policyFor(candidate: Candidate): HoldingPolicy {
  const p = candidate.parameters;
  if (candidate.family === "RANGE_CYCLE") {
    return {
      initialStopAtr: Math.max(0.10, finite(p.initialStopAtr, 0.80)),
      maxHoldBars: boundedInteger(p.maxHoldBars, 4, 1, 4),
      targetR: null,
      timeStopBars: null,
      minMfeAtTimeStopR: 0,
    };
  }
  if (candidate.family === "BEAR_REBREAK") {
    const maxHoldBars = boundedInteger(p.maxHoldBars, 4, 2, 4);
    return {
      initialStopAtr: Math.max(0.10, finite(p.initialStopAtr, 0.70)),
      maxHoldBars,
      targetR: Math.max(0.10, finite(p.targetR, 0.70)),
      timeStopBars: boundedInteger(p.timeStopBars, 2, 2, maxHoldBars),
      minMfeAtTimeStopR: Math.max(0, finite(p.minMfeAtTimeStopR, 0.20)),
    };
  }
  return {
    initialStopAtr: Math.max(0.10, finite(p.initialStopAtr, 1.40)),
    maxHoldBars: boundedInteger(p.maxHoldBars, 64, 5, 192),
    targetR: null,
    timeStopBars: null,
    minMfeAtTimeStopR: 0,
  };
}

function assertInput(input: SimulationInput, requireTacticalInputs: boolean): void {
  if (!input.market.trim()) throw new Error("market is required");
  if (input.bars.length !== input.structural.length) {
    throw new Error("bars and structural points must have identical lengths");
  }
  if (input.localBreadth && input.localBreadth.length !== input.bars.length) {
    throw new Error("localBreadth must be aligned with bars");
  }
  if (
    input.localBreadthVelocity && input.localBreadthVelocity.length !== input.bars.length
  ) {
    throw new Error("localBreadthVelocity must be aligned with bars");
  }
  if (input.fiveMinute && input.fiveMinute.length !== input.bars.length) {
    throw new Error("fiveMinute must be aligned with bars");
  }
  if (
    requireTacticalInputs &&
    (!input.localBreadth || !input.localBreadthVelocity || !input.fiveMinute)
  ) {
    throw new Error(
      "default tactical classifier requires localBreadth, localBreadthVelocity, and fiveMinute",
    );
  }
  for (let i = 0; i < input.bars.length; i++) {
    if (input.bars[i].time !== input.structural[i].time) {
      throw new Error(`structural timestamp mismatch at index ${i}`);
    }
    if (i > 0 && input.bars[i].time <= input.bars[i - 1].time) {
      throw new Error("bars must be strictly chronological");
    }
  }
  const base = finite(input.baseCostBps, BASE_COST_BPS);
  const stress = finite(input.stressCostBps, STRESS_COST_BPS);
  if (base < 0 || stress < base) {
    throw new Error("costs must satisfy 0 <= baseCostBps <= stressCostBps");
  }
  if (input.candidate.family === "BEAR_REBREAK" && input.candidate.side !== "SHORT") {
    throw new Error("BEAR_REBREAK candidates must be SHORT");
  }
  if (input.candidate.family !== "BEAR_REBREAK" && input.candidate.side !== "LONG") {
    throw new Error("BULL and RANGE candidates must be LONG");
  }
}

function favorableR(
  side: Candidate["side"],
  entry: number,
  best: number,
  risk: number,
): number {
  return Math.max(0, side === "LONG" ? (best - entry) / risk : (entry - best) / risk);
}

function updatedStop(
  candidate: Candidate,
  tactical: TacticalContext,
  bar: PreparedBar,
  entry: number,
  best: number,
  risk: number,
  currentStop: number,
): number {
  const p = candidate.parameters;
  const r = favorableR(candidate.side, entry, best, risk);
  let stop = currentStop;

  if (candidate.family === "RANGE_CYCLE") {
    if (r >= finite(p.profitLockAtR, 0.55)) {
      stop = Math.max(stop, entry + finite(p.profitLockR, 0.08) * risk);
    }
    return stop;
  }

  if (candidate.family === "BEAR_REBREAK") {
    if (r >= finite(p.profitLockAtR, 0.40)) {
      stop = Math.min(stop, entry - finite(p.profitLockR, 0.08) * risk);
    }
    return stop;
  }

  if (r >= finite(p.breakEvenAtR, 1)) {
    stop = Math.max(stop, entry + finite(p.breakEvenLockR, 0.05) * risk);
  }
  if (r >= finite(p.trailStartR, 1.5)) {
    stop = Math.max(stop, best - Math.max(0.10, finite(p.trailAtr, 2.2)) * bar.atr);
  }
  if (r >= finite(p.peakTightenR, 3)) {
    stop = Math.max(stop, best - Math.max(0.10, finite(p.peakTrailAtr, 1.25)) * bar.atr);
  }
  // Deceleration protects an existing winner; it never authorizes a new short.
  if (tactical.state === "BULL_DECELERATING" && r > 0) {
    const tightAtr = Math.min(
      Math.max(0.10, finite(p.trailAtr, 2.2)),
      Math.max(0.10, finite(p.peakTrailAtr, 1.25)),
    );
    stop = Math.max(stop, entry, best - tightAtr * bar.atr);
  }
  return stop;
}

function closeGeneratedExit(
  candidate: Candidate,
  tactical: TacticalContext,
  bar: PreparedBar,
): string | null {
  if (
    candidate.family === "DONCHIAN_BREAKOUT" ||
    candidate.family === "MOMENTUM_ACCELERATION" ||
    candidate.family === "COMPRESSION_BREAKOUT"
  ) {
    if (tactical.structural !== "BULL") return "REGIME_EXIT";
    // Require a conjunction of phase, price, momentum and breadth failure so a
    // single pullback cannot cut the validated long trend edge prematurely.
    return tactical.phase === "DECELERATING" && bar.close < bar.ema20 &&
        bar.rsiSlope2 < 0 && tactical.breadthVelocity < 0
      ? "TREND_FAILURE_EXIT"
      : null;
  }
  if (candidate.family === "RANGE_CYCLE") {
    if (tactical.structural !== "RANGE") return "REGIME_EXIT";
    // UP_CYCLE is a cross event, not a state that must repeat every bar. A
    // subsequent NEUTRAL bar therefore remains held; only an observed rollover
    // (or deceleration if a classifier emits it) closes the cycle early.
    return tactical.phase === "ROLL_OVER" || tactical.phase === "DECELERATING"
      ? "CYCLE_EXIT"
      : null;
  }
  if (
    tactical.structural !== "BEAR" || tactical.state === "BEAR_REBOUND" ||
    tactical.phase === "REBOUND" || tactical.phase === "UP_CYCLE"
  ) {
    return tactical.structural === "BEAR" ? "BOUNCE_EXIT" : "REGIME_EXIT";
  }
  return null;
}

function targetFor(
  candidate: Candidate,
  decision: SignalDecision,
  entry: number,
  risk: number,
  policy: HoldingPolicy,
): number | null {
  const hinted = Number(decision.targetHint);
  if (candidate.family === "RANGE_CYCLE") {
    // A next-open gap through the mean-reversion anchor destroys the location
    // edge. Do not silently replace that anchor with a newly invented 1R target.
    return Number.isFinite(hinted) && hinted > entry ? hinted : null;
  }
  if (policy.targetR === null) return null;
  if (candidate.family === "BEAR_REBREAK" && Number.isFinite(hinted)) {
    // If the next open has already crossed the pre-committed downside target,
    // the rebreak edge was consumed in the gap; do not invent a fresh target.
    return hinted < entry ? hinted : null;
  }
  if (candidate.side === "LONG") {
    return Number.isFinite(hinted) && hinted > entry ? hinted : entry + policy.targetR * risk;
  }
  return Number.isFinite(hinted) && hinted < entry ? hinted : entry - policy.targetR * risk;
}

function rangeExitV2Enabled(candidate: Candidate): boolean {
  if (candidate.family !== "RANGE_CYCLE") return false;
  const p = candidate.parameters;
  return finite(p.partialTakeAtr, 0) > 0 &&
    finite(p.partialTakeFraction, 0) > 0 &&
    finite(p.noResponseBars, 0) > 0;
}

/**
 * RANGE Exit V2 changes realization only. The caller has already passed
 * the exact V5 RANGE signal, next-open entry, target-room, cost, and stop
 * gates used by the baseline simulator, so the entry cohort is unchanged.
 *
 * Rules are causal and conservative:
 * - 60% partial at +0.45 signal ATR;
 * - residual stop solves the exact whole-position base-cost break-even;
 * - if same-bar partial/protected-stop order is ambiguous, stop wins;
 * - no partial response within three completed 15m bars -> next-open TIME_STOP;
 * - original anchor target, cycle/regime exit, initial stop and max hold remain.
 */
function simulateRangeExitV2(
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
  const partialTakeAtr = Math.max(0.05, finite(p.partialTakeAtr, 0.45));
  const partialFraction = Math.max(
    0.05,
    Math.min(0.95, finite(p.partialTakeFraction, 0.60)),
  );
  const noResponseBars = boundedInteger(
    p.noResponseBars,
    3,
    1,
    policy.maxHoldBars,
  );
  const partialTarget = entry + partialTakeAtr * signalAtr;
  if (!(partialTarget > entry) || !(partialTarget < target)) return null;

  let stop = initialStop;
  let best = entry;
  let worst = entry;
  let pendingReason: string | null = null;
  let partialTaken = false;
  let remainingFraction = 1;
  let realizedGrossBps = 0;

  const includePoint = (price: number) => {
    best = Math.max(best, price);
    worst = Math.min(worst, price);
  };

  const takePartial = () => {
    if (partialTaken) return;
    includePoint(partialTarget);
    const partialGrossBps = (partialTarget / entry - 1) * 10_000;
    realizedGrossBps += partialFraction * partialGrossBps;
    remainingFraction = 1 - partialFraction;
    partialTaken = true;
    if (finite(p.portfolioBreakEvenAfterPartial, 1) > 0 && remainingFraction > 0) {
      const requiredResidualGrossBps = Math.max(
        0,
        (baseCostBps - realizedGrossBps) / remainingFraction,
      );
      stop = Math.max(
        stop,
        entry * (1 + requiredResidualGrossBps / 10_000),
      );
    }
  };

  const finish = (
    exitIndex: number,
    exit: number,
    reason: string,
    atOpen: boolean,
  ): SimulatedTrade => {
    includePoint(exit);
    const residualGrossBps = (exit / entry - 1) * 10_000;
    const grossBps = realizedGrossBps + remainingFraction * residualGrossBps;
    const netBps = grossBps - baseCostBps;
    const stressNetBps = grossBps - stressCostBps;
    const mfeBps = Math.max(0, (best / entry - 1) * 10_000);
    const maeBps = Math.max(0, (1 - worst / entry) * 10_000);
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
    if (bar.open <= stop) return finish(j, bar.open, "STOP_GAP", true);

    if (!partialTaken && bar.open >= target) {
      takePartial();
      return finish(j, target, "TARGET", true);
    }
    if (!partialTaken && bar.open >= partialTarget) takePartial();
    if (partialTaken && bar.open >= target) return finish(j, target, "TARGET", true);
    includePoint(bar.open);

    if (bar.low <= stop) return finish(j, stop, "STOP", false);

    if (!partialTaken && bar.high >= partialTarget) {
      takePartial();
      if (bar.low <= stop) return finish(j, stop, "STOP", false);
      if (bar.high >= target) return finish(j, target, "TARGET", false);
      includePoint(bar.high);
      includePoint(bar.low);
    } else {
      if (partialTaken && bar.high >= target) {
        return finish(j, target, "TARGET", false);
      }
      includePoint(bar.high);
      includePoint(bar.low);
    }

    const tactical = tacticalAt(j);
    pendingReason = closeGeneratedExit(candidate, tactical, bar);
    const heldBars = j - entryIndex + 1;
    if (!pendingReason && !partialTaken && heldBars >= noResponseBars) {
      pendingReason = "TIME_STOP";
    }
    if (!pendingReason && heldBars >= policy.maxHoldBars) {
      pendingReason = "MAX_HOLD";
    }
  }
  return null;
}

function simulateOne(
  input: SimulationInput,
  signalIndex: number,
  split: TradeSplit,
  decision: SignalDecision,
  tacticalAt: (index: number) => TacticalContext,
  policy: HoldingPolicy,
  baseCostBps: number,
  stressCostBps: number,
): SimulatedTrade | null {
  const bars = input.bars;
  const candidate = input.candidate;
  const entryIndex = signalIndex + 1;
  const entryBar = bars[entryIndex];
  const entry = entryBar.open;
  const signalAtr = bars[signalIndex].atr;
  if (!(entry > 0) || !(signalAtr > 0)) return null;

  const hintedStop = Number(decision.stopHint);
  if (
    Number.isFinite(hintedStop) &&
    (candidate.side === "LONG" ? entry <= hintedStop : entry >= hintedStop)
  ) {
    // The next-open gap has already crossed the stop committed at signal close.
    // Re-anchoring risk from the worse open would manufacture a different trade.
    return null;
  }
  const fallbackRisk = policy.initialStopAtr * signalAtr;
  let stop = candidate.side === "LONG" ? entry - fallbackRisk : entry + fallbackRisk;
  if (
    Number.isFinite(hintedStop) &&
    (candidate.side === "LONG" ? hintedStop < entry : hintedStop > entry) &&
    Math.abs(entry - hintedStop) >= 0.10 * signalAtr
  ) {
    stop = hintedStop;
  }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const target = targetFor(candidate, decision, entry, risk, policy);
  if (candidate.family === "RANGE_CYCLE" && target === null) return null;
  const signalBar = bars[signalIndex];
  if (candidate.family === "RANGE_CYCLE") {
    const targetRoom = target! - entry;
    const targetBps = (target! / entry - 1) * 10_000;
    if (
      targetRoom < finite(candidate.parameters.minTargetAtr, 0.75) * signalAtr ||
      targetBps < baseCostBps * finite(candidate.parameters.costMultiple, 4)
    ) return null;
  } else if (candidate.family === "BEAR_REBREAK") {
    if (target === null) return null;
    if (!(entry < signalBar.ema20)) return null;
    const targetBps = (entry - target) / entry * 10_000;
    const emaChaseAtr = (signalBar.ema20 - entry) / signalAtr;
    if (
      targetBps < baseCostBps * finite(candidate.parameters.costMultiple, 3) ||
      emaChaseAtr > finite(candidate.parameters.maxEmaDistanceAtr, 1.5)
    ) return null;
  } else {
    if (!(entry > signalBar.ema20)) return null;
    const emaChaseAtr = (entry - signalBar.ema20) / signalAtr;
    if (emaChaseAtr > finite(candidate.parameters.maxEmaDistanceAtr, 2.1)) return null;
  }

  if (candidate.family === "RANGE_CYCLE" && rangeExitV2Enabled(candidate)) {
    return simulateRangeExitV2(
      input,
      signalIndex,
      split,
      decision,
      tacticalAt,
      policy,
      baseCostBps,
      stressCostBps,
      entryIndex,
      entry,
      signalAtr,
      target!,
      stop,
    );
  }

  let best = entry;
  let worst = entry;
  let pendingReason: string | null = null;

  const includePoint = (price: number) => {
    if (candidate.side === "LONG") {
      best = Math.max(best, price);
      worst = Math.min(worst, price);
    } else {
      best = Math.min(best, price);
      worst = Math.max(worst, price);
    }
  };

  const finish = (
    exitIndex: number,
    exit: number,
    reason: string,
    atOpen: boolean,
  ): SimulatedTrade => {
    includePoint(exit);
    const grossBps = candidate.side === "LONG"
      ? (exit / entry - 1) * 10_000
      : (entry - exit) / entry * 10_000;
    const netBps = grossBps - baseCostBps;
    const stressNetBps = grossBps - stressCostBps;
    const mfeBps = candidate.side === "LONG"
      ? Math.max(0, (best / entry - 1) * 10_000)
      : Math.max(0, (entry - best) / entry * 10_000);
    const maeBps = candidate.side === "LONG"
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
        entryTime: entryBar.time,
        exitTime: bars[exitIndex].time,
        grossBps,
        netBps,
        stressNetBps,
        mfeBps,
        maeBps,
        // Preserve raw cost-aware capture. A losing exit after positive MFE is
        // intentionally negative and must not be hidden by a zero clamp.
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

    // A rule observed at j-1 close can only execute at j open. No j high/low is read.
    if (pendingReason) return finish(j, bar.open, pendingReason, true);

    if (candidate.side === "LONG") {
      // Resolve executable gaps before recording the open. A favorable gap
      // through the target fills conservatively at the committed target, so
      // the unreachable gap price cannot inflate MFE or profit giveback. An
      // adverse stop gap, however, really does fill at the worse open and the
      // finish helper records that open in MAE.
      if (bar.open <= stop) return finish(j, bar.open, "STOP_GAP", true);
      if (target !== null && bar.open >= target) return finish(j, target, "TARGET", true);
      includePoint(bar.open);
      // Conservative OHLC ambiguity rule: stop always wins if stop and target coexist.
      if (bar.low <= stop) return finish(j, stop, "STOP", false);
      if (target !== null && bar.high >= target) return finish(j, target, "TARGET", false);
      // Full extrema are admissible only because the position survived the whole bar.
      includePoint(bar.high);
      includePoint(bar.low);
    } else {
      if (bar.open >= stop) return finish(j, bar.open, "STOP_GAP", true);
      if (target !== null && bar.open <= target) return finish(j, target, "TARGET", true);
      includePoint(bar.open);
      if (bar.high >= stop) return finish(j, stop, "STOP", false);
      if (target !== null && bar.low <= target) return finish(j, target, "TARGET", false);
      includePoint(bar.low);
      includePoint(bar.high);
    }

    const tactical = tacticalAt(j);
    stop = updatedStop(candidate, tactical, bar, entry, best, risk, stop);
    if (
      (candidate.side === "LONG" && bar.close <= stop) ||
      (candidate.side === "SHORT" && bar.close >= stop)
    ) {
      pendingReason = "TRAIL_CLOSE_EXIT";
    }

    if (!pendingReason) pendingReason = closeGeneratedExit(candidate, tactical, bar);
    const heldBars = j - entryIndex + 1;
    if (
      !pendingReason && policy.timeStopBars !== null && heldBars >= policy.timeStopBars &&
      favorableR(candidate.side, entry, best, risk) < policy.minMfeAtTimeStopR
    ) {
      pendingReason = "TIME_STOP";
    }
    if (!pendingReason && heldBars >= policy.maxHoldBars) pendingReason = "MAX_HOLD";
  }
  return null;
}

/**
 * Causal single-candidate simulation. Signal bar i is completed before the
 * earliest possible entry at i+1 open. Close-generated exits are deferred to
 * the next open, and entries whose worst-case horizon touches an embargo or a
 * different split are purged before simulation.
 */
export function simulateCandidate(
  input: SimulationInput,
  dependencies: SimulationDependencies = {},
): V5Trade[] {
  const usesDefaultClassifier = dependencies.classifyTactical === undefined;
  assertInput(input, usesDefaultClassifier);
  if (input.bars.length < 3) return [];

  const classify = dependencies.classifyTactical ?? classifyTactical;
  const decide = dependencies.signalEvaluator ?? signalDecision;
  const policy = policyFor(input.candidate);
  const baseCostBps = finite(input.baseCostBps, BASE_COST_BPS);
  const stressCostBps = finite(input.stressCostBps, STRESS_COST_BPS);
  const cache = new Array<TacticalContext | undefined>(input.bars.length);
  const tacticalAt = (index: number): TacticalContext => {
    const cached = cache[index];
    if (cached) return cached;
    const structural = input.structural[index];
    const suppliedBreadth = input.localBreadth?.[index];
    const suppliedVelocity = input.localBreadthVelocity?.[index];
    const suppliedFiveMinute = input.fiveMinute?.[index];
    if (
      usesDefaultClassifier &&
      (!Number.isFinite(suppliedBreadth) || !Number.isFinite(suppliedVelocity) ||
        suppliedFiveMinute === undefined)
    ) {
      throw new Error(`missing tactical input at index ${index}`);
    }
    // Structural fallbacks exist only for deliberately injected unit-test
    // classifiers. The production classifier must receive the aligned arrays.
    const localBreadth = suppliedBreadth ?? structural.positiveBreadth6h;
    const breadthVelocity = suppliedVelocity ?? structural.breadthVelocity;
    const tactical = classify({
      bars: input.bars,
      index,
      structural: structural.regime,
      localBreadth,
      breadthVelocity,
      fiveMinute: suppliedFiveMinute ?? null,
    });
    cache[index] = tactical;
    return tactical;
  };

  const trades: V5Trade[] = [];
  let i = 1;
  while (i < input.bars.length - 1) {
    const signalSplit = foldSplitAt(input.bars[i].time, input.fold);
    const entryIndex = i + 1;
    if (
      !isTradeSplit(signalSplit) ||
      foldSplitAt(input.bars[entryIndex].time, input.fold) !== signalSplit
    ) {
      i++;
      continue;
    }

    // Purge the signal unless even the maximum close-generated exit can fill
    // inside the same non-embargo split.
    const latestExitIndex = entryIndex + policy.maxHoldBars;
    if (
      latestExitIndex >= input.bars.length ||
      foldSplitAt(input.bars[latestExitIndex].time, input.fold) !== signalSplit
    ) {
      i++;
      continue;
    }

    const tactical = tacticalAt(i);
    const decision = decide(input.bars, i, input.candidate, tactical, input.structural[i]);
    if (!decision.ok) {
      i++;
      continue;
    }
    const simulated = simulateOne(
      input,
      i,
      signalSplit,
      decision,
      tacticalAt,
      policy,
      baseCostBps,
      stressCostBps,
    );
    if (!simulated) {
      i++;
      continue;
    }
    trades.push(simulated.trade);
    // Avoid overlapping positions. The exit bar itself is not reused as a signal.
    i = Math.max(i + 1, simulated.exitIndex + 1);
  }
  return trades;
}
