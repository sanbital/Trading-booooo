import { assert, assertEquals } from "../../../test-support/assert.ts";
import { prepareBars, rollingPercentileRanks } from "./indicators.ts";
import { classifyTactical, mapRouterState } from "./tactical.ts";
import {
  type Bar,
  BAR_MS,
  FIVE_MINUTE_MS,
  type FiveMinutePoint,
  type PreparedBar,
} from "./types.ts";

function marketBars(count: number, start = Date.UTC(2026, 0, 1)): Bar[] {
  const bars: Bar[] = [];
  let priorClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.02 + Math.sin(i / 7) * 0.3;
    const open = priorClose;
    const high = Math.max(open, close) + 0.25;
    const low = Math.min(open, close) - 0.25;
    const volume = 1_000 + (i % 11) * 20;
    bars.push({
      time: start + i * BAR_MS,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * (open + close) / 2,
    });
    priorClose = close;
  }
  return bars;
}

function prepared(overrides: Partial<PreparedBar> = {}): PreparedBar {
  return {
    time: Date.UTC(2026, 0, 1),
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1_000,
    quoteVolume: 100_000,
    atr: 1,
    atrPct: 0.01,
    atrPercentile7d: 0.5,
    rsi: 55,
    rsiSlope2: 1,
    rsiPercentile7d: 0.5,
    ema20: 99.5,
    ema50: 99,
    ema20SlopeAtr: 0.2,
    stochK: 55,
    stochD: 50,
    stochPercentile7d: 0.5,
    adx: 20,
    vwap96: 100,
    dayOpen: 100,
    vwapDeviationAtr: 0,
    dayOpenDeviationAtr: 0,
    qv24: 50_000_000,
    volumeRatio: 1.1,
    ret2: 0.005,
    ret4: 0.01,
    ret6h: 0.02,
    ret24h: 0.03,
    high20Prev: 101,
    low20Prev: 97,
    high8Prev: 101,
    low8Prev: 97,
    rangeMid20Prev: 99,
    bbMid: 100,
    bbUpper: 102,
    bbLower: 98,
    bbCompressionPercentile7d: 0.5,
    ...overrides,
  };
}

Deno.test("rolling seven-day percentile is causal and gives ties their mid-rank", () => {
  assertEquals(rollingPercentileRanks([1, 2, 3], 2), [0.5, 0.75, 0.75]);
  assertEquals(rollingPercentileRanks([4, 4, 4], 3), [0.5, 0.5, 0.5]);
  assertEquals(rollingPercentileRanks([1, 2, 3], 2).slice(0, 2), rollingPercentileRanks([1, 2], 2));
});

Deno.test("preparing an appended future bar cannot alter any historical indicator", () => {
  const source = marketBars(720);
  const before = prepareBars(source);
  const last = source[source.length - 1];
  const future: Bar = {
    time: last.time + BAR_MS,
    open: last.close,
    high: last.close * 2,
    low: last.close * 0.5,
    close: last.close * 1.5,
    volume: 100_000,
    quoteVolume: last.close * 150_000,
  };
  const after = prepareBars([...source, future]);
  assertEquals(after.slice(0, source.length), before);
});

Deno.test("Donchian and swing levels exclude the current bar high and low", () => {
  const source = marketBars(40);
  const baseline = prepareBars(source);
  const changed = source.slice();
  const current = changed[changed.length - 1];
  changed[changed.length - 1] = {
    ...current,
    high: current.high * 3,
    low: current.low * 0.5,
  };
  const preparedChanged = prepareBars(changed);
  assertEquals(preparedChanged.at(-1)!.high20Prev, baseline.at(-1)!.high20Prev);
  assertEquals(preparedChanged.at(-1)!.low20Prev, baseline.at(-1)!.low20Prev);
  assertEquals(preparedChanged.at(-1)!.high8Prev, baseline.at(-1)!.high8Prev);
  assertEquals(preparedChanged.at(-1)!.low8Prev, baseline.at(-1)!.low8Prev);
});

Deno.test("UTC day open and rolling VWAP contain no later trades", () => {
  const start = Date.UTC(2026, 0, 1, 23, 45);
  const source = marketBars(4, start);
  source[1] = { ...source[1], open: 123, high: 124, low: 99, close: 101 };
  const firstPass = prepareBars(source.slice(0, 2));
  const fullPass = prepareBars(source);
  assertEquals(firstPass[1].dayOpen, 123);
  assertEquals(fullPass[1].dayOpen, 123);
  assertEquals(fullPass[1].vwap96, firstPass[1].vwap96);
});

Deno.test("structural direction and tactical timing map only to the five router states", () => {
  assertEquals(mapRouterState("BULL", "ACCELERATING"), "BULL_TREND");
  assertEquals(mapRouterState("BULL", "DECELERATING"), "BULL_DECELERATING");
  assertEquals(mapRouterState("RANGE", "UP_CYCLE"), "RANGE_UP_CYCLE");
  assertEquals(mapRouterState("BEAR", "REBOUND"), "BEAR_REBOUND");
  assertEquals(mapRouterState("BEAR", "REBREAK"), "BEAR_REBREAK");
  assertEquals(mapRouterState("BULL", "REBREAK"), "NO_TRADE");
  assertEquals(mapRouterState("RANGE", "ACCELERATING"), "NO_TRADE");
  assertEquals(mapRouterState("UNKNOWN", "UP_CYCLE"), "NO_TRADE");
});

Deno.test("bull acceleration maps to BULL_TREND without fabricating 5m confirmation", () => {
  const previous = prepared({ time: 0, close: 100, volumeRatio: 1 });
  const current = prepared({
    time: BAR_MS,
    open: 100,
    close: 102,
    high: 102.2,
    ema20: 101,
    ema50: 100,
    ema20SlopeAtr: 0.3,
    ret4: 0.01,
    rsiSlope2: 3,
    volumeRatio: 1.2,
  });
  const context = classifyTactical("BULL", current, previous, 0.65, 0.02);
  assertEquals(context.phase, "ACCELERATING");
  assertEquals(context.state, "BULL_TREND");
  assertEquals(context.fiveMinuteConfirmed, false);
  assert(context.reasons.some((reason) => reason.includes("no proxy fabricated")));
});

Deno.test("bull breadth and momentum decay maps to BULL_DECELERATING, never SHORT", () => {
  const previous = prepared({ time: 0, stochK: 70, stochD: 65, volumeRatio: 1.2 });
  const current = prepared({
    time: BAR_MS,
    close: 100.5,
    ret2: -0.005,
    rsiSlope2: -3,
    stochK: 58,
    stochD: 62,
    volumeRatio: 0.8,
  });
  const context = classifyTactical("BULL", current, previous, 0.58, -0.05);
  assertEquals(context.phase, "DECELERATING");
  assertEquals(context.state, "BULL_DECELERATING");
});

Deno.test("range needs a dynamic washout, mean location, reversal, and breadth turn", () => {
  const previous = prepared({
    time: 0,
    close: 98.7,
    stochK: 18,
    stochD: 24,
    stochPercentile7d: 0.10,
  });
  const current = prepared({
    time: BAR_MS,
    open: 98.8,
    close: 99.2,
    high: 99.4,
    low: 98.5,
    ema20: 99.7,
    ema50: 100,
    stochK: 29,
    stochD: 23,
    stochPercentile7d: 0.18,
    rsiSlope2: 3,
    vwap96: 100,
    dayOpen: 100.2,
    rangeMid20Prev: 100,
    low20Prev: 97,
  });
  const context = classifyTactical("RANGE", current, previous, 0.48, 0.04);
  assertEquals(context.phase, "UP_CYCLE");
  assertEquals(context.state, "RANGE_UP_CYCLE");

  const noLocation = classifyTactical(
    "RANGE",
    { ...current, close: 101, open: 100.5, vwap96: 100, dayOpen: 100, rangeMid20Prev: 100 },
    previous,
    0.48,
    0.04,
  );
  assertEquals(noLocation.state, "NO_TRADE");

  const decelerating = classifyTactical(
    "RANGE",
    {
      ...current,
      close: 99.1,
      rsiSlope2: -1,
      stochK: 35,
      stochD: 30,
    },
    { ...previous, stochK: 42, stochD: 32 },
    0.51,
    -0.01,
  );
  assertEquals(decelerating.phase, "DECELERATING");
  assertEquals(decelerating.state, "NO_TRADE");
});

Deno.test("bear rebound is a wait state and only a completed-low rebreak enables SHORT timing", () => {
  const reboundPrevious = prepared({
    time: 0,
    close: 98,
    high: 99,
    low: 97.2,
    stochK: 45,
    stochD: 48,
  });
  const reboundCurrent = prepared({
    time: BAR_MS,
    open: 98,
    close: 98.6,
    high: 99,
    low: 97.5,
    ema20: 100,
    ema50: 102,
    ema20SlopeAtr: -0.2,
    vwap96: 99.5,
    high8Prev: 103,
    low8Prev: 97,
    rsiSlope2: 3,
    stochK: 55,
    stochD: 50,
  });
  const rebound = classifyTactical("BEAR", reboundCurrent, reboundPrevious, 0.35, 0.02);
  assertEquals(rebound.phase, "REBOUND");
  assertEquals(rebound.state, "BEAR_REBOUND");

  const failurePrevious = prepared({
    time: 0,
    open: 97.5,
    close: 98,
    high: 100.5,
    low: 97.2,
    stochK: 72,
    stochD: 65,
  });
  const rebreakCurrent = prepared({
    time: BAR_MS,
    open: 98,
    close: 96.5,
    high: 98.2,
    low: 96.2,
    ema20: 100,
    ema50: 102,
    ema20SlopeAtr: -0.3,
    vwap96: 99.5,
    high8Prev: 101,
    low8Prev: 97,
    rsiSlope2: -4,
    stochK: 55,
    stochD: 62,
  });
  const rebreak = classifyTactical("BEAR", rebreakCurrent, failurePrevious, 0.28, -0.05);
  assertEquals(rebreak.phase, "REBREAK");
  assertEquals(rebreak.state, "BEAR_REBREAK");

  const unconfirmed = classifyTactical(
    "BEAR",
    { ...rebreakCurrent, close: 97.1, low: 96.9 },
    failurePrevious,
    0.28,
    -0.05,
  );
  assertEquals(unconfirmed.state, "NO_TRADE");
});

Deno.test("only an actual causal 5m observation can set fiveMinuteConfirmed", () => {
  const previous = prepared({ time: 0, close: 100 });
  const current = prepared({
    time: BAR_MS,
    close: 102,
    ema20: 101,
    ema50: 100,
    ema20SlopeAtr: 0.3,
    ret4: 0.01,
    rsiSlope2: 2,
  });
  const confirming: FiveMinutePoint = {
    time: current.time + 2 * FIVE_MINUTE_MS,
    ret3Atr: 0.3,
    rsiSlope: 1,
    stochK: 60,
    stochD: 50,
    ema20SlopeAtr: 0.1,
    volumeRatio: 1.2,
    breakout: true,
    rebreak: false,
  };
  assertEquals(
    classifyTactical("BULL", current, previous, 0.6, 0.02, confirming).fiveMinuteConfirmed,
    true,
  );

  const nextBarObservation = { ...confirming, time: current.time + BAR_MS };
  const ignored = classifyTactical("BULL", current, previous, 0.6, 0.02, nextBarObservation);
  assertEquals(ignored.fiveMinuteConfirmed, false);
  assert(ignored.reasons.some((reason) => reason.includes("ignored")));
});
