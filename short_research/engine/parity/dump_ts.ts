// Dump production indicator + signal output for a deterministic bar series so the Python
// port can be diffed against the real deployed policy module rather than against a
// re-reading of it. Imports the production file directly -- no copy, no reimplementation.
import {
  prepareP10Bars, p10BenchmarkStates, detectLatestP10Signal, planP10Entry, evaluateP10Exit,
  P10_CONFIG,
} from "../../../supabase/functions/_shared/p10-policy.ts";

// Deterministic LCG so Python can regenerate the identical series.
function series(n: number, seed: number, base: number) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const bars = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 0.02;
    const open = price;
    const close = Math.max(1e-6, open * (1 + drift));
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    const volume = 1000 + rnd() * 9000;
    bars.push({
      time: 1700000000000 + i * 3600000,
      open, high, low, close, volume, quoteVolume: volume * close,
    });
    price = close;
  }
  return bars;
}

const asset = series(400, 12345, 100);
const bench = series(400, 999, 50000);
const prepared = prepareP10Bars(asset);
const states = p10BenchmarkStates(bench);

const out = {
  config: P10_CONFIG,
  inputAsset: asset,
  inputBench: bench,
  prepared: prepared.map((b) => ({
    time: b.time, ema20: b.ema20, ema50: b.ema50, ema100: b.ema100,
    ema20Slope6Pct: b.ema20Slope6Pct, atr14: b.atr14, rsi14: b.rsi14,
    ret24Pct: b.ret24Pct, ret72Pct: b.ret72Pct, efficiency24: b.efficiency24,
    high72Prev: b.high72Prev, low72Prev: b.low72Prev,
    volumeRatio: b.volumeRatio, quoteVolumeMean20: b.quoteVolumeMean20,
  })),
  benchmark: [...states.entries()].map(([time, s]) => ({
    time, regime: s.regime, ret24Pct: s.ret24Pct, ret72Pct: s.ret72Pct,
  })),
  signal: detectLatestP10Signal("binance_futures", asset, bench),
  planLong: planP10Entry("LONG", 100, 2, 100.5),
  planShort: planP10Entry("SHORT", 100, 2, 99.5),
  exitShort: evaluateP10Exit({
    side: "SHORT", entryPrice: 100, initialRisk: 4, currentStop: 104,
    partialDone: false, executablePrice: 92, entryBarTime: 1700000000000,
    openedAtMs: 1700000000000, nowMs: 1700000000000 + 10 * 3600000,
    lastPolicyBarTime: 0, latestCompletedBar: prepared[prepared.length - 1],
    roundTripCostBps: 18,
  }),
};
console.log(JSON.stringify(out));
