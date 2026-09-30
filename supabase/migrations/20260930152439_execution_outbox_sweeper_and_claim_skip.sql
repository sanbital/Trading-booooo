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

CREATE OR REPLACE FUNCTION public.leader20_execution_claim(p_signal_id uuid, p_owner uuid, p_min_remaining_ms bigint DEFAULT 24000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d public.leader20_execution_dispatches%rowtype;
  at_time timestamptz:=clock_timestamp();
  remaining_ms numeric;
begin
  if p_owner is null or p_min_remaining_ms<1000 or p_min_remaining_ms>60000 then
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
revoke all on function public.leader20_enqueue_execution() from public,anon,authenticated;
grant execute on function public.leader20_enqueue_execution() to service_role;

do $$
declare j bigint;
begin
  select jobid into j from cron.job where jobname='leader20-execution-outbox-sweeper';
  if j is not null then perform cron.unschedule(j); end if;
  perform cron.schedule(
    'leader20-execution-outbox-sweeper',
    '5 seconds',
    $cron$
      select net.http_post(
        url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',
        headers:=jsonb_build_object(
          'content-type','application/json',
          'x-v10-executor-token',(select token from public.edge_internal_tokens where name='v10-lane-executor')
        ),
        body:='{"mode":"execute-ready-any"}'::jsonb,
        timeout_milliseconds:=100000
      )
      where exists(
        select 1 from public.leader20_execution_dispatches
        where state='READY_TO_EXECUTE'
          and valid_until>clock_timestamp()+interval '24 seconds'
      );
    $cron$
  );
end $$;