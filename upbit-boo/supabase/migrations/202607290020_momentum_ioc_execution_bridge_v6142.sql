-- v6.14.2 MOMENTUM IOC EXECUTION BRIDGE
--
-- A Binance post-only race can reject a valid continuation before an order exists. Until the
-- orchestrator source can perform candidate-local fallback, disable the global maker branch but
-- allow IOC LIMIT entry only for momentum candidates whose order-time maker-fill policy explicitly
-- measured positive taker economics. All ordinary LOB patterns are rejected while this bridge is
-- active, so no maker-assumed candidate silently pays taker costs.
--
-- The order path remains LIMIT IOC, never MARKET. Momentum's own concurrency/day/loss budget and
-- every structural/EV/direction/spread guard remain active. KST daily -30% is unchanged.

alter table public.trading_settings
  add column if not exists lob_momentum_ioc_bridge_enabled boolean not null default true,
  add column if not exists lob_momentum_ioc_bridge_activated_at timestamptz;

update public.trading_settings
   set lob_momentum_ioc_bridge_enabled=true,
       lob_momentum_ioc_bridge_activated_at=now(),
       scalp_maker_entry=false,
       lob_model_revision='6.14.2-MOMENTUM-IOC-EXECUTION',
       lob_live_admission_revision='6.14.2-MOMENTUM-IOC-EXECUTION',
       version=version+1,
       updated_at=now()
 where id=1;

create or replace function public.enforce_momentum_ioc_execution_v6142()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  cfg public.trading_settings%rowtype;
  signal jsonb;
  v_pattern text;
  v_convert boolean:=false;
  v_attempt_ev numeric;
  v_conditional_ev numeric;
  v_spread numeric;
  reasons text[]:=array[]::text[];
begin
  if new.is_paper is distinct from false or new.state<>'ENTRY_PENDING' then return new; end if;
  signal:=coalesce(new.metadata->'lob_signal',new.metadata->'scalp_signal','{}'::jsonb);
  if upper(coalesce(signal->>'strategy',''))<>'LOB_SCALP' then return new; end if;
  select * into cfg from public.trading_settings where id=1;
  if not found or not cfg.lob_momentum_ioc_bridge_enabled then return new; end if;
  -- The bridge is relevant only while the global maker branch is intentionally disabled.
  if cfg.scalp_maker_entry then return new; end if;

  v_pattern:=upper(coalesce(signal->>'pattern',''));
  v_convert:=lower(coalesce(signal#>>'{maker_fill,convertToTaker}','false'))='true';
  v_attempt_ev:=public.safe_numeric_v6112(signal->>'attempt_ev_lower_bound_bps');
  v_conditional_ev:=public.safe_numeric_v6112(signal->>'conditional_ev_lower_bound_bps');
  v_spread:=coalesce(
    public.safe_numeric_v6112(new.metadata->>'live_spread_bps'),
    public.safe_numeric_v6112(signal#>>'{features,spreadBps}'),
    999
  );

  if v_pattern<>'MOMENTUM_CONTINUATION' then
    reasons:=array_append(reasons,'IOC_BRIDGE_RESERVED_FOR_MOMENTUM');
  end if;
  if not v_convert then reasons:=array_append(reasons,'TAKER_CONVERSION_NOT_APPROVED'); end if;
  if coalesce(v_attempt_ev,-999)<=0 then reasons:=array_append(reasons,'TAKER_ATTEMPT_EV_NOT_POSITIVE'); end if;
  if coalesce(v_conditional_ev,-999)<=0 then reasons:=array_append(reasons,'TAKER_CONDITIONAL_EV_NOT_POSITIVE'); end if;
  if v_spread>cfg.lob_momentum_max_spread_bps then reasons:=array_append(reasons,'TAKER_SPREAD_TOO_WIDE'); end if;

  if cardinality(reasons)>0 then
    raise exception using errcode='P0001',message=format(
      'LOB_ADMISSION_REJECT[%s:%s]: %s',new.exchange,new.market,array_to_string(reasons,',')
    );
  end if;

  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object(
    'execution_lane',jsonb_build_object(
      'revision','6.14.2-MOMENTUM-IOC-EXECUTION',
      'route','LIMIT_IOC',
      'reason','ORDER_TIME_TAKER_EV_POSITIVE',
      'attempt_ev_lower_bound_bps',v_attempt_ev,
      'conditional_ev_lower_bound_bps',v_conditional_ev,
      'spread_bps',v_spread,
      'maker_fill_policy',signal->'maker_fill',
      'activated_at',cfg.lob_momentum_ioc_bridge_activated_at
    )
  );
  return new;
end;
$$;

drop trigger if exists aa0_trading_positions_momentum_ioc_v6142 on public.trading_positions;
create trigger aa0_trading_positions_momentum_ioc_v6142
before insert on public.trading_positions
for each row execute function public.enforce_momentum_ioc_execution_v6142();

revoke all on function public.enforce_momentum_ioc_execution_v6142() from public,anon,authenticated;

comment on function public.enforce_momentum_ioc_execution_v6142() is
  'Temporary candidate-local execution bridge: only order-time taker-approved positive-EV momentum may use LIMIT IOC while global maker is disabled.';

-- Contract tests: approved momentum passes; ordinary pattern and non-approved momentum fail.
create temp table v6142_ioc_test(
  is_paper boolean,state text,metadata jsonb,exchange text,market text
);
create trigger v6142_ioc_test_trigger before insert on v6142_ioc_test
for each row execute function public.enforce_momentum_ioc_execution_v6142();

insert into v6142_ioc_test values(false,'ENTRY_PENDING',jsonb_build_object(
  'live_spread_bps',1.5,
  'lob_signal',jsonb_build_object(
    'strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION',
    'attempt_ev_lower_bound_bps',9.1,'conditional_ev_lower_bound_bps',20.2,
    'maker_fill',jsonb_build_object('convertToTaker',true,'fillRate',0.27),
    'features',jsonb_build_object('spreadBps',1.5)
  )
),'binance','VALIDMOMUSDT');

do $$ begin
  begin
    insert into v6142_ioc_test values(false,'ENTRY_PENDING',jsonb_build_object(
      'live_spread_bps',1.5,
      'lob_signal',jsonb_build_object(
        'strategy','LOB_SCALP','pattern','OFI_CONTINUATION',
        'attempt_ev_lower_bound_bps',9.1,'conditional_ev_lower_bound_bps',20.2,
        'maker_fill',jsonb_build_object('convertToTaker',true),
        'features',jsonb_build_object('spreadBps',1.5)
      )
    ),'binance','ORDINARYUSDT');
    raise exception 'V6142_ORDINARY_IOC_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6142_ORDINARY_IOC_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;

do $$ begin
  begin
    insert into v6142_ioc_test values(false,'ENTRY_PENDING',jsonb_build_object(
      'live_spread_bps',1.5,
      'lob_signal',jsonb_build_object(
        'strategy','LOB_SCALP','pattern','MOMENTUM_CONTINUATION',
        'attempt_ev_lower_bound_bps',9.1,'conditional_ev_lower_bound_bps',20.2,
        'maker_fill',jsonb_build_object('convertToTaker',false),
        'features',jsonb_build_object('spreadBps',1.5)
      )
    ),'binance','UNAPPROVEDUSDT');
    raise exception 'V6142_UNAPPROVED_TAKER_NOT_BLOCKED';
  exception when others then
    if sqlerrm='V6142_UNAPPROVED_TAKER_NOT_BLOCKED' or sqlerrm not like 'LOB_ADMISSION_REJECT%' then raise; end if;
  end;
end $$;
