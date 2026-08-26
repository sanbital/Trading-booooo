import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BINANCE_FUTURES_LIVE_QUALITY_GUARD,
  checkS096ShortSignal,
  evaluateS096ShortExit,
  isS096SignalEvidence,
  planS096ShortEntry,
  resolveFixedShortCurrentStop,
  S096_RESEARCH_PROTOCOL,
  S096_SHORT_CONFIG,
  S096_SHORT_REVISION,
  S096_SHORT_STRATEGY_KEY,
  type S096PreparedBar,
  selectCombinedLongS096Candidate,
} from "./s096-short-policy.ts";

const ROOT = new URL("../../../", import.meta.url);

function eligibleBars(): S096PreparedBar[] {
  const bars = Array.from({ length: 106 }, (): S096PreparedBar => ({
    open: 101,
    high: 102,
    low: 98,
    close: 100,
    atr14: 2,
    rsi14: 50,
    ret24Pct: -2,
    volumeRatio: 1,
    quoteVolumeMean20: 500_000,
    efficiency24: 0.2,
  }));
  bars[102].rsi14 = 43;
  bars[103].rsi14 = 42;
  bars[104].rsi14 = 41;
  bars[105].rsi14 = 40;
  return bars;
}

function liveEligibleBars(): S096PreparedBar[] {
  const bars = eligibleBars();
  bars.at(-1)!.volumeRatio = 1.4;
  bars.at(-1)!.efficiency24 = 0.4;
  return bars;
}

function cloneBars(bars = eligibleBars()): S096PreparedBar[] {
  return bars.map((bar) => ({ ...bar }));
}

Deno.test("S096 live constants match the frozen research definition", async () => {
  const registry = JSON.parse(
    await Deno.readTextFile(
      new URL("short_research/strategy_definitions_short_v4_100.json", ROOT),
    ),
  );
  const spec = registry.strategies.find((row: Record<string, unknown>) =>
    row.strategy_id === "S096"
  );
  assert(spec);
  assertEquals(registry.protocol, S096_RESEARCH_PROTOCOL);
  assertEquals(spec.min_history_bars, S096_SHORT_CONFIG.minHistoryBars);
  assertEquals(spec.stop.mult, S096_SHORT_CONFIG.stopAtr);
  assertEquals(spec.take_profit.r, S096_SHORT_CONFIG.targetR);
  assertEquals(spec.entry.max_entry_gap_atr, S096_SHORT_CONFIG.maxEntryGapAtr);
  assertEquals(spec.entry.max_initial_risk_pct, S096_SHORT_CONFIG.maxInitialRiskPct);
  assertEquals(spec.entry.params.rsi_falling_bars, S096_SHORT_CONFIG.rsiFallingBars);
  assertEquals(spec.entry.params.rsi_max, S096_SHORT_CONFIG.maxRsi14);
  assertEquals(spec.filters.min_volume_ratio, S096_SHORT_CONFIG.minVolumeRatio);
  assertEquals(
    spec.filters.liquidity_floor_quote_mean20,
    S096_SHORT_CONFIG.minQuoteVolumeMean20,
  );
  assertEquals(spec.max_holding_bars, S096_SHORT_CONFIG.maxHoldBars);
  assertEquals(spec.partial_exit.enabled, false);
  assertEquals(spec.breakeven.enabled, false);
  assertEquals(spec.trailing.method, "NONE");
});

Deno.test("S096 accepts the exact boundary fixture and freezes research score", () => {
  const check = checkS096ShortSignal(eligibleBars(), 0);
  assert(check);
  assertEquals(check.score, 2.45);
  assertEquals(check.atrPct, 2);
  assertEquals(check.rsiPath, [40, 41, 42, 43]);
});

Deno.test("futures live quality guard thresholds are fail-closed and explicit", () => {
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.longMinRelativeRet24Pct, 2);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.longMinEfficiency24, 0.25);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.longMinVolumeRatio, 1.2);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.longMinDirectionalCloseLocation, 0.74);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.shortMinEfficiency24, 0.35);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.shortMinVolumeRatio, 1.3);
  assertEquals(BINANCE_FUTURES_LIVE_QUALITY_GUARD.shortMinDirectionalCloseLocation, 0.25);
});

Deno.test("combined producer route emits S096 only on futures and never displaces qualified LONG", () => {
  const short = selectCombinedLongS096Candidate({
    venue: "binance_futures",
    bars: liveEligibleBars(),
    btcRet24Pct: 0,
    longCheck: null,
    longStrategyKey: "I46_HYBRID_SCORE_L1",
    longStrategyRevision: "I46-LIVE-1.0.0",
    longStopAtr: 2,
  });
  assert(short);
  assert(short.side === "SHORT");
  assertEquals(short.strategyKey, S096_SHORT_STRATEGY_KEY);
  assertEquals(short.strategyRevision, S096_SHORT_REVISION);
  assertEquals(short.stopAtr, 1.25);

  assertEquals(
    selectCombinedLongS096Candidate({
      venue: "binance_spot",
      bars: eligibleBars(),
      btcRet24Pct: 0,
      longCheck: null,
      longStrategyKey: "I46_HYBRID_SCORE_L1",
      longStrategyRevision: "I46-LIVE-1.0.0",
      longStopAtr: 2,
    }),
    null,
  );

  const longCheck = { score: 7, rel24: 3.0, dl: 0.8 };
  const long = selectCombinedLongS096Candidate({
    venue: "binance_futures",
    bars: liveEligibleBars(),
    btcRet24Pct: 0,
    longCheck,
    longStrategyKey: "I46_HYBRID_SCORE_L1",
    longStrategyRevision: "I46-LIVE-1.0.0",
    longStopAtr: 2,
  });
  assert(long);
  assert(long.side === "LONG");
  assertEquals(long.check, longCheck);
  assertEquals(long.strategyKey, "I46_HYBRID_SCORE_L1");
  assertEquals(long.strategyRevision, "I46-LIVE-1.0.0");
  assertEquals(long.stopAtr, 2);
});

Deno.test("production-valid research signals are blocked when live quality is weak", () => {
  const weakShort = selectCombinedLongS096Candidate({
    venue: "binance_futures",
    bars: eligibleBars(),
    btcRet24Pct: 0,
    longCheck: null,
    longStrategyKey: "I46_HYBRID_SCORE_L1",
    longStrategyRevision: "I46-LIVE-1.0.0",
    longStopAtr: 2,
  });
  assertEquals(weakShort, null);

  const bars = liveEligibleBars();
  // Isolate the LONG live guard: this fixture must not be eligible for the S096 fallback.
  bars.at(-1)!.ret24Pct = 2;
  bars.at(-1)!.rsi14 = 60;
  const weakLong = selectCombinedLongS096Candidate({
    venue: "binance_futures",
    bars,
    btcRet24Pct: 0,
    longCheck: { score: 7, rel24: 1.99, dl: 0.9 },
    longStrategyKey: "I46_HYBRID_SCORE_L1",
    longStrategyRevision: "I46-LIVE-1.0.0",
    longStopAtr: 2,
  });
  assertEquals(weakLong, null);
});

Deno.test("frozen ETHUSDT research trade remains executable when it also passes live quality", () => {
  const bars = eligibleBars();
  const rsi = [35.71407603383541, 34.32973995516818, 33.44738047933154, 26.66214572217369];
  for (let offset = 0; offset < rsi.length; offset++) {
    bars[bars.length - rsi.length + offset].rsi14 = rsi[offset];
  }
  Object.assign(bars.at(-1)!, {
    open: 1881.85,
    high: 1889.72,
    low: 1863.78,
    close: 1866.22,
    atr14: 12.966868067775831,
    ret24Pct: -3.24099277763088,
    volumeRatio: 2.669042843370005,
    quoteVolumeMean20: 285_141_785.65654296,
    efficiency24: 0.5313217169570766,
  });
  const signal = selectCombinedLongS096Candidate({
    venue: "binance_futures",
    bars,
    btcRet24Pct: -2.6890926966162576,
    longCheck: null,
    longStrategyKey: "I46_HYBRID_SCORE_L1",
    longStrategyRevision: "I46-LIVE-1.0.0",
    longStopAtr: 2,
  });
  assert(signal);
  assert(signal.side === "SHORT");
  assertEquals(signal.strategyKey, S096_SHORT_STRATEGY_KEY);
  assertAlmostEquals(signal.check.score, 4.439575205430458, 1e-12);
  assertAlmostEquals(
    bars.at(-1)!.close + signal.stopAtr * bars.at(-1)!.atr14,
    1882.4285850847198,
    1e-12,
  );
});

Deno.test("S096 requires 106 completed bars", () => {
  assertEquals(checkS096ShortSignal(eligibleBars().slice(1), 0), null);
  assert(checkS096ShortSignal(eligibleBars(), 0));
});

Deno.test("S096 signal gate fails closed when any exact condition is broken", async (t) => {
  const cases: Array<[string, (bars: S096PreparedBar[]) => void, number]> = [
    ["RSI above 40", (bars) => bars.at(-1)!.rsi14 = 40.01, 0],
    ["RSI equal step", (bars) => bars.at(-2)!.rsi14 = 40, 0],
    ["RSI below 14", (bars) => bars.at(-1)!.rsi14 = 13.99, 0],
    ["non-bearish candle", (bars) => bars.at(-1)!.open = bars.at(-1)!.close, 0],
    ["BTC positive", () => {}, 0.0001],
    ["volume ratio below one", (bars) => bars.at(-1)!.volumeRatio = 0.999, 0],
    ["liquidity below floor", (bars) => bars.at(-1)!.quoteVolumeMean20 = 499_999, 0],
    ["ATR below floor", (bars) => bars.at(-1)!.atr14 = 0.1499, 0],
    ["effective ATR risk above 5%", (bars) => bars.at(-1)!.atr14 = 4.0001, 0],
    ["ret24 above ceiling", (bars) => bars.at(-1)!.ret24Pct = -0.1999, 0],
    ["ret24 below floor", (bars) => bars.at(-1)!.ret24Pct = -20.0001, 0],
    ["previous ATR invalid", (bars) => bars.at(-2)!.atr14 = 0, 0],
    ["zero range", (bars) => bars.at(-1)!.high = bars.at(-1)!.low, 0],
  ];
  for (const [name, mutate, btcRet24Pct] of cases) {
    await t.step(name, () => {
      const bars = cloneBars();
      mutate(bars);
      assertEquals(checkS096ShortSignal(bars, btcRet24Pct), null);
    });
  }
});

Deno.test("S096 inclusive numeric boundaries remain research-eligible", () => {
  for (
    const mutate of [
      (bars: S096PreparedBar[]) => bars.at(-1)!.atr14 = 0.15,
      (bars: S096PreparedBar[]) => bars.at(-1)!.atr14 = 4,
      (bars: S096PreparedBar[]) => bars.at(-1)!.ret24Pct = -0.2,
      (bars: S096PreparedBar[]) => bars.at(-1)!.ret24Pct = -20,
    ]
  ) {
    const bars = cloneBars();
    mutate(bars);
    assert(checkS096ShortSignal(bars, 0));
  }
});

Deno.test("S096 entry is a 1.25 ATR stop and full 1.5R target", () => {
  const plan = planS096ShortEntry(100, 2, 99.5);
  assert(plan.allowed);
  assertEquals(plan.initialRisk, 2.5);
  assertEquals(plan.stopPrice, 102);
  assertEquals(plan.partialTarget, 95.75);
  assertEquals(plan.finalTarget, 95.75);
  assert(planS096ShortEntry(100, 2, 99).allowed);
  assertEquals(planS096ShortEntry(100, 2, 98.99).allowed, false);
  assert(planS096ShortEntry(100, 4, 100).allowed);
  assertEquals(planS096ShortEntry(100, 4.01, 100).allowed, false);
});

Deno.test("fixed SHORT exits ignore a stale pre-fill trailing stop", () => {
  assertEquals(resolveFixedShortCurrentStop(102.5, 101.5), 102.5);
});

Deno.test("S096 exits the full position at stop, 1.5R, or 96 hours only", () => {
  const base = {
    entryPrice: 100,
    initialRisk: 2.5,
    currentStop: 102.5,
    openedAtMs: 1,
    lastPolicyBarTime: 0,
  };
  const stop = evaluateS096ShortExit({ ...base, executablePrice: 102.5, nowMs: 2 });
  assertEquals(stop.action, "STOP");
  assertEquals(stop.fraction, 1);
  const target = evaluateS096ShortExit({ ...base, executablePrice: 96.25, nowMs: 2 });
  assertEquals(target.action, "TARGET_2");
  assertEquals(target.fraction, 1);
  assertEquals(target.nextStop, base.currentStop);
  const hold = evaluateS096ShortExit({
    ...base,
    executablePrice: 100,
    nowMs: base.openedAtMs + 96 * 3_600_000 - 1,
  });
  assertEquals(hold.action, "NONE");
  const timed = evaluateS096ShortExit({
    ...base,
    executablePrice: 100,
    nowMs: base.openedAtMs + 96 * 3_600_000,
  });
  assertEquals(timed.action, "TIME");
  assertEquals(timed.fraction, 1);
});

Deno.test("S096 evidence requires the exact strategy and revision", () => {
  assert(isS096SignalEvidence({
    entry_strategy_key: S096_SHORT_STRATEGY_KEY,
    entry_strategy_revision: S096_SHORT_REVISION,
  }));
  assertEquals(isS096SignalEvidence({ entry_strategy_key: S096_SHORT_STRATEGY_KEY }), false);
  assertEquals(
    isS096SignalEvidence({
      entry_strategy_key: "S37_I46_FIXED_1R_BTC24_BEAR",
      entry_strategy_revision: "S37-LIVE-1.0.0",
    }),
    false,
  );
});
