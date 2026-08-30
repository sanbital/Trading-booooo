-- V10 production regime router cutover
--
-- This revision restores only the pre-existing I46/P10 BULL LONG execution lane.
-- RANGE and BEAR remain explicit CASH / NO_TRADE states until a later immutable
-- candidate lock has independently passed the production promotion contract.
-- Missing, stale, non-influential, or erroneous regime evidence always fails closed.
--
-- The release constants are intentionally concentrated in the PATCH BLOCK below.
-- Replace the pending research lineage and hashes before deployment when the final
-- V10 lock is available.  Do not mutate an applied row; publish another revision.

create table if not exists public.p10_v10_router_manifests (
  router_revision text primary key,
  research_revision text not null,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  preregistration_sha256 text not null check (preregistration_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_universe_sha256 text not null check (candidate_universe_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_registry_revision text not null,
  candidate_registry_sha256 text not null check (candidate_registry_sha256 ~ '^[0-9a-f]{64}$'),
  implementation_sha256 text not null check (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  validation_status text not null check (
    validation_status in ('REJECTED_NO_ROBUST_EDGE', 'REJECTED_INCOMPLETE')
  ),
  promotion_decision text not null check (
    promotion_decision = 'BULL_EXISTING_ONLY_NON_BULL_CASH'
  ),
  candidate_lock_timestamp timestamptz,
  final_test_access_timestamp timestamptz,
  manifest jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);

comment on table public.p10_v10_router_manifests is
  'Append-only V10 release constants. A later candidate promotion requires a new router revision.';

create table if not exists public.p10_v10_router_cutover_audit (
  router_revision text primary key,
  claim_policy_revision text not null,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  implementation_sha256 text not null check (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_registry_sha256 text not null check (candidate_registry_sha256 ~ '^[0-9a-f]{64}$'),
  resolver_definition_md5 text not null check (resolver_definition_md5 ~ '^[0-9a-f]{32}$'),
  producer_verifier_definition_md5 text not null check (producer_verifier_definition_md5 ~ '^[0-9a-f]{32}$'),
  wrapper_definition_md5 text not null check (wrapper_definition_md5 ~ '^[0-9a-f]{32}$'),
  claim_definition_md5 text not null check (claim_definition_md5 ~ '^[0-9a-f]{32}$'),
  legacy_resolver_execute_revoked boolean not null,
  suspension_table_found boolean not null,
  suspension_previous_state boolean,
  suspension_previous_reason text,
  suspension_previous_at timestamptz,
  suspension_trigger_found boolean not null,
  suspension_backstop_preserved boolean not null,
  suspension_neutralized_at timestamptz,
  cutover_action text not null,
  audit jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);

comment on table public.p10_v10_router_cutover_audit is
  'One immutable row proving V10 claim wiring, function hashes, legacy ACL retirement, and one-time suspension neutralization.';

-- Canonicalize the emergency backstop that previously existed only as live DB drift.
create table if not exists public.p10_entry_suspension (
  id smallint primary key default 1 check (id = 1),
  suspended boolean not null default true,
  reason text not null,
  suspended_at timestamptz not null default now()
);

create or replace function public.guard_p10_entry_suspension_v810()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_suspended boolean;
begin
  if new.position_effect is distinct from 'OPEN' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.position_effect = 'OPEN' then
    return new;
  end if;

  perform pg_advisory_xact_lock_shared(
    hashtextextended('P10_ENTRY_SUSPENSION_V10', 0)
  );
  select s.suspended
  into v_suspended
  from public.p10_entry_suspension s
  where s.id = 1;

  if coalesce(v_suspended, true) then
    raise exception 'P10_ENTRY_SUSPENDED_20260830'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists aaa0_trading_orders_entry_suspension_v810
  on public.trading_orders;
create trigger aaa0_trading_orders_entry_suspension_v810
before insert or update on public.trading_orders
for each row execute function public.guard_p10_entry_suspension_v810();

create or replace function public.activate_p10_entry_suspension_v10(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_reason = '' then
    raise exception 'P10 suspension reason is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('P10_ENTRY_SUSPENSION_V10', 0)
  );

  insert into public.p10_entry_suspension (id, suspended, reason, suspended_at)
  values (1, true, v_reason, clock_timestamp())
  on conflict (id) do update
  set suspended = true,
      reason = excluded.reason,
      suspended_at = excluded.suspended_at;

  return jsonb_build_object('suspended', true, 'reason', v_reason);
end;
$function$;

alter table public.p10_entry_suspension enable row level security;
revoke all on table public.p10_entry_suspension from public, anon, authenticated, service_role;
grant select on table public.p10_entry_suspension to service_role;
revoke execute on function public.guard_p10_entry_suspension_v810()
  from public, anon, authenticated, service_role;
revoke execute on function public.activate_p10_entry_suspension_v10(text)
  from public, anon, authenticated;
grant execute on function public.activate_p10_entry_suspension_v10(text)
  to service_role;

-- Canonicalize the live-signal producer ledger used by the V10 database attestor.
-- These tables also predated their first checked-in migration in the production DB.
create table if not exists public.v2_live_signal_runs (
  id uuid primary key default gen_random_uuid(),
  revision text not null,
  venue text not null check (
    venue in ('upbit_spot', 'binance_spot', 'binance_futures')
  ),
  mode text not null default 'SHADOW_ONLY' check (
    mode in ('SHADOW_ONLY', 'LIVE_LIMITED')
  ),
  status text not null default 'RUNNING' check (
    status in ('RUNNING', 'COMPLETED', 'FAILED')
  ),
  total_markets integer not null default 0,
  universe_scanned integer not null default 0,
  deep_analyzed integer not null default 0,
  positive_24h integer not null default 0,
  positive_share_24h double precision not null default 0,
  signal_count integer not null default 0,
  error_count integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.v2_live_signals (
  run_id uuid not null references public.v2_live_signal_runs(id) on delete cascade,
  venue text not null,
  market text not null,
  config_key text not null,
  scenario_number integer not null,
  family text not null,
  side text not null check (side in ('LONG', 'SHORT')),
  signal_time timestamptz not null,
  score double precision not null,
  reference_close numeric not null,
  stop_reference numeric not null,
  max_hold_bars integer not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, market, config_key)
);

create table if not exists public.v2_live_universe_snapshots (
  run_id uuid not null references public.v2_live_signal_runs(id) on delete cascade,
  venue text not null,
  market text not null,
  last_price numeric,
  return_24h_pct double precision not null default 0,
  quote_volume_24h numeric not null default 0,
  deep_selected boolean not null default false,
  selection_rank integer,
  created_at timestamptz not null default now(),
  primary key (run_id, market)
);

create table if not exists public.v2_strategy_registry (
  venue text primary key check (
    venue in ('upbit_spot', 'binance_spot', 'binance_futures')
  ),
  revision text not null,
  mode text not null check (
    mode in ('SHADOW_ONLY', 'LIVE_LIMITED', 'REJECTED')
  ),
  cutover_eligible boolean not null default false,
  evidence jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists v2_live_signal_runs_venue_started_idx
  on public.v2_live_signal_runs (venue, started_at desc);
create index if not exists v2_live_signals_venue_created_idx
  on public.v2_live_signals (venue, created_at desc);
create index if not exists v2_live_universe_selected_idx
  on public.v2_live_universe_snapshots (venue, deep_selected, created_at desc);

alter table public.v2_live_signal_runs enable row level security;
alter table public.v2_live_signals enable row level security;
alter table public.v2_live_universe_snapshots enable row level security;
alter table public.v2_strategy_registry enable row level security;
revoke all on table public.v2_live_signal_runs from public, anon, authenticated;
revoke all on table public.v2_live_signals from public, anon, authenticated;
revoke all on table public.v2_live_universe_snapshots from public, anon, authenticated;
revoke all on table public.v2_strategy_registry from public, anon, authenticated;
grant select, insert, update, delete on table public.v2_live_signal_runs to service_role;
grant select, insert, update, delete on table public.v2_live_signals to service_role;
grant select, insert, update, delete on table public.v2_live_universe_snapshots to service_role;
grant select, insert, update, delete on table public.v2_strategy_registry to service_role;

create or replace function public.reject_p10_v10_router_lineage_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception '% is append-only; publish a new V10 router revision', tg_table_name
    using errcode = '55000';
end;
$function$;

drop trigger if exists p10_v10_router_manifests_immutable
  on public.p10_v10_router_manifests;
create trigger p10_v10_router_manifests_immutable
before update or delete on public.p10_v10_router_manifests
for each row execute function public.reject_p10_v10_router_lineage_mutation();

drop trigger if exists p10_v10_router_manifests_no_truncate
  on public.p10_v10_router_manifests;
create trigger p10_v10_router_manifests_no_truncate
before truncate on public.p10_v10_router_manifests
for each statement execute function public.reject_p10_v10_router_lineage_mutation();

drop trigger if exists p10_v10_router_cutover_audit_immutable
  on public.p10_v10_router_cutover_audit;
create trigger p10_v10_router_cutover_audit_immutable
before update or delete on public.p10_v10_router_cutover_audit
for each row execute function public.reject_p10_v10_router_lineage_mutation();

drop trigger if exists p10_v10_router_cutover_audit_no_truncate
  on public.p10_v10_router_cutover_audit;
create trigger p10_v10_router_cutover_audit_no_truncate
before truncate on public.p10_v10_router_cutover_audit
for each statement execute function public.reject_p10_v10_router_lineage_mutation();

alter table public.p10_v10_router_manifests enable row level security;
alter table public.p10_v10_router_cutover_audit enable row level security;
revoke all on table public.p10_v10_router_manifests from public, anon, authenticated;
revoke all on table public.p10_v10_router_cutover_audit from public, anon, authenticated;
revoke all on table public.p10_v10_router_manifests from service_role;
revoke all on table public.p10_v10_router_cutover_audit from service_role;
grant select on table public.p10_v10_router_manifests to service_role;
grant select on table public.p10_v10_router_cutover_audit to service_role;

-- =============================== V10 PATCH BLOCK ===============================
-- Immutable release constants. The implementation digest is SHA-256 over this
-- entire migration after normalizing only its own literal to 64 zeroes.
do $v10_patch_block$
declare
  v_router_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
  v_research_revision constant text :=
    'REGIME_ROUTER_V10_INDEPENDENT_RANGE_BEAR_15M_365D_20260830';
  v_source_sha constant text := 'ca515e391382669fa6c3724f6a3a6e1207d2ad64';
  v_preregistration_sha256 constant text :=
    'eed3db7ad923bc2fa8a3198c88efd8dc31024d55b6b04a9ce7dd709be0605579';
  v_candidate_universe_sha256 constant text :=
    'c0e9519cc36af561adc72b75faa08900f8b7301b6bc72e92023846b14ee5a910';
  v_candidate_registry_revision constant text :=
    'V10-CANDIDATE-LOCK-NO-VALIDATION-EDGE-20260830';
  v_candidate_registry_sha256 constant text :=
    'd7da8d3e6703b2981f174d09e8b900f0753638ee7ed0296111a444455c9a6554';
  v_implementation_sha256 constant text :=
    '06c338e0831517f9ef980adfde3ebc26192696adde848177164239bdc7b0b454';
  v_validation_status constant text := 'REJECTED_NO_ROBUST_EDGE';
  v_promotion_decision constant text := 'BULL_EXISTING_ONLY_NON_BULL_CASH';
  v_expected jsonb;
  v_existing jsonb;
begin
  v_expected := jsonb_build_object(
    'router_revision', v_router_revision,
    'research_revision', v_research_revision,
    'source_sha', v_source_sha,
    'preregistration_sha256', v_preregistration_sha256,
    'candidate_universe_sha256', v_candidate_universe_sha256,
    'candidate_registry_revision', v_candidate_registry_revision,
    'candidate_registry_sha256', v_candidate_registry_sha256,
    'implementation_sha256', v_implementation_sha256,
    'validation_status', v_validation_status,
    'promotion_decision', v_promotion_decision,
    'candidate_lock_timestamp', '2026-08-30 03:41:47.192683+00'::timestamptz,
    'final_test_access_timestamp', null,
    'manifest', jsonb_build_object(
      'bull_signal_families', jsonb_build_array(
        'I46_HYBRID_SCORE_L1@I46-LIVE-1.0.0',
        'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R@P10-LIVE-1.0.0'
      ),
      'execution_strategy_key', 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
      'range_action', 'CASH',
      'bear_action', 'CASH',
      'robust_candidates', '[]'::jsonb,
      'candidate_count', 24,
      'hypothesis_family_count', 12,
      'eligible_candidate_count', 0,
      'candidate_lock_state', 'NO_CANDIDATE_PASSED_LOCK_GATES',
      'test_accessed', false,
      'discovery_report_sha256',
        'b1b0c1c9d376a2e223545ef5c56395d8e960c7272daa4b641bc031c07fada51f',
      'discovery_file_sha256',
        '2b7f0ca3912e7a74f7f0e5356a1c7da0f1807447aa88e608bc2cb79c4ae24146',
      'candidate_lock_file_sha256',
        'f0609617792c25d96aba6688c2b5ed3509d06f582e62b835d5cd6dd450d2e142',
      'runner_file_sha256',
        '7c2659d83c2c4a21485c23b5401488d9c6edf6e4ee9c10fec6a92662296ff4f1',
      'independent_replay_file_sha256',
        'aa5f8d64bdd7380e938a4f536bdd061527b3213a0c9652584e91f717f1820fda',
      'independent_replay_implementation_sha256',
        'cbe35ac38219ecff1251c5217f27b1882a8ce254394cee4813580725e0019a15',
      'independent_replay_eligibility_agreement', '24/24',
      'independent_replay_survivor_count', 0,
      'observer_failure_semantics', 'FAIL_CLOSED',
      'router_error_semantics', 'FAIL_CLOSED',
      'patch_block', 'V10 PATCH BLOCK'
    )
  );

  insert into public.p10_v10_router_manifests (
    router_revision,
    research_revision,
    source_sha,
    preregistration_sha256,
    candidate_universe_sha256,
    candidate_registry_revision,
    candidate_registry_sha256,
    implementation_sha256,
    validation_status,
    promotion_decision,
    candidate_lock_timestamp,
    final_test_access_timestamp,
    manifest
  ) values (
    v_router_revision,
    v_research_revision,
    v_source_sha,
    v_preregistration_sha256,
    v_candidate_universe_sha256,
    v_candidate_registry_revision,
    v_candidate_registry_sha256,
    v_implementation_sha256,
    v_validation_status,
    v_promotion_decision,
    '2026-08-30 03:41:47.192683+00'::timestamptz,
    null,
    v_expected->'manifest'
  )
  on conflict (router_revision) do nothing;

  select to_jsonb(m) - 'recorded_at'
  into strict v_existing
  from public.p10_v10_router_manifests m
  where m.router_revision = v_router_revision;

  if v_existing is distinct from v_expected then
    raise exception 'existing V10 router manifest differs from the immutable PATCH BLOCK'
      using errcode = '55000';
  end if;
end;
$v10_patch_block$;
-- ============================= END V10 PATCH BLOCK =============================

-- Reuse the established append-only registry. This V10 row concerns candidate
-- promotion only; the BULL lane is preserved historical production evidence.
insert into public.p10_regime_router_validations (
  router_revision,
  research_revision,
  research_job_id,
  source_sha,
  implementation_sha256,
  candidate_registry_revision,
  candidate_registry_sha256,
  validation_status,
  validation_metrics
)
select
  m.router_revision,
  m.research_revision,
  null,
  m.source_sha,
  m.implementation_sha256,
  m.candidate_registry_revision,
  m.candidate_registry_sha256,
  m.validation_status,
  jsonb_build_object(
    'preregistration_sha256', m.preregistration_sha256,
    'candidate_universe_sha256', m.candidate_universe_sha256,
    'candidate_lock_timestamp', m.candidate_lock_timestamp,
    'final_test_access_timestamp', m.final_test_access_timestamp,
    'test_accessed', false,
    'test_used_for_selection', false,
    'robust_candidates', '[]'::jsonb,
    'candidate_count', 24,
    'hypothesis_family_count', 12,
    'eligible_candidate_count', 0,
    'discovery_report_sha256', m.manifest->>'discovery_report_sha256',
    'discovery_file_sha256', m.manifest->>'discovery_file_sha256',
    'candidate_lock_file_sha256', m.manifest->>'candidate_lock_file_sha256',
    'runner_file_sha256', m.manifest->>'runner_file_sha256',
    'independent_replay_file_sha256', m.manifest->>'independent_replay_file_sha256',
    'independent_replay_implementation_sha256',
      m.manifest->>'independent_replay_implementation_sha256',
    'independent_replay_eligibility_agreement', '24/24',
    'independent_replay_survivor_count', 0,
    'non_bull_promotion_count', 0,
    'bull_lane_status', 'PRESERVED_EXISTING_I46_P10_EDGE',
    'range_action', 'CASH',
    'bear_action', 'CASH',
    'observer_failure_semantics', 'FAIL_CLOSED',
    'router_error_semantics', 'FAIL_CLOSED',
    'promotion_decision', m.promotion_decision
  )
from public.p10_v10_router_manifests m
where m.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-V10'
on conflict (router_revision) do nothing;

do $validation_assertion$
declare
  v_expected jsonb;
  v_actual jsonb;
begin
  select jsonb_build_object(
    'router_revision', m.router_revision,
    'research_revision', m.research_revision,
    'research_job_id', null,
    'source_sha', m.source_sha,
    'implementation_sha256', m.implementation_sha256,
    'candidate_registry_revision', m.candidate_registry_revision,
    'candidate_registry_sha256', m.candidate_registry_sha256,
    'validation_status', m.validation_status,
    'validation_metrics', jsonb_build_object(
      'preregistration_sha256', m.preregistration_sha256,
      'candidate_universe_sha256', m.candidate_universe_sha256,
      'candidate_lock_timestamp', m.candidate_lock_timestamp,
      'final_test_access_timestamp', m.final_test_access_timestamp,
      'test_accessed', false,
      'test_used_for_selection', false,
      'robust_candidates', '[]'::jsonb,
      'candidate_count', 24,
      'hypothesis_family_count', 12,
      'eligible_candidate_count', 0,
      'discovery_report_sha256', m.manifest->>'discovery_report_sha256',
      'discovery_file_sha256', m.manifest->>'discovery_file_sha256',
      'candidate_lock_file_sha256', m.manifest->>'candidate_lock_file_sha256',
      'runner_file_sha256', m.manifest->>'runner_file_sha256',
      'independent_replay_file_sha256',
        m.manifest->>'independent_replay_file_sha256',
      'independent_replay_implementation_sha256',
        m.manifest->>'independent_replay_implementation_sha256',
      'independent_replay_eligibility_agreement', '24/24',
      'independent_replay_survivor_count', 0,
      'non_bull_promotion_count', 0,
      'bull_lane_status', 'PRESERVED_EXISTING_I46_P10_EDGE',
      'range_action', 'CASH',
      'bear_action', 'CASH',
      'observer_failure_semantics', 'FAIL_CLOSED',
      'router_error_semantics', 'FAIL_CLOSED',
      'promotion_decision', m.promotion_decision
    )
  )
  into strict v_expected
  from public.p10_v10_router_manifests m
  where m.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-V10';

  select to_jsonb(v) - 'id' - 'recorded_at'
  into strict v_actual
  from public.p10_regime_router_validations v
  where v.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-V10';

  if v_actual is distinct from v_expected then
    raise exception 'V10 validation lineage differs from its immutable manifest'
      using errcode = '55000';
  end if;
end;
$validation_assertion$;

insert into public.p10_regime_router_lanes (
  router_revision,
  router_state,
  structural_regime,
  tactical_requirement,
  entry_side,
  entry_strategy_key,
  entry_enabled,
  entry_status,
  entry_policy_key,
  exit_policy_key,
  profit_protection_key,
  risk_guard_key,
  validation_basis
) values
  (
    'P10-PRODUCTION-REGIME-ROUTER-V10',
    'BULL_TREND',
    'BULL_OR_STRONG_BULL',
    'FULL_MARKET_OBSERVER_ACCELERATING_OR_IMPULSE_CONTINUATION',
    'LONG',
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    true,
    'ENABLED_EXISTING_EDGE',
    'I46_BINANCE_OR_P10_UPBIT_LONG_LINEAGE_V10',
    'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY',
    'P10_TARGETS_TRAILING_AND_STOP_PRIORITY',
    'V10_OBSERVER_FAIL_CLOSED_AND_EXISTING_ORDER_CIRCUIT_GUARDS',
    'PRESERVE_PROVEN_EXISTING_I46_P10_BULL_LONG_EDGE'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-V10',
    'BULL_DECELERATING',
    'BULL_OR_STRONG_BULL',
    'FULL_MARKET_OBSERVER_NON_ACCELERATING_BULL_PHASE',
    'LONG',
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    true,
    'ENABLED_EXISTING_EDGE',
    'I46_BINANCE_OR_P10_UPBIT_LONG_LINEAGE_V10',
    'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY',
    'P10_TARGETS_TRAILING_AND_STOP_PRIORITY',
    'V10_OBSERVER_FAIL_CLOSED_AND_EXISTING_ORDER_CIRCUIT_GUARDS',
    'PRESERVE_PROVEN_EXISTING_I46_P10_BULL_LONG_EDGE'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-V10',
    'RANGE_UP_CYCLE',
    'RANGE',
    'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
    null,
    null,
    false,
    'NO_ENTRY_CANDIDATE',
    'NO_TRADE_CASH',
    'NOT_APPLICABLE_CASH',
    'NOT_APPLICABLE_CASH',
    'EXISTING_CIRCUIT_GUARDS',
    'V10_HAS_NO_LOCKED_PRODUCTION_RANGE_EDGE'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-V10',
    'BEAR_REBOUND',
    'BEAR',
    'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
    null,
    null,
    false,
    'NO_ENTRY_CANDIDATE',
    'NO_TRADE_CASH',
    'NOT_APPLICABLE_CASH',
    'NOT_APPLICABLE_CASH',
    'EXISTING_CIRCUIT_GUARDS',
    'V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBOUND_EDGE'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-V10',
    'BEAR_REBREAK',
    'BEAR',
    'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
    null,
    null,
    false,
    'NO_ENTRY_CANDIDATE',
    'NO_TRADE_CASH',
    'NOT_APPLICABLE_CASH',
    'NOT_APPLICABLE_CASH',
    'EXISTING_CIRCUIT_GUARDS',
    'V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBREAK_EDGE'
  )
on conflict (router_revision, router_state) do nothing;

-- Exact row comparison prevents ON CONFLICT from hiding a drifted lane definition.
do $lane_registry_assertion$
declare
  v_expected jsonb;
  v_actual jsonb;
begin
  select jsonb_agg(to_jsonb(x) order by x.router_state)
  into v_expected
  from (
    values
      (
        'P10-PRODUCTION-REGIME-ROUTER-V10'::text,
        'BULL_TREND'::text,
        'BULL_OR_STRONG_BULL'::text,
        'FULL_MARKET_OBSERVER_ACCELERATING_OR_IMPULSE_CONTINUATION'::text,
        'LONG'::text,
        'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'::text,
        true,
        'ENABLED_EXISTING_EDGE'::text,
        'I46_BINANCE_OR_P10_UPBIT_LONG_LINEAGE_V10'::text,
        'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY'::text,
        'P10_TARGETS_TRAILING_AND_STOP_PRIORITY'::text,
        'V10_OBSERVER_FAIL_CLOSED_AND_EXISTING_ORDER_CIRCUIT_GUARDS'::text,
        'PRESERVE_PROVEN_EXISTING_I46_P10_BULL_LONG_EDGE'::text
      ),
      (
        'P10-PRODUCTION-REGIME-ROUTER-V10',
        'BULL_DECELERATING',
        'BULL_OR_STRONG_BULL',
        'FULL_MARKET_OBSERVER_NON_ACCELERATING_BULL_PHASE',
        'LONG',
        'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
        true,
        'ENABLED_EXISTING_EDGE',
        'I46_BINANCE_OR_P10_UPBIT_LONG_LINEAGE_V10',
        'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY',
        'P10_TARGETS_TRAILING_AND_STOP_PRIORITY',
        'V10_OBSERVER_FAIL_CLOSED_AND_EXISTING_ORDER_CIRCUIT_GUARDS',
        'PRESERVE_PROVEN_EXISTING_I46_P10_BULL_LONG_EDGE'
      ),
      (
        'P10-PRODUCTION-REGIME-ROUTER-V10',
        'RANGE_UP_CYCLE',
        'RANGE',
        'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
        null,
        null,
        false,
        'NO_ENTRY_CANDIDATE',
        'NO_TRADE_CASH',
        'NOT_APPLICABLE_CASH',
        'NOT_APPLICABLE_CASH',
        'EXISTING_CIRCUIT_GUARDS',
        'V10_HAS_NO_LOCKED_PRODUCTION_RANGE_EDGE'
      ),
      (
        'P10-PRODUCTION-REGIME-ROUTER-V10',
        'BEAR_REBOUND',
        'BEAR',
        'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
        null,
        null,
        false,
        'NO_ENTRY_CANDIDATE',
        'NO_TRADE_CASH',
        'NOT_APPLICABLE_CASH',
        'NOT_APPLICABLE_CASH',
        'EXISTING_CIRCUIT_GUARDS',
        'V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBOUND_EDGE'
      ),
      (
        'P10-PRODUCTION-REGIME-ROUTER-V10',
        'BEAR_REBREAK',
        'BEAR',
        'REQUIRES_NEW_IMMUTABLE_CANDIDATE_LOCK_AND_CAUSAL_TACTICAL_EVIDENCE',
        null,
        null,
        false,
        'NO_ENTRY_CANDIDATE',
        'NO_TRADE_CASH',
        'NOT_APPLICABLE_CASH',
        'NOT_APPLICABLE_CASH',
        'EXISTING_CIRCUIT_GUARDS',
        'V10_HAS_NO_LOCKED_PRODUCTION_BEAR_REBREAK_EDGE'
      )
  ) as x(
    router_revision,
    router_state,
    structural_regime,
    tactical_requirement,
    entry_side,
    entry_strategy_key,
    entry_enabled,
    entry_status,
    entry_policy_key,
    exit_policy_key,
    profit_protection_key,
    risk_guard_key,
    validation_basis
  );

  select jsonb_agg(
    to_jsonb(l) - 'id' - 'recorded_at'
    order by l.router_state
  )
  into v_actual
  from public.p10_regime_router_lanes l
  where l.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-V10';

  if v_actual is distinct from v_expected then
    raise exception 'V10 lane registry differs from the immutable five-lane definition'
      using errcode = '55000';
  end if;
end;
$lane_registry_assertion$;

create or replace function public.validate_p10_v10_bull_signal_lineage(
  p_venue text,
  p_side text,
  p_evidence jsonb
) returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_venue text := lower(coalesce(p_venue, ''));
  v_side text := upper(coalesce(p_side, ''));
  v_signal jsonb := coalesce(p_evidence->'evidence', '{}'::jsonb);
  v_strategy text;
  v_revision text;
  v_execution_key text;
  v_valid boolean := false;
  v_reason text := 'SIGNAL_LINEAGE_UNAVAILABLE';
begin
  v_strategy := coalesce(v_signal->>'entry_strategy_key', '');
  v_revision := coalesce(
    v_signal->>'entry_strategy_revision',
    v_signal->>'revision',
    ''
  );
  v_execution_key := coalesce(v_signal->>'execution_config_key', '');

  if v_side <> 'LONG' then
    v_reason := 'V10_BULL_LINEAGE_REQUIRES_LONG';
  elsif v_execution_key <> 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    v_reason := 'V10_EXECUTION_CONFIG_MISMATCH';
  elsif v_venue in ('binance_spot', 'binance_futures')
        and v_strategy = 'I46_HYBRID_SCORE_L1'
        and v_revision = 'I46-LIVE-1.0.0' then
    v_valid := true;
    v_reason := 'VALIDATED_EXISTING_I46_BINANCE_LONG_LINEAGE';
  elsif v_venue = 'upbit_spot'
        and v_strategy = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
        and v_revision = 'P10-LIVE-1.0.0' then
    v_valid := true;
    v_reason := 'VALIDATED_EXISTING_P10_UPBIT_LONG_LINEAGE';
  else
    v_reason := 'UNRECOGNIZED_V10_BULL_SIGNAL_LINEAGE';
  end if;

  return jsonb_build_object(
    'valid', v_valid,
    'reason', v_reason,
    'venue', v_venue,
    'side', v_side,
    'entry_strategy_key', nullif(v_strategy, ''),
    'entry_strategy_revision', nullif(v_revision, ''),
    'execution_config_key', nullif(v_execution_key, '')
  );
end;
$function$;

create or replace function public.validate_p10_v10_persisted_signal(
  p_venue text,
  p_market text,
  p_side text,
  p_signal_time timestamptz,
  p_evidence jsonb,
  p_at timestamptz
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_venue text := lower(coalesce(p_venue, ''));
  v_side text := upper(coalesce(p_side, ''));
  v_run_id text := coalesce(p_evidence->>'run_id', '');
  v_expected_revision text;
  v_expected_entry_key text;
  v_verified boolean := false;
  v_reason text := 'PERSISTED_SIGNAL_ATTESTATION_FAILED';
begin
  v_expected_revision := case
    when v_venue = 'upbit_spot' then 'P10-LIVE-1.0.0'
    when v_venue in ('binance_spot', 'binance_futures') then 'I46-LIVE-1.0.0'
    else null
  end;
  v_expected_entry_key := case
    when v_venue = 'upbit_spot' then 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
    when v_venue in ('binance_spot', 'binance_futures') then 'I46_HYBRID_SCORE_L1'
    else null
  end;

  if v_run_id = '' or p_market is null or v_side <> 'LONG'
     or v_expected_revision is null or v_expected_entry_key is null then
    v_reason := 'PERSISTED_SIGNAL_IDENTITY_INCOMPLETE';
  elsif p_signal_time is null or p_at is null
        or p_at < p_signal_time + interval '1 hour'
        or p_at > p_signal_time + interval '80 minutes' then
    v_reason := 'PERSISTED_SIGNAL_OUTSIDE_CAUSAL_ENTRY_WINDOW';
  else
    begin
      execute $query$
        select count(*) = 1
        from public.v2_live_signals s
        join public.v2_live_signal_runs r on r.id = s.run_id
        where s.run_id::text = $1
          and lower(s.venue) = $2
          and s.market = $3
          and upper(s.side) = $4
          and s.signal_time = $5
          and s.config_key = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
          and s.scenario_number = case when $2 = 'upbit_spot' then 10 else 46 end
          and s.family = case when $2 = 'upbit_spot' then 'DONCHIAN_BREAKOUT' else 'HYBRID_SCORE' end
          and s.max_hold_bars = 96
          and s.created_at <= $9
          and s.evidence = $6->'evidence'
          and s.evidence->>'revision' = $7
          and s.evidence->>'entry_strategy_key' = $8
          and s.evidence->>'execution_config_key' =
            'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
          and lower(r.venue) = $2
          and r.revision = $7
          and r.mode = 'LIVE_LIMITED'
          and r.status = 'COMPLETED'
          and r.completed_at is not null
          and r.completed_at <= $9
          and r.metadata->>'strategy_key' = $8
          and r.metadata->>'execution_config_key' =
            'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
          and r.metadata->>'revision' = $7
      $query$
      into v_verified
      using
        v_run_id,
        v_venue,
        p_market,
        v_side,
        p_signal_time,
        coalesce(p_evidence, '{}'::jsonb),
        v_expected_revision,
        v_expected_entry_key,
        p_at;

      v_reason := case
        when v_verified then 'EXACT_PERSISTED_LIVE_SIGNAL_AND_RUN_ATTESTED'
        else 'PERSISTED_SIGNAL_OR_RUN_MISMATCH'
      end;
    exception when others then
      v_verified := false;
      v_reason := 'PERSISTED_SIGNAL_ATTESTATION_UNAVAILABLE_FAIL_CLOSED';
    end;
  end if;

  return jsonb_build_object(
    'verified', v_verified,
    'reason', v_reason,
    'run_id', nullif(v_run_id, ''),
    'venue', v_venue,
    'market', p_market,
    'side', v_side,
    'signal_time', p_signal_time,
    'evaluated_at', p_at,
    'expected_revision', v_expected_revision,
    'expected_entry_strategy_key', v_expected_entry_key,
    'fail_closed', true
  );
end;
$function$;

create or replace function public.evaluate_p10_entry_regime_v10(
  p_side text,
  p_at timestamptz
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_obs public.market_regime_observations%rowtype;
  v_side text := upper(coalesce(p_side, ''));
  v_at timestamptz := coalesce(p_at, statement_timestamp());
  v_phase text := 'UNKNOWN';
  v_recommendation text := 'BLOCK';
  v_reason text := 'OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED';
  v_observer_ready boolean := false;
begin
  select o.*
  into v_obs
  from public.market_regime_observations o
  where o.model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'
    and o.observed_at <= v_at
    and o.observed_at >= v_at - interval '12 minutes'
    and o.confidence >= 0.60
    and o.sample_size >= 240
    and o.features->>'source' = 'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE'
    and case
      when o.features->'breadth_30m'->'binance_spot'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'binance_spot'->>'sample_size')::numeric
      else 0
    end >= 80
    and case
      when o.features->'breadth_30m'->'binance_futures'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'binance_futures'->>'sample_size')::numeric
      else 0
    end >= 80
    and case
      when o.features->'breadth_30m'->'upbit_spot'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'upbit_spot'->>'sample_size')::numeric
      else 0
    end >= 40
    and o.predicted_regime in ('RISK_OFF', 'NEUTRAL', 'BULL', 'STRONG_BULL')
  order by o.observed_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'policy_revision', 'P10-ENTRY-REGIME-GATE-V10',
      'model_revision', 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET',
      'evaluated_at', v_at,
      'side', v_side,
      'recommendation', 'BLOCK',
      'reason', 'OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED',
      'observer_ready', false,
      'live_gate_candidate', false,
      'fail_closed', true
    );
  end if;

  v_phase := coalesce(v_obs.features->'momentum_phase'->>'phase', 'UNKNOWN');
  v_observer_ready := coalesce(v_obs.trading_influence, false);

  if not v_observer_ready then
    v_reason := 'OBSERVER_NOT_LIVE_FOR_TRADING_FAIL_CLOSED';
  elsif v_side = 'LONG' and v_obs.predicted_regime in ('BULL', 'STRONG_BULL') then
    v_recommendation := 'ALLOW';
    v_reason := 'LONG_STRUCTURAL_BULL';
  elsif v_side = 'LONG' and v_obs.predicted_regime = 'NEUTRAL' then
    v_reason := 'RANGE_NO_TRADE';
  elsif v_side = 'LONG' and v_obs.predicted_regime = 'RISK_OFF' then
    v_reason := 'BEAR_NO_TRADE';
  elsif v_side = 'SHORT' then
    v_reason := 'SHORT_DISABLED_NO_LOCKED_V10_EDGE';
  else
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  end if;

  return jsonb_build_object(
    'policy_revision', 'P10-ENTRY-REGIME-GATE-V10',
    'model_revision', v_obs.model_revision,
    'evaluated_at', v_at,
    'side', v_side,
    'observation_id', v_obs.id,
    'observed_at', v_obs.observed_at,
    'regime', v_obs.predicted_regime,
    'phase', v_phase,
    'bull_score', v_obs.bull_score,
    'confidence', v_obs.confidence,
    'sample_size', v_obs.sample_size,
    'observation_trading_influence', v_obs.trading_influence,
    'observer_ready', v_observer_ready,
    'live_gate_candidate', v_observer_ready,
    'recommendation', v_recommendation,
    'reason', v_reason,
    'fail_closed', true,
    'observation_age_seconds', extract(epoch from (v_at - v_obs.observed_at))
  );
end;
$function$;

create or replace function public.resolve_p10_production_regime_route_v10(
  p_venue text,
  p_market text,
  p_side text,
  p_signal_time timestamptz,
  p_evidence jsonb,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
  v_gate jsonb;
  v_lineage jsonb;
  v_persisted_signal jsonb;
  v_lane jsonb := '{}'::jsonb;
  v_validation jsonb := '{}'::jsonb;
  v_manifest jsonb := '{}'::jsonb;
  v_side text := upper(coalesce(p_side, ''));
  v_regime text := 'UNKNOWN';
  v_phase text := 'UNKNOWN';
  v_state text := 'NO_TRADE';
  v_candidate_state text := 'NO_TRADE';
  v_strategy text := null;
  v_action text := 'BLOCK';
  v_reason text := 'V10_ROUTER_UNAVAILABLE_FAIL_CLOSED';
  v_observer_ready boolean := false;
  v_state_verified boolean := false;
  v_structural_verified boolean := false;
  v_tactical_evidence text := 'UNAVAILABLE';
  v_registry_ready boolean := false;
  v_lane_count integer := 0;
  v_enabled_count integer := 0;
begin
  v_gate := public.evaluate_p10_entry_regime_v10(v_side, p_at);
  v_lineage := public.validate_p10_v10_bull_signal_lineage(
    p_venue,
    v_side,
    coalesce(p_evidence, '{}'::jsonb)
  );
  v_persisted_signal := public.validate_p10_v10_persisted_signal(
    p_venue,
    p_market,
    v_side,
    p_signal_time,
    coalesce(p_evidence, '{}'::jsonb),
    p_at
  );
  v_regime := upper(coalesce(v_gate->>'regime', 'UNKNOWN'));
  v_phase := upper(coalesce(v_gate->>'phase', 'UNKNOWN'));
  v_observer_ready := coalesce((v_gate->>'observer_ready')::boolean, false);
  v_structural_verified := nullif(v_gate->>'observation_id', '') is not null;

  select to_jsonb(m) - 'recorded_at'
  into v_manifest
  from public.p10_v10_router_manifests m
  where m.router_revision = v_revision
    and m.promotion_decision = 'BULL_EXISTING_ONLY_NON_BULL_CASH';

  select to_jsonb(v) - 'id' - 'recorded_at'
  into v_validation
  from public.p10_regime_router_validations v
  where v.router_revision = v_revision;

  select count(*), count(*) filter (where l.entry_enabled)
  into v_lane_count, v_enabled_count
  from public.p10_regime_router_lanes l
  where l.router_revision = v_revision;

  v_registry_ready := coalesce(v_manifest, '{}'::jsonb) <> '{}'::jsonb
    and coalesce(v_validation, '{}'::jsonb) <> '{}'::jsonb
    and v_lane_count = 5
    and v_enabled_count = 2
    and exists (
      select 1
      from public.p10_v10_router_cutover_audit a
      where a.router_revision = v_revision
        and a.claim_policy_revision = v_revision
        and a.legacy_resolver_execute_revoked
        and a.suspension_backstop_preserved
    )
    and not exists (
      select 1
      from public.p10_regime_router_lanes l
      where l.router_revision = v_revision
        and l.router_state in ('RANGE_UP_CYCLE', 'BEAR_REBOUND', 'BEAR_REBREAK')
        and l.entry_enabled
    );

  if v_regime in ('BULL', 'STRONG_BULL') then
    v_state := case
      when v_phase in ('ACCELERATING', 'IMPULSE_CONTINUATION') then 'BULL_TREND'
      else 'BULL_DECELERATING'
    end;
    v_candidate_state := v_state;
    v_state_verified := v_observer_ready;
    v_tactical_evidence := 'CAUSAL_FULL_MARKET_OBSERVER_BULL_PHASE';
  elsif v_regime = 'NEUTRAL' then
    v_candidate_state := 'RANGE_UP_CYCLE';
    v_tactical_evidence := 'NO_LOCKED_RANGE_TACTICAL_MODEL';
  elsif v_regime = 'RISK_OFF' then
    v_candidate_state := case
      when v_phase in ('CAPITULATION_REBOUND', 'DEEP_DROP_REBOUND', 'REBOUND_CONFIRMED')
        then 'BEAR_REBOUND'
      else 'BEAR_REBREAK'
    end;
    v_tactical_evidence := 'NO_LOCKED_BEAR_TACTICAL_MODEL';
  end if;

  if v_state in ('BULL_TREND', 'BULL_DECELERATING') then
    select to_jsonb(l) - 'id' - 'recorded_at'
    into v_lane
    from public.p10_regime_router_lanes l
    where l.router_revision = v_revision
      and l.router_state = v_state;
  end if;

  if v_side not in ('LONG', 'SHORT') then
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  elsif not v_registry_ready then
    v_reason := 'V10_REGISTRY_OR_WIRING_INTEGRITY_FAIL_CLOSED';
  elsif not v_structural_verified then
    v_reason := 'OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED';
  elsif not v_observer_ready then
    v_reason := 'OBSERVER_NOT_LIVE_FOR_TRADING_FAIL_CLOSED';
  elsif v_side = 'SHORT' then
    v_reason := 'SHORT_DISABLED_NO_LOCKED_V10_EDGE';
  elsif v_regime = 'NEUTRAL' then
    v_reason := 'RANGE_NO_TRADE_NO_LOCKED_V10_EDGE';
  elsif v_regime = 'RISK_OFF' then
    v_reason := 'BEAR_NO_TRADE_NO_LOCKED_V10_EDGE';
  elsif v_regime not in ('BULL', 'STRONG_BULL') then
    v_reason := 'NON_BULL_NO_TRADE';
  elsif not coalesce((v_lineage->>'valid')::boolean, false) then
    v_reason := coalesce(v_lineage->>'reason', 'V10_BULL_SIGNAL_LINEAGE_FAIL_CLOSED');
  elsif not coalesce((v_persisted_signal->>'verified')::boolean, false) then
    v_reason := coalesce(
      v_persisted_signal->>'reason',
      'V10_PERSISTED_SIGNAL_ATTESTATION_FAIL_CLOSED'
    );
  elsif coalesce((v_lane->>'entry_enabled')::boolean, false)
        and v_lane->>'entry_side' = 'LONG'
        and v_lane->>'entry_strategy_key' = 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R' then
    v_action := 'PASS';
    v_strategy := 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R';
    v_reason := 'VALIDATED_EXISTING_I46_P10_BULL_LONG_EDGE';
  else
    v_reason := 'V10_BULL_LANE_REGISTRY_MISMATCH_FAIL_CLOSED';
  end if;

  return jsonb_build_object(
    'policy_revision', v_revision,
    'claim_wiring_revision', v_revision,
    'evaluated_at', p_at,
    'venue', p_venue,
    'market', p_market,
    'signal_time', p_signal_time,
    'side', v_side,
    'structural_regime', v_regime,
    'observer_phase', v_phase,
    'regime', v_regime,
    'phase', v_phase,
    'state', v_state,
    'candidate_state', v_candidate_state,
    'structural_verified', v_structural_verified,
    'state_verified', v_state_verified,
    'tactical_evidence', v_tactical_evidence,
    'action', v_action,
    'strategy_key', v_strategy,
    'reason', v_reason,
    'observer_ready', v_observer_ready,
    'registry_ready', v_registry_ready,
    'lane', coalesce(v_lane, '{}'::jsonb),
    'validation', coalesce(v_validation, '{}'::jsonb),
    'manifest', coalesce(v_manifest, '{}'::jsonb),
    'signal_lineage', coalesce(v_lineage, '{}'::jsonb),
    'persisted_signal_attestation', coalesce(v_persisted_signal, '{}'::jsonb),
    'gate', coalesce(v_gate, '{}'::jsonb),
    'fail_closed', true
  );
end;
$function$;

-- Compatibility/diagnostic wrapper. It intentionally cannot authorize an entry because
-- it has no venue or immutable producer lineage; the real claim path supplies both.
create or replace function public.resolve_p10_production_regime_route(
  p_side text,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select public.resolve_p10_production_regime_route_v10(
    null,
    null,
    p_side,
    p_at,
    '{}'::jsonb,
    p_at
  );
$function$;

create or replace function public.claim_p10_signal(
  p_venue text,
  p_market text,
  p_signal_time timestamptz,
  p_side text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim public.p10_signal_claims%rowtype;
  v_route jsonb := '{}'::jsonb;
  v_gate jsonb := '{}'::jsonb;
  v_decision text := 'BLOCK';
  v_reason text := 'V10_ROUTER_UNAVAILABLE_FAIL_CLOSED';
  v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
begin
  begin
    v_route := public.resolve_p10_production_regime_route_v10(
      p_venue,
      p_market,
      upper(p_side),
      p_signal_time,
      coalesce(p_evidence, '{}'::jsonb),
      clock_timestamp()
    );
    v_gate := coalesce(v_route->'gate', '{}'::jsonb);
    v_decision := upper(coalesce(v_route->>'action', 'BLOCK'));
    v_reason := coalesce(v_route->>'reason', 'V10_ROUTER_UNAVAILABLE_FAIL_CLOSED');

    if v_decision = 'PASS'
       and (
         v_route->>'policy_revision' is distinct from v_policy_revision
         or v_route->>'claim_wiring_revision' is distinct from v_policy_revision
         or v_route->>'strategy_key' is distinct from
           'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
       ) then
      v_decision := 'BLOCK';
      v_reason := 'V10_ROUTE_CONTRACT_MISMATCH_FAIL_CLOSED';
      v_route := v_route || jsonb_build_object(
        'action', v_decision,
        'reason', v_reason,
        'strategy_key', null
      );
    end if;
  exception when others then
    v_decision := 'BLOCK';
    v_reason := 'V10_ROUTER_ERROR_FAIL_CLOSED';
    v_route := jsonb_build_object(
      'policy_revision', v_policy_revision,
      'claim_wiring_revision', v_policy_revision,
      'error', left(sqlerrm, 240),
      'action', v_decision,
      'reason', v_reason,
      'fail_closed', true
    );
    v_gate := '{}'::jsonb;
  end;

  insert into public.p10_entry_regime_gate_attempts (
    venue,
    market,
    signal_time,
    side,
    observation_id,
    observed_at,
    regime,
    phase,
    bull_score,
    confidence,
    sample_size,
    decision,
    reason,
    policy_revision,
    audit
  ) values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
    nullif(v_gate->>'observation_id', ''),
    case
      when coalesce(v_gate->>'observed_at', '') <> ''
        then (v_gate->>'observed_at')::timestamptz
      else null
    end,
    nullif(v_route->>'regime', ''),
    nullif(v_route->>'phase', ''),
    nullif(v_gate->>'bull_score', '')::numeric,
    nullif(v_gate->>'confidence', '')::numeric,
    nullif(v_gate->>'sample_size', '')::integer,
    v_decision,
    v_reason,
    v_policy_revision,
    jsonb_build_object(
      'route', coalesce(v_route, '{}'::jsonb),
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    )
  )
  on conflict (venue, market, signal_time, side, policy_revision)
  do update set
    last_attempt_at = clock_timestamp(),
    attempt_count = public.p10_entry_regime_gate_attempts.attempt_count + 1,
    observation_id = excluded.observation_id,
    observed_at = excluded.observed_at,
    regime = excluded.regime,
    phase = excluded.phase,
    bull_score = excluded.bull_score,
    confidence = excluded.confidence,
    sample_size = excluded.sample_size,
    decision = excluded.decision,
    reason = excluded.reason,
    audit = excluded.audit;

  -- Anything other than exact PASS is a block. Unknown future action strings cannot claim.
  if v_decision <> 'PASS' then
    return jsonb_build_object(
      'claimed', false,
      'blocked', true,
      'reason', v_reason,
      'regime_route', v_route,
      'claim', null
    );
  end if;

  insert into public.p10_signal_claims (
    venue,
    market,
    signal_time,
    side,
    strategy_key,
    evidence
  ) values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('regime_route', v_route)
  )
  on conflict (venue, market, signal_time, side) do nothing
  returning * into v_claim;

  if not found then
    select *
    into v_claim
    from public.p10_signal_claims
    where venue = p_venue
      and market = p_market
      and signal_time = p_signal_time
      and side = upper(p_side);

    return jsonb_build_object(
      'claimed', false,
      'blocked', false,
      'reason', 'P10_SIGNAL_ALREADY_CLAIMED',
      'regime_route', v_route,
      'claim', to_jsonb(v_claim)
    );
  end if;

  return jsonb_build_object(
    'claimed', true,
    'blocked', false,
    'reason', v_reason,
    'regime_route', v_route,
    'claim', to_jsonb(v_claim)
  );
end;
$function$;

revoke execute on function public.reject_p10_v10_router_lineage_mutation()
  from public, anon, authenticated;
revoke execute on function public.validate_p10_v10_bull_signal_lineage(text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.validate_p10_v10_persisted_signal(
  text, text, text, timestamptz, jsonb, timestamptz
) from public, anon, authenticated;
revoke execute on function public.evaluate_p10_entry_regime_v10(text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.resolve_p10_production_regime_route_v10(
  text, text, text, timestamptz, jsonb, timestamptz
) from public, anon, authenticated;
revoke execute on function public.resolve_p10_production_regime_route(text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.evaluate_p10_entry_regime_v10(text, timestamptz)
  to service_role;
grant execute on function public.resolve_p10_production_regime_route_v10(
  text, text, text, timestamptz, jsonb, timestamptz
) to service_role;
grant execute on function public.resolve_p10_production_regime_route(text, timestamptz)
  to service_role;
grant execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb)
  to service_role;

-- Remove direct app access to every versioned legacy resolver. Historical functions stay
-- in place for audit/replay, but only the V10 resolver and compatibility wrapper are callable.
do $legacy_resolver_acl$
declare
  v_proc regprocedure;
begin
  for v_proc in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and left(p.proname, length('resolve_p10_production_regime_route_v')) =
        'resolve_p10_production_regime_route_v'
      and p.oid <>
        'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      v_proc
    );
  end loop;
end;
$legacy_resolver_acl$;

-- One-time production cutover and immutable hash audit.
--
-- p10_entry_suspension was an out-of-band emergency backstop and is canonicalized above.
-- On first V10 application only, clear the specifically allowlisted
-- research-wide suspension that accidentally disabled the existing BULL edge. Keep its
-- trigger and guard intact so service_role can still activate an emergency stop later.
-- Re-running this migration never clears a subsequent operator/emergency suspension.
do $v10_cutover$
declare
  v_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
  v_expected_old_reason constant text :=
    'BULL lane failed the same V5 promotion criteria that rejected RANGE/BEAR (v_p10_lane_revalidation); regime gate edge negative at every horizon (v_regime_gate_edge). 2026-08-30.';
  v_expected_old_suspended_at constant timestamptz :=
    '2026-08-30 02:29:10.746581+00'::timestamptz;
  v_neutralized_reason constant text :=
    'V10_BULL_I46_P10_RESTORED_NON_BULL_CASH_OBSERVER_FAIL_CLOSED_20260830';
  v_manifest public.p10_v10_router_manifests%rowtype;
  v_existing public.p10_v10_router_cutover_audit%rowtype;
  v_first_cutover boolean;
  v_table_found boolean;
  v_trigger_found boolean;
  v_trigger_guard_name text;
  v_trigger_guard_definition text;
  v_previous_state boolean;
  v_previous_reason text;
  v_previous_at timestamptz;
  v_row_found boolean := false;
  v_row_count integer := 0;
  v_cas_count integer := 0;
  v_neutralized boolean := true;
  v_did_neutralize boolean := false;
  v_resolver_md5 text;
  v_producer_verifier_md5 text;
  v_wrapper_md5 text;
  v_claim_md5 text;
  v_legacy_revoked boolean;
  v_expected_audit jsonb;
begin
  select *
  into strict v_manifest
  from public.p10_v10_router_manifests
  where router_revision = v_revision;

  perform pg_advisory_xact_lock(
    hashtextextended('P10_ENTRY_SUSPENSION_V10', 0)
  );

  v_first_cutover := not exists (
    select 1
    from public.p10_v10_router_cutover_audit
    where router_revision = v_revision
  );
  v_table_found := to_regclass('public.p10_entry_suspension') is not null;

  select exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = to_regclass('public.trading_orders')
      and t.tgname = 'aaa0_trading_orders_entry_suspension_v810'
      and not t.tgisinternal
      and t.tgtype = 23 -- ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16)
      and t.tgenabled in ('O', 'A')
      and t.tgqual is null
  )
  into v_trigger_found;

  select p.proname, pg_get_functiondef(p.oid)
  into v_trigger_guard_name, v_trigger_guard_definition
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where t.tgrelid = to_regclass('public.trading_orders')
    and t.tgname = 'aaa0_trading_orders_entry_suspension_v810'
    and not t.tgisinternal
    and t.tgenabled in ('O', 'A')
    and n.nspname = 'public';

  if v_table_found then
    if not v_trigger_found
       or v_trigger_guard_name is distinct from 'guard_p10_entry_suspension_v810'
       or position('P10_ENTRY_SUSPENDED_20260830' in coalesce(v_trigger_guard_definition, '')) = 0
       or position('position_effect' in coalesce(v_trigger_guard_definition, '')) = 0
       or position('p10_entry_suspension' in coalesce(v_trigger_guard_definition, '')) = 0 then
      raise exception 'V10 requires the p10_entry_suspension emergency trigger backstop'
        using errcode = '55000';
    end if;

    select s.suspended, s.reason, s.suspended_at
    into v_previous_state, v_previous_reason, v_previous_at
    from public.p10_entry_suspension s
    where s.id = 1
    for update;
    v_row_found := found;
    v_row_count := case when v_row_found then 1 else 0 end;

    if v_first_cutover then
      if v_row_found
         and coalesce(v_previous_state, false)
         and (
           v_previous_reason is distinct from v_expected_old_reason
           or v_previous_at is distinct from v_expected_old_suspended_at
         ) then
        raise exception 'refusing to clear non-allowlisted p10 entry suspension: reason=%, suspended_at=%',
          coalesce(v_previous_reason, '<NULL>'),
          coalesce(v_previous_at::text, '<NULL>')
          using errcode = '55000';
      end if;

      if not v_row_found then
        execute $sql$
          insert into public.p10_entry_suspension (id, suspended, reason, suspended_at)
          values (1, false, $1, clock_timestamp())
        $sql$
        using v_neutralized_reason;
      elsif coalesce(v_previous_state, false) then
        update public.p10_entry_suspension
        set suspended = false,
            reason = v_neutralized_reason,
            suspended_at = clock_timestamp()
        where id = 1
          and suspended
          and reason is not distinct from v_previous_reason
          and suspended_at is not distinct from v_previous_at;
        get diagnostics v_cas_count = row_count;
        if v_cas_count <> 1 then
          raise exception 'P10 entry suspension changed during V10 cutover'
            using errcode = '40001';
        end if;
        v_did_neutralize := true;
      end if;

      execute 'select not suspended from public.p10_entry_suspension where id = 1'
      into v_neutralized;
      if coalesce(v_neutralized, false) is false then
        raise exception 'V10 failed to neutralize the allowlisted global entry suspension'
          using errcode = '55000';
      end if;
    end if;
  end if;

  select md5(pg_get_functiondef(
    'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
  )) into v_resolver_md5;
  select md5(pg_get_functiondef(
    'public.validate_p10_v10_persisted_signal(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
  )) into v_producer_verifier_md5;
  select md5(pg_get_functiondef(
    'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure
  )) into v_wrapper_md5;
  select md5(pg_get_functiondef(
    'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
  )) into v_claim_md5;

  select not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and left(p.proname, length('resolve_p10_production_regime_route_v')) =
        'resolve_p10_production_regime_route_v'
      and p.oid <>
        'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) into v_legacy_revoked;

  if not v_legacy_revoked then
    raise exception 'legacy versioned P10 resolver remains executable by service_role'
      using errcode = '55000';
  end if;

  v_expected_audit := jsonb_build_object(
    'suspension_one_time_only', true,
    'suspension_allowlisted_reason', v_expected_old_reason,
    'suspension_allowlisted_at', v_expected_old_suspended_at,
    'suspension_replacement_reason', v_neutralized_reason,
    'suspension_trigger_action', 'PRESERVED',
    'claim_calls', 'resolve_p10_production_regime_route_v10',
    'compatibility_wrapper_calls', 'resolve_p10_production_regime_route_v10',
    'legacy_resolver_execute', 'REVOKED',
    'observer_failure_semantics', 'FAIL_CLOSED',
    'router_error_semantics', 'FAIL_CLOSED'
  );

  insert into public.p10_v10_router_cutover_audit (
    router_revision,
    claim_policy_revision,
    source_sha,
    implementation_sha256,
    candidate_registry_sha256,
    resolver_definition_md5,
    producer_verifier_definition_md5,
    wrapper_definition_md5,
    claim_definition_md5,
    legacy_resolver_execute_revoked,
    suspension_table_found,
    suspension_previous_state,
    suspension_previous_reason,
    suspension_previous_at,
    suspension_trigger_found,
    suspension_backstop_preserved,
    suspension_neutralized_at,
    cutover_action,
    audit
  ) values (
    v_revision,
    v_revision,
    v_manifest.source_sha,
    v_manifest.implementation_sha256,
    v_manifest.candidate_registry_sha256,
    v_resolver_md5,
    v_producer_verifier_md5,
    v_wrapper_md5,
    v_claim_md5,
    v_legacy_revoked,
    v_table_found,
    v_previous_state,
    v_previous_reason,
    v_previous_at,
    v_trigger_found,
    v_table_found and v_trigger_found,
    case when v_did_neutralize then clock_timestamp() else null end,
    'RESTORE_EXISTING_BULL_FAIL_CLOSED_NON_BULL_CASH',
    v_expected_audit
  )
  on conflict (router_revision) do nothing;

  select *
  into strict v_existing
  from public.p10_v10_router_cutover_audit
  where router_revision = v_revision;

  if v_existing.claim_policy_revision is distinct from v_revision
     or v_existing.source_sha is distinct from v_manifest.source_sha
     or v_existing.implementation_sha256 is distinct from v_manifest.implementation_sha256
     or v_existing.candidate_registry_sha256 is distinct from v_manifest.candidate_registry_sha256
     or v_existing.resolver_definition_md5 is distinct from v_resolver_md5
     or v_existing.producer_verifier_definition_md5 is distinct from v_producer_verifier_md5
     or v_existing.wrapper_definition_md5 is distinct from v_wrapper_md5
     or v_existing.claim_definition_md5 is distinct from v_claim_md5
     or not v_existing.legacy_resolver_execute_revoked
     or not v_existing.suspension_table_found
     or not v_existing.suspension_trigger_found
     or not v_existing.suspension_backstop_preserved
     or v_existing.audit is distinct from v_expected_audit
     or (
       coalesce(v_existing.suspension_previous_state, false)
       and (
         v_existing.suspension_previous_reason is distinct from v_expected_old_reason
         or v_existing.suspension_previous_at is distinct from v_expected_old_suspended_at
         or v_existing.suspension_neutralized_at is null
       )
     )
     or (
       v_existing.suspension_previous_state is false
       and v_existing.suspension_neutralized_at is not null
     )
     or (
       v_existing.suspension_previous_state is null
       and (
         v_existing.suspension_previous_reason is not null
         or v_existing.suspension_previous_at is not null
         or v_existing.suspension_neutralized_at is not null
       )
     )
     or v_existing.cutover_action is distinct from
       'RESTORE_EXISTING_BULL_FAIL_CLOSED_NON_BULL_CASH' then
    raise exception 'existing V10 cutover audit differs from the installed implementation'
      using errcode = '55000';
  end if;

  if position(
       'resolve_p10_production_regime_route_v10'
       in pg_get_functiondef(
         'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
       )
     ) = 0
     or position(
       'P10-PRODUCTION-REGIME-ROUTER-v3'
       in pg_get_functiondef(
         'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
       )
     ) > 0 then
    raise exception 'claim_p10_signal V10 revision wiring assertion failed'
      using errcode = '55000';
  end if;
end;
$v10_cutover$;

comment on function public.resolve_p10_production_regime_route_v10(
  text, text, text, timestamptz, jsonb, timestamptz
) is
  'V10 final production router: existing I46/P10 BULL LONG only; RANGE/BEAR/SHORT/unknown/stale/error all fail closed.';

comment on function public.claim_p10_signal(text, text, timestamptz, text, jsonb) is
  'Claims only exact PASS results from P10-PRODUCTION-REGIME-ROUTER-V10 and audits every blocked attempt.';
