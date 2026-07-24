import type { SignalEvaluation, Trade } from "./simulate.ts";

export type Metrics = {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  winRate95LowPct: number;
  winRate95HighPct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  medianPct: number;
  profitFactor: number;
  avgRealizedRR: number;
  avgBarsHeld: number;
  avgAllocationPct: number;
  exitBreakdown: { target: number; stop: number; partialStop: number; time: number };
  equityFinalPct: number;
  maxDrawdownPct: number;
  avgPlannedRR: number;
  avgScore: number;
  avgMfePct: number;
  avgMaePct: number;
  forecastMaePct: number;
  forecastRmsePct: number;
  forecastBiasPct: number;
  ambiguousTrades: number;
};

export type GateAccuracy = {
  gate: string;
  samples: number;
  correctRejections: number;
  missedOpportunities: number;
  accuracyPct: number;
  missedOpportunityPct: number;
};

export type AccuracyMetrics = {
  signals: number;
  enteredSignals: number;
  buySignals: number;
  buyHitRatePct: number;
  waitSignals: number;
  waitEntries: number;
  waitEntryRatePct: number;
  waitHitRatePct: number;
  targetFirst: number;
  stopFirst: number;
  timeoutProfit: number;
  timeoutLoss: number;
  noEntry: number;
  rejectedSignals: number;
  rejectionAccuracyPct: number;
  missedOpportunityRatePct: number;
  directionAccuracyPct: number;
  avgMfePct: number;
  avgMaePct: number;
  forecastMaePct: number;
  forecastRmsePct: number;
  forecastBiasPct: number;
  probabilityBrierScore: number;
  ambiguousSignals: number;
  byGate: GateAccuracy[];
};

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]) => a.length ? sum(a) / a.length : 0;
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

function wilson95(wins: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.959963984540054;
  const p = wins / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) /
    denominator;
  return [Math.max(0, center - margin) * 100, Math.min(1, center + margin) * 100];
}

export function computeMetrics(trades: Trade[]): Metrics {
  const n = trades.length;
  const empty: Metrics = {
    trades: 0,
    wins: 0,
    losses: 0,
    winRatePct: 0,
    winRate95LowPct: 0,
    winRate95HighPct: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    expectancyPct: 0,
    medianPct: 0,
    profitFactor: 0,
    avgRealizedRR: 0,
    avgBarsHeld: 0,
    avgAllocationPct: 0,
    exitBreakdown: { target: 0, stop: 0, partialStop: 0, time: 0 },
    equityFinalPct: 0,
    maxDrawdownPct: 0,
    avgPlannedRR: 0,
    avgScore: 0,
    avgMfePct: 0,
    avgMaePct: 0,
    forecastMaePct: 0,
    forecastRmsePct: 0,
    forecastBiasPct: 0,
    ambiguousTrades: 0,
  };
  if (!n) return empty;

  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const nets = trades.map((t) => t.netPct);
  const grossWin = sum(wins.map((t) => t.netPct));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPct)));
  const avgWin = mean(wins.map((t) => t.netPct));
  const avgLoss = Math.abs(mean(losses.map((t) => t.netPct)));
  const [winLow, winHigh] = wilson95(wins.length, n);
  const forecastErrors = trades.map((t) => t.forecastErrorPct);

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) {
    equity *= 1 + t.netPct / 100;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: wins.length / n * 100,
    winRate95LowPct: winLow,
    winRate95HighPct: winHigh,
    avgWinPct: avgWin,
    avgLossPct: -avgLoss,
    expectancyPct: mean(nets),
    medianPct: median(nets),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    avgRealizedRR: avgLoss > 0 ? avgWin / avgLoss : Infinity,
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
    avgAllocationPct: mean(trades.map((t) => t.allocationPct)),
    exitBreakdown: {
      target: trades.filter((t) => t.exitReason === "TARGET").length,
      stop: trades.filter((t) => t.exitReason === "STOP").length,
      partialStop: trades.filter((t) => t.exitReason === "PARTIAL_STOP").length,
      time: trades.filter((t) => t.exitReason === "TIME").length,
    },
    equityFinalPct: (equity - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    avgPlannedRR: mean(trades.map((t) => t.plannedRR)),
    avgScore: mean(trades.map((t) => t.score)),
    avgMfePct: mean(trades.map((t) => t.maxFavorableExcursionPct)),
    avgMaePct: mean(trades.map((t) => t.maxAdverseExcursionPct)),
    forecastMaePct: mean(forecastErrors.map(Math.abs)),
    forecastRmsePct: Math.sqrt(mean(forecastErrors.map((value) => value ** 2))),
    forecastBiasPct: mean(forecastErrors),
    ambiguousTrades: trades.filter((t) => t.ambiguousSameBar).length,
  };
}

export function computeAccuracyMetrics(signals: SignalEvaluation[]): AccuracyMetrics {
  const entered = signals.filter((signal) => signal.entryStatus === "ENTERED");
  const buy = entered.filter((signal) => signal.decision === "BUY");
  const waits = signals.filter((signal) => signal.decision === "WAIT");
  const waitEntries = entered.filter((signal) => signal.decision === "WAIT");
  const hit = (signal: SignalEvaluation) => signal.outcome === "TARGET_FIRST";
  const rejected = signals.filter((signal) =>
    signal.outcome === "REJECT_CORRECT" || signal.outcome === "MISSED_OPPORTUNITY"
  );
  const errors = entered
    .map((signal) => signal.forecastErrorPct)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const mfes = entered
    .map((signal) => signal.maxFavorableExcursionPct)
    .filter((value): value is number => value != null);
  const maes = entered
    .map((signal) => signal.maxAdverseExcursionPct)
    .filter((value): value is number => value != null);
  const direction = signals.filter((signal) => signal.directionCorrect != null);
  const briers = entered
    .map((signal) => signal.brierScore)
    .filter((value): value is number => value != null);

  const gateMap = new Map<string, { correct: number; missed: number }>();
  for (const signal of rejected) {
    for (const gate of signal.failedGates) {
      const row = gateMap.get(gate) || { correct: 0, missed: 0 };
      if (signal.outcome === "REJECT_CORRECT") row.correct++;
      else row.missed++;
      gateMap.set(gate, row);
    }
  }
  const byGate = [...gateMap.entries()].map(([gate, row]) => {
    const samples = row.correct + row.missed;
    return {
      gate,
      samples,
      correctRejections: row.correct,
      missedOpportunities: row.missed,
      accuracyPct: samples ? row.correct / samples * 100 : 0,
      missedOpportunityPct: samples ? row.missed / samples * 100 : 0,
    };
  }).sort((a, b) => b.samples - a.samples || b.accuracyPct - a.accuracyPct);

  return {
    signals: signals.length,
    enteredSignals: entered.length,
    buySignals: buy.length,
    buyHitRatePct: buy.length ? buy.filter(hit).length / buy.length * 100 : 0,
    waitSignals: waits.length,
    waitEntries: waitEntries.length,
    waitEntryRatePct: waits.length ? waitEntries.length / waits.length * 100 : 0,
    waitHitRatePct: waitEntries.length
      ? waitEntries.filter(hit).length / waitEntries.length * 100
      : 0,
    targetFirst: entered.filter(hit).length,
    stopFirst: entered.filter((signal) => signal.outcome === "STOP_FIRST").length,
    timeoutProfit: entered.filter((signal) => signal.outcome === "TIMEOUT_PROFIT").length,
    timeoutLoss: entered.filter((signal) => signal.outcome === "TIMEOUT_LOSS").length,
    noEntry: signals.filter((signal) => signal.outcome === "NO_ENTRY").length,
    rejectedSignals: rejected.length,
    rejectionAccuracyPct: rejected.length
      ? rejected.filter((signal) => signal.outcome === "REJECT_CORRECT").length /
        rejected.length * 100
      : 0,
    missedOpportunityRatePct: rejected.length
      ? rejected.filter((signal) => signal.outcome === "MISSED_OPPORTUNITY").length /
        rejected.length * 100
      : 0,
    directionAccuracyPct: direction.length
      ? direction.filter((signal) => signal.directionCorrect).length /
        direction.length * 100
      : 0,
    avgMfePct: mean(mfes),
    avgMaePct: mean(maes),
    forecastMaePct: mean(errors.map(Math.abs)),
    forecastRmsePct: Math.sqrt(mean(errors.map((value) => value ** 2))),
    forecastBiasPct: mean(errors),
    probabilityBrierScore: mean(briers),
    ambiguousSignals: signals.filter((signal) => signal.ambiguousSameBar).length,
    byGate,
  };
}

export function formatReport(
  m: Metrics,
  extra: {
    benchmarkPct?: number;
    label?: string;
    showEquity?: boolean;
  } = {},
): string {
  const f = (x: number, d = 2) =>
    Number.isFinite(x) ? x.toFixed(d) : x > 0 ? "∞" : "-";
  const lines: string[] = [];
  lines.push(`── 백테스트 결과${extra.label ? ` · ${extra.label}` : ""} ──`);
  lines.push(`거래 수             ${m.trades}`);
  lines.push(
    `승률               ${f(m.winRatePct, 1)}% (95% 구간 ${f(m.winRate95LowPct, 1)}~${f(m.winRate95HighPct, 1)}%)`,
  );
  lines.push(`거래당 자본 기대값    ${f(m.expectancyPct)}% (중앙값 ${f(m.medianPct)}%)`);
  lines.push(`평균 자본 이익/손실   +${f(m.avgWinPct)}% / ${f(m.avgLossPct)}%`);
  lines.push(`Profit Factor      ${f(m.profitFactor)}`);
  lines.push(`평균 실현/계획 RR    ${f(m.avgRealizedRR)} / ${f(m.avgPlannedRR)}`);
  lines.push(`평균 투입 비중        ${f(m.avgAllocationPct, 1)}%`);
  if (extra.showEquity !== false) {
    lines.push(`순차 복리 누적        ${f(m.equityFinalPct)}%`);
    lines.push(`최대 낙폭(MDD)       ${f(m.maxDrawdownPct)}%`);
  }
  lines.push(`평균 보유            ${f(m.avgBarsHeld, 1)}봉 (15분)`);
  lines.push(
    `청산 사유           목표 ${m.exitBreakdown.target} / 손절 ${m.exitBreakdown.stop} / 1차후본전 ${m.exitBreakdown.partialStop} / 시간 ${m.exitBreakdown.time}`,
  );
  lines.push(`평균 MFE / MAE      +${f(m.avgMfePct)}% / -${f(m.avgMaePct)}%`);
  lines.push(
    `상승률 예측오차      MAE ${f(m.forecastMaePct)}%p / RMSE ${f(m.forecastRmsePct)}%p / 편향 ${f(m.forecastBiasPct)}%p`,
  );
  lines.push(`동일봉 목표·손절      ${m.ambiguousTrades}건 (보수적 손절 처리)`);
  lines.push(`평균 진입점수         ${f(m.avgScore, 1)}`);
  if (extra.benchmarkPct !== undefined) {
    lines.push(`동일기간 단순보유      ${f(extra.benchmarkPct)}%`);
    if (extra.showEquity !== false) {
      const edge = m.equityFinalPct - extra.benchmarkPct;
      lines.push(`초과성과             ${edge >= 0 ? "+" : ""}${f(edge)}%p`);
    }
  }
  return lines.join("\n");
}

export function formatAccuracyReport(m: AccuracyMetrics): string {
  const f = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : "-";
  return [
    "── 신호 실제 일치율 ──",
    `전체 평가 신호       ${m.signals}`,
    `실제 진입 신호       ${m.enteredSignals}`,
    `BUY 목표 선도달률    ${f(m.buyHitRatePct)}% (${m.buySignals}건)`,
    `WAIT 조건 발동률     ${f(m.waitEntryRatePct)}% (${m.waitEntries}/${m.waitSignals})`,
    `발동 WAIT 적중률     ${f(m.waitHitRatePct)}%`,
    `목표/손절 선도달     ${m.targetFirst} / ${m.stopFirst}`,
    `시간종료 이익/손실   ${m.timeoutProfit} / ${m.timeoutLoss}`,
    `거절 정확도          ${f(m.rejectionAccuracyPct)}%`,
    `놓친 기회율          ${f(m.missedOpportunityRatePct)}%`,
    `방향 일치율          ${f(m.directionAccuracyPct)}%`,
    `평균 MFE / MAE      +${f(m.avgMfePct, 2)}% / -${f(m.avgMaePct, 2)}%`,
    `상승률 예측 MAE      ${f(m.forecastMaePct, 2)}%p`,
    `상승률 예측 편향     ${f(m.forecastBiasPct, 2)}%p`,
    `확률 Brier Score    ${f(m.probabilityBrierScore, 3)} (낮을수록 우수)`,
    `동일봉 모호 신호     ${m.ambiguousSignals}건 (손절 우선)`,
  ].join("\n");
}
