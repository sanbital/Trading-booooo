-- v6.14.0 BINANCE MOMENTUM CONTINUATION SCALP
--
-- Captures real-time continuation in large 24h gainers without turning 24h return itself into
-- a buy signal. Entry still requires present-tense aggressive buying, ticker-notional
-- acceleration, tight spread, fresh book, positive microprice and fee-net EV.
--
-- This is a candidate-local spot lane. It does not relax the global LOB gate, enable leverage,
-- add derivatives, permit transfers/withdrawals or change the operator's only global automatic
-- circuit: KST daily loss -30%.

alter table public.trading_settings
  add column if not exists lob_momentum_enabled boolean not null default true,
  add column if not exists lob_momentum_min_change_24h_pct numeric not null default 3,
  add column if not exists lob_momentum_max_change_24h_pct numeric not null default 60,
  add column if not exists lob_momentum_min_heat_score numeric not null default 45,
  add column if not exists lob_momentum_min_trade_pressure numeric not null default 0.25,
  add column if not exists lob_momentum_min_notional_acceleration numeric not null default 0.02,
  add column if not exists lob_momentum_min_microprice_bps numeric not null default 0,
  add column if not exists lob_momentum_min_direction_votes integer not null default 2,
  add column if not exists lob_momentum_min_data_quality numeric not null default 0.25,
  add column if not exists lob_momentum_max_spread_bps numeric not null default 8,
  add column if not exists lob_momentum_max_concurrent integer not null default 1,
  add column if not exists lob_momentum_max_entries_per_day integer not null default 8,
  add column if not exists lob_momentum_daily_loss_pct numeric not null default 0.50,
  add column if not exists lob_momentum_fallback_budget_krw numeric not null default 800,
  add column if not exists lob_momentum_fallback_budget_usdt numeric not null default 1.50,
  add column if not exists lob_momentum_target_min_bps numeric not null default 60,
  add column if not exists lob_momentum_target_max_bps numeric not null default 140,
  add column if not exists lob_momentum_max_holding_seconds integer not null default 90;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_momentum_v6140;
alter table public.trading_settings
  add constraint trading_settings_lob_momentum_v6140 check (
    lob_momentum_min_change_24h_pct between 0 and 30
    and lob_momentum_max_change_24h_pct between lob_momentum_min_change_24h_pct and 150
    and lob_momentum_min_heat_score between 0 and 100
    and lob_momentum_min_trade_pressure between 0 and 1
    and lob_momentum_min_notional_acceleration between 0 and 1
    and lob_momentum_min_microprice_bps between -10 and 20
    and lob_momentum_min_direction_votes between 2 and 3
    and lob_momentum_min_data_quality between 0 and 1
    and lob_momentum_max_spread_bps between 0.1 and lob_max_spread_bps
    and lob_momentum_max_concurrent between 1 and 3
    and lob_momentum_max_entries_per_day between 1 and 30
    and lob_momentum_daily_loss_pct between 0.05 and 2
    and lob_momentum_fallback_budget_krw > 0
    and lob_momentum_fallback_budget_usdt > 0
    and lob_momentum_target_min_bps between 20 and 200
    and lob_momentum_target_max_bps between lob_momentum_target_min_bps and 300
    and lob_momentum_max_holding_seconds between 30 and 180
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_momentum_v6140;

update public.trading_settings
   set lob_momentum_enabled=true,
       lob_momentum_min_change_24h_pct=3,
       lob_momentum_max_change_24h_pct=60,
       lob_momentum_min_heat_score=45,
       lob_momentum_min_trade_pressure=0.25,
       lob_momentum_min_notional_acceleration=0.02,
       lob_momentum_min_microprice_bps=0,
       lob_momentum_min_direction_votes=2,
       lob_momentum_min_data_quality=0.25,
       lob_momentum_max_spread_bps=8,
       lob_momentum_max_concurrent=1,
       lob_momentum_max_entries_per_day=8,
       lob_momentum_daily_loss_pct=0.50,
       lob_momentum_fallback_budget_krw=800,
       lob_momentum_fallback_budget_usdt=1.50,
       lob_momentum_target_min_bps=60,
       lob_momentum_target_max_bps=140,
       lob_momentum_max_holding_seconds=90,
       lob_model_revision='6.14.0-MOMENTUM-CONTINUATION-SCALP',
       lob_live_admission_revision='6.14.0-MOMENTUM-CONTINUATION-SCALP',
       version=version+1,
       updated_at=now()
 where id=1;

create or replace function public.enforce_lob_momentum_lane_v6140()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  f jsonb;
  v_pattern text;
  v_change_24h numeric;
  v_heat numeric;
  v_pressure numeric;
  v_acceleration numeric;
  v_micro numeric;
  v_imbalance numeric;
  v_quality numeric;
  v_spread numeric;
  v_votes integer:=0;
  v_ev numeric;
  v_active integer:=0;
  v_today_entries integer:=0;
  v_today_loss numeric:=0;
  v_active_worst_case numeric:=0;
  v_new_worst_case numeric:=0;
  v_budget_limit numeric:=0;
  v_managed_capital numeric:=0;
  v_stop_fraction numeric:=0;
  v_day date;
  reasons text[]:=array[]::text[];
begin
  if new.is_paper is distinct from false or new.state<>'ENTRY_PENDING' then return new; end if;
  signal:=coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  v_pattern:=upper(coalesce(signal->>'pattern',''));
  if v_pattern<>'MOMENTUM_CONTINUATION' then return new; end if;

  select * into cfg from public.trading_settings where id=1;
  if not found then raise exception using errcode='P0001',message='LOB_ADMISSION_REJECT: trading_settings id=1 unavailable'; end if;
  if not cfg.lob_momentum_enabled then
    raise exception using errcode='P0001',message=format('LOB_ADMISSION_REJECT[%s:%s]: MOMENTUM_LANE_DISABLED',new.exchange,new.market);
  end if;

  f:=coalesce(signal->'features','{}'::jsonb);
  -- heatPeriod encodes signed 24h return as change_pct / 400 in trendContext.
  v_change_24h:=coalesce(public.safe_numeric_v6112(f->>'change24hPct'),public.safe_numeric_v6112(f->>'trendContext')*400,0);
  v_heat:=coalesce(public.safe_numeric_v6112(f->>'marketHeatScore'),0);
  v_pressure:=coalesce(public.safe_numeric_v6112(f->>'tradePressureFast'),0);
  v_acceleration:=coalesce(public.safe_numeric_v6112(f->>'notionalAcceleration'),0);
  v_micro:=coalesce(public.safe_numeric_v6112(f->>'micropriceDeviationBps'),0);
  v_imbalance:=coalesce(public.safe_numeric_v6112(f->>'bookImbalance'),0);
  v_quality:=coalesce(public.safe_numeric_v6112(f->>'dataQuality'),0);
  v_spread:=coalesce(public.safe_numeric_v6112(new.metadata->>'live_spread_bps'),public.safe_numeric_v6112(f->>'spreadBps'),999);
  v_ev:=coalesce(public.safe_numeric_v6112(signal->>'attempt_ev_lower_bound_bps'),public.safe_numeric_v6112(signal->>'conditional_ev_lower_bound_bps'),-999);
  v_votes:=(case when v_pressure>0 then 1 else 0 end)
          +(case when v_micro>=0 then 1 else 0 end)
          +(case when v_imbalance>0 then 1 else 0 end);

  if v_change_24h<cfg.lob_momentum_min_change_24h_pct or v_change_24h>cfg.lob_momentum_max_change_24h_pct then reasons:=array_append(reasons,'MOMENTUM_24H_CHANGE_OUTSIDE_LANE'); end if;
  if v_heat<cfg.lob_momentum_min_heat_score then reasons:=array_append(reasons,'MOMENTUM_HEAT_TOO_LOW'); end if;
  if v_pressure<cfg.lob_momentum_min_trade_pressure then reasons:=array_append(reasons,'MOMENTUM_BUY_PRESSURE_TOO_LOW'); end if;
  if v_acceleration<cfg.lob_momentum_min_notional_acceleration then reasons:=array_append(reasons,'MOMENTUM_NOTIONAL_ACCELERATION_TOO_LOW'); end if;
  if v_micro<cfg.lob_momentum_min_microprice_bps then reasons:=array_append(reasons,'MOMENTUM_MICROPRICE_NOT_POSITIVE'); end if;
  if v_votes<cfg.lob_momentum_min_direction_votes then reasons:=array_append(reasons,'MOMENTUM_DIRECTION_CONFLICT'); end if;
  if v_quality<cfg.lob_momentum_min_data_quality then reasons:=array_append(reasons,'MOMENTUM_DATA_QUALITY_TOO_LOW'); end if;
  if v_spread>cfg.lob_momentum_max_spread_bps then reasons:=array_append(reasons,'MOMENTUM_SPREAD_TOO_WIDE'); end if;
  if v_ev<=0 then reasons:=array_append(reasons,'MOMENTUM_VERIFIED_EV_NOT_POSITIVE'); end if;

  select count(*) into v_active
    from public.trading_positions p
   where p.exchange=new.exchange and p.is_paper=false
     and p.state in ('ENTRY_PENDING','OPEN','EXITING')
     and p.metadata#>>'{lob_signal,pattern}'='MOMENTUM_CONTINUATION';
  if v_active>=cfg.lob_momentum_max_concurrent then reasons:=array_append(reasons,'MOMENTUM_CONCURRENCY_LIMIT'); end if;

  v_day:=case when lower(new.exchange)='upbit' then (now() at time zone 'Asia/Seoul')::date else (now() at time zone 'UTC')::date end;
  select count(*),
         coalesce(sum(case when p.state='CLOSED' then greatest(0,-coalesce(p.realized_pnl_quote,0)) else 0 end),0),
         coalesce(sum(case when p.state in ('ENTRY_PENDING','OPEN','EXITING') then coalesce(public.safe_numeric_v6112(p.metadata#>>'{momentum_budget,worst_case_loss_quote}'),0) else 0 end),0)
    into v_today_entries,v_today_loss,v_active_worst_case
    from public.trading_positions p
   where p.exchange=new.exchange and p.is_paper=false
     and p.metadata#>>'{lob_signal,pattern}'='MOMENTUM_CONTINUATION'
     and (case when lower(new.exchange)='upbit' then (p.created_at at time zone 'Asia/Seoul')::date else (p.created_at at time zone 'UTC')::date end)=v_day;
  if v_today_entries>=cfg.lob_momentum_max_entries_per_day then reasons:=array_append(reasons,'MOMENTUM_DAILY_ENTRY_LIMIT'); end if;

  select coalesce((select managed_capital_quote from public.lob_exploration_budget_daily where exchange=lower(new.exchange) order by day_key desc limit 1),0)
    into v_managed_capital;
  v_budget_limit:=case when v_managed_capital>0 then v_managed_capital*cfg.lob_momentum_daily_loss_pct/100
    when lower(new.exchange)='upbit' then cfg.lob_momentum_fallback_budget_krw else cfg.lob_momentum_fallback_budget_usdt end;
  if coalesce(new.planned_entry_price,0)>0 and coalesce(new.stop_price,0)>0 then
    v_stop_fraction:=greatest(0,(new.planned_entry_price-new.stop_price)/new.planned_entry_price);
  else v_stop_fraction:=0.004; end if;
  v_new_worst_case:=greatest(0,coalesce(new.reserved_quote,0))*(greatest(0.0005,v_stop_fraction)+0.003);
  if v_today_loss+v_active_worst_case+v_new_worst_case>v_budget_limit then reasons:=array_append(reasons,'MOMENTUM_DAILY_LOSS_BUDGET'); end if;

  if cardinality(reasons)>0 then
    raise exception using errcode='P0001',message=format('LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(reasons,','));
  end if;

  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
    'momentum_lane',jsonb_build_object(
      'revision','6.14.0-MOMENTUM-CONTINUATION-SCALP',
      'change_24h_pct',round(v_change_24h,4),'heat_score',round(v_heat,4),
      'trade_pressure',round(v_pressure,4),'notional_acceleration',round(v_acceleration,4),
      'microprice_bps',round(v_micro,4),'book_imbalance',round(v_imbalance,4),
      'direction_votes',v_votes,'data_quality',round(v_quality,4),'spread_bps',round(v_spread,4),
      'verified_ev_bps',round(v_ev,4),'max_holding_seconds',cfg.lob_momentum_max_holding_seconds
    ),
    'momentum_budget',jsonb_build_object(
      'day_key',v_day,'limit_quote',v_budget_limit,'realized_loss_before',v_today_loss,
      'active_worst_case_before',v_active_worst_case,'worst_case_loss_quote',v_new_worst_case
    )
  );
  return new;
end;
$$;

drop trigger if exists ab0_trading_positions_lob_momentum_v6140 on public.trading_positions;
create trigger ab0_trading_positions_lob_momentum_v6140
before insert on public.trading_positions
for each row execute function public.enforce_lob_momentum_lane_v6140();

revoke all on function public.enforce_lob_momentum_lane_v6140() from public,anon,authenticated;
comment on function public.enforce_lob_momentum_lane_v6140() is
  'Bounded present-tense momentum continuation admission. 24h gain alone is never sufficient.';

-- Synthetic positive and stale-momentum tests. No exchange order or production position is created.
create temp table v6140_momentum_test(
  is_paper boolean,state text,metadata jsonb,exchange text,market text,
  planned_entry_price numeric,stop_price numeric,reserved_quote numeric
);
create trigger v6140_momentum_test_trigger before insert on v6140_momentum_test
for each row execute function public.enforce_lob_momentum_lane_v6140();

insert into v6140_momentum_test values(false,'ENTRY_PENDING',jsonb_build_object(
  'live_spread_bps',1.2,
  'lob_signal',jsonb_build_object('strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION',
    'attempt_ev_lower_bound_bps',2.5,'conditional_ev_lower_bound_bps',4.0,
    'features',jsonb_build_object('trendContext',0.03,'marketHeatScore',72,'tradePressureFast',0.62,
      'notionalAcceleration',0.35,'micropriceDeviationBps',2.1,'bookImbalance',0.18,'dataQuality',0.62,'spreadBps',1.2)
  )),'binance','TESTMOMUSDT',100,99.6,1);

do $$ begin
  begin
    insert into v6140_momentum_test values(false,'ENTRY_PENDING',jsonb_build_object(
      'live_spread_bps',1.2,
      'lob_signal',jsonb_build_object('strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION',
        'attempt_ev_lower_bound_bps',2.5,'conditional_ev_lower_bound_bps',4.0,
        'features',jsonb_build_object('trendContext',0.075,'marketHeatScore',72,'tradePressureFast',0.62,
          'notionalAcceleration',0,'micropriceDeviationBps',2.1,'bookImbalance',0.18,'dataQuality',0.62,'spreadBps',1.2)
      )),'binance','STALEMOMUSDT',100,99.6,1);
    raise exception 'V6140_STALE_MOMENTUM_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6140_STALE_MOMENTUM_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;
