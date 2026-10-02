-- Recover ambiguous existing dispatches without ever replaying an exchange command.
-- Backward-compatible: existing logged tables, state values, deadlines and claim reserve.
create table if not exists public.leader20_execution_recovery_events (
 id bigint generated always as identity primary key,
 signal_id uuid not null references public.leader20_execution_dispatches(signal_id),
 event text not null,prior_state text,order_id uuid,evidence jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp()
);
alter table public.leader20_execution_recovery_events enable row level security;
revoke all on public.leader20_execution_recovery_events from public,anon,authenticated;
grant select,insert on public.leader20_execution_recovery_events to service_role;
CREATE OR REPLACE FUNCTION public.leader20_execution_claim(p_signal_id uuid, p_owner uuid, p_min_remaining_ms bigint DEFAULT 24000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d public.leader20_execution_dispatches%rowtype;
  at_time timestamptz:=clock_timestamp();
  remaining_ms numeric; existing_order uuid;
begin
  if p_owner is null or p_min_remaining_ms is null or p_min_remaining_ms<1000 or p_min_remaining_ms>60000 then
    raise exception 'EXECUTION_CLAIM_INPUT';
  end if;

  loop
    d:=null;
    if p_signal_id is not null then
      select * into d from public.leader20_execution_dispatches
      where signal_id=p_signal_id for update;
    else
      select * into d from public.leader20_execution_dispatches
      where state='READY_TO_EXECUTE'
         or (state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and claim_lease_until<=at_time)
      order by dispatch_requested_at
      for update skip locked limit 1;
    end if;

    if d.signal_id is null then
      return jsonb_build_object('claimed',false,'reason','NO_READY_EXECUTION');
    end if;
    if d.state not in ('READY_TO_EXECUTE','EXECUTION_CLAIMED','ORDER_SUBMITTING') then
      return jsonb_build_object('claimed',false,'reason','EXECUTION_TERMINAL','row',to_jsonb(d));
    end if;
    if d.state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and d.claim_lease_until>at_time then
      return jsonb_build_object('claimed',false,'reason','EXECUTION_ALREADY_CLAIMED','row',to_jsonb(d));
    end if;

    -- A lease timeout says nothing about whether an exchange accepted the order.
    -- Never turn SUBMITTING into another entry claim, including after deadline.
    select id into existing_order from public.v11_long_regime_orders
      where signal_id=d.signal_id and intent='OPEN_LONG'
      order by created_at limit 1;
    if d.state='ORDER_SUBMITTING' or d.order_id is not null or existing_order is not null then
      update public.leader20_execution_dispatches
      set state='UNKNOWN',claim_owner=null,claim_lease_until=null,
          order_id=coalesce(order_id,existing_order),terminal_at=null,terminal_reason=null,
          last_error='ORDER_IDENTITY_RECONCILIATION_REQUIRED',updated_at=at_time
      where signal_id=d.signal_id returning * into d;
      insert into public.leader20_execution_recovery_events(signal_id,event,prior_state,order_id,evidence)
        values(d.signal_id,'SUBMISSION_RECOVERY_REQUIRED','AMBIGUOUS_CLAIM',d.order_id,
          jsonb_build_object('no_resubmit',true,'deadline',d.valid_until));
      if p_signal_id is not null then
        return jsonb_build_object('claimed',false,'reason','ORDER_IDENTITY_RECONCILIATION_REQUIRED','row',to_jsonb(d));
      end if;
      continue;
    end if;

    remaining_ms:=extract(epoch from d.valid_until-at_time)*1000;
    if remaining_ms<=0 then
      update public.leader20_execution_dispatches
      set state='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',terminal_at=at_time,
          terminal_reason='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',claim_owner=null,
          claim_lease_until=null,updated_at=at_time
      where signal_id=d.signal_id returning * into d;
      update public.leader20_clock_executions
      set terminal_reason=coalesce(terminal_reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION'),
          execution_failure_reason=coalesce(execution_failure_reason,'CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION'),
          updated_at=at_time
      where signal_id=d.signal_id and order_sent_at is null;
      if p_signal_id is not null then
        return jsonb_build_object('claimed',false,'reason','CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION','row',to_jsonb(d));
      end if;
      continue;
    end if;

    if remaining_ms<p_min_remaining_ms then
      update public.leader20_execution_dispatches
      set state='EXECUTION_WINDOW_INSUFFICIENT',terminal_at=at_time,
          terminal_reason='EXECUTION_WINDOW_INSUFFICIENT',claim_owner=null,
          claim_lease_until=null,updated_at=at_time
      where signal_id=d.signal_id returning * into d;
      update public.leader20_clock_executions
      set terminal_reason=coalesce(terminal_reason,'EXECUTION_WINDOW_INSUFFICIENT'),
          execution_failure_reason=coalesce(execution_failure_reason,'EXECUTION_WINDOW_INSUFFICIENT'),
          updated_at=at_time
      where signal_id=d.signal_id and order_sent_at is null;
      if p_signal_id is not null then
        return jsonb_build_object('claimed',false,'reason','EXECUTION_WINDOW_INSUFFICIENT',
          'remaining_ms',remaining_ms,'row',to_jsonb(d));
      end if;
      continue;
    end if;

    update public.leader20_execution_dispatches
    set state='EXECUTION_CLAIMED',claim_owner=p_owner,
        claim_lease_until=least(valid_until,at_time+interval '90 seconds'),
        executor_claimed_at=at_time,
        execution_started_at=coalesce(execution_started_at,at_time),
        claim_attempts=claim_attempts+1,last_error=null,updated_at=at_time
    where signal_id=d.signal_id returning * into d;
    update public.leader20_clock_executions
    set executor_claimed_at=coalesce(executor_claimed_at,at_time),updated_at=at_time
    where signal_id=d.signal_id;
    return jsonb_build_object('claimed',true,'remaining_ms',remaining_ms,'row',to_jsonb(d));
  end loop;
end $function$
;

revoke all on function public.leader20_execution_claim(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.leader20_execution_claim(uuid,uuid,bigint) to service_role;
comment on function public.leader20_execution_claim(uuid,uuid,bigint) is 'DISPATCH_NO_RESUBMIT_1: ambiguous submission and existing order require reconciliation before deadline handling; never reclaim for order execution.';
CREATE OR REPLACE FUNCTION public.leader20_execution_transition(p_signal_id uuid, p_owner uuid, p_state text, p_error text DEFAULT NULL::text, p_order_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d public.leader20_execution_dispatches%rowtype;at_time timestamptz:=clock_timestamp();next_state text:=p_state;
begin
 select * into d from public.leader20_execution_dispatches where signal_id=p_signal_id for update;
 if d.signal_id is null then return jsonb_build_object('updated',false,'reason','DISPATCH_NOT_FOUND');end if;
 if d.claim_owner is distinct from p_owner or d.state not in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') then
  return jsonb_build_object('updated',false,'reason','DISPATCH_OWNER_OR_STATE','row',to_jsonb(d));
 end if;
 if next_state not in ('READY_TO_EXECUTE','ORDER_SUBMITTING','FILLED','PARTIALLY_FILLED',
  'PARTIALLY_FILLED_CANCELED','REJECTED','EXPIRED','UNKNOWN',
  'EXECUTION_WINDOW_INSUFFICIENT','CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION') then
  raise exception 'EXECUTION_TRANSITION_STATE';
 end if;
 if d.state='ORDER_SUBMITTING' and next_state='READY_TO_EXECUTE' then
  next_state:='UNKNOWN';p_error:=coalesce(p_error,'SUBMISSION_OUTCOME_UNKNOWN');
 end if;
 if next_state='READY_TO_EXECUTE' and d.valid_until<=at_time then next_state:='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION';end if;
 if next_state='READY_TO_EXECUTE' and extract(epoch from d.valid_until-at_time)*1000<24000 then next_state:='EXECUTION_WINDOW_INSUFFICIENT';end if;
 if next_state='READY_TO_EXECUTE' then
  update public.leader20_execution_dispatches set state=next_state,claim_owner=null,claim_lease_until=null,
   last_error=left(p_error,500),updated_at=at_time where signal_id=p_signal_id returning * into d;
 elsif next_state='ORDER_SUBMITTING' then
  update public.leader20_execution_dispatches set state=next_state,order_id=coalesce(p_order_id,order_id),
   claim_lease_until=least(valid_until,at_time+interval '90 seconds'),updated_at=at_time
   where signal_id=p_signal_id returning * into d;
 elsif next_state='UNKNOWN' then
  update public.leader20_execution_dispatches set state='UNKNOWN',order_id=coalesce(p_order_id,order_id),
   claim_owner=null,claim_lease_until=null,terminal_at=null,terminal_reason=null,
   last_error=left(coalesce(p_error,'SUBMISSION_OUTCOME_UNKNOWN'),500),updated_at=at_time
   where signal_id=p_signal_id returning * into d;
 else
  update public.leader20_execution_dispatches set state=next_state,order_id=coalesce(p_order_id,order_id),
   terminal_at=at_time,terminal_reason=next_state,last_error=left(p_error,500),claim_lease_until=null,
   updated_at=at_time where signal_id=p_signal_id returning * into d;
  update public.leader20_clock_executions set terminal_reason=coalesce(terminal_reason,next_state),
   execution_failure_reason=case when next_state in ('FILLED','PARTIALLY_FILLED','PARTIALLY_FILLED_CANCELED')
    then execution_failure_reason else coalesce(execution_failure_reason,left(p_error,500),next_state) end,
   updated_at=at_time where signal_id=p_signal_id;
 end if;
 return jsonb_build_object('updated',true,'row',to_jsonb(d));
end $function$;
revoke all on function public.leader20_execution_transition(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.leader20_execution_transition(uuid,uuid,text,text,uuid) to service_role;
-- Advance UNKNOWN only from the existing engine's same-decision, same-order durable
-- reconciliation. This RPC never contacts the exchange or creates/claims an entry.
create or replace function public.leader20_reconcile_execution_dispatches(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.leader20_execution_dispatches%rowtype;o public.v11_long_regime_orders%rowtype;
 p public.v11_long_regime_positions%rowtype;valid boolean;has_order boolean;next_state text;
 at_time timestamptz:=clock_timestamp();settled int:=0;seen int:=0;total numeric;target numeric;posid uuid;
 evidence jsonb;executed numeric;requested numeric;
begin
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'DISPATCH_RECONCILIATION_LIMIT';end if;
 for d in select * from public.leader20_execution_dispatches
   where state='UNKNOWN' or (state='ORDER_SUBMITTING' and claim_lease_until<=at_time)
   order by updated_at,signal_id for update skip locked limit p_limit
 loop
  seen=seen+1;valid=true;has_order=false;total=0;target=null;posid=null;next_state=null;
  for o in select * from public.v11_long_regime_orders where signal_id=d.signal_id and intent='OPEN_LONG' order by created_at,id loop
   has_order=true;
   -- Do not join a later approval for a recycled signal UUID to this dispatch.
   if o.symbol is distinct from d.symbol
     or o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,signal_id}' is distinct from d.signal_id::text
     or o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,completed_at_ms}' is distinct from (extract(epoch from d.gpt_completed_at)*1000)::bigint::text
     or o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,authority_version}' is distinct from 'TOP20_CLOCK_GPT_FINAL_3'
     or o.request_payload#>>'{order,side}' is distinct from 'BUY'
     or o.request_payload#>>'{order,position_effect}' is distinct from 'OPEN' then valid=false;exit;end if;
   target=coalesce(target,o.requested_quantity);
   evidence=o.response_payload->'orderStateEvidence';
   if o.state in ('FILLED','PARTIALLY_FILLED_CANCELED','EXPIRED','REJECTED')
     and o.response_payload->'v18ExposureFinal'='true'::jsonb
     and evidence->'quantityConsistent'='true'::jsonb
     and evidence#>'{reconciliation,observed}'='true'::jsonb
     and jsonb_typeof(evidence->'executedQty')='number' and jsonb_typeof(evidence->'requestedQty')='number'
     and evidence->>'state'=o.state then
    executed=(evidence->>'executedQty')::numeric;requested=(evidence->>'requestedQty')::numeric;
    if requested<>o.requested_quantity or executed<0 or executed>requested
      or (o.state='FILLED' and (executed<>requested or evidence->>'rawStatus' is distinct from 'FILLED'))
      or (o.state='PARTIALLY_FILLED_CANCELED' and not(executed>0 and executed<requested)) then valid=false;exit;end if;
    total=total+executed;
    if executed>0 then
     if o.position_id is null or (posid is not null and posid<>o.position_id) then valid=false;exit;end if;
     posid=o.position_id;
    end if;
   elsif o.state='REJECTED' and (o.response_payload->'notDispatched'='true'::jsonb
       or (o.response_payload->'v18ExposureFinal'='true'::jsonb and o.response_payload#>'{v18EntryNeverPlaced,neverPlaced}'='true'::jsonb)) then
    null; -- Explicit no-send or the existing corroborated never-placed proof.
   else valid=false;exit;
   end if;
  end loop;
  if not has_order or not valid then continue;end if;
  if total>0 then
   select * into p from public.v11_long_regime_positions where id=posid;
   if not found or p.signal_id is distinct from d.signal_id or p.symbol is distinct from d.symbol
     or p.metadata->>'executionMode' is distinct from 'LEADER_MOMENTUM_V17'
     or abs(p.original_quantity-total)>greatest(0.00000001,total*0.000000001) then continue;end if;
   next_state=case when total>=target-greatest(0.00000001,target*0.000000001) then 'FILLED' else 'PARTIALLY_FILLED_CANCELED' end;
  else next_state='REJECTED';end if;
  update public.leader20_execution_dispatches set state=next_state,claim_owner=null,claim_lease_until=null,
   terminal_at=at_time,terminal_reason=next_state,last_error=null,updated_at=at_time where signal_id=d.signal_id;
  update public.leader20_clock_executions set terminal_reason=next_state,updated_at=at_time where signal_id=d.signal_id;
  insert into public.leader20_execution_recovery_events(signal_id,event,prior_state,order_id,evidence)
   values(d.signal_id,'DURABLE_ORDER_RECONCILED',d.state,d.order_id,jsonb_build_object('state',next_state,'quantity',total,'position_id',posid,'no_resubmit',true));
  settled=settled+1;
 end loop;
 return jsonb_build_object('inspected',seen,'reconciled',settled,'no_resubmit',true);
end $$;
revoke all on function public.leader20_reconcile_execution_dispatches(integer) from public,anon,authenticated;
grant execute on function public.leader20_reconcile_execution_dispatches(integer) to service_role;
comment on function public.leader20_reconcile_execution_dispatches(integer) is 'DISPATCH_NO_RESUBMIT_1: same-decision durable receipt and position proof only; no exchange submit or stale BUY replay.';

create index if not exists leader20_dispatch_recovery_pending on public.leader20_execution_dispatches(updated_at,signal_id) where state in ('UNKNOWN','ORDER_SUBMITTING');
