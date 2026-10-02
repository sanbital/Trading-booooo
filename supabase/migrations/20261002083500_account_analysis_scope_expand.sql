-- Disabled expand: separate analysis single-flight from account side-effect ownership.
begin;
set local lock_timeout='2s';set local statement_timeout='10s';
create table if not exists public.v17_execution_infrastructure_control(
 singleton boolean primary key default true check(singleton),
 short_writer_enabled boolean not null default false,updated_at timestamptz not null default clock_timestamp());
insert into public.v17_execution_infrastructure_control(singleton) values(true) on conflict do nothing;
create table if not exists public.v17_analysis_lease(
 singleton boolean primary key default true check(singleton),owner uuid,fence bigint not null default 0,
 expires_at timestamptz not null default '-infinity',postmaster_started_at timestamptz,heartbeat_at timestamptz);
insert into public.v17_analysis_lease(singleton) values(true) on conflict do nothing;
alter table public.v17_execution_infrastructure_control enable row level security;
alter table public.v17_analysis_lease enable row level security;
revoke all on public.v17_execution_infrastructure_control,public.v17_analysis_lease from anon,authenticated;
grant all on public.v17_execution_infrastructure_control,public.v17_analysis_lease to service_role;
alter table public.leader20_execution_dispatches add column if not exists claim_postmaster_at timestamptz;
update public.leader20_execution_dispatches set claim_postmaster_at=pg_postmaster_start_time()
 where claim_owner is not null and claim_postmaster_at is null;
create or replace function public.v17_stamp_dispatch_claim_generation() returns trigger language plpgsql set search_path='' as $fn$
begin
 if new.claim_owner is not null and (new.claim_owner is distinct from old.claim_owner or
    (new.state='EXECUTION_CLAIMED' and old.state='READY_TO_EXECUTE')) then
  new.claim_postmaster_at:=pg_postmaster_start_time();
 end if;return new;
end $fn$;
create trigger v17_dispatch_claim_generation before update on public.leader20_execution_dispatches
 for each row execute function public.v17_stamp_dispatch_claim_generation();
create function public.v17_acquire_analysis_lease(p_owner uuid) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare l public.v17_analysis_lease%rowtype;
begin
 if p_owner is null then return null;end if;
 update public.v17_analysis_lease set owner=p_owner,fence=fence+1,
 expires_at=clock_timestamp()+interval '150 seconds',heartbeat_at=clock_timestamp(),postmaster_started_at=pg_postmaster_start_time()
 where singleton and (expires_at<clock_timestamp() or postmaster_started_at is distinct from pg_postmaster_start_time()) returning * into l;
 if not found then return null;end if;return to_jsonb(l);
end $fn$;
create function public.v17_require_analysis_scope(p_owner uuid,p_fence bigint,p_dispatch uuid default null) returns void language plpgsql security definer set search_path='' as $fn$
begin
 if p_dispatch is null then
  if not exists(select 1 from public.v17_analysis_lease where singleton and owner=p_owner and fence=p_fence
   and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '1 second') then
   raise exception 'V17_ANALYSIS_FENCED';end if;
 else
  -- Deadline is enforced at entry validation/send, not on post-fill safety work.
  if not exists(select 1 from public.leader20_execution_dispatches where signal_id=p_dispatch and claim_owner=p_owner
   and claim_attempts=p_fence and claim_postmaster_at=pg_postmaster_start_time()
   and state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING')) then raise exception 'V17_DISPATCH_ANALYSIS_FENCED';end if;
 end if;
end $fn$;
create function public.v17_heartbeat_analysis_lease(p_owner uuid,p_fence bigint) returns boolean language plpgsql security definer set search_path='' as $fn$
declare n integer;
begin
 update public.v17_analysis_lease set expires_at=clock_timestamp()+interval '150 seconds',heartbeat_at=clock_timestamp()
 where singleton and owner=p_owner and fence=p_fence and postmaster_started_at=pg_postmaster_start_time()
  and expires_at>clock_timestamp()+interval '1 second';get diagnostics n=row_count;return n=1;
end $fn$;
create function public.v17_release_analysis_lease(p_owner uuid,p_fence bigint) returns boolean language plpgsql security definer set search_path='' as $fn$
declare n integer;
begin update public.v17_analysis_lease set owner=null,expires_at='-infinity' where singleton and owner=p_owner and (p_fence is null or fence=p_fence);
 get diagnostics n=row_count;return n=1;end $fn$;
create or replace function public.v18_fence_executor_write() returns trigger language plpgsql set search_path='pg_catalog','public' as $fn$
declare h jsonb:=nullif(current_setting('request.headers',true),'')::jsonb;owner_text text;
begin
 owner_text:=h->>'x-v18-execution-owner';
 if owner_text is not null then perform public.v18_require_lease(owner_text::uuid);
 elsif h->>'x-v18-analysis-owner' is not null then
  perform public.v17_require_analysis_scope((h->>'x-v18-analysis-owner')::uuid,
   (h->>'x-v18-analysis-fence')::bigint,(h->>'x-v18-analysis-dispatch')::uuid);
 end if;return new;
end $fn$;
revoke all on function public.v17_acquire_analysis_lease(uuid),public.v17_require_analysis_scope(uuid,bigint,uuid),
 public.v17_heartbeat_analysis_lease(uuid,bigint),public.v17_release_analysis_lease(uuid,bigint) from public,anon,authenticated;
grant execute on function public.v17_acquire_analysis_lease(uuid),public.v17_require_analysis_scope(uuid,bigint,uuid),
 public.v17_heartbeat_analysis_lease(uuid,bigint),public.v17_release_analysis_lease(uuid,bigint) to service_role;

-- Separate mandatory submit RPC: legacy deployment signatures remain compatible.
create function public.leader20_execution_begin_submit(p_signal_id uuid,p_owner uuid,p_order_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare d public.leader20_execution_dispatches%rowtype;o public.v11_long_regime_orders%rowtype;
 h jsonb:=nullif(current_setting('request.headers',true),'')::jsonb;
 at_time timestamptz:=clock_timestamp();
begin
 perform public.v18_require_lease((h->>'x-v18-execution-owner')::uuid);
 select * into d from public.leader20_execution_dispatches where signal_id=p_signal_id for update;
 if d.signal_id is null or d.claim_owner is distinct from p_owner or
  d.state not in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') then return jsonb_build_object('updated',false,'reason','DISPATCH_OWNER_OR_STATE');end if;
 if d.claim_postmaster_at is distinct from pg_postmaster_start_time() then return jsonb_build_object('updated',false,'reason','DISPATCH_RESTART_FENCED');end if;
 if d.claim_lease_until<=at_time or d.valid_until<=at_time then return jsonb_build_object('updated',false,'reason','DISPATCH_DEADLINE_EXPIRED');end if;
 select * into o from public.v11_long_regime_orders where id=p_order_id and signal_id=p_signal_id and intent='OPEN_LONG' for update;
 if o.id is null or o.state<>'PLANNED' or o.exchange_order_id is not null then return jsonb_build_object('updated',false,'reason','ORDER_IDENTITY_NOT_PLANNED');end if;
 -- Only a confirmed terminal IOC may authorize its existing bounded retry. The
 -- new command's stable ID is unique in the existing orders table.
 if d.order_id is not null and d.order_id<>p_order_id and not exists(
  select 1 from public.v11_long_regime_orders first_order where first_order.id=d.order_id
   and first_order.signal_id=p_signal_id and o.request_payload->>'retry_of_order_id'=first_order.id::text
   and o.request_payload->>'entry_ioc_attempt'='2' and
    (first_order.response_payload#>>'{v22EntryFinality,finalStatus}') in ('EXPIRED','CANCELED','REJECTED')
   and first_order.state in ('EXPIRED','CANCELED','REJECTED','PARTIALLY_FILLED_CANCELED')) then
  return jsonb_build_object('updated',false,'reason','PRIOR_ORDER_RECONCILIATION_REQUIRED');end if;
 if o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,signal_id}' is distinct from p_signal_id::text or
  o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,authority_version}' is distinct from 'TOP20_CLOCK_GPT_FINAL_3' or
  (case when o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,completed_at_ms}' ~ '^[0-9]+$'
   then to_timestamp((o.request_payload#>>'{entry_gpt_decision,clockFinalAuthority,completed_at_ms}')::numeric/1000)
   else null end) is distinct from d.gpt_completed_at then return jsonb_build_object('updated',false,'reason','ORIGINAL_GPT_AUTHORITY_MISMATCH');end if;
 update public.leader20_execution_dispatches set state='ORDER_SUBMITTING',order_id=p_order_id,updated_at=at_time
 where signal_id=p_signal_id returning * into d;
 return jsonb_build_object('updated',true,'row',to_jsonb(d));
end $fn$;
revoke all on function public.leader20_execution_begin_submit(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.leader20_execution_begin_submit(uuid,uuid,uuid) to service_role;


alter table public.v17_execution_infrastructure_control add column if not exists recovered_postmaster_at timestamptz;
alter table public.v17_execution_infrastructure_control add column if not exists recovery_completed_at timestamptz;
create function public.v17_account_recovery_state() returns jsonb language sql security definer set search_path='' as $fn$
 select jsonb_build_object('ready',recovered_postmaster_at=pg_postmaster_start_time(),'postmaster_at',pg_postmaster_start_time(),
  'recovery_completed_at',recovery_completed_at) from public.v17_execution_infrastructure_control where singleton
$fn$;
create function public.v17_record_account_recovery(p_owner uuid,p_postmaster timestamptz,p_positions jsonb,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
 perform public.v18_require_lease(p_owner);
 if p_postmaster is distinct from pg_postmaster_start_time() or p_observed_at is null or
  p_observed_at>clock_timestamp()+interval '1 second' or p_observed_at<clock_timestamp()-interval '5 seconds' or
  jsonb_typeof(p_positions) is distinct from 'array' then return false;end if;
 if exists(select 1 from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED')) then return false;end if;
 if (select count(*) from public.v11_long_regime_positions where state='OPEN')<>jsonb_array_length(p_positions) or
  exists(select 1 from jsonb_array_elements(p_positions) e where not exists(
   select 1 from public.v11_long_regime_positions p where p.id::text=e->>'id' and p.state='OPEN'
    and p.updated_at=(e->>'updated_at')::timestamptz and p.remaining_quantity=(e->>'quantity')::numeric)) then return false;end if;
 update public.v17_execution_infrastructure_control set recovered_postmaster_at=p_postmaster,
  recovery_completed_at=clock_timestamp(),updated_at=clock_timestamp() where singleton;
 return true;
end $fn$;
revoke all on function public.v17_account_recovery_state(),public.v17_record_account_recovery(uuid,timestamptz,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.v17_account_recovery_state(),public.v17_record_account_recovery(uuid,timestamptz,jsonb,timestamptz) to service_role;

create function public.v17_acquire_gateway_writer(p_owner uuid) returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
 if not public.v17_acquire_execution_lease(p_owner) then return null;end if;
 return (select jsonb_build_object('owner',owner,'fence',fence) from public.v17_execution_lease where singleton and owner=p_owner);
end $fn$;
create function public.v17_gateway_authorize(p_key text,p_account text,p_owner uuid,p_fence bigint,p_command jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare o public.v11_long_regime_orders%rowtype;
begin
 if p_account is distinct from 'binance_futures:futures' or p_key is null or length(p_key)<16 or
  p_command->>'exchange' is distinct from 'binance_futures' then return false;end if;
 if not exists(select 1 from public.v17_execution_lease where singleton and owner=p_owner and fence=p_fence
  and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '30 seconds') then return false;end if;
 if p_command->>'action'='create_order' and upper(p_command#>>'{order,side}')='BUY' then
  select * into o from public.v11_long_regime_orders where client_order_id=p_command#>>'{order,identifier}'
   and intent='OPEN_LONG' and state='PLANNED';
  if o.id is null or o.symbol is distinct from p_command#>>'{order,market}' or
   o.requested_quantity is distinct from (p_command#>>'{order,quantity}')::numeric or
   o.request_payload->'order' is distinct from p_command->'order' or
   o.request_payload->'leverage' is distinct from p_command->'leverage' then return false;end if;
  return exists(select 1 from public.leader20_execution_dispatches d where d.signal_id=o.signal_id and d.order_id=o.id
   and d.state='ORDER_SUBMITTING' and d.claim_postmaster_at=pg_postmaster_start_time()
   and d.valid_until>clock_timestamp() and d.claim_lease_until>clock_timestamp());
 end if;
 -- Read-only API plus reduce-only management retains the gateway's existing owned
 -- position, quantity, account-mode, stop and protection validation.
 if p_command->>'action'='create_order' then return upper(p_command#>>'{order,side}')='SELL'
  and upper(p_command#>>'{order,position_effect}')='CLOSE';end if;
 return p_command->>'action' in ('cancel_order','v17_create_stop','v17_cancel_stop');
end $fn$;
revoke all on function public.v17_acquire_gateway_writer(uuid),public.v17_gateway_authorize(text,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.v17_acquire_gateway_writer(uuid),public.v17_gateway_authorize(text,text,uuid,bigint,jsonb) to service_role;

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

  if (select short_writer_enabled from public.v17_execution_infrastructure_control where singleton) then
    perform public.v18_require_lease((nullif(current_setting('request.headers',true),'')::jsonb->>'x-v18-execution-owner')::uuid);
  end if;

  loop
    d:=null;
    if p_signal_id is not null then
      select * into d from public.leader20_execution_dispatches
      where signal_id=p_signal_id for update;
    else
      select * into d from public.leader20_execution_dispatches
      where state='READY_TO_EXECUTE'
         or (state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and (claim_lease_until<=at_time or claim_postmaster_at is distinct from pg_postmaster_start_time()))
      order by dispatch_requested_at
      for update skip locked limit 1;
    end if;

    if d.signal_id is null then
      return jsonb_build_object('claimed',false,'reason','NO_READY_EXECUTION');
    end if;
    if d.state not in ('READY_TO_EXECUTE','EXECUTION_CLAIMED','ORDER_SUBMITTING') then
      return jsonb_build_object('claimed',false,'reason','EXECUTION_TERMINAL','row',to_jsonb(d));
    end if;
    if d.state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and d.claim_lease_until>at_time and d.claim_postmaster_at=pg_postmaster_start_time() then
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

commit;
