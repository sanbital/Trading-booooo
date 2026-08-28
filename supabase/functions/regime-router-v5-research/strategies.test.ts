import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CANDIDATE_REGISTRY_HASH_INPUT,
  candidates,
  signalDecision,
  V5_CANDIDATE_REGISTRY_REVISION,
} from "./strategies.ts";
import type { PreparedBar, StructuralPoint, TacticalContext } from "./types.ts";

function bar(overrides: Partial<PreparedBar> = {}): PreparedBar {
  return {
    time: 1_000,
    open: 99,
    high: 100.4,
    low: 98.8,
    close: 100,
    volume: 1_000,
    quoteVolume: 100_000,
    atr: 1,
    atrPct: 0.01,
    atrPercentile7d: 0.5,
    rsi: 60,
    rsiSlope2: 0.5,
    rsiPercentile7d: 0.45,
    ema20: 99,
    ema50: 98,
    ema20SlopeAtr: 0.1,
    stochK: 40,
    stochD: 35,
    stochPercentile7d: 0.4,
    adx: 20,
    vwap96: 100.9,
    dayOpen: 101,
    vwapDeviationAtr: -0.9,
    dayOpenDeviationAtr: -1,
    qv24: 10_000_000,
    volumeRatio: 1.25,
    ret2: 0.003,
    ret4: 0.008,
    ret6h: 0.03,
    ret24h: 0.08,
    high20Prev: 99.8,
    low20Prev: 97,
    high8Prev: 99.7,
    low8Prev: 98,
    rangeMid20Prev: 100.95,
    bbMid: 100.8,
    bbUpper: 100.2,
    bbLower: 98.5,
    bbCompressionPercentile7d: 0.1,
    ...overrides,
  };
}

function structural(
  regime: StructuralPoint["regime"],
  overrides: Partial<StructuralPoint> = {},
): StructuralPoint {
  return {
    time: 1_000,
    regime,
    positiveBreadth6h: regime === "BEAR" ? 0.25 : 0.62,
    negativeBreadth6h: regime === "BEAR" ? 0.7 : 0.3,
    positiveBreadth24h: regime === "BEAR" ? 0.22 : 0.65,
    negativeBreadth24h: regime === "BEAR" ? 0.73 : 0.28,
    meanReturn6h: regime === "BEAR" ? -0.02 : 0.02,
    meanReturn24h: regime === "BEAR" ? -0.05 : 0.05,
    medianReturn6h: regime === "BEAR" ? -0.018 : 0.018,
    medianReturn24h: regime === "BEAR" ? -0.045 : 0.045,
    emaBullShare: regime === "BEAR" ? 0.25 : 0.65,
    emaBearShare: regime === "BEAR" ? 0.7 : 0.25,
    trendPersistence: 0.6,
    lowAdxShare: regime === "RANGE" ? 0.7 : 0.25,
    meanReversionShare: regime === "RANGE" ? 0.7 : 0.25,
    volatilityPercentile: 0.5,
    extremeMoverShare: 0.03,
    breadthVelocity: regime === "BEAR" ? -0.03 : 0.02,
    breadthAcceleration: regime === "BEAR" ? -0.01 : 0.01,
    btc6h: 0.02,
    btc24h: 0.05,
    eth6h: 0.02,
    eth24h: 0.05,
    sol6h: 0.02,
    sol24h: 0.05,
    bullScore: regime === "BULL" ? 0.8 : 0.1,
    bearScore: regime === "BEAR" ? 0.8 : 0.1,
    rangeScore: regime === "RANGE" ? 0.8 : 0.1,
    validMarkets: 500,
    ...overrides,
  };
}

function tactical(
  structuralRegime: TacticalContext["structural"],
  state: TacticalContext["state"],
  phase: TacticalContext["phase"],
  overrides: Partial<TacticalContext> = {},
): TacticalContext {
  return {
    structural: structuralRegime,
    state,
    phase,
    localBreadth: structuralRegime === "BEAR" ? 0.25 : 0.45,
    breadthVelocity: structuralRegime === "BEAR" ? -0.03 : 0.02,
    fiveMinuteConfirmed: true,
    reasons: [],
    ...overrides,
  };
}

function named(fragment: string) {
  const found = candidates().find((candidate) => candidate.name.includes(fragment));
  if (!found) throw new Error(`missing candidate ${fragment}`);
  // Entry unit tests use compact hand-built histories. Production candidates
  // retain the frozen seven-day guard; only this detached test copy bypasses it.
  found.parameters.minHistoryBars = 0;
  return found;
}

Deno.test("candidate grid is pre-committed, detached, and excludes wait states", () => {
  const first = candidates();
  const second = candidates();
  assertEquals(first.length, 19);
  assert(first !== second);
  assert(first[0].parameters !== second[0].parameters);
  assert(first.every((candidate) => candidate.state !== "BULL_DECELERATING"));
  assert(first.every((candidate) => candidate.state !== "BEAR_REBOUND"));
  assert(first.some((candidate) => candidate.family === "DONCHIAN_BREAKOUT"));
  assert(first.some((candidate) => candidate.family === "MOMENTUM_ACCELERATION"));
  assert(first.some((candidate) => candidate.family === "COMPRESSION_BREAKOUT"));
  assert(first.every((candidate) => candidate.parameters.minHistoryBars === 7 * 24 * 4));
  assert(CANDIDATE_REGISTRY_HASH_INPUT.startsWith(`${V5_CANDIDATE_REGISTRY_REVISION}\n[`));
});

Deno.test("production candidates fail closed before seven causal days or with NaN history", () => {
  const productionCandidate = candidates().find((candidate) =>
    candidate.name.includes("DONCHIAN_B080")
  );
  if (!productionCandidate) throw new Error("missing production candidate");
  const shortHistory = [bar({ time: 0, close: 99 }), bar({ ret24h: Number.NaN })];
  const decision = signalDecision(
    shortHistory,
    1,
    productionCandidate,
    tactical("BULL", "BULL_TREND", "ACCELERATING"),
    structural("BULL"),
  );
  assertEquals(decision.ok, false);
  assert(decision.reasons.includes("SEVEN_DAY_CAUSAL_HISTORY_REQUIRED"));
  assert(decision.reasons.includes("INVALID_CAUSAL_HISTORY_FEATURES"));
});

Deno.test("BULL Donchian enters only on accelerating trend and preserves an open-ended exit", () => {
  const candidate = named("DONCHIAN_B080");
  const bars = [bar({ time: 0, close: 99, bbUpper: 99.5 }), bar()];
  const decision = signalDecision(
    bars,
    1,
    candidate,
    tactical("BULL", "BULL_TREND", "ACCELERATING", { fiveMinuteConfirmed: false }),
    structural("BULL"),
  );
  assertEquals(decision.ok, true);
  assert(!decision.reasons.includes("FIVE_MINUTE_CONFIRMATION_REQUIRED"));
  assert(decision.stopHint! < bars[1].close);
  assertEquals(decision.targetHint, undefined);

  const decelerating = signalDecision(
    bars,
    1,
    candidate,
    tactical("BULL", "BULL_DECELERATING", "DECELERATING"),
    structural("BULL"),
  );
  assertEquals(decelerating.ok, false);
  assert(decelerating.reasons.includes("BULL_ACCELERATING_ONLY"));
});

Deno.test("BULL Momentum and Compression keep the legacy long-hold risk baselines", () => {
  const momentum = named("MOMENTUM_M60");
  const compression = named("COMPRESSION_P18");
  assertEquals(momentum.parameters.initialStopAtr, 1.6);
  assertEquals(momentum.parameters.maxHoldBars, 160);
  assertEquals(compression.parameters.initialStopAtr, 1.5);
  assertEquals(compression.parameters.maxHoldBars, 160);
  assertEquals(named("DONCHIAN_B080").parameters.maxHoldBars, 192);

  const previous = bar({
    time: 0,
    close: 99,
    bbUpper: 99.5,
    bbCompressionPercentile7d: 0.1,
  });
  const current = bar();
  const context = tactical("BULL", "BULL_TREND", "ACCELERATING");
  assertEquals(
    signalDecision([previous, current], 1, momentum, context, structural("BULL")).ok,
    true,
  );
  assertEquals(
    signalDecision([previous, current], 1, compression, context, structural("BULL")).ok,
    true,
  );
});

Deno.test("RANGE requires a dynamic-percentile up-cycle and a cost-aware mean target", () => {
  const candidate = named("RANGE_TARGET_A60");
  const previous = bar({
    time: 0,
    open: 99.8,
    close: 99.6,
    ret2: -0.004,
    stochK: 7,
    stochD: 9,
  });
  const current = bar({
    open: 99.7,
    close: 100,
    low: 99.5,
    ema20: 100.1,
    ema50: 100,
    adx: 16,
    stochK: 11,
    stochD: 10,
    stochPercentile7d: 0.12,
    rsi: 43,
    rsiSlope2: 0.6,
    rsiPercentile7d: 0.25,
    vwap96: 101,
    dayOpen: 101.1,
    bbMid: 100.9,
    rangeMid20Prev: 101.2,
    high20Prev: 103,
    low20Prev: 98.5,
    low8Prev: 99,
    ret24h: 0.01,
  });
  const context = tactical("RANGE", "RANGE_UP_CYCLE", "UP_CYCLE");
  const decision = signalDecision(
    [previous, current],
    1,
    candidate,
    context,
    structural("RANGE"),
  );
  assertEquals(decision.ok, true);
  assertEquals(decision.targetHint, 100.9);

  const withoutFiveMinuteConfirmation = signalDecision(
    [previous, current],
    1,
    candidate,
    { ...context, fiveMinuteConfirmed: false },
    structural("RANGE"),
  );
  assertEquals(withoutFiveMinuteConfirmation.ok, false);
  assert(
    withoutFiveMinuteConfirmation.reasons.includes("FIVE_MINUTE_CONFIRMATION_REQUIRED"),
  );

  const fixedOversoldOnly = signalDecision(
    [previous, { ...current, stochK: 12, stochD: 10, stochPercentile7d: 0.5 }],
    1,
    candidate,
    context,
    structural("RANGE"),
  );
  assertEquals(fixedOversoldOnly.ok, false);
  assert(fixedOversoldOnly.reasons.includes("DYNAMIC_STOCH_UP_CROSS_REQUIRED"));

  const insufficientRoom = signalDecision(
    [
      previous,
      {
        ...current,
        vwap96: 100.4,
        dayOpen: 100.5,
        bbMid: 100.45,
        rangeMid20Prev: 100.5,
      },
    ],
    1,
    candidate,
    context,
    structural("RANGE"),
  );
  assertEquals(insufficientRoom.ok, false);
  assert(insufficientRoom.reasons.includes("TARGET_ROOM_BELOW_ATR_OR_COST_GATE"));
});

function bearSetup(): PreparedBar[] {
  return [
    bar({ time: 0, open: 105.5, high: 106, low: 104, close: 105 }),
    bar({ time: 1, open: 105, high: 105, low: 102.5, close: 103 }),
    bar({ time: 2, open: 103, high: 103.2, low: 100.5, close: 101 }),
    bar({
      time: 3,
      open: 101,
      high: 101.2,
      low: 97,
      close: 98,
      low8Prev: 99.8,
      ema20: 100,
      vwap96: 100.2,
    }),
    bar({ time: 4, open: 98, high: 99.2, low: 97.8, close: 99, volumeRatio: 1 }),
    bar({ time: 5, open: 99, high: 100, low: 98.8, close: 99.8, volumeRatio: 1.1 }),
    bar({ time: 6, open: 99.8, high: 100.2, low: 99.5, close: 100, volumeRatio: 1.05 }),
    bar({
      time: 7,
      open: 100,
      high: 100.1,
      low: 99.2,
      close: 99.5,
      stochK: 60,
      stochD: 55,
      volumeRatio: 0.9,
    }),
    bar({
      time: 8,
      open: 99,
      high: 99,
      low: 97,
      close: 97.2,
      ema20: 98.5,
      ema50: 101,
      ema20SlopeAtr: -0.1,
      stochK: 40,
      stochD: 50,
      rsi: 42,
      rsiSlope2: -0.6,
      low8Prev: 97.4,
      low20Prev: 96,
      volumeRatio: 1.2,
      ret24h: -0.1,
    }),
  ];
}

Deno.test("BEAR waits through rebound and enters only after completed low rebreak", () => {
  const candidate = named("BEAR_REBREAK_B05");
  const bars = bearSetup();
  const bear = structural("BEAR", { time: 8 });
  const rebreak = signalDecision(
    bars,
    8,
    candidate,
    tactical("BEAR", "BEAR_REBREAK", "REBREAK"),
    bear,
  );
  assertEquals(rebreak.ok, true);
  assert(rebreak.stopHint! > bars[8].close);
  assert(rebreak.targetHint! < bars[8].close);

  const withoutFiveMinuteConfirmation = signalDecision(
    bars,
    8,
    candidate,
    tactical("BEAR", "BEAR_REBREAK", "REBREAK", { fiveMinuteConfirmed: false }),
    bear,
  );
  assertEquals(withoutFiveMinuteConfirmation.ok, false);
  assert(
    withoutFiveMinuteConfirmation.reasons.includes("FIVE_MINUTE_CONFIRMATION_REQUIRED"),
  );

  const rebound = signalDecision(
    bars,
    8,
    candidate,
    tactical("BEAR", "BEAR_REBOUND", "REBOUND"),
    bear,
  );
  assertEquals(rebound.ok, false);
  assert(rebound.reasons.includes("BEAR_REBREAK_ONLY_REBOUND_MUST_WAIT"));

  const noRebreakBars = [...bars];
  noRebreakBars[8] = { ...bars[8], close: 98, low: 97.8, ema20: 98.5 };
  const noRebreak = signalDecision(
    noRebreakBars,
    8,
    candidate,
    tactical("BEAR", "BEAR_REBREAK", "REBREAK"),
    bear,
  );
  assertEquals(noRebreak.ok, false);
  assert(noRebreak.reasons.includes("COMPLETED_PRIOR_LOW_OR_DONCHIAN_REBREAK_REQUIRED"));
});

Deno.test("signal evaluation is invariant to bars after the signal index", () => {
  const candidate = named("DONCHIAN_B080");
  const history = [bar({ time: 0, close: 99 }), bar({ time: 1_000 })];
  const context = tactical("BULL", "BULL_TREND", "ACCELERATING");
  const market = structural("BULL");
  const withoutFuture = signalDecision(history, 1, candidate, context, market);
  const withFuture = signalDecision(
    [...history, bar({ time: 2_000, open: 1, high: 1_000_000, low: 0.01, close: 500_000 })],
    1,
    candidate,
    context,
    market,
  );
  assertEquals(withFuture, withoutFuture);
});
