import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);
const MIGRATION = new URL(
  "supabase/migrations/20260829120027_p10_production_regime_router_v3_validation_registry.sql",
  ROOT,
);

Deno.test("regime router v3 preserves five explicit lanes without promoting rejected V5 edges", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  for (
    const state of [
      "BULL_TREND",
      "BULL_DECELERATING",
      "RANGE_UP_CYCLE",
      "BEAR_REBOUND",
      "BEAR_REBREAK",
    ]
  ) {
    assert(sql.includes(`'${state}'`), `missing production lane ${state}`);
  }

  assert(sql.includes("'REJECTED_NO_ROBUST_EDGE'"));
  assert(sql.includes("'robust_candidates', '[]'::jsonb"));
  assert(sql.includes("'test_used_for_selection', false"));
  assert(sql.includes("'funding_accounted', false"));
  assert(sql.includes("'actual_fill_replay', false"));
  assert(sql.includes("'point_in_time_delisted_universe', false"));
  assert(sql.includes("V5_FULL_MARKET_ROLLING_VALIDATION_REJECTED_ALL_RANGE_CANDIDATES"));
  assert(sql.includes("V5_FULL_MARKET_ROLLING_VALIDATION_REJECTED_ALL_BEAR_REBREAK_CANDIDATES"));

  const enabledRows = sql.match(/\n\s+true,\n\s+'ENABLED_EXISTING_EDGE'/g) ?? [];
  assertEquals(enabledRows.length, 2);
  assert(sql.includes("PRESERVE_PREEXISTING_P10_BULL_LONG_EDGE_NOT_A_V5_PROMOTION"));
});

Deno.test("regime router v3 never invents market tactical confirmation from the global observer", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assert(sql.includes("v_state text := 'NO_TRADE'"));
  assert(sql.includes("v_candidate_state := 'RANGE_UP_CYCLE'"));
  assert(sql.includes("then 'BEAR_REBOUND'"));
  assert(sql.includes("else 'BEAR_REBREAK'"));
  assert(sql.includes("MISSING_MARKET_V5_15M_AND_COMPLETED_5M_CONFIRMATION"));
  assert(!sql.includes("v_state := 'RANGE_UP_CYCLE'"));
  assert(!sql.includes("v_state := 'BEAR_REBREAK'"));
  assert(sql.includes("'state_verified', v_state_verified"));
});

Deno.test("regime router v3 keeps lineage append-only and internal RPCs service-role only", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assert(sql.includes("is append-only; insert a new router revision instead"));
  assert(sql.includes("before truncate on public.p10_regime_router_validations"));
  assert(sql.includes("before truncate on public.p10_regime_router_lanes"));
  assert(sql.includes("unique (router_revision)"));
  assert(
    sql.includes("on conflict (router_revision) do nothing"),
  );
  assert(sql.includes("on conflict (router_revision, router_state) do nothing"));
  assert(sql.includes("expected exactly one immutable completed V5 validation job"));
  assert(sql.includes("validation lineage does not match the immutable migration"));
  assert(sql.includes("lane registry does not match the fail-closed migration"));
  assert(sql.includes("P10_ROUTER_PROMOTION_BLOCKED"));
  assert(sql.includes("v.validation_status = 'APPROVED'"));
  assert(sql.includes("v.validation_metrics->>'funding_accounted'"));
  assert(sql.includes("v.validation_metrics->>'actual_fill_replay'"));
  assert(sql.includes("v.validation_metrics->>'point_in_time_delisted_universe'"));
  assert(sql.includes("jsonb_array_length"));
  assert(
    sql.includes("revoke all on table public.p10_regime_router_validations from service_role"),
  );
  assert(sql.includes("revoke execute on function public.resolve_p10_production_regime_route_v3"));
  assert(
    sql.includes(
      "revoke execute on function public.resolve_p10_production_regime_route(text, timestamptz)",
    ),
  );
  assert(sql.includes("revoke execute on function public.claim_p10_signal"));
  assert(sql.includes("grant execute on function public.claim_p10_signal"));
});

Deno.test("claim v3 passes market-time evidence and preserves BULL-only fail semantics", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assert(sql.includes("public.resolve_p10_production_regime_route_v3(\n      p_market,"));
  assert(sql.includes("p_signal_time,"));
  assert(sql.includes("coalesce(p_evidence, '{}'::jsonb),"));
  assert(sql.includes("'OBSERVER_UNAVAILABLE_PRESERVE_VALIDATED_LONG_EDGE'"));
  assert(sql.includes("'VALIDATED_BULL_LONG_EDGE'"));
  assert(sql.includes("'RANGE_ABSTAIN_NO_VALIDATED_EDGE'"));
  assert(sql.includes("'BEAR_ABSTAIN_NO_VALIDATED_EDGE'"));
  assert(sql.includes("'SHORT_DISABLED_NEGATIVE_LIVE_AND_NO_V5_ROBUST_EDGE'"));
  assert(sql.includes("v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-v3'"));
});

Deno.test("executor preserves route decisions and immutable entry lineage before order creation", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );

  const claimAt = source.indexOf('const claimResult = await rpc("claim_p10_signal"');
  const positionAt = source.indexOf('position = (await insert("trading_positions"', claimAt);
  const orderAt = source.indexOf("orderRow = await createOrderRecord", positionAt);
  assert(claimAt >= 0 && claimAt < positionAt && positionAt < orderAt);
  const entryScope = source.slice(claimAt, orderAt);

  assert(entryScope.includes("claimResult?.blocked === true"));
  assert(entryScope.includes("claimResult?.reason"));
  assert(!entryScope.includes('reason: "signal already claimed"'));
  assert(entryScope.includes("P10_ROUTE_STRATEGY_MISMATCH"));
  assert(entryScope.includes("p10_regime_route: regimeRoute"));
  assert(entryScope.includes("p10_router_revision: regimeRoute?.policy_revision"));
  assert(entryScope.includes("p10_router_state: regimeRoute?.state"));
  assert(entryScope.includes("p10_entry_structural_regime:"));
  assert(entryScope.includes("p10_entry_tactical_phase:"));
  assert(entryScope.includes("p10_entry_route_observation_id:"));
  assert(entryScope.includes("p10_entry_router_research_job_id:"));
});
