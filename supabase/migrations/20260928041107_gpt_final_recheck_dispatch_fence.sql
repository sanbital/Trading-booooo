-- Parent kind FD1_FINAL_RECHECK has no expires_at_ms; its own runtime recheck
-- deadline remains mandatory. Preserve RUNNING ownership fencing and ENTRY expiry.
create or replace function public.ai_call_transition(p_key text,p_owner uuid,p_state text,
 p_usage jsonb default null,p_request_id text default null,
 p_latency_ms bigint default null,p_error text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.ai_call_ledger%rowtype; cost numeric; i bigint; o bigint; c bigint;
 parent_state text; parent_kind text; deadline_ms numeric;
begin
 if p_state in ('DISPATCHED','SETTLED','CANCELLED') then
  perform pg_advisory_xact_lock(20260928,51); end if;
 select * into j from public.ai_call_ledger where call_key=p_key for update;
 if not found or j.owner<>p_owner then raise exception 'API_CALL_OWNER'; end if;
 if j.state=p_state and p_state in ('SETTLED','CANCELLED','UNKNOWN') then
  return jsonb_build_object('state',j.state,'duplicate',true); end if;
 if p_state='DISPATCHED' and j.state='RESERVED' then
  select state,record->>'kind',case when jsonb_typeof(record->'expires_at_ms')='number'
    then (record->>'expires_at_ms')::numeric end into parent_state,parent_kind,deadline_ms
  from public.gpt_final_entry_reviews where job_key=j.parent_key;
  if found and (parent_state<>'RUNNING' or
    (deadline_ms is null and parent_kind is distinct from 'FD1_FINAL_RECHECK') or
    (deadline_ms is not null and deadline_ms<=extract(epoch from clock_timestamp())*1000)) then
   raise exception 'API_PARENT_EXPIRED_OR_TERMINAL';
  end if;
  update public.ai_call_ledger set state=p_state where call_key=p_key;
 elsif p_state='CANCELLED' and j.state='RESERVED' then
  update public.ai_call_ledger set state=p_state,actual_usd=0,settled_at=clock_timestamp() where call_key=p_key;
 elsif p_state='UNKNOWN' and j.state='DISPATCHED' then
  update public.ai_call_ledger set state=p_state,error=p_error where call_key=p_key;
 elsif p_state='SETTLED' and j.state in ('DISPATCHED','UNKNOWN') then
  i:=(p_usage->>'input_tokens')::bigint;o:=(p_usage->>'output_tokens')::bigint;
  c:=coalesce((p_usage->>'cached_input_tokens')::bigint,0);
  if i is null or o is null or i<0 or o<0 or c<0 or c>i then raise exception 'API_USAGE_INVALID'; end if;
  cost:=case when j.provider='deepseek' then ((i-c)*.3+c*.006+o*1.2)/1000000
   else ((i-c)*.75+c*.075+o*4.5)/1000000 end;
  update public.ai_call_ledger set state=p_state,actual_usd=cost,input_tokens=i,output_tokens=o,cached_input_tokens=c,
   request_id=p_request_id,cost_basis='TOKEN_RATE_PEAK_NOT_INVOICE',latency_ms=p_latency_ms,
   settled_at=clock_timestamp(),error=case when cost>reserved_usd then 'RESERVATION_EXCEEDED' else p_error end
   where call_key=p_key;
 else raise exception 'API_CALL_TRANSITION';
 end if;
 return jsonb_build_object('state',p_state,'cost_usd',cost);
end $$;

