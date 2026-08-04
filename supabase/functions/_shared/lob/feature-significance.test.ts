import {
  analyzeCohortEvidence,
  analyzeReentryEffect,
  analyzeTradeEvidence,
  averageRanks,
  benjaminiHochberg,
  discoverMicrostructureFeatures,
  leaveOneOutRhoRange,
  mannWhitneyU,
  outcomeRowToEvidenceSample,
  spearmanPermutationTest,
  spearmanRho,
  type TradeEvidenceSample,
} from "./feature-significance.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function sample(overrides: Partial<TradeEvidenceSample> = {}): TradeEvidenceSample {
  return {
    exchange: "binance",
    market: "BTCUSDT",
    pattern: "OFI_CONTINUATION",
    closedAtMs: 1_700_000_000_000,
    openedAtMs: 1_699_999_000_000,
    netBps: 0,
    profitable: false,
    targetHit: false,
    heldSeconds: 60,
    mfeBps: 0,
    maeBps: 0,
    snapshot: {},
    ...overrides,
  };
}

Deno.test("midranks average tied positions", () => {
  assert(JSON.stringify(averageRanks([10, 20, 30])) === JSON.stringify([1, 2, 3]));
  assert(JSON.stringify(averageRanks([5, 5, 9])) === JSON.stringify([1.5, 1.5, 3]));
  assert(JSON.stringify(averageRanks([7, 7, 7, 7])) === JSON.stringify([2.5, 2.5, 2.5, 2.5]));
});

Deno.test("spearman is monotone-exact and tie-aware", () => {
  assert(close(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40]), 1));
  assert(close(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10]), -1));
  // Monotone but non-linear: Pearson would fall short of 1, Spearman must not.
  assert(close(spearmanRho([1, 2, 3, 4, 5], [1, 4, 9, 16, 250]), 1));
  assert(!Number.isFinite(spearmanRho([2, 2, 2, 2], [1, 2, 3, 4])));
});

Deno.test("permutation p-value is exact for small n and reproducible for large n", () => {
  const perfect = spearmanPermutationTest([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]);
  assert(perfect.exact, "n=6 must enumerate exactly");
  // Only the identity and the full reversal reach |rho| = 1 among 720 permutations.
  assert(close(perfect.p, 2 / 720, 1e-12), JSON.stringify(perfect));

  const x = Array.from({ length: 30 }, (_, index) => index);
  const y = x.map((value) => value * 2 + (value % 3));
  const first = spearmanPermutationTest(x, y, 2000);
  const second = spearmanPermutationTest(x, y, 2000);
  assert(!first.exact);
  assert(first.p === second.p, "identical input must reproduce the same p-value");
  assert(first.p < 0.01, JSON.stringify(first));
  assert(first.p > 0, "a finite resample can never justify reporting p = 0");
});

Deno.test("permutation p-value stays near uniform under the null", () => {
  const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4];
  const y = [8, 6, 4, 2, 9, 1, 3, 7, 5, 0, 2, 4, 6, 8, 1, 3, 5, 7, 9, 0];
  const result = spearmanPermutationTest(x, y, 4000);
  assert(result.p > 0.10, `unrelated series must not look significant: ${JSON.stringify(result)}`);
});

Deno.test("benjamini-hochberg matches the step-up definition and stays monotone", () => {
  // Three tests: q = p * m / rank, then enforced non-decreasing from the largest p down.
  const adjusted = benjaminiHochberg([0.000021, 0.000663, 0.186]);
  assert(close(adjusted[0] as number, 0.000063, 1e-9), JSON.stringify(adjusted));
  assert(close(adjusted[1] as number, 0.0009945, 1e-9), JSON.stringify(adjusted));
  assert(close(adjusted[2] as number, 0.186, 1e-9), JSON.stringify(adjusted));

  // The eight-variable entry family from the live review: the smallest raw p of 0.023 is
  // pushed to roughly 0.19 and must not be reported as significant.
  const entry = benjaminiHochberg([0.023, 0.296, 0.310, 0.443, 0.622, 0.758, 0.865, 0.949]);
  assert((entry[0] as number) > 0.05, JSON.stringify(entry));
  assert(close(entry[0] as number, 0.184, 1e-9), JSON.stringify(entry));
  for (let index = 1; index < entry.length; index++) {
    assert((entry[index] as number) >= (entry[index - 1] as number), "q must be monotone in p");
  }
});

Deno.test("degenerate tests neither receive nor consume a q-value", () => {
  const adjusted = benjaminiHochberg([0.01, null, 0.02]);
  assert(adjusted[1] === null, "a degenerate test has no q-value");
  // Family size is 2, not 3: 0.01 * 2 / 1 = 0.02.
  assert(close(adjusted[0] as number, 0.02, 1e-12), JSON.stringify(adjusted));
});

Deno.test("leave-one-out detects a correlation carried by a single observation", () => {
  const carried = leaveOneOutRhoRange([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 100]);
  assert(!carried.signStable || (carried.max ?? 0) - (carried.min ?? 0) > 0.3);

  const robust = leaveOneOutRhoRange([1, 2, 3, 4, 5, 6, 7], [2, 3, 5, 7, 11, 13, 17]);
  assert(robust.signStable, JSON.stringify(robust));
  assert((robust.min ?? 0) > 0.9, JSON.stringify(robust));
});

Deno.test("mann-whitney separates shifted groups and clears unshifted ones", () => {
  const separated = mannWhitneyU([1, 2, 3, 4, 5, 6], [20, 21, 22, 23, 24, 25], 3000);
  assert(separated.p < 0.01, JSON.stringify(separated));

  const overlapping = mannWhitneyU([1, 5, 3, 7, 2], [4, 2, 6, 3, 8], 3000);
  assert(overlapping.p > 0.10, JSON.stringify(overlapping));
});

Deno.test("post-entry path variables are reported but never called entry evidence", () => {
  // MFE tracks return by construction; the report must still label it POST_ENTRY.
  const samples = Array.from({ length: 40 }, (_, index) =>
    sample({
      market: `M${index % 8}`,
      closedAtMs: 1_700_000_000_000 + index * 900_000,
      netBps: index - 20,
      profitable: index > 20,
      mfeBps: Math.max(0, index - 18),
      maeBps: Math.max(0, 40 - index),
      snapshot: { p_target: 0.5, target_bps: 20, stop_bps: 12 },
    }));
  const report = analyzeCohortEvidence("binance", samples, { permutationIterations: 1500 });
  const mfe = report.features.find((row) => row.key === "mfe_bps" && row.target === "netBps");
  assert(mfe, "mfe must be measured");
  assert(mfe!.causality === "POST_ENTRY");
  assert(mfe!.verdict === "SIGNIFICANT", JSON.stringify(mfe));
  assert(
    report.features.every((row) => row.causality !== "POST_ENTRY" || row.target === "netBps"),
    "path variables are never used as prediction targets",
  );
});

Deno.test("a constant entry variable is degenerate rather than uncorrelated", () => {
  const samples = Array.from({ length: 12 }, (_, index) =>
    sample({
      closedAtMs: 1_700_000_000_000 + index * 600_000,
      netBps: index % 2 === 0 ? 5 : -7,
      snapshot: { p_target: 0.62, target_bps: 20, stop_bps: 12 },
    }));
  const report = analyzeCohortEvidence("binance", samples, { permutationIterations: 1200 });
  const pTarget = report.features.find((row) => row.key === "p_target" && row.target === "netBps");
  assert(pTarget?.verdict === "DEGENERATE", JSON.stringify(pTarget));
});

Deno.test("a small sample with a strong raw signal is a candidate, never significant", () => {
  const samples = Array.from({ length: 20 }, (_, index) =>
    sample({
      market: `M${index % 6}`,
      closedAtMs: 1_700_000_000_000 + index * 1_200_000,
      netBps: index - 17,
      profitable: index > 17,
      snapshot: { p_target: 0.40 + index * 0.01, target_bps: 20, stop_bps: 12 },
    }));
  const report = analyzeCohortEvidence("binance", samples, { permutationIterations: 2000 });
  const pTarget = report.features.find((row) => row.key === "p_target" && row.target === "netBps");
  assert(pTarget, "p_target must be measured");
  assert(pTarget!.rawP != null && pTarget!.rawP < 0.05, JSON.stringify(pTarget));
  assert(pTarget!.verdict === "CANDIDATE", JSON.stringify(pTarget));
  assert(
    report.notes.some((note) => note.startsWith("SAMPLE_BELOW_SIGNIFICANCE_FLOOR")),
    JSON.stringify(report.notes),
  );
});

Deno.test("microstructure family is discovered from coverage and bounded in size", () => {
  const samples = Array.from({ length: 20 }, (_, index) =>
    sample({
      closedAtMs: 1_700_000_000_000 + index * 600_000,
      netBps: index - 10,
      snapshot: {
        features: {
          bookImbalance: index / 20,
          spreadBps: 4 + (index % 3),
          persistentBidWall: index % 2 === 0,
          samples: 40,
          // Present on one row only: below the coverage floor.
          ...(index === 0 ? { rareProbe: 1 } : {}),
        },
      },
    }));
  const discovered = discoverMicrostructureFeatures(samples);
  const keys = discovered.map((spec) => spec.key);
  assert(keys.includes("features.bookImbalance"), keys.join(","));
  assert(keys.includes("features.persistentBidWall"), "booleans are testable as 0/1");
  assert(!keys.includes("features.samples"), "bookkeeping fields are excluded");
  assert(!keys.includes("features.rareProbe"), "sparse keys fail the coverage floor");

  const capped = discoverMicrostructureFeatures(samples, {
    alpha: 0.05,
    minSamples: 30,
    permutationIterations: 1000,
    maxMicrostructureFeatures: 2,
    minFeatureCoverage: 0.8,
    nowMs: 0,
  });
  assert(capped.length === 2, `family size cap not applied: ${capped.length}`);
});

Deno.test("venue cohorts are analyzed separately and never pooled", () => {
  const binance = Array.from({ length: 20 }, (_, index) =>
    sample({
      exchange: "binance",
      market: `B${index % 5}`,
      closedAtMs: 1_700_000_000_000 + index * 600_000,
      netBps: -2,
    }));
  const upbit = Array.from({ length: 2 }, (_, index) =>
    sample({
      exchange: "upbit",
      market: `KRW-A${index}`,
      closedAtMs: 1_700_000_000_000 + index * 600_000,
      netBps: 500,
    }));
  const reports = analyzeTradeEvidence([...binance, ...upbit], { permutationIterations: 1000 });
  assert(reports.length === 2, "one report per venue");
  assert(reports[0].cohort === "binance" && reports[0].samples === 20);
  assert(reports[1].cohort === "upbit" && reports[1].samples === 2);
  assert(
    reports.every((report) => report.samples < 30 ? report.notes.length > 0 : true),
    "an undersized cohort must say so",
  );
});

Deno.test("re-entry contrast splits by prior closed trade on the same market", () => {
  const samples = [
    sample({ market: "AAA", closedAtMs: 1_000, netBps: -5 }),
    sample({ market: "BBB", closedAtMs: 2_000, netBps: -3 }),
    sample({ market: "AAA", closedAtMs: 3_000, netBps: -9 }),
    sample({ market: "CCC", closedAtMs: 4_000, netBps: 2 }),
    sample({ market: "BBB", closedAtMs: 5_000, netBps: -8 }),
  ];
  const group = analyzeReentryEffect(samples, {
    alpha: 0.05,
    minSamples: 30,
    permutationIterations: 1000,
    maxMicrostructureFeatures: 60,
    minFeatureCoverage: 0.8,
    nowMs: 0,
  });
  assert(group.leftSamples === 3 && group.rightSamples === 2, JSON.stringify(group));
  assert(group.rightMean < group.leftMean, "re-entries were worse in this fixture");
  assert(group.verdict === "INSUFFICIENT_SAMPLES", "five trades cannot settle the question");
});

Deno.test("outcome rows without a usable snapshot or close time are dropped", () => {
  assert(outcomeRowToEvidenceSample({ net_bps: 1, closed_at: "2026-08-01T00:00:00Z" }) === null);
  assert(outcomeRowToEvidenceSample({ entry_snapshot: {}, closed_at: "bad", net_bps: 1 }) === null);
  const parsed = outcomeRowToEvidenceSample({
    exchange: "BINANCE",
    market: "ethusdt",
    pattern: "SWEEP_RECLAIM",
    closed_at: "2026-08-01T00:00:00Z",
    opened_at: "2026-07-31T23:58:00Z",
    net_bps: -12.5,
    profitable: false,
    target_hit: false,
    held_seconds: 120,
    mfe_bps: 4,
    mae_bps: 30,
    entry_snapshot: { p_target: 0.55 },
  });
  assert(parsed?.exchange === "binance" && parsed?.market === "ETHUSDT", JSON.stringify(parsed));
  assert(parsed?.netBps === -12.5 && parsed?.maeBps === 30);
});
