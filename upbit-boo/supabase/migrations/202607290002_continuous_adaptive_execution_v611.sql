-- v6.11.0: continuous adaptive execution.
--
-- 1. Upbit entries are never submitted below the operator-required KRW 40,000 floor.
-- 2. The KST-midnight daily loss circuit is the sole automatic global entry stop.
-- 3. Legacy infrastructure/reconciliation pauses are cleared during the rolling deploy.
-- 4. Verified learning accepts both the predecessor cohort and this release cohort.

alter table public.trading_settings
  alter column min_order_krw set default 40000;

update public.trading_settings
   set min_order_krw = greatest(coalesce(min_order_krw, 0), 40000),
       max_order_krw = greatest(coalesce(max_order_krw, 0), 40000),
       max_daily_buy_krw = greatest(coalesce(max_daily_buy_krw, 0), 40000),
       scalp_daily_loss_pct = 30,
       lob_max_spread_bps = 60,
       version = version + 1
 where id = 1;

alter table public.trading_settings
  drop constraint if exists trading_settings_min_order_krw_v611;
alter table public.trading_settings
  add constraint trading_settings_min_order_krw_v611
  check (min_order_krw >= 40000) not valid;
alter table public.trading_settings
  validate constraint trading_settings_min_order_krw_v611;

update public.trading_settings
   set pause_new_entries = false,
       manual_intervention_required = false,
       manual_event_reason = null,
       gateway_error_count = 0,
       gateway_recovery_cycles = 0,
       last_resume_at = now(),
       version = version + 1
 where id = 1
   and (
     manual_event_reason = 'SAFETY_GATEWAY_UNAVAILABLE'
     or manual_event_reason like 'RECONCILIATION_FAILED:%'
     or manual_event_reason like 'SAFETY_POSITION_MISMATCH:%'
   );

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

  if coalesce(new.engine_version, '') not in (
       '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE',
       '6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'
     )
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
     where engine_version in (
       '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE',
       '6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'
     )
       and accounting_quality in ('NO_RESIDUAL', 'RESIDUAL_MARKED_TO_EXIT')
       and fee_accounting_quality in (
         'EXACT', 'AGGREGATE_EXACT', 'THIRD_ASSET_MARKED', 'BASE_ASSET_ACCOUNTED'
       )
       and prediction_basis = 'FILL_CONDITIONAL'
  )
  select jsonb_build_object(
    'mode', 'CONTINUOUS_ADAPTIVE_ACCOUNTING_VERIFIED_LIVE_VALIDATION',
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

revoke all on function public.guard_lob_outcome_integrity_v610()
  from public, anon, authenticated;
revoke all on function public.get_lob_policy_status()
  from public, anon, authenticated;
grant execute on function public.get_lob_policy_status() to service_role;

comment on column public.trading_settings.min_order_krw is
  'Operator floor: every submitted Upbit KRW buy must be at least KRW 40,000.';
comment on column public.trading_settings.scalp_daily_loss_pct is
  'Sole automatic global entry stop: fee-net realized plus marked loss against the first KST-midnight total-equity snapshot.';
