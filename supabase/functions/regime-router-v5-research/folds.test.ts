import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertMetricCompleteness,
  buildRollingFolds,
  type CandidateFoldMetric,
  DAY_MS,
  evaluateCandidateValidation,
  expectedMetricCompleteness,
  FINAL_HISTORICAL_TEST_LABEL,
  selectedCandidates,
  splitForFold,
} from "./folds.ts";
import { BAR_MS } from "./types.ts";

function assertThrowsLocal(fn: () => unknown, messageIncludes?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, "expected function to throw an Error");
  if (messageIncludes !== undefined) {
    assert(
      thrown.message.includes(messageIncludes),
      `expected error message to include ${JSON.stringify(messageIncludes)}, got ${
        JSON.stringify(thrown.message)
      }`,
    );
  }
}

function candidateRows(
  candidate: string,
  neighborGroup: string,
  stressMultiplier = 1,
): CandidateFoldMetric[] {
  const rows: CandidateFoldMetric[] = [];
  for (let fold = 1; fold <= 4; fold++) {
    rows.push(
      {
        candidate,
        neighborGroup,
        fold,
        split: "TRAIN",
        trades: 40,
        profitFactor: 1.2,
        stressNetPnlBps: 80 * stressMultiplier,
      },
      {
        candidate,
        neighborGroup,
        fold,
        split: "VALIDATION",
        trades: 15,
        profitFactor: 1.1,
        stressNetPnlBps: 15 * stressMultiplier,
      },
      {
        candidate,
        neighborGroup,
        fold,
        split: "TEST",
        trades: 15,
        profitFactor: 1.05,
        stressNetPnlBps: 5,
      },
    );
  }
  return rows;
}

Deno.test("V5 builds four 75-day folds spanning one 120-day window", () => {
  const start = Date.UTC(2026, 0, 1);
  const end = start + 120 * DAY_MS;
  const folds = buildRollingFolds(start, end);

  assertEquals(folds.length, 4);
  assertEquals(folds.map((fold) => fold.id), [1, 2, 3, 4]);
  assertEquals(folds.map((fold) => (fold.trainStart - start) / DAY_MS), [0, 15, 30, 45]);
  for (const fold of folds) {
    assertEquals((fold.trainEnd - fold.trainStart) / DAY_MS, 45);
    assertEquals((fold.validationStart - fold.trainEnd) / DAY_MS, 1);
    assertEquals((fold.validationEnd - fold.validationStart) / DAY_MS, 14);
    assertEquals((fold.testStart - fold.validationEnd) / DAY_MS, 1);
    assertEquals((fold.testEnd - fold.testStart) / DAY_MS, 14);
    assertEquals(fold.embargoBars, 96);
  }
  assertEquals(folds[3].testEnd, end);
});

Deno.test("fold split boundaries are end-exclusive and embargoed", () => {
  const start = Date.UTC(2026, 0, 1);
  const [fold] = buildRollingFolds(start, start + 120 * DAY_MS);

  assertEquals(splitForFold(fold.trainStart, fold), "TRAIN");
  assertEquals(splitForFold(fold.trainEnd - BAR_MS, fold), "TRAIN");
  assertEquals(splitForFold(fold.trainEnd, fold), "EMBARGO");
  assertEquals(splitForFold(fold.validationStart, fold), "VALIDATION");
  assertEquals(splitForFold(fold.validationEnd, fold), "EMBARGO");
  assertEquals(splitForFold(fold.testStart, fold), "TEST");
  assertEquals(splitForFold(fold.testEnd, fold), "OUTSIDE");
});

Deno.test("rolling-fold builder rejects a non-120-day or unaligned window", () => {
  const start = Date.UTC(2026, 0, 1);
  assertThrowsLocal(() => buildRollingFolds(start, start + 119 * DAY_MS));
  assertThrowsLocal(() => buildRollingFolds(start + 1, start + 120 * DAY_MS + 1));
});

Deno.test("selection requires strict train and validation gates in every fold", () => {
  const rows = [
    ...candidateRows("candidate-a", "neighborhood"),
    ...candidateRows("candidate-b", "neighborhood"),
  ];
  const failed = rows.find((row) =>
    row.candidate === "candidate-a" && row.fold === 2 && row.split === "VALIDATION"
  );
  assert(failed);
  failed.profitFactor = 1;
  failed.stressNetPnlBps = 0;

  const reports = evaluateCandidateValidation(rows);
  const candidateA = reports.find((report) => report.candidate === "candidate-a");
  const candidateB = reports.find((report) => report.candidate === "candidate-b");
  assert(candidateA && candidateB);
  assertEquals(candidateA.selectionEligible, false);
  assertEquals(candidateA.foldGates[1].validationPass, false);
  assert(candidateA.foldGates[1].selectionFailures.includes("VALIDATION_GATE_FAILED"));
  assertEquals(candidateB.selectionEligible, false);
  assert(candidateB.foldGates.some((fold) => !fold.neighborhoodRobust));
});

Deno.test("neighborhood robustness requires at least one passing neighboring config", () => {
  const reports = evaluateCandidateValidation(candidateRows("isolated", "solo"));
  assertEquals(reports.length, 1);
  assertEquals(reports[0].selectionEligible, false);
  assertEquals(reports[0].foldGates[0].neighborhoodCandidateCount, 1);
  assertEquals(reports[0].foldGates[0].passingNeighborCount, 0);
  assertEquals(reports[0].foldGates[0].neighborhoodRobust, false);
});

Deno.test("final TEST affects production review but never selection or ranking", () => {
  const rows = [
    ...candidateRows("candidate-a", "neighborhood", 1),
    ...candidateRows("candidate-b", "neighborhood", 2),
  ];
  const selectedBefore = selectedCandidates(rows).map((report) => ({
    candidate: report.candidate,
    score: report.selectionScore,
    selectionEligible: report.selectionEligible,
  }));
  const reportsBefore = evaluateCandidateValidation(rows);

  const changedTest = rows.map((row) =>
    row.split === "TEST"
      ? {
        ...row,
        trades: row.candidate === "candidate-a" ? 0 : 1_000_000,
        profitFactor: row.candidate === "candidate-a" ? 999 : 0,
        stressNetPnlBps: row.candidate === "candidate-a" ? 1e12 : -1e12,
      }
      : { ...row }
  );
  const selectedAfter = selectedCandidates(changedTest).map((report) => ({
    candidate: report.candidate,
    score: report.selectionScore,
    selectionEligible: report.selectionEligible,
  }));

  assertEquals(selectedBefore, [
    { candidate: "candidate-b", score: 2, selectionEligible: true },
    { candidate: "candidate-a", score: 1, selectionEligible: true },
  ]);
  assertEquals(selectedAfter, selectedBefore);
  assertEquals(
    reportsBefore.map((report) => report.productionReviewEligible),
    [true, true],
  );
  const report = evaluateCandidateValidation(changedTest).find((item) =>
    item.candidate === "candidate-a"
  );
  assert(report);
  assertEquals(report.selectionEligible, true);
  assertEquals(report.historicalTestSufficient, false);
  assertEquals(report.historicalTestPass, false);
  assertEquals(report.productionReviewEligible, false);
  assertEquals(report.testUsedForSelection, false);
  assertEquals(report.finalHistoricalTestFold, 4);
  assertEquals(report.finalHistoricalTestLabel, FINAL_HISTORICAL_TEST_LABEL);
});

Deno.test("only fold 4 TEST is the final OOS production-review gate", () => {
  const rows = [
    ...candidateRows("candidate-a", "neighborhood"),
    ...candidateRows("candidate-b", "neighborhood"),
  ];
  for (const row of rows) {
    if (row.split === "TEST" && row.fold < 4) {
      row.trades = 0;
      row.profitFactor = 0;
      row.stressNetPnlBps = -1_000;
    }
  }

  const reports = evaluateCandidateValidation(rows);
  assert(reports.every((report) => report.selectionEligible));
  assert(reports.every((report) => report.historicalTestPass));
  assert(reports.every((report) => report.productionReviewEligible));
  assert(reports.every((report) => !report.historicalTestSufficient));
});

Deno.test("metric completeness is the exact market/config/fold/split Cartesian product", () => {
  const expected = expectedMetricCompleteness(567, 19);
  assertEquals(expected, {
    markets: 567,
    candidates: 19,
    folds: 4,
    splits: 3,
    rows: 129_276,
  });
  assertMetricCompleteness({ ...expected }, expected);
  assertThrowsLocal(
    () => assertMetricCompleteness({ ...expected, rows: expected.rows - 1 }, expected),
    "incomplete V5 metric matrix",
  );
});

Deno.test("duplicate candidate/fold/split rows fail closed", () => {
  const rows = candidateRows("candidate-a", "neighborhood");
  assertThrowsLocal(
    () => evaluateCandidateValidation([...rows, { ...rows[0] }]),
    "duplicate candidate/fold/split metric",
  );
});
