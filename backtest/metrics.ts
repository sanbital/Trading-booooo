import type { Trade } from "./simulate.ts";

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
  exitBreakdown: { target: number; stop: number; time: number };
  equityFinalPct: number;
  maxDrawdownPct: number;
  avgPlannedRR: number;
  avgScore: number;
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
    exitBreakdown: { target: 0, stop: 0, time: 0 },
    equityFinalPct: 0,
    maxDrawdownPct: 0,
    avgPlannedRR: 0,
    avgScore: 0,
  };
  if (!n) return empty;

  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const mean = (a: number[]) => a.length ? sum(a) / a.length : 0;
  const nets = trades.map((t) => t.netPct).sort((a, b) => a - b);
  const median = nets.length % 2
    ? nets[(nets.length - 1) / 2]
    : (nets[nets.length / 2 - 1] + nets[nets.length / 2]) / 2;
  const grossWin = sum(wins.map((t) => t.netPct));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPct)));
  const avgWin = mean(wins.map((t) => t.netPct));
  const avgLoss = Math.abs(mean(losses.map((t) => t.netPct)));
  const [winLow, winHigh] = wilson95(wins.length, n);

  // 단일 종목에서는 포지션이 중복되지 않는다. 여러 종목을 합친 값은
  // run.ts에서 자본곡선이 아닌 pooled signal 통계라고 명시한다.
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
    medianPct: median,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    avgRealizedRR: avgLoss > 0 ? avgWin / avgLoss : Infinity,
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
    avgAllocationPct: mean(trades.map((t) => t.allocationPct)),
    exitBreakdown: {
      target: trades.filter((t) => t.exitReason === "TARGET").length,
      stop: trades.filter((t) => t.exitReason === "STOP").length,
      time: trades.filter((t) => t.exitReason === "TIME").length,
    },
    equityFinalPct: (equity - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    avgPlannedRR: mean(trades.map((t) => t.plannedRR)),
    avgScore: mean(trades.map((t) => t.score)),
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
    `청산 사유           목표 ${m.exitBreakdown.target} / 손절 ${m.exitBreakdown.stop} / 시간 ${m.exitBreakdown.time}`,
  );
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
