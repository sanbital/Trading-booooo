-- Concurrent GPT completions must not leave a fully reviewed slot AI_REVIEWING.
-- This changes telemetry only: no admission, expiry authority, provider or order call.
do $migration$
declare source text;marker text:='d:=jsonb_build_object(''gpt_started_at'',j->>''api_started_at'',''slot_status'',''AI_REVIEWING'');';
begin
 select pg_get_functiondef('public.leader20_clock_journal()'::regprocedure) into source;
 if strpos(source,marker)=0 then raise exception 'CLOCK_JOURNAL_BASELINE_CHANGED';end if;
 source:=replace(source,marker,'-- Serialize before counting other committed completions, not after the count.
  perform 1 from public.leader20_clock_slots where slot_at=at_slot for update;
  '||marker);
 execute source;
end $migration$;

create or replace function public.leader20_clock_expire() returns void language sql set search_path='' as $$
 -- Reconcile durable results as well, including a missed/overlapping last trigger.
 with finished as (
  select t.slot_at,count(*) completed,count(*) filter(where r.decision='BUY') buys,
   max(coalesce(r.api_completed_at,r.completed_at)) completed_at
  from public.leader20_clock_slots t join public.gpt_final_entry_reviews r
   on r.record#>>'{packet,leader20,batch_id}'=t.batch_id::text and r.purpose='PRODUCTION'
  where t.slot_status in ('AI_REVIEWING','EXPIRED') and t.capture_ready_count>0
   and t.order_sent_at is null and r.completed_at is not null
  group by t.slot_at
 )
 update public.leader20_clock_slots t set
  slot_status=case when f.buys=0 then 'DONE' when clock_timestamp()<t.decision_deadline then 'DECIDED' else 'EXPIRED' end,
  updated_at=clock_timestamp()
 from finished f where f.slot_at=t.slot_at and f.completed>=t.capture_ready_count
  and f.completed_at<t.decision_deadline;
 update public.leader20_clock_slots set slot_status=case when batch_reason='CAPACITY_ZERO' then 'DONE' else 'EXPIRED' end,
  updated_at=clock_timestamp()
 where decision_deadline<=clock_timestamp() and slot_status not in ('DONE','EXPIRED');
$$;
revoke all on function public.leader20_clock_expire() from public,anon,authenticated;
grant execute on function public.leader20_clock_expire() to service_role;
select public.leader20_clock_expire();
