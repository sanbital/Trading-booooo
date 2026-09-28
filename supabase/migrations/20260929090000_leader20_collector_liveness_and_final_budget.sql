-- Collector liveness as a first-class slot outcome, and observable FINAL-window accounting.
--
-- WHY
-- ---
-- On 2026-09-29 the doa-capture collector stopped at 04:33 KST. Its lease expired and was never
-- renewed; nothing streamed for four hours. Every ten-minute slot after it recorded exactly the
-- same shape as a capture problem -- ready=0, blocked=20, DECISION_WINDOW_INSUFFICIENT, retry 4-21
-- -- because that is all the batch runtime can see. The transport being GONE and the capture being
-- LATE were indistinguishable in telemetry, so a total outage read as ordinary flakiness and the
-- retry loop kept burning each decision window against streams that did not exist.
--
-- doa_capture.control.heartbeat_at already knows. This exposes it where the decision is made.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- The collector's own liveness, from the heartbeat it already writes on every ingest.
-- 75s: the worker itself gives up on a control response older than 90s, so anything beyond
-- 75s means the transport is gone rather than merely slow. Read-only; writes nothing.
create or replace function public.leader20_collector_health() returns jsonb
 language sql stable set search_path='' as $$
 select jsonb_build_object(
  'live',c.enabled and c.heartbeat_at>clock_timestamp()-interval '75 seconds'
   and c.heartbeat_at<=clock_timestamp()+interval '1 second',
  'enabled',c.enabled,'heartbeat_at',c.heartbeat_at,
  'heartbeat_age_ms',floor(extract(epoch from (clock_timestamp()-c.heartbeat_at))*1000),
  'lease_owner',c.lease_owner,'lease_until',c.lease_until,
  'lease_expired',c.lease_until is null or c.lease_until<=clock_timestamp(),
  'streaming_symbols',(select count(distinct symbol) from doa_capture.live_micro
   where kind='micro' and at>clock_timestamp()-interval '90 seconds'),
  'reason',case
   when not c.enabled then 'COLLECTOR_DISABLED'
   when c.heartbeat_at is null then 'COLLECTOR_NEVER_STARTED'
   when c.heartbeat_at<=clock_timestamp()-interval '75 seconds' then 'COLLECTOR_DOWN'
   else null end)
 from doa_capture.control c where c.id=1;
$$;
revoke all on function public.leader20_collector_health() from public,anon,authenticated;
grant execute on function public.leader20_collector_health() to service_role;

alter table public.leader20_clock_slots
 add column collector_reason text,
 add column collector_heartbeat_age_ms bigint;

-- Attribute a slot to the collector when the transport was gone, so a dead collector is never
-- again recorded as a capture or capacity problem. Telemetry only: this grants no authority and
-- changes no admission, order or capacity decision.
do $migration$
declare source text;marker text:='watch_count=greatest(coalesce(watch_count,0),coalesce((p_data->>''watch_count'')::integer,0)),';
begin
 select pg_get_functiondef('public.leader20_clock_note(timestamptz,jsonb)'::regprocedure) into source;
 if strpos(source,marker)=0 then raise exception 'CLOCK_NOTE_COLLECTOR_BASELINE_CHANGED';end if;
 source:=replace(source,marker,marker||'
  collector_reason=coalesce(p_data->>''collector_reason'',collector_reason),
  collector_heartbeat_age_ms=coalesce((p_data->>''collector_heartbeat_age_ms'')::bigint,collector_heartbeat_age_ms),');
 execute source;
end $migration$;

-- A blocked slot now names its own cause. capture_state separates the three cases the
-- 04:33 outage proved indistinguishable: the transport was gone, the capture was late,
-- or the account had no room.
create or replace view public.leader20_clock_slot_report as
select t.slot_at,t.slot_status,t.batch_reason,t.batch_id,
 case
  when t.collector_reason is not null then t.collector_reason
  when t.capture_ready_count>0 then 'CAPTURE_READY'
  when t.batch_reason='CAPACITY_ZERO' then 'NO_ENTRY_CAPACITY'
  when t.capture_blocked_count>0 then 'CAPTURE_INCOMPLETE'
  else 'NO_CAPTURE_ATTEMPT' end capture_state,
 t.collector_reason,t.collector_heartbeat_age_ms,
 t.open_position_count,t.available_slots_before,t.reserved_slots,
 coalesce(t.available_slots_after,t.available_slots) available_slots_after,t.available_slots,
 t.futures_available_margin,t.target_margin_per_slot,
 t.watch_count,t.capture_ready_count,t.capture_blocked_count,t.blocked_reasons,t.retry_count,
 (select count(*) from public.gpt_final_entry_reviews g
  where g.record#>>'{packet,leader20,batch_id}'=t.batch_id::text and g.purpose='PRODUCTION'
   and g.record#>>'{packet,task}'='ENTRY' and coalesce(g.record->>'kind','FD1_ENTRY')='FD1_ENTRY'
   and g.completed_at is not null and g.decision='BUY') buy_now_count,
 -- FINAL answers that landed after the slot's own authority expired. These are the fills the
 -- 120s window lost; they must be driven to zero by finishing sooner, never by widening it.
 (select count(*) from public.gpt_final_entry_reviews g
  where g.record#>>'{packet,leader20,batch_id}'=t.batch_id::text and g.purpose='PRODUCTION'
   and g.record#>>'{packet,task}'='ENTRY' and coalesce(g.record->>'kind','FD1_ENTRY')='FD1_ENTRY'
   and g.completed_at>=t.decision_deadline) final_after_expiry,
 (select count(*) from public.v11_long_regime_orders o join public.v11_long_regime_signals s on s.id=o.signal_id
  where o.intent='OPEN_LONG' and (s.features#>>'{leader20,entry_window,slot_ms}')::bigint
   =floor(extract(epoch from t.slot_at)*1000)::bigint) orders_attempted,
 (select count(*) from public.v11_long_regime_orders o join public.v11_long_regime_signals s on s.id=o.signal_id
  where o.intent='OPEN_LONG' and o.state='FILLED' and (s.features#>>'{leader20,entry_window,slot_ms}')::bigint
   =floor(extract(epoch from t.slot_at)*1000)::bigint) fills,
 (select count(*) from public.leader20_entry_reservations r
  where r.slot_ms=floor(extract(epoch from t.slot_at)*1000)::bigint) reservations,
 (select count(*) from public.leader20_entry_reservations r
  where r.slot_ms=floor(extract(epoch from t.slot_at)*1000)::bigint and r.state in ('RELEASED','EXPIRED')) reservations_released,
 -- Top20 publication lag against its own T-180s schedule. A lag over 60s used to cost the whole
 -- slot; it is now only a shorter transport lead for members that actually changed rank.
 (select round(extract(epoch from (e.observed_at-(t.slot_at-interval '180 seconds')))*1000)
  from public.leader20_epochs e
  where (e.snapshot->>'capture_slot_ms')::bigint=floor(extract(epoch from t.slot_at)*1000)::bigint
  order by e.observed_at limit 1) epoch_publish_lag_ms,
 t.decision_total_latency_ms,t.gpt_latency_ms,t.deepseek_latency_ms,t.batch_start_latency_ms,
 t.tracked_positions,t.capture_ready_at,t.decision_deadline,t.updated_at
from public.leader20_clock_slots t;
revoke all on public.leader20_clock_slot_report from public,anon,authenticated;
grant select on public.leader20_clock_slot_report to service_role;

notify pgrst,'reload schema';
commit;
