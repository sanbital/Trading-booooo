begin;set local lock_timeout='2s';set local statement_timeout='10s';
create or replace function public.v17_gateway_authorize(p_key text,p_account text,p_owner uuid,p_fence bigint,p_command jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare o public.v11_long_regime_orders%rowtype;
begin
 if p_account is distinct from 'binance_futures:futures' or p_key is null or length(p_key)<16 or
  p_command->>'exchange' is distinct from 'binance_futures' then return false;end if;
 if not exists(select 1 from public.v17_execution_lease where singleton and owner=p_owner and fence=p_fence
  and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '30 seconds') then return false;end if;
 if p_command->>'action'='create_order' and upper(p_command#>>'{order,side}')='BUY' and upper(coalesce(p_command#>>'{order,position_effect}','OPEN'))<>'CLOSE' then
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
 if p_command->>'action'='create_order' then return upper(p_command#>>'{order,side}') in ('BUY','SELL')
  and upper(p_command#>>'{order,position_effect}')='CLOSE';end if;
 return p_command->>'action' in ('cancel_order','v17_create_stop','v17_cancel_stop');
end $fn$;

CREATE OR REPLACE FUNCTION public.leader20_enqueue_execution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  w jsonb; sid uuid; completed timestamptz; deadline timestamptz;
  inserted integer; token text; wake boolean:=false;
begin
  if new.purpose<>'PRODUCTION' or new.state<>'DONE' or new.valid is distinct from true or new.decision<>'BUY'
    or new.record#>>'{result,review_route}'<>'TOP20_CLOCK_GPT_FINAL_3'
    or new.record#>>'{packet,leader20,entry_window,version}'<>'TOP20_CLOCK_CAPTURE_1'
    or (tg_op='UPDATE' and old.state='DONE' and old.valid is true and old.decision='BUY')
  then return new; end if;

  w:=new.record#>'{packet,leader20,entry_window}';
  sid:=(new.record#>>'{identity,signal_id}')::uuid;
  completed:=to_timestamp((new.record#>>'{result,completed_at_ms}')::numeric/1000);
  deadline:=to_timestamp((w->>'expires_at_ms')::numeric/1000);

  insert into public.leader20_clock_executions(
    signal_id,slot_at,decision_deadline,gpt_buy_completed_at,gpt_completed_at)
  values(sid,to_timestamp((w->>'slot_ms')::numeric/1000),deadline,completed,completed)
  on conflict(signal_id) do update set
    gpt_completed_at=excluded.gpt_completed_at,
    gpt_buy_completed_at=excluded.gpt_buy_completed_at,
    updated_at=clock_timestamp();

  insert into public.leader20_execution_dispatches(signal_id,symbol,state,gpt_completed_at,valid_until)
  values(sid,new.symbol,'READY_TO_EXECUTE',completed,deadline)
  on conflict(signal_id) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return new; end if;

  update public.leader20_clock_executions
  set execution_dispatch_at=clock_timestamp(),updated_at=clock_timestamp()
  where signal_id=sid;

  -- Logged dispatch has committed authority. External clock reads it directly;
  -- never depend on unlogged pg_net or call the database's public URL here.
  if exists(select 1 from public.trading_scheduler_control
    where scheduler_key='trading-production' and enabled) then return new;end if;

  -- Coalesce simultaneous BUY wakeups. The durable outbox is the authority; one
  -- immediate HTTP wake is enough and the 5-second sweeper below is the fallback.
  perform pg_advisory_xact_lock(20261001,20);
  select not exists(
    select 1 from public.leader20_execution_dispatches d
    where d.signal_id<>sid and d.state in ('READY_TO_EXECUTE','EXECUTION_CLAIMED','ORDER_SUBMITTING')
      and d.valid_until>clock_timestamp()
      and d.dispatch_requested_at<(
        select x.dispatch_requested_at from public.leader20_execution_dispatches x where x.signal_id=sid
      )
  ) into wake;
  if not wake then return new; end if;
  -- The account-wide lease is the execution ownership truth. If another worker is
  -- active, that owner (including an ordinary cycle) must inspect this durable row
  -- before management; the sweeper retries only after the lease is released.
  if not public.leader20_claim_execution_wake('IMMEDIATE') then return new; end if;

  select t.token into token from public.edge_internal_tokens t where t.name='v10-lane-executor';
  if token is null then
    update public.leader20_execution_dispatches
    set last_error='IMMEDIATE_DISPATCH_TOKEN_MISSING' where signal_id=sid;
    return new;
  end if;
  begin
    perform net.http_post(
      url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',
      headers:=jsonb_build_object('content-type','application/json','x-v10-executor-token',token),
      body:=jsonb_build_object('mode','execute-ready-any'),
      timeout_milliseconds:=100000
    );
  exception when others then
    update public.leader20_execution_dispatches
    set last_error=left('IMMEDIATE_DISPATCH_ENQUEUE:'||sqlerrm,500)
    where signal_id=sid;
  end;
  return new;
end $function$
;

-- State and terminal cause are distinct. All future terminal writes have one cause.
create function public.leader20_dispatch_terminal_cause(p_state text,p_error text,p_claimed boolean)
returns text language sql immutable set search_path='' as $$
 select case
 when p_state in ('FILLED','PARTIALLY_FILLED_CANCELED') then p_state
 when coalesce(p_error,'') ~* 'PRE_EXECUTION_GPT_CANCEL_OR_ERROR:CANCEL_BUY' then 'GPT_RECHECK_CANCELED'
 when coalesce(p_error,'') ~* 'PRE_EXECUTION_INVALID|PRE_EXECUTION_UNCERTAIN_DATA_UNSAFE|STALE|FRESHNESS|CAPTURE|SNAPSHOT' then 'LATEST_DATA_VALIDATION_FAILED'
 when coalesce(p_error,'') ~* 'CIRCUIT' then 'CIRCUIT_OPEN'
 when coalesce(p_error,'') ~* 'CAPACITY|SLOT_FULL|MARGIN_INSUFFICIENT|INSUFFICIENT_MARGIN' then 'CAPACITY_REJECTED'
 when coalesce(p_error,'') ~* 'DB.*TIMEOUT|DATABASE|CONNECTION|HTTP_50[234]|signal has been aborted' then 'DEPENDENCY_TIMEOUT_OR_5XX'
 when coalesce(p_error,'') ~* 'RATE.?LIMIT|HTTP_429' then 'RATE_LIMIT'
 when coalesce(p_error,'') ~* 'LEASE|FENCED' then 'LEASE_FAILURE'
 when p_state in ('CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION','EXECUTION_WINDOW_INSUFFICIENT') and not p_claimed then 'UNCLAIMED_DEADLINE_EXPIRED'
 when p_state='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION' then 'AUTHORITY_EXPIRED'
 when p_state='EXECUTION_WINDOW_INSUFFICIENT' then 'VALIDATION_WINDOW_EXHAUSTED'
 when p_state in ('EXPIRED','REJECTED') and nullif(p_error,'') is null then 'EXCHANGE_'||p_state
 when p_state='REJECTED' then 'OTHER_VALIDATION_REJECTED'
 else p_state end
$$;
create function public.leader20_dispatch_record_terminal_cause() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if new.terminal_at is not null and (old.terminal_at is null or new.state is distinct from old.state) then
  new.terminal_reason:=public.leader20_dispatch_terminal_cause(new.state,new.last_error,new.executor_claimed_at is not null);
 end if;return new;end $$;
create trigger leader20_precise_terminal_cause before update on public.leader20_execution_dispatches
for each row execute function public.leader20_dispatch_record_terminal_cause();

-- No exchange/authority replay: close only expired, unsubmitted READY rows.
create function public.leader20_execution_expire(p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path='' as $$declare n integer;begin
 if p_limit<1 or p_limit>100 then raise exception 'DISPATCH_EXPIRY_BOUND';end if;
 with due as (select d.signal_id from public.leader20_execution_dispatches d
  where d.state='READY_TO_EXECUTE' and d.valid_until<=clock_timestamp() and d.order_id is null
   and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=d.signal_id and o.intent='OPEN_LONG')
  order by d.valid_until limit p_limit for update of d skip locked)
 update public.leader20_execution_dispatches d set state='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',
  terminal_at=clock_timestamp(),claim_owner=null,claim_lease_until=null,updated_at=clock_timestamp()
 from due where d.signal_id=due.signal_id;
 get diagnostics n=row_count;return jsonb_build_object('expired',n);end $$;
revoke all on function public.leader20_execution_expire(integer),public.leader20_dispatch_record_terminal_cause(),public.leader20_dispatch_terminal_cause(text,text,boolean) from public,anon,authenticated;
grant execute on function public.leader20_execution_expire(integer),public.leader20_dispatch_record_terminal_cause(),public.leader20_dispatch_terminal_cause(text,text,boolean) to service_role;
-- Activate only after the Fly runner image knows this idempotent maintenance RPC.
insert into public.trading_scheduler_jobs(scheduler_key,job_key,enabled,period_ms,timeout_ms,recovery_mode,job_kind,requires_recovery,target)
values('trading-production','outbox-deadline-expiry',false,5000,2500,'DURABLE_CURSOR','MAINTENANCE',false,'{"rpc":"leader20_execution_expire","limit":30}');

commit;
