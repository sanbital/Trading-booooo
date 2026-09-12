-- Trading-booooo v5.12.0 — conservative outcome gate and fail-closed reconciliation.
--
-- Frequency can increase only through capacity. EV / win probability / fill probability,
-- liquidity, exposure and loss limits are immutable quality gates.

alter table public.trading_settings
  add column if not exists scalp_strategy_profile text not null default 'HF_SCALP',
  add column if not exists scalp_min_win_probability_lcb numeric not null default 0.50,
  add column if not exists scalp_min_fill_probability_lcb numeric not null default 0.30,
  add column if not exists scalp_min_forecast_samples integer not null default 60,
  add column if not exists scalp_min_independent_blocks integer not null default 3,
  add column if not exists scalp_target_utilization numeric not null default 0.70,
  add column if not exists scalp_min_position_slots integer not null default 2,
  add column if not exists scalp_max_position_slots integer not null default 12,
  add column if not exists scalp_scan_universe integer not null default 60,
  add column if not exists scalp_min_scan_universe integer not null default 30,
  add column if not exists scalp_max_scan_universe integer not null default 240,
  add column if not exists scalp_average_holding_minutes numeric not null default 15;

alter table public.trading_settings drop constraint if exists trading_settings_scalp_strategy_profile_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_win_lcb_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_fill_lcb_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_forecast_samples_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_blocks_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_utilization_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_slots_v512_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_universe_ck;
alter table public.trading_settings drop constraint if exists trading_settings_scalp_holding_ck;
alter table public.trading_settings
  add constraint trading_settings_scalp_strategy_profile_ck
    check (scalp_strategy_profile in ('HF_SCALP','INTRADAY_SCALP')) not valid,
  add constraint trading_settings_scalp_win_lcb_ck
    check (scalp_min_win_probability_lcb >= 0.50 and scalp_min_win_probability_lcb <= 0.95) not valid,
  add constraint trading_settings_scalp_fill_lcb_ck
    check (scalp_min_fill_probability_lcb >= 0.05 and scalp_min_fill_probability_lcb <= 0.95) not valid,
  add constraint trading_settings_scalp_forecast_samples_ck
    check (scalp_min_forecast_samples between 0 and 20000) not valid,
  add constraint trading_settings_scalp_blocks_ck
    check (scalp_min_independent_blocks between 0 and 1000) not valid,
  add constraint trading_settings_scalp_utilization_ck
    check (scalp_target_utilization >= 0.10 and scalp_target_utilization <= 0.95) not valid,
  add constraint trading_settings_scalp_slots_v512_ck
    check (scalp_min_position_slots between 1 and 20 and scalp_max_position_slots between scalp_min_position_slots and 20) not valid,
  add constraint trading_settings_scalp_universe_ck
    check (scalp_min_scan_universe between 10 and 1000 and scalp_scan_universe between 10 and 1000 and scalp_max_scan_universe between scalp_min_scan_universe and 1000) not valid,
  add constraint trading_settings_scalp_holding_ck
    check (scalp_average_holding_minutes between 1 and 1440) not valid;

alter table public.trading_settings validate constraint trading_settings_scalp_strategy_profile_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_win_lcb_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_fill_lcb_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_forecast_samples_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_blocks_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_utilization_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_slots_v512_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_universe_ck;
alter table public.trading_settings validate constraint trading_settings_scalp_holding_ck;

-- The controller may reserve more attempts per scan, but it cannot increase total exposure.
alter table public.trading_settings drop constraint if exists trading_settings_max_new_entries_per_scan_ck;
alter table public.trading_settings
  add constraint trading_settings_max_new_entries_per_scan_ck
    check (max_new_entries_per_scan between 1 and 12) not valid;
alter table public.trading_settings validate constraint trading_settings_max_new_entries_per_scan_ck;

-- Disable the v5.10/v5.11 live quality bypasses and force a fresh PAPER validation.
-- LIVE_LIMITED must be explicitly re-approved after the v5.12 deploy.
update public.trading_settings
   set mode = 'PAPER',
       scalp_rate_relaxation = 0,
       scalp_rate_max_relaxation = 0,
       scalp_exploration_per_day = 0,
       scalp_exploration_per_scan = 0,
       scalp_strategy_profile = coalesce(scalp_strategy_profile, 'HF_SCALP'),
       scalp_max_holding_minutes = least(greatest(coalesce(scalp_max_holding_minutes, 30), 5), 30),
       scalp_safety_ttl_minutes = least(greatest(coalesce(scalp_safety_ttl_minutes, 30), 5), 30),
       updated_at = now()
 where id = 1;

-- Extend the position state machine with explicit reconciliation failure states.
do $$
declare r record;
begin
  for r in
    select conname
      from pg_constraint
     where conrelid = 'public.trading_positions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%ENTRY_PENDING%'
       and pg_get_constraintdef(oid) like '%EXITING%'
  loop
    execute format('alter table public.trading_positions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.trading_positions drop constraint if exists trading_positions_state_v512_ck;
alter table public.trading_positions
  add constraint trading_positions_state_v512_ck check (state in (
    'ENTRY_PENDING','OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED',
    'MANUAL_INTERVENTION_REQUIRED','CLOSED','CANCELLED','ERROR'
  )) not valid;
alter table public.trading_positions validate constraint trading_positions_state_v512_ck;

drop index if exists public.trading_one_active_exchange_market_position;
create unique index trading_one_active_exchange_market_position
  on public.trading_positions(exchange, market)
  where state in ('ENTRY_PENDING','OPEN','EXITING','RECONCILING','RECONCILIATION_FAILED','MANUAL_INTERVENTION_REQUIRED');

-- Keep shadow replay explicitly lower-trust than actual fills.
alter table public.scalp_shadow_outcomes
  add column if not exists label_source text not null default 'SHADOW_REPLAY',
  add column if not exists execution_cost_quality text not null default 'ESTIMATED',
  add column if not exists fill_label_quality text not null default 'SIMULATED',
  add column if not exists predicted_p_target numeric,
  add column if not exists predicted_p_stop numeric,
  add column if not exists predicted_p_timeout numeric,
  add column if not exists predicted_p_fill numeric,
  add column if not exists timeout_positive_probability numeric,
  add column if not exists expected_holding_minutes numeric,
  add column if not exists model_version text,
  add column if not exists calibration_version text,
  add column if not exists estimated_ev numeric,
  add column if not exists estimated_ev_lcb numeric,
  add column if not exists predicted_p_win_lcb numeric,
  add column if not exists predicted_p_fill_lcb numeric;

alter table public.scalp_shadow_outcomes drop constraint if exists scalp_shadow_outcomes_label_source_ck;
alter table public.scalp_shadow_outcomes drop constraint if exists scalp_shadow_outcomes_execution_quality_ck;
alter table public.scalp_shadow_outcomes drop constraint if exists scalp_shadow_outcomes_fill_quality_ck;
alter table public.scalp_shadow_outcomes
  add constraint scalp_shadow_outcomes_label_source_ck
    check (label_source in ('ACTUAL_TRADE','SHADOW_REPLAY','MIXED','PRIOR')) not valid,
  add constraint scalp_shadow_outcomes_execution_quality_ck
    check (execution_cost_quality in ('ACTUAL','ESTIMATED','STRESSED')) not valid,
  add constraint scalp_shadow_outcomes_fill_quality_ck
    check (fill_label_quality in ('ACTUAL','SIMULATED','UNKNOWN')) not valid;
alter table public.scalp_shadow_outcomes validate constraint scalp_shadow_outcomes_label_source_ck;
alter table public.scalp_shadow_outcomes validate constraint scalp_shadow_outcomes_execution_quality_ck;
alter table public.scalp_shadow_outcomes validate constraint scalp_shadow_outcomes_fill_quality_ck;

comment on column public.scalp_shadow_outcomes.execution_cost_quality is
  'SHADOW_REPLAY has no actual fill price. Actual commission/slippage samples must take precedence for promotion.';
