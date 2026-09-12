-- v6.13.0 REALIZED-EDGE + PROFIT-RETENTION
--
-- Mission:
--   improve fee-net PnL, profitable-trade rate and opportunity-normalized activity together.
--
-- Anti-gaming invariants:
--   * low activity NEVER lowers EV, payoff, direction or execution-quality requirements;
--   * zero qualified opportunities after adequate search is SEARCH_FAILURE, not activity success;
--   * candidate-local negative evidence raises the EV burden or enters a bounded revalidation lane;
--   * no global economic stop is introduced. The operator's KST daily -30% circuit remains intact.
--
-- Profit-retention invariants:
--   * once MFE covers costs, the stop can only rise;
--   * profit protection is evaluated from the live peak update returned to the same monitor cycle;
--   * no market order, leverage, withdrawal, transfer or derivatives route is added.

alter table public.trading_settings
  add column if not exists lob_model_revision text not null default '6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
  add column if not exists lob_profit_protect_enabled boolean not null default true,
  add column if not exists lob_profit_protect_min_hold_seconds integer not null default 3,
  add column if not exists lob_profit_protect_breakeven_trigger_bps numeric not null default 18,
  add column if not exists lob_profit_protect_cost_buffer_bps_upbit numeric not null default 12,
  add column if not exists lob_profit_protect_cost_buffer_bps_binance numeric not null default 12,
  add column if not exists lob_profit_lock_trigger_bps numeric not null default 30,
  add column if not exists lob_profit_lock_net_bps numeric not null default 5,
  add column if not exists lob_profit_trail_trigger_bps numeric not null default 40,
  add column if not exists lob_profit_trail_distance_bps numeric not null default 15,
  add column if not exists lob_regime_min_samples integer not null default 8,
  add column if not exists lob_regime_full_samples integer not null default 30,
  add column if not exists lob_regime_parent_start_samples integer not null default 20,
  add column if not exists lob_regime_parent_full_samples integer not null default 100,
  add column if not exists lob_regime_bad_mean_bps numeric not null default -5,
  add column if not exists lob_regime_bad_profit_factor numeric not null default 0.80,
  add column if not exists lob_regime_bad_zero_mfe_rate numeric not null default 0.55,
  add column if not exists lob_regime_ev_penalty_cap_bps numeric not null default 20,
  add column if not exists lob_regime_revalidation_min_ev_bps numeric not null default 1,
  add column if not exists lob_regime_revalidation_min_quality numeric not null default 0.60,
  add column if not exists lob_regime_revalidation_max_spread_bps numeric not null default 5,
  add column if not exists lob_regime_revalidation_max_concurrent integer not null default 1,
  add column if not exists lob_regime_revalidation_max_entries_per_day integer not null default 3,
  add column if not exists lob_search_min_attempts_hourly integer not null default 40,
  add column if not exists lob_search_min_attempts_daily integer not null default 200,
  add column if not exists lob_search_min_attempts_weekly integer not null default 800,
  add column if not exists lob_search_failure boolean not null default false,
  add column if not exists lob_search_failure_streak integer not null default 0,
  add column if not exists lob_search_last_evaluated_at timestamptz;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_realized_edge_v6130;
alter table public.trading_settings
  add constraint trading_settings_lob_realized_edge_v6130 check (
    lob_profit_protect_min_hold_seconds between 0 and 60
    and lob_profit_protect_breakeven_trigger_bps between 5 and 100
    and lob_profit_protect_cost_buffer_bps_upbit between 0 and 50
    and lob_profit_protect_cost_buffer_bps_binance between 0 and 50
    and lob_profit_lock_trigger_bps >= lob_profit_protect_breakeven_trigger_bps
    and lob_profit_lock_net_bps between 0 and 50
    and lob_profit_trail_trigger_bps >= lob_profit_lock_trigger_bps
    and lob_profit_trail_distance_bps between 3 and 100
    and lob_regime_min_samples between 3 and 100
    and lob_regime_full_samples >= lob_regime_min_samples
    and lob_regime_parent_start_samples between 3 and 200
    and lob_regime_parent_full_samples >= lob_regime_parent_start_samples
    and lob_regime_bad_profit_factor between 0 and 2
    and lob_regime_bad_zero_mfe_rate between 0 and 1
    and lob_regime_ev_penalty_cap_bps between 0 and 100
    and lob_regime_revalidation_min_ev_bps > 0
    and lob_regime_revalidation_min_quality between 0 and 1
    and lob_regime_revalidation_max_spread_bps between 1 and lob_max_spread_bps
    and lob_regime_revalidation_max_concurrent between 1 and 3
    and lob_regime_revalidation_max_entries_per_day between 1 and 20
    and lob_search_min_attempts_hourly between 1 and 10000
    and lob_search_min_attempts_daily >= lob_search_min_attempts_hourly
    and lob_search_min_attempts_weekly >= lob_search_min_attempts_daily
    and lob_search_failure_streak >= 0
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_realized_edge_v6130;

update public.trading_settings
   set lob_model_revision = '6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
       lob_profit_protect_enabled = true,
       lob_profit_protect_min_hold_seconds = 3,
       lob_profit_protect_breakeven_trigger_bps = 18,
       lob_profit_protect_cost_buffer_bps_upbit = 12,
       lob_profit_protect_cost_buffer_bps_binance = 12,
       lob_profit_lock_trigger_bps = 30,
       lob_profit_lock_net_bps = 5,
       lob_profit_trail_trigger_bps = 40,
       lob_profit_trail_distance_bps = 15,
       lob_regime_min_samples = 8,
       lob_regime_full_samples = 30,
       lob_regime_parent_start_samples = 20,
       lob_regime_parent_full_samples = 100,
       lob_regime_bad_mean_bps = -5,
       lob_regime_bad_profit_factor = 0.80,
       lob_regime_bad_zero_mfe_rate = 0.55,
       lob_regime_ev_penalty_cap_bps = 20,
       lob_regime_revalidation_min_ev_bps = 1,
       lob_regime_revalidation_min_quality = 0.60,
       lob_regime_revalidation_max_spread_bps = 5,
       lob_regime_revalidation_max_concurrent = 1,
       lob_regime_revalidation_max_entries_per_day = 3,
       lob_search_min_attempts_hourly = 40,
       lob_search_min_attempts_daily = 200,
       lob_search_min_attempts_weekly = 800,
       -- Undo only the old activity-deficit relaxation. Economic requirements are no longer
       -- modified by a trade-count shortfall.
       lob_core_min_opportunity_score = greatest(coalesce(lob_core_min_opportunity_score,0.24),0.24),
       lob_exploration_min_opportunity_score = greatest(coalesce(lob_exploration_min_opportunity_score,0.38),0.38),
       lob_min_net_reward_risk_ratio = greatest(coalesce(lob_min_net_reward_risk_ratio,0.80),0.80),
       lob_exploration_min_net_rr = greatest(coalesce(lob_exploration_min_net_rr,0.90),0.90),
       lob_live_admission_revision = '6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
       version = version + 1,
       updated_at = now()
 where id = 1;

create or replace function public.lob_regime_key_v6130(p_signal jsonb)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  f jsonb := coalesce(p_signal -> 'features', p_signal #> '{scanned_lob,features}', '{}'::jsonb);
  q numeric := coalesce(public.safe_numeric_v6112(f ->> 'dataQuality'),0);
  pressure numeric := coalesce(public.safe_numeric_v6112(f ->> 'tradePressureFast'),0);
  micro numeric := coalesce(public.safe_numeric_v6112(f ->> 'micropriceDeviationBps'),0);
  imbalance numeric := coalesce(public.safe_numeric_v6112(f ->> 'bookImbalance'),0);
  spread numeric := coalesce(public.safe_numeric_v6112(f ->> 'spreadBps'),999);
  votes integer := 0;
  q_bucket text;
  d_bucket text;
  s_bucket text;
begin
  votes := (case when pressure > 0 then 1 else 0 end)
         + (case when micro > 0 then 1 else 0 end)
         + (case when imbalance > 0 then 1 else 0 end);
  q_bucket := case when q < 0.30 then 'Q_LOW' when q < 0.60 then 'Q_MID' else 'Q_HIGH' end;
  d_bucket := case when votes >= 3 then 'DIR_3' when votes = 2 then 'DIR_2' else 'DIR_0_1' end;
  s_bucket := case when spread <= 5 then 'SP_TIGHT' when spread <= 12 then 'SP_NORMAL' else 'SP_WIDE' end;
  return q_bucket || '|' || d_bucket || '|' || s_bucket;
end;
$$;

create table if not exists public.lob_realized_regime_profiles (
  exchange text not null,
  pattern text not null,
  regime_key text not null,
  samples integer not null default 0,
  wins integer not null default 0,
  gross_profit_bps numeric not null default 0,
  gross_loss_bps numeric not null default 0,
  mean_net_bps numeric not null default 0,
  profit_factor numeric not null default 0,
  zero_mfe_rate numeric not null default 0,
  giveback_rate numeric not null default 0,
  mfe_p50_bps numeric not null default 0,
  mfe_p75_bps numeric not null default 0,
  winner_mae_p75_bps numeric not null default 0,
  revision text not null default '6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
  updated_at timestamptz not null default now(),
  primary key(exchange,pattern,regime_key)
);
create index if not exists lob_realized_regime_profiles_lookup_idx
  on public.lob_realized_regime_profiles(exchange,pattern,samples desc,updated_at desc);
alter table public.lob_realized_regime_profiles enable row level security;
revoke all on table public.lob_realized_regime_profiles from anon,authenticated;

create or replace function public.refresh_lob_realized_regime_profile_v6130(
  p_exchange text,
  p_pattern text,
  p_regime_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with source_rows as (
    select
      o.net_bps,
      greatest(0,o.mfe_bps) as mfe_bps,
      greatest(0,o.mae_bps) as mae_bps,
      o.profitable
    from public.lob_online_outcomes o
    where lower(o.exchange)=lower(p_exchange)
      and o.pattern=p_pattern
      and (p_regime_key='*' or public.lob_regime_key_v6130(o.entry_snapshot)=p_regime_key)
      and o.accounting_quality in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
      and o.fee_accounting_quality in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
  ), agg as (
    select
      count(*)::integer as samples,
      count(*) filter(where profitable)::integer as wins,
      coalesce(sum(greatest(net_bps,0)),0) as gross_profit_bps,
      coalesce(sum(greatest(-net_bps,0)),0) as gross_loss_bps,
      coalesce(avg(net_bps),0) as mean_net_bps,
      coalesce(avg(case when mfe_bps <= 1 then 1.0 else 0.0 end),0) as zero_mfe_rate,
      coalesce(avg(case when mfe_bps >= 15 and net_bps <= 0 then 1.0 else 0.0 end),0) as giveback_rate,
      coalesce(percentile_cont(0.50) within group(order by mfe_bps),0) as mfe_p50_bps,
      coalesce(percentile_cont(0.75) within group(order by mfe_bps),0) as mfe_p75_bps,
      coalesce(percentile_cont(0.75) within group(order by mae_bps) filter(where profitable),0) as winner_mae_p75_bps
    from source_rows
  )
  insert into public.lob_realized_regime_profiles(
    exchange,pattern,regime_key,samples,wins,gross_profit_bps,gross_loss_bps,
    mean_net_bps,profit_factor,zero_mfe_rate,giveback_rate,mfe_p50_bps,mfe_p75_bps,
    winner_mae_p75_bps,revision,updated_at
  )
  select lower(p_exchange),p_pattern,p_regime_key,samples,wins,gross_profit_bps,gross_loss_bps,
         mean_net_bps,
         case when gross_loss_bps>0 then gross_profit_bps/gross_loss_bps
              when gross_profit_bps>0 then 999 else 0 end,
         zero_mfe_rate,giveback_rate,mfe_p50_bps,mfe_p75_bps,winner_mae_p75_bps,
         '6.13.0-REALIZED-EDGE-PROFIT-RETENTION',now()
  from agg where samples>0
  on conflict(exchange,pattern,regime_key) do update set
    samples=excluded.samples,wins=excluded.wins,gross_profit_bps=excluded.gross_profit_bps,
    gross_loss_bps=excluded.gross_loss_bps,mean_net_bps=excluded.mean_net_bps,
    profit_factor=excluded.profit_factor,zero_mfe_rate=excluded.zero_mfe_rate,
    giveback_rate=excluded.giveback_rate,mfe_p50_bps=excluded.mfe_p50_bps,
    mfe_p75_bps=excluded.mfe_p75_bps,winner_mae_p75_bps=excluded.winner_mae_p75_bps,
    revision=excluded.revision,updated_at=now()
  returning samples into v_count;

  if v_count=0 then
    delete from public.lob_realized_regime_profiles
     where exchange=lower(p_exchange) and pattern=p_pattern and regime_key=p_regime_key;
  end if;
end;
$$;

create or replace function public.on_lob_online_outcome_regime_v6130()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_key text;
  old_key text;
begin
  new_key := public.lob_regime_key_v6130(new.entry_snapshot);
  perform public.refresh_lob_realized_regime_profile_v6130(new.exchange,new.pattern,new_key);
  perform public.refresh_lob_realized_regime_profile_v6130(new.exchange,new.pattern,'*');
  if tg_op='UPDATE' then
    old_key := public.lob_regime_key_v6130(old.entry_snapshot);
    if lower(old.exchange)<>lower(new.exchange) or old.pattern<>new.pattern or old_key<>new_key then
      perform public.refresh_lob_realized_regime_profile_v6130(old.exchange,old.pattern,old_key);
      perform public.refresh_lob_realized_regime_profile_v6130(old.exchange,old.pattern,'*');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lob_online_outcomes_regime_v6130 on public.lob_online_outcomes;
create trigger lob_online_outcomes_regime_v6130
after insert or update of net_bps,profitable,mfe_bps,mae_bps,entry_snapshot
on public.lob_online_outcomes
for each row execute function public.on_lob_online_outcome_regime_v6130();

-- Backfill exact regimes and exchange-pattern parents from verified fee-net outcomes.
with keys as (
  select distinct lower(exchange) exchange,pattern,public.lob_regime_key_v6130(entry_snapshot) regime_key
  from public.lob_online_outcomes
  where accounting_quality in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
    and fee_accounting_quality in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
)
select public.refresh_lob_realized_regime_profile_v6130(exchange,pattern,regime_key) from keys;
with parents as (
  select distinct lower(exchange) exchange,pattern
  from public.lob_online_outcomes
  where accounting_quality in ('NO_RESIDUAL','RESIDUAL_MARKED_TO_EXIT')
    and fee_accounting_quality in ('EXACT','AGGREGATE_EXACT','THIRD_ASSET_MARKED','BASE_ASSET_ACCOUNTED')
)
select public.refresh_lob_realized_regime_profile_v6130(exchange,pattern,'*') from parents;

create or replace function public.enforce_lob_realized_edge_v6130()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  f jsonb;
  v_pattern text;
  v_regime text;
  exact_profile public.lob_realized_regime_profiles%rowtype;
  parent_profile public.lob_realized_regime_profiles%rowtype;
  v_exact_weight numeric := 0;
  v_parent_weight numeric := 0;
  v_evidence_weight numeric := 0;
  v_mean numeric := 0;
  v_pf numeric := 0;
  v_zero_mfe numeric := 0;
  v_giveback numeric := 0;
  v_current_ev numeric;
  v_base_required_ev numeric := 0;
  v_required_ev numeric := 0;
  v_penalty numeric := 0;
  v_quality numeric := 0;
  v_spread numeric := 999;
  v_pressure numeric := 0;
  v_micro numeric := 0;
  v_imbalance numeric := 0;
  v_votes integer := 0;
  v_probability_edge numeric := -1;
  v_bad_profile boolean := false;
  v_strong_revalidation boolean := false;
  v_active_revalidations integer := 0;
  v_today_revalidations integer := 0;
  v_lane text := 'STANDARD';
  v_day date;
begin
  if new.is_paper is distinct from false or new.state<>'ENTRY_PENDING' then return new; end if;
  signal := coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found then return new; end if;

  f := coalesce(signal->'features','{}'::jsonb);
  v_pattern := upper(coalesce(signal->>'pattern','UNKNOWN'));
  v_regime := public.lob_regime_key_v6130(signal);
  v_current_ev := coalesce(
    public.safe_numeric_v6112(signal->>'attempt_ev_lower_bound_bps'),
    public.safe_numeric_v6112(signal->>'conditional_ev_lower_bound_bps')
  );
  v_quality := coalesce(public.safe_numeric_v6112(f->>'dataQuality'),0);
  v_spread := coalesce(public.safe_numeric_v6112(new.metadata->>'live_spread_bps'),public.safe_numeric_v6112(f->>'spreadBps'),999);
  v_pressure := coalesce(public.safe_numeric_v6112(f->>'tradePressureFast'),0);
  v_micro := coalesce(public.safe_numeric_v6112(f->>'micropriceDeviationBps'),0);
  v_imbalance := coalesce(public.safe_numeric_v6112(f->>'bookImbalance'),0);
  v_votes := (case when v_pressure>0 then 1 else 0 end)
           + (case when v_micro>0 then 1 else 0 end)
           + (case when v_imbalance>0 then 1 else 0 end);
  v_probability_edge := coalesce(public.safe_numeric_v6112(signal->>'p_target'),0)
                      - coalesce(public.safe_numeric_v6112(signal->>'p_stop'),1);

  select * into exact_profile from public.lob_realized_regime_profiles
   where exchange=lower(new.exchange) and pattern=v_pattern and regime_key=v_regime;
  select * into parent_profile from public.lob_realized_regime_profiles
   where exchange=lower(new.exchange) and pattern=v_pattern and regime_key='*';

  v_exact_weight := case when coalesce(exact_profile.samples,0)>0
    then exact_profile.samples::numeric/(exact_profile.samples+12) else 0 end;
  v_parent_weight := case when coalesce(parent_profile.samples,0)<cfg.lob_regime_parent_start_samples then 0
    else 0.50*least(1,(parent_profile.samples-cfg.lob_regime_parent_start_samples)::numeric/
      greatest(1,cfg.lob_regime_parent_full_samples-cfg.lob_regime_parent_start_samples)) end;
  v_evidence_weight := greatest(
    case when coalesce(exact_profile.samples,0)<cfg.lob_regime_min_samples then 0
      else least(1,(exact_profile.samples-cfg.lob_regime_min_samples+1)::numeric/
        greatest(1,cfg.lob_regime_full_samples-cfg.lob_regime_min_samples+1)) end,
    v_parent_weight
  );

  if coalesce(exact_profile.samples,0)>0 and coalesce(parent_profile.samples,0)>0 then
    v_mean := exact_profile.mean_net_bps*v_exact_weight + parent_profile.mean_net_bps*(1-v_exact_weight);
    v_pf := exact_profile.profit_factor*v_exact_weight + parent_profile.profit_factor*(1-v_exact_weight);
    v_zero_mfe := exact_profile.zero_mfe_rate*v_exact_weight + parent_profile.zero_mfe_rate*(1-v_exact_weight);
    v_giveback := exact_profile.giveback_rate*v_exact_weight + parent_profile.giveback_rate*(1-v_exact_weight);
  elsif coalesce(exact_profile.samples,0)>0 then
    v_mean:=exact_profile.mean_net_bps; v_pf:=exact_profile.profit_factor;
    v_zero_mfe:=exact_profile.zero_mfe_rate; v_giveback:=exact_profile.giveback_rate;
  elsif coalesce(parent_profile.samples,0)>0 then
    v_mean:=parent_profile.mean_net_bps; v_pf:=parent_profile.profit_factor;
    v_zero_mfe:=parent_profile.zero_mfe_rate; v_giveback:=parent_profile.giveback_rate;
  end if;

  v_base_required_ev := greatest(
    coalesce(cfg.lob_min_net_ev_bps,0),
    coalesce(cfg.lob_min_verified_ev_cushion_bps,0),
    0
  );
  v_penalty := least(cfg.lob_regime_ev_penalty_cap_bps,greatest(0,-v_mean)*v_evidence_weight);
  v_required_ev := v_base_required_ev+v_penalty;
  v_bad_profile := v_evidence_weight>0 and (
    v_mean<=cfg.lob_regime_bad_mean_bps
    or v_pf<cfg.lob_regime_bad_profit_factor
    or v_zero_mfe>=cfg.lob_regime_bad_zero_mfe_rate
  );

  v_day := case when lower(new.exchange)='upbit'
    then (now() at time zone 'Asia/Seoul')::date else (now() at time zone 'UTC')::date end;
  select count(*) into v_active_revalidations
    from public.trading_positions p
   where p.exchange=new.exchange and p.is_paper=false
     and p.state in ('ENTRY_PENDING','OPEN','EXITING')
     and p.metadata#>>'{realized_edge_calibration,lane}'='REVALIDATION';
  select count(*) into v_today_revalidations
    from public.trading_positions p
   where p.exchange=new.exchange and p.is_paper=false
     and p.metadata#>>'{realized_edge_calibration,lane}'='REVALIDATION'
     and (case when lower(new.exchange)='upbit'
       then (p.created_at at time zone 'Asia/Seoul')::date else (p.created_at at time zone 'UTC')::date end)=v_day;

  v_strong_revalidation := coalesce(v_current_ev,0)>=greatest(cfg.lob_regime_revalidation_min_ev_bps,v_base_required_ev)
    and v_votes=3
    and v_quality>=cfg.lob_regime_revalidation_min_quality
    and v_spread<=cfg.lob_regime_revalidation_max_spread_bps
    and v_probability_edge>=0.20
    and v_active_revalidations<cfg.lob_regime_revalidation_max_concurrent
    and v_today_revalidations<cfg.lob_regime_revalidation_max_entries_per_day;

  if v_bad_profile and coalesce(v_current_ev,-999)<v_required_ev then
    if v_strong_revalidation then
      v_lane:='REVALIDATION';
      new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('low_evidence',true);
    else
      raise exception using errcode='P0001',message=format(
        'LOB_ADMISSION_REJECT[%s:%s]: REALIZED_EDGE_UNDERCALIBRATED current_ev=%s required_ev=%s regime=%s',
        new.exchange,new.market,coalesce(round(v_current_ev,3)::text,'null'),round(v_required_ev,3),v_regime
      );
    end if;
  elsif v_bad_profile then
    v_lane:='CURRENT_EDGE_OVERRIDES_HISTORY';
  end if;

  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
    'realized_edge_calibration',jsonb_build_object(
      'revision','6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
      'lane',v_lane,'regime_key',v_regime,
      'exact_samples',coalesce(exact_profile.samples,0),
      'parent_samples',coalesce(parent_profile.samples,0),
      'evidence_weight',round(v_evidence_weight,6),
      'mean_net_bps',round(v_mean,4),'profit_factor',round(v_pf,4),
      'zero_mfe_rate',round(v_zero_mfe,4),'giveback_rate',round(v_giveback,4),
      'current_ev_bps',v_current_ev,'required_ev_bps',round(v_required_ev,4),
      'penalty_bps',round(v_penalty,4),'direction_votes',v_votes,
      'data_quality',v_quality,'spread_bps',v_spread
    )
  );
  return new;
end;
$$;

drop trigger if exists ac_trading_positions_lob_realized_edge_v6130 on public.trading_positions;
create trigger ac_trading_positions_lob_realized_edge_v6130
before insert on public.trading_positions
for each row execute function public.enforce_lob_realized_edge_v6130();

create or replace function public.protect_lob_open_profit_v6130()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  v_entry numeric;
  v_peak numeric;
  v_mfe_bps numeric;
  v_tick numeric;
  v_cost_buffer numeric;
  v_observed_entry_fee_bps numeric := 0;
  v_candidate_stop numeric;
  v_locked_gross_bps numeric := 0;
  v_stage text := 'NONE';
  v_held_seconds numeric := 0;
  v_original_stop numeric;
begin
  if new.is_paper is distinct from false or new.state<>'OPEN' then return new; end if;
  signal:=coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found or not cfg.lob_profit_protect_enabled then return new; end if;

  v_entry:=coalesce(new.average_entry_price,old.average_entry_price,0);
  v_peak:=greatest(coalesce(new.peak_price,0),coalesce(old.peak_price,0),v_entry);
  if v_entry<=0 or v_peak<=v_entry then return new; end if;
  if new.opened_at is not null then
    v_held_seconds:=greatest(0,extract(epoch from(now()-new.opened_at)));
  end if;
  if v_held_seconds<cfg.lob_profit_protect_min_hold_seconds then return new; end if;

  v_mfe_bps:=(v_peak/v_entry-1)*10000;
  if coalesce(new.realized_cost_quote,0)>0 and coalesce(new.paid_fees_quote,0)>0 then
    -- At OPEN this is normally the entry fee. Double it and add 2bp execution allowance.
    v_observed_entry_fee_bps:=new.paid_fees_quote/new.realized_cost_quote*10000;
  end if;
  v_cost_buffer:=greatest(
    case when lower(new.exchange)='upbit' then cfg.lob_profit_protect_cost_buffer_bps_upbit
         else cfg.lob_profit_protect_cost_buffer_bps_binance end,
    v_observed_entry_fee_bps*2+2
  );
  v_original_stop:=coalesce(
    public.safe_numeric_v6112(old.metadata#>>'{profit_protection,original_stop_price}'),
    old.stop_price,new.stop_price
  );
  v_candidate_stop:=greatest(coalesce(old.stop_price,0),coalesce(new.stop_price,0),v_original_stop);

  if v_mfe_bps>=cfg.lob_profit_protect_breakeven_trigger_bps then
    v_stage:='COST_RECOVERY';
    v_locked_gross_bps:=v_cost_buffer;
    v_candidate_stop:=greatest(v_candidate_stop,v_entry*(1+v_locked_gross_bps/10000));
  end if;
  if v_mfe_bps>=cfg.lob_profit_lock_trigger_bps then
    v_stage:='NET_PROFIT_LOCK';
    v_locked_gross_bps:=v_cost_buffer+cfg.lob_profit_lock_net_bps;
    v_candidate_stop:=greatest(v_candidate_stop,v_entry*(1+v_locked_gross_bps/10000));
  end if;
  if v_mfe_bps>=cfg.lob_profit_trail_trigger_bps then
    v_stage:='PEAK_TRAIL';
    v_candidate_stop:=greatest(
      v_candidate_stop,
      v_peak*(1-cfg.lob_profit_trail_distance_bps/10000)
    );
    v_locked_gross_bps:=(v_candidate_stop/v_entry-1)*10000;
  end if;

  v_tick:=greatest(coalesce(new.tick_size,0),0);
  if v_tick>0 then v_candidate_stop:=floor(v_candidate_stop/v_tick)*v_tick; end if;
  -- Stop protection is monotonic and must stay below the observed peak by at least one tick.
  if v_tick>0 then v_candidate_stop:=least(v_candidate_stop,v_peak-v_tick);
  else v_candidate_stop:=least(v_candidate_stop,v_peak*(1-0.000001)); end if;
  v_candidate_stop:=greatest(v_candidate_stop,coalesce(old.stop_price,0),coalesce(new.stop_price,0));

  if v_candidate_stop>coalesce(new.stop_price,0) then
    new.stop_price:=v_candidate_stop;
    new.trailing_stop:=greatest(coalesce(new.trailing_stop,0),v_candidate_stop);
    new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
      'profit_protection',jsonb_build_object(
        'revision','6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
        'stage',v_stage,'original_stop_price',v_original_stop,
        'protected_stop_price',v_candidate_stop,'peak_price',v_peak,
        'mfe_bps',round(v_mfe_bps,4),'estimated_cost_buffer_bps',round(v_cost_buffer,4),
        'locked_gross_bps',round((v_candidate_stop/v_entry-1)*10000,4),
        'locked_net_bps_estimate',round((v_candidate_stop/v_entry-1)*10000-v_cost_buffer,4),
        'updated_at',now()
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists aa_trading_positions_profit_protection_v6130 on public.trading_positions;
create trigger aa_trading_positions_profit_protection_v6130
before update of peak_price,paid_fees_quote,realized_cost_quote on public.trading_positions
for each row execute function public.protect_lob_open_profit_v6130();

-- Trade-count deficits are diagnostics, never permission to weaken the model.
create or replace function public.rebalance_lob_mission_activity_v6120()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_since timestamptz:=now()-interval '1 hour';
  v_attempts integer:=0;
  v_qualified integer:=0;
  v_entries integer:=0;
  v_required integer:=0;
  v_activity_deficit boolean:=false;
  v_search_failure boolean:=false;
  v_prior_activity boolean:=false;
  v_prior_search boolean:=false;
begin
  perform pg_advisory_xact_lock(6130);
  select * into cfg from public.trading_settings where id=1 for update;
  if not found or not cfg.lob_mission_enabled then
    return jsonb_build_object('changed',false,'reason','MISSION_DISABLED');
  end if;
  if cfg.lob_mission_last_rebalanced_at is not null
     and cfg.lob_mission_last_rebalanced_at>now()-interval '5 minutes' then
    return jsonb_build_object('changed',false,'reason','REBALANCE_COOLDOWN');
  end if;

  select count(*),count(*) filter(where coalesce((audit->>'mission_qualified_opportunity')::boolean,false))
    into v_attempts,v_qualified
    from public.trading_decisions
   where upper(coalesce(strategy,audit->>'mission_strategy',audit->>'strategy',''))='LOB_SCALP'
     and created_at>=v_since;
  select count(*) into v_entries
    from public.trading_positions
   where is_paper=false and coalesce(opened_at,created_at)>=v_since
     and state not in ('CANCELLED','ERROR');

  if v_qualified>0 then
    v_required:=greatest(1,least(v_qualified,ceil(v_qualified*cfg.lob_mission_participation_floor)::integer));
  end if;
  v_activity_deficit:=v_qualified>0 and v_entries<v_required;
  v_search_failure:=v_attempts>=cfg.lob_search_min_attempts_hourly and v_qualified=0;
  v_prior_activity:=cfg.lob_mission_activity_deficit;
  v_prior_search:=cfg.lob_search_failure;

  update public.trading_settings
     set lob_mission_activity_deficit=v_activity_deficit,
         lob_mission_activity_deficit_streak=case when v_activity_deficit
           then lob_mission_activity_deficit_streak+1 else 0 end,
         lob_search_failure=v_search_failure,
         lob_search_failure_streak=case when v_search_failure
           then lob_search_failure_streak+1 else 0 end,
         lob_search_last_evaluated_at=now(),
         lob_mission_last_rebalanced_at=now(),
         updated_at=now()
   where id=1;

  return jsonb_build_object(
    'changed',v_prior_activity is distinct from v_activity_deficit or v_prior_search is distinct from v_search_failure,
    'mission_revision','6.13.0-REALIZED-EDGE-PROFIT-RETENTION',
    'attempts_1h',v_attempts,'qualified_opportunities_1h',v_qualified,
    'entries_1h',v_entries,'required_entries_1h',v_required,
    'activity_deficit',v_activity_deficit,'search_failure',v_search_failure,
    'thresholds_relaxed',false
  );
end;
$$;

create or replace function public.normalize_partial_mission_scorecard_v6122()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  v_eval_start timestamptz:=null;
  v_elapsed_fraction numeric:=1;
  v_period_goal integer:=0;
  v_prorated_goal integer:=0;
  v_opportunity_goal integer:=0;
  v_search_attempt_floor integer:=0;
  v_search_failure boolean:=false;
  v_search_status text;
begin
  if new.mission_revision not in ('6.12.2-MISSION-EPOCH','6.13.0-REALIZED-EDGE-PROFIT-RETENTION') then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found then return new; end if;
  begin v_eval_start:=(new.metrics->>'evaluation_start')::timestamptz;
  exception when others then v_eval_start:=greatest(new.period_start,cfg.lob_mission_epoch_at); end;
  v_eval_start:=greatest(coalesce(v_eval_start,new.period_start),new.period_start);

  v_period_goal:=case new.period_type
    when 'HOURLY' then cfg.lob_mission_hourly_min_trades
    when 'DAILY' then cfg.lob_mission_daily_min_trades
    when 'WEEKLY' then cfg.lob_mission_weekly_min_trades else 0 end;
  v_search_attempt_floor:=case new.period_type
    when 'HOURLY' then cfg.lob_search_min_attempts_hourly
    when 'DAILY' then cfg.lob_search_min_attempts_daily
    when 'WEEKLY' then cfg.lob_search_min_attempts_weekly else cfg.lob_search_min_attempts_hourly end;

  if new.period_end>v_eval_start then
    v_elapsed_fraction:=least(1,greatest(0,
      extract(epoch from(least(coalesce(new.captured_at,now()),new.period_end)-v_eval_start)) /
      extract(epoch from(new.period_end-v_eval_start))));
  end if;
  v_prorated_goal:=case when v_period_goal<=0 or v_elapsed_fraction<=0 then 0
    else ceil(v_period_goal*v_elapsed_fraction)::integer end;
  v_opportunity_goal:=case when new.qualified_opportunities>0
    then greatest(1,ceil(new.qualified_opportunities*cfg.lob_mission_participation_floor)::integer)
    else 0 end;
  new.required_entries:=least(new.qualified_opportunities,greatest(v_prorated_goal,v_opportunity_goal));

  v_search_failure:=new.entry_attempts>=v_search_attempt_floor and new.qualified_opportunities=0;
  v_search_status:=case
    when v_search_failure then 'SEARCH_FAILURE'
    when new.qualified_opportunities=0 then 'INSUFFICIENT_SEARCH_SAMPLE'
    when new.entries<new.required_entries then 'OPPORTUNITY_UNDERPARTICIPATION'
    else 'ACTIVITY_OK' end;
  -- Zero opportunity is never activity success. This does not place or force a trade; it makes
  -- the model own its failure to discover an economically valid setup.
  new.activity_pass:=new.qualified_opportunities>0 and new.entries>=new.required_entries;
  new.mission_pass:=new.evaluation_ready and new.activity_pass and new.profitability_pass
    and new.win_rate_pass and new.capture_pass;
  new.mission_revision:='6.13.0-REALIZED-EDGE-PROFIT-RETENTION';
  new.metrics:=coalesce(new.metrics,'{}'::jsonb)||jsonb_build_object(
    'activity_proration',jsonb_build_object(
      'elapsed_fraction',v_elapsed_fraction,'full_period_goal',v_period_goal,
      'prorated_goal',v_prorated_goal,'qualified_opportunity_goal',v_opportunity_goal,
      'required_entries',new.required_entries),
    'search_health',jsonb_build_object(
      'status',v_search_status,'attempts',new.entry_attempts,
      'attempt_floor',v_search_attempt_floor,'search_failure',v_search_failure,
      'thresholds_relaxed',false)
  );
  return new;
end;
$$;

-- Existing trigger is retained and now calls the replaced function body.

revoke all on function public.lob_regime_key_v6130(jsonb) from public,anon,authenticated;
revoke all on function public.refresh_lob_realized_regime_profile_v6130(text,text,text) from public,anon,authenticated;
revoke all on function public.on_lob_online_outcome_regime_v6130() from public,anon,authenticated;
revoke all on function public.enforce_lob_realized_edge_v6130() from public,anon,authenticated;
revoke all on function public.protect_lob_open_profit_v6130() from public,anon,authenticated;
revoke all on function public.rebalance_lob_mission_activity_v6120() from public,anon,authenticated;
revoke all on function public.normalize_partial_mission_scorecard_v6122() from public,anon,authenticated;

comment on table public.lob_realized_regime_profiles is
  'Verified fee-net outcomes grouped by exchange, LOB pattern and live quality/direction/spread regime.';
comment on function public.enforce_lob_realized_edge_v6130() is
  'Raises candidate-local EV burden from realized losses; preserves only a bounded all-three-direction-vote revalidation lane.';
comment on function public.protect_lob_open_profit_v6130() is
  'Monotonically raises the live LOB stop after cost recovery, net-profit lock and peak-trailing milestones.';
comment on function public.rebalance_lob_mission_activity_v6120() is
  'Activity/search diagnostics only. Never relaxes EV, payoff, direction, spread or quality thresholds.';

-- Synthetic profit-protection test: 41bp MFE must lock a stop above fee-adjusted breakeven.
create temp table v6130_profit_test(
  is_paper boolean,state text,metadata jsonb,exchange text,average_entry_price numeric,
  peak_price numeric,stop_price numeric,trailing_stop numeric,tick_size numeric,
  opened_at timestamptz,realized_cost_quote numeric,paid_fees_quote numeric
);
create trigger v6130_profit_test_trigger
before update of peak_price,paid_fees_quote,realized_cost_quote on v6130_profit_test
for each row execute function public.protect_lob_open_profit_v6130();
insert into v6130_profit_test values(
  false,'OPEN',jsonb_build_object('lob_signal',jsonb_build_object('strategy','LOB_SCALP')),
  'upbit',1000,1000,990,null,1,now()-interval '20 seconds',40000,20
);
update v6130_profit_test set peak_price=1004.1;
do $$ declare r v6130_profit_test%rowtype; begin
  select * into r from v6130_profit_test limit 1;
  if r.stop_price<=1001.2 then raise exception 'V6130_PROFIT_PROTECTION_NOT_APPLIED'; end if;
  if r.metadata#>>'{profit_protection,stage}'<>'PEAK_TRAIL' then raise exception 'V6130_PROFIT_STAGE_WRONG'; end if;
end $$;

-- Synthetic regime classifier test.
do $$ begin
  if public.lob_regime_key_v6130(jsonb_build_object('features',jsonb_build_object(
    'dataQuality',0.72,'tradePressureFast',0.5,'micropriceDeviationBps',2,
    'bookImbalance',0.2,'spreadBps',3
  )))<>'Q_HIGH|DIR_3|SP_TIGHT' then
    raise exception 'V6130_REGIME_CLASSIFIER_FAILED';
  end if;
end $$;

select public.rebalance_lob_mission_activity_v6120();
select public.refresh_trading_mission_scorecard_v6120('HOURLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('HOURLY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('DAILY','binance',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','upbit',now());
select public.refresh_trading_mission_scorecard_v6120('WEEKLY','binance',now());
