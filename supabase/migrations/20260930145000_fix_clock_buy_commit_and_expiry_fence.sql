-- Fix BUY commit telemetry compatibility and fence stale durable recovery.
create or replace function public.leader20_clock_execution_journal()
returns trigger language plpgsql set search_path='' as $$
declare j jsonb:=to_jsonb(new);w jsonb;d jsonb;sid uuid;completed timestamptz;
begin
 if tg_table_name='gpt_final_entry_reviews' then
  w:=j#>'{record,packet,leader20,entry_window}';
  if j->>'purpose'='PRODUCTION' and j->>'valid'='true' and j->>'decision'='BUY'
   and j#>>'{record,result,review_route}'='TOP20_CLOCK_GPT_FINAL_3' and w->>'version'='TOP20_CLOCK_CAPTURE_1' then
   completed:=to_timestamp((j#>>'{record,result,completed_at_ms}')::numeric/1000);
   insert into public.leader20_clock_executions(signal_id,slot_at,decision_deadline,gpt_buy_completed_at,gpt_completed_at)
    values((j#>>'{record,identity,signal_id}')::uuid,to_timestamp((w->>'slot_ms')::numeric/1000),
     to_timestamp((w->>'expires_at_ms')::numeric/1000),completed,completed)
    on conflict(signal_id) do update set
      gpt_buy_completed_at=coalesce(public.leader20_clock_executions.gpt_buy_completed_at,excluded.gpt_buy_completed_at),
      gpt_completed_at=coalesce(public.leader20_clock_executions.gpt_completed_at,excluded.gpt_completed_at),
      updated_at=clock_timestamp();
  end if; return new;
 elsif tg_table_name='v11_long_regime_decisions' then
  if coalesce(j#>>'{details,stage}','') not in ('CLOCK_EXECUTION_SAFETY','ENTRY_ATTEMPT_OUTCOME','PRE_ORDER_REJECTION')
   or coalesce(j#>>'{details,signalId}','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new;end if;
  sid:=(j#>>'{details,signalId}')::uuid;
  d:=coalesce(nullif(j#>'{details,clockExecutionTelemetry}','null'::jsonb),'{}'::jsonb);
  if j->>'action' in ('ENTRY_DEFER','ENTRY_REJECT') then d:=d||jsonb_build_object('execution_failure_reason',j->>'reason');end if;
 else
  if j->>'intent' is distinct from 'OPEN_LONG' then return new;end if;
  sid:=(j->>'signal_id')::uuid;
  d:=coalesce(nullif(j#>'{response_payload,v22EntryFinality,clockExecutionTelemetry}','null'::jsonb),
   nullif(j#>'{request_payload,entry_clock_execution}','null'::jsonb),'{}'::jsonb);
  d:=d||jsonb_build_object('order_intent_at',extract(epoch from (j->>'created_at')::timestamptz)*1000);
  if j#>>'{response_payload,v22EntryFinality,sentAt}' is not null then d:=d||jsonb_build_object('order_sent_at',(j#>>'{response_payload,v22EntryFinality,sentAt}')::bigint);end if;
  if j->>'state'='REJECTED' then d:=d||jsonb_build_object('execution_failure_reason',j->>'reject_reason');end if;
 end if;
 if sid is not null then perform public.leader20_clock_execution_note(sid,d);end if; return new;
end $$;

create or replace function public.gpt_final_review_promote_stored(p_job_key text)
returns jsonb language plpgsql set search_path to '' set lock_timeout to '500ms' set statement_timeout to '2500ms' as $$
declare j public.gpt_final_entry_reviews%rowtype;r jsonb;u jsonb;v_attempted boolean;v_cost numeric;v_settled numeric;valid_until_ms numeric;
begin
 select * into j from public.gpt_final_entry_reviews where job_key=p_job_key for update;
 if j.job_key is null then return jsonb_build_object('done',false,'reason','NOT_FOUND');end if;
 if j.state='DONE' then return jsonb_build_object('done',true,'duplicate',true);end if;
 if j.state<>'RUNNING' then return jsonb_build_object('done',false,'reason','NOT_RUNNING');end if;
 r:=j.record->'result';u:=j.record#>'{result,usage}';
 if jsonb_typeof(r)<>'object' or r->>'origin'<>'OPENAI_API' or coalesce(r->>'decision','') not in ('BUY','WAIT','SKIP','ABSTAIN')
  or jsonb_typeof(r->'raw_response')<>'object' or nullif(r->>'request_id','') is null or jsonb_typeof(r->'completed_at_ms')<>'number'
  then return jsonb_build_object('done',false,'reason','NO_DURABLE_PROVIDER_RESULT');end if;
 valid_until_ms:=case when jsonb_typeof(j.record->'valid_until_ms')='number' then (j.record->>'valid_until_ms')::numeric end;
 if r->>'decision'='BUY' and (valid_until_ms is null or valid_until_ms<=extract(epoch from clock_timestamp())*1000)
  then return jsonb_build_object('done',false,'reason','EXPIRED_BUY_NOT_PROMOTED');end if;
 v_attempted:=coalesce((r->>'attempted')::boolean,true);
 v_cost:=case when jsonb_typeof(r->'api_cost_usd')='number' then (r->>'api_cost_usd')::numeric end;
 v_settled:=case when not v_attempted then 0 when v_cost is not null and v_cost>=0 and v_cost::text not in ('NaN','Infinity','-Infinity') then v_cost end;
 update public.gpt_final_entry_reviews set state='DONE',completed_at=clock_timestamp(),settled_usd=v_settled,
  model=j.record#>>'{result,model_requested}',prompt_hash=j.record->>'prompt_hash',schema_hash=j.record->>'schema_hash',
  source_commit=j.record->>'source_commit',candidate_id=j.record#>>'{packet,candidate_id}',snapshot_hash=j.record#>>'{packet,snapshot_hash}',
  decision=r->>'decision',valid=coalesce((r->>'valid')::boolean,false),error=left(r->>'error',200),attempted=v_attempted,
  request_id=left(r->>'request_id',200),
  input_tokens=case when jsonb_typeof(u->'input_tokens')='number' then (u->>'input_tokens')::integer end,
  cached_input_tokens=case when jsonb_typeof(u#>'{input_tokens_details,cached_tokens}')='number' then (u#>>'{input_tokens_details,cached_tokens}')::integer end,
  output_tokens=case when jsonb_typeof(u->'output_tokens')='number' then (u->>'output_tokens')::integer end,
  api_cost_usd=v_cost,cost_basis=left(r->>'cost_basis',80),
  latency_ms=case when jsonb_typeof(r->'latency_ms')='number' then (r->>'latency_ms')::integer end,
  api_started_at=case when jsonb_typeof(r->'started_at_ms')='number' then to_timestamp((r->>'started_at_ms')::double precision/1000) end,
  api_completed_at=case when jsonb_typeof(r->'completed_at_ms')='number' then to_timestamp((r->>'completed_at_ms')::double precision/1000) end,
  snapshot_at=case when jsonb_typeof(j.record->'snapshot_at_ms')='number' then to_timestamp((j.record->>'snapshot_at_ms')::double precision/1000) end
 where job_key=p_job_key and state='RUNNING';
 if not found then return jsonb_build_object('done',false,'reason','CAS_LOST');end if;
 if v_settled is not null and j.budget_day is not null and j.reserved_usd is not null then
  update public.gpt_final_review_daily_budget set reserved_usd=greatest(0,reserved_usd-(j.reserved_usd-v_settled)),settled_usd=settled_usd+v_settled where utc_day=j.budget_day;
 end if;
 return jsonb_build_object('done',true,'recovered',true,'decision',r->>'decision');
end $$;

create or replace function public.gpt_final_review_recover_ready(p_limit integer default 30)
returns jsonb language plpgsql set search_path to '' as $$
declare j record;out jsonb;recovered integer:=0;skipped integer:=0;
begin
 if p_limit<1 or p_limit>100 then raise exception 'REVIEW_RECOVERY_LIMIT';end if;
 for j in select job_key from public.gpt_final_entry_reviews where state='RUNNING' and provider_ledger=true
  and record#>>'{result,origin}'='OPENAI_API' and jsonb_typeof(record#>'{result,raw_response}')='object'
  and nullif(record#>>'{result,request_id}','') is not null
  and (record#>>'{result,decision}'<>'BUY' or (jsonb_typeof(record->'valid_until_ms')='number'
   and (record->>'valid_until_ms')::numeric>extract(epoch from clock_timestamp())*1000))
  order by created_at limit p_limit for update skip locked
 loop
  out:=public.gpt_final_review_promote_stored(j.job_key);
  if coalesce((out->>'recovered')::boolean,false) then recovered:=recovered+1;else skipped:=skipped+1;end if;
 end loop;
 return jsonb_build_object('recovered',recovered,'skipped',skipped);
end $$;

create or replace function public.gpt_final_review_expire(p_limit integer default 30)
returns jsonb language plpgsql set search_path to '' as $$
declare j public.gpt_final_entry_reviews%rowtype;dispatched boolean;promoted jsonb;cancelled integer:=0;just_cancelled integer:=0;
 terminal_cancelled integer:=0;unresolved integer:=0;expired integer:=0;recovered integer:=0;provider_result jsonb;
begin
 if p_limit<1 or p_limit>100 then raise exception 'REVIEW_REAPER_LIMIT';end if;
 perform pg_advisory_xact_lock(20260928,51);
 with terminal as (select l.call_key from public.ai_call_ledger l join public.gpt_final_entry_reviews r on r.job_key=l.parent_key
  where l.state='RESERVED' and l.created_at<clock_timestamp()-interval '90 seconds' and r.state='DONE' and r.provider_ledger=true
  order by l.created_at limit p_limit for update of l skip locked)
 update public.ai_call_ledger l set state='CANCELLED',actual_usd=0,settled_at=clock_timestamp(),error='PARENT_DONE_BEFORE_DISPATCH'
 from terminal t where l.call_key=t.call_key and l.state='RESERVED';
 get diagnostics terminal_cancelled=row_count;
 for j in select * from public.gpt_final_entry_reviews where state='RUNNING' and provider_ledger=true
  and created_at<clock_timestamp()-interval '90 seconds' and jsonb_typeof(record->'expires_at_ms')='number'
  and (record->>'expires_at_ms')::numeric<extract(epoch from clock_timestamp()-interval '30 seconds')*1000
  order by created_at limit p_limit for update skip locked loop
  promoted:=public.gpt_final_review_promote_stored(j.job_key);
  if coalesce((promoted->>'done')::boolean,false) and coalesce((promoted->>'recovered')::boolean,false) then recovered:=recovered+1;continue;end if;
  select exists(select 1 from public.ai_call_ledger where parent_key=j.job_key and state in ('DISPATCHED','UNKNOWN','SETTLED')) into dispatched;
  if not dispatched then update public.ai_call_ledger set state='CANCELLED',actual_usd=0,settled_at=clock_timestamp(),error='PARENT_EXPIRED_BEFORE_DISPATCH'
    where parent_key=j.job_key and state='RESERVED';get diagnostics just_cancelled=row_count;cancelled:=cancelled+just_cancelled;
  else unresolved:=unresolved+1;end if;
  provider_result:=case when j.record#>>'{result,origin}'='OPENAI_API' then j.record->'result' else null end;
  update public.gpt_final_entry_reviews set state='DONE',completed_at=clock_timestamp(),decision='ABSTAIN',valid=false,attempted=dispatched,
   error=case when provider_result is not null then 'REVIEW_EXPIRED_BEFORE_DURABLE_PROMOTION'
    when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN' else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
   record=jsonb_set(case when provider_result is not null then jsonb_set(j.record,'{provider_result}',provider_result,true) else j.record end,
    '{result}',jsonb_build_object('origin','LOCAL_WORKER_RECOVERY','valid',false,'decision','ABSTAIN','error',
     case when provider_result is not null then 'REVIEW_EXPIRED_BEFORE_DURABLE_PROMOTION'
      when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN' else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
     'attempted',dispatched,'completed_at_ms',floor(extract(epoch from clock_timestamp())*1000)::bigint),true)
   where job_key=j.job_key and owner=j.owner and state='RUNNING';
  expired:=expired+1;
 end loop;
 return jsonb_build_object('expired',expired,'recovered',recovered,'unresolved',unresolved,'cancelled',cancelled,'terminal_cancelled',terminal_cancelled);
end $$;