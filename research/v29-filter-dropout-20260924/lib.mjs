// Research harness: drives the PRODUCTION modules against real Binance 1m klines.
import { readFileSync } from "node:fs";
const R = new URL("../../supabase/functions/_shared/", import.meta.url).href;
export const PB = await import(R + "leader-pullback-reaccel.mjs");
export const B6 = await import(R + "leader-b06133-entry.mjs");
export const CEC = await import(R + "leader-cec0040.mjs");
export const V17 = await import(R + "leader-momentum-v17.mjs");
const D = new URL("./data/", import.meta.url);
export const MIN = 60000;
const K = JSON.parse(readFileSync(new URL("klines.json", D)));
export const SIGNALS = JSON.parse(readFileSync(new URL("signals_all.json", D)));
const cache = new Map();
export function barsOf(sym) {
  if (!cache.has(sym)) {
    const m = new Map();
    for (const [k, v] of Object.entries(K[sym] || {})) m.set(Number(k) * MIN, v);
    cache.set(sym, m);
  }
  return cache.get(sym);
}
/** Binance REST kline array shape (with quote volume idx7 and taker-buy quote idx10). */
export function kline(t, v) {
  return [t, String(v[0]), String(v[1]), String(v[2]), String(v[3]), "0", t + MIN - 1, String(v[4]), 0, "0", String(v[5]), "0"];
}
export function range(sym, from, to) {
  const m = barsOf(sym), out = [];
  for (let t = Math.floor(from / MIN) * MIN; t < to; t += MIN) { const v = m.get(t); if (!v) return { out, gapAt: t }; out.push([t, ...v]); }
  return { out, gapAt: null };
}
const btc = [...barsOf("BTC15").entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t, String(v[0]), String(v[1]), String(v[2]), String(v[3]), "0", t + 15 * MIN - 1, String(v[4]), 0, "0", String(v[5]), "0"]);
export function btcBarsBefore(at) { return btc.filter(r => r[6] < at).slice(-12); }

/** Replay a setup with the production state machine. `policy` defaults to production. */
export function simulateSetup(sig, policy = PB.SETUP_POLICY) {
  const f = sig.f, armAt = Number(f.signal5Close);
  const armed = PB.startPullbackSetup({ id: sig.id, symbol: sig.symbol, features: f }, armAt, policy);
  if (!armed.ok) return { state: null, reason: armed.reason };
  let state = armed.state;
  const { out } = range(sig.symbol, armAt - MIN, armAt + policy.setupTtlMs + 2 * MIN);
  for (let i = 0; i < out.length; i++) {
    const b = out[i]; if (b[0] < armAt) continue;
    const now = b[0] + MIN;
    if (now > state.expiresAt) { state = PB.expirePullbackSetup(state, now).state; break; }
    const r = PB.advancePullbackSetup(state, kline(b[0], b.slice(1)), i > 0 ? kline(out[i - 1][0], out[i - 1].slice(1)) : null, now, policy);
    state = r.state;
    if (PB.isTerminal(state) || state.state === PB.SETUP_STATE.TRIGGERED) break;
  }
  if (!PB.isTerminal(state) && state.state !== PB.SETUP_STATE.TRIGGERED) state = PB.expirePullbackSetup(state, state.expiresAt + 1).state;
  return { state, reason: state.terminalReason ?? state.state };
}
export function b06133At(sig, decisionAt) {
  const { out } = range(sig.symbol, decisionAt - 3 * MIN, decisionAt);
  const prebars = out.map(b => kline(b[0], b.slice(1)));
  return B6.evaluateB06133({ features: sig.f, prebars, btcBars: btcBarsBefore(decisionAt), decisionAt });
}
export const COSTS_REAL = Object.freeze({ entryFee: .0005, exitFee: .0005, entrySlip: .0005, exitSlip: .001, actualBaselineEntrySlip: .0005 });
export const COSTS_44 = CEC.CEC0040_44BP_COSTS;
/**
 * Enter at the OPEN of the minute starting at `at` (first price after the decision),
 * exit with the production P142/R5 kernel, averaged over LOW_FIRST/HIGH_FIRST/CLOSE_ONLY.
 * Net USDT at the 600 USDT slot notional.
 */
export function trade(sig, at, { style = "retestAnchor", costs = COSTS_REAL } = {}) {
  const { out, gapAt } = range(sig.symbol, at, at + V17.POLICY.maxHoldMs + 5 * MIN);
  if (!out.length || out[0][0] !== at) return null;
  const open = out[0][1], price = open * (1 + costs.entrySlip);
  const bars = out.map(b => b.slice(0, 5));
  const res = CEC.P142_MODES.map(mode => CEC.replayP142Target({ at, price }, bars, { style, mode, costs }));
  if (res.some(r => r.status !== "CLOSED")) return { status: res.find(r => r.status !== "CLOSED").status, gapAt };
  const nets = res.map(r => r.netBeforeFunding);
  const net = nets.reduce((a, b) => a + b, 0) / nets.length;
  return { status: "CLOSED", entryAt: at, entryPrice: price, open, net, nets, exitAt: Math.max(...res.map(r => r.exitAt)),
    reasons: res.map(r => r.reason), mfe: res[0].mfe, mae: res[0].mae, holdMin: (res[2].exitAt - at) / MIN };
}
export function forward(sig, from, ref) {
  const o = {};
  for (const h of [15, 30, 60, 120, 240]) {
    const { out } = range(sig.symbol, from, from + h * MIN);
    if (out.length < h) continue;
    o["max" + h] = Math.max(...out.map(b => b[2])) / ref - 1;
    o["min" + h] = Math.min(...out.map(b => b[3])) / ref - 1;
    o["ret" + h] = out.at(-1)[4] / ref - 1;
  }
  return o;
}
export function stats(trades, key = "net") {
  const xs = trades.map(t => t[key]); const n = xs.length;
  if (!n) return { n: 0 };
  const w = xs.filter(x => x > 0), l = xs.filter(x => x <= 0), sum = xs.reduce((a, b) => a + b, 0);
  let peak = 0, cur = 0, mdd = 0;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) { cur += t[key]; peak = Math.max(peak, cur); mdd = Math.min(mdd, cur - peak); }
  const aw = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0, al = l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
  return { n, win: +(w.length / n).toFixed(3), net: +sum.toFixed(2), exp: +(sum / n).toFixed(3), pf: l.length ? +(w.reduce((a, b) => a + b, 0) / -l.reduce((a, b) => a + b, 0)).toFixed(3) : null,
    rr: al ? +(aw / -al).toFixed(3) : null, mdd: +mdd.toFixed(2) };
}
/** Portfolio: one position per symbol, at most `cap` concurrent, chronological first-come. */
export function portfolio(trades, cap = 4) {
  const open = [], kept = [];
  for (const t of [...trades].sort((a, b) => a.entryAt - b.entryAt)) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitAt <= t.entryAt) open.splice(i, 1);
    if (open.length >= cap || open.some(o => o.symbol === t.symbol)) continue;
    open.push(t); kept.push(t);
  }
  return kept;
}
