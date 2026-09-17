/**
 * Produce every arm of the comparison the promotion gate needs.
 *
 * Arms:  OLD V17 (immediate entry)  |  NEW entry + QV3 current  |  NEW entry + QV3 off
 * Splits: development 6d (09-10..09-16) | untouched holdout 24h (09-16 14:00Z..) | combined
 * Stress: exit slippage +0bp / +10bp / +20bp on top of the 10bp base.
 *
 * Both arms are run on the SAME candidate set, so the only thing that differs
 * between OLD and NEW is when the order is placed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { findTrigger, loadFixtures, mergeCandidates, runExit, summarise } from "./replay.mjs";
import { entryTriggerFresh, SETUP_POLICY, SETUP_STATE }
  from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";
import { POLICY } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import { SLOT_SIZING_CONTRACT } from "../../supabase/functions/_shared/leader-slot-sizing.mjs";

const MIN = 60_000;
const NOTIONAL = SLOT_SIZING_CONTRACT.targetMarginUsdt * SLOT_SIZING_CONTRACT.leverage;
const ENTRY_FEE_RATE = 0.0005;
/** The 24h holdout boundary: everything at or after this was never used to choose a parameter. */
const HOLDOUT_FROM = Date.parse("2026-09-16T14:00:00.000Z");

const { candidates, setupBars, holdBars } = loadFixtures();
const baselineBars = JSON.parse(
  readFileSync(new URL("data/baseline-bars.json", import.meta.url), "utf8"));

function openPosition(bars, at, price) {
  const quantity = NOTIONAL / price;
  return { price, at, quantity, fee: price * quantity * ENTRY_FEE_RATE };
}

/** OLD V17: buy the first executable open after the 5m signal closed. */
function oldEntry(c, stressPct, qv3) {
  const bars = baselineBars[c.id];
  if (!bars || bars.length < 3) return null;
  // The signal closes at s5c; the first bar we could act into opens at s5c.
  const i = bars.findIndex((b) => b[0] >= c.s5c);
  if (i < 0 || i + 2 >= bars.length) return null;
  const entryBar = bars[i];
  const entry = openPosition(bars, entryBar[0], entryBar[1]);
  // The old policy's own drift guard still applies at the fill.
  if (Math.abs(entry.price / c.ref - 1) > POLICY.maxEntryDriftPct) return null;
  const t = runExit(entry, bars.slice(i), { stressPct, qv3 });
  return { ...t, symbol: c.symbol, id: c.id, arm: "OLD" };
}

/** NEW: buy the open of the minute AFTER the re-acceleration candle closed. */
function newEntry(c, stressPct, qv3, policy) {
  const sBars = setupBars[c.id];
  if (!sBars || sBars.length < 3) return null;
  const { state } = findTrigger(c, sBars, policy);
  if (state?.state !== SETUP_STATE.TRIGGERED) return null;
  const bars = holdBars[c.id];
  if (!bars || bars.length < 3) return null;
  // bars[0] opens exactly at triggerAt -- the first minute we could act in.
  const entryBar = bars[0];
  if (entryBar[0] !== state.triggerAt) return null;
  const price = entryBar[1];
  // The live execution guard, applied identically here.
  const stale = entryTriggerFresh(state, state.triggerAt, price, POLICY.maxEntryDriftPct, policy);
  if (stale) return null;
  const entry = openPosition(bars, entryBar[0], price);
  const t = runExit(entry, bars, { stressPct, qv3 });
  return { ...t, symbol: c.symbol, id: c.id, arm: "NEW",
    pullbackPct: state.pullbackLow / c.ref - 1, triggerPct: state.triggerClose / c.ref - 1,
    entryDriftPct: price / c.ref - 1 };
}

function splitOf(t) {
  return t.entryAt >= HOLDOUT_FROM ? "holdout24h" : "dev6d";
}

function runArm(kind, { stressPct = 0, qv3 = "off", pullback = SETUP_POLICY.minPullbackPct } = {}) {
  const policy = { ...SETUP_POLICY, minPullbackPct: pullback };
  const { kept } = mergeCandidates(candidates, policy);
  const trades = [];
  for (const c of kept) {
    const t = kind === "OLD" ? oldEntry(c, stressPct, qv3) : newEntry(c, stressPct, qv3, policy);
    if (t) trades.push(t);
  }
  return trades;
}

function bySplit(trades) {
  return {
    dev6d: summarise(trades.filter((t) => splitOf(t) === "dev6d")),
    holdout24h: summarise(trades.filter((t) => splitOf(t) === "holdout24h")),
    combined: summarise(trades),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const usd = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);
function row(label, s) {
  return [
    label.padEnd(30),
    String(s.trades).padStart(4),
    String(s.wins).padStart(4),
    String(s.losses).padStart(4),
    pct(s.winRate).padStart(7),
    usd(s.grossPnl).padStart(9),
    s.fees.toFixed(3).padStart(8),
    usd(s.netPnl).padStart(9),
    usd(s.expectancy).padStart(8),
    (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : "inf").padStart(7),
    s.maxDrawdown.toFixed(2).padStart(8),
    usd(s.avgWin).padStart(8),
    usd(s.avgLoss).padStart(8),
    s.avgHoldMin.toFixed(1).padStart(7),
  ].join(" ");
}

const HEAD = [
  "arm / split".padEnd(30), "   n", "   W", "   L", "     WR", "    gross", "    fees",
  "      net", "    exp.", "     PF", "     MDD", "  avgWin", " avgLoss", " holdMin",
].join(" ");

const out = { generatedAt: new Date().toISOString(), arms: {} };

console.log(`\n=== V17 pullback / re-acceleration replay =========================`);
console.log(`candidates (gated V17 signals, real production rows): ${candidates.length}`);
console.log(`slot ${SLOT_SIZING_CONTRACT.targetMarginUsdt} USDT x ${SLOT_SIZING_CONTRACT.leverage} ` +
  `= ${NOTIONAL} USDT notional; fees 5bp/side; exit slippage 10bp base`);
console.log(`holdout boundary: ${new Date(HOLDOUT_FROM).toISOString()} (24h, untouched)\n`);

const arms = [
  ["OLD V17 immediate + R5", () => runArm("OLD", { qv3: "off" })],
  ["NEW pullback + R5 + QV3 cur", () => runArm("NEW", { qv3: "current" })],
  ["NEW pullback + R5 + QV3 off", () => runArm("NEW", { qv3: "off" })],
];
console.log(HEAD);
console.log("-".repeat(HEAD.length));
for (const [label, fn] of arms) {
  const trades = fn(), s = bySplit(trades);
  out.arms[label] = s;
  for (const k of ["dev6d", "holdout24h", "combined"]) {
    console.log(row(`${label} / ${k}`, s[k]));
  }
  console.log("-".repeat(HEAD.length));
}

console.log(`\n=== cost stress (NEW entry, QV3 off, combined) ====================`);
console.log(HEAD);
for (const [label, stress] of [["base 10bp", 0], ["+10bp", 0.001], ["+20bp", 0.002]]) {
  const s = summarise(runArm("NEW", { qv3: "off", stressPct: stress }));
  out.arms[`stress ${label}`] = { combined: s };
  console.log(row(`stress ${label}`, s));
}

console.log(`\n=== pullback robustness (NEW entry, QV3 off, combined) ============`);
console.log(HEAD);
for (const p of [0.0025, 0.005, 0.0075]) {
  const s = summarise(runArm("NEW", { qv3: "off", pullback: p }));
  out.arms[`pullback ${(p * 100).toFixed(2)}%`] = { combined: s };
  console.log(row(`pullback ${(p * 100).toFixed(2)}%`, s));
}

const newTrades = runArm("NEW", { qv3: "off" });
const oldTrades = runArm("OLD", { qv3: "off" });
const avg = (xs, f) => xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : 0;
console.log(`\n=== does the new timing actually improve the entry? ===============`);
console.log(`                         OLD        NEW`);
console.log(`avg MAE (adverse)   ${pct(avg(oldTrades, (t) => t.mae)).padStart(8)}   ${pct(avg(newTrades, (t) => t.mae)).padStart(8)}`);
console.log(`avg MFE (favourable)${pct(avg(oldTrades, (t) => t.mfe)).padStart(8)}   ${pct(avg(newTrades, (t) => t.mfe)).padStart(8)}`);
console.log(`MFE capture         ${(avg(oldTrades, (t) => t.mfe) ? (avg(oldTrades, (t) => t.netPnl / NOTIONAL) / avg(oldTrades, (t) => t.mfe)).toFixed(3) : "n/a").padStart(8)}   ${(avg(newTrades, (t) => t.mfe) ? (avg(newTrades, (t) => t.netPnl / NOTIONAL) / avg(newTrades, (t) => t.mfe)).toFixed(3) : "n/a").padStart(8)}`);
console.log(`entries             ${String(oldTrades.length).padStart(8)}   ${String(newTrades.length).padStart(8)}`);

const reasons = {};
for (const t of newTrades) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1;
console.log(`\nNEW exit reasons: ${JSON.stringify(reasons)}`);

out.trades = { new: newTrades, old: oldTrades };
writeFileSync(new URL("data/results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`\nwrote data/results.json`);
