import { compareLobSelection, lobSelectionMetrics, rankLobSelections } from "./selection.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function snapshot(
  ev: number,
  hotness: number,
  noiseBandBps = 4,
  maxHoldingSeconds = 180,
) {
  return lobSelectionMetrics({
    ev_lower_bound_bps: ev,
    target_bps: 60,
    stop_bps: 40,
    max_holding_seconds: maxHoldingSeconds,
    hotness_score: hotness,
    p_target: 0.55,
    features: { noiseBandBps, observationMs: 8000 },
  });
}

Deno.test("materially higher EV outranks legacy hotness", () => {
  const profitable = snapshot(5, 55);
  const merelyHot = snapshot(1, 99);
  assert(
    compareLobSelection(profitable, merelyHot) < 0,
    "hotness must not bury a materially better EV lower bound",
  );
});

Deno.test("turnover breaks ties only inside the EV uncertainty band", () => {
  const faster = snapshot(4.9, 70, 12);
  const slower = snapshot(5, 70, 1);
  assert(
    compareLobSelection(faster, slower) < 0,
    "near-equal EV should prefer the faster-resolving slot",
  );
});

Deno.test("expected resolution never exceeds the strategy holding ceiling", () => {
  const metrics = snapshot(3, 70, 0, 180);
  assert(metrics.expectedSecondsToResolve === 180);
});

Deno.test("a candidate worse on EV, win rate and turnover never outranks its dominator", () => {
  const dominant = lobSelectionMetrics({
    ev_lower_bound_bps: 5,
    p_target: 0.60,
    target_bps: 60,
    stop_bps: 40,
    empirical_hold_seconds: 40,
    features: { noiseBandBps: 8, observationMs: 8000 },
  });
  const dominated = lobSelectionMetrics({
    ev_lower_bound_bps: 4,
    p_target: 0.50,
    target_bps: 60,
    stop_bps: 40,
    empirical_hold_seconds: 100,
    features: { noiseBandBps: 4, observationMs: 8000 },
  });
  assert(compareLobSelection(dominant, dominated) < 0);
});

Deno.test("joint-objective ranking preserves count and prioritises the Pareto frontier", () => {
  const candidates = [
    {
      name: "slow-low",
      metrics: lobSelectionMetrics({
        ev_lower_bound_bps: 3,
        p_target: 0.45,
        target_bps: 60,
        stop_bps: 40,
        empirical_hold_seconds: 150,
      }),
    },
    {
      name: "sweep-like",
      metrics: lobSelectionMetrics({
        ev_lower_bound_bps: 5,
        p_target: 0.58,
        target_bps: 60,
        stop_bps: 40,
        pattern_quality: 1.2,
        empirical_profitable_rate: 0.43,
        empirical_hold_seconds: 41,
      }),
    },
    {
      name: "high-ev-slower",
      metrics: lobSelectionMetrics({
        ev_lower_bound_bps: 6,
        p_target: 0.56,
        target_bps: 60,
        stop_bps: 40,
        empirical_hold_seconds: 90,
      }),
    },
  ];
  const ranked = rankLobSelections(candidates, (row) => row.metrics);
  assert(ranked.length === candidates.length, "ranking must never reduce trade supply");
  assert(ranked[0].name !== "slow-low", "a candidate dominated on every objective cannot lead");
});

Deno.test("live-data migration seeds calibration without adding a trade-count gate", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../migrations/202607270017_live_data_model_v660.sql",
      import.meta.url,
    ),
  );
  assert(sql.includes("samples = 67"));
  assert(sql.includes('"probabilityMultiplier": 0.30'));
  assert(sql.includes("scalp_position_slots = greatest"));
  assert(sql.includes("scalp_scan_universe = greatest"));
  assert(!sql.includes("max_daily_entries ="));
});

Deno.test("joint-objective migration keeps positive EV and repairs legacy maker reconciliation", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../migrations/202607270018_joint_objective_v661.sql",
      import.meta.url,
    ),
  );
  assert(sql.includes("JOINT_OBJECTIVE_V661"));
  assert(sql.includes("'reconciliation_phase', 'ENTRY'"));
  assert(sql.includes("p.remaining_quantity, 0) = 0"));
  assert(!sql.includes("lob_min_net_ev_bps"));
  assert(!sql.includes("max_daily_entries"));
  const source = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  assert(source.includes("legacy_maker_recovered_at"));
  assert(source.includes('reconciliation_phase: "ENTRY"'));
  assert(source.includes("!p.metadata?.reconciliation_phase"));
  assert(source.includes("finite(p.initial_quantity) <= 0"));
  assert(source.includes("await syncMakerEntry(position, settings, cycleId)"));
});
