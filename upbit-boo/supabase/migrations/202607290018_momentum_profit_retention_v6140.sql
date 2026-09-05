-- v6.14.0 FEE-AWARE MOMENTUM PROFIT RETENTION
--
-- The prior trigger could label +18bp as cost recovery even when Binance's observed round-trip
-- fee buffer was about 22bp. The protected stop was then capped below the peak and still locked
-- a net loss. Protection milestones now move with the measured fee buffer. Momentum uses a
-- shorter trail only after costs and positive net profit are genuinely covered.

alter table public.trading_settings
  add column if not exists lob_momentum_profit_trail_distance_bps numeric not null default 12,
  add column if not exists lob_momentum_profit_lock_net_bps numeric not null default 6,
  add column if not exists lob_momentum_cost_recovery_margin_bps numeric not null default 2,
  add column if not exists lob_momentum_trail_net_trigger_bps numeric not null default 20;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_momentum_profit_v6140;
alter table public.trading_settings
  add constraint trading_settings_lob_momentum_profit_v6140 check (
    lob_momentum_profit_trail_distance_bps between 3 and 50
    and lob_momentum_profit_lock_net_bps between 1 and 50
    and lob_momentum_cost_recovery_margin_bps between 0.5 and 20
    and lob_momentum_trail_net_trigger_bps between lob_momentum_profit_lock_net_bps and 100
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_momentum_profit_v6140;

update public.trading_settings
   set lob_momentum_profit_trail_distance_bps=12,
       lob_momentum_profit_lock_net_bps=6,
       lob_momentum_cost_recovery_margin_bps=2,
       lob_momentum_trail_net_trigger_bps=20,
       updated_at=now()
 where id=1;

create or replace function public.protect_lob_open_profit_v6130()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  v_entry numeric;
  v_peak numeric;
  v_mfe_bps numeric;
  v_tick numeric;
  v_cost_buffer numeric;
  v_observed_entry_fee_bps numeric:=0;
  v_candidate_stop numeric;
  v_stage text:='NONE';
  v_held_seconds numeric:=0;
  v_original_stop numeric;
  v_is_momentum boolean:=false;
  v_cost_recovery_trigger numeric;
  v_profit_lock_trigger numeric;
  v_trail_trigger numeric;
  v_lock_net_bps numeric;
  v_trail_distance_bps numeric;
begin
  if new.is_paper is distinct from false or new.state<>'OPEN' then return new; end if;
  signal:=coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found or not cfg.lob_profit_protect_enabled then return new; end if;

  v_is_momentum:=upper(coalesce(signal->>'pattern',''))='MOMENTUM_CONTINUATION';
  v_entry:=coalesce(new.average_entry_price,old.average_entry_price,0);
  v_peak:=greatest(coalesce(new.peak_price,0),coalesce(old.peak_price,0),v_entry);
  if v_entry<=0 or v_peak<=v_entry then return new; end if;
  if new.opened_at is not null then
    v_held_seconds:=greatest(0,extract(epoch from(now()-new.opened_at)));
  end if;
  if v_held_seconds<cfg.lob_profit_protect_min_hold_seconds then return new; end if;

  v_mfe_bps:=(v_peak/v_entry-1)*10000;
  if coalesce(new.realized_cost_quote,0)>0 and coalesce(new.paid_fees_quote,0)>0 then
    v_observed_entry_fee_bps:=new.paid_fees_quote/new.realized_cost_quote*10000;
  end if;
  v_cost_buffer:=greatest(
    case when lower(new.exchange)='upbit' then cfg.lob_profit_protect_cost_buffer_bps_upbit
         else cfg.lob_profit_protect_cost_buffer_bps_binance end,
    v_observed_entry_fee_bps*2+2
  );

  v_lock_net_bps:=case when v_is_momentum then cfg.lob_momentum_profit_lock_net_bps
    else cfg.lob_profit_lock_net_bps end;
  v_trail_distance_bps:=case when v_is_momentum then cfg.lob_momentum_profit_trail_distance_bps
    else cfg.lob_profit_trail_distance_bps end;
  -- A milestone cannot fire before the stop it requests physically fits below the observed peak.
  v_cost_recovery_trigger:=greatest(
    cfg.lob_profit_protect_breakeven_trigger_bps,
    v_cost_buffer + case when v_is_momentum then cfg.lob_momentum_cost_recovery_margin_bps else 2 end
  );
  v_profit_lock_trigger:=greatest(
    cfg.lob_profit_lock_trigger_bps,
    v_cost_buffer+v_lock_net_bps+2
  );
  v_trail_trigger:=greatest(
    cfg.lob_profit_trail_trigger_bps,
    v_cost_buffer + case when v_is_momentum then cfg.lob_momentum_trail_net_trigger_bps else 20 end
  );

  v_original_stop:=coalesce(
    public.safe_numeric_v6112(old.metadata#>>'{profit_protection,original_stop_price}'),
    old.stop_price,new.stop_price
  );
  v_candidate_stop:=greatest(coalesce(old.stop_price,0),coalesce(new.stop_price,0),v_original_stop);

  if v_mfe_bps>=v_cost_recovery_trigger then
    v_stage:='COST_RECOVERY';
    v_candidate_stop:=greatest(v_candidate_stop,v_entry*(1+v_cost_buffer/10000));
  end if;
  if v_mfe_bps>=v_profit_lock_trigger then
    v_stage:='NET_PROFIT_LOCK';
    v_candidate_stop:=greatest(v_candidate_stop,v_entry*(1+(v_cost_buffer+v_lock_net_bps)/10000));
  end if;
  if v_mfe_bps>=v_trail_trigger then
    v_stage:=case when v_is_momentum then 'MOMENTUM_PEAK_TRAIL' else 'PEAK_TRAIL' end;
    v_candidate_stop:=greatest(v_candidate_stop,v_peak*(1-v_trail_distance_bps/10000));
  end if;

  v_tick:=greatest(coalesce(new.tick_size,0),0);
  if v_tick>0 then v_candidate_stop:=floor(v_candidate_stop/v_tick)*v_tick; end if;
  if v_tick>0 then v_candidate_stop:=least(v_candidate_stop,v_peak-v_tick);
  else v_candidate_stop:=least(v_candidate_stop,v_peak*(1-0.000001)); end if;
  v_candidate_stop:=greatest(v_candidate_stop,coalesce(old.stop_price,0),coalesce(new.stop_price,0));

  if v_candidate_stop>coalesce(new.stop_price,0) then
    new.stop_price:=v_candidate_stop;
    new.trailing_stop:=greatest(coalesce(new.trailing_stop,0),v_candidate_stop);
    new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
      'profit_protection',jsonb_build_object(
        'revision','6.14.0-FEE-AWARE-MOMENTUM-PROFIT-RETENTION',
        'stage',v_stage,'momentum_lane',v_is_momentum,
        'original_stop_price',v_original_stop,'protected_stop_price',v_candidate_stop,
        'peak_price',v_peak,'mfe_bps',round(v_mfe_bps,4),
        'estimated_cost_buffer_bps',round(v_cost_buffer,4),
        'cost_recovery_trigger_bps',round(v_cost_recovery_trigger,4),
        'profit_lock_trigger_bps',round(v_profit_lock_trigger,4),
        'trail_trigger_bps',round(v_trail_trigger,4),
        'trail_distance_bps',round(v_trail_distance_bps,4),
        'locked_gross_bps',round((v_candidate_stop/v_entry-1)*10000,4),
        'locked_net_bps_estimate',round((v_candidate_stop/v_entry-1)*10000-v_cost_buffer,4),
        'updated_at',now()
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function public.protect_lob_open_profit_v6130() from public,anon,authenticated;

-- Synthetic Binance momentum test with 10bp entry fee. At +24bp the stop must lock the
-- 22bp estimated round-trip buffer; at +45bp it must trail and preserve positive net bps.
create temp table v6140_profit_test(
  is_paper boolean,state text,metadata jsonb,exchange text,average_entry_price numeric,
  peak_price numeric,stop_price numeric,trailing_stop numeric,tick_size numeric,
  opened_at timestamptz,realized_cost_quote numeric,paid_fees_quote numeric
);
create trigger v6140_profit_test_trigger
before update of peak_price,paid_fees_quote,realized_cost_quote on v6140_profit_test
for each row execute function public.protect_lob_open_profit_v6130();
insert into v6140_profit_test values(
  false,'OPEN',jsonb_build_object('lob_signal',jsonb_build_object(
    'strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION')),
  'binance',1000,1000,990,null,0.1,now()-interval '20 seconds',100,0.1
);
update v6140_profit_test set peak_price=1002.4;
do $$ declare r v6140_profit_test%rowtype; begin
  select * into r from v6140_profit_test limit 1;
  if r.stop_price<1002.1 then raise exception 'V6140_COST_RECOVERY_NOT_LOCKED'; end if;
  if r.metadata#>>'{profit_protection,stage}'<>'COST_RECOVERY' then raise exception 'V6140_COST_STAGE_WRONG'; end if;
end $$;
update v6140_profit_test set peak_price=1004.5;
do $$ declare r v6140_profit_test%rowtype; begin
  select * into r from v6140_profit_test limit 1;
  if r.metadata#>>'{profit_protection,stage}'<>'MOMENTUM_PEAK_TRAIL' then raise exception 'V6140_TRAIL_STAGE_WRONG'; end if;
  if public.safe_numeric_v6112(r.metadata#>>'{profit_protection,locked_net_bps_estimate}')<=0 then raise exception 'V6140_TRAIL_NET_NOT_POSITIVE'; end if;
end $$;
