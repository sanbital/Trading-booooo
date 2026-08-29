-- Production Regime Router v3
--
-- This revision deliberately keeps the pre-existing P10 BULL LONG edge live and
-- records the completed V5 validation as a rejected promotion.  V5 produced no
-- robust RANGE or BEAR candidate, so those lanes remain fail-closed.  Tactical
-- states that require per-market 15m/5m evidence are never inferred from the
-- legacy full-market observer phase.

create table if not exists public.p10_regime_router_validations (
  id bigint generated always as identity primary key,
  router_revision text not null,
  research_revision text not null,
  research_job_id uuid,
  source_sha text not null,
  implementation_sha256 text not null,
  candidate_registry_revision text not null,
  candidate_registry_sha256 text not null,
  validation_status text not null check (
    validation_status in ('APPROVED', 'REJECTED_NO_ROBUST_EDGE', 'REJECTED_INCOMPLETE')
  ),
  validation_metrics jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (router_revision)
);

comment on table public.p10_regime_router_validations is
  'Append-only validation lineage for production regime-router promotion decisions.';

create table if not exists public.p10_regime_router_lanes (
  id bigint generated always as identity primary key,
  router_revision text not null,
  router_state text not null check (
    router_state in (
      'BULL_TREND',
      'BULL_DECELERATING',
      'RANGE_UP_CYCLE',
      'BEAR_REBOUND',
      'BEAR_REBREAK'
    )
  ),
  structural_regime text not null,
  tactical_requirement text not null,
  entry_side text check (entry_side in ('LONG', 'SHORT')),
  entry_strategy_key text,
  entry_enabled boolean not null,
  entry_status text not null check (
    entry_status in (
      'ENABLED_EXISTING_EDGE',
      'REJECTED_NO_ROBUST_EDGE',
      'NO_ENTRY_CANDIDATE'
    )
  ),
  entry_policy_key text not null,
  exit_policy_key text not null,
  profit_protection_key text not null,
  risk_guard_key text not null,
  validation_basis text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (router_revision, router_state),
  check (
    (entry_enabled and entry_status = 'ENABLED_EXISTING_EDGE' and entry_side is not null and entry_strategy_key is not null)
    or
    (not entry_enabled and entry_status <> 'ENABLED_EXISTING_EDGE')
  )
);

comment on table public.p10_regime_router_lanes is
  'Append-only five-state production registry. Disabled lanes are explicit abstentions, not hidden strategy mappings.';

create or replace function public.reject_p10_regime_router_registry_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception '% is append-only; insert a new router revision instead', tg_table_name
    using errcode = '55000';
end;
$$;

create or replace function public.guard_p10_regime_router_lane_promotion()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.entry_enabled
     and new.router_state in ('RANGE_UP_CYCLE', 'BEAR_REBOUND', 'BEAR_REBREAK')
     and not exists (
       select 1
       from public.p10_regime_router_validations v
       where v.router_revision = new.router_revision
         and v.validation_status = 'APPROVED'
         and coalesce((v.validation_metrics->>'funding_accounted')::boolean, false)
         and coalesce((v.validation_metrics->>'actual_fill_replay')::boolean, false)
         and coalesce((v.validation_metrics->>'point_in_time_delisted_universe')::boolean, false)
         and jsonb_array_length(coalesce(v.validation_metrics->'robust_candidates', '[]'::jsonb)) > 0
     ) then
    raise exception 'P10_ROUTER_PROMOTION_BLOCKED: non-BULL lane lacks approved execution-complete validation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists p10_regime_router_validations_immutable
  on public.p10_regime_router_validations;
create trigger p10_regime_router_validations_immutable
before update or delete on public.p10_regime_router_validations
for each row execute function public.reject_p10_regime_router_registry_mutation();

drop trigger if exists p10_regime_router_validations_no_truncate
  on public.p10_regime_router_validations;
create trigger p10_regime_router_validations_no_truncate
before truncate on public.p10_regime_router_validations
for each statement execute function public.reject_p10_regime_router_registry_mutation();

drop trigger if exists p10_regime_router_lanes_immutable
  on public.p10_regime_router_lanes;
create trigger p10_regime_router_lanes_immutable
before update or delete on public.p10_regime_router_lanes
for each row execute function public.reject_p10_regime_router_registry_mutation();

drop trigger if exists p10_regime_router_lanes_no_truncate
  on public.p10_regime_router_lanes;
create trigger p10_regime_router_lanes_no_truncate
before truncate on public.p10_regime_router_lanes
for each statement execute function public.reject_p10_regime_router_registry_mutation();

drop trigger if exists p10_regime_router_lanes_promotion_guard
  on public.p10_regime_router_lanes;
create trigger p10_regime_router_lanes_promotion_guard
before insert on public.p10_regime_router_lanes
for each row execute function public.guard_p10_regime_router_lane_promotion();

alter table public.p10_regime_router_validations enable row level security;
alter table public.p10_regime_router_lanes enable row level security;
revoke all on table public.p10_regime_router_validations from public, anon, authenticated;
revoke all on table public.p10_regime_router_lanes from public, anon, authenticated;
revoke all on sequence public.p10_regime_router_validations_id_seq from public, anon, authenticated;
revoke all on sequence public.p10_regime_router_lanes_id_seq from public, anon, authenticated;
revoke all on table public.p10_regime_router_validations from service_role;
revoke all on table public.p10_regime_router_lanes from service_role;
revoke all on sequence public.p10_regime_router_validations_id_seq from service_role;
revoke all on sequence public.p10_regime_router_lanes_id_seq from service_role;
grant select on table public.p10_regime_router_validations to service_role;
grant select on table public.p10_regime_router_lanes to service_role;

-- Resolve the generated job id by immutable research lineage when that research
-- schema exists.  A clean database can still reproduce the router registry without
-- depending on research-only tables.
do $$
declare
  v_job_id uuid;
  v_job_count integer := 0;
  v_expected_metrics jsonb;
  v_existing public.p10_regime_router_validations%rowtype;
begin
  if to_regclass('public.v2_research_jobs') is not null then
    execute $query$
      select count(*), min(id::text)::uuid
      from public.v2_research_jobs
      where revision = $1
        and status = 'COMPLETE'
        and window_start = $4::timestamptz
        and window_end = $5::timestamptz
        and total_markets = 567
        and processed_markets = 567
        and failed_markets = 0
        and config->>'source_sha' = $2
        and config->>'implementation_sha256' = $3
        and config->>'candidate_registry_revision' = $6
        and config->>'candidate_registry_sha256' = $7
        and coalesce((metrics->>'no_robust_edge_found')::boolean, false)
        and coalesce(metrics->'robust_candidates', '[]'::jsonb) = '[]'::jsonb
    $query$
    into v_job_count, v_job_id
    using
      'REGIME_ROUTER_V5_STRUCTURAL_TACTICAL_RANGE_EXIT_V2_15M_120D_RSWF',
      '96d00bbb1c992cefdf3cb7fbccc1e276c160032d',
      '0ec1b27242e2c7e41f39ed42889bd8ff94e440665545e54ca0771b45ebeedbb8',
      '2026-04-30T22:30:00Z',
      '2026-08-28T22:15:00Z',
      'V5_PRECOMMITTED_NEIGHBOURHOOD_20260829_RANGE_EXIT_V2_A',
      '1342a3b4538314aa68fa4176a08ea5e3c1bd260b007cdee192fe5e3812b6318c';

    if v_job_count <> 1 then
      raise exception 'expected exactly one immutable completed V5 validation job, found %',
        v_job_count;
    end if;
  end if;

  v_expected_metrics := jsonb_build_object(
    'markets', 567,
    'failed_markets', 0,
    'candidates', 19,
    'rolling_folds', 4,
    'splits', jsonb_build_array('TRAIN', 'VALIDATION', 'TEST'),
    'candidate_cells', 129276,
    'train_fold_passes_max', 0,
    'validation_fold_passes_max', 0,
    'production_review_eligible_count', 0,
    'robust_candidates', '[]'::jsonb,
    'no_robust_edge_found', true,
    'test_used_for_selection', false,
    'base_round_trip_cost_bps', 14,
    'stress_round_trip_cost_bps', 23,
    'funding_accounted', false,
    'actual_fill_replay', false,
    'point_in_time_delisted_universe', false,
    'research_job_link_status', case
      when v_job_id is null then 'RESEARCH_SCHEMA_ABSENT_CLEAN_REPLAY'
      else 'EXACT_UNIQUE_JOB_MATCH'
    end,
    'promotion_decision', 'NO_RANGE_OR_BEAR_PRODUCTION_PROMOTION'
  );

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
  ) values (
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'REGIME_ROUTER_V5_STRUCTURAL_TACTICAL_RANGE_EXIT_V2_15M_120D_RSWF',
    v_job_id,
    '96d00bbb1c992cefdf3cb7fbccc1e276c160032d',
    '0ec1b27242e2c7e41f39ed42889bd8ff94e440665545e54ca0771b45ebeedbb8',
    'V5_PRECOMMITTED_NEIGHBOURHOOD_20260829_RANGE_EXIT_V2_A',
    '1342a3b4538314aa68fa4176a08ea5e3c1bd260b007cdee192fe5e3812b6318c',
    'REJECTED_NO_ROBUST_EDGE',
    v_expected_metrics
  )
  on conflict (router_revision) do nothing;

  select *
  into strict v_existing
  from public.p10_regime_router_validations
  where router_revision = 'P10-PRODUCTION-REGIME-ROUTER-v3';

  if v_existing.research_revision is distinct from
       'REGIME_ROUTER_V5_STRUCTURAL_TACTICAL_RANGE_EXIT_V2_15M_120D_RSWF'
     or v_existing.research_job_id is distinct from v_job_id
     or v_existing.source_sha is distinct from
       '96d00bbb1c992cefdf3cb7fbccc1e276c160032d'
     or v_existing.implementation_sha256 is distinct from
       '0ec1b27242e2c7e41f39ed42889bd8ff94e440665545e54ca0771b45ebeedbb8'
     or v_existing.candidate_registry_revision is distinct from
       'V5_PRECOMMITTED_NEIGHBOURHOOD_20260829_RANGE_EXIT_V2_A'
     or v_existing.candidate_registry_sha256 is distinct from
       '1342a3b4538314aa68fa4176a08ea5e3c1bd260b007cdee192fe5e3812b6318c'
     or v_existing.validation_status is distinct from 'REJECTED_NO_ROBUST_EDGE'
     or v_existing.validation_metrics is distinct from v_expected_metrics then
    raise exception 'existing P10 router v3 validation lineage does not match the immutable migration';
  end if;
end;
$$;

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
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'BULL_TREND',
    'BULL_OR_STRONG_BULL',
    'LEGACY_OBSERVER_ACCELERATING_OR_IMPULSE_CONTINUATION',
    'LONG',
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    true,
    'ENABLED_EXISTING_EDGE',
    'P10_EXISTING_LONG_ENTRY',
    'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY',
    'P10_TARGETS_TRAILING_AND_STOP_PRIORITY',
    'guard_p10_order_v800_AND_EXISTING_CIRCUIT_GUARDS',
    'PRESERVE_PREEXISTING_P10_BULL_LONG_EDGE_NOT_A_V5_PROMOTION'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'BULL_DECELERATING',
    'BULL_OR_STRONG_BULL',
    'LEGACY_OBSERVER_NON_ACCELERATING_BULL_PHASE',
    'LONG',
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    true,
    'ENABLED_EXISTING_EDGE',
    'P10_EXISTING_LONG_ENTRY',
    'P10_SLOW_4R_WITH_MARKET_RISK_OVERLAY',
    'P10_TARGETS_TRAILING_AND_STOP_PRIORITY',
    'guard_p10_order_v800_AND_EXISTING_CIRCUIT_GUARDS',
    'PRESERVE_PREEXISTING_P10_BULL_LONG_EDGE_NOT_A_V5_PROMOTION'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'RANGE_UP_CYCLE',
    'RANGE',
    'MARKET_V5_15M_UP_CYCLE_AND_CAUSAL_COMPLETED_5M_CONFIRMATION',
    'LONG',
    null,
    false,
    'REJECTED_NO_ROBUST_EDGE',
    'UNAVAILABLE',
    'REQUIRES_VALIDATED_RANGE_EXIT_V2',
    'REQUIRES_VALIDATED_RANGE_PARTIAL_AND_BREAK_EVEN_RESIDUAL_STOP',
    'guard_p10_order_v800_AND_FUTURE_FAMILY_DISPATCH',
    'V5_FULL_MARKET_ROLLING_VALIDATION_REJECTED_ALL_RANGE_CANDIDATES'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'BEAR_REBOUND',
    'BEAR',
    'MARKET_V5_15M_REBOUND_WITH_CAUSAL_COMPLETED_5M_CONTEXT',
    null,
    null,
    false,
    'NO_ENTRY_CANDIDATE',
    'NO_ENTRY_DURING_BEAR_REBOUND',
    'REQUIRES_FAMILY_SPECIFIC_BEAR_REBOUND_EXIT',
    'REQUIRES_FAMILY_SPECIFIC_SHORT_PROFIT_PROTECTION',
    'guard_p10_order_v800_AND_FUTURE_FAMILY_DISPATCH',
    'V5_PRECOMMITTED_REGISTRY_CONTAINS_NO_BEAR_REBOUND_ENTRY'
  ),
  (
    'P10-PRODUCTION-REGIME-ROUTER-v3',
    'BEAR_REBREAK',
    'BEAR',
    'MARKET_V5_15M_REBREAK_AND_CAUSAL_COMPLETED_5M_CONFIRMATION',
    'SHORT',
    null,
    false,
    'REJECTED_NO_ROBUST_EDGE',
    'UNAVAILABLE',
    'REQUIRES_VALIDATED_BEAR_REBREAK_EXIT',
    'REQUIRES_VALIDATED_SHORT_PROFIT_PROTECTION',
    'guard_p10_order_v800_AND_FUTURE_FAMILY_DISPATCH',
    'V5_FULL_MARKET_ROLLING_VALIDATION_REJECTED_ALL_BEAR_REBREAK_CANDIDATES'
  )
on conflict (router_revision, router_state) do nothing;

do $$
declare
  v_lane_count integer;
  v_enabled_states text[];
begin
  select count(*),
         array_agg(router_state order by router_state) filter (where entry_enabled)
  into v_lane_count, v_enabled_states
  from public.p10_regime_router_lanes
  where router_revision = 'P10-PRODUCTION-REGIME-ROUTER-v3';

  if v_lane_count <> 5
     or v_enabled_states is distinct from array['BULL_DECELERATING', 'BULL_TREND']::text[]
     or exists (
       select 1
       from public.p10_regime_router_lanes
       where router_revision = 'P10-PRODUCTION-REGIME-ROUTER-v3'
         and router_state in ('RANGE_UP_CYCLE', 'BEAR_REBOUND', 'BEAR_REBREAK')
         and entry_enabled
     ) then
    raise exception 'existing P10 router v3 lane registry does not match the fail-closed migration';
  end if;
end;
$$;

-- The evaluator existed in production before it was added to the repository.
-- Persisting the exact deployed behavior here makes a clean migration replayable.
create or replace function public.evaluate_p10_entry_regime_shadow(
  p_side text,
  p_at timestamptz
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_obs public.market_regime_observations%rowtype;
  v_side text := upper(coalesce(p_side, ''));
  v_phase text;
  v_recommendation text := 'UNKNOWN';
  v_reason text := 'REGIME_UNAVAILABLE_OR_STALE';
  v_live_gate_candidate boolean := false;
begin
  select o.*
  into v_obs
  from public.market_regime_observations o
  where o.model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'
    and o.observed_at <= p_at
    and o.observed_at >= p_at - interval '12 minutes'
    and o.confidence >= 0.60
    and o.sample_size >= 240
    and o.features->>'source' = 'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE'
    and coalesce((o.features->'breadth_30m'->'binance_spot'->>'sample_size')::integer, 0) >= 80
    and coalesce((o.features->'breadth_30m'->'binance_futures'->>'sample_size')::integer, 0) >= 80
    and coalesce((o.features->'breadth_30m'->'upbit_spot'->>'sample_size')::integer, 0) >= 40
    and o.predicted_regime in ('RISK_OFF', 'NEUTRAL', 'BULL', 'STRONG_BULL')
  order by o.observed_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'policy_revision', 'P10-ENTRY-REGIME-SHADOW-v1',
      'model_revision', 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET',
      'evaluated_at', p_at,
      'side', v_side,
      'recommendation', 'UNKNOWN',
      'reason', 'REGIME_UNAVAILABLE_OR_STALE',
      'live_gate_candidate', false,
      'shadow_only', true
    );
  end if;

  v_phase := coalesce(v_obs.features->'momentum_phase'->>'phase', 'UNKNOWN');
  v_live_gate_candidate := coalesce(v_obs.trading_influence, false);

  if v_side = 'LONG' then
    if v_obs.predicted_regime in ('BULL', 'STRONG_BULL') then
      v_recommendation := 'ALLOW';
      v_reason := 'LONG_STRUCTURAL_BULL';
    elsif v_obs.predicted_regime in ('NEUTRAL', 'RISK_OFF') then
      v_recommendation := 'BLOCK';
      v_reason := 'LONG_NON_BULL_REGIME';
    end if;
  elsif v_side = 'SHORT' then
    if v_phase = 'CAPITULATION_REBOUND' then
      v_recommendation := 'BLOCK';
      v_reason := 'SHORT_CAPITULATION_REBOUND';
    elsif v_obs.predicted_regime in ('BULL', 'STRONG_BULL') then
      v_recommendation := 'BLOCK';
      v_reason := 'SHORT_BULL_ADVERSE';
    elsif v_obs.predicted_regime = 'RISK_OFF' and v_obs.bull_score <= 42 then
      v_recommendation := 'ALLOW';
      v_reason := 'SHORT_CONFIRMED_RISK_OFF';
    else
      v_recommendation := 'CAUTION';
      v_reason := 'SHORT_AMBIGUOUS_REGIME';
    end if;
  else
    v_recommendation := 'UNKNOWN';
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  end if;

  return jsonb_build_object(
    'policy_revision', 'P10-ENTRY-REGIME-SHADOW-v1',
    'model_revision', v_obs.model_revision,
    'evaluated_at', p_at,
    'side', v_side,
    'observation_id', v_obs.id,
    'observed_at', v_obs.observed_at,
    'regime', v_obs.predicted_regime,
    'phase', v_phase,
    'bull_score', v_obs.bull_score,
    'confidence', v_obs.confidence,
    'sample_size', v_obs.sample_size,
    'observation_trading_influence', v_obs.trading_influence,
    'live_gate_candidate', v_live_gate_candidate,
    'recommendation', v_recommendation,
    'reason', v_reason,
    'shadow_only', true,
    'observation_age_seconds', extract(epoch from (p_at - v_obs.observed_at))
  );
end;
$$;

create or replace function public.resolve_p10_production_regime_route_v3(
  p_market text,
  p_side text,
  p_signal_time timestamptz,
  p_evidence jsonb,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gate jsonb;
  v_lane jsonb := '{}'::jsonb;
  v_validation jsonb := '{}'::jsonb;
  v_side text := upper(coalesce(p_side, ''));
  v_regime text := 'UNKNOWN';
  v_phase text := 'UNKNOWN';
  v_state text := 'NO_TRADE';
  v_candidate_state text := 'NO_TRADE';
  v_strategy text := null;
  v_action text := 'BLOCK';
  v_reason text := 'ROUTER_UNAVAILABLE';
  v_live boolean := false;
  v_state_verified boolean := false;
  v_tactical_evidence text := 'UNAVAILABLE';
begin
  v_gate := public.evaluate_p10_entry_regime_shadow(v_side, p_at);
  v_regime := upper(coalesce(v_gate->>'regime', 'UNKNOWN'));
  v_phase := upper(coalesce(v_gate->>'phase', 'UNKNOWN'));
  v_live := coalesce((v_gate->>'live_gate_candidate')::boolean, false);

  if v_regime in ('BULL', 'STRONG_BULL') then
    v_state := case
      when v_phase in ('ACCELERATING', 'IMPULSE_CONTINUATION') then 'BULL_TREND'
      else 'BULL_DECELERATING'
    end;
    v_candidate_state := v_state;
    v_state_verified := true;
    v_tactical_evidence := 'LEGACY_GLOBAL_OBSERVER_PRESERVES_EXISTING_P10_BULL_GATE';
  elsif v_regime = 'NEUTRAL' then
    v_candidate_state := 'RANGE_UP_CYCLE';
    v_tactical_evidence := 'MISSING_MARKET_V5_15M_AND_COMPLETED_5M_CONFIRMATION';
  elsif v_regime = 'RISK_OFF' then
    v_candidate_state := case
      when v_phase in ('CAPITULATION_REBOUND', 'DEEP_DROP_REBOUND', 'REBOUND_CONFIRMED')
        then 'BEAR_REBOUND'
      else 'BEAR_REBREAK'
    end;
    v_tactical_evidence := 'MISSING_MARKET_V5_15M_AND_COMPLETED_5M_CONFIRMATION';
  end if;

  if v_state in ('BULL_TREND', 'BULL_DECELERATING') then
    select to_jsonb(l) - 'id' - 'recorded_at'
    into v_lane
    from public.p10_regime_router_lanes l
    where l.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-v3'
      and l.router_state = v_state;
  end if;

  select to_jsonb(v) - 'id' - 'recorded_at'
  into v_validation
  from public.p10_regime_router_validations v
  where v.router_revision = 'P10-PRODUCTION-REGIME-ROUTER-v3'
  order by v.recorded_at desc
  limit 1;

  if v_side not in ('LONG', 'SHORT') then
    v_action := 'BLOCK';
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  elsif not v_live then
    if v_side = 'LONG' then
      v_action := 'FAIL_OPEN';
      v_strategy := 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R';
      v_reason := 'OBSERVER_UNAVAILABLE_PRESERVE_VALIDATED_LONG_EDGE';
    else
      v_action := 'BLOCK';
      v_reason := 'SHORT_DISABLED_UNTIL_VALIDATED_EDGE';
    end if;
  elsif v_side = 'LONG' and v_regime in ('BULL', 'STRONG_BULL') then
    v_action := 'PASS';
    v_strategy := 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R';
    v_reason := 'VALIDATED_BULL_LONG_EDGE';
  elsif v_side = 'SHORT' then
    v_action := 'BLOCK';
    v_reason := 'SHORT_DISABLED_NEGATIVE_LIVE_AND_NO_V5_ROBUST_EDGE';
  elsif v_regime = 'NEUTRAL' then
    v_action := 'BLOCK';
    v_reason := 'RANGE_ABSTAIN_NO_VALIDATED_EDGE';
  elsif v_regime = 'RISK_OFF' then
    v_action := 'BLOCK';
    v_reason := 'BEAR_ABSTAIN_NO_VALIDATED_EDGE';
  else
    v_action := 'BLOCK';
    v_reason := 'NON_BULL_LONG_ENTRY_BLOCK';
  end if;

  return jsonb_build_object(
    'policy_revision', 'P10-PRODUCTION-REGIME-ROUTER-v3',
    'evaluated_at', p_at,
    'market', p_market,
    'signal_time', p_signal_time,
    'side', v_side,
    'structural_regime', v_regime,
    'observer_phase', v_phase,
    'regime', v_regime,
    'phase', v_phase,
    'state', v_state,
    'candidate_state', v_candidate_state,
    'state_verified', v_state_verified,
    'tactical_evidence', v_tactical_evidence,
    'action', v_action,
    'strategy_key', v_strategy,
    'reason', v_reason,
    'live_gate_candidate', v_live,
    'lane', coalesce(v_lane, '{}'::jsonb),
    'validation', coalesce(v_validation, '{}'::jsonb),
    'signal_evidence_present', coalesce(p_evidence, '{}'::jsonb) <> '{}'::jsonb,
    'gate', coalesce(v_gate, '{}'::jsonb)
  );
end;
$$;

create or replace function public.resolve_p10_production_regime_route(
  p_side text,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.resolve_p10_production_regime_route_v3(
    null,
    p_side,
    p_at,
    '{}'::jsonb,
    p_at
  );
$$;

create or replace function public.claim_p10_signal(
  p_venue text,
  p_market text,
  p_signal_time timestamptz,
  p_side text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.p10_signal_claims%rowtype;
  v_route jsonb;
  v_gate jsonb;
  v_decision text := 'BLOCK';
  v_reason text := 'ROUTER_UNAVAILABLE';
  v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-v3';
begin
  begin
    v_route := public.resolve_p10_production_regime_route_v3(
      p_market,
      upper(p_side),
      p_signal_time,
      coalesce(p_evidence, '{}'::jsonb),
      clock_timestamp()
    );
    v_gate := coalesce(v_route->'gate', '{}'::jsonb);
    v_decision := upper(coalesce(v_route->>'action', 'BLOCK'));
    v_reason := coalesce(v_route->>'reason', 'ROUTER_UNAVAILABLE');
  exception when others then
    if upper(coalesce(p_side, '')) = 'LONG' then
      v_decision := 'FAIL_OPEN';
      v_reason := 'ROUTER_ERROR_PRESERVE_VALIDATED_LONG_EDGE';
    else
      v_decision := 'BLOCK';
      v_reason := 'ROUTER_ERROR_SHORT_FAIL_CLOSED';
    end if;
    v_route := jsonb_build_object(
      'policy_revision', v_policy_revision,
      'error', left(sqlerrm, 240),
      'action', v_decision,
      'reason', v_reason
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
      when coalesce(v_gate->>'observed_at', '') <> '' then (v_gate->>'observed_at')::timestamptz
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

  if v_decision = 'BLOCK' then
    return jsonb_build_object(
      'claimed', false,
      'blocked', true,
      'reason', v_reason,
      'regime_route', v_route,
      'claim', null
    );
  end if;

  insert into public.p10_signal_claims (venue, market, signal_time, side, evidence)
  values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
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
$$;

revoke execute on function public.reject_p10_regime_router_registry_mutation() from public, anon, authenticated;
revoke execute on function public.guard_p10_regime_router_lane_promotion() from public, anon, authenticated;
revoke execute on function public.evaluate_p10_entry_regime_shadow(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.resolve_p10_production_regime_route_v3(text, text, timestamptz, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.resolve_p10_production_regime_route(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb) from public, anon, authenticated;

grant execute on function public.evaluate_p10_entry_regime_shadow(text, timestamptz) to service_role;
grant execute on function public.resolve_p10_production_regime_route_v3(text, text, timestamptz, jsonb, timestamptz) to service_role;
grant execute on function public.resolve_p10_production_regime_route(text, timestamptz) to service_role;
grant execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb) to service_role;
