-- Total approved envelope remains USD 50: AI 45 + incremental storage reserve 5.
-- Daily burn remains 1.25 (at most 38.75 over 31 days); all old costs stay counted.
begin;
set local lock_timeout='1s';
alter table public.gpt_final_review_control drop constraint gpt_final_review_control_monthly_cap_usd_check;
alter table public.gpt_final_review_control add constraint gpt_final_review_control_monthly_cap_usd_check
 check(monthly_cap_usd between 0 and 45 and monthly_cap_usd::text not in ('NaN','Infinity','-Infinity'));
update public.gpt_final_review_control set monthly_cap_usd=45,
 approval_ref='USER-APPROVED-2026-09-27-MONTHLY50-AI45-STORAGE5',updated_at=now() where singleton;

create or replace function public.leader20_record_review() returns trigger language plpgsql set search_path='' as $$
declare marker jsonb; answer jsonb; outcome text; e public.leader20_review_events%rowtype;
begin
 marker:=new.record->'packet'->'leader20';
 if marker->>'version' is distinct from 'LEADER20_DYNAMIC_1' then return new; end if;
 select * into e from public.leader20_review_events where id=(marker->>'event_id')::uuid;
 if e.id is null or e.signal_id::text is distinct from new.record->'identity'->>'signal_id' then return new; end if;
 answer:=new.record->'result'->'answer';
 outcome:=case when new.record->'result'->>'valid'='true' and answer->>'action'='ENTER' then 'ENTER' else 'DEFER' end;
 update public.leader20_review_events set result=coalesce(result,'{}'::jsonb)||jsonb_build_object(
   'action',outcome,'review_job_key',new.job_key,'snapshot_hash',new.record->'packet'->>'snapshot_hash',
   'pressure_state',answer->>'pressure_state','decision_reason',answer->>'decision_reason',
   'counter_evidence',answer->'counter_evidence','thesis_invalidation',answer->>'thesis_invalidation',
   'next_review_conditions',answer->>'next_review_conditions','error',new.record->'result'->>'error') where id=e.id;
 -- A valid ENTRY DEFER finishes this event immediately. Observation remains alive;
 -- only the paced scheduler may create the next event. Technical failures may recover.
 if new.record->'packet'->>'task'='ENTRY' and new.record->'result'->>'valid'='true' and outcome='DEFER' then
  update public.leader20_review_events set state='DEFERRED' where id=e.id and state='REVIEWING';
 end if;
 update public.leader20_campaigns w set last_decision=outcome,next_review_conditions=answer->'next_review_conditions',updated_at=clock_timestamp()
 where w.symbol=e.symbol and w.epoch_id=e.epoch_id and w.last_requested_at<=e.requested_at and
   exists(select 1 from public.leader20_control c where c.epoch_id=e.epoch_id and c.generation=e.generation);
 return new;
end $$;
revoke all on function public.leader20_record_review() from public,anon,authenticated;
commit;
