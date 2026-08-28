import { assert, assertAlmostEquals, assertEquals } from "../../../test-support/assert.ts";
import {
  accumulateStructuralObservation,
  causalRollingPercentile,
  classifyStructuralSeries,
  createStructuralAccumulator,
  finalizeStructuralAccumulator,
  mergeStructuralAccumulators,
  type StructuralClassifierOptions,
  type StructuralMarketObservation,
  type StructuralSnapshot,
} from "./structural.ts";

const TIME = Date.UTC(2026, 0, 1);

function observation(
  symbol: string,
  return6h: number,
  return24h: number,
  overrides: Partial<StructuralMarketObservation> = {},
): StructuralMarketObservation {
  return {
    time: TIME,
    symbol,
    return6h,
    return24h,
    emaStructure: return24h > 0 ? "BULL" : return24h < 0 ? "BEAR" : "FLAT",
    trendPersistence: Math.sign(return24h) * 0.6,
    adxPercentile: 0.5,
    meanReverting: false,
    volatilityPercentile: 0.5,
    extremeMover: false,
    ...overrides,
  };
}

Deno.test("structural shard merge preserves full-market statistics", () => {
  const first = createStructuralAccumulator(TIME, 2);
  const second = createStructuralAccumulator(TIME, 2);
  accumulateStructuralObservation(first, observation("BTCUSDT", 0.01, 0.02));
  accumulateStructuralObservation(
    first,
    observation("ETHUSDT", -0.02, -0.01, {
      adxPercentile: 0.2,
      meanReverting: true,
    }),
  );
  accumulateStructuralObservation(second, observation("SOLUSDT", 0.03, 0.04));
  accumulateStructuralObservation(
    second,
    observation("ADAUSDT", -0.01, -0.03, { extremeMover: true }),
  );

  const serialized = JSON.parse(JSON.stringify(second));
  const merged = mergeStructuralAccumulators(first, serialized);
  const point = finalizeStructuralAccumulator(merged);

  assertEquals(point.expectedMarkets, 4);
  assertEquals(point.validMarkets, 4);
  assertEquals(point.majorCoverage, 3);
  assertAlmostEquals(point.positiveBreadth6h, 0.5);
  assertAlmostEquals(point.negativeBreadth24h, 0.5);
  assertAlmostEquals(point.medianReturn6h, 0);
  assertAlmostEquals(point.medianReturn24h, 0.005);
  assertAlmostEquals(point.lowAdxShare, 0.25);
  assertAlmostEquals(point.meanReversionShare, 0.25);
  assertAlmostEquals(point.extremeMoverShare, 0.25);
  assertAlmostEquals(point.btc24h, 0.02);
  assertAlmostEquals(point.eth24h, -0.01);
  assertAlmostEquals(point.sol24h, 0.04);
  assertEquals(JSON.stringify(merged).includes("null"), false);
});

Deno.test("malformed observations are ignored while timestamp mismatches fail closed", () => {
  const accumulator = createStructuralAccumulator(TIME, 2);
  assertEquals(
    accumulateStructuralObservation(
      accumulator,
      observation("BADUSDT", Number.NaN, 0.01),
    ),
    false,
  );
  assertEquals(accumulator.validMarkets, 0);

  let threw = false;
  try {
    accumulateStructuralObservation(
      accumulator,
      observation("BTCUSDT", 0.01, 0.01, { time: TIME + 1 }),
    );
  } catch {
    threw = true;
  }
  assert(threw, "timestamp mismatch must throw");
});

Deno.test("rolling percentile ranks use prior values only", () => {
  assertEquals(causalRollingPercentile([1, 2, 3, 0], 2, 2), [0.5, 0.5, 1, 0]);
  assertEquals(causalRollingPercentile([4, 4, 4], 4, 1), [0.5, 0.5, 0.5]);

  const prefix = causalRollingPercentile([1, 2, 3, 0], 3, 2);
  const withDifferentFuture = causalRollingPercentile([1, 2, 3, 0, -1_000_000], 3, 2);
  assertEquals(withDifferentFuture.slice(0, prefix.length), prefix);
});

type Mode = "RANGE" | "BULL" | "BEAR";

function snapshot(index: number, mode: Mode): StructuralSnapshot {
  const time = TIME + index * 15 * 60_000;
  const wobble = ((index % 3) - 1) * 0.0001;
  if (mode === "BULL") {
    return {
      time,
      positiveBreadth6h: 0.78,
      negativeBreadth6h: 0.2,
      positiveBreadth24h: 0.82,
      negativeBreadth24h: 0.16,
      meanReturn6h: 0.018 + wobble,
      meanReturn24h: 0.042 + wobble,
      medianReturn6h: 0.014 + wobble,
      medianReturn24h: 0.034 + wobble,
      emaBullShare: 0.8,
      emaBearShare: 0.1,
      trendPersistence: 0.72,
      lowAdxShare: 0.12,
      meanReversionShare: 0.12,
      volatilityPercentile: 0.76,
      extremeMoverShare: 0.04,
      btc6h: 0.016,
      btc24h: 0.038,
      eth6h: 0.019,
      eth24h: 0.044,
      sol6h: 0.024,
      sol24h: 0.052,
      validMarkets: 100,
      expectedMarkets: 100,
      majorCoverage: 3,
    };
  }
  if (mode === "BEAR") {
    return {
      time,
      positiveBreadth6h: 0.18,
      negativeBreadth6h: 0.8,
      positiveBreadth24h: 0.14,
      negativeBreadth24h: 0.84,
      meanReturn6h: -0.02 + wobble,
      meanReturn24h: -0.046 + wobble,
      medianReturn6h: -0.016 + wobble,
      medianReturn24h: -0.038 + wobble,
      emaBullShare: 0.08,
      emaBearShare: 0.84,
      trendPersistence: -0.76,
      lowAdxShare: 0.1,
      meanReversionShare: 0.1,
      volatilityPercentile: 0.82,
      extremeMoverShare: 0.05,
      btc6h: -0.018,
      btc24h: -0.04,
      eth6h: -0.022,
      eth24h: -0.049,
      sol6h: -0.027,
      sol24h: -0.057,
      validMarkets: 100,
      expectedMarkets: 100,
      majorCoverage: 3,
    };
  }
  return {
    time,
    positiveBreadth6h: 0.5 + wobble,
    negativeBreadth6h: 0.5 - wobble,
    positiveBreadth24h: 0.5 - wobble,
    negativeBreadth24h: 0.5 + wobble,
    meanReturn6h: wobble,
    meanReturn24h: -wobble,
    medianReturn6h: wobble * 0.5,
    medianReturn24h: -wobble * 0.5,
    emaBullShare: 0.25,
    emaBearShare: 0.25,
    trendPersistence: 0,
    lowAdxShare: 0.82,
    meanReversionShare: 0.78,
    volatilityPercentile: 0.22,
    extremeMoverShare: 0.01,
    btc6h: wobble,
    btc24h: -wobble,
    eth6h: -wobble,
    eth24h: wobble,
    sol6h: wobble * 0.5,
    sol24h: -wobble * 0.5,
    validMarkets: 100,
    expectedMarkets: 100,
    majorCoverage: 3,
  };
}

const TEST_OPTIONS: StructuralClassifierOptions = {
  rollingLookbackBars: 12,
  minHistoryBars: 4,
  minValidMarkets: 50,
  minUniverseCoverage: 0.5,
  minMajorCoverage: 2,
  breadthVelocityBars: 1,
  breadthAccelerationBars: 1,
  confirmationWindowBars: 3,
  confirmationBars: 2,
  minDirectionalScore: 0.52,
  minRangeScore: 0.52,
  candidateMargin: 0.01,
  switchMargin: 0.02,
  maxAmbiguousBars: 3,
};

Deno.test("structural classifier separates regimes and ignores a one-bar reversal", () => {
  const modes: Mode[] = [
    "RANGE",
    "RANGE",
    "RANGE",
    "RANGE",
    "RANGE",
    "RANGE",
    "BULL",
    "BULL",
    "BULL",
    "BULL",
    "BEAR",
    "BULL",
    "BEAR",
    "BEAR",
    "BEAR",
    "BEAR",
  ];
  const classified = classifyStructuralSeries(
    modes.map((mode, index) => snapshot(index, mode)),
    TEST_OPTIONS,
  );

  assertEquals(classified.slice(0, 4).every((point) => point.regime === "UNKNOWN"), true);
  assert(classified.some((point) => point.regime === "RANGE"));
  assertEquals(classified[8].regime, "BULL");
  assertEquals(classified[10].regime, "BULL", "single bear bar must not flip the regime");
  assertEquals(classified.at(-1)?.regime, "BEAR");
  assert(classified[8].bullScore > classified[8].bearScore);
  assert(classified.at(-1)!.bearScore > classified.at(-1)!.bullScore);
});

Deno.test("structural classification is prefix invariant and therefore causal", () => {
  const prefixModes: Mode[] = [
    "RANGE",
    "RANGE",
    "RANGE",
    "RANGE",
    "BULL",
    "BULL",
    "BULL",
    "BULL",
  ];
  const prefix = prefixModes.map((mode, index) => snapshot(index, mode));
  const prefixResult = classifyStructuralSeries(prefix, TEST_OPTIONS);
  const future = ["BEAR", "BEAR", "BEAR", "BEAR"] as Mode[];
  const fullResult = classifyStructuralSeries(
    [
      ...prefix,
      ...future.map((mode, offset) => snapshot(prefix.length + offset, mode)),
    ],
    TEST_OPTIONS,
  );
  assertEquals(fullResult.slice(0, prefixResult.length), prefixResult);
});

Deno.test("persistent challenger cannot leave an incumbent regime latched forever", () => {
  const modes: Mode[] = [
    "RANGE",
    "RANGE",
    "RANGE",
    "RANGE",
    "BULL",
    "BULL",
    "BULL",
    "BULL",
    "BEAR",
    "BEAR",
    "BEAR",
    "BEAR",
    "BEAR",
    "BEAR",
  ];
  const classified = classifyStructuralSeries(
    modes.map((mode, index) => snapshot(index, mode)),
    {
      ...TEST_OPTIONS,
      confirmationBars: 1,
      candidateMargin: 0,
      // Deliberately unreachable direct switch: maxAmbiguousBars must release
      // the stale incumbent before the confirmed challenger can take over.
      switchMargin: 1,
      maxAmbiguousBars: 2,
    },
  );
  assertEquals(classified[7].regime, "BULL");
  assertEquals(
    classified.slice(8).every((point) => point.regime === "BULL"),
    false,
    "a persistent semantic BEAR challenger must eventually release BULL",
  );
  assertEquals(classified.at(-1)?.regime, "BEAR");
});

Deno.test("coverage failure emits UNKNOWN immediately and chronology fails closed", () => {
  const snapshots = Array.from({ length: 8 }, (_, index) => snapshot(index, "RANGE"));
  snapshots[7] = { ...snapshots[7], validMarkets: 20 };
  const classified = classifyStructuralSeries(snapshots, {
    ...TEST_OPTIONS,
    confirmationBars: 1,
  });
  assertEquals(classified[7].regime, "UNKNOWN");

  let threw = false;
  try {
    classifyStructuralSeries([snapshots[1], snapshots[0]], TEST_OPTIONS);
  } catch {
    threw = true;
  }
  assert(threw, "non-chronological input must throw");
});
