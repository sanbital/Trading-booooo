// Trading-booooo v2.6.0 — candle-layer walk-forward simulator.
//
// Historical candles do not contain historical orderbook/trade streams. The
// microstructure layer is therefore injected as neutral and isolated from the
// measured TA/price-structure edge. Live orderflow accuracy is measured by the
// optional forward paper logger, not silently invented here.

import {
  analyzePeriod,
  buildUniverse,
  finalizeCandidate,
  type CandleRow,
  type FinalCandidate,
  type PeriodDataset,
  type RiskConfig,
  type TargetStrategy,
  timeframeMetrics,
  type TradePlan,
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
export type ExitReason = "TARGET" | "STOP" | "PARTIAL_STOP" | "TIME";
export type SignalOutcome =
  | "TARGET_FIRST"
  | "STOP_FIRST"
  | "TIMEOUT_PROFIT"
  | "TIMEOUT_LOSS"
  | "TIMEOUT_FLAT"
  | "NO_ENTRY"
  | "REJECT_CORRECT"
  | "MISSED_OPPORTUNITY"
  | "UNRESOLVED";

export type SimOptions = {
  maxHoldBars15m?: number;
  maxWaitBars15m?: number;
  stepBars?: number;
  signalStepBars?: number;
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
  secondTarget: number | null;
  stop: number;
  targetStrategy: TargetStrategy;
  barsHeld: number;
  assetNetPct: number;
  netPct: number;
  allocationPct: number;
  exitReason: ExitReason;
  score: number;
  plannedRR: number;
  rawPredictedUpsidePct: number;
  predictedUpsidePct: number;
  predictedHitProbabilityPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  forecastErrorPct: number;
  ambiguousSameBar: boolean;
};

export type SignalEvaluation = {
  market: string;
  exchange: MarketHistory["exchange"];
  signalTime: number;
  decision: FinalCandidate["decision"];
  score: number;
  confidence: number;
  horizonCode: FinalCandidate["horizon"]["code"];
  targetStrategy: TargetStrategy;
  entryStatus: "ENTERED" | "NO_ENTRY" | "NOT_APPLICABLE";
  entryTime: number | null;
  entryPrice: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  outcome: SignalOutcome;
  exitReason: ExitReason | null;
  rawPredictedUpsidePct: number;
  predictedUpsidePct: number;
  predictedHitProbabilityPct: number;
  realizedNetPct: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  forecastErrorPct: number | null;
  brierScore: number | null;
  directionCorrect: boolean | null;
  ambiguousSameBar: boolean;
  failedGates: string[];
};

export type MarketSimulation = {
  window: EvaluationWindow | null;
  buyTrades: Trade[];
  waitTrades: Trade[];
  signals: SignalEvaluation[];
};

type EntryLevels = {
  targetTrigger: number;
  targetExecution: number;
  stopTrigger: number;
  stopExecution: number;
  targetStrategy?: TargetStrategy;
  secondTargetTrigger?: number;
  secondTargetExecution?: number;
  firstAllocation?: number;
};

type ResolvedExit = {
  exitIdx: number;
  exitPrice: number;
  exitReason: ExitReason;
  assetNetPctOverride?: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  ambiguousSameBar: boolean;
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
    const ready = closedUpTo(history.m5, decisionTime, TF_MS.m5).length >= 60 &&
      closedUpTo(history.h4, decisionTime, TF_MS.h4).length >= 120 &&
      closedUpTo(history.day, decisionTime, TF_MS.day).length >= 120;
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
  const recent = m15Closed.slice(-96);
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

export function candidateAt(
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
    neutralMicro(universe.current_price, decisionTime),
    history.tickSize,
    risk,
  );
}

function maxAllowedIndex(
  candles: SimCandle[],
  entryIdx: number,
  maxHoldBars: number,
  decisionEndMs: number,
): number {
  const lastByHold = entryIdx + Math.max(1, maxHoldBars) - 1;
  let lastAllowed = -1;
  for (let k = entryIdx; k < candles.length && k <= lastByHold; k++) {
    if (candles[k].openTime + TF_MS.m15 > decisionEndMs) break;
    lastAllowed = k;
  }
  return lastAllowed;
}

function excursion(
  candles: SimCandle[],
  entryIdx: number,
  exitIdx: number,
  entryPrice: number,
): { mfe: number; mae: number } {
  const path = candles.slice(entryIdx, exitIdx + 1);
  if (!path.length || !(entryPrice > 0)) return { mfe: 0, mae: 0 };
  const high = Math.max(...path.map((bar) => bar.high));
  const low = Math.min(...path.map((bar) => bar.low));
  return {
    mfe: Math.max(0, (high / entryPrice - 1) * 100),
    mae: Math.max(0, (1 - low / entryPrice) * 100),
  };
}

export function resolveExit(
  candles: SimCandle[],
  entryIdx: number,
  levels: EntryLevels,
  maxHoldBars: number,
  decisionEndMs: number,
  timeExitSlippage: number,
  entryPriceOverride?: number,
): ResolvedExit | null {
  const lastAllowed = maxAllowedIndex(
    candles,
    entryIdx,
    maxHoldBars,
    decisionEndMs,
  );
  if (lastAllowed < entryIdx) return null;
  const entryPrice = entryPriceOverride ?? candles[entryIdx].open;

  for (let k = entryIdx; k <= lastAllowed; k++) {
    const bar = candles[k];
    if (bar.open <= levels.stopTrigger) {
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: Math.max(
          Number.EPSILON,
          Math.min(levels.stopExecution, bar.open - timeExitSlippage),
        ),
        exitReason: "STOP",
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: false,
      };
    }
    if (bar.open >= levels.targetTrigger) {
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: Math.max(
          levels.targetExecution,
          bar.open - timeExitSlippage,
        ),
        exitReason: "TARGET",
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: false,
      };
    }
    const hitStop = bar.low <= levels.stopTrigger;
    const hitTarget = bar.high >= levels.targetTrigger;
    // Intrabar path is unknowable from OHLC. Use conservative stop-first and
    // explicitly mark ambiguity instead of silently inflating win rate.
    if (hitStop) {
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: levels.stopExecution,
        exitReason: "STOP",
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: hitTarget,
      };
    }
    if (hitTarget) {
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: levels.targetExecution,
        exitReason: "TARGET",
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: false,
      };
    }
  }
  const ex = excursion(candles, entryIdx, lastAllowed, entryPrice);
  return {
    exitIdx: lastAllowed,
    exitPrice: Math.max(
      Number.EPSILON,
      candles[lastAllowed].close - timeExitSlippage,
    ),
    exitReason: "TIME",
    maxFavorableExcursionPct: ex.mfe,
    maxAdverseExcursionPct: ex.mae,
    ambiguousSameBar: false,
  };
}

function resolveScaleOut(
  candles: SimCandle[],
  entryIdx: number,
  entryPrice: number,
  levels: EntryLevels,
  maxHoldBars: number,
  decisionEndMs: number,
  feePerSidePct: number,
  timeExitSlippage: number,
): ResolvedExit | null {
  const secondTrigger = Number(levels.secondTargetTrigger);
  const secondExecution = Number(levels.secondTargetExecution);
  const firstAllocation = Math.min(0.9, Math.max(0.1, levels.firstAllocation ?? 0.6));
  if (!(secondTrigger > levels.targetTrigger) || !(secondExecution > entryPrice)) {
    return resolveExit(
      candles,
      entryIdx,
      levels,
      maxHoldBars,
      decisionEndMs,
      timeExitSlippage,
      entryPrice,
    );
  }
  const lastAllowed = maxAllowedIndex(candles, entryIdx, maxHoldBars, decisionEndMs);
  if (lastAllowed < entryIdx) return null;
  let firstHitIdx = -1;
  let ambiguous = false;
  for (let k = entryIdx; k <= lastAllowed; k++) {
    const bar = candles[k];
    if (firstHitIdx < 0) {
      const hitStop = bar.open <= levels.stopTrigger || bar.low <= levels.stopTrigger;
      const hitFirst = bar.open >= levels.targetTrigger || bar.high >= levels.targetTrigger;
      if (hitStop) {
        const ex = excursion(candles, entryIdx, k, entryPrice);
        return {
          exitIdx: k,
          exitPrice: bar.open <= levels.stopTrigger
            ? Math.max(Number.EPSILON, Math.min(levels.stopExecution, bar.open - timeExitSlippage))
            : levels.stopExecution,
          exitReason: "STOP",
          maxFavorableExcursionPct: ex.mfe,
          maxAdverseExcursionPct: ex.mae,
          ambiguousSameBar: hitFirst,
        };
      }
      if (!hitFirst) continue;
      firstHitIdx = k;
      if (bar.high >= secondTrigger || bar.open >= secondTrigger) {
        const firstNet = netGainPct(entryPrice, levels.targetExecution, feePerSidePct);
        const secondNet = netGainPct(entryPrice, Math.max(secondExecution, bar.open - timeExitSlippage), feePerSidePct);
        const assetNet = firstNet * firstAllocation + secondNet * (1 - firstAllocation);
        const ex = excursion(candles, entryIdx, k, entryPrice);
        return {
          exitIdx: k,
          exitPrice: levels.targetExecution * firstAllocation + secondExecution * (1 - firstAllocation),
          exitReason: "TARGET",
          assetNetPctOverride: assetNet,
          maxFavorableExcursionPct: ex.mfe,
          maxAdverseExcursionPct: ex.mae,
          ambiguousSameBar: false,
        };
      }
      continue;
    }

    const breakEvenTrigger = entryPrice;
    const breakEvenExecution = Math.max(
      Number.EPSILON,
      entryPrice - timeExitSlippage,
    );
    if (bar.open >= secondTrigger || bar.high >= secondTrigger) {
      const firstNet = netGainPct(entryPrice, levels.targetExecution, feePerSidePct);
      const secondExit = bar.open >= secondTrigger
        ? Math.max(secondExecution, bar.open - timeExitSlippage)
        : secondExecution;
      const secondNet = netGainPct(entryPrice, secondExit, feePerSidePct);
      const assetNet = firstNet * firstAllocation + secondNet * (1 - firstAllocation);
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: levels.targetExecution * firstAllocation + secondExit * (1 - firstAllocation),
        exitReason: "TARGET",
        assetNetPctOverride: assetNet,
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: false,
      };
    }
    if (bar.open <= breakEvenTrigger || bar.low <= breakEvenTrigger) {
      const firstNet = netGainPct(entryPrice, levels.targetExecution, feePerSidePct);
      const secondExit = bar.open <= breakEvenTrigger
        ? Math.max(Number.EPSILON, bar.open - timeExitSlippage)
        : breakEvenExecution;
      const secondNet = netGainPct(entryPrice, secondExit, feePerSidePct);
      const assetNet = firstNet * firstAllocation + secondNet * (1 - firstAllocation);
      const ex = excursion(candles, entryIdx, k, entryPrice);
      return {
        exitIdx: k,
        exitPrice: levels.targetExecution * firstAllocation + secondExit * (1 - firstAllocation),
        exitReason: "PARTIAL_STOP",
        assetNetPctOverride: assetNet,
        maxFavorableExcursionPct: ex.mfe,
        maxAdverseExcursionPct: ex.mae,
        ambiguousSameBar: ambiguous,
      };
    }
  }
  const finalBar = candles[lastAllowed];
  const firstNet = netGainPct(entryPrice, levels.targetExecution, feePerSidePct);
  const secondExit = Math.max(Number.EPSILON, finalBar.close - timeExitSlippage);
  const secondNet = netGainPct(entryPrice, secondExit, feePerSidePct);
  const assetNet = firstNet * firstAllocation + secondNet * (1 - firstAllocation);
  const ex = excursion(candles, entryIdx, lastAllowed, entryPrice);
  return {
    exitIdx: lastAllowed,
    exitPrice: levels.targetExecution * firstAllocation + secondExit * (1 - firstAllocation),
    exitReason: "TIME",
    assetNetPctOverride: assetNet,
    maxFavorableExcursionPct: ex.mfe,
    maxAdverseExcursionPct: ex.mae,
    ambiguousSameBar: ambiguous,
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

function levelsFromPlan(plan: TradePlan): EntryLevels {
  return {
    targetTrigger: plan.short_target,
    targetExecution: plan.short_target_execution_estimate,
    stopTrigger: plan.stop_price,
    stopExecution: plan.stop_execution_estimate,
    targetStrategy: plan.target_strategy,
    secondTargetTrigger: plan.medium_target,
    secondTargetExecution: plan.medium_target_execution_estimate,
    firstAllocation: plan.first_target_allocation_pct / 100,
  };
}

function makeTrade(
  history: MarketHistory,
  risk: RiskConfig,
  signalType: SignalType,
  signalTime: number,
  entryIdx: number,
  entryPrice: number,
  levels: EntryLevels,
  candidate: FinalCandidate,
  maxHoldBars: number,
  decisionEndMs: number,
  requirePlannedRR = true,
): { trade: Trade; exitIdx: number } | null {
  if (
    !(levels.targetTrigger > entryPrice) ||
    !(levels.targetExecution > entryPrice) ||
    !(levels.stopTrigger < entryPrice) ||
    !(levels.stopExecution < entryPrice)
  ) return null;
  const shortGain = netGainPct(
    entryPrice,
    levels.targetExecution,
    risk.feePerSidePct,
  );
  const secondGain = levels.targetStrategy === "SCALE_OUT" &&
      Number(levels.secondTargetExecution) > entryPrice
    ? netGainPct(
      entryPrice,
      Number(levels.secondTargetExecution),
      risk.feePerSidePct,
    )
    : shortGain;
  const firstAllocation = levels.targetStrategy === "SCALE_OUT"
    ? Math.min(0.9, Math.max(0.1, levels.firstAllocation ?? 0.6))
    : 1;
  const plannedGain = shortGain * firstAllocation +
    secondGain * (1 - firstAllocation);
  const plannedLoss = netLossPct(
    entryPrice,
    levels.stopExecution,
    risk.feePerSidePct,
  );
  const plannedRR = plannedLoss > 0 ? plannedGain / plannedLoss : 0;
  if (requirePlannedRR && (!(plannedGain > 0) || plannedRR < risk.minNetRR)) {
    return null;
  }

  const slippage = history.tickSize * risk.exitSlippageTicks;
  const resolved = levels.targetStrategy === "SCALE_OUT"
    ? resolveScaleOut(
      history.m15,
      entryIdx,
      entryPrice,
      levels,
      maxHoldBars,
      decisionEndMs,
      risk.feePerSidePct,
      slippage,
    )
    : resolveExit(
      history.m15,
      entryIdx,
      levels,
      maxHoldBars,
      decisionEndMs,
      slippage,
      entryPrice,
    );
  if (!resolved) return null;
  const assetNetPct = resolved.assetNetPctOverride ?? netGainPct(
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
      secondTarget: levels.targetStrategy === "SCALE_OUT"
        ? Number(levels.secondTargetTrigger)
        : null,
      stop: levels.stopTrigger,
      targetStrategy: levels.targetStrategy || "SHORT_ONLY",
      barsHeld: resolved.exitIdx - entryIdx + 1,
      assetNetPct,
      netPct: assetNetPct * allocation,
      allocationPct: allocation * 100,
      exitReason: resolved.exitReason,
      score: candidate.score,
      plannedRR,
      rawPredictedUpsidePct: candidate.forecast.raw_expected_upside_pct,
      predictedUpsidePct: candidate.forecast.expected_upside_pct,
      predictedHitProbabilityPct: candidate.forecast.target_hit_probability_pct,
      maxFavorableExcursionPct: resolved.maxFavorableExcursionPct,
      maxAdverseExcursionPct: resolved.maxAdverseExcursionPct,
      forecastErrorPct: resolved.maxFavorableExcursionPct -
        candidate.forecast.expected_upside_pct,
      ambiguousSameBar: resolved.ambiguousSameBar,
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

function findWaitEntry(
  history: MarketHistory,
  candidate: FinalCandidate,
  t: number,
  maxWait: number,
  rangeEnd: number,
): number {
  const watch = candidate.watch_entry_plan;
  const zoneLow = Number(watch.zone_low);
  const zoneHigh = Number(watch.zone_high);
  const stopTrigger = Number(watch.invalidation_price);
  if (!(zoneLow > 0 && zoneHigh >= zoneLow && stopTrigger > 0)) return -1;
  let touched = false;
  const lastWaitIdx = Math.min(history.m15.length - 2, t + maxWait);
  for (let k = t + 1; k <= lastWaitIdx; k++) {
    const bar = history.m15[k];
    if (bar.openTime + TF_MS.m15 >= rangeEnd) break;
    if (bar.low <= stopTrigger) break;
    if (bar.low <= zoneHigh && bar.high >= zoneLow) touched = true;
    if (!touched) continue;
    const metric = timeframeMetrics(rows(history.m15.slice(0, k + 1), 192));
    if (metric.ema21 != null && bar.close > metric.ema21) return k + 1;
  }
  return -1;
}

function simulateBuy(
  history: MarketHistory,
  risk: RiskConfig,
  opts: SimOptions,
): Trade[] {
  const range = bounds(history, opts);
  if (!range) return [];
  const maxHold = opts.maxHoldBars15m ?? 192;
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
    const made = makeTrade(
      history,
      risk,
      "BUY",
      decisionTime,
      entryIdx,
      entryPrice,
      levelsFromPlan(candidate.trade_plan),
      candidate,
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
  const maxHold = opts.maxHoldBars15m ?? 192;
  const maxWait = opts.maxWaitBars15m ?? 192;
  const step = Math.max(1, opts.stepBars ?? 1);
  const trades: Trade[] = [];
  let t = 96;
  while (t < history.m15.length - 2) {
    const decisionTime = history.m15[t].openTime + TF_MS.m15;
    if (decisionTime < range.start) { t++; continue; }
    if (decisionTime >= range.end) break;
    const candidate = candidateAt(history, t, risk);
    if (candidate?.decision !== "WAIT" || !candidate.watch_entry_plan.available) {
      t += step;
      continue;
    }
    const entryIdx = findWaitEntry(history, candidate, t, maxWait, range.end);
    if (entryIdx < 0 || entryIdx >= history.m15.length) { t += step; continue; }
    const entryPrice = history.m15[entryIdx].open +
      history.tickSize * risk.entrySlippageTicks;
    const watch = candidate.watch_entry_plan;
    if (entryPrice > Number(watch.max_price)) { t = entryIdx; continue; }
    const made = makeTrade(
      history,
      risk,
      "WAIT",
      decisionTime,
      entryIdx,
      entryPrice,
      {
        targetTrigger: Number(watch.reference_target),
        targetExecution: Number(watch.expected_exit_price) -
          history.tickSize * risk.exitSlippageTicks,
        stopTrigger: Number(watch.invalidation_price),
        stopExecution: Math.max(
          history.tickSize,
          Number(watch.invalidation_price) -
            history.tickSize * risk.exitSlippageTicks,
        ),
        targetStrategy: "SHORT_ONLY",
      },
      candidate,
      maxHold,
      range.end,
    );
    if (!made) { t = entryIdx; continue; }
    trades.push(made.trade);
    t = made.exitIdx + 1;
  }
  return trades;
}

function tradeOutcome(trade: Trade): SignalOutcome {
  if (trade.exitReason === "TARGET" || trade.exitReason === "PARTIAL_STOP") {
    return "TARGET_FIRST";
  }
  if (trade.exitReason === "STOP") return "STOP_FIRST";
  if (trade.assetNetPct > 0.02) return "TIMEOUT_PROFIT";
  if (trade.assetNetPct < -0.02) return "TIMEOUT_LOSS";
  return "TIMEOUT_FLAT";
}

function signalFromTrade(
  history: MarketHistory,
  candidate: FinalCandidate,
  trade: Trade,
): SignalEvaluation {
  const outcome = tradeOutcome(trade);
  const actual = outcome === "TARGET_FIRST" ? 1 : 0;
  const probability = candidate.forecast.target_hit_probability_pct / 100;
  return {
    market: history.market,
    exchange: history.exchange,
    signalTime: trade.signalTime,
    decision: candidate.decision,
    score: candidate.score,
    confidence: candidate.confidence,
    horizonCode: candidate.horizon.code,
    targetStrategy: trade.targetStrategy,
    entryStatus: "ENTERED",
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    outcome,
    exitReason: trade.exitReason,
    rawPredictedUpsidePct: candidate.forecast.raw_expected_upside_pct,
    predictedUpsidePct: candidate.forecast.expected_upside_pct,
    predictedHitProbabilityPct: candidate.forecast.target_hit_probability_pct,
    realizedNetPct: trade.assetNetPct,
    maxFavorableExcursionPct: trade.maxFavorableExcursionPct,
    maxAdverseExcursionPct: trade.maxAdverseExcursionPct,
    forecastErrorPct: trade.forecastErrorPct,
    brierScore: (probability - actual) ** 2,
    directionCorrect: trade.assetNetPct > 0,
    ambiguousSameBar: trade.ambiguousSameBar,
    failedGates: [...candidate.failed_gates],
  };
}

function evaluateSignals(
  history: MarketHistory,
  risk: RiskConfig,
  opts: SimOptions,
): SignalEvaluation[] {
  const range = bounds(history, opts);
  if (!range) return [];
  const maxHold = opts.maxHoldBars15m ?? 192;
  const maxWait = opts.maxWaitBars15m ?? 192;
  const step = Math.max(1, opts.signalStepBars ?? 4);
  const signals: SignalEvaluation[] = [];
  for (let t = 96; t < history.m15.length - 2; t += step) {
    const decisionTime = history.m15[t].openTime + TF_MS.m15;
    if (decisionTime < range.start) continue;
    if (decisionTime >= range.end) break;
    const candidate = candidateAt(history, t, risk);
    if (!candidate) continue;

    if (candidate.decision === "BUY") {
      const entryIdx = t + 1;
      const entryPrice = history.m15[entryIdx].open +
        history.tickSize * risk.entrySlippageTicks;
      const made = makeTrade(
        history,
        risk,
        "BUY",
        decisionTime,
        entryIdx,
        entryPrice,
        levelsFromPlan(candidate.trade_plan),
        candidate,
        maxHold,
        range.end,
        false,
      );
      if (made) signals.push(signalFromTrade(history, candidate, made.trade));
      continue;
    }

    if (candidate.decision === "WAIT" && candidate.watch_entry_plan.available) {
      const entryIdx = findWaitEntry(history, candidate, t, maxWait, range.end);
      if (entryIdx < 0 || entryIdx >= history.m15.length) {
        signals.push({
          market: history.market,
          exchange: history.exchange,
          signalTime: decisionTime,
          decision: candidate.decision,
          score: candidate.score,
          confidence: candidate.confidence,
          horizonCode: candidate.horizon.code,
          targetStrategy: "SHORT_ONLY",
          entryStatus: "NO_ENTRY",
          entryTime: null,
          entryPrice: null,
          exitTime: null,
          exitPrice: null,
          outcome: "NO_ENTRY",
          exitReason: null,
          rawPredictedUpsidePct: candidate.forecast.raw_expected_upside_pct,
          predictedUpsidePct: candidate.forecast.expected_upside_pct,
          predictedHitProbabilityPct: candidate.forecast.target_hit_probability_pct,
          realizedNetPct: null,
          maxFavorableExcursionPct: null,
          maxAdverseExcursionPct: null,
          forecastErrorPct: null,
          brierScore: null,
          directionCorrect: null,
          ambiguousSameBar: false,
          failedGates: [...candidate.failed_gates],
        });
        continue;
      }
      const entryPrice = history.m15[entryIdx].open +
        history.tickSize * risk.entrySlippageTicks;
      if (entryPrice > Number(candidate.watch_entry_plan.max_price)) continue;
      const made = makeTrade(
        history,
        risk,
        "WAIT",
        decisionTime,
        entryIdx,
        entryPrice,
        {
          targetTrigger: Number(candidate.watch_entry_plan.reference_target),
          targetExecution: Number(candidate.watch_entry_plan.expected_exit_price) -
            history.tickSize * risk.exitSlippageTicks,
          stopTrigger: Number(candidate.watch_entry_plan.invalidation_price),
          stopExecution: Math.max(
            history.tickSize,
            Number(candidate.watch_entry_plan.invalidation_price) -
              history.tickSize * risk.exitSlippageTicks,
          ),
          targetStrategy: "SHORT_ONLY",
        },
        candidate,
        maxHold,
        range.end,
        false,
      );
      if (made) signals.push(signalFromTrade(history, candidate, made.trade));
      continue;
    }

    // Rejected/blocked candidates are evaluated only when a complete, testable
    // target/stop structure exists. This measures whether each gate actually
    // prevented losses or merely hid a missed opportunity.
    const plan = candidate.trade_plan;
    if (!plan.structure_complete || !(plan.short_target > plan.entry_execution_estimate) ||
      !(plan.stop_price < plan.entry_execution_estimate)) continue;
    const entryIdx = t + 1;
    const entryPrice = history.m15[entryIdx].open +
      history.tickSize * risk.entrySlippageTicks;
    const resolved = resolveExit(
      history.m15,
      entryIdx,
      levelsFromPlan(plan),
      Math.min(maxHold, 192),
      range.end,
      history.tickSize * risk.exitSlippageTicks,
      entryPrice,
    );
    if (!resolved) continue;
    const realizedNet = netGainPct(entryPrice, resolved.exitPrice, risk.feePerSidePct);
    const missed = resolved.exitReason === "TARGET" ||
      (resolved.exitReason === "TIME" && realizedNet > 0.25 &&
        resolved.maxFavorableExcursionPct >= candidate.forecast.expected_upside_pct);
    signals.push({
      market: history.market,
      exchange: history.exchange,
      signalTime: decisionTime,
      decision: candidate.decision,
      score: candidate.score,
      confidence: candidate.confidence,
      horizonCode: candidate.horizon.code,
      targetStrategy: plan.target_strategy,
      entryStatus: "NOT_APPLICABLE",
      entryTime: history.m15[entryIdx].openTime,
      entryPrice,
      exitTime: history.m15[resolved.exitIdx].openTime + TF_MS.m15,
      exitPrice: resolved.exitPrice,
      outcome: missed ? "MISSED_OPPORTUNITY" : "REJECT_CORRECT",
      exitReason: resolved.exitReason,
      rawPredictedUpsidePct: candidate.forecast.raw_expected_upside_pct,
      predictedUpsidePct: candidate.forecast.expected_upside_pct,
      predictedHitProbabilityPct: candidate.forecast.target_hit_probability_pct,
      realizedNetPct: realizedNet,
      maxFavorableExcursionPct: resolved.maxFavorableExcursionPct,
      maxAdverseExcursionPct: resolved.maxAdverseExcursionPct,
      forecastErrorPct: resolved.maxFavorableExcursionPct -
        candidate.forecast.expected_upside_pct,
      brierScore: null,
      directionCorrect: !missed,
      ambiguousSameBar: resolved.ambiguousSameBar,
      failedGates: [...candidate.failed_gates],
    });
  }
  return signals;
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
    signals: evaluateSignals(history, risk, opts),
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
