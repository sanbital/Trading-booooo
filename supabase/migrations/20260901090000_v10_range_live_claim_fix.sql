begin;

create or replace function public.claim_v10_lane_signal_v3()
returns table(
  signal_id uuid,lane text,fingerprint text,symbol text,side text,
  signal_bar_at timestamptz,entry_bar_at timestamptz,hold_hours integer,
  features jsonb,notional_usdt numeric,leverage integer,max_concurrent integer,
  max_aggregate_notional_usdt numeric
)
language plpgsql
set search_path=''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('v10_lane_signal_claim_v3',0)
  );
  perform public.expire_v10_lane_signals_v3();
  if exists(
    select 1 from public.v10_lane_execution_circuit
    where singleton and is_open
  ) then
    return;
  end if;

  return query
  with candidate as (
    select
      s.id,s.lane,s.fingerprint,s.symbol,s.side,s.signal_bar_at,s.entry_bar_at,
      s.hold_hours,s.features,f.notional_usdt,f.leverage,f.max_concurrent,
      f.max_aggregate_notional_usdt
    from public.v10_lane_signals s
    join public.v10_lane_flags f on f.lane=s.lane
    where not s.is_shadow
      and s.lane='RANGE'
      and f.live_enabled
      and f.validated
      and f.engine_revision='V10-LANES-3.0.0'
      and f.spec_sha256='9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f'
      and s.entry_bar_at<=now()
      and s.entry_bar_at>=now()-interval '3 minutes'
      and exists(
        select 1 from public.v10_lane_strategy_versions v
        where v.fingerprint=s.fingerprint
          and v.lane='RANGE'
          and v.revision='V10-LANES-3.0.0'
      )
      and not exists(
        select 1 from public.v10_lane_claims c where c.signal_id=s.id
      )
      and not exists(
        select 1 from public.v10_lane_positions p
        where p.symbol=s.symbol
          and p.state in ('OPEN','CLOSE_SUBMITTED','RECONCILIATION_FAILED')
      )
      and (
        select count(*) from public.v10_lane_positions p
        where p.lane=s.lane
          and p.state in ('OPEN','CLOSE_SUBMITTED','RECONCILIATION_FAILED')
      ) < f.max_concurrent
      and (
        select coalesce(sum(p.entry_notional_usdt/nullif(p.leverage,0)),0)
        from public.v10_lane_positions p
        where p.state in ('OPEN','CLOSE_SUBMITTED','RECONCILIATION_FAILED')
      ) + f.notional_usdt <= f.max_aggregate_notional_usdt
    order by s.entry_bar_at,s.symbol
    for update of s skip locked
    limit 1
  ), claimed as (
    insert into public.v10_lane_claims as vc(signal_id,claim_state)
    select id,'CLAIMED' from candidate
    on conflict on constraint v10_lane_claims_pkey do nothing
    returning vc.signal_id
  )
  select
    c.id,c.lane,c.fingerprint,c.symbol,c.side,c.signal_bar_at,c.entry_bar_at,
    c.hold_hours,c.features,c.notional_usdt,c.leverage,c.max_concurrent,
    c.max_aggregate_notional_usdt
  from candidate c
  join claimed x on x.signal_id=c.id;
end;
$function$;

revoke execute on function public.claim_v10_lane_signal_v3() from public, anon, authenticated;
grant execute on function public.claim_v10_lane_signal_v3() to service_role;

insert into public.v10_lane_deployment_audit(
  stage,engine_revision,spec_sha256,edge_function_slug,passed,details
)
values(
  'RANGE_CLAIM_FUNCTION_FIXED','V10-LANES-3.0.0',
  '9a41b270a1f11a6649bb5ca9510b0b53a48998979e8c4def5aed274262c6a27f',
  'v10-lane-executor',true,
  jsonb_build_object('ambiguous_output_column_fixed',true,'live_enabled',false)
);

commit;
