
-- RESERVED is durable proof that the paid transport did not send a request:
-- DISPATCHED is committed before fetch. The shared dispatch lock prevents a
-- concurrent RESERVED -> DISPATCHED transition while terminal rows are freed.
create or replace function public.gpt_final_review_expire(p_limit integer default 30)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.gpt_final_entry_reviews%rowtype; dispatched boolean;
 cancelled integer:=0; just_cancelled integer:=0; terminal_cancelled integer:=0;
 unresolved integer:=0; expired integer:=0;
begin
 if p_limit<1 or p_limit>100 then raise exception 'REVIEW_REAPER_LIMIT'; end if;
 perform pg_advisory_xact_lock(20260928,51);
 -- A DONE parent cannot dispatch another provider call. Release only aged,
 -- pre-dispatch reservations; never touch DISPATCHED, UNKNOWN or SETTLED.
 with terminal as (
  select l.call_key from public.ai_call_ledger l
  join public.gpt_final_entry_reviews r on r.job_key=l.parent_key
  where l.state='RESERVED' and l.created_at<clock_timestamp()-interval '90 seconds'
   and r.state='DONE' and r.provider_ledger=true
  order by l.created_at limit p_limit for update of l skip locked
 )
 update public.ai_call_ledger l set state='CANCELLED',actual_usd=0,
  settled_at=clock_timestamp(),error='PARENT_DONE_BEFORE_DISPATCH'
 from terminal t where l.call_key=t.call_key and l.state='RESERVED';
 get diagnostics terminal_cancelled=row_count;
 for j in select * from public.gpt_final_entry_reviews
  where state='RUNNING' and provider_ledger=true
   and created_at<clock_timestamp()-interval '90 seconds'
   and jsonb_typeof(record->'expires_at_ms')='number'
   and (record->>'expires_at_ms')::numeric<extract(epoch from clock_timestamp()-interval '30 seconds')*1000
  order by created_at limit p_limit for update skip locked loop
  select exists(select 1 from public.ai_call_ledger where parent_key=j.job_key
    and state in ('DISPATCHED','UNKNOWN','SETTLED')) into dispatched;
  if not dispatched then
   -- A worker may still hold a RESERVED owner token. The transition fence
   -- observes this CANCELLED state before any network dispatch can occur.
   update public.ai_call_ledger set state='CANCELLED',actual_usd=0,
    settled_at=clock_timestamp(),error='PARENT_EXPIRED_BEFORE_DISPATCH'
    where parent_key=j.job_key and state='RESERVED';
   get diagnostics just_cancelled=row_count;
   cancelled:=cancelled+just_cancelled;
  else unresolved:=unresolved+1;
  end if;
  update public.gpt_final_entry_reviews set state='DONE',completed_at=clock_timestamp(),
   decision='ABSTAIN',valid=false,attempted=dispatched,
   error=case when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN'
     else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
   record=jsonb_set(j.record,'{result}',jsonb_build_object('origin','LOCAL_WORKER_RECOVERY',
     'valid',false,'decision','ABSTAIN','error',
     case when dispatched then 'REVIEW_EXPIRED_PROVIDER_OUTCOME_UNCERTAIN'
       else 'REVIEW_EXPIRED_BEFORE_DISPATCH' end,
     'attempted',dispatched,'completed_at_ms',floor(extract(epoch from clock_timestamp())*1000)::bigint))
   where job_key=j.job_key and owner=j.owner and state='RUNNING';
  expired:=expired+1;
 end loop;
 return jsonb_build_object('expired',expired,'unresolved',unresolved,
  'cancelled',cancelled,'terminal_cancelled',terminal_cancelled);
end $$;
