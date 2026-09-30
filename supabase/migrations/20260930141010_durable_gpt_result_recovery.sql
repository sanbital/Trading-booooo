-- Durable GPT result recovery. Strategy and decision contracts are unchanged.
create or replace function public.gpt_final_review_promote_stored(p_job_key text)
returns jsonb
language plpgsql
set search_path to ''
set lock_timeout to '500ms'
set statement_timeout to '2500ms'
as $$
declare
 j public.gpt_final_entry_reviews%rowtype;
 r jsonb; u jsonb; v_attempted boolean; v_cost numeric; v_settled numeric;
begin
 select * into j from public.gpt_final_entry_reviews where job_key=p_job_key for update;
 if j.job_key is null then return jsonb_build_object('done',false,'reason','NOT_FOUND'); end if;
 if j.state='DONE' then return jsonb_build_object('done',true,'duplicate',true); end if;
 if j.state<>'RUNNING' then return jsonb_build_object('done',false,'reason','NOT_RUNNING'); end if;
 r:=j.record->'result'; u:=j.record#>'{result,usage}';
 if jsonb_typeof(r)<>'object' or r->>'origin'<>'OPENAI_API'
   or coalesce(r->>'decision','') not in ('BUY','WAIT','SKIP','ABSTAIN')
   or jsonb_typeof(r->'raw_response')<>'object' or nullif(r->>'request_id','') is null
   or jsonb_typeof(r->'completed_at_ms')<>'number'
 then return jsonb_build_object('done',false,'reason','NO_DURABLE_PROVIDER_RESULT'); end if;
 v_attempted:=coalesce((r->>'attempted')::boolean,true);
 v_cost:=case when jsonb_typeof(r->'api_cost_usd')='number' then (r->>'api_cost_usd')::numeric end;
 v_settled:=case when not v_attempted then 0 when v_cost is not null and v_cost>=0 and v_cost::text not in ('NaN','Infinity','-Infinity') then v_cost end;
 update public.gpt_final_entry_reviews set state='DONE',completed_at=clock_timestamp(),
  settled_usd=v_settled,model=j.record#>>'{result,model_requested}',prompt_hash=j.record->>'prompt_hash',
  schema_hash=j.record->>'schema_hash',source_commit=j.record->>'source_commit',
  candidate_id=j.record#>>'{packet,candidate_id}',snapshot_hash=j.record#>>'{packet,snapshot_hash}',
  decision=r->>'decision',valid=coalesce((r->>'valid')::boolean,false),error=left(r->>'error',200),
  attempted=v_attempted,request_id=left(r->>'request_id',200),
  input_tokens=case when jsonb_typeof(u->'input_tokens')='number' then (u->>'input_tokens')::integer end,
  cached_input_tokens=case when jsonb_typeof(u#>'{input_tokens_details,cached_tokens}')='number' then (u#>>'{input_tokens_details,cached_tokens}')::integer end,
  output_tokens=case when jsonb_typeof(u->'output_tokens')='number' then (u->>'output_tokens')::integer end,
  api_cost_usd=v_cost,cost_basis=left(r->>'cost_basis',80),
  latency_ms=case when jsonb_typeof(r->'latency_ms')='number' then (r->>'latency_ms')::integer end,
  api_started_at=case when jsonb_typeof(r->'started_at_ms')='number' then to_timestamp((r->>'started_at_ms')::double precision/1000) end,
  api_completed_at=case when jsonb_typeof(r->'completed_at_ms')='number' then to_timestamp((r->>'completed_at_ms')::double precision/1000) end,
  snapshot_at=case when jsonb_typeof(j.record->'snapshot_at_ms')='number' then to_timestamp((j.record->>'snapshot_at_ms')::double precision/1000) end
 where job_key=p_job_key and state='RUNNING';
 if not found then return jsonb_build_object('done',false,'reason','CAS_LOST'); end if;
 if v_settled is not null and j.budget_day is not null and j.reserved_usd is not null then
  update public.gpt_final_review_daily_budget
   set reserved_usd=greatest(0,reserved_usd-(j.reserved_usd-v_settled)),settled_usd=settled_usd+v_settled
   where utc_day=j.budget_day;
 end if;
 return jsonb_build_object('done',true,'recovered',true,'decision',r->>'decision');
end $$;
revoke all on function public.gpt_final_review_promote_stored(text) from public, anon, authenticated;
grant execute on function public.gpt_final_review_promote_stored(text) to service_role;

create or replace function public.gpt_final_review_expire(p_limit integer default 30)
returns jsonb language plpgsql set search_path to '' as $$
declare j public.gpt_final_entry_reviews%rowtype; dispatched boolean; promoted jsonb;
 cancelled integer:=0; just_cancelled integer:=0; terminal_cancelled integer:=0;
 unresolved integer:=0; expired integer:=0; recovered integer:=0;
begin
 if p_limit<1 or p_limit>100 then raise exception 'REVIEW_REAPER_LIMIT'; end if;
 perform pg_advisory_xact_lock(20260928,51);
 with terminal as (
  select l.call_key from public.ai_call_ledger l join public.gpt_final_entry_reviews r on r.job_key=l.parent_key
  where l.state='RESERVED' and l.created_at<clock_timestamp()-interval '90 seconds'
   and r.state='DONE' and r.provider_ledger=true order by l.created_at limit p_limit for update of l skip locked
 )
 update public.ai_call_ledger l set state='CANCELLED',actual_usd=0,settled_at=clock_timestamp(),error='PARENT_DONE_BEFORE_DISPATCH'
 from terminal t where l.call_key=t.call_key and l.state='RESERVED';
 get diagnostics terminal_cancelled=row_count;
 for j in select * from public.gpt_final_entry_reviews
  where state='RUNNING' and provider_ledger=true and created_at<clock_timestamp()-interval '90 seconds'
   and jsonb_typeof(record->'expires_at_ms')='number'
   and (record->>'expires_at_ms')::numeric<extract(epoch from clock_timestamp()-interval '30 seconds')*1000
  order by created_at limit p_limit for update skip locked loop
  promoted:=public.gpt_final_review_promote_stored(j.job_key);
  if coalesce((promoted->>'done')::boolean,false) and coalesce((promoted->>'recovered')::boolean,false) then
   recovered:=recovered+1; continue;
  end if;
  select exists(select 1 from public.ai_call_ledger where parent_key=j.job_key and state in ('DISPATCHED','UNKNOWN','SETTLED')) into dispatched;
  if not dispatched then
   update public.ai_call_ledger set state='CANCELLED',actual_usd=0,settled_at=clock_timestamp(),error='PARENT_EXPIRED_BEFORE_DISPATCH'
    where parent_key=j.job_key and state='RESERVED';
   get diagnostics just_cancelled=row_count; cancelled:=cancelled+just_cancelled;
  else unresolved:=unresolved+1; end if;
  update public.gpt_final_entry_reviews set state='DONE',completed_at=clock_timestamp(),decision='ABSTAIN',valid=false,attempted=dispatched,
   error=case when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN' else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
   record=jsonb_set(j.record,'{result}',jsonb_build_object('origin','LOCAL_WORKER_RECOVERY','valid',false,'decision','ABSTAIN','error',
    case when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN' else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
    'attempted',dispatched,'completed_at_ms',floor(extract(epoch from clock_timestamp())*1000)::bigint))
   where job_key=j.job_key and owner=j.owner and state='RUNNING';
  expired:=expired+1;
 end loop;
 return jsonb_build_object('expired',expired,'recovered',recovered,'unresolved',unresolved,'cancelled',cancelled,'terminal_cancelled',terminal_cancelled);
end $$;