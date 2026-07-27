import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../../", import.meta.url);

Deno.test("v5.12 autotrader has no live EV exploration or threshold relaxation path", async () => {
  const code = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  assertEquals(code.includes("evaluateExploration"), false);
  assertEquals(code.includes("relaxedMinimumEdge"), false);
  assert(code.includes("scalp_rate_relaxation: 0"));
});

Deno.test("SCALP monitoring preserves the profile TIMEOUT before and after TP cancellation", async () => {
  const code = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  const calls = [...code.matchAll(/decideExit\([^;]+\);/g)].map((m) => m[0]);
  assert(calls.length >= 2);
  for (const call of calls) assert(/,\s*true,\s*\);$/.test(call), call);
});

Deno.test("v5.12 migration forces PAPER and extends reconciliation states", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "supabase/migrations/202607260015_scalp_v512_quality_gate.sql",
      ROOT,
    ),
  );
  assert(sql.includes("mode = 'PAPER'"));
  assert(sql.includes("scalp_exploration_per_day = 0"));
  assert(sql.includes("RECONCILIATION_FAILED"));
  assert(sql.includes("MANUAL_INTERVENTION_REQUIRED"));
});
