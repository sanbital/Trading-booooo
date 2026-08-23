// Per-bar signal eligibility for both sides from the deployed policy module, over series
// deliberately built to reach the gates. A random walk almost never clears the production
// filters, so a parity check run only on noise would prove nothing about the gate logic.
import { detectLatestP10Signal } from "../../../supabase/functions/_shared/p10-policy.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
}

// drift: per-bar % trend. breakoutAt: bar index where range expands and volume spikes.
function build(n: number, seed: number, base: number, drift: number, vol: number,
               breakoutAt: number, breakoutDir: number, volScale = 1) {
  const rnd = lcg(seed);
  const bars = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    let d = drift + (rnd() - 0.5) * vol;
    let volMult = 1;
    if (breakoutAt > 0 && i >= breakoutAt) {
      d += breakoutDir * 0.0035;
      volMult = 3.2;
    }
    const open = price;
    const close = Math.max(1e-6, open * (1 + d));
    const dirUp = close >= open;
    // close near the extreme in the trend direction so closeLocation clears 0.74
    const high = (dirUp ? close : open) * (1 + rnd() * 0.0008);
    const low = (dirUp ? open : close) * (1 - rnd() * 0.0008);
    const volume = (1000 + rnd() * 500) * volMult * volScale;
    bars.push({ time: 1700000000000 + i * 3600000, open, high, low, close,
                volume, quoteVolume: volume * close });
    price = close;
  }
  return bars;
}

const scenarios: Record<string, { asset: any[]; bench: any[] }> = {};
// LONG: benchmark trending up, asset consolidates then breaks out up
scenarios.long_break = {
  bench: build(400, 11, 50000, 0.0012, 0.004, 0, 0, 10),
  asset: build(400, 22, 100, 0.0000, 0.010, 300, +1, 10),
};
// SHORT: benchmark trending down, asset consolidates then breaks down
scenarios.short_break = {
  bench: build(400, 33, 50000, -0.0012, 0.004, 0, 0, 10),
  asset: build(400, 44, 100, 0.0000, 0.010, 300, -1, 10),
};
// mixed / no-trend control
scenarios.chop = {
  bench: build(400, 55, 50000, 0, 0.010, 0, 0, 10),
  asset: build(400, 66, 100, 0, 0.014, 0, 0, 10),
};

const out: any = { scenarios: {} };
for (const [name, s] of Object.entries(scenarios)) {
  const rows = [];
  for (let end = 106; end <= s.asset.length; end++) {
    const sig = detectLatestP10Signal("binance_futures",
      s.asset.slice(0, end), s.bench.slice(0, end));
    rows.push({
      endIndex: end - 1, time: s.asset[end - 1].time,
      side: sig ? sig.side : null,
      score: sig ? sig.score : null,
      referenceClose: sig ? sig.referenceClose : null,
      atr14: sig ? sig.atr14 : null,
      stopReference: sig ? sig.stopReference : null,
    });
  }
  out.scenarios[name] = { asset: s.asset, bench: s.bench, rows };
}
console.log(JSON.stringify(out));
