import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectLatestP10Signal,
  evaluateP10Exit,
  P10_CONFIG,
  P10_HOUR_MS,
  p10ExecutableTicketCapital,
  type P10PreparedBar,
  planP10Entry,
} from "./p10-policy.ts";

Deno.test("P10 permits one executable minimum ticket when slot division falls below it", () => {
  assertEquals(
    p10ExecutableTicketCapital({
      available: 119.90743764675331,
      capital: 119.90743764675331,
      slots: 3,
      maximum: 40,
      minimum: 40,
      step: 0.01,
    }),
    40,
  );
  assertEquals(
    p10ExecutableTicketCapital({
      available: 66.65928212,
      capital: 66.65928212,
      slots: 3,
      maximum: 50,
      minimum: 50,
      step: 0.01,
    }),
    50,
  );
  assertEquals(
    p10ExecutableTicketCapital({
      available: 16.65928212,
      capital: 66.65928212,
      slots: 3,
      maximum: 50,
      minimum: 50,
      step: 0.01,
    }),
    16.65,
  );
});

function directionalBars(direction: 1 | -1) {
  const bars = [];
  let close = 100;
  for (let index = 0; index < 130; index++) {
    const prior = close;
    close += direction * (index % 2 === 0 ? 0.4 : -0.2);
    if (index === 129) close += direction * 1.2;
    bars.push({
      time: (index + 1) * P10_HOUR_MS,
      open: prior,
      high: Math.max(prior, close) + 0.2,
      low: Math.min(prior, close) - 0.25,
      close,
      volume: 10_000,
      quoteVolume: index === 129 ? 10_000_000 : 1_000_000,
    });
  }
  return bars;
}

Deno.test("P10 detects completed-bar long breakouts and keeps spot long-only", () => {
  const bull = directionalBars(1);
  const long = detectLatestP10Signal("binance_spot", bull, bull);
  assertEquals(long?.side, "LONG");

  const bear = directionalBars(-1);
  assertEquals(detectLatestP10Signal("binance_spot", bear, bear), null);
  assertEquals(detectLatestP10Signal("binance_futures", bear, bear)?.side, "SHORT");
});

Deno.test("P10 entry uses 2 ATR stop, 2R partial, 4R final and rejects late gaps", () => {
  const plan = planP10Entry("LONG", 100, 1, 100.25);
  assert(plan.allowed);
  assertEquals(plan.initialRisk, 2);
  assertEquals(plan.stopPrice, 98.25);
  assertEquals(plan.partialTarget, 104.25);
  assertEquals(plan.finalTarget, 108.25);
  assertEquals(planP10Entry("LONG", 100, 1, 100.51).allowed, false);
});

Deno.test("P10 stop wins a same-tick collision", () => {
  const decision = evaluateP10Exit({
    side: "LONG",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 98,
    partialDone: false,
    executablePrice: 97,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: null,
    roundTripCostBps: 20,
  });
  assertEquals(decision.action, "STOP");
  assertEquals(decision.fraction, 1);
});

Deno.test("P10 slow exit updates trail on a completed bar and supports short partial", () => {
  const completed = {
    time: P10_HOUR_MS,
    open: 100,
    high: 104,
    low: 99,
    close: 103.5,
    volume: 1,
    quoteVolume: 100,
    ema20: 101,
    ema50: 100,
    ema100: 99,
    ema20Slope6Pct: 1,
    atr14: 1,
    rsi14: 60,
    ret24Pct: 2,
    ret72Pct: 4,
    efficiency24: 0.5,
    high72Prev: 103,
    low72Prev: 90,
    volumeRatio: 2,
    quoteVolumeMean20: 100,
  } satisfies P10PreparedBar;
  const long = evaluateP10Exit({
    side: "LONG",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 96,
    partialDone: false,
    executablePrice: 101,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: 2 * P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: completed,
    roundTripCostBps: 20,
  });
  assert(long.nextStop >= 101);
  const short = evaluateP10Exit({
    side: "SHORT",
    entryPrice: 100,
    initialRisk: 2,
    currentStop: 104,
    partialDone: false,
    executablePrice: 96,
    entryBarTime: 0,
    openedAtMs: 0,
    nowMs: P10_HOUR_MS,
    lastPolicyBarTime: 0,
    latestCompletedBar: null,
    roundTripCostBps: 18,
  });
  assertEquals(short.action, "TARGET_1");
  assertEquals(short.fraction, P10_CONFIG.partialFraction);
});
