-- REVIEW CANDIDATE. Apply only to the approved project/commit after a backup.
-- No circuit reset, trading toggle, historical position/PnL rewrite or scheduler change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.v11_long_regime_positions alter column realized_pnl_usdt drop not null;
alter table public.v11_long_regime_positions alter column entry_fee_usdt drop not null;
alter table public.v11_long_regime_runtime
  add column if not exists incident_id uuid,
  add column if not exists incident_generation bigint not null default 0,
  add column if not exists incident_kind text,
  add column if not exists incident_opened_at timestamptz,
  add column if not exists incident_last_checked_at timestamptz,
  add column if not exists incident_resolved_at timestamptz,
  add column if not exists last_cycle_started_at timestamptz,
  add column if not exists last_cycle_completed_at timestamptz,
  add column if not exists last_management_success_at timestamptz,
  add column if not exists last_reconciliation_success_at timestamptz,
  add column if not exists entry_block_reason text,
  add column if not exists protection_health text,
  add column if not exists reconciliation_pending_age double precision;

create table if not exists public.v18_ops_incidents (
  id uuid primary key, generation bigint not null, kind text not null, reason text not null,
  evidence jsonb not null default '{}', opened_at timestamptz not null default clock_timestamp(),
  last_checked_at timestamptz, resolved_at timestamptz,
  clean_checks integer not null default 0, first_clean_at timestamptz,
  last_observation_id text, last_observed_at timestamptz, resolution_evidence jsonb
);
alter table public.v18_ops_incidents enable row level security;
revoke all on public.v18_ops_incidents from public,anon,authenticated;
grant select,insert,update on public.v18_ops_incidents to service_role;

-- Production still has an enabled legacy cap=3 trigger while V17's declared limit
-- is 10. Keep the legacy limit for legacy rows; enforce the existing V17 limit.
create or replace function public.v11_long_regime_enforce_slot_cap()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare slot_cap integer; open_count integer;
begin
 if new.state is distinct from 'OPEN' then return new; end if;
 slot_cap:=case when new.metadata->>'executionMode'='LEADER_MOMENTUM_V17' then 10 else 3 end;
 perform pg_advisory_xact_lock(hashtext('v11_long_regime_slot_cap'));
 select count(*) into open_count from public.v11_long_regime_positions where state='OPEN' and id is distinct from new.id;
 if open_count>=slot_cap then raise exception 'V11_SLOT_CAP_EXCEEDED: % open positions already, cap is %',open_count,slot_cap using errcode='23505'; end if;
 return new;
end $$;

-- Invoker RPCs retain existing service-role authentication. No new SECURITY DEFINER.
create or replace function public.v18_require_lease(p_owner uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare l public.v17_execution_lease%rowtype;
begin
 select * into l from public.v17_execution_lease where singleton for share;
 if p_owner is null or l.owner is distinct from p_owner or l.expires_at<=clock_timestamp()+interval '1 second' then
   raise exception 'V18_EXECUTION_FENCED';
 end if;
end $$;

create or replace function public.v18_fence_executor_write()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare owner_text text;
begin
 owner_text:=nullif(current_setting('request.headers',true),'')::jsonb->>'x-v18-execution-owner';
 -- Only this executor attaches this header. Other authenticated services keep their
 -- existing grants and triggers; no caller is granted new access by this fence.
 if owner_text is not null then perform public.v18_require_lease(owner_text::uuid); end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['v11_long_regime_runtime','v11_long_regime_positions','v11_long_regime_orders','v11_long_regime_signals','v11_long_regime_decisions'] loop
   execute format('drop trigger if exists v18_executor_fence on public.%I',t);
   execute format('create trigger v18_executor_fence before insert or update on public.%I for each row execute function public.v18_fence_executor_write()',t);
 end loop;
end $$;

create or replace function public.v18_record_incident(p_owner uuid,p_kind text,p_reason text,p_evidence jsonb)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.v11_long_regime_runtime%rowtype; incident uuid;
begin
 perform public.v18_require_lease(p_owner);
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 -- Identical unresolved cause is one incident. New cause creates a new generation;
 -- earlier recovery observations cannot clear it, including a repeated error later.
 if r.circuit_open and r.incident_kind=p_kind and r.circuit_reason=p_reason and r.incident_id is not null then
   update public.v18_ops_incidents set last_checked_at=clock_timestamp(),evidence=p_evidence,
     clean_checks=0,first_clean_at=null,last_observation_id=null,last_observed_at=null where id=r.incident_id;
   update public.v11_long_regime_runtime set incident_last_checked_at=clock_timestamp() where singleton;
   return r.incident_id;
 end if;
 incident:=gen_random_uuid();
 insert into public.v18_ops_incidents(id,generation,kind,reason,evidence)
 values(incident,r.incident_generation+1,p_kind,p_reason,p_evidence);
 update public.v11_long_regime_runtime set circuit_open=true,circuit_reason=p_reason,last_error=p_reason,
   incident_id=incident,incident_generation=r.incident_generation+1,incident_kind=p_kind,
   incident_opened_at=clock_timestamp(),incident_last_checked_at=clock_timestamp(),incident_resolved_at=null,
   updated_at=clock_timestamp() where singleton;
 return incident;
end $$;

-- An older authenticated writer may still raise a circuit without incident fields.
-- Give that event a new, non-recoverable epoch rather than letting an old proof clear it.
create or replace function public.v18_external_incident_epoch()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.circuit_open and (not old.circuit_open or new.circuit_reason is distinct from old.circuit_reason or new.last_error is distinct from old.last_error)
    and new.incident_id is not distinct from old.incident_id and new.incident_generation=old.incident_generation then
   new.incident_id:=gen_random_uuid();new.incident_generation:=old.incident_generation+1;
   new.incident_kind:='MANUAL_REVIEW_REQUIRED';new.incident_opened_at:=clock_timestamp();new.incident_resolved_at:=null;
   insert into public.v18_ops_incidents(id,generation,kind,reason,evidence)
     values(new.incident_id,new.incident_generation,new.incident_kind,coalesce(new.circuit_reason,new.last_error,'EXTERNAL_WRITER'),jsonb_build_object('source','PRE_EXISTING_WRITER'));
 end if;
 return new;
end $$;
drop trigger if exists v18_external_incident_epoch on public.v11_long_regime_runtime;
create trigger v18_external_incident_epoch before update on public.v11_long_regime_runtime
 for each row execute function public.v18_external_incident_epoch();

create or replace function public.v18_recovery_observation(p_owner uuid,p_incident_id uuid,p_generation bigint,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='500ms' as $$
declare r public.v11_long_regime_runtime%rowtype; i public.v18_ops_incidents%rowtype;
 c public.v17_operator_control%rowtype; s public.trading_settings%rowtype;
 seen timestamptz; obs text; expected jsonb; actual jsonb; checks integer;
begin
 perform public.v18_require_lease(p_owner);
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 if not r.circuit_open or r.incident_id is distinct from p_incident_id or r.incident_generation<>p_generation then
   return jsonb_build_object('resolved',false,'reason','INCIDENT_CAS_MISS');
 end if;
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.generation is distinct from r.incident_generation or i.reason is distinct from r.circuit_reason or i.kind is distinct from r.incident_kind or
    i.kind not in ('KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION','INCOMPLETE_OR_STALE_SNAPSHOT','TRANSIENT_DEPENDENCY','ACCOUNTING_DETAILS_PENDING','DB_CAS_CONFLICT') then
   return jsonb_build_object('resolved',false,'reason','MANUAL_REVIEW_REQUIRED');
 end if;
 select * into strict c from public.v17_operator_control where singleton for share;
 select * into strict s from public.trading_settings where id=1 for share;
 if r.live_enabled is not true or c.entry_enabled is not true or c.legacy_entries_retired is not true or s.mode is distinct from 'LIVE_LIMITED' or
   s.pause_new_entries is distinct from false or s.withdrawal_mode is distinct from false or s.manual_intervention_required is distinct from false or s.scalp_kill_switch is distinct from false or s.emergency_liquidation is distinct from false or s.pause_lock_reason is not null then
   update public.v18_ops_incidents set clean_checks=0,first_clean_at=null where id=i.id;
   return jsonb_build_object('resolved',false,'reason','OPERATOR_HALT');
 end if;
 seen:=to_timestamp((p_evidence#>>'{observation,requested_at_ms}')::double precision/1000);
 obs:=p_evidence#>>'{observation,id}';
 if obs is null or obs='' or p_evidence#>>'{observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or
   jsonb_typeof(p_evidence->'positions') is distinct from 'array' or
   p_evidence#>>'{observation,received_at_ms}' is null or
   (p_evidence#>>'{observation,received_at_ms}')::double precision<(p_evidence#>>'{observation,requested_at_ms}')::double precision or
   p_evidence->>'ordersObservedAt' is null or seen is null or seen<clock_timestamp()-interval '5 seconds' or seen>clock_timestamp()+interval '1 second' or
   to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)>clock_timestamp()+interval '1 second' or
   to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)<clock_timestamp()-interval '8 seconds' then
   return jsonb_build_object('resolved',false,'reason','STALE_EVIDENCE');
 end if;
 -- Fence all position/order mutations for the short validation/CAS transaction.
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at,'quantity',remaining_quantity) order by id),'[]') into actual
 from public.v11_long_regime_positions where state='OPEN';
 select coalesce(jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'updated_at',(x->>'updated_at')::timestamptz,'quantity',(x->>'quantity')::numeric) order by x->>'id'),'[]') into expected
 from jsonb_array_elements(p_evidence->'positions') x;
 if actual is distinct from expected or exists(select 1 from public.v11_long_regime_orders
   where state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and
     coalesce(response_payload->>'v18ExposureFinal','false')<>'true') then
   update public.v18_ops_incidents set clean_checks=0,first_clean_at=null where id=i.id;
   return jsonb_build_object('resolved',false,'reason','EXPOSURE_CHANGED');
 end if;
 if seen<clock_timestamp()-interval '5 seconds' then return jsonb_build_object('resolved',false,'reason','STALE_EVIDENCE_AFTER_LOCK'); end if;
 -- One-minute scheduler: three independent observations, separated by >=50 seconds,
 -- spanning >=110 seconds. Re-reading the same cached response never advances checks.
 if obs=i.last_observation_id or seen<i.last_observed_at+interval '50 seconds' then
   return jsonb_build_object('resolved',false,'reason','OBSERVATION_NOT_INDEPENDENT','checks',i.clean_checks);
 end if;
 checks:=case when i.last_observed_at is null or seen<=i.last_observed_at+interval '90 seconds' then i.clean_checks+1 else 1 end;
 update public.v18_ops_incidents set clean_checks=checks,first_clean_at=case when checks=1 then seen else first_clean_at end,
   last_observation_id=obs,last_observed_at=seen,last_checked_at=clock_timestamp(),resolution_evidence=p_evidence where id=i.id;
 update public.v11_long_regime_runtime set incident_last_checked_at=clock_timestamp() where singleton;
 if checks<3 or i.first_clean_at is null or seen<i.first_clean_at+interval '110 seconds' then
   return jsonb_build_object('resolved',false,'reason','VERIFYING','checks',checks);
 end if;
 update public.v11_long_regime_runtime set circuit_open=false,circuit_reason=null,last_error=null,
   incident_resolved_at=clock_timestamp(),entry_block_reason='RECOVERED_WAITING_FOR_STRATEGY',updated_at=clock_timestamp()
 where singleton and incident_id=p_incident_id and incident_generation=p_generation;
 update public.v18_ops_incidents set resolved_at=clock_timestamp() where id=i.id;
 return jsonb_build_object('resolved',true,'incidentId',i.id,'checks',checks);
end $$;

-- Preserve existing attribution policy and privileges, add account/stop identity checks.
CREATE OR REPLACE FUNCTION public.enforce_futures_fill_order_attribution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.trading_orders%rowtype;
  v_v17 public.v11_long_regime_orders%rowtype;
  v_v17_position uuid;
  v_position_id uuid;
begin
  if new.exchange <> 'binance_futures' or new.account_scope <> 'futures' then
    return new;
  end if;

  -- V17 lane first: it is the lane that currently trades this account.
  select o.* into v_v17
  from public.v11_long_regime_orders o
  where o.exchange_order_id is not null
    and o.exchange_order_id = new.exchange_order_id
    and o.symbol = new.market
  order by o.created_at desc
  limit 1;

  if found then
    new.v17_order_id := v_v17.id;
    new.v17_position_id := v_v17.position_id;
    new.client_order_id := coalesce(nullif(new.client_order_id, ''), v_v17.client_order_id);
    -- The legacy FK columns stay null: a V17 id is not a trading_orders id.
    new.bot_order_id := null;
    new.position_id := null;
    new.source := 'AUTOMATED';
    new.accounting_status := case when v_v17.position_id is not null then 'PENDING'
                                  else 'UNMATCHED_INVENTORY' end;
    return new;
  end if;

  -- An exchange-resident stop (V17_NATIVE_STOP) closes the position through
  -- /fapi/v1/algoOrder. The resulting market order carries the algo's actualOrderId and
  -- has no row in v11_long_regime_orders, so the protection journal on the position is
  -- the only link back. Verified against EGLDUSDT order 9678930536 on 2026-09-08.
  if new.exchange_order_id is not null then
    select p.id into v_v17_position
    from public.v11_long_regime_positions p
    where p.symbol = new.market
      and p.side='LONG' and p.metadata->>'executionMode'='LEADER_MOMENTUM_V17'
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(p.metadata->'exitProtection'->'orders', '[]'::jsonb)) o
        where o->>'actualOrderId' = new.exchange_order_id
          and o#>>'{spec,params,symbol}'=new.market
          and o#>>'{spec,params,side}'='SELL'
          and o#>>'{spec,params,reduceOnly}'='true')
    order by p.updated_at desc
    limit 1;

    if v_v17_position is not null then
      -- No v17_order_id exists for a native stop; the position carries the attribution.
      new.v17_order_id := null;
      new.v17_position_id := v_v17_position;
      new.bot_order_id := null;
      new.position_id := null;
      new.source := 'AUTOMATED';
      new.accounting_status := 'PENDING';
      return new;
    end if;
  end if;

  select o.* into v_order
  from public.trading_orders o
  where o.exchange = 'binance_futures'
    and o.market = new.market
    and o.exchange_order_id is not null
    and o.exchange_order_id = new.exchange_order_id
  order by o.created_at desc
  limit 1;

  if found then
    new.bot_order_id := v_order.id;
    new.position_id := v_order.position_id;
    new.client_order_id := coalesce(nullif(new.client_order_id, ''), v_order.identifier);
    new.source := 'AUTOMATED';
    if new.position_id is not null then
      new.accounting_status := 'PENDING';
    end if;
    return new;
  end if;

  new.bot_order_id := null;
  new.client_order_id := null;
  new.source := 'MANUAL';
  v_position_id := null;

  if upper(coalesce(new.side,'')) = 'SELL'
     and coalesce(new.quantity,0) > 0
     and new.executed_at is not null then

    -- Once a manual fill has been safely attributed, keep that attribution immutable
    -- across later idempotent upserts even after the position has fully closed.
    if tg_op = 'UPDATE'
       and old.position_id is not null
       and old.exchange = 'binance_futures'
       and old.market = new.market
       and old.exchange_trade_id = new.exchange_trade_id then
      select p.id into v_position_id
      from public.trading_positions p
      where p.id = old.position_id
        and p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
      limit 1;
    end if;

    -- For a newly supplied Edge position id, require positive linked inventory at
    -- the fill instant. This prevents an unrelated manual sell from being attached.
    if v_position_id is null and new.position_id is not null then
      select p.id into v_position_id
      from public.trading_positions p
      where p.id = new.position_id
        and p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
        and coalesce((
          select sum(case when upper(f.side)='BUY' then f.quantity else -f.quantity end)
          from public.exchange_trade_fills f
          where f.exchange='binance_futures'
            and f.position_id=p.id
        ),0) > greatest(
          coalesce((
            select sum(f.quantity)
            from public.exchange_trade_fills f
            where f.exchange='binance_futures'
              and f.position_id=p.id
              and upper(f.side)='BUY'
          ),0) * 1e-7,
          1e-10
        )
      limit 1;
    end if;

    if v_position_id is null then
      perform pg_advisory_xact_lock(hashtext('manual-futures-sell:' || new.market));
      select p.id into v_position_id
      from public.trading_positions p
      where p.exchange = 'binance_futures'
        and p.market = new.market
        and coalesce(p.is_paper,false) = false
        and p.opened_at is not null
        and p.opened_at <= new.executed_at
        and (p.closed_at is null or p.closed_at >= new.executed_at)
        and coalesce((
          select sum(case when upper(f.side)='BUY' then f.quantity else -f.quantity end)
          from public.exchange_trade_fills f
          where f.exchange='binance_futures'
            and f.position_id=p.id
        ),0) > greatest(
          coalesce((
            select sum(f.quantity)
            from public.exchange_trade_fills f
            where f.exchange='binance_futures'
              and f.position_id=p.id
              and upper(f.side)='BUY'
          ),0) * 1e-7,
          1e-10
        )
      order by p.opened_at desc, p.created_at desc
      limit 1;
    end if;
  end if;

  new.position_id := v_position_id;
  -- UNPROVEN_FUTURES_SOURCE_20260908: absence of a bot match does not prove manual ownership.
  if v_position_id is null then
    new.source := 'UNCLASSIFIED';
  end if;
  new.accounting_status := case when v_position_id is not null then 'PENDING' else 'UNMATCHED_INVENTORY' end;
  return new;
end;
$function$
;

-- Revisit raw fills when attribution arrives AFTER the fill. This changes attribution
-- only; the executor's receipt CAS remains the single position/PnL writer.
create or replace function public.v18_retry_lane_fill_attribution()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_table_name='v11_long_regime_orders' then
   if new.exchange_order_id is not null then
     update public.exchange_trade_fills set exchange_order_id=exchange_order_id
     where exchange='binance_futures' and account_scope='futures' and market=new.symbol and
       exchange_order_id=new.exchange_order_id and bot_order_id is null and position_id is null and
       (v17_order_id is null or v17_position_id is distinct from new.position_id);
   end if;
 else
   update public.exchange_trade_fills f set exchange_order_id=f.exchange_order_id
   where f.exchange='binance_futures' and f.account_scope='futures' and f.market=new.symbol and
     f.bot_order_id is null and f.position_id is null and f.v17_position_id is null and
     exists(select 1 from jsonb_array_elements(coalesce(new.metadata#>'{exitProtection,orders}','[]')) o
       where o->>'actualOrderId'=f.exchange_order_id and o#>>'{spec,params,symbol}'=f.market and
         o#>>'{spec,params,side}'='SELL' and o#>>'{spec,params,reduceOnly}'='true');
 end if;
 return new;
end $$;
drop trigger if exists v18_retry_order_fill on public.v11_long_regime_orders;
create trigger v18_retry_order_fill after insert or update of exchange_order_id,position_id on public.v11_long_regime_orders
for each row execute function public.v18_retry_lane_fill_attribution();
drop trigger if exists v18_retry_native_fill on public.v11_long_regime_positions;
create trigger v18_retry_native_fill after update of metadata on public.v11_long_regime_positions
for each row when (old.metadata->'exitProtection' is distinct from new.metadata->'exitProtection')
execute function public.v18_retry_lane_fill_attribution();
create index if not exists v18_pending_fill_identity on public.exchange_trade_fills(exchange,account_scope,market,exchange_order_id)
where v17_position_id is null and bot_order_id is null and position_id is null;
create index if not exists v18_pending_order_queue on public.v11_long_regime_orders(updated_at)
where state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED');

create or replace function public.v18_native_terminal_signal()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if new.metadata->>'executionMode'='LEADER_MOMENTUM_V17' and new.remaining_quantity=0 and new.closed_at is not null and
    exists(select 1 from jsonb_array_elements(coalesce(new.metadata#>'{exitProtection,orders}','[]')) o
      where o->>'actualOrderId' is not null and (o->>'appliedQuantity')::numeric>0) then
   update public.v11_long_regime_signals set status='CLOSED',updated_at=clock_timestamp()
     where id=new.signal_id and position_id=new.id and status in ('FILLED','ORDERED');
 end if;
 return new;
end $$;
drop trigger if exists v18_native_terminal_signal on public.v11_long_regime_positions;
create trigger v18_native_terminal_signal after update of state on public.v11_long_regime_positions
for each row when (old.state='OPEN' and new.state='CLOSED') execute function public.v18_native_terminal_signal();

revoke all on function public.v18_require_lease(uuid),public.v18_fence_executor_write(),
 public.v18_record_incident(uuid,text,text,jsonb),public.v18_recovery_observation(uuid,uuid,bigint,jsonb),
 public.v18_native_terminal_signal(),public.v18_external_incident_epoch(),public.v18_retry_lane_fill_attribution() from public,anon,authenticated;
grant execute on function public.v18_require_lease(uuid),public.v18_fence_executor_write(),
 public.v18_record_incident(uuid,text,text,jsonb),public.v18_recovery_observation(uuid,uuid,bigint,jsonb),
 public.v18_native_terminal_signal(),public.v18_external_incident_epoch(),public.v18_retry_lane_fill_attribution() to service_role;
commit;
