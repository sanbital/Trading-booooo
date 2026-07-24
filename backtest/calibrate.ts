// Trading-booooo v4.0.0 — guarded, rolling walk-forward self-calibration.
// TRAIN selects the challenger. Multiple chronological VALIDATION folds decide
// promotion. HOLDOUT is reported after the decision and never participates in it.

import { ACTIVE_CALIBRATION_PROFILE } from "../supabase/functions/market-scanner/calibration-profile.ts";
import { ENGINE_VERSION, type RiskConfig } from "../supabase/functions/market-scanner/engine.ts";
import {
  computeAccuracyMetrics,
  computeMetrics,
  formatAccuracyReport,
  formatReport,
} from "./metrics.ts";
import {
  baseRisk,
  commonWindow,
  loadHistories,
  runWindow,
  splitWindow,
  type WindowRun,
} from "./run.ts";
import type { EvaluationWindow } from "./simulate.ts";
import { buildCalibrationProfile, profileToTypeScript } from "./calibration.ts";

const CANDIDATES: Array<Partial<RiskConfig>> = [];
for (const scoreThreshold of [68, 72, 76]) {
  for (const shortTargetAtrMult of [1.8, 2.4, 3.0]) {
    for (const stopAtrMult of [1.0, 1.35]) {
      for (const minNetRR of [1.3, 1.5, 1.8]) {
        CANDIDATES.push({
          scoreThreshold,
          shortTargetAtrMult,
          stopAtrMult,
          minNetRR,
          mediumTargetAtr4hMult: shortTargetAtrMult >= 2.8 ? 3.0 : 2.4,
          mediumTargetAtrDayMult: shortTargetAtrMult >= 2.8 ? 1.6 : 1.3,
        });
      }
    }
  }
}

function finitePf(value: number): number {
  return Number.isFinite(value) ? value : 5;
}

function objective(run: WindowRun): number {
  const metrics = computeMetrics(run.buy);
  const accuracy = computeAccuracyMetrics(run.signals);
  const sample = Math.min(1, metrics.trades / 100);
  // Profit-first objective: after-cost expectancy and realised equity growth
  // dominate. Hit-rate is only a supporting diagnostic so a high-accuracy but
  // negative-payoff strategy cannot win calibration.
  return sample * (
    metrics.expectancyPct * 4.5 +
    metrics.equityFinalPct * 0.18 +
    Math.min(3, finitePf(metrics.profitFactor)) * 1.0 +
    Math.max(0, metrics.avgRealizedRR) * 0.45 +
    accuracy.buyHitRatePct / 100 * 0.45 +
    accuracy.rejectionAccuracyPct / 100 * 0.30 -
    accuracy.missedOpportunityRatePct / 100 * 0.65 -
    metrics.forecastMaePct * 0.22 -
    Math.abs(metrics.forecastBiasPct) * 0.10 -
    metrics.maxDrawdownPct * 0.12
  );
}

function requiredParameters(
  overrides: Partial<RiskConfig>,
  quote: "KRW" | "USDT",
) {
  const merged = { ...baseRisk(quote), ...overrides };
  return {
    scoreThreshold: Number(merged.scoreThreshold),
    shortTargetAtrMult: Number(merged.shortTargetAtrMult),
    stopAtrMult: Number(merged.stopAtrMult),
    minNetRR: Number(merged.minNetRR),
    mediumTargetAtr4hMult: Number(merged.mediumTargetAtr4hMult),
    mediumTargetAtrDayMult: Number(merged.mediumTargetAtrDayMult),
  };
}

function rollingFolds(window: EvaluationWindow, count = 3): EvaluationWindow[] {
  const span = window.endMs - window.startMs;
  return Array.from({ length: count }, (_, index) => ({
    startMs: window.startMs + Math.floor(span * index / count),
    endMs: window.startMs + Math.floor(span * (index + 1) / count),
  }));
}

function parameterDriftSafe(candidate: ReturnType<typeof requiredParameters>): boolean {
  const current = ACTIVE_CALIBRATION_PROFILE.parameters;
  const limits: Record<keyof typeof candidate, number> = {
    scoreThreshold: 8,
    shortTargetAtrMult: 1.2,
    stopAtrMult: 0.55,
    minNetRR: 0.5,
    mediumTargetAtr4hMult: 1.0,
    mediumTargetAtrDayMult: 0.6,
  };
  return (Object.keys(candidate) as Array<keyof typeof candidate>).every((key) =>
    Math.abs(candidate[key] - current[key]) <= limits[key]
  );
}

if (import.meta.main) {
  const args = [...Deno.args];
  const writeProfile = args.includes("--write-profile");
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (!paths.length) {
    console.error("사용: deno run -A backtest/calibrate.ts [--write-profile] backtest/data/*.json");
    Deno.exit(1);
  }
  const histories = await loadHistories(paths);
  const common = commonWindow(histories);
  if (!common) {
    console.error("공통 평가구간이 없습니다. 최소 125일 이상의 데이터가 필요합니다.");
    Deno.exit(1);
  }
  const split = splitWindow(common);
  const simulationOptions = { stepBars: 4, signalStepBars: 4 };
  const scored = CANDIDATES.map((overrides) => {
    const trainRun = runWindow(histories, overrides, split.train, simulationOptions);
    const metrics = computeMetrics(trainRun.buy);
    return { overrides, trainRun, metrics, score: objective(trainRun) };
  }).filter((row) =>
    row.metrics.trades >= 100 && row.metrics.expectancyPct > 0 &&
    finitePf(row.metrics.profitFactor) >= 1
  ).sort((a, b) => b.score - a.score || b.metrics.trades - a.metrics.trades);

  const selected = scored[0];
  if (!selected) {
    console.error("훈련구간 승격 가능한 조합이 없어 기존 프로필을 유지합니다.");
    Deno.exit(0);
  }

  const candidateParameters = requiredParameters(selected.overrides, histories[0].quoteCurrency);
  const validationFolds = rollingFolds(split.validation, 3);
  const foldReports = validationFolds.map((window, index) => {
    const baseline = runWindow(histories, {}, window, simulationOptions);
    const challenger = runWindow(histories, selected.overrides, window, simulationOptions);
    const baselineMetrics = computeMetrics(baseline.buy);
    const challengerMetrics = computeMetrics(challenger.buy);
    const challengerAccuracy = computeAccuracyMetrics(challenger.signals);
    const baselineObjective = objective(baseline);
    const challengerObjective = objective(challenger);
    const passed = challengerMetrics.trades >= 20 &&
      challengerMetrics.expectancyPct > 0 &&
      challengerMetrics.equityFinalPct > 0 &&
      finitePf(challengerMetrics.profitFactor) >= 0.95 &&
      challengerMetrics.maxDrawdownPct <= 18 &&
      challengerAccuracy.missedOpportunityRatePct <= 45 &&
      challengerObjective >= baselineObjective - 0.02;
    return {
      fold: index + 1,
      window,
      passed,
      baselineMetrics,
      challengerMetrics,
      challengerAccuracy,
      baselineObjective,
      challengerObjective,
    };
  });

  const baselineValidation = runWindow(histories, {}, split.validation, simulationOptions);
  const validation = runWindow(histories, selected.overrides, split.validation, simulationOptions);
  const holdout = runWindow(histories, selected.overrides, split.test, simulationOptions);
  const validationMetrics = computeMetrics(validation.buy);
  const validationAccuracy = computeAccuracyMetrics(validation.signals);
  const baselineMetrics = computeMetrics(baselineValidation.buy);
  const baselineScore = objective(baselineValidation);
  const candidateScore = objective(validation);
  const foldsPassed = foldReports.filter((row) => row.passed).length;

  const promotionChecks = {
    validationTrades: validationMetrics.trades >= 60,
    positiveExpectancy: validationMetrics.expectancyPct > 0,
    positiveNetEquity: validationMetrics.equityFinalPct > 0,
    positiveMedianTrade: validationMetrics.medianPct > 0,
    realizedRewardRisk: validationMetrics.avgRealizedRR >= 0.15,
    profitFactor: finitePf(validationMetrics.profitFactor) >= 1.12,
    drawdown: validationMetrics.maxDrawdownPct <= 18,
    missedOpportunity: validationAccuracy.missedOpportunityRatePct <= 40,
    objectiveImprovement: candidateScore >= baselineScore + 0.03 ||
      (baselineMetrics.trades === 0 && validationMetrics.trades >= 60),
    noForecastCollapse: validationMetrics.forecastMaePct <=
      Math.max(5, baselineMetrics.forecastMaePct * 1.15 || 5),
    noForecastBiasExplosion: Math.abs(validationMetrics.forecastBiasPct) <=
      Math.max(3.5, Math.abs(baselineMetrics.forecastBiasPct) + 1.25),
    rollingStability: foldsPassed >= 2,
    noCatastrophicFold: foldReports.every((row) =>
      row.challengerMetrics.maxDrawdownPct <= 22 &&
      row.challengerMetrics.equityFinalPct > -1.5 &&
      finitePf(row.challengerMetrics.profitFactor) >= 0.75
    ),
    boundedParameterDrift: parameterDriftSafe(candidateParameters),
  };
  const promoted = Object.values(promotionChecks).every(Boolean);
  const calibrationSignals = [
    ...selected.trainRun.signals,
    ...validation.signals,
  ];
  const profile = buildCalibrationProfile({
    signals: calibrationSignals,
    parameters: candidateParameters,
    markets: histories.length,
    validationMetrics,
    validationAccuracy,
    promoted,
    rollingFoldsPassed: foldsPassed,
    rollingFoldsTotal: foldReports.length,
  });

  const report = {
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    histories: histories.map((history) => ({
      exchange: history.exchange,
      market: history.market,
      m15: history.m15.length,
    })),
    selectedParameters: profile.parameters,
    currentParameters: ACTIVE_CALIBRATION_PROFILE.parameters,
    promotionChecks,
    promoted,
    train: {
      trades: computeMetrics(selected.trainRun.buy),
      accuracy: computeAccuracyMetrics(selected.trainRun.signals),
    },
    validation: {
      baseline: baselineMetrics,
      candidate: validationMetrics,
      accuracy: validationAccuracy,
      baselineObjective: baselineScore,
      candidateObjective: candidateScore,
      rollingFolds: foldReports,
    },
    holdoutMonitoringOnly: {
      trades: computeMetrics(holdout.buy),
      accuracy: computeAccuracyMetrics(holdout.signals),
    },
    profile,
  };

  await Deno.mkdir("backtest/output", { recursive: true });
  await Deno.writeTextFile(
    "backtest/output/calibration-report.json",
    JSON.stringify(report, null, 2),
  );
  const markdown = [
    `# Trading-booooo v${ENGINE_VERSION} 자기교정 리포트`,
    "",
    `- 생성: ${report.generatedAt}`,
    `- 종목 수: ${histories.length}`,
    `- 승격 여부: ${promoted ? "PROMOTED" : "REJECTED — 기존 프로필 유지"}`,
    `- 선택 파라미터: ${JSON.stringify(profile.parameters)}`,
    `- 롤링 검증: ${foldsPassed}/${foldReports.length}개 구간 통과`,
    `- 최근 데이터 반감기: ${profile.recencyHalfLifeDays}일`,
    `- 학습 세그먼트: ${profile.segments.length}개`,
    "",
    "## 승격 조건",
    ...Object.entries(promotionChecks).map(([key, value]) =>
      `- ${value ? "PASS" : "FAIL"} · ${key}`
    ),
    "",
    "## 롤링 검증",
    ...foldReports.map((row) =>
      `- Fold ${row.fold}: ${row.passed ? "PASS" : "FAIL"} · 거래 ${row.challengerMetrics.trades} · 기대값 ${row.challengerMetrics.expectancyPct.toFixed(3)}% · PF ${Number.isFinite(row.challengerMetrics.profitFactor) ? row.challengerMetrics.profitFactor.toFixed(2) : "∞"}`
    ),
    "",
    "## VALIDATION 거래 성과",
    "```",
    formatReport(validationMetrics, { label: "challenger" }),
    "```",
    "",
    "## VALIDATION 실제 일치율",
    "```",
    formatAccuracyReport(validationAccuracy),
    "```",
    "",
    "## HOLDOUT 모니터링(선택·승격에 미사용)",
    "```",
    formatReport(computeMetrics(holdout.buy), { label: "holdout" }),
    formatAccuracyReport(computeAccuracyMetrics(holdout.signals)),
    "```",
  ].join("\n");
  await Deno.writeTextFile("backtest/output/calibration-report.md", markdown);

  const historyRow = JSON.stringify({
    generatedAt: report.generatedAt,
    engineVersion: ENGINE_VERSION,
    promoted,
    selectedParameters: profile.parameters,
    promotionChecks,
    validation: validationMetrics,
    validationAccuracy,
    foldsPassed,
    foldsTotal: foldReports.length,
    holdoutMonitoringOnly: report.holdoutMonitoringOnly,
  });
  let existingHistory = "";
  try {
    existingHistory = await Deno.readTextFile("backtest/calibration-history.jsonl");
  } catch {
    // First run.
  }
  const historyLines = existingHistory.trim().split("\n").filter(Boolean).slice(-51);
  historyLines.push(historyRow);
  await Deno.writeTextFile("backtest/calibration-history.jsonl", historyLines.join("\n") + "\n");

  if (writeProfile && promoted) {
    await Deno.writeTextFile(
      "supabase/functions/market-scanner/calibration-profile.ts",
      profileToTypeScript(profile),
    );
    console.log("PROMOTED: calibration-profile.ts를 갱신했습니다.");
  } else if (writeProfile) {
    console.log("NOT PROMOTED: 기존 calibration-profile.ts를 유지합니다.");
  }
  console.log(markdown);
}
