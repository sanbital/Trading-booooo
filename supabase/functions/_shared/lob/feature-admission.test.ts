import {
  buildFeatureAdmissionPolicy,
  evidenceScaledAdjustment,
  featureAuthority,
  mayBreakTies,
  mayHardenGate,
  policyForCohort,
} from "./feature-admission.ts";
import {
  analyzeCohortEvidence,
  type EvidenceCohortReport,
  type FeatureEvidence,
  type TradeEvidenceSample,
} from "./feature-significance.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function evidence(overrides: Partial<FeatureEvidence> = {}): FeatureEvidence {
  return {
    key: "p_target",
    family: "ENTRY_INTENT",
    causality: "PRE_ENTRY",
    target: "netBps",
    samples: 60,
    rho: 0.55,
    rawP: 0.0001,
    q: 0.0008,
    permutationIterations: 10_000,
    permutationExact: false,
    looMinRho: 0.45,
    looMaxRho: 0.64,
    signStable: true,
    verdict: "SIGNIFICANT",
    ...overrides,
  };
}

function report(features: FeatureEvidence[], overrides: Partial<EvidenceCohortReport> = {}) {
  return {
    cohort: "binance",
    generatedAtMs: 1_700_000_000_000,
    samples: 60,
    wins: 25,
    winRate: 25 / 60,
    observationHours: 48,
    distinctMarkets: 9,
    alpha: 0.05,
    minSamples: 30,
    features,
    groups: [],
    notes: [],
    ...overrides,
  } satisfies EvidenceCohortReport;
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

Deno.test("an unmeasured feature holds no authority", () => {
  const policy = buildFeatureAdmissionPolicy(report([]));
  assert(featureAuthority(policy, "p_target") === "NONE");
  assert(!mayHardenGate(policy, "p_target"));
  assert(!mayBreakTies(policy, "p_target"));
  assert(featureAuthority(null, "p_target") === "NONE", "a missing policy grants nothing");
});

Deno.test("a measured, corrected, stable feature earns gate authority", () => {
  const policy = buildFeatureAdmissionPolicy(report([evidence()]));
  assert(featureAuthority(policy, "p_target") === "GATE");
  assert(mayHardenGate(policy, "p_target"));
  assert(mayBreakTies(policy, "p_target"), "gate authority implies tie-break authority");
  assert(policy.gateFeatures.join(",") === "p_target");
});

Deno.test("a post-entry variable is barred from authority however significant it is", () => {
  const policy = buildFeatureAdmissionPolicy(report([
    evidence({
      key: "mfe_bps",
      family: "TRADE_PATH",
      causality: "POST_ENTRY",
      rho: 0.802,
      rawP: 0.000021,
      q: 0.000063,
    }),
  ]));
  assert(featureAuthority(policy, "mfe_bps") === "NONE");
  assert(!mayBreakTies(policy, "mfe_bps"), "lookahead may not even order candidates");
  assert(policy.admissions[0].reason === "POST_ENTRY_PATH_VARIABLE");
  assert(
    policy.notes.some((note) => note.startsWith("PATH_VARIABLES_SIGNIFICANT_BUT_UNUSABLE")),
    JSON.stringify(policy.notes),
  );
});

Deno.test("an uncorrected signal is watched, not traded on", () => {
  const policy = buildFeatureAdmissionPolicy(report([
    evidence({ rawP: 0.023, q: 0.188, verdict: "CANDIDATE" }),
  ]));
  assert(featureAuthority(policy, "p_target") === "TIE_BREAK");
  assert(!mayHardenGate(policy, "p_target"), "q = 0.188 may not move a threshold");
  assert(mayBreakTies(policy, "p_target"));
  assert(policy.admissions[0].reason === "UNCORRECTED_SIGNAL_ONLY");
});

Deno.test("significance on a lopsided sample is demoted to tie-break", () => {
  // Twenty trades with three winners: the live-review shape. Even a clean q cannot promote.
  const policy = buildFeatureAdmissionPolicy(
    report([evidence({ samples: 20 })], { samples: 20, wins: 3, winRate: 0.15 }),
  );
  assert(featureAuthority(policy, "p_target") === "TIE_BREAK", JSON.stringify(policy.admissions));
  assert(policy.admissions[0].reason === "INSUFFICIENT_SAMPLES");

  const balancedButThin = buildFeatureAdmissionPolicy(
    report([evidence()], { samples: 40, wins: 4 }),
  );
  assert(balancedButThin.admissions[0].reason === "OUTCOME_CLASSES_UNBALANCED");
  assert(balancedButThin.gateFeatures.length === 0);
});

Deno.test("a significant but fragile or weak correlation cannot gate", () => {
  const fragile = buildFeatureAdmissionPolicy(report([evidence({ signStable: false })]));
  assert(fragile.admissions[0].reason === "UNSTABLE_UNDER_LEAVE_ONE_OUT");
  assert(fragile.gateFeatures.length === 0);

  const weak = buildFeatureAdmissionPolicy(report([evidence({ rho: 0.12 })]));
  assert(weak.admissions[0].authority === "TIE_BREAK", JSON.stringify(weak.admissions));
});

Deno.test("only realized return grants authority; excursion predictors are surfaced", () => {
  const policy = buildFeatureAdmissionPolicy(report([
    evidence({ key: "features.noiseBandBps", family: "ENTRY_MICROSTRUCTURE", target: "maeBps" }),
  ]));
  assert(policy.admissions.length === 0, "an MAE predictor is not a return finding");
  assert(
    policy.notes.some((note) => note.startsWith("PRE_ENTRY_EXCURSION_PREDICTORS")),
    JSON.stringify(policy.notes),
  );
});

Deno.test("authority never crosses venue cohorts", () => {
  const binance = buildFeatureAdmissionPolicy(report([evidence()]));
  const upbit = buildFeatureAdmissionPolicy(report([], { cohort: "upbit", samples: 2, wins: 0 }));
  const policies = [binance, upbit];
  assert(mayHardenGate(policyForCohort(policies, "binance"), "p_target"));
  assert(!mayHardenGate(policyForCohort(policies, "upbit"), "p_target"));
  assert(policyForCohort(policies, "bithumb") === null, "an unseen venue inherits nothing");
  assert(policyForCohort([], "binance") === null);
});

Deno.test("gate adjustments scale with strength and stay inside their bound", () => {
  const gated = buildFeatureAdmissionPolicy(report([evidence({ rho: 0.5 })]));
  assert(evidenceScaledAdjustment(gated, "p_target", 2) === 1);
  assert(evidenceScaledAdjustment(gated, "p_target", -2) === -1);

  const saturated = buildFeatureAdmissionPolicy(report([evidence({ rho: 4 })]));
  assert(evidenceScaledAdjustment(saturated, "p_target", 2) === 2, "clamped at the bound");

  const watched = buildFeatureAdmissionPolicy(report([evidence({ verdict: "CANDIDATE" })]));
  assert(evidenceScaledAdjustment(watched, "p_target", 2) === 0, "tie-break moves no threshold");
});

Deno.test("the live-review shape produces an empty gate set end to end", () => {
  // Twenty binance trades, three winners, entry variables carrying no usable signal.
  const netBps = [
    -0.20, -0.31, -0.18, 0.44, -0.26, -0.12, -0.35, -0.22, 0.51, -0.19,
    -0.28, -0.41, -0.15, -0.24, 0.38, -0.33, -0.17, -0.29, -0.21, -0.36,
  ];
  const samples = netBps.map((net, index) =>
    sample({
      market: `M${index % 7}`,
      closedAtMs: 1_700_000_000_000 + index * 1_800_000,
      netBps: net,
      profitable: net > 0,
      mfeBps: Math.max(0, net) * 3 + 1,
      maeBps: Math.max(0, -net) * 3 + 1,
      heldSeconds: 60 + (index % 5) * 40,
      snapshot: {
        p_target: 0.50 + ((index * 7) % 11) * 0.01,
        ev_lower_bound_bps: 0.6 + ((index * 3) % 5) * 0.1,
        hotness_score: 40 + ((index * 5) % 13),
        confidence: 0.55 + ((index * 2) % 7) * 0.02,
        target_bps: 18 + (index % 4),
        stop_bps: 11 + (index % 3),
        expected_cost_bps: 2 + (index % 3) * 0.2,
      },
    })
  );
  const cohort = analyzeCohortEvidence("binance", samples, { permutationIterations: 2000 });
  const policy = buildFeatureAdmissionPolicy(cohort);
  assert(policy.gateFeatures.length === 0, JSON.stringify(policy.gateFeatures));
  assert(
    policy.admissions.every((row) => row.key !== "mfe_bps" || row.authority === "NONE"),
    "path variables stay at NONE end to end",
  );
  assert(
    policy.notes.some((note) => note.startsWith("NO_PRE_ENTRY_FEATURE_SEPARATES_OUTCOMES")),
    JSON.stringify(policy.notes),
  );
});
