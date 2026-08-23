import { prepareP10Bars, p10BenchmarkStates, P10_CONFIG } from "../../../supabase/functions/_shared/p10-policy.ts";
const raw = JSON.parse(await Bun.file(new URL("./ts_gates.json", import.meta.url)).text());
const s = raw.scenarios.long_break;
const bars = prepareP10Bars(s.asset);
const states = p10BenchmarkStates(s.bench);
for (const i of [305, 310, 320, 350, 399]) {
  const b = bars[i], p = bars[i-1], st = states.get(b.time);
  const cl = (b.close-b.low)/(b.high-b.low);
  console.log(JSON.stringify({
    i, regime: st?.regime, bRet24: st?.ret24Pct?.toFixed(3), bRet72: st?.ret72Pct?.toFixed(3),
    volRatio: b.volumeRatio.toFixed(2), qvMean20: Math.round(b.quoteVolumeMean20),
    liqFloor: 500000,
    atrPct: (b.atr14/b.close*100).toFixed(3), ret24: b.ret24Pct.toFixed(2),
    rsi: b.rsi14.toFixed(1), closeLoc: cl.toFixed(3),
    slope6: b.ema20Slope6Pct.toFixed(3), emaOk: b.ema20>b.ema50,
    breakout: b.close > b.high72Prev + 0.10*b.atr14, prevInside: p.close <= b.high72Prev,
    close: b.close.toFixed(4), high72Prev: b.high72Prev.toFixed(4),
  }));
}
