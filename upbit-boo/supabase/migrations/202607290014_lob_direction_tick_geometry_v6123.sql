-- v6.12.3 DIRECTIONAL-EXECUTION-CONSISTENCY
--
-- The first mission trades exposed two structural alpha defects, not a need for another
-- blanket threshold:
--   1. a LONG breakout was admitted while pressure, microprice and book imbalance were all
--      bearish; the pattern score was high because one breakout component dominated;
--   2. stops were only about four ticks away, so one ordinary book jump produced far more
--      loss than the model's worst-case estimate.
--
-- This guard is pattern-specific. It does not pause the engine, raise a generic confidence
-- bar or force a trade quota. Consistent positive-EV signals continue to the normal mission
-- lanes; contradictory or unexecutable geometry is rejected candidate by candidate.

alter table public.trading_settings
  add column if not exists lob_min_stop_ticks numeric not null default 6,
  add column if not exists lob_long_direction_min_votes integer not null default 2,
  add column if not exists lob_ofi_min_trade_pressure numeric not null default 0.15,
  add column if not exists lob_ofi_min_persistence numeric not null default 0.45,
  add column if not exists lob_ofi_max_adverse_trend numeric not null default -0.001,
  add column if not exists lob_breakout_min_score numeric not null default 0.60,
  add column if not exists lob_sweep_min_score numeric not null default 0.45,
  add column if not exists lob_absorption_min_score numeric not null default 0.45;

alter table public.trading_settings
  drop constraint if exists trading_settings_lob_direction_geometry_v6123;
alter table public.trading_settings
  add constraint trading_settings_lob_direction_geometry_v6123 check (
    lob_min_stop_ticks between 2 and 20
    and lob_long_direction_min_votes between 1 and 3
    and lob_ofi_min_trade_pressure between 0 and 1
    and lob_ofi_min_persistence between 0 and 1
    and lob_ofi_max_adverse_trend between -0.02 and 0.02
    and lob_breakout_min_score between 0 and 1
    and lob_sweep_min_score between 0 and 1
    and lob_absorption_min_score between 0 and 1
  ) not valid;
alter table public.trading_settings
  validate constraint trading_settings_lob_direction_geometry_v6123;

update public.trading_settings
   set lob_min_stop_ticks=6,
       lob_long_direction_min_votes=2,
       lob_ofi_min_trade_pressure=0.15,
       lob_ofi_min_persistence=0.45,
       lob_ofi_max_adverse_trend=-0.001,
       lob_breakout_min_score=0.60,
       lob_sweep_min_score=0.45,
       lob_absorption_min_score=0.45,
       lob_live_admission_revision='6.12.3-DIRECTION-TICK-GEOMETRY',
       version=version+1,
       updated_at=now()
 where id=1;

create or replace function public.enforce_lob_direction_geometry_v6123()
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
  v_pressure numeric;
  v_micro numeric;
  v_imbalance numeric;
  v_ofi numeric;
  v_trend numeric;
  v_breakout numeric;
  v_sweep numeric;
  v_absorption numeric;
  v_votes integer:=0;
  v_stop_bps numeric;
  v_tick_bps numeric;
  v_stop_ticks numeric;
  reasons text[]:=array[]::text[];
begin
  if new.is_paper is distinct from false or new.state<>'ENTRY_PENDING' then return new; end if;
  signal:=coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found then return new; end if;

  f:=coalesce(signal->'features','{}'::jsonb);
  v_pattern:=upper(coalesce(signal->>'pattern',''));
  v_pressure:=coalesce(public.safe_numeric_v6112(f->>'tradePressureFast'),0);
  v_micro:=coalesce(public.safe_numeric_v6112(f->>'micropriceDeviationBps'),0);
  v_imbalance:=coalesce(public.safe_numeric_v6112(f->>'bookImbalance'),0);
  v_ofi:=coalesce(public.safe_numeric_v6112(f->>'ofiPersistence'),0);
  v_trend:=coalesce(public.safe_numeric_v6112(f->>'trendContext'),0);
  v_breakout:=coalesce(public.safe_numeric_v6112(f->>'breakoutScore'),0);
  v_sweep:=coalesce(public.safe_numeric_v6112(f->>'sweepReclaimScore'),0);
  v_absorption:=coalesce(public.safe_numeric_v6112(f->>'bidAbsorptionScore'),0);

  v_votes:=(case when v_pressure>0 then 1 else 0 end)
          +(case when v_micro>0 then 1 else 0 end)
          +(case when v_imbalance>0 then 1 else 0 end);

  if v_pattern in ('QUEUE_DEPLETION_BREAKOUT','OFI_CONTINUATION','SWEEP_RECLAIM')
     and v_votes<cfg.lob_long_direction_min_votes then
    reasons:=array_append(reasons,'LONG_SIGNAL_DIRECTION_CONFLICT');
  end if;

  if v_pattern='QUEUE_DEPLETION_BREAKOUT' and v_breakout<cfg.lob_breakout_min_score then
    reasons:=array_append(reasons,'BREAKOUT_CORE_EVIDENCE_MISSING');
  elsif v_pattern='OFI_CONTINUATION' then
    if v_pressure<cfg.lob_ofi_min_trade_pressure or v_ofi<cfg.lob_ofi_min_persistence then
      reasons:=array_append(reasons,'OFI_FLOW_TOO_WEAK');
    end if;
    if v_trend<cfg.lob_ofi_max_adverse_trend then
      reasons:=array_append(reasons,'OFI_TREND_CONFLICT');
    end if;
  elsif v_pattern='SWEEP_RECLAIM' and v_sweep<cfg.lob_sweep_min_score then
    reasons:=array_append(reasons,'SWEEP_CORE_EVIDENCE_MISSING');
  elsif v_pattern='ABSORPTION_REVERSAL' then
    if v_absorption<cfg.lob_absorption_min_score or v_micro< -1 then
      reasons:=array_append(reasons,'ABSORPTION_NOT_STABILIZED');
    end if;
  elsif v_pattern='REPLENISHMENT_ICEBERG' then
    if lower(coalesce(f->>'persistentBidWall','false'))<>'true' or v_micro< -1 then
      reasons:=array_append(reasons,'BID_REPLENISHMENT_NOT_CONFIRMED');
    end if;
  end if;

  v_stop_bps:=public.safe_numeric_v6112(signal->>'stop_bps');
  if coalesce(new.planned_entry_price,0)>0 and coalesce(new.tick_size,0)>0 then
    v_tick_bps:=new.tick_size/new.planned_entry_price*10000;
    v_stop_ticks:=case when v_tick_bps>0 then coalesce(v_stop_bps,0)/v_tick_bps else null end;
    if v_stop_ticks is null or v_stop_ticks<cfg.lob_min_stop_ticks then
      reasons:=array_append(reasons,'STOP_TICK_GEOMETRY_TOO_TIGHT');
    end if;
  end if;

  if cardinality(reasons)>0 then
    raise exception using
      errcode='P0001',
      message=format('LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(reasons,','));
  end if;
  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
    'direction_consistency',jsonb_build_object(
      'revision','6.12.3-DIRECTION-TICK-GEOMETRY',
      'positive_votes',v_votes,
      'pressure',v_pressure,
      'microprice_bps',v_micro,
      'book_imbalance',v_imbalance,
      'stop_ticks',v_stop_ticks
    )
  );
  return new;
end;
$$;

-- Alphabetical ordering makes this run before the broader v6.12.1 lane/budget admission.
drop trigger if exists ab_trading_positions_lob_direction_geometry_v6123
  on public.trading_positions;
create trigger ab_trading_positions_lob_direction_geometry_v6123
before insert on public.trading_positions
for each row execute function public.enforce_lob_direction_geometry_v6123();

create or replace function public.normalize_mission_alpha_rejection_v6123()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if upper(coalesce(new.reason,''))~(
    'LONG_SIGNAL_DIRECTION_CONFLICT|BREAKOUT_CORE_EVIDENCE_MISSING|OFI_FLOW_TOO_WEAK|' ||
    'OFI_TREND_CONFLICT|SWEEP_CORE_EVIDENCE_MISSING|ABSORPTION_NOT_STABILIZED|' ||
    'BID_REPLENISHMENT_NOT_CONFIRMED|STOP_TICK_GEOMETRY_TOO_TIGHT'
  ) then
    new.audit:=coalesce(new.audit,'{}'::jsonb)||jsonb_build_object(
      'mission_qualified_opportunity',false,
      'mission_operationally_unavailable',true,
      'mission_alpha_rejection',true,
      'mission_alpha_revision','6.12.3-DIRECTION-TICK-GEOMETRY'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists zz_trading_decisions_alpha_rejection_v6123
  on public.trading_decisions;
create trigger zz_trading_decisions_alpha_rejection_v6123
before insert or update of reason,audit on public.trading_decisions
for each row execute function public.normalize_mission_alpha_rejection_v6123();

revoke all on function public.enforce_lob_direction_geometry_v6123()
  from public,anon,authenticated;
revoke all on function public.normalize_mission_alpha_rejection_v6123()
  from public,anon,authenticated;

comment on function public.enforce_lob_direction_geometry_v6123() is
  'Pattern-specific logical consistency and tick-executable stop geometry. Prevents a single pattern component from declaring LONG against the live book.';

-- Synthetic tests: STORJ-like bearish breakout must fail; a directionally consistent, tick-
-- executable breakout must pass to this guard. The normal v6.12.1 admission is not attached to
-- the temporary table, so no exchange or live position is involved.
create temp table v6123_direction_test(
  is_paper boolean,state text,metadata jsonb,exchange text,market text,
  planned_entry_price numeric,tick_size numeric
);
create trigger v6123_direction_test_trigger before insert on v6123_direction_test
for each row execute function public.enforce_lob_direction_geometry_v6123();

do $$ begin
  begin
    insert into v6123_direction_test values(false,'ENTRY_PENDING',jsonb_build_object('lob_signal',jsonb_build_object(
      'strategy','LOB_SCALP','pattern','QUEUE_DEPLETION_BREAKOUT','stop_bps',46,
      'features',jsonb_build_object('tradePressureFast',-0.14,'micropriceDeviationBps',-5.4,
        'bookImbalance',-0.60,'breakoutScore',0.99)
    )),'upbit','KRW-BEARISH-BREAKOUT',82.9,0.1);
    raise exception 'V6123_DIRECTION_CONFLICT_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6123_DIRECTION_CONFLICT_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;

insert into v6123_direction_test values(false,'ENTRY_PENDING',jsonb_build_object('lob_signal',jsonb_build_object(
  'strategy','LOB_SCALP','pattern','QUEUE_DEPLETION_BREAKOUT','stop_bps',80,
  'features',jsonb_build_object('tradePressureFast',0.32,'micropriceDeviationBps',3.2,
    'bookImbalance',0.18,'breakoutScore',0.82)
)),'upbit','KRW-CONSISTENT-BREAKOUT',1000,1);
