import {
  applyRuntimeRisk,
  evaluatePath,
  type LearningParameters,
  type RuntimeProfile,
  type StoredCandidate,
} from "./forward-learning.ts";
import type { RiskConfig } from "./engine.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const weekly: LearningParameters = {
  scoreThreshold: 72,
  minNetRR: 1.5,
  shortTargetAtrMult: 2.2,
  stopAtrMult: 1.15,
  mediumTargetAtr4hMult: 2.4,
  mediumTargetAtrDayMult: 1.3,
  minStructuralHeadroomNetPct: 0.6,
  minCostMultiple: 2,
  minTradePressure: -0.2,
  maxNegativeBookImbalance: -0.4,
  minDepthCoverage: 1.5,
  maxSlippageBps: 20,
  maxSpreadBps: 35,
  stopMinAtr4hMult: 1,
  stopMinAtr15mMult: 1.5,
  firstTargetAllocationPct: 60,
  exitPolicy: "SCALE_OUT",
};

const base: StoredCandidate = {
  id: "00000000-0000-0000-0000-000000000001",
  scan_id: "00000000-0000-0000-0000-000000000002",
  exchange: "binance",
  market: "TESTUSDT",
  created_at: "2026-07-24T00:00:00.000Z",
  decision: "BUY",
  score: 78,
  period_score: 76,
  entry_low: 99,
  entry_high: 100,
  stop_price: 97,
  target_1: 104,
  target_2: 108,
  net_rr: 1.5,
  estimated_cost_pct: 0.2,
  intended_horizon_hours: 24,
  active_policy_key: "FIXED_T1",
  profile_version: 0,
  feature_vector: {
    atr15: 1,
    event_status: "CLEAR",
    trade_pressure: 0.1,
  },
  applied_parameters: weekly,
  snapshot: {},
};

Deno.test("forward outcome uses conservative stop-first on ambiguous bar", () => {
  const result = evaluatePath(base, [
    { t: 1, o: 100, h: 101, l: 99, c: 100 },
    { t: 2, o: 100, h: 105, l: 96, c: 103 },
  ], 3, 24);
  const out = result.active_outcome;
  assert(out.stop_first, JSON.stringify(out));
  assert(out.outcome === "AMBIGUOUS_STOP_FIRST", JSON.stringify(out));
  assert(out.mae_pct > 0, "MAE must use the same positive-loss sign as backtest");
});

Deno.test("forward evaluator compares fixed, scale-out and trailing policies", () => {
  const result = evaluatePath({ ...base, active_policy_key: "SCALE_OUT_60" }, [
    { t: 1, o: 100, h: 104.5, l: 99.5, c: 104 },
    { t: 2, o: 104, h: 109, l: 103, c: 108 },
  ], 3, 24);
  assert(Object.keys(result.policy_outcomes).includes("FIXED_T1"));
  assert(Object.keys(result.policy_outcomes).includes("SCALE_OUT_60"));
  assert(Object.keys(result.policy_outcomes).includes("TRAIL_AFTER_T1_60"));
  assert(result.policy_outcomes.SCALE_OUT_60.target_2_hit);
  assert(result.optimal_policy_key != null);
});

Deno.test("runtime profile cannot loosen weekly score, RR or micro safety", () => {
  const risk: RiskConfig = {
    capitalKrw: 500,
    riskPct: 1,
    feePerSidePct: 0.1,
    minNetRR: 1.5,
    maxStopPct: 5,
    entrySlippageTicks: 0.5,
    exitSlippageTicks: 1,
  };
  const profile: RuntimeProfile = {
    version: 1,
    source: "FORWARD_AUTO",
    parameters: {
      ...weekly,
      scoreThreshold: 66,
      minNetRR: 1.2,
      minStructuralHeadroomNetPct: 0.4,
      maxSpreadBps: 50,
    },
    samples: 200,
    validationSamples: 60,
    objective: 1,
    promotedAt: new Date().toISOString(),
    parentVersion: 0,
  };
  const applied = applyRuntimeRisk(risk, profile, weekly);
  assert(applied.scoreThreshold === 72);
  assert(applied.minNetRR === 1.5);
  assert(applied.minStructuralHeadroomNetPct === 0.6);
  assert(applied.maxSpreadBps === 35);
});

import { promotionDecision, type Metrics } from "./forward-learning.ts";

function metric(overrides: Partial<Metrics> = {}): Metrics {
  return {
    value: 1,
    n: 40,
    expectancy: 0.3,
    profitFactor: 1.4,
    maxDrawdown: 3,
    equity: 10,
    winRate: 0.55,
    capture: 0.6,
    tailLoss: 1,
    marketConcentration: 0.3,
    ...overrides,
  };
}

Deno.test("forward promotion rejects insufficient validation samples", () => {
  const champion = metric({ value: 1 });
  const challenger = metric({ value: 2, n: 20 });
  const result = promotionDecision(champion, challenger, [
    { champion, challenger },
    { champion, challenger },
    { champion, challenger },
  ]);
  assert(!result.accepted);
  assert(result.reason.includes("samples"));
});

Deno.test("forward promotion rejects weak profit factor", () => {
  const champion = metric({ value: 1 });
  const challenger = metric({ value: 2, profitFactor: 1.05 });
  const result = promotionDecision(champion, challenger, [
    { champion, challenger },
    { champion, challenger },
    { champion, challenger },
  ]);
  assert(!result.accepted);
  assert(result.reason.includes("profit factor"));
});

Deno.test("forward promotion rejects a challenger that does not beat champion", () => {
  const champion = metric({ value: 1.5 });
  const challenger = metric({ value: 1.55 });
  const result = promotionDecision(champion, challenger, [
    { champion, challenger },
    { champion, challenger },
    { champion, challenger },
  ]);
  assert(!result.accepted);
  assert(result.reason.includes("objective"));
});
