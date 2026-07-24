// Trading-booooo v2.6.0 — guarded walk-forward calibration.
// Parameter selection uses TRAIN only. Promotion uses VALIDATION only. HOLDOUT
// is reported after the decision and never participates in selection/promotion.

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
} from "./run.ts";
import { buildCalibrationProfile, profileToTypeScript } from "./calibration.ts";

const CANDIDATES: Array<Partial<RiskConfig>> = [];
for (const scoreThreshold of [68, 72, 76]) {
  for (const shortTargetAtrMult of [1.8, 2.2, 2.8]) {
    for (const stopAtrMult of [0.9, 1.15]) {
      for (const minNetRR of [1.3, 1.5]) {
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

function objective(run: ReturnType<typeof runWindow>): number {
  const metrics = computeMetrics(run.buy);
  const accuracy = computeAccuracyMetrics(run.signals);
  const sample = Math.min(1, metrics.trades / 30);
  return sample * (
    metrics.expectancyPct * 3.5 +
    Math.min(3, finitePf(metrics.profitFactor)) * 0.9 +
    accuracy.buyHitRatePct / 100 * 1.2 +
    accuracy.rejectionAccuracyPct / 100 * 0.45 -
    accuracy.missedOpportunityRatePct / 100 * 0.8 -
    metrics.forecastMaePct * 0.28 -
    metrics.maxDrawdownPct * 0.08
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
  const scored = CANDIDATES.map((overrides) => {
    const trainRun = runWindow(histories, overrides, split.train, { stepBars: 4, signalStepBars: 4 });
    const metrics = computeMetrics(trainRun.buy);
    return { overrides, trainRun, metrics, score: objective(trainRun) };
  }).filter((row) =>
    row.metrics.trades >= 30 && row.metrics.expectancyPct > 0 &&
    finitePf(row.metrics.profitFactor) >= 1
  ).sort((a, b) => b.score - a.score || b.metrics.trades - a.metrics.trades);

  const selected = scored[0];
  if (!selected) {
    console.error("훈련구간 승격 가능한 조합이 없어 기존 프로필을 유지합니다.");
    Deno.exit(0);
  }
  const baselineValidation = runWindow(histories, {}, split.validation, { stepBars: 4, signalStepBars: 4 });
  const validation = runWindow(histories, selected.overrides, split.validation, { stepBars: 4, signalStepBars: 4 });
  const holdout = runWindow(histories, selected.overrides, split.test, { stepBars: 4, signalStepBars: 4 });
  const validationMetrics = computeMetrics(validation.buy);
  const validationAccuracy = computeAccuracyMetrics(validation.signals);
  const baselineMetrics = computeMetrics(baselineValidation.buy);
  const baselineScore = objective(baselineValidation);
  const candidateScore = objective(validation);

  const promotionChecks = {
    validationTrades: validationMetrics.trades >= 15,
    positiveExpectancy: validationMetrics.expectancyPct > 0,
    profitFactor: finitePf(validationMetrics.profitFactor) >= 1.08,
    drawdown: validationMetrics.maxDrawdownPct <= 18,
    missedOpportunity: validationAccuracy.missedOpportunityRatePct <= 40,
    objectiveImprovement: candidateScore >= baselineScore + 0.03 ||
      (baselineMetrics.trades === 0 && validationMetrics.trades >= 15),
    noForecastCollapse: validationMetrics.forecastMaePct <=
      Math.max(5, baselineMetrics.forecastMaePct * 1.15 || 5),
  };
  const promoted = Object.values(promotionChecks).every(Boolean);
  const calibrationSignals = [
    ...selected.trainRun.signals,
    ...validation.signals,
  ];
  const profile = buildCalibrationProfile({
    signals: calibrationSignals,
    parameters: requiredParameters(selected.overrides, histories[0].quoteCurrency),
    markets: histories.length,
    validationMetrics,
    validationAccuracy,
    promoted,
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
    `# Trading-booooo v${ENGINE_VERSION} 자동 교정 리포트`,
    "",
    `- 생성: ${report.generatedAt}`,
    `- 종목 수: ${histories.length}`,
    `- 승격 여부: ${promoted ? "PROMOTED" : "REJECTED — 기존 프로필 유지"}`,
    `- 선택 파라미터: ${JSON.stringify(profile.parameters)}`,
    "",
    "## 승격 조건",
    ...Object.entries(promotionChecks).map(([key, value]) =>
      `- ${value ? "PASS" : "FAIL"} · ${key}`
    ),
    "",
    "## VALIDATION 거래 성과",
    "```",
    formatReport(validationMetrics, { label: "candidate" }),
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
