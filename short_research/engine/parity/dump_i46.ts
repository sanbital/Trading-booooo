// Per-bar I46 verdicts from the deployed market-v2-signal logic, over series built to
// reach the gates. The module under test is the repo file with only its Deno entrypoint
// stripped -- the gate functions themselves are byte-for-byte the deployed ones.
import { prepare, bench, detectI46, detectP10 } from "./_v2signal_pure.ts";

function lcg(seed: number) { let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); }

function build(n: number, seed: number, base: number, drift: number, vol: number,
               breakAt: number, dir: number, volScale = 1) {
  const r = lcg(seed); const bars = []; let price = base;
  for (let i = 0; i < n; i++) {
    let d = drift + (r() - 0.5) * vol; let m = 1;
    if (breakAt && i >= breakAt) { d += dir * 0.0035; m = 3.2; }
    const o = price, c = Math.max(1e-8, o * (1 + d)), up = c >= o;
    const h = (up ? c : o) * (1 + r() * 0.0008), l = (up ? o : c) * (1 - r() * 0.0008);
    const v = (1000 + r() * 500) * m * volScale;
    bars.push({ time: 1700000000000 + i * 3600000, open: o, high: h, low: l, close: c,
                volume: v, quoteVolume: v * c });
    price = c;
  }
  return bars;
}

const scen: Record<string, { asset: any[]; bench: any[] }> = {
  short_break: { bench: build(400, 33, 50000, -0.0012, 0.004, 0, 0, 10),
                 asset: build(400, 44, 100, 0, 0.010, 300, -1, 10) },
  long_break:  { bench: build(400, 11, 50000, 0.0012, 0.004, 0, 0, 10),
                 asset: build(400, 22, 100, 0, 0.010, 300, +1, 10) },
  mild_down:   { bench: build(400, 77, 50000, -0.0004, 0.004, 0, 0, 10),
                 asset: build(400, 88, 100, -0.0003, 0.008, 0, 0, 10) },
  chop:        { bench: build(400, 55, 50000, 0, 0.010, 0, 0, 10),
                 asset: build(400, 66, 100, 0, 0.014, 0, 0, 10) },
};

const out: any = { scenarios: {} };
for (const [name, s] of Object.entries(scen)) {
  const rows = [];
  for (let end = 106; end <= s.asset.length; end++) {
    const i46 = detectI46("binance_futures", s.asset.slice(0, end), s.bench.slice(0, end));
    const p10 = detectP10("binance_futures", s.asset.slice(0, end), s.bench.slice(0, end));
    rows.push({ endIndex: end - 1, time: s.asset[end - 1].time,
      i46_side: i46 ? i46.side : null, i46_score: i46 ? i46.score : null,
      i46_stop: i46 ? i46.stopReference : null, i46_atr: i46 ? i46.atr14 : null,
      p10_side: p10 ? p10.side : null });
  }
  out.scenarios[name] = { asset: s.asset, bench: s.bench, rows };
}
console.log(JSON.stringify(out));
