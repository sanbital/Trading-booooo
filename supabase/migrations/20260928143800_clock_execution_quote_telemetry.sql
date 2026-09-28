-- ENTRY observability only. No strategy, order, capital or exit policy changes.
create table public.leader20_clock_executions (
 signal_id uuid primary key references public.v11_long_regime_signals(id),
 slot_at timestamptz not null, decision_deadline timestamptz not null,
 gpt_buy_completed_at timestamptz not null,
 executor_wake_at timestamptz, execution_started_at timestamptz,
 fresh_quote_requested_at timestamptz, fresh_quote_received_at timestamptz,
 quote_age_ms bigint, quote_after_gpt_ms bigint, clock_safety_result text,
 order_intent_at timestamptz, order_sent_at timestamptz, fill_at timestamptz,
 old_quote_used boolean, quote_refresh_attempts integer not null default 0,
 execution_failure_reason text, terminal_reason text,
 trace jsonb not null default '{}', updated_at timestamptz not null default clock_timestamp(),
 gpt_to_executor_wake_ms numeric generated always as (extract(epoch from executor_wake_at-gpt_buy_completed_at)*1000) stored,
 gpt_to_quote_ms numeric generated always as (extract(epoch from fresh_quote_received_at-gpt_buy_completed_at)*1000) stored,
 gpt_to_order_ms numeric generated always as (extract(epoch from order_sent_at-gpt_buy_completed_at)*1000) stored,
 quote_to_order_ms numeric generated always as (extract(epoch from order_sent_at-fresh_quote_received_at)*1000) stored
);
alter table public.leader20_clock_executions enable row level security;
revoke all on public.leader20_clock_executions from public,anon,authenticated;
grant all on public.leader20_clock_executions to service_role;
create index leader20_clock_execution_expiry on public.leader20_clock_executions(decision_deadline)
 where terminal_reason is null and order_sent_at is null;

create function public.leader20_clock_execution_note(p_signal_id uuid,p_trace jsonb) returns void
 language sql set search_path='' as $$
 update public.leader20_clock_executions set
 executor_wake_at=least(executor_wake_at,to_timestamp((p_trace->>'executor_wake_at')::numeric/1000)),
 execution_started_at=least(execution_started_at,to_timestamp((p_trace->>'execution_started_at')::numeric/1000)),
 fresh_quote_requested_at=coalesce(to_timestamp((p_trace->>'fresh_quote_requested_at')::numeric/1000),fresh_quote_requested_at),
 fresh_quote_received_at=coalesce(to_timestamp((p_trace->>'fresh_quote_received_at')::numeric/1000),fresh_quote_received_at),
 quote_age_ms=coalesce((p_trace->>'quote_age_ms')::bigint,quote_age_ms),
 quote_after_gpt_ms=coalesce((p_trace->>'quote_after_gpt_ms')::bigint,quote_after_gpt_ms),
 clock_safety_result=coalesce(p_trace->>'clock_safety_result',clock_safety_result),
 order_intent_at=least(order_intent_at,to_timestamp((p_trace->>'order_intent_at')::numeric/1000)),
 order_sent_at=least(order_sent_at,to_timestamp((p_trace->>'order_sent_at')::numeric/1000)),
 fill_at=least(fill_at,to_timestamp((p_trace->>'fill_at')::numeric/1000)),
 old_quote_used=case when p_trace?'old_quote_used' then coalesce(old_quote_used,false) or (p_trace->>'old_quote_used')::boolean else old_quote_used end,
 quote_refresh_attempts=greatest(quote_refresh_attempts,coalesce((p_trace->>'quote_refresh_attempts')::integer,0)),
 execution_failure_reason=coalesce(execution_failure_reason,p_trace->>'execution_failure_reason'),
 terminal_reason=coalesce(terminal_reason,p_trace->>'terminal_reason'),
 trace=trace||p_trace,updated_at=clock_timestamp()
 where signal_id=p_signal_id;
$$;

create function public.leader20_clock_execution_journal() returns trigger language plpgsql set search_path='' as $$
declare j jsonb:=to_jsonb(new);w jsonb;d jsonb;sid uuid;
begin
 if tg_table_name='gpt_final_entry_reviews' then
  w:=j#>'{record,packet,leader20,entry_window}';
  if j->>'purpose'='PRODUCTION' and j->>'valid'='true' and j->>'decision'='BUY'
   and j#>>'{record,result,review_route}'='TOP20_CLOCK_GPT_FINAL_3' and w->>'version'='TOP20_CLOCK_CAPTURE_1' then
   insert into public.leader20_clock_executions(signal_id,slot_at,decision_deadline,gpt_buy_completed_at)
    values((j#>>'{record,identity,signal_id}')::uuid,to_timestamp((w->>'slot_ms')::numeric/1000),
     to_timestamp((w->>'expires_at_ms')::numeric/1000),to_timestamp((j#>>'{record,result,completed_at_ms}')::numeric/1000))
    on conflict(signal_id) do nothing;
  end if;
  return new;
 elsif tg_table_name='v11_long_regime_decisions' then
  if coalesce(j#>>'{details,stage}','') not in ('CLOCK_EXECUTION_SAFETY','ENTRY_ATTEMPT_OUTCOME','PRE_ORDER_REJECTION')
   or coalesce(j#>>'{details,signalId}','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new;end if;
  sid:=(j#>>'{details,signalId}')::uuid;
  d:=coalesce(nullif(j#>'{details,clockExecutionTelemetry}','null'::jsonb),'{}'::jsonb);
  if j->>'action' in ('ENTRY_DEFER','ENTRY_REJECT') then d:=d||jsonb_build_object('execution_failure_reason',j->>'reason');end if;
 else
  if j->>'intent' is distinct from 'OPEN_LONG' then return new;end if;
  sid:=(j->>'signal_id')::uuid;
  -- Prefer the final send boundary; request telemetry predates durable-intent I/O.
  d:=coalesce(nullif(j#>'{response_payload,v22EntryFinality,clockExecutionTelemetry}','null'::jsonb),
   nullif(j#>'{request_payload,entry_clock_execution}','null'::jsonb),'{}'::jsonb);
  d:=d||jsonb_build_object('order_intent_at',extract(epoch from (j->>'created_at')::timestamptz)*1000);
  if j#>>'{response_payload,v22EntryFinality,sentAt}' is not null then
   d:=d||jsonb_build_object('order_sent_at',(j#>>'{response_payload,v22EntryFinality,sentAt}')::bigint);end if;
  if j->>'state'='REJECTED' then d:=d||jsonb_build_object('execution_failure_reason',j->>'reject_reason');end if;
 end if;
 if sid is not null then perform public.leader20_clock_execution_note(sid,d);end if;
 return new;
end $$;
create trigger leader20_clock_execution_gpt after insert or update on public.gpt_final_entry_reviews
 for each row execute function public.leader20_clock_execution_journal();
create trigger leader20_clock_execution_decision after insert on public.v11_long_regime_decisions
 for each row execute function public.leader20_clock_execution_journal();
create trigger leader20_clock_execution_order after insert or update on public.v11_long_regime_orders
 for each row execute function public.leader20_clock_execution_journal();

create function public.leader20_clock_execution_expire() returns void language sql set search_path='' as $$
 update public.leader20_clock_executions set terminal_reason='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',updated_at=clock_timestamp()
 where decision_deadline<=clock_timestamp() and order_sent_at is null and terminal_reason is null;
$$;
revoke all on function public.leader20_clock_execution_note(uuid,jsonb),public.leader20_clock_execution_journal(),public.leader20_clock_execution_expire() from public,anon,authenticated;
grant execute on function public.leader20_clock_execution_note(uuid,jsonb),public.leader20_clock_execution_journal(),public.leader20_clock_execution_expire() to service_role;
-- Backfill only already-stored facts; unknown wake/quote/order times remain NULL.
insert into public.leader20_clock_executions(signal_id,slot_at,decision_deadline,gpt_buy_completed_at,execution_failure_reason,trace)
 select s.id,to_timestamp((r.record#>>'{packet,leader20,entry_window,slot_ms}')::numeric/1000),
  to_timestamp((r.record#>>'{packet,leader20,entry_window,expires_at_ms}')::numeric/1000),
  to_timestamp((r.record#>>'{result,completed_at_ms}')::numeric/1000),
  case when s.features#>>'{entryLifecycle,stage}'='EXECUTION' then s.features#>>'{entryLifecycle,reason}' end,
  '{"backfilled_from":"gpt_final_entry_reviews+entryLifecycle"}'::jsonb
 from public.gpt_final_entry_reviews r join public.v11_long_regime_signals s on s.id::text=r.record#>>'{identity,signal_id}'
 where r.purpose='PRODUCTION' and r.valid=true and r.decision='BUY'
  and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3'
  and r.record#>>'{packet,leader20,entry_window,version}'='TOP20_CLOCK_CAPTURE_1'
 on conflict(signal_id) do nothing;
-- Backfilled sent orders retain their actual durable gateway timestamp too.
update public.leader20_clock_executions e set order_sent_at=x.sent_at
 from (select signal_id,min(to_timestamp((response_payload#>>'{v22EntryFinality,sentAt}')::numeric/1000)) sent_at
  from public.v11_long_regime_orders where intent='OPEN_LONG' and response_payload#>>'{v22EntryFinality,sentAt}' is not null group by signal_id)x
 where e.signal_id=x.signal_id;
select public.leader20_clock_execution_expire();
do $$begin
 if to_regclass('cron.job') is not null then
  perform cron.schedule('leader20-clock-execution-expiry','10 seconds','select public.leader20_clock_execution_expire();');
 end if;
end $$;
