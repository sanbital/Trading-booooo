// v6.9.0 deployment invariants. These are source-level tripwires for the seven fixes.

import { assert, assertEquals } from "../../../../test-support/assert.ts";

Deno.test("v7 keeps slot concentration safety and sizes only from current LOB evidence", async () => {
  const source = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  assert(source.includes("capitalSupportedSlotCount("));
  assert(
    !source.includes("effectiveSlots("),
    "autotrader must not dynamically reduce slot denominator",
  );
  assert(source.includes("current LOB evidence complete"));
  assert(!source.includes("lobEvidenceSizeFraction("));
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

Deno.test("the current scanner and autotrader versions remain aligned", async () => {
  const scanner = await Deno.readTextFile(
    new URL("../../market-scanner/engine.ts", import.meta.url),
  );
  const autotrader = await Deno.readTextFile(
    new URL("../../market-autotrader/index.ts", import.meta.url),
  );
  const scannerVersion = scanner.match(/ENGINE_VERSION = "([^"]+)"/)?.[1];
  const autotraderVersion = autotrader.match(/const VERSION = "([^"]+)"/)?.[1];
  assert(scannerVersion);
  assertEquals(autotraderVersion, scannerVersion);
});
