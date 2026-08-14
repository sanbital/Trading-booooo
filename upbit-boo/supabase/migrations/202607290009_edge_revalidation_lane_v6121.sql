-- v6.12.1 EDGE-REVALIDATION
--
-- Mature adverse history must remain expensive, but it cannot become an irreversible veto:
-- otherwise the model can never discover that a market regime or a pattern implementation has
-- improved. This migration creates a fresh, tiny revalidation lane for order-time signals that
-- remain positive after fees, slippage and conservative uncertainty, while keeping structural
-- execution failures and the operator's KST daily -30% circuit untouched.

alter table public.trading_settings
  add column if not exists lob_mission_epoch_at timestamptz not null default now(),
  add column if not exists lob_revalidation_enabled boolean not null default true,
  add column if not exists lob_revalidation_min_ev_bps numeric not null default 0.50,
  add column if not exists lob_revalidation_min_rr numeric not null default 0.85,
  add column if not exists lob_revalidation_min_probability_edge numeric not null default 0.20,
  add column if not exists lob_revalidation_min_data_quality numeric not null default 0.25,
  add column if not exists lob_revalidation_max_spread_bps numeric not null default 12,
  add column if not exists lob_revalidation_max_concurrent integer not null default 1,
  add column if not exists lob_revalidation_max_entries_per_day integer not null default 4,
  add column if not exists lob_revalidation_daily_loss_pct numeric not null default 0.25,
  add column if not exists lob_revalidation_fallback_budget_krw numeric not null default 400,
  add column if not exists lob_revalidation_fallback_budget_usdt numeric not null default 0.75;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_revalidation_v6121;
alter table public.trading_settings
  add constraint trading_settings_lob_revalidation_v6121 check (
    lob_revalidation_min_ev_bps > 0
    and lob_revalidation_min_rr between 0.75 and 2
    and lob_revalidation_min_probability_edge between 0 and 1
    and lob_revalidation_min_data_quality between 0 and 1
    and lob_revalidation_max_spread_bps between 1 and lob_max_spread_bps
    and lob_revalidation_max_concurrent between 1 and 3
    and lob_revalidation_max_entries_per_day between 1 and 20
    and lob_revalidation_daily_loss_pct between 0.05 and 1
    and lob_revalidation_fallback_budget_krw > 0
    and lob_revalidation_fallback_budget_usdt > 0
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_revalidation_v6121;

update public.trading_settings
   set lob_mission_epoch_at = now(),
       lob_revalidation_enabled = true,
       lob_revalidation_min_ev_bps = 0.50,
       lob_revalidation_min_rr = 0.85,
       lob_revalidation_min_probability_edge = 0.20,
       lob_revalidation_min_data_quality = 0.25,
       lob_revalidation_max_spread_bps = 12,
       lob_revalidation_max_concurrent = 1,
       lob_revalidation_max_entries_per_day = 4,
       lob_revalidation_daily_loss_pct = 0.25,
       lob_revalidation_fallback_budget_krw = 400,
       lob_revalidation_fallback_budget_usdt = 0.75,
       lob_live_admission_revision = '6.12.1-EDGE-REVALIDATION',
       version = version + 1,
       updated_at = now()
 where id = 1;

create index if not exists trading_decisions_mission_qualified_idx
  on public.trading_decisions(created_at desc, exchange)
  where audit ->> 'mission_qualified_opportunity' = 'true';
create index if not exists trading_positions_mission_lane_created_idx
  on public.trading_positions((metadata ->> 'admission_lane'), created_at desc, exchange)
  where is_paper = false;

create or replace function public.enforce_lob_live_entry_v6121()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  block_reasons text[] := array[]::text[];
  adverse_reasons text[] := array[]::text[];
  v_lane text := 'CORE';
  v_dynamic_status text;
  v_low_evidence boolean := false;
  v_learning_missing boolean := false;
  v_learning_anomaly boolean := false;
  v_ev_missing boolean := false;
  v_weak_payoff boolean := false;
  v_adverse_learning boolean := false;
  v_lane_ok boolean := false;

  v_spread numeric;
  v_rr numeric;
  v_attempt_ev_lb numeric;
  v_conditional_ev_lb numeric;
  v_ev_lb numeric;
  v_target_net numeric;
  v_p_target numeric;
  v_p_stop numeric;
  v_data_quality numeric;
  v_day_change_pct numeric := 0;
  v_opportunity_score numeric := 0;

  v_pattern_samples integer := 0;
  v_pattern_mean numeric;
  v_pattern_lower numeric;
  v_pattern_profit_factor numeric;
  v_pattern_profitable_rate numeric;
  v_coin_source text;
  v_coin_market_samples integer := 0;
  v_coin_pattern_samples integer := 0;
  v_coin_mean numeric;
  v_coin_profitable_rate numeric;

  v_recent_count integer := 0;
  v_recent_all_losses boolean := false;
  v_recent_first_closed_at timestamptz;

  v_active_lane integer := 0;
  v_today_lane_entries integer := 0;
  v_today_realized_loss numeric := 0;
  v_active_worst_case numeric := 0;
  v_managed_capital numeric := 0;
  v_budget_limit numeric := 0;
  v_new_worst_case numeric := 0;
  v_stop_fraction numeric := 0;
  v_budget_day date;
begin
  if new.is_paper is distinct from false or new.state <> 'ENTRY_PENDING' then return new; end if;
  signal := coalesce(new.metadata -> 'lob_signal', new.metadata -> 'scalp_signal', '{}'::jsonb);
  if upper(coalesce(signal ->> 'strategy', '')) <> 'LOB_SCALP' then return new; end if;

  select * into cfg from public.trading_settings where id = 1;
  if not found then
    raise exception using errcode='P0001', message='LOB_ADMISSION_REJECT: trading_settings row id=1 unavailable';
  end if;

  v_dynamic_status := upper(coalesce(signal #>> '{features,dynamicStatus}', 'UNKNOWN'));
  v_spread := public.safe_numeric_v6112(new.metadata ->> 'live_spread_bps');
  v_rr := public.safe_numeric_v6112(signal ->> 'net_reward_risk_ratio');
  v_attempt_ev_lb := public.safe_numeric_v6112(signal ->> 'attempt_ev_lower_bound_bps');
  v_conditional_ev_lb := public.safe_numeric_v6112(signal ->> 'conditional_ev_lower_bound_bps');
  v_ev_lb := coalesce(v_attempt_ev_lb, v_conditional_ev_lb);
  v_target_net := public.safe_numeric_v6112(signal ->> 'target_return_net_bps');
  v_p_target := public.safe_numeric_v6112(signal ->> 'p_target');
  v_p_stop := public.safe_numeric_v6112(signal ->> 'p_stop');
  v_data_quality := public.safe_numeric_v6112(signal #>> '{features,dataQuality}');
  v_day_change_pct := 100 * coalesce(
    public.safe_numeric_v6112(new.metadata #>> '{quote_at_entry,raw,ticker,change_rate}'),
    public.safe_numeric_v6112(new.metadata #>> '{quote_at_entry,raw,ticker,signed_change_rate}'), 0
  );

  v_pattern_samples := coalesce(public.safe_integer_v6112(signal #>> '{pattern_learning,samples}'),0);
  v_pattern_mean := public.safe_numeric_v6112(signal #>> '{pattern_learning,mean_net_bps}');
  v_pattern_lower := public.safe_numeric_v6112(signal #>> '{pattern_learning,mean_net_lower_bound_bps}');
  v_pattern_profit_factor := public.safe_numeric_v6112(signal #>> '{pattern_learning,profit_factor}');
  v_pattern_profitable_rate := public.safe_numeric_v6112(signal #>> '{pattern_learning,profitable_rate}');
  v_coin_source := upper(coalesce(signal #>> '{coin_learning,source}', ''));
  v_coin_market_samples := coalesce(public.safe_integer_v6112(signal #>> '{coin_learning,market_samples}'),0);
  v_coin_pattern_samples := coalesce(public.safe_integer_v6112(signal #>> '{coin_learning,pattern_samples}'),0);
  v_coin_mean := public.safe_numeric_v6112(signal #>> '{coin_learning,mean_net_bps}');
  v_coin_profitable_rate := public.safe_numeric_v6112(signal #>> '{coin_learning,profitable_rate}');

  v_weak_payoff := jsonb_typeof(signal -> 'warnings')='array' and (signal -> 'warnings') ? 'NET_PAYOFF_TOO_WEAK';
  v_learning_missing := signal #>> '{pattern_learning,samples}' is null or signal #>> '{coin_learning,source}' is null;
  v_learning_anomaly := v_pattern_samples<0 or v_coin_market_samples<0 or v_coin_pattern_samples<0
    or (v_pattern_profitable_rate is not null and (v_pattern_profitable_rate<0 or v_pattern_profitable_rate>1))
    or (v_coin_profitable_rate is not null and (v_coin_profitable_rate<0 or v_coin_profitable_rate>1))
    or (v_pattern_mean is not null and abs(v_pattern_mean)>5000)
    or (v_coin_mean is not null and abs(v_coin_mean)>5000)
    or (v_coin_source<>'' and v_coin_source not in ('PRIOR','PATTERN','MARKET'));
  v_ev_missing := v_attempt_ev_lb is null and v_conditional_ev_lb is null;
  v_low_evidence := lower(coalesce(new.metadata->>'low_evidence','false'))='true'
    or lower(coalesce(new.metadata->>'is_exploration','false'))='true'
    or v_dynamic_status in ('INSUFFICIENT','UNKNOWN') or v_learning_missing or v_learning_anomaly or v_ev_missing;

  v_opportunity_score :=
      0.35*least(1,greatest(0,coalesce(v_ev_lb,0)/8))
    + 0.25*least(1,greatest(0,(coalesce(v_rr,1)-0.80)/1.20))
    + 0.20*least(1,greatest(0,1-coalesce(v_spread,cfg.lob_max_spread_bps)/greatest(1,cfg.lob_max_spread_bps)))
    + 0.10*least(1,greatest(0,coalesce(v_data_quality,0)))
    + 0.10*least(1,greatest(0,(coalesce(v_p_target,0.5)-coalesce(v_p_stop,0.5)+0.20)/0.40));

  -- Structural execution/economics remain hard requirements. Activity targets never force a
  -- non-positive-EV, stale, unbounded or fee-inadequate trade.
  if v_rr is null then block_reasons:=array_append(block_reasons,'MISSING_NET_RR');
  elsif v_rr<cfg.lob_min_net_reward_risk_ratio then block_reasons:=array_append(block_reasons,'NET_RR_BELOW_FLOOR'); end if;
  if v_spread is null then block_reasons:=array_append(block_reasons,'MISSING_LIVE_SPREAD');
  elsif v_spread>cfg.lob_max_spread_bps then block_reasons:=array_append(block_reasons,'SPREAD_TOO_WIDE'); end if;
  if v_ev_lb is null or v_ev_lb<=0 then block_reasons:=array_append(block_reasons,'NON_POSITIVE_VERIFIED_EV'); end if;
  if v_weak_payoff then block_reasons:=array_append(block_reasons,'NET_PAYOFF_TOO_WEAK'); end if;
  if v_day_change_pct>=cfg.lob_chase_change_rate_pct and coalesce(v_spread,999999)>=cfg.lob_chase_min_spread_bps then
    block_reasons:=array_append(block_reasons,'WIDE_SPREAD_CHASE');
  end if;

  -- Mature adverse history is detected, but becomes a bounded revalidation lane rather than
  -- an eternal veto when current, independently computed order-time evidence is strong.
  if not v_learning_anomaly and v_pattern_samples>=cfg.lob_live_min_pattern_samples and (
       (v_pattern_lower is not null and v_pattern_lower < -3)
       or (v_pattern_mean is not null and v_pattern_mean<=-8
           and v_pattern_profit_factor is not null and v_pattern_profit_factor<0.80
           and v_pattern_profitable_rate is not null and v_pattern_profitable_rate<0.35)
     ) then
    adverse_reasons:=array_append(adverse_reasons,'MATURE_NEGATIVE_PATTERN');
  end if;
  if not v_learning_anomaly and v_coin_source='MARKET'
     and v_coin_market_samples>=cfg.lob_live_min_market_samples and v_coin_mean is not null
     and (v_coin_mean<=-15 or (v_coin_mean<=-8 and v_coin_profitable_rate is not null and v_coin_profitable_rate<=0.30)) then
    adverse_reasons:=array_append(adverse_reasons,'MATURE_NEGATIVE_MARKET');
  elsif not v_learning_anomaly and v_coin_source='PATTERN'
     and v_coin_pattern_samples>=cfg.lob_live_min_pattern_samples and v_coin_mean is not null and v_coin_mean<=-15 then
    adverse_reasons:=array_append(adverse_reasons,'MATURE_NEGATIVE_COIN_PATTERN');
  end if;
  v_adverse_learning := cardinality(adverse_reasons)>0;

  if cfg.lob_symbol_loss_cooldown_minutes>0 then
    select count(*),coalesce(bool_and(x.realized_pnl_quote<0),false),min(x.closed_at)
      into v_recent_count,v_recent_all_losses,v_recent_first_closed_at
      from (
        select coalesce(realized_pnl_quote,0) realized_pnl_quote,closed_at
        from public.trading_positions
        where exchange=new.exchange and market=new.market and is_paper=false and state='CLOSED' and closed_at is not null
        order by closed_at desc limit cfg.lob_symbol_loss_streak
      ) x;
    if v_recent_count>=cfg.lob_symbol_loss_streak and v_recent_all_losses
       and v_recent_first_closed_at>=now()-make_interval(mins=>cfg.lob_symbol_loss_cooldown_minutes) then
      block_reasons:=array_append(block_reasons,'SYMBOL_LOSS_COOLDOWN');
    end if;
  end if;

  if cardinality(block_reasons)>0 then
    raise exception using errcode='P0001',message=format('LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(block_reasons,','));
  end if;

  v_budget_day := case when lower(new.exchange)='upbit' then (now() at time zone 'Asia/Seoul')::date else (now() at time zone 'UTC')::date end;
  if coalesce(new.planned_entry_price,0)>0 and coalesce(new.stop_price,0)>0 then
    v_stop_fraction:=greatest(0,(new.planned_entry_price-new.stop_price)/new.planned_entry_price);
  else v_stop_fraction:=0.005; end if;
  v_new_worst_case:=greatest(0,coalesce(new.reserved_quote,0))*(greatest(0.0005,v_stop_fraction)+0.003);
  select coalesce((select managed_capital_quote from public.lob_exploration_budget_daily
                   where exchange=lower(new.exchange) order by day_key desc limit 1),0)
    into v_managed_capital;

  if v_adverse_learning then
    v_lane:='REVALIDATION';
    v_lane_ok:=cfg.lob_revalidation_enabled
      and v_ev_lb>=cfg.lob_revalidation_min_ev_bps
      and v_rr>=cfg.lob_revalidation_min_rr
      and coalesce(v_p_target,0)-coalesce(v_p_stop,1)>=cfg.lob_revalidation_min_probability_edge
      and v_spread<=cfg.lob_revalidation_max_spread_bps
      and (coalesce(v_data_quality,0)>=cfg.lob_revalidation_min_data_quality
           or v_dynamic_status not in ('INSUFFICIENT','UNKNOWN'));
    if not v_lane_ok then
      block_reasons:=adverse_reasons||array['REVALIDATION_EDGE_TOO_WEAK'];
    end if;
    select count(*) into v_active_lane from public.trading_positions
     where exchange=new.exchange and is_paper=false and state in ('ENTRY_PENDING','OPEN','EXITING')
       and metadata->>'admission_lane'='REVALIDATION' and created_at>=cfg.lob_mission_epoch_at;
    if v_active_lane>=cfg.lob_revalidation_max_concurrent then block_reasons:=array_append(block_reasons,'REVALIDATION_CONCURRENCY_LIMIT'); end if;
    select count(*),coalesce(sum(case when state='CLOSED' then greatest(0,-coalesce(realized_pnl_quote,0)) else 0 end),0),
           coalesce(sum(case when state in ('ENTRY_PENDING','OPEN','EXITING') then coalesce(public.safe_numeric_v6112(metadata#>>'{admission_budget,worst_case_loss_quote}'),0) else 0 end),0)
      into v_today_lane_entries,v_today_realized_loss,v_active_worst_case
      from public.trading_positions
     where exchange=new.exchange and is_paper=false and metadata->>'admission_lane'='REVALIDATION'
       and created_at>=cfg.lob_mission_epoch_at
       and (case when lower(new.exchange)='upbit' then (created_at at time zone 'Asia/Seoul')::date else (created_at at time zone 'UTC')::date end)=v_budget_day;
    if v_today_lane_entries>=cfg.lob_revalidation_max_entries_per_day then block_reasons:=array_append(block_reasons,'REVALIDATION_DAILY_ENTRY_LIMIT'); end if;
    v_budget_limit:=case when v_managed_capital>0 then v_managed_capital*cfg.lob_revalidation_daily_loss_pct/100
                         when lower(new.exchange)='upbit' then cfg.lob_revalidation_fallback_budget_krw
                         else cfg.lob_revalidation_fallback_budget_usdt end;
    if v_today_realized_loss+v_active_worst_case+v_new_worst_case>v_budget_limit then block_reasons:=array_append(block_reasons,'REVALIDATION_LOSS_BUDGET'); end if;
  elsif v_low_evidence then
    v_lane:='CONTROLLED_EXPLORATION';
    v_lane_ok:=(not v_ev_missing and v_ev_lb>=0.25 and v_rr>=cfg.lob_exploration_min_net_rr
                and v_spread<=cfg.lob_exploration_max_spread_bps
                and v_opportunity_score>=cfg.lob_exploration_min_opportunity_score)
      or (v_ev_missing and v_rr>=greatest(1.25,cfg.lob_exploration_min_net_rr)
          and v_spread<=least(8,cfg.lob_exploration_max_spread_bps)
          and coalesce(v_target_net,0)>0 and coalesce(v_p_target,0)>coalesce(v_p_stop,1));
    if not v_lane_ok then block_reasons:=array_append(block_reasons,'EXPLORATION_EDGE_TOO_WEAK'); end if;
    select count(*) into v_active_lane from public.trading_positions
     where exchange=new.exchange and is_paper=false and state in ('ENTRY_PENDING','OPEN','EXITING')
       and metadata->>'admission_lane'='CONTROLLED_EXPLORATION' and created_at>=cfg.lob_mission_epoch_at;
    if v_active_lane>=cfg.lob_controlled_exploration_max_concurrent then block_reasons:=array_append(block_reasons,'EXPLORATION_CONCURRENCY_LIMIT'); end if;
    select count(*),coalesce(sum(case when state='CLOSED' then greatest(0,-coalesce(realized_pnl_quote,0)) else 0 end),0),
           coalesce(sum(case when state in ('ENTRY_PENDING','OPEN','EXITING') then coalesce(public.safe_numeric_v6112(metadata#>>'{admission_budget,worst_case_loss_quote}'),0) else 0 end),0)
      into v_today_lane_entries,v_today_realized_loss,v_active_worst_case
      from public.trading_positions
     where exchange=new.exchange and is_paper=false and metadata->>'admission_lane'='CONTROLLED_EXPLORATION'
       and created_at>=cfg.lob_mission_epoch_at
       and (case when lower(new.exchange)='upbit' then (created_at at time zone 'Asia/Seoul')::date else (created_at at time zone 'UTC')::date end)=v_budget_day;
    if v_today_lane_entries>=cfg.lob_controlled_exploration_max_entries_per_day then block_reasons:=array_append(block_reasons,'EXPLORATION_DAILY_ENTRY_LIMIT'); end if;
    v_budget_limit:=case when v_managed_capital>0 then v_managed_capital*cfg.lob_controlled_exploration_daily_loss_pct/100
                         when lower(new.exchange)='upbit' then cfg.lob_controlled_exploration_fallback_budget_krw
                         else cfg.lob_controlled_exploration_fallback_budget_usdt end;
    if v_today_realized_loss+v_active_worst_case+v_new_worst_case>v_budget_limit then block_reasons:=array_append(block_reasons,'EXPLORATION_LOSS_BUDGET'); end if;
  elsif v_opportunity_score<cfg.lob_core_min_opportunity_score then
    block_reasons:=array_append(block_reasons,'CORE_OPPORTUNITY_SCORE_LOW');
  end if;

  if cardinality(block_reasons)>0 then
    raise exception using errcode='P0001',message=format('LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(block_reasons,','));
  end if;

  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
    'admission_revision','6.12.1-EDGE-REVALIDATION','admission_lane',v_lane,
    'admission_opportunity_score',round(v_opportunity_score,6),
    'admission_learning_missing',v_learning_missing,'admission_learning_anomaly',v_learning_anomaly,
    'admission_ev_missing',v_ev_missing,'admission_adverse_learning',v_adverse_learning,
    'admission_adverse_reasons',to_jsonb(adverse_reasons),
    'mission_revision','6.12.0-MISSION-COMPOUND-EDGE',
    'admission_budget',case when v_lane in ('CONTROLLED_EXPLORATION','REVALIDATION') then jsonb_build_object(
      'day_key',v_budget_day,'limit_quote',v_budget_limit,'realized_loss_quote_before',v_today_realized_loss,
      'active_worst_case_quote_before',v_active_worst_case,'worst_case_loss_quote',v_new_worst_case
    ) else null end
  );
  return new;
end;
$$;

drop trigger if exists trading_positions_lob_live_guard_v6112 on public.trading_positions;
drop trigger if exists trading_positions_lob_live_guard_v6121 on public.trading_positions;
create trigger trading_positions_lob_live_guard_v6121
before insert on public.trading_positions
for each row execute function public.enforce_lob_live_entry_v6121();
revoke all on function public.enforce_lob_live_entry_v6121() from public,anon,authenticated;

-- Mission tables contain private trading data; service-role processes remain able to use them.
alter table public.trading_trade_mission_audits enable row level security;
alter table public.trading_mission_scorecards enable row level security;
revoke all on table public.trading_trade_mission_audits from anon,authenticated;
revoke all on table public.trading_mission_scorecards from anon,authenticated;
alter function public.safe_numeric_v6112(text) set search_path=public;
alter function public.safe_integer_v6112(text) set search_path=public;

comment on function public.enforce_lob_live_entry_v6121() is
  'Joint mission admission: hard-blocks invalid fee-net economics, routes immature positive edge to exploration, and permits tightly budgeted revalidation of historically adverse patterns when current evidence is independently strong.';

-- Synthetic guard tests: no exchange order is involved.
create temp table v6121_guard_test(
  is_paper boolean,state text,metadata jsonb,exchange text,market text,
  planned_entry_price numeric,stop_price numeric,reserved_quote numeric
);
create trigger v6121_guard_test_trigger before insert on v6121_guard_test
for each row execute function public.enforce_lob_live_entry_v6121();

insert into v6121_guard_test values(
 false,'ENTRY_PENDING',jsonb_build_object('low_evidence',true,'live_spread_bps',5,'lob_signal',jsonb_build_object(
   'strategy','LOB_SCALP','warnings','[]'::jsonb,'net_reward_risk_ratio',0.95,
   'attempt_ev_lower_bound_bps',1.2,'conditional_ev_lower_bound_bps',3,
   'p_target',0.60,'p_stop',0.25,'target_return_net_bps',20,
   'features',jsonb_build_object('dynamicStatus','NEUTRAL','dataQuality',0.50),
   'pattern_learning',jsonb_build_object('samples',50,'mean_net_bps',-20,'profit_factor',0.5,'profitable_rate',0.2),
   'coin_learning',jsonb_build_object('source','PATTERN','market_samples',0,'pattern_samples',50,'mean_net_bps',-25,'profitable_rate',0.2)
 )), 'upbit','KRW-V6121-PASS',100,99.6,10
);

do $$ begin
  begin
    insert into v6121_guard_test values(
      false,'ENTRY_PENDING',jsonb_build_object('low_evidence',true,'live_spread_bps',5,'lob_signal',jsonb_build_object(
        'strategy','LOB_SCALP','warnings','[]'::jsonb,'net_reward_risk_ratio',0.82,
        'attempt_ev_lower_bound_bps',0.10,'conditional_ev_lower_bound_bps',0.2,
        'p_target',0.52,'p_stop',0.40,'features',jsonb_build_object('dynamicStatus','INSUFFICIENT','dataQuality',0.10),
        'pattern_learning',jsonb_build_object('samples',50,'mean_net_bps',-20,'profit_factor',0.5,'profitable_rate',0.2),
        'coin_learning',jsonb_build_object('source','PATTERN','pattern_samples',50,'mean_net_bps',-25,'profitable_rate',0.2)
      )), 'upbit','KRW-V6121-BLOCK',100,99.6,10
    );
    raise exception 'V6121_WEAK_REVALIDATION_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6121_WEAK_REVALIDATION_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;
