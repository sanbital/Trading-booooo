-- v6.14.1 MOMENTUM LIVE-TRADE CONTRACT
--
-- A scanner BUY and the database admission must describe the same event. Ten-minute REST trade
-- history and whole-market ticker acceleration are context; a live continuation additionally
-- requires trades aligned to the same websocket book window. Momentum has its own bounded loss
-- budget and must not be charged again to the generic low-evidence exploration budget.

alter table public.trading_settings
  add column if not exists lob_momentum_min_trade_arrival_rate numeric not null default 0.05,
  add column if not exists lob_momentum_min_aggressive_notional_per_second numeric not null default 0.01;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_momentum_live_trade_v6141;
alter table public.trading_settings
  add constraint trading_settings_lob_momentum_live_trade_v6141 check (
    lob_momentum_min_trade_arrival_rate between 0 and 20
    and lob_momentum_min_aggressive_notional_per_second >= 0
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_momentum_live_trade_v6141;

update public.trading_settings
   set lob_momentum_min_trade_arrival_rate=0.05,
       lob_momentum_min_aggressive_notional_per_second=0.01,
       lob_model_revision='6.14.1-MOMENTUM-LIVE-TRADE-CONTRACT',
       lob_live_admission_revision='6.14.1-MOMENTUM-LIVE-TRADE-CONTRACT',
       version=version+1,
       updated_at=now()
 where id=1;

-- Preserve the existing audited function body and make two narrow, fail-fast source patches.
do $$
declare
  ddl text;
  anchor text;
  replacement text;
begin
  select pg_get_functiondef(p.oid) into ddl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='enforce_lob_momentum_lane_v6140';
  if ddl is null then raise exception 'enforce_lob_momentum_lane_v6140 unavailable'; end if;
  anchor := 'if v_quality<cfg.lob_momentum_min_data_quality then reasons:=array_append(reasons,''MOMENTUM_DATA_QUALITY_TOO_LOW''); end if;';
  replacement := anchor || E'\n if coalesce(public.safe_numeric_v6112(f->>''tradeArrivalRate''),0)<cfg.lob_momentum_min_trade_arrival_rate then reasons:=array_append(reasons,''MOMENTUM_LIVE_TRADE_ARRIVAL_TOO_LOW''); end if;' ||
    E'\n if coalesce(public.safe_numeric_v6112(f->>''aggressiveNotionalPerSecond''),0)<cfg.lob_momentum_min_aggressive_notional_per_second then reasons:=array_append(reasons,''MOMENTUM_LIVE_AGGRESSIVE_NOTIONAL_TOO_LOW''); end if;';
  if position(anchor in ddl)=0 then raise exception 'momentum live-trade patch anchor unavailable'; end if;
  execute replace(ddl,anchor,replacement);

  select pg_get_functiondef(p.oid) into ddl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='enforce_lob_live_entry_v6121';
  if ddl is null then raise exception 'enforce_lob_live_entry_v6121 unavailable'; end if;
  anchor := 'elsif v_low_evidence then';
  replacement := 'elsif v_low_evidence and upper(coalesce(signal->>''pattern'',''''))<>''MOMENTUM_CONTINUATION'' then';
  if position(anchor in ddl)=0 then raise exception 'generic exploration branch patch anchor unavailable'; end if;
  execute replace(ddl,anchor,replacement);
end $$;

comment on column public.trading_settings.lob_momentum_min_trade_arrival_rate is
  'Minimum trades/second aligned to the same live orderbook observation window. REST history does not satisfy it.';
comment on column public.trading_settings.lob_momentum_min_aggressive_notional_per_second is
  'Positive same-window executed notional required for momentum admission; quote currency units per second.';
comment on function public.enforce_lob_momentum_lane_v6140() is
  'Bounded momentum continuation admission with same-window book and trade evidence. 24h gain alone is never sufficient.';
comment on function public.enforce_lob_live_entry_v6121() is
  'Structural LOB gate. MOMENTUM_CONTINUATION retains all hard economic gates but uses its dedicated momentum budget rather than generic exploration budget.';

-- Full two-guard contract test on a temporary relation. No production position or order is created.
create temp table v6141_contract_test(
  is_paper boolean,
  state text,
  metadata jsonb,
  exchange text,
  market text,
  planned_entry_price numeric,
  stop_price numeric,
  reserved_quote numeric,
  tick_size numeric
);
create trigger ab0_momentum before insert on v6141_contract_test
for each row execute function public.enforce_lob_momentum_lane_v6140();
create trigger trading_live_guard before insert on v6141_contract_test
for each row execute function public.enforce_lob_live_entry_v6121();

insert into v6141_contract_test values(
  false,'ENTRY_PENDING',jsonb_build_object(
    'live_spread_bps',1.2,
    'lob_signal',jsonb_build_object(
      'strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION','warnings','[]'::jsonb,
      'net_reward_risk_ratio',1.55,'attempt_ev_lower_bound_bps',3.2,
      'conditional_ev_lower_bound_bps',5.4,'target_return_net_bps',82,
      'p_target',0.56,'p_stop',0.24,
      'features',jsonb_build_object(
        'dynamicStatus','READY','dataQuality',0.62,'spreadBps',1.2,
        'trendContext',0.03,'marketHeatScore',74,'tradePressureFast',0.68,
        'notionalAcceleration',0.45,'micropriceDeviationBps',2.2,
        'bookImbalance',0.18,'tradeArrivalRate',2.4,
        'aggressiveNotionalPerSecond',150
      )
    )
  ),'binance','VALIDMOMUSDT',100,99.6,1,0.01
);

do $$ begin
  begin
    insert into v6141_contract_test values(
      false,'ENTRY_PENDING',jsonb_build_object(
        'live_spread_bps',1.2,
        'lob_signal',jsonb_build_object(
          'strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION','warnings','[]'::jsonb,
          'net_reward_risk_ratio',1.55,'attempt_ev_lower_bound_bps',3.2,
          'conditional_ev_lower_bound_bps',5.4,'target_return_net_bps',82,
          'p_target',0.56,'p_stop',0.24,
          'features',jsonb_build_object(
            'dynamicStatus','INSUFFICIENT','dataQuality',0.2275,'spreadBps',1.2,
            'trendContext',0.03,'marketHeatScore',74,'tradePressureFast',0.68,
            'notionalAcceleration',0.45,'micropriceDeviationBps',2.2,
            'bookImbalance',0.18,'tradeArrivalRate',0,
            'aggressiveNotionalPerSecond',0
          )
        )
      ),'binance','STALEMOMUSDT',100,99.6,1,0.01
    );
    raise exception 'V6141_STALE_MOMENTUM_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6141_STALE_MOMENTUM_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;
