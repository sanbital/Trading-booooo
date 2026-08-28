import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { maxDrawdownBps, summarizeByFoldSplitCandidate, summarizeTrades } from "./metrics.ts";
import type { V5Trade } from "./types.ts";

function trade(overrides: Partial<V5Trade> = {}): V5Trade {
  return {
    market: "TESTUSDT",
    candidate: "TEST",
    family: "RANGE_CYCLE",
    state: "RANGE_UP_CYCLE",
    fold: 1,
    split: "TEST",
    side: "LONG",
    signalTime: 0,
    entryTime: 1,
    exitTime: 2,
    grossBps: 100,
    netBps: 86,
    stressNetBps: 77,
    mfeBps: 120,
    maeBps: 20,
    mfeCapture: 86 / 120,
    givebackBps: 34,
    holdBars: 2,
    exitReason: "TARGET",
    ...overrides,
  };
}

Deno.test("summarizeTrades emits every requested cost-aware performance metric", () => {
  const trades = [
    trade(),
    trade({
      market: "LOSSUSDT",
      signalTime: 3,
      entryTime: 4,
      exitTime: 5,
      grossBps: -36,
      netBps: -50,
      stressNetBps: -59,
      mfeBps: 10,
      maeBps: 55,
      mfeCapture: -5,
      givebackBps: 60,
      holdBars: 3,
      exitReason: "STOP",
    }),
  ];
  const summary = summarizeTrades(trades, { regimeBars: 25, eligibleBars: 100 });
  assertEquals(summary.trades, 2);
  assertEquals(summary.wins, 1);
  assertEquals(summary.losses, 1);
  assertAlmostEquals(summary.winRate, 0.5);
  assertAlmostEquals(summary.grossPnlBps, 64);
  assertAlmostEquals(summary.netPnlBps, 36);
  assertAlmostEquals(summary.stressNetPnlBps, 18);
  assertAlmostEquals(summary.profitFactor!, 86 / 50);
  assertAlmostEquals(summary.averageReturnBps, 18);
  assertAlmostEquals(summary.maxDrawdownBps, 50);
  assertAlmostEquals(summary.averageMfeBps, 65);
  assertAlmostEquals(summary.averageMaeBps, 37.5);
  assertAlmostEquals(summary.mfeCaptureRatio!, ((86 / 120) - 5) / 2);
  assertAlmostEquals(summary.profitGivebackBps, 47);
  assertAlmostEquals(summary.averageHoldBars, 2.5);
  assertAlmostEquals(summary.stopHitRate, 0.5);
  assertAlmostEquals(summary.targetHitRate, 0.5);
  assertAlmostEquals(summary.timeStopRate, 0);
  assertAlmostEquals(summary.regimeFrequency, 0.25);
});

Deno.test("drawdown batches simultaneous exits instead of depending on market order", () => {
  const simultaneous = [
    trade({ market: "AUSDT", exitTime: 10, netBps: 100 }),
    trade({ market: "BUSDT", exitTime: 10, netBps: -150 }),
  ];
  assertAlmostEquals(maxDrawdownBps(simultaneous), 50);
  assertAlmostEquals(maxDrawdownBps([...simultaneous].reverse()), 50);
});

Deno.test("exit frequencies treat trail as stop and only TIME_STOP as time stop", () => {
  const summary = summarizeTrades([
    trade({ exitReason: "TRAIL_CLOSE_EXIT" }),
    trade({ exitReason: "TIME_STOP" }),
    trade({ exitReason: "MAX_HOLD" }),
  ]);
  assertAlmostEquals(summary.stopHitRate, 1 / 3);
  assertAlmostEquals(summary.timeStopRate, 1 / 3);
});

Deno.test("zero-trade metrics are finite and do not fabricate PF or capture", () => {
  assertEquals(summarizeTrades([]), {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossPnlBps: 0,
    netPnlBps: 0,
    stressNetPnlBps: 0,
    profitFactor: null,
    averageReturnBps: 0,
    maxDrawdownBps: 0,
    averageMfeBps: 0,
    averageMaeBps: 0,
    mfeCaptureRatio: null,
    profitGivebackBps: 0,
    averageHoldBars: 0,
    stopHitRate: 0,
    targetHitRate: 0,
    timeStopRate: 0,
    regimeFrequency: 0,
  });
});

Deno.test("metric grouping never mixes folds, splits, or candidates", () => {
  const groups = summarizeByFoldSplitCandidate([
    trade({ fold: 1, split: "TRAIN", candidate: "A" }),
    trade({ fold: 1, split: "VALIDATION", candidate: "A" }),
    trade({ fold: 2, split: "TRAIN", candidate: "A" }),
    trade({ fold: 1, split: "TRAIN", candidate: "B" }),
  ]);
  assertEquals(groups.length, 4);
  assertEquals(groups.map((group) => group.summary.trades), [1, 1, 1, 1]);
});
