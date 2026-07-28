// v6.9.0 deployment invariants. These are source-level tripwires for the seven fixes.

import { assert, assertEquals } from "../../../../test-support/assert.ts";

Deno.test("v6.9 fixes slot concentration and evidence-sizes LOB exploration", async () => {
  const source = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  assert(source.includes("const slots = configuredSlots;"));
  assert(!source.includes("effectiveSlots("), "autotrader must not dynamically reduce slot denominator");
  assert(source.includes("lobEvidenceSizeFraction"));
  assert(source.includes("sizeFraction: evidenceSize"));
  assert(source.includes("forecastBiasPenaltyBps"));
  assert(source.includes("resolveLatencyPenaltyBps"));
});

Deno.test("v6.9 migration permits only verified live outcomes to vote", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../migrations/202607270022_evidence_sized_live_validation_v690.sql",
      import.meta.url,
    ),
  );
  assert(sql.includes("accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')"));
  assert(sql.includes("'liveVerified', true"));
  assert(sql.includes("'backtest_shadow_can_vote', false"));
  assert(sql.includes("traffic_fraction = 0.50"));
  assert(sql.includes("v_decision = 'EXPAND'"));
  assert(sql.includes("policy_definition"));
  assert(!sql.includes("scalp_position_slots ="));
  assert(!sql.includes("scalp_max_single_loss_pct ="));
});

Deno.test("v6.9.1 hotfix versions remain aligned", async () => {
  const scanner = await Deno.readTextFile(
    new URL("../../market-scanner/engine.ts", import.meta.url),
  );
  const autotrader = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  const expected = "6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE";
  assert(scanner.includes(expected));
  assert(autotrader.includes(expected));
  assertEquals(expected, "6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE");
});
