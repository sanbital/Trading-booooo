-- Telemetry maintenance only: no authority, strategy, provider or exchange call.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
alter table public.leader20_clock_slots
 add column if not exists completion_telemetry_checked_at timestamptz,
 add column if not exists completion_reconciled_at timestamptz,
 add column if not exists completion_reconciled_batch_id uuid;
create or replace function public.leader20_clock_expire()
 returns void language plpgsql set search_path='' as $fn$
declare t record;f record;next_status text;at_time timestamptz:=clock_timestamp();
begin
 -- Shared by cron, generator and manual telemetry calls; never queue overlapping work.
 if not pg_try_advisory_xact_lock(hashtextextended('leader20-clock-completion-maintenance-v2',0)) then return;end if;
 -- Give live slots priority, then oldest unchecked history. A durable check cursor
 -- prevents incomplete historical slots from starving newer reconciliation.
 for t in select slot_at,batch_id,slot_status,capture_ready_count,decision_deadline
  from public.leader20_clock_slots
  where slot_status in ('AI_REVIEWING','EXPIRED') and capture_ready_count>0 and order_sent_at is null
   and completion_reconciled_batch_id is distinct from batch_id
  order by (decision_deadline>at_time) desc,completion_telemetry_checked_at asc nulls first,slot_at desc
  limit 32 for update skip locked
 loop
  -- Parameterized single-batch lookup uses the existing leader20_clock_gpt_batch
  -- index. Do not join every large review JSON document against all old slots.
  select count(distinct r.record#>>'{packet,symbol}') completed,
   count(*) filter(where r.decision='BUY') buys,
   max(coalesce(r.api_completed_at,r.completed_at)) completed_at into f
  from public.gpt_final_entry_reviews r
  where r.record#>>'{packet,leader20,batch_id}'=t.batch_id::text
   and r.purpose='PRODUCTION' and r.record#>>'{packet,task}'='ENTRY'
   and coalesce(r.record->>'kind','FD1_ENTRY')='FD1_ENTRY' and r.completed_at is not null;
  next_status:=t.slot_status;
  if f.completed>=t.capture_ready_count and f.completed_at<t.decision_deadline then
   next_status:=case when f.buys=0 then 'DONE' when clock_timestamp()<t.decision_deadline then 'DECIDED' else 'EXPIRED' end;
  end if;
  update public.leader20_clock_slots set slot_status=next_status,
   completion_telemetry_checked_at=at_time,
   completion_reconciled_at=case when f.completed>=t.capture_ready_count then at_time else completion_reconciled_at end,
   completion_reconciled_batch_id=case when f.completed>=t.capture_ready_count then t.batch_id else completion_reconciled_batch_id end,
   -- An unchanged expired terminal slot must not churn its operational timestamp.
   updated_at=case when slot_status is distinct from next_status then at_time else updated_at end
  where slot_at=t.slot_at;
 end loop;
 update public.leader20_clock_slots set slot_status=case when batch_reason='CAPACITY_ZERO' then 'DONE' else 'EXPIRED' end,
  updated_at=at_time where decision_deadline<=at_time and slot_status not in ('DONE','EXPIRED');
end $fn$;
-- Existing execution expiry already has a selective partial deadline index. Keep
-- its authority/deadline semantics unchanged; dispatch recovery is separate.
create or replace function public.leader20_clock_telemetry_maintain()
 returns void language plpgsql security definer set search_path='' as $fn$
begin
 if not pg_try_advisory_xact_lock(hashtextextended('leader20-clock-completion-maintenance-v2',0)) then return;end if;
 perform public.leader20_clock_expire();
 perform public.leader20_clock_execution_expire();
end $fn$;
commit;
