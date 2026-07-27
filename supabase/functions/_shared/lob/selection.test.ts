import { compareLobSelection, lobSelectionMetrics } from "./selection.ts";

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
