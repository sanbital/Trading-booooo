import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url);
const MIGRATION = new URL(
  "supabase/migrations/20260830054000_v10_production_regime_router_fail_closed.sql",
  ROOT,
);
const migration = await Deno.readTextFile(MIGRATION);
const ACL_FINALIZATION_MIGRATION = new URL(
  "supabase/migrations/20260830055500_v10_legacy_resolver_acl_finalization.sql",
  ROOT,
);
const aclFinalizationMigration = await Deno.readTextFile(
  ACL_FINALIZATION_MIGRATION,
);
const CLAIM_DRIFT_MIGRATION = new URL(
  "supabase/migrations/20260830060500_v10_claim_drift_reconciliation.sql",
  ROOT,
);
const claimDriftMigration = await Deno.readTextFile(CLAIM_DRIFT_MIGRATION);

function section(start: string, end: string): string {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  assert(from >= 0, `missing section start: ${start}`);
  assert(to > from, `missing section end: ${end}`);
  return migration.slice(from, to);
}

function sqlFunctionDefinition(source: string, start: string): string {
  const from = source.indexOf(start);
  assert(from >= 0, `missing SQL function: ${start}`);
  const terminator = "$function$;";
  const to = source.indexOf(terminator, from);
  assert(to > from, `unterminated SQL function: ${start}`);
  return source.slice(from, to + terminator.length);
}

Deno.test("V10 release constants and implementation hashes are one immutable patch block", () => {
  const patchBlock = section(
    "-- =============================== V10 PATCH BLOCK",
    "-- ============================= END V10 PATCH BLOCK",
  );

  assert(patchBlock.includes("P10-PRODUCTION-REGIME-ROUTER-V10"));
  assert(
    patchBlock.includes(
      "REGIME_ROUTER_V10_INDEPENDENT_RANGE_BEAR_15M_365D_20260830",
    ),
  );
  assert(patchBlock.includes("ca515e391382669fa6c3724f6a3a6e1207d2ad64"));
  assert(patchBlock.includes("REJECTED_NO_ROBUST_EDGE"));
  assert(patchBlock.includes("v_preregistration_sha256"));
  assert(patchBlock.includes("v_candidate_universe_sha256"));
  assert(patchBlock.includes("v_candidate_registry_sha256"));
  assert(patchBlock.includes("v_implementation_sha256"));
  assert(patchBlock.includes("v_validation_status"));
  assert(patchBlock.includes("v_promotion_decision"));
  assert(patchBlock.includes("BULL_EXISTING_ONLY_NON_BULL_CASH"));
  assert(patchBlock.includes("NO_CANDIDATE_PASSED_LOCK_GATES"));
  assert(patchBlock.includes("'candidate_count', 24"));
  assert(patchBlock.includes("'hypothesis_family_count', 12"));
  assert(patchBlock.includes("'eligible_candidate_count', 0"));
  assert(patchBlock.includes("'test_accessed', false"));
  assert(patchBlock.includes("'independent_replay_eligibility_agreement', '24/24'"));
  assert(patchBlock.includes("'robust_candidates', '[]'::jsonb"));

  for (
    const hash of [
      "eed3db7ad923bc2fa8a3198c88efd8dc31024d55b6b04a9ce7dd709be0605579",
      "c0e9519cc36af561adc72b75faa08900f8b7301b6bc72e92023846b14ee5a910",
      "d7da8d3e6703b2981f174d09e8b900f0753638ee7ed0296111a444455c9a6554",
      "b1b0c1c9d376a2e223545ef5c56395d8e960c7272daa4b641bc031c07fada51f",
      "aa5f8d64bdd7380e938a4f536bdd061527b3213a0c9652584e91f717f1820fda",
    ]
  ) {
    assert(patchBlock.includes(hash));
  }
  assert(patchBlock.includes("on conflict (router_revision) do nothing"));
  assert(patchBlock.includes("differs from the immutable PATCH BLOCK"));

  for (const table of ["p10_v10_router_manifests", "p10_v10_router_cutover_audit"]) {
    assert(migration.includes(`alter table public.${table} enable row level security`));
    assert(
      migration.includes(`revoke all on table public.${table} from public, anon, authenticated`),
    );
    assert(migration.includes(`grant select on table public.${table} to service_role`));
  }
  assert(migration.includes("before truncate on public.p10_v10_router_manifests"));
  assert(migration.includes("before truncate on public.p10_v10_router_cutover_audit"));
  assert(migration.includes("is append-only; publish a new V10 router revision"));
});

Deno.test("V10 migration implementation digest reproduces after self-normalization", async () => {
  const match = migration.match(
    /v_implementation_sha256 constant text :=\s*'([0-9a-f]{64})';/,
  );
  assert(match, "missing implementation SHA-256 literal");
  const normalized = migration.replace(match[1], "0".repeat(64));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const actual = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(match[1], actual);
});

Deno.test("V10 legacy resolver ACL finalization is reproducible and exhaustive", async () => {
  const match = aclFinalizationMigration.match(
    /v_implementation_sha256 constant text :=\s*'([0-9a-f]{64})';/,
  );
  assert(match, "missing ACL finalization implementation SHA-256 literal");
  const normalized = aclFinalizationMigration.replace(match[1], "0".repeat(64));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const actual = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(match[1], actual);

  assert(
    aclFinalizationMigration.includes(
      "P10-V10-LEGACY-RESOLVER-ACL-FINAL-20260830",
    ),
  );
  assert(
    aclFinalizationMigration.includes(
      "revoke execute on function %s from public, anon, authenticated, service_role",
    ),
  );
  assert(aclFinalizationMigration.includes("legacy resolver EXECUTE privilege remains"));
  assert(aclFinalizationMigration.includes("p10_v10_acl_repair_audit"));
  assert(aclFinalizationMigration.includes("before truncate"));
});

Deno.test("V10 claim drift reconciliation restores canonical fail-closed wiring", async () => {
  const match = claimDriftMigration.match(
    /v_implementation_sha256 constant text :=\s*'([0-9a-f]{64})';/,
  );
  assert(match, "missing claim drift implementation SHA-256 literal");
  const normalized = claimDriftMigration.replace(match[1], "0".repeat(64));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const actual = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(match[1], actual);

  assert(
    claimDriftMigration.includes("P10-V10-CLAIM-DRIFT-RECONCILIATION-20260830"),
  );
  assert(
    claimDriftMigration.includes("resolve_p10_production_regime_route_v10("),
  );
  assert(claimDriftMigration.includes("V10_ROUTER_ERROR_FAIL_CLOSED"));
  assert(claimDriftMigration.includes("if v_decision <> 'PASS' then"));
  assert(claimDriftMigration.includes("V10 claim/wrapper canonical definition assertion"));
  assert(claimDriftMigration.includes("p10_v10_claim_drift_repairs"));
  assert(claimDriftMigration.includes("before truncate"));

  for (
    const signature of [
      "create or replace function public.resolve_p10_production_regime_route(",
      "create or replace function public.claim_p10_signal(",
    ]
  ) {
    assertEquals(
      sqlFunctionDefinition(claimDriftMigration, signature),
      sqlFunctionDefinition(migration, signature),
      `${signature} must remain byte-identical to the immutable V10 definition`,
    );
  }
});

Deno.test("post-V10 migrations cannot silently redefine production claim wiring", async () => {
  const migrationDirectory = new URL("supabase/migrations/", ROOT);
  const allowed = new Set([
    "20260830060500_v10_claim_drift_reconciliation.sql",
  ]);

  for await (const entry of Deno.readDir(migrationDirectory)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    if (entry.name <= "20260830054000_v10_production_regime_router_fail_closed.sql") {
      continue;
    }
    const source = await Deno.readTextFile(new URL(entry.name, migrationDirectory));
    const redefinesWiring =
      source.includes("create or replace function public.claim_p10_signal(") ||
      source.includes(
        "create or replace function public.resolve_p10_production_regime_route(",
      );
    if (redefinesWiring) {
      assert(allowed.has(entry.name), `unapproved post-V10 wiring migration: ${entry.name}`);
    }
  }
});

Deno.test("V10 registry preserves only two existing BULL lanes and makes every non-BULL state CASH", () => {
  const registry = section(
    "insert into public.p10_regime_router_lanes",
    "create or replace function public.validate_p10_v10_bull_signal_lineage",
  );

  for (
    const state of [
      "BULL_TREND",
      "BULL_DECELERATING",
      "RANGE_UP_CYCLE",
      "BEAR_REBOUND",
      "BEAR_REBREAK",
    ]
  ) {
    assert(registry.includes(`'${state}'`), `missing V10 state ${state}`);
  }

  const laneInsert = registry.slice(0, registry.indexOf("-- Exact row comparison"));
  const enabledRows = laneInsert.match(/\n\s+true,\n\s+'ENABLED_EXISTING_EDGE'/g) ?? [];
  assertEquals(enabledRows.length, 2);
  assert(registry.includes("PRESERVE_PROVEN_EXISTING_I46_P10_BULL_LONG_EDGE"));
  assert(registry.includes("V10_HAS_NO_LOCKED_PRODUCTION_RANGE_EDGE"));
  assert(registry.includes("V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBOUND_EDGE"));
  assert(registry.includes("V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBREAK_EDGE"));
  assert(registry.includes("'NO_TRADE_CASH'"));
  assert(registry.includes("'NOT_APPLICABLE_CASH'"));
  assert(registry.includes("Exact row comparison prevents ON CONFLICT"));
  assert(registry.includes("v_actual is distinct from v_expected"));
});

Deno.test("V10 accepts only the exact existing I46 Binance or P10 Upbit LONG lineage", () => {
  const lineage = section(
    "create or replace function public.validate_p10_v10_bull_signal_lineage",
    "create or replace function public.evaluate_p10_entry_regime_v10",
  );

  assert(lineage.includes("v_side <> 'LONG'"));
  assert(lineage.includes("v_venue in ('binance_spot', 'binance_futures')"));
  assert(lineage.includes("v_strategy = 'I46_HYBRID_SCORE_L1'"));
  assert(lineage.includes("v_revision = 'I46-LIVE-1.0.0'"));
  assert(lineage.includes("v_venue = 'upbit_spot'"));
  assert(lineage.includes("v_strategy = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'"));
  assert(lineage.includes("v_revision = 'P10-LIVE-1.0.0'"));
  assert(lineage.includes("v_execution_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'"));
  assert(lineage.includes("UNRECOGNIZED_V10_BULL_SIGNAL_LINEAGE"));
});

Deno.test("live producer and claimant preserve the V10 lineage evidence contract", async () => {
  const producer = await Deno.readTextFile(
    new URL("supabase/functions/market-v2-signal/index.ts", ROOT),
  );
  const claimant = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );

  assert(producer.includes('const I46_REV = "I46-LIVE-1.0.0"'));
  assert(producer.includes('const P10_REV = "P10-LIVE-1.0.0"'));
  assert(producer.includes("revision: rev,"));
  assert(producer.includes("entry_strategy_key: i46 ? I46_KEY : P10_KEY,"));
  assert(producer.includes("execution_config_key: P10_KEY,"));

  const claimCall = claimant.slice(
    claimant.indexOf('const claimResult = await rpc("claim_p10_signal"'),
    claimant.indexOf(
      "const regimeRoute =",
      claimant.indexOf('const claimResult = await rpc("claim_p10_signal"'),
    ),
  );
  assert(claimCall.includes("p_venue: signal.venue"));
  assert(claimCall.includes("p_side: side"));
  assert(claimCall.includes("evidence: signal.evidence"));
});

Deno.test("V10 attests the caller evidence to one fresh persisted live signal and completed run", () => {
  const verifier = section(
    "create or replace function public.validate_p10_v10_persisted_signal",
    "create or replace function public.evaluate_p10_entry_regime_v10",
  );

  assert(verifier.includes("from public.v2_live_signals s"));
  assert(verifier.includes("join public.v2_live_signal_runs r on r.id = s.run_id"));
  assert(verifier.includes("select count(*) = 1"));
  assert(verifier.includes("s.run_id::text = $1"));
  assert(verifier.includes("s.signal_time = $5"));
  assert(verifier.includes("s.scenario_number = case when $2 = 'upbit_spot' then 10 else 46 end"));
  assert(verifier.includes("s.created_at <= $9"));
  assert(verifier.includes("s.evidence = $6->'evidence'"));
  assert(verifier.includes("r.mode = 'LIVE_LIMITED'"));
  assert(verifier.includes("r.status = 'COMPLETED'"));
  assert(verifier.includes("r.completed_at <= $9"));
  assert(verifier.includes("r.metadata->>'entry_strategy_key'") === false);
  assert(verifier.includes("r.metadata->>'strategy_key' = $8"));
  assert(verifier.includes("p_at < p_signal_time + interval '1 hour'"));
  assert(verifier.includes("p_at > p_signal_time + interval '80 minutes'"));
  assert(verifier.includes("PERSISTED_SIGNAL_ATTESTATION_UNAVAILABLE_FAIL_CLOSED"));

  const router = section(
    "create or replace function public.resolve_p10_production_regime_route_v10",
    "-- Compatibility/diagnostic wrapper",
  );
  assert(router.includes("public.validate_p10_v10_persisted_signal("));
  assert(router.includes("v_persisted_signal->>'verified'"));
  assert(router.includes("persisted_signal_attestation"));
});

Deno.test("V10 canonicalizes every persisted producer table required before attestation", () => {
  for (
    const table of [
      "v2_live_signal_runs",
      "v2_live_signals",
      "v2_live_universe_snapshots",
      "v2_strategy_registry",
    ]
  ) {
    assert(migration.includes(`create table if not exists public.${table}`));
    assert(migration.includes(`alter table public.${table} enable row level security`));
  }
  assert(
    migration.includes(
      "references public.v2_live_signal_runs(id) on delete cascade",
    ),
  );
  assert(
    migration.includes(
      "grant select, insert, update, delete on table public.v2_live_signals to service_role",
    ),
  );
});

Deno.test("V10 observer and router fail closed while structural and tactical states remain separate", () => {
  const evaluator = section(
    "create or replace function public.evaluate_p10_entry_regime_v10",
    "create or replace function public.resolve_p10_production_regime_route_v10",
  );
  const router = section(
    "create or replace function public.resolve_p10_production_regime_route_v10",
    "-- Compatibility/diagnostic wrapper",
  );

  assert(evaluator.includes("o.observed_at <= v_at"));
  assert(evaluator.includes("o.observed_at >= v_at - interval '12 minutes'"));
  assert(evaluator.includes("o.confidence >= 0.60"));
  assert(evaluator.includes("o.sample_size >= 240"));
  assert(evaluator.includes("'sample_size' ~ '^[0-9]+$'"));
  assertEquals(evaluator.includes("'sample_size')::integer"), false);
  assert(evaluator.includes("OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED"));
  assert(evaluator.includes("OBSERVER_NOT_LIVE_FOR_TRADING_FAIL_CLOSED"));
  assert(evaluator.includes("'fail_closed', true"));

  assert(router.includes("v_state text := 'NO_TRADE'"));
  assert(router.includes("v_candidate_state := 'RANGE_UP_CYCLE'"));
  assert(router.includes("then 'BEAR_REBOUND'"));
  assert(router.includes("else 'BEAR_REBREAK'"));
  assertEquals(router.includes("v_state := 'RANGE_UP_CYCLE'"), false);
  assertEquals(router.includes("v_state := 'BEAR_REBOUND'"), false);
  assertEquals(router.includes("v_state := 'BEAR_REBREAK'"), false);
  assert(router.includes("RANGE_NO_TRADE_NO_LOCKED_V10_EDGE"));
  assert(router.includes("BEAR_NO_TRADE_NO_LOCKED_V10_EDGE"));
  assert(router.includes("SHORT_DISABLED_NO_LOCKED_V10_EDGE"));
  assert(router.includes("V10_REGISTRY_OR_WIRING_INTEGRITY_FAIL_CLOSED"));
  assert(router.includes("v_action text := 'BLOCK'"));
  assertEquals(router.includes("FAIL_OPEN"), false);
});

Deno.test("claim is wired directly to V10 and every exception or unknown action blocks", () => {
  const claim = section(
    "create or replace function public.claim_p10_signal",
    "revoke execute on function public.reject_p10_v10_router_lineage_mutation",
  );

  assert(claim.includes("public.resolve_p10_production_regime_route_v10("));
  assertEquals(claim.includes("resolve_p10_production_regime_route_v3("), false);
  assert(claim.includes("v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10'"));
  assert(claim.includes("exception when others"));
  assert(claim.includes("v_decision := 'BLOCK'"));
  assert(claim.includes("V10_ROUTER_ERROR_FAIL_CLOSED"));
  assert(claim.includes("if v_decision <> 'PASS' then"));
  assert(claim.includes("V10_ROUTE_CONTRACT_MISMATCH_FAIL_CLOSED"));
  assert(claim.includes("'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'"));
  assertEquals(claim.includes("FAIL_OPEN"), false);

  const wrapper = section(
    "-- Compatibility/diagnostic wrapper",
    "create or replace function public.claim_p10_signal",
  );
  assert(wrapper.includes("resolve_p10_production_regime_route_v10"));
  assert(wrapper.includes("cannot authorize an entry"));
});

Deno.test("legacy versioned resolvers lose service-role execution without deleting history", () => {
  const acl = section(
    "-- Remove direct app access to every versioned legacy resolver",
    "-- One-time production cutover and immutable hash audit",
  );

  assert(acl.includes("p.prokind = 'f'"));
  assert(acl.includes("left(p.proname, length('resolve_p10_production_regime_route_v'))"));
  assert(
    acl.includes(
      "resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)",
    ),
  );
  assert(acl.includes("revoke execute on function %s"));
  assert(acl.includes("service_role"));
  assertEquals(acl.includes("drop function"), false);

  assert(migration.includes("resolver_definition_md5"));
  assert(migration.includes("wrapper_definition_md5"));
  assert(migration.includes("claim_definition_md5"));
  assert(migration.includes("md5(pg_get_functiondef("));
  assert(migration.includes("claim_p10_signal V10 revision wiring assertion failed"));
});

Deno.test("global suspension is neutralized exactly once and retained as an emergency backstop", () => {
  const cutover = section(
    "do $v10_cutover$",
    "comment on function public.resolve_p10_production_regime_route_v10",
  );
  const exactLegacyReason =
    "BULL lane failed the same V5 promotion criteria that rejected RANGE/BEAR (v_p10_lane_revalidation); regime gate edge negative at every horizon (v_regime_gate_edge). 2026-08-30.";

  assert(cutover.includes(exactLegacyReason));
  assert(cutover.includes("2026-08-30 02:29:10.746581+00"));
  assert(cutover.includes("v_first_cutover := not exists"));
  assert(cutover.includes("if v_first_cutover then"));
  assert(cutover.includes("refusing to clear non-allowlisted p10 entry suspension"));
  assert(cutover.includes("set suspended = false"));
  assert(cutover.includes("suspended_at = clock_timestamp()"));
  assert(cutover.includes("V10_BULL_I46_P10_RESTORED_NON_BULL_CASH_OBSERVER_FAIL_CLOSED_20260830"));
  assert(migration.includes("create table if not exists public.p10_entry_suspension"));
  assert(migration.includes("create or replace function public.activate_p10_entry_suspension_v10"));
  assert(migration.includes("grant select on table public.p10_entry_suspension to service_role"));
  assertEquals(
    migration.includes("grant select, update on table public.p10_entry_suspension"),
    false,
  );
  assert(
    migration.includes("grant execute on function public.activate_p10_entry_suspension_v10(text)"),
  );
  assert(cutover.includes("aaa0_trading_orders_entry_suspension_v810"));
  assert(cutover.includes("guard_p10_entry_suspension_v810"));
  assert(cutover.includes("P10_ENTRY_SUSPENDED_20260830"));
  assert(cutover.includes("position_effect"));
  assert(cutover.includes("t.tgtype = 23"));
  assert(migration.includes("before insert or update on public.trading_orders"));
  assert(migration.includes("pg_advisory_xact_lock_shared"));
  assert(cutover.includes("pg_advisory_xact_lock"));
  assert(cutover.includes("for update"));
  assert(cutover.includes("get diagnostics v_cas_count = row_count"));
  assert(cutover.includes("t.tgenabled in ('O', 'A')"));
  assert(cutover.includes("t.tgqual is null"));
  assert(cutover.includes("n.nspname = 'public'"));
  assert(cutover.includes("'suspension_trigger_action', 'PRESERVED'"));
  assert(cutover.includes("v_table_found and v_trigger_found"));
  assertEquals(cutover.includes("drop trigger"), false);
  assertEquals(cutover.includes("drop table public.p10_entry_suspension"), false);
  assertEquals(cutover.includes("drop function public.guard_p10_entry_suspension_v810"), false);
});

Deno.test("executor still claims before durable position and order guards", async () => {
  const source = await Deno.readTextFile(
    new URL("supabase/functions/market-autotrader/index.ts", ROOT),
  );
  const safetySql = await Deno.readTextFile(
    new URL("supabase/migrations/20260824054500_confirm_emergency_liquidation.sql", ROOT),
  );

  const claimAt = source.indexOf('const claimResult = await rpc("claim_p10_signal"');
  const positionAt = source.indexOf('position = (await insert("trading_positions"', claimAt);
  const orderAt = source.indexOf("orderRow = await createOrderRecord", positionAt);
  assert(claimAt >= 0 && claimAt < positionAt && positionAt < orderAt);

  assert(safetySql.includes("create or replace function public.guard_p10_live_entry_settings"));
  assert(safetySql.includes("for share"));
  assert(safetySql.includes("pause_new_entries"));
  assert(safetySql.includes("emergency_liquidation"));
  assertEquals(
    migration.includes("drop trigger if exists trg_guard_p10_live_entry_settings"),
    false,
  );
  assertEquals(migration.includes("drop function public.guard_p10_live_entry_settings"), false);
});
