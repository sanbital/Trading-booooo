import {
  assignLobPolicy,
  calculateLobPolicyMetrics,
  evaluateLobPolicy,
  type LobPolicyExposure,
  type LobPolicyTrade,
  resolveLobPolicyRuntime,
  stablePolicyFraction,
} from "./governance.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function trades(
  policyVersion: number,
  count: number,
  netBps: number,
  winRate: number,
  heldSeconds: number,
  notionalQuote = 100,
): LobPolicyTrade[] {
  const wins = Math.round(count * winRate);
  const losses = count - wins;
  const lossNet = netBps >= 0 || wins === 0
    ? -10
    : (netBps * count - 10 * wins) / Math.max(1, losses);
  const winNet = netBps >= 0 && wins > 0 ? (netBps * count - lossNet * losses) / wins : 10;
  const winningIndexes = new Set(
    Array.from({ length: wins }, (_, index) => Math.floor(index * count / Math.max(1, wins))),
  );
  return Array.from({ length: count }, (_, index) => ({
    id: `${policyVersion}-${index}`,
    policyVersion,
    exchange: index % 2 === 0 ? "upbit" : "binance",
    market: index % 2 === 0 ? "KRW-ETH" : "BTCUSDT",
    pattern: index % 2 === 0 ? "ABSORPTION_REVERSAL" : "OFI_CONTINUATION",
    netBps: winningIndexes.has(index) ? winNet : lossNet,
    profitable: winningIndexes.has(index),
    heldSeconds,
    notionalQuote,
    // Three independent blocks separated by at least four hours are required.
    closedAtMs: (1 + Math.floor(index / Math.max(1, Math.ceil(count / 3)))) * 12 * 3_600_000 + index,
    liveVerified: true,
    accountingQuality: "NO_RESIDUAL",
  }));
}

function exposures(policyVersion: number, scans: number, reservations = scans) {
  return Array.from({ length: scans }, (_, index): LobPolicyExposure => ({
    policyVersion,
    assignedAtMs: index,
    candidateCount: 4,
    entryAttempts: 1,
    reservations,
  })).map((row) => ({ ...row, reservations: reservations > 0 ? 1 : 0 }));
}

Deno.test("scan assignment is deterministic and keeps alternate traffic bounded", () => {
  assert(stablePolicyFraction("scan-a") === stablePolicyFraction("scan-a"));
  const runtime = resolveLobPolicyRuntime([
    {
      version: 1,
      status: "CHAMPION",
      online_profiles: [],
      pattern_profile: null,
    },
    {
      version: 2,
      status: "CHALLENGER",
      traffic_fraction: 0.5,
      online_profiles: [],
      pattern_profile: null,
    },
  ]);
  let alternate = 0;
  for (let index = 0; index < 1_000; index++) {
    if (assignLobPolicy(runtime, `scan-${index}`)?.lane === "CHALLENGER") alternate++;
  }
  assert(alternate > 430 && alternate < 570, `unexpected alternate allocation ${alternate}`);
});

Deno.test("policy metrics cannot be improved by shrinking notional or splitting orders", () => {
  const whole = calculateLobPolicyMetrics(
    trades(1, 40, 8, 0.55, 60, 100),
    exposures(1, 40),
  );
  const tiny = calculateLobPolicyMetrics(
    trades(2, 40, 9, 0.60, 55, 10),
    exposures(2, 40),
  );
  assert(whole.samples === tiny.samples);
  assert(tiny.meanNotionalQuote === 10);
  const evaluation = evaluateLobPolicy(
    trades(1, 40, 8, 0.55, 60, 100),
    trades(2, 40, 9, 0.60, 55, 10),
    exposures(1, 40),
    exposures(2, 40),
    "CHALLENGE",
    { zScore: 0 },
  );
  assert(!evaluation.gates.notional_preserved);
  assert(evaluation.decision === "HOLD");
});

Deno.test("KRW and USDT performance is normalized before aggregation", () => {
  const metrics = calculateLobPolicyMetrics([
    {
      policyVersion: 1,
      exchange: "upbit",
      netBps: -10,
      heldSeconds: 60,
      notionalQuote: 100_000,
      closedAtMs: 3_600_001,
      liveVerified: true,
      accountingQuality: "NO_RESIDUAL",
    },
    {
      policyVersion: 1,
      exchange: "binance",
      netBps: 20,
      heldSeconds: 60,
      notionalQuote: 10,
      closedAtMs: 7_200_002,
      liveVerified: true,
      accountingQuality: "NO_RESIDUAL",
    },
  ]);
  assert(Math.abs(metrics.notionalWeightedNetBps - 5) < 1e-9);
  assert(Math.abs(metrics.capitalTurnsPerHour - 60) < 1e-9);
  assert(Math.abs(metrics.profitFactor - 2) < 1e-9);
});

Deno.test("normal order size is compared inside each exchange, not across currencies", () => {
  const tagged = (
    rows: LobPolicyTrade[],
    exchange: string,
    pattern: string,
  ): LobPolicyTrade[] => rows.map((row) => ({ ...row, exchange, pattern }));
  const baseline = [
    ...tagged(
      trades(1, 30, 1, 0.40, 60, 100_000),
      "upbit",
      "ABSORPTION_REVERSAL",
    ),
    ...tagged(trades(1, 10, 1, 0.40, 60, 20), "binance", "OFI_CONTINUATION"),
  ];
  const candidate = [
    ...tagged(
      trades(2, 10, 10, 0.70, 50, 100_000),
      "upbit",
      "ABSORPTION_REVERSAL",
    ),
    ...tagged(trades(2, 30, 10, 0.70, 50, 20), "binance", "OFI_CONTINUATION"),
  ];
  const evaluation = evaluateLobPolicy(
    baseline,
    candidate,
    exposures(1, 40),
    exposures(2, 40),
    "CHALLENGE",
    { zScore: 0, currentTrafficFraction: 0.50, minSamplesPerArm: 40, minAssignedScansPerArm: 40 },
  );
  assert(Math.abs(evaluation.deltas.meanNotionalRatio - 1) < 1e-9);
  assert(evaluation.gates.notional_preserved);
  assert(evaluation.decision === "PROMOTE", JSON.stringify(evaluation.gates));
});

Deno.test("higher win rate and return are rejected when completed trade rate falls", () => {
  const evaluation = evaluateLobPolicy(
    trades(1, 40, 2, 0.50, 60),
    trades(2, 40, 8, 0.65, 50),
    exposures(1, 40),
    exposures(2, 80),
    "CHALLENGE",
    { zScore: 0 },
  );
  assert(evaluation.gates.net_return_improved);
  assert(evaluation.gates.win_rate_improved);
  assert(!evaluation.gates.completed_trade_rate_preserved);
  assert(evaluation.decision === "HOLD");
});

Deno.test("a strict joint improvement promotes only after every invariant passes", () => {
  const baseline = trades(1, 100, 1, 0.45, 90);
  const candidate = trades(2, 100, 14, 0.68, 55);
  const evaluation = evaluateLobPolicy(
    baseline,
    candidate,
    exposures(1, 100),
    exposures(2, 100),
    "CHALLENGE",
    { currentTrafficFraction: 0.50 },
  );
  assert(evaluation.decision === "PROMOTE", JSON.stringify(evaluation.gates));
  assert(Object.values(evaluation.gates).every(Boolean));
});

Deno.test("the second live comparison confirms or rolls back a provisional champion", () => {
  const control = trades(1, 100, 2, 0.50, 80);
  const strong = trades(2, 100, 15, 0.70, 50);
  const confirmed = evaluateLobPolicy(
    control,
    strong,
    exposures(1, 100),
    exposures(2, 100),
    "CONFIRMATION",
    { currentTrafficFraction: 0.50 },
  );
  assert(confirmed.decision === "CONFIRM");

  const weak = trades(2, 100, -12, 0.25, 100);
  const rolledBack = evaluateLobPolicy(
    control,
    weak,
    exposures(1, 100),
    exposures(2, 100),
    "CONFIRMATION",
    { currentTrafficFraction: 0.50 },
  );
  assert(rolledBack.decision === "ROLLBACK");
});

Deno.test("negative expectancy can never be promoted even if it is less bad", () => {
  const evaluation = evaluateLobPolicy(
    trades(1, 60, -20, 0.20, 100),
    trades(2, 60, -5, 0.35, 70),
    exposures(1, 60),
    exposures(2, 60),
    "CHALLENGE",
    { zScore: 0 },
  );
  assert(evaluation.gates.net_return_improved);
  assert(evaluation.gates.win_rate_improved);
  assert(!evaluation.gates.positive_net_after_costs);
  assert(evaluation.decision !== "PROMOTE");
});

Deno.test("a favourable exchange-pattern mix cannot fake model improvement", () => {
  const inCell = (
    rows: LobPolicyTrade[],
    exchange: string,
    pattern: string,
  ): LobPolicyTrade[] => rows.map((row) => ({ ...row, exchange, pattern }));
  const baseline = [
    ...inCell(trades(1, 10, 10, 0.60, 60), "upbit", "SWEEP_RECLAIM"),
    ...inCell(trades(1, 30, -10, 0.20, 60), "binance", "OFI_CONTINUATION"),
  ];
  const candidate = [
    ...inCell(trades(2, 30, 9, 0.55, 60), "upbit", "SWEEP_RECLAIM"),
    ...inCell(trades(2, 10, -11, 0.15, 60), "binance", "OFI_CONTINUATION"),
  ];
  const evaluation = evaluateLobPolicy(
    baseline,
    candidate,
    exposures(1, 40),
    exposures(2, 40),
    "CHALLENGE",
    { zScore: 0 },
  );
  assert(evaluation.gates.net_return_improved);
  assert(evaluation.gates.win_rate_improved);
  assert(!evaluation.gates.exchange_pattern_mix_preserved);
  assert(evaluation.deltas.mixAdjustedMeanNetBps < 0);
  assert(evaluation.decision !== "PROMOTE");
});


Deno.test("a safe 15 percent canary expands before it can promote", () => {
  const evaluation = evaluateLobPolicy(
    trades(1, 30, 4, 0.50, 70),
    trades(2, 30, 6, 0.53, 65),
    exposures(1, 30),
    exposures(2, 30),
    "CHALLENGE",
    {
      zScore: 0,
      currentTrafficFraction: 0.15,
      expandedTrafficFraction: 0.25,
    },
  );
  assert(evaluation.decision === "EXPAND", JSON.stringify(evaluation));
});

Deno.test("shadow, backtest and unverified accounting labels can never vote", () => {
  const baseline = trades(1, 60, 2, 0.50, 70);
  const candidate = trades(2, 60, 20, 0.75, 40).map((row) => ({
    ...row,
    liveVerified: false,
    accountingQuality: "LEGACY_UNVERIFIED",
  }));
  const evaluation = evaluateLobPolicy(
    baseline,
    candidate,
    exposures(1, 60),
    exposures(2, 60),
    "CHALLENGE",
    { zScore: 0 },
  );
  assert(!evaluation.gates.live_verified_labels);
  assert(evaluation.decision !== "PROMOTE");
});

Deno.test("v6.8 migration freezes policies, records full-size cohorts and never edits capital", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../migrations/202607270020_validated_pareto_learning_v680.sql",
      import.meta.url,
    ),
  );
  assert(sql.includes("create table if not exists public.lob_policy_versions"));
  assert(sql.includes("create table if not exists public.lob_policy_cycle_exposures"));
  assert(sql.includes("get_lob_policy_evaluation_dataset"));
  assert(sql.includes("apply_lob_policy_decision"));
  assert(sql.includes("AUTO_ROLLBACK_CONTROL_RESTORED"));
  assert(sql.includes("policy_lane in ('CHAMPION', 'CHALLENGER', 'CONTROL', 'LEGACY')"));
  assert(!sql.includes("update public.trading_settings"));
  assert(!sql.includes("scalp_position_slots ="));
  assert(!sql.includes("scalp_size_fraction ="));
});

Deno.test("runtime pins entry policy and calibration cannot auto-activate raw profiles", async () => {
  const autotrader = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  const calibration = await Deno.readTextFile(
    new URL("../../lob-calibration/index.ts", import.meta.url),
  );
  assert(autotrader.includes("assignLobPolicy(policyRuntime, scanId)"));
  assert(autotrader.includes("__policy_bundle"));
  assert(autotrader.includes("lob_soft_exit_policy_version"));
  assert(autotrader.includes("pinnedCoinPolicy.soft_exit_confirmations"));
  assert(autotrader.includes("policy: assignedPolicy"));
  assert(autotrader.includes("validated LOB policy unavailable"));
  assert(!autotrader.includes("async function loadLobLearning"));
  assert(!autotrader.includes("async function loadLobOnlineProfiles"));
  assert(!calibration.includes("active: true"));
  assert(!calibration.includes('"lob_learning_profiles?active=eq.true"'));
  assert(calibration.includes("evaluateLobPolicy"));
  assert(calibration.includes("create_lob_policy_challenger"));
});
