import type { MetricSummary, V5Trade } from "./types.ts";

export interface MetricContext {
  /** Number of eligible bars carrying the regime/state summarized by these trades. */
  regimeBars?: number;
  /** Total non-embargo bars in the same fold and split. */
  eligibleBars?: number;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

/**
 * Computes drawdown from the full supplied trade ledger. Trades sharing an exit
 * timestamp are settled as one batch so arbitrary market ordering cannot change
 * the result. Callers should summarize one fold/split/candidate allocation at a
 * time when they need a capital-consistent portfolio curve.
 */
export function maxDrawdownBps(trades: readonly V5Trade[]): number {
  const byExit = new Map<number, number>();
  for (const trade of trades) {
    byExit.set(trade.exitTime, (byExit.get(trade.exitTime) ?? 0) + trade.netBps);
  }
  const times = [...byExit.keys()].sort((left, right) => left - right);
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const time of times) {
    equity += byExit.get(time)!;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

export function summarizeTrades(
  trades: readonly V5Trade[],
  context: MetricContext = {},
): MetricSummary {
  const ordered = [...trades].sort((left, right) =>
    left.exitTime - right.exitTime ||
    left.entryTime - right.entryTime ||
    left.market.localeCompare(right.market)
  );
  const net = ordered.map((trade) => trade.netBps);
  const positive = net.filter((value) => value > 0);
  const negative = net.filter((value) => value < 0);
  const grossProfit = sum(positive);
  const grossLoss = Math.abs(sum(negative));
  const captures = ordered
    .map((trade) => trade.mfeCapture)
    // Raw net/MFE ratios intentionally retain negative capture after giveback.
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const stops =
    ordered.filter((trade) =>
      trade.exitReason === "STOP" || trade.exitReason === "STOP_GAP" ||
      trade.exitReason === "TRAIL_CLOSE_EXIT"
    )
      .length;
  const targets = ordered.filter((trade) => trade.exitReason === "TARGET").length;
  const timeStops = ordered.filter((trade) => trade.exitReason === "TIME_STOP").length;
  const eligibleBars = Math.max(0, Math.round(Number(context.eligibleBars) || 0));
  const regimeBars = Math.max(0, Math.round(Number(context.regimeBars) || 0));

  return {
    trades: ordered.length,
    wins: positive.length,
    losses: ordered.length - positive.length,
    winRate: ordered.length ? positive.length / ordered.length : 0,
    grossPnlBps: sum(ordered.map((trade) => trade.grossBps)),
    netPnlBps: sum(net),
    stressNetPnlBps: sum(ordered.map((trade) => trade.stressNetBps)),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageReturnBps: average(net),
    maxDrawdownBps: maxDrawdownBps(ordered),
    averageMfeBps: average(ordered.map((trade) => trade.mfeBps)),
    averageMaeBps: average(ordered.map((trade) => trade.maeBps)),
    mfeCaptureRatio: captures.length ? average(captures) : null,
    profitGivebackBps: average(ordered.map((trade) => trade.givebackBps)),
    averageHoldBars: average(ordered.map((trade) => trade.holdBars)),
    stopHitRate: ordered.length ? stops / ordered.length : 0,
    targetHitRate: ordered.length ? targets / ordered.length : 0,
    timeStopRate: ordered.length ? timeStops / ordered.length : 0,
    regimeFrequency: eligibleBars ? Math.min(1, regimeBars / eligibleBars) : 0,
  };
}

export interface MetricGroup {
  fold: number;
  split: V5Trade["split"];
  candidate: string;
  summary: MetricSummary;
}

/** Groups without mixing folds or chronological splits. */
export function summarizeByFoldSplitCandidate(
  trades: readonly V5Trade[],
  contextFor?: (fold: number, split: V5Trade["split"], candidate: string) => MetricContext,
): MetricGroup[] {
  const groups = new Map<string, V5Trade[]>();
  for (const trade of trades) {
    const key = `${trade.fold}\u0000${trade.split}\u0000${trade.candidate}`;
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { fold, split, candidate } = group[0];
      return {
        fold,
        split,
        candidate,
        summary: summarizeTrades(group, contextFor?.(fold, split, candidate)),
      };
    })
    .sort((left, right) =>
      left.fold - right.fold ||
      left.split.localeCompare(right.split) ||
      left.candidate.localeCompare(right.candidate)
    );
}
