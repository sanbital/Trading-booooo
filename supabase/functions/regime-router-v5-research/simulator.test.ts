import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  foldSplitAt,
  type SignalEvaluator,
  simulateCandidate,
  type SimulationDependencies,
} from "./simulator.ts";
import type { TacticalInput } from "./tactical.ts";
import {
  BAR_MS,
  type Candidate,
  type FoldDefinition,
  type PreparedBar,
  type RouterState,
  type StructuralPoint,
  type TacticalContext,
  type TacticalPhase,
} from "./types.ts";

const START = Date.UTC(2026, 0, 1);

function bar(index: number, overrides: Partial<PreparedBar> = {}): PreparedBar {
  const open = overrides.open ?? 100;
  const close = overrides.close ?? open;
  return {
    time: START + index * BAR_MS,
    open,
    high: overrides.high ?? Math.max(open, close) + 0.20,
    low: overrides.low ?? Math.min(open, close) - 0.20,
    close,
    volume: 1_000,
    quoteVolume: 100_000,
    atr: 1,
    atrPct: 0.01,
    atrPercentile7d: 0.5,
    rsi: 50,
    rsiSlope2: 0,
    rsiPercentile7d: 0.5,
    ema20: 100,
    ema50: 100,
    ema20SlopeAtr: 0,
    stochK: 50,
    stochD: 50,
    stochPercentile7d: 0.5,
    adx: 15,
    vwap96: 101,
    dayOpen: 101,
    vwapDeviationAtr: -1,
    dayOpenDeviationAtr: -1,
    qv24: 20_000_000,
    volumeRatio: 1,
    ret2: 0,
    ret4: 0,
    ret6h: 0,
    ret24h: 0,
    high20Prev: 102,
    low20Prev: 98,
    high8Prev: 101,
    low8Prev: 99,
    rangeMid20Prev: 100,
    bbMid: 100,
    bbUpper: 102,
    bbLower: 98,
    bbCompressionPercentile7d: 0.5,
    ...overrides,
  };
}

function structural(point: PreparedBar, regime: StructuralPoint["regime"]): StructuralPoint {
  return {
    time: point.time,
    regime,
    positiveBreadth6h: 0.5,
    negativeBreadth6h: 0.5,
    positiveBreadth24h: 0.5,
    negativeBreadth24h: 0.5,
    meanReturn6h: 0,
    meanReturn24h: 0,
    medianReturn6h: 0,
    medianReturn24h: 0,
    emaBullShare: 0.5,
    emaBearShare: 0.5,
    trendPersistence: 0.5,
    lowAdxShare: 0.5,
    meanReversionShare: 0.5,
    volatilityPercentile: 0.5,
    extremeMoverShare: 0,
    breadthVelocity: 0,
    breadthAcceleration: 0,
    btc6h: 0,
    btc24h: 0,
    eth6h: 0,
    eth24h: 0,
    sol6h: 0,
    sol24h: 0,
    bullScore: 0,
    bearScore: 0,
    rangeScore: 1,
    validMarkets: 500,
  };
}

function fold(points: readonly PreparedBar[], embargoBars = 0): FoldDefinition {
  const after = points.at(-1)!.time + BAR_MS;
  return {
    id: 1,
    trainStart: points[0].time,
    trainEnd: after,
    validationStart: after + BAR_MS,
    validationEnd: after + 10 * BAR_MS,
    testStart: after + 11 * BAR_MS,
    testEnd: after + 20 * BAR_MS,
    embargoBars,
  };
}

function candidate(
  family: Candidate["family"],
  parameters: Record<string, number>,
): Candidate {
  const bear = family === "BEAR_REBREAK";
  const range = family === "RANGE_CYCLE";
  return {
    name: `TEST_${family}`,
    family,
    side: bear ? "SHORT" : "LONG",
    state: bear ? "BEAR_REBREAK" : range ? "RANGE_UP_CYCLE" : "BULL_TREND",
    neighborGroup: "TEST",
    parameters,
  };
}

function tactical(state: RouterState, input: TacticalInput): TacticalContext {
  return {
    state,
    phase: state === "RANGE_UP_CYCLE"
      ? "UP_CYCLE"
      : state === "BEAR_REBREAK"
      ? "REBREAK"
      : state === "BEAR_REBOUND"
      ? "REBOUND"
      : state === "BULL_DECELERATING"
      ? "DECELERATING"
      : state === "BULL_TREND"
      ? "ACCELERATING"
      : "NEUTRAL",
    structural: input.structural,
    localBreadth: input.localBreadth,
    breadthVelocity: input.breadthVelocity,
    fiveMinuteConfirmed: false,
    reasons: [],
  };
}

function dependencies(
  signalState: RouterState,
  stateAt: (index: number) => RouterState,
  stopHint: number,
  targetHint?: number,
  signalIndex = 1,
  phaseAt?: (index: number) => TacticalPhase | undefined,
): SimulationDependencies {
  const signalEvaluator: SignalEvaluator = (_bars, index) => ({
    ok: index === signalIndex,
    state: signalState,
    phase: signalState === "RANGE_UP_CYCLE"
      ? "UP_CYCLE"
      : signalState === "BEAR_REBREAK"
      ? "REBREAK"
      : "ACCELERATING",
    stopHint,
    targetHint,
    reasons: [],
  });
  return {
    signalEvaluator,
    classifyTactical: (input) => {
      const context = tactical(stateAt(input.index), input);
      const phase = phaseAt?.(input.index);
      return phase ? { ...context, phase } : context;
    },
  };
}

function run(
  points: readonly PreparedBar[],
  strategy: Candidate,
  deps: SimulationDependencies,
  definition = fold(points),
) {
  const regime = strategy.family === "BEAR_REBREAK"
    ? "BEAR"
    : strategy.family === "RANGE_CYCLE"
    ? "RANGE"
    : "BULL";
  return simulateCandidate({
    market: "TESTUSDT",
    bars: points,
    structural: points.map((point) => structural(point, regime)),
    candidate: strategy,
    fold: definition,
  }, deps);
}

function assertThrowsMessage(action: () => unknown, expected: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error);
  assert(caught.message.includes(expected));
}

Deno.test("completed signal bar i enters at i+1 and rollover exits at the following open", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 101, close: 101 });
  points[3] = bar(3, { open: 102, close: 102 });
  const strategy = candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 4 });
  const trades = run(
    points,
    strategy,
    dependencies(
      "RANGE_UP_CYCLE",
      (index) => index <= 1 ? "RANGE_UP_CYCLE" : "NO_TRADE",
      90,
      200,
      1,
      (index) => index === 2 ? "ROLL_OVER" : undefined,
    ),
  );
  assertEquals(trades.length, 1);
  assertEquals(trades[0].signalTime, points[1].time);
  assertEquals(trades[0].entryTime, points[2].time);
  assertEquals(trades[0].exitReason, "CYCLE_EXIT");
  // The cycle turn is observed at bar 2 close but executes only at bar 3 open.
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, (102 / 101 - 1) * 10_000);
});

Deno.test("RANGE neutral bar after the UP_CYCLE event does not force a one-bar exit", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100, close: 100 });
  points[3] = bar(3, { open: 101, close: 101 });
  points[4] = bar(4, { open: 102, close: 102 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 2 }),
    dependencies(
      "RANGE_UP_CYCLE",
      (index) => index === 1 ? "RANGE_UP_CYCLE" : "NO_TRADE",
      90,
      200,
    ),
  );
  assertEquals(trades[0].exitReason, "MAX_HOLD");
  assertEquals(trades[0].exitTime, points[4].time);
  assertEquals(trades[0].holdBars, 2);
});

Deno.test("ambiguous intrabar stop and target is stop-first without post-exit extrema", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100, high: 110, low: 90, close: 105 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { maxHoldBars: 4 }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 99, 101),
  );
  assertEquals(trades.length, 1);
  assertEquals(trades[0].exitReason, "STOP");
  assertAlmostEquals(trades[0].grossBps, -100);
  assertAlmostEquals(trades[0].mfeBps, 0);
  assertAlmostEquals(trades[0].maeBps, 100);
});

Deno.test("target exit records target only, not the rest of its exit bar", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100, high: 110, low: 99.5, close: 108 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { maxHoldBars: 4 }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 99, 101),
  );
  assertEquals(trades[0].exitReason, "TARGET");
  assertAlmostEquals(trades[0].mfeBps, 100);
  assertAlmostEquals(trades[0].maeBps, 0);
  assertAlmostEquals(trades[0].mfeCapture!, 0.86);
  assertAlmostEquals(trades[0].givebackBps, 14);
});

Deno.test("LONG favorable target gap caps MFE and giveback at the executable target", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100, high: 100.25, low: 99.75, close: 100 });
  points[3] = bar(3, { open: 105, high: 110, low: 104, close: 108 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 4 }),
    dependencies(
      "RANGE_UP_CYCLE",
      (index) => index === 1 ? "RANGE_UP_CYCLE" : "NO_TRADE",
      90,
      101,
    ),
  );
  assertEquals(trades.length, 1);
  assertEquals(trades[0].exitReason, "TARGET");
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, 100);
  assertAlmostEquals(trades[0].mfeBps, 100);
  assertAlmostEquals(trades[0].mfeCapture!, 0.86);
  assertAlmostEquals(trades[0].givebackBps, 14);
});

Deno.test("SHORT favorable target gap caps MFE and giveback at the executable target", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 101 });
  points[2] = bar(2, { open: 100, high: 100.25, low: 99.75, close: 100 });
  points[3] = bar(3, { open: 95, high: 96, low: 90, close: 92 });
  const trades = run(
    points,
    candidate("BEAR_REBREAK", {
      initialStopAtr: 1,
      targetR: 1.5,
      maxHoldBars: 4,
      timeStopBars: 4,
      minMfeAtTimeStopR: 0,
    }),
    dependencies(
      "BEAR_REBREAK",
      (index) => index === 1 ? "BEAR_REBREAK" : "NO_TRADE",
      101,
      98.5,
    ),
  );
  assertEquals(trades.length, 1);
  assertEquals(trades[0].exitReason, "TARGET");
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, 150);
  assertAlmostEquals(trades[0].mfeBps, 150);
  assertAlmostEquals(trades[0].mfeCapture!, 136 / 150);
  assertAlmostEquals(trades[0].givebackBps, 14);
});

Deno.test("adverse stop gap records the executable open in MAE", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 99 });
  points[2] = bar(2, { open: 100, high: 100.25, low: 99.75, close: 100 });
  points[3] = bar(3, { open: 97, high: 98, low: 95, close: 96 });
  const trades = run(
    points,
    candidate("DONCHIAN_BREAKOUT", {
      initialStopAtr: 1,
      maxHoldBars: 5,
      trailStartR: 99,
      breakEvenAtR: 99,
      peakTightenR: 99,
    }),
    dependencies("BULL_TREND", () => "BULL_TREND", 99),
  );
  assertEquals(trades.length, 1);
  assertEquals(trades[0].exitReason, "STOP_GAP");
  assertAlmostEquals(trades[0].grossBps, -300);
  assertAlmostEquals(trades[0].maeBps, 300);
});

Deno.test("max-hold exit generated at close fills the following open", () => {
  const points = Array.from({ length: 8 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100, high: 100.2, low: 99.8, close: 100 });
  points[3] = bar(3, { open: 103, close: 103 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 1 }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 90, 200),
  );
  assertEquals(trades[0].exitReason, "MAX_HOLD");
  assertEquals(trades[0].exitTime, points[3].time);
  assertEquals(trades[0].holdBars, 1);
  assertAlmostEquals(trades[0].grossBps, 300);
});

Deno.test("RANGE entry is cancelled when next open has already crossed its mean target", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 102, close: 102 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 4 }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 90, 101),
  );
  assertEquals(trades, []);
});

Deno.test("RANGE next-open gap must still pass ATR room and cost gates", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 100.5, close: 100.5 });
  const trades = run(
    points,
    candidate("RANGE_CYCLE", {
      initialStopAtr: 1,
      maxHoldBars: 4,
      minTargetAtr: 0.75,
      costMultiple: 4,
    }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 99, 101),
  );
  assertEquals(trades, []);
});

Deno.test("BEAR next-open target-cost and EMA chase gates fail closed", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  const strategy = candidate("BEAR_REBREAK", {
    initialStopAtr: 1,
    targetR: 0.75,
    maxHoldBars: 4,
    timeStopBars: 2,
    minMfeAtTimeStopR: 0.2,
    costMultiple: 3,
    maxEmaDistanceAtr: 1.5,
  });
  const costRejected = run(
    points,
    strategy,
    dependencies("BEAR_REBREAK", () => "BEAR_REBREAK", 101, 99.8),
  );
  assertEquals(costRejected, []);

  points[2] = bar(2, { open: 98, close: 98 });
  const chaseRejected = run(
    points,
    strategy,
    dependencies("BEAR_REBREAK", () => "BEAR_REBREAK", 101, 95),
  );
  assertEquals(chaseRejected, []);
});

Deno.test("BULL next-open extension beyond EMA chase limit cancels entry", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[2] = bar(2, { open: 103, close: 103 });
  const trades = run(
    points,
    candidate("DONCHIAN_BREAKOUT", { maxHoldBars: 5, maxEmaDistanceAtr: 2 }),
    dependencies("BULL_TREND", () => "BULL_TREND", 99),
  );
  assertEquals(trades, []);
});

Deno.test("LONG next-open adverse gap through the signal stop cancels entry", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 98 });
  points[2] = bar(2, { open: 99, close: 99 });
  const trades = run(
    points,
    candidate("DONCHIAN_BREAKOUT", { initialStopAtr: 1, maxHoldBars: 5 }),
    dependencies("BULL_TREND", () => "BULL_TREND", 99),
  );
  assertEquals(trades, []);
});

Deno.test("SHORT next-open adverse gap through the signal stop cancels entry", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 102 });
  points[2] = bar(2, { open: 101, close: 101 });
  const trades = run(
    points,
    candidate("BEAR_REBREAK", {
      initialStopAtr: 1,
      targetR: 2,
      maxHoldBars: 4,
      timeStopBars: 2,
    }),
    dependencies("BEAR_REBREAK", () => "BEAR_REBREAK", 101, 98),
  );
  assertEquals(trades, []);
});

Deno.test("BULL next-open at or below signal EMA20 cancels entry", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 100 });
  points[2] = bar(2, { open: 100, close: 100 });
  const trades = run(
    points,
    candidate("DONCHIAN_BREAKOUT", { initialStopAtr: 1, maxHoldBars: 5 }),
    dependencies("BULL_TREND", () => "BULL_TREND", 99),
  );
  assertEquals(trades, []);
});

Deno.test("BEAR next-open at or above signal EMA20 cancels entry", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 100 });
  points[2] = bar(2, { open: 100, close: 100 });
  const trades = run(
    points,
    candidate("BEAR_REBREAK", {
      initialStopAtr: 1,
      targetR: 2,
      maxHoldBars: 4,
      timeStopBars: 2,
    }),
    dependencies("BEAR_REBREAK", () => "BEAR_REBREAK", 101, 98),
  );
  assertEquals(trades, []);
});

Deno.test("BEAR weak-MFE time stop is decided at close and filled next open", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 101 });
  points[2] = bar(2, { open: 100, high: 100.1, low: 99.9, close: 100 });
  points[3] = bar(3, { open: 100, high: 100.1, low: 99.9, close: 100 });
  points[4] = bar(4, { open: 100.5, close: 100.5 });
  const strategy = candidate("BEAR_REBREAK", {
    initialStopAtr: 1,
    targetR: 0.75,
    maxHoldBars: 4,
    timeStopBars: 2,
    minMfeAtTimeStopR: 0.2,
  });
  const trades = run(
    points,
    strategy,
    dependencies("BEAR_REBREAK", () => "BEAR_REBREAK", 101),
  );
  assertEquals(trades[0].exitReason, "TIME_STOP");
  assertEquals(trades[0].exitTime, points[4].time);
  assertEquals(trades[0].holdBars, 2);
});

Deno.test("BULL profit trailing is formed at close and can stop only on a later bar", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 99 });
  points[2] = bar(2, { open: 100, high: 102, low: 99.5, close: 101.8 });
  points[3] = bar(3, { open: 101.8, high: 102, low: 101, close: 101.2 });
  const strategy = candidate("DONCHIAN_BREAKOUT", {
    maxHoldBars: 5,
    trailStartR: 1,
    trailAtr: 0.5,
    breakEvenAtR: 99,
    peakTightenR: 99,
  });
  const trades = run(
    points,
    strategy,
    dependencies("BULL_TREND", () => "BULL_TREND", 99),
  );
  assertEquals(trades[0].exitReason, "STOP");
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, 150);
  assertAlmostEquals(trades[0].mfeBps, 200);
});

Deno.test("BULL_DECELERATING tightens an existing long without reversing SHORT", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 99 });
  points[2] = bar(2, { open: 100, high: 101, low: 99.5, close: 100.8 });
  points[3] = bar(3, { open: 100.8, high: 101, low: 99.8, close: 100 });
  const strategy = candidate("MOMENTUM_ACCELERATION", {
    maxHoldBars: 5,
    trailStartR: 99,
    breakEvenAtR: 99,
    peakTightenR: 99,
    peakTrailAtr: 1.25,
  });
  const trades = run(
    points,
    strategy,
    dependencies(
      "BULL_TREND",
      (index) => index === 2 ? "BULL_DECELERATING" : "BULL_TREND",
      99,
    ),
  );
  assertEquals(trades[0].side, "LONG");
  assertEquals(trades[0].exitReason, "STOP");
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, 0);
});

Deno.test("BULL conjunctive trend failure exits only at the next open", () => {
  const points = Array.from({ length: 10 }, (_, index) => bar(index));
  points[1] = bar(1, { ema20: 99 });
  points[2] = bar(2, {
    open: 100,
    high: 100,
    low: 99.4,
    close: 99.5,
    ema20: 100,
    rsiSlope2: -1,
  });
  points[3] = bar(3, { open: 99.3, high: 110, low: 90, close: 100 });
  const deps = dependencies(
    "BULL_TREND",
    (index) => index === 2 ? "BULL_DECELERATING" : "BULL_TREND",
    98,
    undefined,
    1,
    (index) => index === 2 ? "DECELERATING" : undefined,
  );
  deps.classifyTactical = (input) => ({
    ...tactical(input.index === 2 ? "BULL_DECELERATING" : "BULL_TREND", input),
    phase: input.index === 2 ? "DECELERATING" : "ACCELERATING",
    breadthVelocity: input.index === 2 ? -0.1 : 0,
  });
  const trades = run(
    points,
    candidate("DONCHIAN_BREAKOUT", {
      initialStopAtr: 2,
      maxHoldBars: 5,
      trailStartR: 99,
      breakEvenAtR: 99,
      peakTightenR: 99,
    }),
    deps,
  );
  assertEquals(trades[0].exitReason, "TREND_FAILURE_EXIT");
  assertEquals(trades[0].exitTime, points[3].time);
  assertAlmostEquals(trades[0].grossBps, -70);
  assertAlmostEquals(trades[0].mfeBps, 0);
});

Deno.test("purge rejects any entry whose maximum horizon could cross a split", () => {
  const points = Array.from({ length: 9 }, (_, index) => bar(index));
  const definition = fold(points);
  definition.trainEnd = points[6].time;
  const trades = run(
    points,
    candidate("RANGE_CYCLE", { initialStopAtr: 10, maxHoldBars: 4 }),
    dependencies("RANGE_UP_CYCLE", () => "RANGE_UP_CYCLE", 90, 200),
    definition,
  );
  assertEquals(trades, []);
});

Deno.test("foldSplitAt preserves the explicit between-split embargo windows", () => {
  const points = Array.from({ length: 12 }, (_, index) => bar(index));
  const definition = fold(points, 1);
  assertEquals(foldSplitAt(points[0].time, definition), "TRAIN");
  assertEquals(foldSplitAt(definition.trainEnd, definition), "EMBARGO");
  assertEquals(foldSplitAt(definition.validationStart, definition), "VALIDATION");
  assert(foldSplitAt(definition.validationEnd, definition) === "EMBARGO");
});

Deno.test("tactical classifier receives aligned local 30m breadth velocity", () => {
  const points = Array.from({ length: 8 }, (_, index) => bar(index));
  let observed = Number.NaN;
  simulateCandidate({
    market: "TESTUSDT",
    bars: points,
    structural: points.map((point) => structural(point, "RANGE")),
    localBreadth: points.map(() => 0.45),
    localBreadthVelocity: points.map(() => 0.123),
    candidate: candidate("RANGE_CYCLE", { maxHoldBars: 1 }),
    fold: fold(points),
  }, {
    classifyTactical: (input) => {
      observed = input.breadthVelocity;
      return tactical("RANGE_UP_CYCLE", input);
    },
    signalEvaluator: (_bars, _index, _candidate, context) => ({
      ok: false,
      state: context.state,
      phase: context.phase,
      reasons: [],
    }),
  });
  assertAlmostEquals(observed, 0.123);
});

Deno.test("default tactical classifier fails closed when aligned tactical arrays are missing", () => {
  const points = Array.from({ length: 8 }, (_, index) => bar(index));
  const common = {
    market: "TESTUSDT",
    bars: points,
    structural: points.map((point) => structural(point, "RANGE")),
    candidate: candidate("RANGE_CYCLE", { maxHoldBars: 1 }),
    fold: fold(points),
  };
  const localBreadth = points.map(() => 0.45);
  const localBreadthVelocity = points.map(() => 0.01);
  const fiveMinute = points.map(() => null);

  assertThrowsMessage(
    () => simulateCandidate(common),
    "default tactical classifier requires",
  );
  assertThrowsMessage(
    () => simulateCandidate({ ...common, localBreadth, localBreadthVelocity }),
    "default tactical classifier requires",
  );
  assertThrowsMessage(
    () => simulateCandidate({ ...common, localBreadth, fiveMinute }),
    "default tactical classifier requires",
  );
  assertThrowsMessage(
    () => simulateCandidate({ ...common, localBreadthVelocity, fiveMinute }),
    "default tactical classifier requires",
  );
});
