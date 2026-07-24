// Trading-booooo v2.5.0 — candle-layer walk-forward simulator.
//
// This deliberately does not pretend that historical candles contain orderbook
// history. Dynamic orderflow is injected as neutral and must be evaluated by
// forward paper logging. BUY and conditional WAIT scenarios are reported
// separately so their hit rates cannot be mixed.

import {
  analyzePeriod,
  buildUniverse,
  finalizeCandidate,
  type CandleRow,
  type FinalCandidate,
  type PeriodDataset,
  type RiskConfig,
  timeframeMetrics,
  type UniverseRow,
} from "../supabase/functions/market-scanner/engine.ts";
import { neutralMicro } from "./neutral-micro.ts";

export type SimCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
};

export type MarketHistory = {
  exchange: "upbit" | "binance";
  market: string;
  koreanName?: string;
  quoteCurrency: "KRW" | "USDT";
  tickSize: number;
  collectedAt?: number;
  m5: SimCandle[];
  m15: SimCandle[];
  h4: SimCandle[];
  day: SimCandle[];
};

export type SignalType = "BUY" | "WAIT";

export type SimOptions = {
  maxHoldBars15m?: number;
  maxWaitBars15m?: number;
  stepBars?: number;
  decisionStartMs?: number;
  decisionEndMs?: number;
};

export type EvaluationWindow = {
  startMs: number;
  endMs: number;
};

export type Trade = {
  market: string;
  signalType: SignalType;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  target: number;
  stop: number;
  barsHeld: number;
  assetNetPct: number;
  netPct: number;
  allocationPct: number;
  exitReason: "TARGET" | "STOP" | "TIME";
  score: number;
  plannedRR: number;
};

export type MarketSimulation = {
  window: EvaluationWindow | null;
  buyTrades: Trade[];
  waitTrades: Trade[];
};

type EntryLevels = {
  targetTrigger: number;
  targetExecution: number;
  stopTrigger: number;
  stopExecution: number;
};

type ResolvedExit = {
  exitIdx: number;
  exitPrice: number;
  exitReason: Trade["exitReason"];
};

export const TF_MS = {
  m5: 300_000,
  m15: 900_000,
  h4: 14_400_000,
  day: 86_400_000,
};

function rows(candles: SimCandle[], take: number): CandleRow[] {
  return candles.slice(Math.max(0, candles.length - take)).map((c) => ({
    timestamp: c.openTime,
    opening_price: c.open,
    high_price: c.high,
    low_price: c.low,
    trade_price: c.close,
    candle_acc_trade_price: c.quoteVolume,
  }));
}

export function closedUpTo(
  candles: SimCandle[],
  decisionTime: number,
  tfMs: number,
): SimCandle[] {
  return candles.filter((c) => c.openTime + tfMs <= decisionTime);
}

export function netGainPct(
  entry: number,
  exit: number,
  feePerSidePct: number,
): number {
  const fee = feePerSidePct / 100;
  return ((exit * (1 - fee)) / (entry * (1 + fee)) - 1) * 100;
}

function netLossPct(
  entry: number,
  exit: number,
  feePerSidePct: number,
): number {
  return Math.max(0, -netGainPct(entry, exit, feePerSidePct));
}

export function usableWindow(history: MarketHistory): EvaluationWindow | null {
  const m15 = history.m15;
  let t = 96;
  while (t < m15.length - 1) {
    const decisionTime = m15[t].openTime + TF_MS.m15;
    const ready = closedUpTo(history.m5, decisionTime, TF_MS.m5).length >= 50 &&
      closedUpTo(history.h4, decisionTime, TF_MS.h4).length >= 50 &&
      closedUpTo(history.day, decisionTime, TF_MS.day).length >= 50;
    if (ready) {
      return {
        startMs: decisionTime,
        endMs: m15.at(-1)!.openTime + TF_MS.m15,
      };
    }
    t++;
  }
  return null;
}

function pointInTimeUniverse(
  history: MarketHistory,
  m15Closed: SimCandle[],
  decisionTime: number,
): UniverseRow | null {
  const recent = m15Closed.slice(-192);
  if (recent.length < 96) return null;
  const opening = recent[0].open;
  const current = recent.at(-1)!.close;
  const high = Math.max(...recent.map((c) => c.high));
  const low = Math.min(...recent.map((c) => c.low));
  const turnover = recent.reduce((sum, c) => sum + (c.quoteVolume || 0), 0);
  const binance = history.quoteCurrency === "USDT";
  const universe = buildUniverse(
    [{
      market: history.market,
      korean_name: history.koreanName || history.market,
      english_name: history.market,
      market_event: { warning: false, caution: {} },
    }],
    [{
      market: history.market,
      trade_price: current,
      opening_price: opening,
      high_price: high,
      low_price: low,
      signed_change_rate: opening > 0 ? (current - opening) / opening : 0,
      acc_trade_price_24h: turnover,
      trade_timestamp: decisionTime,
    }],
    decisionTime,
    binance
      ? {
        quoteCurrency: "USDT",
        marketMatches: (market) => market.endsWith("USDT"),
        minTurnover24h: 500_000,
        minActionableTurnover24h: 1_000_000,
        liquidityLogFloor: 5.7,
      }
      : {},
  );
  return universe[0] || null;
}

function candidateAt(
  history: MarketHistory,
  t: number,
  risk: RiskConfig,
): FinalCandidate | null {
  const decisionTime = history.m15[t].openTime + TF_MS.m15;
  const m15Closed = history.m15.slice(0, t + 1);
  const universe = pointInTimeUniverse(history, m15Closed, decisionTime);
  if (!universe?.eligible) return null;
  const dataset: PeriodDataset = {
    m5: rows(closedUpTo(history.m5, decisionTime, TF_MS.m5), 144),
    m15: rows(m15Closed, 192),
    h4: rows(closedUpTo(history.h4, decisionTime, TF_MS.h4), 180),
    day: rows(closedUpTo(history.day, decisionTime, TF_MS.day), 200),
  };
  return finalizeCandidate(
    analyzePeriod(universe, dataset),
    neutralMicro(universe.current_price),
    history.tickSize,
    risk,
  );
}

export function resolveExit(
  candles: SimCandle[],
  entryIdx: number,
  levels: EntryLevels,
  maxHoldBars: number,
  decisionEndMs: number,
  timeExitSlippage: number,
): ResolvedExit | null {
  const lastByHold = entryIdx + Math.max(1, maxHoldBars) - 1;
  let lastAllowed = -1;
  for (let k = entryIdx; k < candles.length && k <= lastByHold; k++) {
    if (candles[k].openTime + TF_MS.m15 > decisionEndMs) break;
    lastAllowed = k;
  }
  if (lastAllowed < entryIdx) return null;

  for (let k = entryIdx; k <= lastAllowed; k++) {
    const bar = candles[k];
    if (bar.open <= levels.stopTrigger) {
      return {
        exitIdx: k,
        exitPrice: Math.max(
          Number.EPSILON,
          Math.min(levels.stopExecution, bar.open - timeExitSlippage),
        ),
        exitReason: "STOP",
      };
    }
    if (bar.open >= levels.targetTrigger) {
      return {
        exitIdx: k,
        exitPrice: Math.max(
          levels.targetExecution,
          bar.open - timeExitSlippage,
        ),
        exitReason: "TARGET",
      };
    }
    const hitStop = bar.low <= levels.stopTrigger;
    const hitTarget = bar.high >= levels.targetTrigger;
    if (hitStop) {
      return {
        exitIdx: k,
        exitPrice: levels.stopExecution,
        exitReason: "STOP",
      };
    }
    if (hitTarget) {
      return {
        exitIdx: k,
        exitPrice: levels.targetExecution,
        exitReason: "TARGET",
      };
    }
  }
  return {
    exitIdx: lastAllowed,
    exitPrice: Math.max(
      Number.EPSILON,
      candles[lastAllowed].close - timeExitSlippage,
    ),
    exitReason: "TIME",
  };
}

function allocationFraction(
  entry: number,
  stopExecution: number,
  risk: RiskConfig,
): number {
  const stopLoss = netLossPct(entry, stopExecution, risk.feePerSidePct);
  if (!(stopLoss > 0)) return 0;
  return Math.min(1, (risk.riskPct / 100) / (stopLoss / 100));
}

function makeTrade(
  history: MarketHistory,
  risk: RiskConfig,
  signalType: SignalType,
  signalTime: number,
  entryIdx: number,
  entryPrice: number,
  levels: EntryLevels,
  score: number,
  maxHoldBars: number,
  decisionEndMs: number,
): { trade: Trade; exitIdx: number } | null {
  if (
    !(levels.targetTrigger > entryPrice) ||
    !(levels.targetExecution > entryPrice) ||
    !(levels.stopTrigger < entryPrice) ||
    !(levels.stopExecution < entryPrice)
  ) return null;
  const plannedGain = netGainPct(
    entryPrice,
    levels.targetExecution,
    risk.feePerSidePct,
  );
  const plannedLoss = netLossPct(
    entryPrice,
    levels.stopExecution,
    risk.feePerSidePct,
  );
  const plannedRR = plannedLoss > 0 ? plannedGain / plannedLoss : 0;
  if (!(plannedGain > 0) || plannedRR < risk.minNetRR) return null;

  const resolved = resolveExit(
    history.m15,
    entryIdx,
    levels,
    maxHoldBars,
    decisionEndMs,
    history.tickSize * risk.exitSlippageTicks,
  );
  if (!resolved) return null;
  const assetNetPct = netGainPct(
    entryPrice,
    resolved.exitPrice,
    risk.feePerSidePct,
  );
  const allocation = allocationFraction(entryPrice, levels.stopExecution, risk);
  const exitBar = history.m15[resolved.exitIdx];
  return {
    exitIdx: resolved.exitIdx,
    trade: {
      market: history.market,
      signalType,
      signalTime,
      entryTime: history.m15[entryIdx].openTime,
      exitTime: exitBar.openTime + TF_MS.m15,
      entryPrice,
      exitPrice: resolved.exitPrice,
      target: levels.targetTrigger,
      stop: levels.stopTrigger,
      barsHeld: resolved.exitIdx - entryIdx + 1,
      assetNetPct,
      netPct: assetNetPct * allocation,
      allocationPct: allocation * 100,
      exitReason: resolved.exitReason,
      score,
      plannedRR,
    },
  };
}

function bounds(
  history: MarketHistory,
  opts: SimOptions,
): { start: number; end: number } | null {
  const usable = usableWindow(history);
  if (!usable) return null;
  const start = Math.max(usable.startMs, opts.decisionStartMs ?? usable.startMs);
  const end = Math.min(usable.endMs, opts.decisionEndMs ?? usable.endMs);
  return start < end ? { start, end } : null;
}

function simulateBuy(
  history: MarketHistory,
  risk: RiskConfig,
  opts: SimOptions,
): Trade[] {
  const range = bounds(history, opts);
  if (!range) return [];
  const maxHold = opts.maxHoldBars15m ?? 96;
  const step = Math.max(1, opts.stepBars ?? 1);
  const trades: Trade[] = [];
  let t = 96;
  while (t < history.m15.length - 1) {
    const decisionTime = history.m15[t].openTime + TF_MS.m15;
    if (decisionTime < range.start) { t++; continue; }
    if (decisionTime >= range.end) break;
    const candidate = candidateAt(history, t, risk);
    if (candidate?.decision !== "BUY") { t += step; continue; }
    const entryIdx = t + 1;
    const entryPrice = history.m15[entryIdx].open +
      history.tickSize * risk.entrySlippageTicks;
    const plan = candidate.trade_plan;
    const made = makeTrade(
      history,
      risk,
      "BUY",
      decisionTime,
      entryIdx,
      entryPrice,
      {
        targetTrigger: plan.short_target,
        targetExecution: plan.short_target_execution_estimate,
        stopTrigger: plan.stop_price,
        stopExecution: plan.stop_execution_estimate,
      },
      candidate.score,
      maxHold,
      range.end,
    );
    if (!made) { t += step; continue; }
    trades.push(made.trade);
    t = made.exitIdx + 1;
  }
  return trades;
}

function simulateWait(
  history: MarketHistory,
  risk: RiskConfig,
  opts: SimOptions,
): Trade[] {
  const range = bounds(history, opts);
  if (!range) return [];
  const maxHold = opts.maxHoldBars15m ?? 96;
  const maxWait = opts.maxWaitBars15m ?? 96;
  const step = Math.max(1, opts.stepBars ?? 1);
  const trades: Trade[] = [];
  let t = 96;
  while (t < history.m15.length - 2) {
    const decisionTime = history.m15[t].openTime + TF_MS.m15;
    if (decisionTime < range.start) { t++; continue; }
    if (decisionTime >= range.end) break;
    const candidate = candidateAt(history, t, risk);
    const watch = candidate?.watch_entry_plan;
    if (candidate?.decision !== "WAIT" || !watch?.available) {
      t += step;
      continue;
    }
    const zoneLow = Number(watch.zone_low);
    const zoneHigh = Number(watch.zone_high);
    const maxPrice = Number(watch.max_price);
    const stopTrigger = Number(watch.invalidation_price);
    const targetTrigger = Number(watch.reference_target);
    if (!(zoneLow > 0 && zoneHigh >= zoneLow && maxPrice >= zoneHigh) ||
      !(stopTrigger > 0 && targetTrigger > maxPrice)) {
      t += step;
      continue;
    }

    let touched = false;
    let triggerIdx = -1;
    const lastWaitIdx = Math.min(history.m15.length - 2, t + maxWait);
    for (let k = t + 1; k <= lastWaitIdx; k++) {
      const bar = history.m15[k];
      if (bar.openTime + TF_MS.m15 >= range.end) break;
      if (bar.low <= stopTrigger) break; // trigger 전 무효화 우선
      if (bar.low <= zoneHigh && bar.high >= zoneLow) touched = true;
      if (!touched) continue;
      const metric = timeframeMetrics(rows(history.m15.slice(0, k + 1), 192));
      if (metric.ema21 != null && bar.close > metric.ema21) {
        triggerIdx = k;
        break;
      }
    }
    if (triggerIdx < 0) { t += step; continue; }
    const entryIdx = triggerIdx + 1;
    const entryPrice = history.m15[entryIdx].open +
      history.tickSize * risk.entrySlippageTicks;
    if (entryPrice > maxPrice) { t = entryIdx; continue; }
    const made = makeTrade(
      history,
      risk,
      "WAIT",
      decisionTime,
      entryIdx,
      entryPrice,
      {
        targetTrigger,
        targetExecution: targetTrigger - history.tickSize * risk.exitSlippageTicks,
        stopTrigger,
        stopExecution: Math.max(
          history.tickSize,
          stopTrigger - history.tickSize * risk.exitSlippageTicks,
        ),
      },
      candidate.score,
      maxHold,
      range.end,
    );
    if (!made) { t = entryIdx; continue; }
    trades.push(made.trade);
    t = made.exitIdx + 1;
  }
  return trades;
}

export function simulateMarket(
  history: MarketHistory,
  risk: RiskConfig,
  opts: SimOptions = {},
): MarketSimulation {
  const range = bounds(history, opts);
  return {
    window: range ? { startMs: range.start, endMs: range.end } : null,
    buyTrades: simulateBuy(history, risk, opts),
    waitTrades: simulateWait(history, risk, opts),
  };
}

export function buyAndHoldPct(
  history: MarketHistory,
  risk: RiskConfig,
  window: EvaluationWindow,
): number {
  const bars = history.m15.filter((bar) =>
    bar.openTime >= window.startMs &&
    bar.openTime + TF_MS.m15 <= window.endMs
  );
  if (!bars.length) return 0;
  const entry = bars[0].open + history.tickSize * risk.entrySlippageTicks;
  const exit = Math.max(
    history.tickSize,
    bars.at(-1)!.close - history.tickSize * risk.exitSlippageTicks,
  );
  return netGainPct(entry, exit, risk.feePerSidePct);
}
