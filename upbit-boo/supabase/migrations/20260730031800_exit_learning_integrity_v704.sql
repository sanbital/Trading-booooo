-- Trading-booooo v7.0.4-EXIT-LEARNING-INTEGRITY
--
-- Evidence-backed repairs only:
--   * preserve the semantic LOB exit reason instead of collapsing every full exit to STOP;
--   * admit current verified engine versions to online learning and learn momentum entries;
--   * enforce the operator's 20-30 second observation contract in persisted settings;
--   * remove record-only cash-flow rows that can be proved to be bot order settlement.
--
-- Exit thresholds and holding periods are intentionally unchanged. The new live cohort is
-- too small to distinguish a durable timing improvement from post-trade path noise.

create or replace function public.normalize_lob_exit_reason_v704(
  p_raw text,
  p_fallback text
)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when upper(coalesce(p_raw, '')) like '%TARGET_2%'
      or upper(coalesce(p_fallback, '')) = 'TARGET_2' then 'TARGET_2'
    when upper(coalesce(p_raw, '')) like '%TARGET_1%'
      or upper(coalesce(p_fallback, '')) = 'TARGET_1' then 'TARGET_1'
    when upper(coalesce(p_raw, '')) like '%TARGET_HIT%' then 'TARGET'
    when upper(coalesce(p_raw, '')) like '%LOB_INVALIDATION%' then 'LOB_INVALIDATION'
    when upper(coalesce(p_raw, '')) like '%SIGNAL_REVERSAL%' then 'SIGNAL_REVERSAL'
    when upper(coalesce(p_raw, '')) like '%TIMEOUT%'
      or lower(coalesce(p_raw, '')) like '%maximum holding time%' then 'TIMEOUT'
    when upper(coalesce(p_raw, '')) like '%LIQUIDITY_EVENT%'
      or lower(coalesce(p_raw, '')) like 'rotation:%' then 'LIQUIDITY_EVENT'
    when upper(coalesce(p_raw, '')) like '%LOB_REVERSAL%'
      or lower(coalesce(p_raw, '')) like 'live_hold:%' then 'LOB_REVERSAL'
    when upper(coalesce(p_raw, '')) like '%RECONCILIATION%' then 'RECONCILIATION_FAILURE'
    when upper(coalesce(p_raw, '')) like '%EMERGENCY%' then 'RISK_EMERGENCY'
    when upper(coalesce(p_raw, '')) like '%STOP%'
      or upper(coalesce(p_fallback, '')) = 'STOP' then 'STOP'
    else upper(coalesce(nullif(p_fallback, ''), 'UNKNOWN'))
  end
$$;

create or replace function public.label_trading_exit_reason_v704()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw text;
  v_reason text;
begin
  if new.state <> 'CLOSED' then
    return new;
  end if;

  v_raw := coalesce(
    nullif(new.metadata ->> 'exit_reason_raw', ''),
    nullif(new.metadata ->> 'pending_exit_reason', ''),
    nullif(new.close_reason, '')
  );
  v_reason := public.normalize_lob_exit_reason_v704(v_raw, new.close_reason);

  new.metadata := jsonb_set(
    jsonb_set(
      coalesce(new.metadata, '{}'::jsonb),
      '{exit_reason_raw}',
      to_jsonb(coalesce(v_raw, 'UNKNOWN')),
      true
    ),
    '{pending_exit_reason}',
    to_jsonb(v_reason),
    true
  );
  new.close_reason := v_reason;
  return new;
end;
$$;

drop trigger if exists label_trading_exit_reason_v704 on public.trading_positions;
create trigger label_trading_exit_reason_v704
before insert or update
on public.trading_positions
for each row
when (new.state = 'CLOSED')
execute function public.label_trading_exit_reason_v704();

-- Repair prior full-exit labels only where the raw reason is durably present.
update public.trading_positions
set metadata = metadata,
    updated_at = updated_at
where state = 'CLOSED'
  and metadata ? 'pending_exit_reason'
  and public.normalize_lob_exit_reason_v704(
    metadata ->> 'pending_exit_reason',
    close_reason
  ) is distinct from close_reason;

-- The previous trigger enumerated two exact release strings, silently rejecting every
-- verified outcome after the engine moved to v7. Parse semver and retain all accounting,
-- fee and prediction-basis gates.
create or replace function public.guard_lob_outcome_integrity_v610()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.trading_positions%rowtype;
  v_semver text[];
  v_engine_trusted boolean := false;
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

  v_semver := regexp_match(coalesce(new.engine_version, ''), '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)');
  if v_semver is not null then
    v_engine_trusted :=
      v_semver[1]::integer > 6
      or (v_semver[1]::integer = 6 and v_semver[2]::integer >= 10);
  end if;

  if not v_engine_trusted
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

alter table public.lob_online_outcomes
  drop constraint if exists lob_online_outcomes_pattern_check;
alter table public.lob_online_outcomes
  add constraint lob_online_outcomes_pattern_check check (
    pattern in (
      'OFI_CONTINUATION',
      'ABSORPTION_REVERSAL',
      'SWEEP_RECLAIM',
      'QUEUE_DEPLETION_BREAKOUT',
      'REPLENISHMENT_ICEBERG',
      'MOMENTUM_CONTINUATION'
    )
  ) not valid;
alter table public.lob_online_outcomes
  validate constraint lob_online_outcomes_pattern_check;

alter table public.lob_market_profiles
  drop constraint if exists lob_market_profiles_pattern_check;
alter table public.lob_market_profiles
  add constraint lob_market_profiles_pattern_check check (
    pattern in (
      'OFI_CONTINUATION',
      'ABSORPTION_REVERSAL',
      'SWEEP_RECLAIM',
      'QUEUE_DEPLETION_BREAKOUT',
      'REPLENISHMENT_ICEBERG',
      'MOMENTUM_CONTINUATION'
    )
  ) not valid;
alter table public.lob_market_profiles
  validate constraint lob_market_profiles_pattern_check;

-- Extend the existing audited learner without duplicating its profile update logic.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.learn_lob_trade_outcome(uuid)'::regprocedure
  );
  v_updated := v_definition;
  if position('MOMENTUM_CONTINUATION' in v_updated) = 0 then
    v_updated := replace(
      v_updated,
      $needle$    'REPLENISHMENT_ICEBERG'
  )$needle$,
      $replacement$    'REPLENISHMENT_ICEBERG',
    'MOMENTUM_CONTINUATION'
  )$replacement$
    );
  end if;
  if position('v_pattern is null or v_pattern not in' in v_updated) = 0 then
    v_updated := replace(
      v_updated,
      '  if v_pattern not in (',
      '  if v_pattern is null or v_pattern not in ('
    );
  end if;
  if v_updated <> v_definition then
    execute v_updated;
  end if;
end
$$;

-- Make policy status use the same semver trust cohort as the ingestion guard.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef(
    'public.get_lob_policy_status()'::regprocedure
  );
  v_updated := replace(
    v_definition,
    $needle$where engine_version in (
       '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE',
       '6.11.0-CONTINUOUS-ADAPTIVE-EXECUTION'
     )$needle$,
    $replacement$where (
       (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[1]::integer > 6
       or (
         (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[1]::integer = 6
         and (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[2]::integer >= 10
       )
     )$replacement$
  );
  v_updated := replace(
    v_updated,
    $needle$where engine_version = '6.10.0-JOINT-COMPOUND-GROWTH-GOVERNANCE'$needle$,
    $replacement$where (
       (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[1]::integer > 6
       or (
         (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[1]::integer = 6
         and (regexp_match(engine_version, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)'))[2]::integer >= 10
       )
     )$replacement$
  );
  if v_updated <> v_definition then
    execute v_updated;
  end if;
end
$$;

revoke all on function public.normalize_lob_exit_reason_v704(text, text)
  from public, anon, authenticated;
revoke all on function public.label_trading_exit_reason_v704()
  from public, anon, authenticated;
revoke all on function public.guard_lob_outcome_integrity_v610()
  from public, anon, authenticated;
revoke all on function public.learn_lob_trade_outcome(uuid)
  from public, anon, authenticated;
grant execute on function public.learn_lob_trade_outcome(uuid) to service_role;

-- Recover only outcomes that pass the unchanged accounting-integrity trigger.
select public.backfill_lob_online_learning(5000);

alter table public.trading_settings
  alter column lob_observation_window_ms set default 20000;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_search_v6130;
alter table public.trading_settings
  drop constraint if exists trading_settings_lob_adaptive_search_v704;
alter table public.trading_settings
  add constraint trading_settings_lob_adaptive_search_v704 check (
    lob_search_base_finalists between 4 and 20
    and lob_search_max_finalists between lob_search_base_finalists and 20
    and lob_search_base_observation_ms between 20000 and 30000
    and lob_search_max_observation_ms between lob_search_base_observation_ms and 30000
    and lob_search_rotation_pool between lob_search_max_finalists and 120
    and lob_search_rotation_minutes between 1 and 30
    and lob_search_state_fresh_minutes between 5 and 120
  ) not valid;

update public.trading_settings
set lob_observation_window_ms = greatest(20000, least(30000, lob_observation_window_ms)),
    lob_search_base_observation_ms = greatest(20000, least(30000, lob_search_base_observation_ms)),
    lob_search_max_observation_ms = greatest(
      greatest(20000, least(30000, lob_search_base_observation_ms)),
      greatest(20000, least(30000, lob_search_max_observation_ms))
    ),
    version = version + 1
where id = 1;

alter table public.trading_settings
  validate constraint trading_settings_lob_adaptive_search_v704;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_observation_v704;
alter table public.trading_settings
  add constraint trading_settings_lob_observation_v704 check (
    lob_observation_window_ms between 20000 and 30000
    and lob_search_base_observation_ms between 20000 and 30000
    and lob_search_max_observation_ms between lob_search_base_observation_ms and 30000
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_observation_v704;

-- Delete only rows whose amount and direction exactly reconcile to a nearby APPLIED bot
-- order. This is evidence of timestamp attribution lag, not a user deposit/withdrawal.
delete from public.trading_cash_flows cf
where cf.detected_at >= timestamptz '2026-07-30 00:08:00+00'
  and cf.details ->> 'detection_mode' = 'RECORD_ONLY'
  and exists (
    select 1
    from public.trading_orders o
    where o.exchange = cf.exchange
      and o.state = 'APPLIED'
      and coalesce(o.completed_at, o.updated_at, o.created_at)
        between cf.detected_at - interval '30 seconds' and cf.detected_at + interval '10 seconds'
      and (
        (
          cf.flow_type = 'EXTERNAL_DECREASE'
          and o.side = 'BUY'
          and abs(cf.amount_quote - (o.executed_funds_quote + o.paid_fee_quote))
            <= greatest(0.01, cf.amount_quote * 0.000001)
        )
        or
        (
          cf.flow_type = 'EXTERNAL_INCREASE'
          and o.side = 'SELL'
          and abs(cf.amount_quote - (o.executed_funds_quote - o.paid_fee_quote))
            <= greatest(0.01, cf.amount_quote * 0.000001)
        )
      )
  );

do $$
begin
  if public.normalize_lob_exit_reason_v704('LOB:TIMEOUT', 'STOP') <> 'TIMEOUT'
     or public.normalize_lob_exit_reason_v704('LOB:LOB_INVALIDATION', 'STOP') <> 'LOB_INVALIDATION'
     or public.normalize_lob_exit_reason_v704('maximum holding time reached', 'STOP') <> 'TIMEOUT'
  then
    raise exception 'exit reason normalization regression';
  end if;
end
$$;
