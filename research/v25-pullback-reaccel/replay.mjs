/**
 * Offline replay of the V17 pullback / re-acceleration entry.
 *
 * It drives the SAME modules production runs -- leader-pullback-reaccel.mjs for the
 * setup state machine, leader-exit-review.mjs (R5) for the exit, leader-qv3-rules.mjs
 * for the QV3 comparison -- against real Binance 1m klines and the real V17 signals
 * production wrote. Nothing about the strategy is reimplemented here; this file only
 * supplies data, sequences time, and accounts for cost.
 *
 * NO LOOKAHEAD, enforced structurally:
 *   - a setup only ever sees candles whose closeTime is already past `now`;
 *   - the earliest possible entry is the OPEN of the minute AFTER the trigger candle
 *     closed, never that candle's own open, high or low;
 *   - within a holding bar the stop is tested against the level that was already
 *     fixed at the END of the previous bar, and only then is the peak advanced with
 *     this bar's high. A bar can therefore never raise the stop and fill it at the
 *     same time.
 *
 * Usage: node replay.mjs [--pullback 0.0025] [--stress 0] [--qv3 off|current] [--entry new|old]
 */
import { readFileSync } from "node:fs";
import {
  advancePullbackSetup,
  enterPullbackSetup,
  entryTriggerFresh,
  isTerminal,
  SETUP_POLICY,
  SETUP_STATE,
  startPullbackSetup,
} from "../../supabase/functions/_shared/leader-pullback-reaccel.mjs";
import { EXIT_REVIEW_R5, nextExitReviewed } from "../../supabase/functions/_shared/leader-exit-review.mjs";
import { exitSignal } from "../../supabase/functions/_shared/leader-qv3-rules.mjs";
import { POLICY, STRATEGY } from "../../supabase/functions/_shared/leader-momentum-v17.mjs";
import { SLOT_SIZING_CONTRACT } from "../../supabase/functions/_shared/leader-slot-sizing.mjs";

const MIN = 60_000;
const HERE = new URL("./", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(`data/${f}`, HERE), "utf8"));

/** Cost model. Taker both sides; exits additionally pay adverse slippage. */
export const COSTS = Object.freeze({
  entryFeeRate: 0.0005,
  exitFeeRate: 0.0005,
  /** Both a stop and a discretionary market exit are charged at least this. */
  exitSlippagePct: 0.001,
  entrySlippagePct: 0,
});

const NOTIONAL = SLOT_SIZING_CONTRACT.targetMarginUsdt * SLOT_SIZING_CONTRACT.leverage;
const MARGIN = SLOT_SIZING_CONTRACT.targetMarginUsdt;

/** Binance kline rows -> the array shape the pure modules expect. */
function toKline(row) {
  const [t, o, h, l, c] = row;
  return [t, String(o), String(h), String(l), String(c), "0", t + MIN - 1, "0", 0, "0", "0", "0"];
}

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

/**
 * Walk one candidate's setup window and return the trigger, if any.
 * `bars` are consecutive completed 1m klines covering [s5c - 2m, s5c + 16m].
 */
export function findTrigger(signal, bars, policy) {
  const armedAt = Number(signal.s5c);
  const armed = startPullbackSetup(
    { id: signal.id, symbol: signal.symbol, features: { referenceClose: signal.ref, signal5Close: armedAt } },
    armedAt,
    policy,
  );
  if (!armed.ok) return { state: null, reason: armed.reason };
  let state = armed.state;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar[0] < armedAt) continue;
    // `now` is the instant the bar became readable: one millisecond after it closed.
    const now = bar[0] + MIN;
    const out = advancePullbackSetup(state, toKline(bar), i > 0 ? toKline(bars[i - 1]) : null, now, policy);
    state = out.state;
    if (isTerminal(state) || state.state === SETUP_STATE.TRIGGERED) break;
  }
  return { state, reason: state?.state };
}

/**
 * Hold a position from `entryPrice` through `bars`, under R5, with no same-bar
 * lookahead. `bars[0]` is the entry bar; the stop is first testable on bars[1].
 */
export function runExit(entry, bars, { stressPct = 0, qv3 = "off" } = {}) {
  const policy = { ...POLICY, ...EXIT_REVIEW_R5 };
  const slip = COSTS.exitSlippagePct + stressPct;
  let peakPrice = entry.price, lastHighAt = entry.at,
    stopPrice = entry.price * (1 - POLICY.stopPct);
  const seen = [];
  let mae = 0, mfe = 0;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i], closeAt = bar[0] + MIN - 1;
    const [, o, h, l, c] = bar;
    mae = Math.min(mae, l / entry.price - 1);
    mfe = Math.max(mfe, h / entry.price - 1);

    // 1. The stop as it stood BEFORE this bar opened.
    const preBar = {
      entryPrice: entry.price, entryAt: entry.at, peakPrice, lastHighAt, stopPrice,
      entryFee: entry.fee, quantity: entry.quantity,
    };
    const adverse = nextExitReviewed(preBar, l, closeAt, policy);
    if (adverse.action === "CLOSE" && l <= adverse.stopPrice) {
      // A gap through the stop fills at the open, not at the level.
      const raw = Math.min(o, adverse.stopPrice);
      return settle(entry, raw * (1 - slip), closeAt, adverse.reason, { mae, mfe });
    }

    // 2. Only now may the bar's high advance the peak, for the NEXT bar.
    const favourable = nextExitReviewed(
      { ...preBar }, h, closeAt, policy,
    );
    peakPrice = favourable.peakPrice;
    lastHighAt = favourable.lastHighAt;
    stopPrice = favourable.stopPrice;

    // 3. Time-based exits are decided on the close, and fill on the close.
    const onClose = nextExitReviewed(
      { entryPrice: entry.price, entryAt: entry.at, peakPrice, lastHighAt, stopPrice,
        entryFee: entry.fee, quantity: entry.quantity },
      c, closeAt, policy,
    );
    if (onClose.action === "CLOSE" && onClose.reason !== "V17_HARD_STOP" &&
        onClose.reason !== "V17_TRAILING_STOP") {
      return settle(entry, c * (1 - slip), closeAt, onClose.reason, { mae, mfe });
    }

    // 4. QV3's two-bearish-candle exit, when it is the authoritative policy.
    seen.push(toKline(bar));
    if (qv3 === "current") {
      const pos = { entryAt: entry.at, entryPrice: entry.price, ownership: "AUTO" };
      if (exitSignal(pos, seen, closeAt + 1, "ENTRY_EXIT_TWO")) {
        return settle(entry, c * (1 - slip), closeAt, "QV3_TWO_BEARISH_CLOSED", { mae, mfe });
      }
    }
  }
  const last = bars.at(-1);
  return settle(entry, last[4] * (1 - slip), last[0] + MIN - 1, "REPLAY_WINDOW_END", { mae, mfe });
}

function settle(entry, exitPrice, exitAt, reason, extra) {
  const gross = (exitPrice - entry.price) * entry.quantity;
  const exitFee = exitPrice * entry.quantity * COSTS.exitFeeRate;
  return {
    ...extra,
    entryPrice: entry.price, exitPrice, entryAt: entry.at, exitAt, reason,
    quantity: entry.quantity, grossPnl: gross, fees: entry.fee + exitFee,
    netPnl: gross - entry.fee - exitFee, holdMs: exitAt - entry.at,
  };
}

/** Aggregate a list of settled trades into the reported metrics. */
export function summarise(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0), losses = trades.filter((t) => t.netPnl <= 0);
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const gross = trades.reduce((s, t) => s + t.grossPnl, 0);
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  let equity = 0, peak = 0, mdd = 0;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) {
    equity += t.netPnl;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity - peak);
  }
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : 0,
    grossPnl: gross,
    fees,
    // Slippage is already inside grossPnl via the executed price; reported separately
    // so the cost stack is legible rather than implied.
    slippage: trades.reduce((s, t) => s + t.slippageCost ?? 0, 0),
    netPnl: net,
    expectancy: n ? net / n : 0,
    expectancyPctOfMargin: n ? net / n / MARGIN : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDrawdown: mdd,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    avgHoldMin: n ? trades.reduce((s, t) => s + t.holdMs, 0) / n / MIN : 0,
    avgMae: n ? trades.reduce((s, t) => s + t.mae, 0) / n : 0,
    avgMfe: n ? trades.reduce((s, t) => s + t.mfe, 0) / n : 0,
  };
}

export function loadFixtures() {
  const candidates = read("candidates.json");
  const setupBars = read("setup-bars.json");
  let holdBars = {};
  try {
    holdBars = read("hold-bars.json");
  } catch { /* pass 1 has not produced them yet */ }
  return { candidates, setupBars, holdBars };
}

/**
 * Section 13: one opportunity per symbol. A later V17 signal on a symbol that
 * already has a live setup is merged into it -- it does NOT re-arm, and it does not
 * re-base the reference upwards, which is what would let the chase ceiling walk.
 */
export function mergeCandidates(candidates, policy = SETUP_POLICY) {
  const bySymbol = new Map(), kept = [], merged = [];
  for (const c of [...candidates].sort((a, b) => a.s5c - b.s5c)) {
    const live = bySymbol.get(c.symbol);
    if (live && c.s5c < live.s5c + policy.setupTtlMs) {
      merged.push({ ...c, mergedInto: live.id });
      continue;
    }
    bySymbol.set(c.symbol, c);
    kept.push(c);
  }
  return { kept, merged };
}
