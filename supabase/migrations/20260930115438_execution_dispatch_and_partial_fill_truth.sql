-- Execution infrastructure only: order/position truth, durable immediate dispatch,
-- latency telemetry, and actual-use API accounting. No strategy parameter changes.

alter table public.leader20_clock_executions
 add column if not exists gpt_completed_at timestamptz,
 add column if not exists execution_dispatch_at timestamptz,
 add column if not exists executor_claimed_at timestamptz;

update public.leader20_clock_executions
set gpt_completed_at=gpt_buy_completed_at
where gpt_completed_at is null;

alter table public.leader20_clock_executions
 alter column gpt_completed_at set not null,
 add column if not exists gpt_to_dispatch_ms numeric generated always as
  (extract(epoch from execution_dispatch_at-gpt_completed_at)*1000) stored,
 add column if not exists dispatch_to_executor_ms numeric generated always as
  (extract(epoch from executor_claimed_at-execution_dispatch_at)*1000) stored,
 add column if not exists gpt_to_execution_ms numeric generated always as
  (extract(epoch from execution_started_at-gpt_completed_at)*1000) stored,
 add column if not exists execution_to_quote_ms numeric generated always as
  (extract(epoch from fresh_quote_received_at-execution_started_at)*1000) stored,
 add column if not exists order_to_fill_ms numeric generated always as
  (extract(epoch from fill_at-order_sent_at)*1000) stored;

create table public.leader20_execution_dispatches (
 signal_id uuid primary key references public.v11_long_regime_signals(id),
 symbol text not null,
 position_side text not null default 'LONG' check(position_side='LONG'),
 state text not null check(state in (
  'READY_TO_EXECUTE','EXECUTION_CLAIMED','ORDER_SUBMITTING',
  'FILLED','PARTIALLY_FILLED','PARTIALLY_FILLED_CANCELED','REJECTED','EXPIRED','UNKNOWN',
  'EXECUTION_WINDOW_INSUFFICIENT','CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION'
 )),
 gpt_completed_at timestamptz not null,
 valid_until timestamptz not null,
 dispatch_requested_at timestamptz not null default clock_timestamp(),
 executor_claimed_at timestamptz,
 execution_started_at timestamptz,
 claim_owner uuid,
 claim_lease_until timestamptz,
 claim_attempts integer not null default 0,
 order_id uuid references public.v11_long_regime_orders(id),
 terminal_at timestamptz,
 terminal_reason text,
 last_error text,
 updated_at timestamptz not null default clock_timestamp(),
 unique(signal_id,symbol,position_side),
 check(valid_until>gpt_completed_at)
);
create index leader20_execution_dispatch_ready
 on public.leader20_execution_dispatches(dispatch_requested_at)
 where state='READY_TO_EXECUTE';
create index leader20_execution_dispatch_lease
 on public.leader20_execution_dispatches(claim_lease_until)
 where state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING');
alter table public.leader20_execution_dispatches enable row level security;
revoke all on public.leader20_execution_dispatches from public,anon,authenticated;
grant all on public.leader20_execution_dispatches to service_role;

create or replace function public.leader20_execution_claim(
 p_signal_id uuid,p_owner uuid,p_min_remaining_ms bigint default 24000
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.leader20_execution_dispatches%rowtype;at_time timestamptz:=clock_timestamp();remaining_ms numeric;
begin
 if p_owner is null or p_min_remaining_ms<1000 or p_min_remaining_ms>60000 then
  raise exception 'EXECUTION_CLAIM_INPUT';
 end if;
 if p_signal_id is not null then
  select * into d from public.leader20_execution_dispatches
   where signal_id=p_signal_id for update;
 else
  select * into d from public.leader20_execution_dispatches
   where state='READY_TO_EXECUTE'
      or (state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and claim_lease_until<=at_time)
   order by dispatch_requested_at for update skip locked limit 1;
 end if;
 if d.signal_id is null then return jsonb_build_object('claimed',false,'reason','NO_READY_EXECUTION');end if;
 if d.state not in ('READY_TO_EXECUTE','EXECUTION_CLAIMED','ORDER_SUBMITTING') then
  return jsonb_build_object('claimed',false,'reason','EXECUTION_TERMINAL','row',to_jsonb(d));
 end if;
 if d.state in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') and d.claim_lease_until>at_time then
  return jsonb_build_object('claimed',false,'reason','EXECUTION_ALREADY_CLAIMED','row',to_jsonb(d));
 end if;
 remaining_ms:=extract(epoch from d.valid_until-at_time)*1000;
 if remaining_ms<=0 then
  update public.leader20_execution_dispatches set state='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',
   terminal_at=at_time,terminal_reason='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',updated_at=at_time
   where signal_id=d.signal_id returning * into d;
  update public.leader20_clock_executions set terminal_reason='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION',updated_at=at_time
   where signal_id=d.signal_id and order_sent_at is null;
  return jsonb_build_object('claimed',false,'reason','CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION','row',to_jsonb(d));
 end if;
 if remaining_ms<p_min_remaining_ms then
  update public.leader20_execution_dispatches set state='EXECUTION_WINDOW_INSUFFICIENT',
   terminal_at=at_time,terminal_reason='EXECUTION_WINDOW_INSUFFICIENT',updated_at=at_time
   where signal_id=d.signal_id returning * into d;
  update public.leader20_clock_executions set terminal_reason='EXECUTION_WINDOW_INSUFFICIENT',
   execution_failure_reason='EXECUTION_WINDOW_INSUFFICIENT',updated_at=at_time
   where signal_id=d.signal_id and order_sent_at is null;
  return jsonb_build_object('claimed',false,'reason','EXECUTION_WINDOW_INSUFFICIENT','remaining_ms',remaining_ms,'row',to_jsonb(d));
 end if;
 update public.leader20_execution_dispatches set state='EXECUTION_CLAIMED',claim_owner=p_owner,
  claim_lease_until=least(valid_until,at_time+interval '90 seconds'),executor_claimed_at=at_time,
  execution_started_at=coalesce(execution_started_at,at_time),claim_attempts=claim_attempts+1,
  last_error=null,updated_at=at_time where signal_id=d.signal_id returning * into d;
 update public.leader20_clock_executions set executor_claimed_at=least(executor_claimed_at,at_time),updated_at=at_time
  where signal_id=d.signal_id;
 return jsonb_build_object('claimed',true,'remaining_ms',remaining_ms,'row',to_jsonb(d));
end $$;

create or replace function public.leader20_execution_transition(
 p_signal_id uuid,p_owner uuid,p_state text,p_error text default null,p_order_id uuid default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.leader20_execution_dispatches%rowtype;at_time timestamptz:=clock_timestamp();next_state text:=p_state;
begin
 select * into d from public.leader20_execution_dispatches where signal_id=p_signal_id for update;
 if d.signal_id is null then return jsonb_build_object('updated',false,'reason','DISPATCH_NOT_FOUND');end if;
 if d.claim_owner is distinct from p_owner or d.state not in ('EXECUTION_CLAIMED','ORDER_SUBMITTING') then
  return jsonb_build_object('updated',false,'reason','DISPATCH_OWNER_OR_STATE','row',to_jsonb(d));
 end if;
 if next_state not in ('READY_TO_EXECUTE','ORDER_SUBMITTING','FILLED','PARTIALLY_FILLED',
  'PARTIALLY_FILLED_CANCELED','REJECTED','EXPIRED','UNKNOWN',
  'EXECUTION_WINDOW_INSUFFICIENT','CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION') then
  raise exception 'EXECUTION_TRANSITION_STATE';
 end if;
 if next_state='READY_TO_EXECUTE' and d.valid_until<=at_time then next_state:='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION';end if;
 if next_state='READY_TO_EXECUTE' and extract(epoch from d.valid_until-at_time)*1000<24000 then next_state:='EXECUTION_WINDOW_INSUFFICIENT';end if;
 if next_state='READY_TO_EXECUTE' then
  update public.leader20_execution_dispatches set state=next_state,claim_owner=null,claim_lease_until=null,
   last_error=left(p_error,500),updated_at=at_time where signal_id=p_signal_id returning * into d;
 elsif next_state='ORDER_SUBMITTING' then
  update public.leader20_execution_dispatches set state=next_state,order_id=coalesce(p_order_id,order_id),
   claim_lease_until=least(valid_until,at_time+interval '90 seconds'),updated_at=at_time
   where signal_id=p_signal_id returning * into d;
 else
  update public.leader20_execution_dispatches set state=next_state,order_id=coalesce(p_order_id,order_id),
   terminal_at=at_time,terminal_reason=next_state,last_error=left(p_error,500),claim_lease_until=null,
   updated_at=at_time where signal_id=p_signal_id returning * into d;
  update public.leader20_clock_executions set terminal_reason=coalesce(terminal_reason,next_state),
   execution_failure_reason=case when next_state in ('FILLED','PARTIALLY_FILLED','PARTIALLY_FILLED_CANCELED')
    then execution_failure_reason else coalesce(execution_failure_reason,left(p_error,500),next_state) end,
   updated_at=at_time where signal_id=p_signal_id;
 end if;
 return jsonb_build_object('updated',true,'row',to_jsonb(d));
end $$;

revoke all on function public.leader20_execution_claim(uuid,uuid,bigint),
 public.leader20_execution_transition(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.leader20_execution_claim(uuid,uuid,bigint),
 public.leader20_execution_transition(uuid,uuid,text,text,uuid) to service_role;

create or replace function public.leader20_enqueue_execution() returns trigger
language plpgsql security definer set search_path='' as $$
declare w jsonb;sid uuid;completed timestamptz;deadline timestamptz;inserted integer;token text;
begin
 if new.purpose<>'PRODUCTION' or new.state<>'DONE' or new.valid is distinct from true or new.decision<>'BUY'
  or new.record#>>'{result,review_route}'<>'TOP20_CLOCK_GPT_FINAL_3'
  or new.record#>>'{packet,leader20,entry_window,version}'<>'TOP20_CLOCK_CAPTURE_1'
  or (tg_op='UPDATE' and old.state='DONE' and old.valid is true and old.decision='BUY') then return new;end if;
 w:=new.record#>'{packet,leader20,entry_window}';
 sid:=(new.record#>>'{identity,signal_id}')::uuid;
 completed:=to_timestamp((new.record#>>'{result,completed_at_ms}')::numeric/1000);
 deadline:=to_timestamp((w->>'expires_at_ms')::numeric/1000);
 insert into public.leader20_clock_executions(signal_id,slot_at,decision_deadline,gpt_buy_completed_at,gpt_completed_at)
 values(sid,to_timestamp((w->>'slot_ms')::numeric/1000),deadline,completed,completed)
 on conflict(signal_id) do update set gpt_completed_at=excluded.gpt_completed_at,
  gpt_buy_completed_at=excluded.gpt_buy_completed_at,updated_at=clock_timestamp();
 insert into public.leader20_execution_dispatches(signal_id,symbol,state,gpt_completed_at,valid_until)
 values(sid,new.symbol,'READY_TO_EXECUTE',completed,deadline) on conflict(signal_id) do nothing;
 get diagnostics inserted=row_count;
 if inserted=0 then return new;end if;
 update public.leader20_clock_executions set execution_dispatch_at=clock_timestamp(),updated_at=clock_timestamp()
  where signal_id=sid;
 select t.token into token from public.edge_internal_tokens t where t.name='v10-lane-executor';
 if token is null then
  update public.leader20_execution_dispatches set last_error='IMMEDIATE_DISPATCH_TOKEN_MISSING' where signal_id=sid;
  return new;
 end if;
 begin
  perform net.http_post(
   url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',
   headers:=jsonb_build_object('content-type','application/json','x-v10-executor-token',token),
   body:=jsonb_build_object('mode','execute-ready','signalId',sid),timeout_milliseconds:=100000);
 exception when others then
  update public.leader20_execution_dispatches set last_error=left('IMMEDIATE_DISPATCH_ENQUEUE:'||sqlerrm,500)
   where signal_id=sid;
 end;
 return new;
end $$;
drop trigger if exists leader20_immediate_execution_gpt on public.gpt_final_entry_reviews;
create trigger leader20_immediate_execution_gpt after insert or update on public.gpt_final_entry_reviews
 for each row execute function public.leader20_enqueue_execution();
revoke all on function public.leader20_enqueue_execution() from public,anon,authenticated;

create or replace function public.leader20_clock_execution_note(p_signal_id uuid,p_trace jsonb) returns void
language sql set search_path='' as $$
 update public.leader20_clock_executions set
 gpt_completed_at=coalesce(to_timestamp((p_trace->>'gpt_completed_at')::numeric/1000),gpt_completed_at),
 execution_dispatch_at=least(execution_dispatch_at,to_timestamp((p_trace->>'execution_dispatch_at')::numeric/1000)),
 executor_claimed_at=least(executor_claimed_at,to_timestamp((p_trace->>'executor_claimed_at')::numeric/1000)),
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

-- Correct already-persisted IOC truth. A partial terminal order is not FILLED;
-- a zero-fill EXPIRED order is not REJECTED. Position rows remain untouched.
with evidence as (
 select id,requested_quantity,
  nullif(response_payload#>>'{order,executed_volume}','')::numeric executed,
  upper(response_payload#>>'{order,raw_status}') raw_status
 from public.v11_long_regime_orders
 where intent='OPEN_LONG' and response_payload->>'v18ExposureFinal'='true'
)
update public.v11_long_regime_orders o set
 state=case
  when e.executed>0 and e.executed<e.requested_quantity and e.raw_status in ('EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED') then 'PARTIALLY_FILLED_CANCELED'
  when e.executed=0 and e.raw_status='EXPIRED' then 'EXPIRED'
  else o.state end,
 reject_reason=case
  when e.executed>0 and e.executed<e.requested_quantity then 'PARTIAL_'||e.raw_status
  when e.executed=0 and e.raw_status='EXPIRED' then 'IOC_NO_FILL:EXPIRED'
  else o.reject_reason end,
 updated_at=clock_timestamp()
from evidence e where o.id=e.id and (
 (o.state='FILLED' and e.executed>0 and e.executed<e.requested_quantity)
 or (o.state='REJECTED' and e.executed=0 and e.raw_status='EXPIRED'));

-- Actual settled spend plus a deliberately small reservation only for requests that
-- have physically dispatched. RESERVED/UNKNOWN/402 rows are telemetry, not spend.
create or replace function public.ai_provider_month_used(
 p_provider text,p_day date default (now() at time zone 'UTC')::date
) returns numeric language sql stable set search_path='' as $$
 select case when p_provider='deepseek' then public.ai_legacy_deepseek_used(p_day)
  else greatest(0,public.ai_monthly_spend_used_before_provider_ledger(p_day)-public.ai_legacy_deepseek_used(p_day)) end
 +coalesce((select sum(coalesce(actual_usd,0)) from public.ai_call_ledger
   where provider=p_provider and created_at>=date_trunc('month',p_day) at time zone 'UTC'
    and created_at<(date_trunc('month',p_day)+interval '1 month') at time zone 'UTC'),0);
$$;

create or replace function public.leader20_entry_budget_limits() returns jsonb
language sql stable security definer set search_path='' as $$
 with exposure as (select count(*)::integer n from public.v11_long_regime_positions
  where state='OPEN' or remaining_quantity>0.0000000001 or metadata->>'exitAccountingPending'='true'),
 capacity as (select c.daily_cap_usd,c.max_calls_per_day,e.n from public.gpt_final_review_control c cross join exposure e where c.singleton)
 select jsonb_build_object('exposure_count',n,'protected_usd',0,'entry_cap_usd',greatest(0,daily_cap_usd),
  'entry_max_calls',max_calls_per_day) from capacity;
$$;

create or replace function public.ai_call_reserve(p_key text,p_provider text,p_model text,p_purpose text,
 p_parent text,p_version text,p_reserve numeric) returns jsonb
language plpgsql set search_path='' as $$
declare l public.ai_provider_limits%rowtype;j public.ai_call_ledger%rowtype;legacy_day numeric;ds_day numeric;cap jsonb;
 actual_day numeric;actual_entry numeric;inflight_day numeric;inflight_month numeric;month_actual numeric;
 day_start timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
 perform pg_advisory_xact_lock(20260927,40);perform pg_advisory_xact_lock(20260928,51);
 select * into j from public.ai_call_ledger where call_key=p_key;
 if found then
  if j.provider<>p_provider or j.model<>p_model or j.purpose<>p_purpose or j.data_version<>p_version or j.parent_key is distinct from p_parent
   then raise exception 'API_CALL_IDENTITY_CONFLICT';end if;
  return jsonb_build_object('created',false,'row',to_jsonb(j));
 end if;
 select * into l from public.ai_provider_limits where provider=p_provider for update;
 if not found or not l.enabled then return jsonb_build_object('created',false,'reason','PROVIDER_LEDGER_DISABLED');end if;
 if p_purpose in ('ENTRY','RECHECK') and (select enabled from public.leader20_batch_control where singleton) then
  perform pg_advisory_xact_lock(20260928,52);cap:=public.leader20_batch_capacity();
  if (cap->>'available')::integer<1 then return jsonb_build_object('created',false,'reason','API_NO_ENTRY_CAPACITY','capacity',cap);end if;
 end if;
 if p_reserve is null or p_reserve<=0 or p_reserve>=10 or p_reserve::text in ('NaN','Infinity','-Infinity') then raise exception 'API_RESERVE_INVALID';end if;
 if (p_provider='deepseek' and p_model<>'deepseek-flash') or (p_provider='openai' and p_model<>'gpt-5.4-mini-2026-03-17')
  then raise exception 'API_MODEL_NOT_PRICED';end if;
 select coalesce(sum(coalesce(actual_usd,0)),0),
  coalesce(sum(case when purpose in ('ENTRY','RECHECK','VERIFICATION') then coalesce(actual_usd,0) else 0 end),0),
  coalesce(sum(case when state='DISPATCHED' and actual_usd is null then least(reserved_usd,0.01) else 0 end),0)
 into actual_day,actual_entry,inflight_day from public.ai_call_ledger where provider=p_provider and created_at>=day_start;
 select coalesce(sum(case when state='DISPATCHED' and actual_usd is null then least(reserved_usd,0.01) else 0 end),0)
 into inflight_month from public.ai_call_ledger where provider=p_provider
  and created_at>=date_trunc('month',day_start) and created_at<date_trunc('month',day_start)+interval '1 month';
 select greatest(0,coalesce(b.settled_usd,0)-case when b.utc_day=g.budget_effective_day then g.daily_spend_offset else 0 end)
 into legacy_day from public.gpt_final_review_daily_budget b cross join public.gpt_final_review_control g
 where g.singleton and b.utc_day=(now() at time zone 'UTC')::date;
 ds_day:=public.ai_legacy_deepseek_used((now() at time zone 'UTC')::date,true);
 legacy_day:=case when p_provider='deepseek' then ds_day else greatest(0,coalesce(legacy_day,0)-ds_day) end;
 actual_day:=actual_day+legacy_day;actual_entry:=actual_entry+legacy_day;
 month_actual:=public.ai_provider_month_used(p_provider);
 if month_actual+inflight_month+least(p_reserve,0.01)>l.monthly_usd
  or actual_day+inflight_day+least(p_reserve,0.01)>l.daily_usd
  or (p_purpose in ('ENTRY','RECHECK','VERIFICATION') and actual_entry+inflight_day+least(p_reserve,0.01)>l.daily_usd) then
  return jsonb_build_object('created',false,'reason','API_BUDGET_EXHAUSTED','provider',p_provider,'purpose',p_purpose,
   'month_actual_usd',month_actual,'daily_actual_usd',actual_day,'inflight_minimum_usd',inflight_day,
   'monthly_limit_usd',l.monthly_usd,'daily_limit_usd',l.daily_usd,'accounting_basis','ACTUAL_PLUS_MINIMAL_INFLIGHT');
 end if;
 insert into public.ai_call_ledger(call_key,provider,model,purpose,parent_key,data_version,state,reserved_usd)
 values(p_key,p_provider,p_model,p_purpose,p_parent,p_version,'RESERVED',p_reserve) returning * into j;
 return jsonb_build_object('created',true,'row',to_jsonb(j),'accounting_basis','ACTUAL_PLUS_MINIMAL_INFLIGHT');
end $$;

revoke all on function public.ai_provider_month_used(text,date),public.leader20_entry_budget_limits(),
 public.ai_call_reserve(text,text,text,text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.ai_provider_month_used(text,date),public.leader20_entry_budget_limits(),
 public.ai_call_reserve(text,text,text,text,text,text,numeric) to service_role;
