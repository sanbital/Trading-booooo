-- Trading-booooo v6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION
--
-- Seven bounded improvements:
-- 1) fixed configured slot denominator, 2) reviewed policy-definition evolution,
-- 3) evidence-weighted exploration size, 4) non-zero unmeasured latency cost,
-- 5) live EV optimism de-biasing, 6) accounting-verified live-only promotion,
-- 7) staged 15% -> 50% canary expansion before full Pareto promotion.
--
-- This migration never increases allocation, slots, reserves, stop limits or loss limits.

alter table public.trading_settings
  add column if not exists scalp_unmeasured_latency_ms integer not null default 1500,
  add column if not exists scalp_unmeasured_latency_penalty_bps numeric not null default 1,
  add column if not exists scalp_ev_bias_penalty_bps numeric not null default 0,
  add column if not exists scalp_ev_bias_samples integer not null default 0,
  add column if not exists scalp_ev_bias_source text not null default 'UNMEASURED',
  add column if not exists scalp_ev_bias_measured_at timestamptz;

alter table public.trading_settings
  drop constraint if exists trading_settings_unmeasured_latency_ms_ck,
  drop constraint if exists trading_settings_unmeasured_latency_penalty_ck,
  drop constraint if exists trading_settings_ev_bias_penalty_ck,
  drop constraint if exists trading_settings_ev_bias_samples_ck,
  drop constraint if exists trading_settings_ev_bias_source_ck;

alter table public.trading_settings
  add constraint trading_settings_unmeasured_latency_ms_ck
    check (scalp_unmeasured_latency_ms between 250 and 5000),
  add constraint trading_settings_unmeasured_latency_penalty_ck
    check (scalp_unmeasured_latency_penalty_bps between 0.25 and 5),
  add constraint trading_settings_ev_bias_penalty_ck
    check (scalp_ev_bias_penalty_bps between 0 and 50),
  add constraint trading_settings_ev_bias_samples_ck
    check (scalp_ev_bias_samples >= 0),
  add constraint trading_settings_ev_bias_source_ck
    check (scalp_ev_bias_source in ('UNMEASURED', 'MEASURED'));

alter table public.lob_policy_versions
  add column if not exists policy_definition jsonb not null default
  '{
    "schemaVersion":1,
    "family":"BALANCED",
    "evidenceSizing":{
      "unprovenFloorFraction":0.35,
      "insufficientStatusCap":0.55,
      "lowQualityCap":0.40,
      "dataQualityForFullSize":0.75,
      "featureSamplesForFullSize":60,
      "marketSamplesForFullSize":40,
      "patternSamplesForFullSize":100
    },
    "latency":{"assumedP95Ms":1500,"unmeasuredFloorBps":1,"penaltyMultiplier":1},
    "evBias":{"penaltyMultiplier":1,"maxPenaltyBps":30}
  }'::jsonb;

update public.lob_policy_versions
set policy_definition = coalesce(policy_definition, '{}'::jsonb) || jsonb_build_object(
  'schemaVersion', 1
)
where policy_definition is null or not (policy_definition ? 'schemaVersion');

-- Replace the one-argument overload so PostgREST has one unambiguous RPC signature.
drop function if exists public.create_lob_policy_challenger(integer);

create or replace function public.create_lob_policy_challenger(
  p_min_new_samples integer default 20,
  p_policy_definition jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_champion public.lob_policy_versions%rowtype;
  v_existing public.lob_policy_versions%rowtype;
  v_pattern public.lob_learning_profiles%rowtype;
  v_online jsonb;
  v_source_version bigint;
  v_last_source bigint;
  v_fingerprint text;
  v_definition jsonb;
  v_created public.lob_policy_versions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('lob-policy-governance-v690'));

  select * into v_existing
    from public.lob_policy_versions
   where status in ('CHALLENGER', 'CONTROL')
   order by version desc limit 1;
  if found then
    return jsonb_build_object(
      'created', false,
      'reason', 'ALTERNATE_ALREADY_ACTIVE',
      'alternate_version', v_existing.version,
      'alternate_status', v_existing.status
    );
  end if;

  select * into v_champion
    from public.lob_policy_versions
   where status = 'CHAMPION'
   order by version desc limit 1 for update;
  if not found then
    return jsonb_build_object('created', false, 'reason', 'NO_CHAMPION');
  end if;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.exchange, p.market, p.pattern), '[]'::jsonb),
         coalesce(sum(p.version) filter (where p.market = '*'), 0)
    into v_online, v_source_version
    from public.lob_market_profiles p;

  select * into v_pattern
    from public.lob_learning_profiles
   order by generated_at desc limit 1;

  select greatest(coalesce(v_champion.source_online_version, 0), coalesce(max(source_online_version), 0))
    into v_last_source
    from public.lob_policy_versions;

  if v_source_version - v_last_source < greatest(1, coalesce(p_min_new_samples, 20)) then
    return jsonb_build_object(
      'created', false,
      'reason', 'INSUFFICIENT_NEW_OUTCOMES',
      'source_online_version', v_source_version,
      'required_after_version', v_last_source + greatest(1, coalesce(p_min_new_samples, 20))
    );
  end if;

  -- Runtime normalization in TypeScript enforces all numerical bounds. SQL stores only the
  -- immutable, auditable proposal attached to this challenger.
  v_definition := coalesce(p_policy_definition, v_champion.policy_definition);
  v_fingerprint := md5(
    coalesce(v_online::text, '[]') ||
    coalesce(to_jsonb(v_pattern)::text, 'null') ||
    coalesce(v_definition::text, '{}')
  );
  if exists (select 1 from public.lob_policy_versions where fingerprint = v_fingerprint) then
    return jsonb_build_object('created', false, 'reason', 'SNAPSHOT_ALREADY_EVALUATED');
  end if;

  update public.lob_policy_versions
     set evaluation_started_at = now(), updated_at = now()
   where version = v_champion.version;

  insert into public.lob_policy_versions (
    status, parent_version, engine_version, fingerprint, source_online_version,
    source_pattern_profile_id, online_profiles, pattern_profile, policy_definition,
    traffic_fraction, evaluation_started_at, decision_reason, criteria
  ) values (
    'CHALLENGER', v_champion.version, '6.9.0-EVIDENCE-SIZED-LIVE-VALIDATION',
    v_fingerprint, v_source_version, v_pattern.id, v_online,
    case when v_pattern.id is null then null else to_jsonb(v_pattern) end,
    v_definition,
    0.15,
    now(),
    'CANARY_15_PERCENT_ACCOUNTING_VERIFIED_LIVE_ONLY',
    jsonb_build_object(
      'min_samples_per_arm', 40,
      'canary_min_baseline_samples', 20,
      'canary_min_candidate_samples', 10,
      'expanded_traffic_fraction', 0.50,
      'min_live_verified_fraction', 1.0,
      'min_distinct_markets_per_arm', 2,
      'min_independent_hour_blocks_per_arm', 2,
      'net_non_inferiority_bps', 2,
      'win_rate_non_inferiority', 0.03,
      'turnover_non_inferiority_ratio', 0.90,
      'requires_positive_net_after_costs', true,
      'requires_accounting_verified_live_labels', true,
      'backtest_shadow_can_vote', false
    )
  ) returning * into v_created;

  return jsonb_build_object(
    'created', true,
    'version', v_created.version,
    'parent_version', v_created.parent_version,
    'traffic_fraction', v_created.traffic_fraction,
    'policy_definition', v_created.policy_definition,
    'source_online_version', v_created.source_online_version
  );
end;
$$;

create or replace function public.get_lob_policy_evaluation_dataset()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_champion public.lob_policy_versions%rowtype;
  v_alternate public.lob_policy_versions%rowtype;
  v_phase text;
  v_baseline_version bigint;
  v_candidate_version bigint;
  v_since timestamptz;
  v_baseline_trades jsonb;
  v_candidate_trades jsonb;
  v_baseline_exposures jsonb;
  v_candidate_exposures jsonb;
begin
  select * into v_champion from public.lob_policy_versions
   where status = 'CHAMPION' order by version desc limit 1;
  select * into v_alternate from public.lob_policy_versions
   where status in ('CHALLENGER', 'CONTROL') order by version desc limit 1;

  if v_champion.version is null or v_alternate.version is null then
    return jsonb_build_object('phase', 'IDLE');
  end if;

  if v_alternate.status = 'CHALLENGER' then
    v_phase := 'CHALLENGE';
    v_baseline_version := v_champion.version;
    v_candidate_version := v_alternate.version;
  else
    v_phase := 'CONFIRMATION';
    v_baseline_version := v_alternate.version;
    v_candidate_version := v_champion.version;
  end if;
  v_since := greatest(
    coalesce(v_champion.evaluation_started_at, v_champion.created_at),
    coalesce(v_alternate.evaluation_started_at, v_alternate.created_at)
  );

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.position_id,
      'policyVersion', o.policy_version,
      'exchange', o.exchange,
      'market', o.market,
      'pattern', o.pattern,
      'netBps', o.net_bps,
      'profitable', o.profitable,
      'heldSeconds', o.held_seconds,
      'notionalQuote', o.realized_cost_quote,
      'closedAtMs', extract(epoch from o.closed_at) * 1000,
      'liveVerified', true,
      'accountingQuality', o.accounting_quality
    ) order by o.closed_at), '[]'::jsonb)
    into v_baseline_trades
    from public.lob_online_outcomes o
   where o.policy_version = v_baseline_version
     and o.closed_at >= v_since
     and o.accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT');

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.position_id,
      'policyVersion', o.policy_version,
      'exchange', o.exchange,
      'market', o.market,
      'pattern', o.pattern,
      'netBps', o.net_bps,
      'profitable', o.profitable,
      'heldSeconds', o.held_seconds,
      'notionalQuote', o.realized_cost_quote,
      'closedAtMs', extract(epoch from o.closed_at) * 1000,
      'liveVerified', true,
      'accountingQuality', o.accounting_quality
    ) order by o.closed_at), '[]'::jsonb)
    into v_candidate_trades
    from public.lob_online_outcomes o
   where o.policy_version = v_candidate_version
     and o.closed_at >= v_since
     and o.accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT');

  select coalesce(jsonb_agg(jsonb_build_object(
      'policyVersion', e.policy_version,
      'assignedAtMs', extract(epoch from e.assigned_at) * 1000,
      'candidateCount', e.candidate_count,
      'entryAttempts', e.entry_attempts,
      'reservations', e.reservations
    ) order by e.assigned_at), '[]'::jsonb)
    into v_baseline_exposures
    from public.lob_policy_cycle_exposures e
   where e.policy_version = v_baseline_version and e.assigned_at >= v_since;

  select coalesce(jsonb_agg(jsonb_build_object(
      'policyVersion', e.policy_version,
      'assignedAtMs', extract(epoch from e.assigned_at) * 1000,
      'candidateCount', e.candidate_count,
      'entryAttempts', e.entry_attempts,
      'reservations', e.reservations
    ) order by e.assigned_at), '[]'::jsonb)
    into v_candidate_exposures
    from public.lob_policy_cycle_exposures e
   where e.policy_version = v_candidate_version and e.assigned_at >= v_since;

  return jsonb_build_object(
    'phase', v_phase,
    'since', v_since,
    'baseline_version', v_baseline_version,
    'candidate_version', v_candidate_version,
    'candidate_traffic_fraction', case
      when v_phase = 'CHALLENGE' then v_alternate.traffic_fraction
      else 0.50
    end,
    'baseline_trades', v_baseline_trades,
    'candidate_trades', v_candidate_trades,
    'baseline_exposures', v_baseline_exposures,
    'candidate_exposures', v_candidate_exposures
  );
end;
$$;

create or replace function public.apply_lob_policy_decision(
  p_expected_champion bigint,
  p_expected_alternate bigint,
  p_decision text,
  p_metrics jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_champion public.lob_policy_versions%rowtype;
  v_alternate public.lob_policy_versions%rowtype;
  v_decision text := upper(coalesce(p_decision, ''));
begin
  perform pg_advisory_xact_lock(hashtext('lob-policy-governance-v690'));

  select * into v_champion from public.lob_policy_versions
   where status = 'CHAMPION' order by version desc limit 1 for update;
  select * into v_alternate from public.lob_policy_versions
   where status in ('CHALLENGER', 'CONTROL') order by version desc limit 1 for update;

  if v_champion.version is distinct from p_expected_champion or
     v_alternate.version is distinct from p_expected_alternate then
    return jsonb_build_object('applied', false, 'reason', 'STALE_POLICY_STATE');
  end if;

  if v_decision = 'HOLD' then
    update public.lob_policy_versions
       set metrics = coalesce(p_metrics, '{}'::jsonb), decision_reason = p_reason,
           evaluated_at = now(), updated_at = now()
     where version = v_alternate.version;
  elsif v_decision = 'EXPAND' and v_alternate.status = 'CHALLENGER' then
    update public.lob_policy_versions
       set traffic_fraction = 0.50,
           metrics = coalesce(p_metrics, '{}'::jsonb),
           decision_reason = coalesce(p_reason, 'CANARY_EXPANDED_TO_50_PERCENT'),
           evaluation_started_at = now(),
           evaluated_at = now(), updated_at = now()
     where version = v_alternate.version;
    update public.lob_policy_versions
       set evaluation_started_at = now(), updated_at = now()
     where version = v_champion.version;
  elsif v_decision = 'REJECT' and v_alternate.status = 'CHALLENGER' then
    update public.lob_policy_versions
       set status = 'REJECTED', metrics = coalesce(p_metrics, '{}'::jsonb),
           decision_reason = p_reason, evaluated_at = now(), retired_at = now(), updated_at = now()
     where version = v_alternate.version;
    update public.lob_policy_versions
       set evaluation_started_at = null, updated_at = now()
     where version = v_champion.version;
  elsif v_decision = 'PROMOTE' and v_alternate.status = 'CHALLENGER' then
    update public.lob_policy_versions set status = 'RETIRED', updated_at = now()
     where version = v_alternate.version;
    update public.lob_policy_versions
       set status = 'CONTROL', traffic_fraction = 0.50, evaluation_started_at = now(),
           metrics = coalesce(p_metrics -> 'baseline', '{}'::jsonb),
           decision_reason = 'LIVE_CONTROL_AFTER_PROVISIONAL_PROMOTION', updated_at = now()
     where version = v_champion.version;
    update public.lob_policy_versions
       set status = 'CHAMPION', promoted_at = now(), confirmed_at = null,
           evaluation_started_at = now(), metrics = coalesce(p_metrics -> 'candidate', '{}'::jsonb),
           decision_reason = p_reason, evaluated_at = now(), updated_at = now()
     where version = v_alternate.version;
  elsif v_decision = 'CONFIRM' and v_alternate.status = 'CONTROL' then
    update public.lob_policy_versions
       set status = 'RETIRED', metrics = coalesce(p_metrics -> 'baseline', metrics),
           decision_reason = 'PROVISIONAL_CHAMPION_CONFIRMED', evaluated_at = now(),
           retired_at = now(), updated_at = now()
     where version = v_alternate.version;
    update public.lob_policy_versions
       set confirmed_at = now(), evaluation_started_at = null,
           metrics = coalesce(p_metrics -> 'candidate', metrics), decision_reason = p_reason,
           evaluated_at = now(), updated_at = now()
     where version = v_champion.version;
  elsif v_decision = 'ROLLBACK' and v_alternate.status = 'CONTROL' then
    update public.lob_policy_versions
       set status = 'ROLLED_BACK', metrics = coalesce(p_metrics -> 'candidate', metrics),
           decision_reason = p_reason, evaluated_at = now(), retired_at = now(), updated_at = now()
     where version = v_champion.version;
    update public.lob_policy_versions
       set status = 'CHAMPION', confirmed_at = now(), evaluation_started_at = null,
           metrics = coalesce(p_metrics -> 'baseline', metrics),
           decision_reason = 'AUTO_ROLLBACK_CONTROL_RESTORED', evaluated_at = now(),
           retired_at = null, updated_at = now()
     where version = v_alternate.version;
  else
    return jsonb_build_object(
      'applied', false, 'reason', 'INVALID_DECISION_FOR_PHASE',
      'decision', v_decision, 'alternate_status', v_alternate.status
    );
  end if;

  return jsonb_build_object(
    'applied', true,
    'decision', v_decision,
    'status', public.get_lob_policy_status()
  );
end;
$$;

create or replace function public.get_lob_policy_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with champion as (
    select * from public.lob_policy_versions where status = 'CHAMPION'
    order by version desc limit 1
  ), alternate as (
    select * from public.lob_policy_versions where status in ('CHALLENGER', 'CONTROL')
    order by version desc limit 1
  )
  select jsonb_build_object(
    'mode', 'EVIDENCE_SIZED_ACCOUNTING_VERIFIED_LIVE_VALIDATION',
    'phase', case
      when (select status from alternate) = 'CHALLENGER' then 'CHALLENGE'
      when (select status from alternate) = 'CONTROL' then 'CONFIRMATION'
      else 'IDLE'
    end,
    'champion', (select jsonb_build_object(
      'version', version, 'status', status, 'policy_definition', policy_definition,
      'source_online_version', source_online_version, 'confirmed', confirmed_at is not null,
      'evaluation_started_at', evaluation_started_at, 'metrics', metrics,
      'decision_reason', decision_reason, 'updated_at', updated_at
    ) from champion),
    'alternate', (select jsonb_build_object(
      'version', version, 'status', status, 'parent_version', parent_version,
      'traffic_fraction', traffic_fraction, 'policy_definition', policy_definition,
      'source_online_version', source_online_version, 'evaluation_started_at', evaluation_started_at,
      'metrics', metrics, 'decision_reason', decision_reason, 'updated_at', updated_at
    ) from alternate),
    'verified_live_outcome_samples', (
      select count(*) from public.lob_online_outcomes
       where accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
    ),
    'unverified_outcome_samples', (
      select count(*) from public.lob_online_outcomes
       where accounting_quality = 'LEGACY_UNVERIFIED'
    ),
    'last_verified_update_at', (
      select max(created_at) from public.lob_online_outcomes
       where accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
    )
  );
$$;

revoke all on function public.create_lob_policy_challenger(integer, jsonb) from public;
revoke all on function public.get_lob_policy_evaluation_dataset() from public;
revoke all on function public.apply_lob_policy_decision(bigint, bigint, text, jsonb, text) from public;
revoke all on function public.get_lob_policy_status() from public;

grant execute on function public.create_lob_policy_challenger(integer, jsonb) to service_role;
grant execute on function public.get_lob_policy_evaluation_dataset() to service_role;
grant execute on function public.apply_lob_policy_decision(bigint, bigint, text, jsonb, text) to service_role;
grant execute on function public.get_lob_policy_status() to service_role;

comment on column public.lob_policy_versions.policy_definition is
  'Immutable bounded LOB policy knobs. Source-code generation and safety-rail relaxation are forbidden.';
comment on column public.trading_settings.scalp_ev_bias_penalty_bps is
  'Shrunk one-sided live realized-vs-predicted optimism penalty, bps, accounting-verified labels only.';
