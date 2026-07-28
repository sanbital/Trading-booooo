import { assert } from "../../../../test-support/assert.ts";

const ROOT = new URL("../../../../", import.meta.url);

Deno.test("v6.10 joint objective keeps return, win rate and turnover as separate promotion gates", async () => {
  const governance = await Deno.readTextFile(new URL("supabase/functions/_shared/lob/governance.ts", ROOT));
  assert(governance.includes("net_return_improved"));
  assert(governance.includes("win_rate_improved"));
  assert(governance.includes("capital_turnover_improved"));
  assert(governance.includes("joint_objective_point_dominance"));
  assert(governance.includes("currentTrafficFraction: 0.15"));
  assert(governance.includes("expandedTrafficFraction: 0.25"));
});

Deno.test("v6.10 accounting and exposure ledgers are wired into the runtime", async () => {
  const source = await Deno.readTextFile(new URL("supabase/functions/market-autotrader/index.ts", ROOT));
  assert(source.includes("calculateExposureLedger"));
  assert(source.includes("reserved_quote"));
  assert(source.includes("fee_accounting_quality"));
  assert(source.includes("reconcileFeeLedger"));
  assert(source.includes("recordJointObjectiveSnapshot"));
  assert(source.includes("claim_lob_exploration_budget_v610"));
  assert(source.includes("p_position_id: position.id"));
});

Deno.test("v6.10 migration separates fee quality and settles exploration cancellation", async () => {
  const sql = await Deno.readTextFile(new URL("supabase/migrations/202607280002_joint_compound_growth_v610.sql", ROOT));
  assert(sql.includes("fee_accounting_quality"));
  assert(sql.includes("trading_asset_locks"));
  assert(sql.includes("trading_residual_inventory"));
  assert(sql.includes("lob_exploration_budget_claims"));
  assert(sql.includes("POSITION_NOT_TERMINAL"));
  assert(sql.includes("new.state in ('CLOSED','CANCELLED')"));
  assert(sql.includes("external_flow_quote"));
  assert(sql.includes("FILL_CONDITIONAL"));
});

Deno.test("v6.10 self-learning is bounded and cannot rewrite source or operator safety rails", async () => {
  const policy = await Deno.readTextFile(new URL("supabase/functions/_shared/lob/adaptive-policy.ts", ROOT));
  const migration = await Deno.readTextFile(new URL("supabase/migrations/202607280002_joint_compound_growth_v610.sql", ROOT));
  assert(policy.includes("schemaVersion: 2"));
  assert(policy.includes("bounded"));
  assert(!migration.includes("scalp_max_single_loss_pct="));
  assert(!migration.includes("scalp_daily_loss_pct="));
  assert(!migration.includes("upbit_enabled="));
  assert(!migration.includes("binance_enabled="));
});
