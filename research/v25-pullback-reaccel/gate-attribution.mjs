/**
 * How much of the improvement is SELECTION (the dayReturn<8% + volumeRatio>=1.3 gate)
 * and how much is TIMING (pullback + re-acceleration)?
 *
 * The main replay applies the gate to both arms, which isolates timing correctly but
 * cannot answer this. Here the untouched 24h holdout is run four ways on the same
 * real signals, so the two effects separate.
 */
import { readFileSync } from "node:fs";
import { runExit, summarise } from "./replay.mjs";
import { findTrigger } from "./replay.mjs";
import { SETUP_POLICY, SETUP_STATE } from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";
import { POLICY } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import { SLOT_SIZING_CONTRACT } from "../../supabase/functions/_shared/leader-slot-sizing.mjs";

const MIN = 60_000;
const NOTIONAL = SLOT_SIZING_CONTRACT.targetMarginUsdt * SLOT_SIZING_CONTRACT.leverage;
const here = (f) => JSON.parse(readFileSync(new URL(`data/${f}`, import.meta.url), "utf8"));
const WINDOW = process.argv[2] ?? "all";
const suffix = WINDOW === "holdout" ? "holdout" : WINDOW === "dev" ? "dev" : "all";
// "all" is derived from the two windows rather than stored a third time.
const parts = suffix === "all" ? ["dev", "holdout"] : [suffix];
const seen = new Set();
const candidates = [];
const bars = {};
for (const part of parts) {
  for (const c of here(`ungated-${part}-candidates.json`)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }
  Object.assign(bars, here(`ungated-${part}-bars.json`));
}
const HOLDOUT_FROM = 1789567200000;
const inWindow = (c) => WINDOW === "holdout" ? c.s5c >= HOLDOUT_FROM
  : WINDOW === "dev" ? c.s5c < HOLDOUT_FROM : true;

const gate = (c) => c.dayReturn >= 0.03 && c.dayReturn < 0.08 && c.volumeRatio >= 1.30;
const universe = candidates.filter(inWindow);

/** Same-symbol merge, as the live queue would do it. */
function merge(cs) {
  const live = new Map(), kept = [];
  for (const c of [...cs].sort((a, b) => a.s5c - b.s5c)) {
    const l = live.get(c.symbol);
    if (l && c.s5c < l.s5c + SETUP_POLICY.setupTtlMs) continue;
    live.set(c.symbol, c);
    kept.push(c);
  }
  return kept;
}

function open(price, at) {
  const quantity = NOTIONAL / price;
  return { price, at, quantity, fee: price * quantity * 0.0005 };
}

function oldArm(cs) {
  const out = [];
  for (const c of merge(cs)) {
    const b = bars[c.id];
    if (!b || b.length < 3) continue;
    const i = b.findIndex((x) => x[0] >= c.s5c);
    if (i < 0 || i + 2 >= b.length) continue;
    const price = b[i][1];
    if (Math.abs(price / c.ref - 1) > POLICY.maxEntryDriftPct) continue;
    out.push(runExit(open(price, b[i][0]), b.slice(i), { qv3: "off" }));
  }
  return out;
}

function newArm(cs) {
  const out = [];
  for (const c of merge(cs)) {
    const b = bars[c.id];
    if (!b || b.length < 20) continue;
    // The setup window is the first 17 bars of this series (signal close onwards).
    const { state } = findTrigger(c, b.slice(0, 18), SETUP_POLICY);
    if (state?.state !== SETUP_STATE.TRIGGERED) continue;
    const i = b.findIndex((x) => x[0] === state.triggerAt);
    if (i < 0 || i + 2 >= b.length) continue;
    const price = b[i][1];
    if (Math.abs(price / c.ref - 1) > POLICY.maxEntryDriftPct) continue;
    out.push(runExit(open(price, b[i][0]), b.slice(i), { qv3: "off" }));
  }
  return out;
}

const rows = [
  ["OLD timing, NO gate  (the stated baseline)", oldArm(universe)],
  ["OLD timing, WITH gate  (selection only)", oldArm(universe.filter(gate))],
  ["NEW timing, NO gate  (timing only)", newArm(universe)],
  ["NEW timing, WITH gate  (both)", newArm(universe.filter(gate))],
];

console.log(`\n=== ${WINDOW}: selection effect vs timing effect ===================`);
console.log(`(real V17 signals, ASCII symbols only, n=${universe.length} merged opportunities)\n`);
console.log("arm".padEnd(44) + "   n     WR       net     exp.      PF     MDD");
console.log("-".repeat(44 + 46));
for (const [label, trades] of rows) {
  const s = summarise(trades);
  console.log(
    label.padEnd(44) +
      String(s.trades).padStart(4) +
      `${(s.winRate * 100).toFixed(1)}%`.padStart(7) +
      (s.netPnl >= 0 ? "+" : "") + s.netPnl.toFixed(3).padStart(9) +
      ((s.expectancy >= 0 ? "+" : "") + s.expectancy.toFixed(3)).padStart(9) +
      (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : "inf").padStart(8) +
      s.maxDrawdown.toFixed(2).padStart(8),
  );
}
console.log();
