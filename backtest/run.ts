// Trading-booooo v2.6.0 — backtest CLI.
// Default: aligned full-period report. --sweep: 60/20/20 train/validation/holdout.

import {
  buyAndHoldPct,
  type EvaluationWindow,
  type MarketHistory,
  simulateMarket,
  type SimOptions,
  type SignalEvaluation,
  type Trade,
  usableWindow,
} from "./simulate.ts";
import {
  computeAccuracyMetrics,
  computeMetrics,
  formatAccuracyReport,
  formatReport,
} from "./metrics.ts";
import {
  CALIBRATED_PARAMETERS,
  ENGINE_VERSION,
  type RiskConfig,
} from "../supabase/functions/market-scanner/engine.ts";

export const GRID = {
  scoreThreshold: [68, 72, 76, 80],
  shortTargetAtrMult: [1.8, 2.2, 2.8, 3.4],
  stopAtrMult: [0.9, 1.15, 1.4, 1.7],
  minNetRR: [1.3, 1.5, 1.8],
  mediumTargetAtr4hMult: [2.0, 2.4, 3.0],
  mediumTargetAtrDayMult: [1.0, 1.3, 1.6],
};

export const MIN_TRAIN_TRADES = 30;

export function baseRisk(quote: "KRW" | "USDT"): RiskConfig {
  const binance = quote === "USDT";
  return {
    capitalKrw: binance ? 500 : 500_000,
    quoteCurrency: quote,
    riskPct: 1,
    feePerSidePct: binance ? 0.1 : 0.05,
    minNetRR: CALIBRATED_PARAMETERS.minNetRR,
    maxStopPct: 5,
    entrySlippageTicks: 0.5,
    exitSlippageTicks: 1,
    scoreThreshold: CALIBRATED_PARAMETERS.scoreThreshold,
    shortTargetAtrMult: CALIBRATED_PARAMETERS.shortTargetAtrMult,
    stopAtrMult: CALIBRATED_PARAMETERS.stopAtrMult,
    mediumTargetAtr4hMult: CALIBRATED_PARAMETERS.mediumTargetAtr4hMult,
    mediumTargetAtrDayMult: CALIBRATED_PARAMETERS.mediumTargetAtrDayMult,
  };
}

export async function loadHistories(paths: string[]): Promise<MarketHistory[]> {
  const histories: MarketHistory[] = [];
  for (const path of paths) {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as MarketHistory;
    if (!parsed.exchange) {
      parsed.exchange = parsed.quoteCurrency === "KRW" ? "upbit" : "binance";
    }
    histories.push(parsed);
  }
  return histories;
}

export function commonWindow(
  histories: MarketHistory[],
): EvaluationWindow | null {
  const windows = histories.map(usableWindow).filter(
    (value): value is EvaluationWindow => value != null,
  );
  if (windows.length !== histories.length || !windows.length) return null;
  const startMs = Math.max(...windows.map((window) => window.startMs));
  const endMs = Math.min(...windows.map((window) => window.endMs));
  return startMs < endMs ? { startMs, endMs } : null;
}

export type WindowRun = {
  buy: Trade[];
  wait: Trade[];
  signals: SignalEvaluation[];
  benchmark: number;
  byMarket: Array<{
    market: string;
    buy: Trade[];
    wait: Trade[];
    signals: SignalEvaluation[];
    benchmark: number;
  }>;
};

export function runWindow(
  histories: MarketHistory[],
  overrides: Partial<RiskConfig>,
  window: EvaluationWindow,
  simulationOptions: SimOptions = {},
): WindowRun {
  const buy: Trade[] = [];
  const wait: Trade[] = [];
  const signals: SignalEvaluation[] = [];
  const byMarket: WindowRun["byMarket"] = [];
  for (const history of histories) {
    const risk = { ...baseRisk(history.quoteCurrency), ...overrides };
    const simulation = simulateMarket(history, risk, {
      ...simulationOptions,
      decisionStartMs: window.startMs,
      decisionEndMs: window.endMs,
    });
    buy.push(...simulation.buyTrades);
    wait.push(...simulation.waitTrades);
    signals.push(...simulation.signals);
    byMarket.push({
      market: history.market,
      buy: simulation.buyTrades,
      wait: simulation.waitTrades,
      signals: simulation.signals,
      benchmark: buyAndHoldPct(history, risk, window),
    });
  }
  buy.sort((a, b) => a.entryTime - b.entryTime);
  wait.sort((a, b) => a.entryTime - b.entryTime);
  signals.sort((a, b) => a.signalTime - b.signalTime);
  return {
    buy,
    wait,
    signals,
    benchmark: byMarket.reduce((sum, row) => sum + row.benchmark, 0) /
      byMarket.length,
    byMarket,
  };
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function printWindowReport(
  label: string,
  run: WindowRun,
  window: EvaluationWindow,
  multipleMarkets: boolean,
) {
  console.log(`\n## ${label} · ${date(window.startMs)} ~ ${date(window.endMs)}`);
  console.log(formatReport(computeMetrics(run.buy), {
    label: "즉시 BUY",
    benchmarkPct: run.benchmark,
    showEquity: !multipleMarkets,
  }));
  console.log();
  console.log(formatReport(computeMetrics(run.wait), {
    label: "조건부 WAIT 진입",
    benchmarkPct: run.benchmark,
    showEquity: !multipleMarkets,
  }));
  console.log();
  console.log(formatAccuracyReport(computeAccuracyMetrics(run.signals)));
  if (multipleMarkets) {
    console.log(
      "\n※ 다종목 합계는 동시 포지션의 자본배분을 재현하지 않은 pooled 신호 통계입니다.",
    );
    console.log("  따라서 합계 자본곡선·MDD·초과성과는 표시하지 않습니다.");
  }
}

export function splitWindow(window: EvaluationWindow): {
  train: EvaluationWindow;
  validation: EvaluationWindow;
  test: EvaluationWindow;
} {
  const span = window.endMs - window.startMs;
  const trainEnd = window.startMs + Math.floor(span * 0.6);
  const validationEnd = window.startMs + Math.floor(span * 0.8);
  return {
    train: { startMs: window.startMs, endMs: trainEnd },
    validation: { startMs: trainEnd, endMs: validationEnd },
    test: { startMs: validationEnd, endMs: window.endMs },
  };
}

function objective(run: WindowRun): {
  score: number;
  trades: number;
  expectancy: number;
  pf: number;
  forecastMae: number;
  missed: number;
  mdd: number;
} {
  const metrics = computeMetrics(run.buy);
  const accuracy = computeAccuracyMetrics(run.signals);
  const finitePf = Number.isFinite(metrics.profitFactor)
    ? metrics.profitFactor
    : 5;
  const sampleFactor = Math.min(1, metrics.trades / MIN_TRAIN_TRADES);
  const score = sampleFactor * (
    metrics.expectancyPct * 3.5 +
    Math.min(3, finitePf) * 0.9 +
    accuracy.buyHitRatePct / 100 * 1.2 +
    accuracy.rejectionAccuracyPct / 100 * 0.5 -
    accuracy.missedOpportunityRatePct / 100 * 0.8 -
    metrics.forecastMaePct * 0.3 -
    metrics.maxDrawdownPct * 0.08
  );
  return {
    score,
    trades: metrics.trades,
    expectancy: metrics.expectancyPct,
    pf: metrics.profitFactor,
    forecastMae: metrics.forecastMaePct,
    missed: accuracy.missedOpportunityRatePct,
    mdd: metrics.maxDrawdownPct,
  };
}

if (import.meta.main) {
  const args = [...Deno.args];
  const sweep = args.includes("--sweep");
  const jsonMode = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (!paths.length) {
    console.error("히스토리 JSON 경로를 넘기세요. 먼저 fetch-history.ts를 실행하세요.");
    Deno.exit(1);
  }
  const histories = await loadHistories(paths);
  const window = commonWindow(histories);
  if (!window) {
    console.error("공통 평가구간이 없습니다. 각 파일에 최소 125일 이상의 완성 봉이 필요합니다.");
    Deno.exit(1);
  }
  console.log(
    `Trading-booooo v${ENGINE_VERSION} 백테스트 · 종목 ${histories.length}개 · ` +
      `15분봉 ${histories.reduce((sum, h) => sum + h.m15.length, 0)}개`,
  );
  console.log("동적 호가·체결은 중립 가정이며 실시간 표본은 전진 페이퍼 평가로 분리합니다.");

  if (!sweep) {
    const run = runWindow(histories, {}, window);
    if (jsonMode) {
      console.log(JSON.stringify({
        version: ENGINE_VERSION,
        window,
        buy: computeMetrics(run.buy),
        wait: computeMetrics(run.wait),
        accuracy: computeAccuracyMetrics(run.signals),
      }, null, 2));
    } else {
      printWindowReport("기본 파라미터", run, window, histories.length > 1);
    }
    Deno.exit(0);
  }

  const split = splitWindow(window);
  type SweepRow = {
    overrides: Partial<RiskConfig>;
    label: string;
    objective: ReturnType<typeof objective>;
  };
  const rows: SweepRow[] = [];
  for (const scoreThreshold of GRID.scoreThreshold) {
    for (const shortTargetAtrMult of GRID.shortTargetAtrMult) {
      for (const stopAtrMult of GRID.stopAtrMult) {
        for (const minNetRR of GRID.minNetRR) {
          // Medium target multipliers are paired rather than fully crossed to
          // keep scheduled calibration runtime bounded.
          for (let mediumIndex = 0; mediumIndex < GRID.mediumTargetAtr4hMult.length; mediumIndex++) {
            const overrides = {
              scoreThreshold,
              shortTargetAtrMult,
              stopAtrMult,
              minNetRR,
              mediumTargetAtr4hMult: GRID.mediumTargetAtr4hMult[mediumIndex],
              mediumTargetAtrDayMult: GRID.mediumTargetAtrDayMult[mediumIndex],
            };
            const trainRun = runWindow(histories, overrides, split.train);
            rows.push({
              overrides,
              label: `score>=${scoreThreshold} target=${shortTargetAtrMult} ` +
                `stop=${stopAtrMult} RR>=${minNetRR} medium=` +
                `${overrides.mediumTargetAtr4hMult}/${overrides.mediumTargetAtrDayMult}`,
              objective: objective(trainRun),
            });
          }
        }
      }
    }
  }
  const candidates = rows.filter((row) =>
    row.objective.trades >= MIN_TRAIN_TRADES &&
    row.objective.expectancy > 0 && row.objective.pf >= 1
  ).sort((left, right) =>
    right.objective.score - left.objective.score ||
    right.objective.trades - left.objective.trades
  );
  if (!candidates.length) {
    console.log(
      `\n훈련구간에서 거래 ${MIN_TRAIN_TRADES}건·양의 기대값·PF 1 이상을 모두 만족한 조합이 없습니다.`,
    );
    console.log("운영 기본값을 변경하지 마세요.");
    Deno.exit(0);
  }
  const selected = candidates[0];
  console.log(`\n훈련구간에서만 선택된 연구 조합: ${selected.label}`);
  console.log("검증·홀드아웃 결과는 조합 선택에 사용하지 않았습니다.");
  printWindowReport(
    "TRAIN 60%",
    runWindow(histories, selected.overrides, split.train),
    split.train,
    histories.length > 1,
  );
  printWindowReport(
    "VALIDATION 20%",
    runWindow(histories, selected.overrides, split.validation),
    split.validation,
    histories.length > 1,
  );
  printWindowReport(
    "HOLDOUT TEST 20%",
    runWindow(histories, selected.overrides, split.test),
    split.test,
    histories.length > 1,
  );
  console.log(
    "\n⚠ HOLDOUT이 좋아도 선택 기준에는 넣지 않습니다. 운영 적용은 validation 승격조건과 전진 페이퍼 로그를 모두 통과해야 합니다.",
  );
}
