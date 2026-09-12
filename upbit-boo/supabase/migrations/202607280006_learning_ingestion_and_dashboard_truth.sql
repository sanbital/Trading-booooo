-- Repair verified LOB outcome ingestion and make policy status report the cohort that
-- can actually vote. The column default LEGACY_UNVERIFIED is a storage sentinel, not an
-- authoritative value; the closed position ledger is authoritative at ingestion time.

create or replace function public.guard_lob_outcome_integrity_v610()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.trading_positions%rowtype;
begin
  select * into p from public.trading_positions where id = new.position_id;
  if not found then return null; end if;

  new.engine_version := coalesce(
    nullif(new.engine_version, ''),
    nullif(p.metadata ->> 'engine_version', '')
  );
  new.accounting_quality := coalesce(
    nullif(nullif(new.accounting_quality, ''), 'LEGACY_UNVERIFIED'),
    nullif(p.metadata #>> '{exit_residual_accounting,quality}', ''),
    'LEGACY_UNVERIFIED'
  );
  new.accounting_version := coalesce(
    nullif(new.accounting_version, ''),
    nullif(p.accounting_version, '')
  );
  new.fee_accounting_quality := coalesce(
    nullif(p.fee_accounting_quality, ''),
    'LEGACY_UNVERIFIED'
  );
  new.prediction_basis := case
    when p.metadata #>> '{lob_signal,prediction_basis}' = 'FILL_CONDITIONAL'
      then 'FILL_CONDITIONAL'
    else 'LEGACY_ATTEMPT_EV'
  end;

  if coalesce(new.engine_version, '') <> '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'
     or new.accounting_quality not in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
     or new.fee_accounting_quality not in (
       'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED'
     )
     or new.prediction_basis <> 'FILL_CONDITIONAL'
  then
    return null;
  end if;
  return new;
end;
$$;

-- Report only rows that were really inserted. The previous function counted every
-- attempted historical position, including rows rejected by the integrity trigger.
create or replace function public.backfill_lob_online_learning(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_result jsonb;
  v_count integer := 0;
begin
  for v_row in
    select p.id
      from public.trading_positions p
      left join public.lob_online_outcomes o on o.position_id = p.id
     where p.state = 'CLOSED'
       and not p.is_paper
       and p.metadata ? 'lob_signal'
       and coalesce(
         p.metadata #>> '{exit_residual_accounting,quality}',
         'LEGACY_UNVERIFIED'
       ) <> 'LEGACY_UNVERIFIED'
       and o.position_id is null
     order by p.closed_at asc
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    v_result := public.learn_lob_trade_outcome(v_row.id);
    if coalesce((v_result ->> 'updated')::boolean, false) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- The dashboard previously called residual-accounting-only rows "verified", even when
-- their fees and prediction basis were legacy. Match the exact policy-voting predicate.
create or replace function public.get_lob_policy_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with champion as (
    select * from public.lob_policy_versions
     where status = 'CHAMPION'
     order by version desc
     limit 1
  ), alternate as (
    select * from public.lob_policy_versions
     where status in ('CHALLENGER', 'CONTROL')
     order by version desc
     limit 1
  ), verified as (
    select *
      from public.lob_online_outcomes
     where engine_version = '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'
       and accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
       and fee_accounting_quality in (
         'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED'
       )
       and prediction_basis = 'FILL_CONDITIONAL'
  )
  select jsonb_build_object(
    'mode', 'EVIDENCE_SIZED_ACCOUNTING_VERIFIED_LIVE_VALIDATION',
    'phase', case
      when (select status from alternate) = 'CHALLENGER' then 'CHALLENGE'
      when (select status from alternate) = 'CONTROL' then 'CONFIRMATION'
      else 'IDLE'
    end,
    'champion', (select jsonb_build_object(
      'version', version,
      'status', status,
      'policy_definition', policy_definition,
      'source_online_version', source_online_version,
      'confirmed', confirmed_at is not null,
      'evaluation_started_at', evaluation_started_at,
      'metrics', metrics,
      'decision_reason', decision_reason,
      'updated_at', updated_at
    ) from champion),
    'alternate', (select jsonb_build_object(
      'version', version,
      'status', status,
      'parent_version', parent_version,
      'traffic_fraction', traffic_fraction,
      'policy_definition', policy_definition,
      'source_online_version', source_online_version,
      'evaluation_started_at', evaluation_started_at,
      'metrics', metrics,
      'decision_reason', decision_reason,
      'updated_at', updated_at
    ) from alternate),
    'verified_live_outcome_samples', (select count(*) from verified),
    'verified_champion_samples', (
      select count(*) from verified
       where policy_version = (select version from champion)
    ),
    'verified_alternate_samples', (
      select count(*) from verified
       where policy_version = (select version from alternate)
    ),
    'unverified_outcome_samples', (
      select count(*) from public.lob_online_outcomes
    ) - (select count(*) from verified),
    'last_verified_update_at', (select max(created_at) from verified)
  );
$$;

revoke all on function public.guard_lob_outcome_integrity_v610() from public, anon, authenticated;
revoke all on function public.backfill_lob_online_learning(integer) from public, anon, authenticated;
revoke all on function public.get_lob_policy_status() from public, anon, authenticated;
grant execute on function public.backfill_lob_online_learning(integer) to service_role;
grant execute on function public.get_lob_policy_status() to service_role;

-- Immediately recover qualifying completed trades that the old sentinel bug discarded.
select public.backfill_lob_online_learning(5000);
