-- Additive handoff repair on main 9e7cce61 / executor153 / generator45.
-- Provider/risk/capture policy and TOP20_CLOCK_GPT_FINAL_3 are unchanged.
set local lock_timeout='2s';
set local statement_timeout='30s';
alter table public.leader20_batch_control add column decision_reserve_ms integer not null default 80000
 check(decision_reserve_ms>=30000 and decision_reserve_ms<120000);
create unique index leader20_clock_one_batch_per_slot on public.leader20_batches(periodic_slot)
 where packet->>'version'='TOP20_DEEPSEEK_BATCH_1';
create index leader20_clock_gpt_batch on public.gpt_final_entry_reviews((record#>>'{packet,leader20,batch_id}'))
 where purpose='PRODUCTION';

create table public.leader20_clock_slots(
 slot_at timestamptz primary key, capture_start timestamptz not null,capture_end timestamptz not null,
 decision_deadline timestamptz not null,decision_reserve_ms integer not null default 80000,
 capture_ready_at timestamptz,batch_requested_at timestamptz,batch_created_at timestamptz,
 deepseek_started_at timestamptz,deepseek_completed_at timestamptz,
 gpt_started_at timestamptz,gpt_completed_at timestamptz,order_started_at timestamptz,order_sent_at timestamptz,
 capture_ready_count integer not null default 0,capture_blocked_count integer not null default 0,
 available_slots integer,retry_count integer not null default 0,
 slot_status text not null default 'BATCH_WAITING' check(slot_status in ('CAPTURE_COMPLETE','BATCH_WAITING','AI_REVIEWING','DECIDED','EXECUTING','DONE','EXPIRED')),
 batch_reason text,batch_id uuid,updated_at timestamptz not null default clock_timestamp(),
 capture_finalize_latency_ms numeric generated always as (extract(epoch from capture_ready_at-capture_end)*1000) stored,
 batch_start_latency_ms numeric generated always as (extract(epoch from batch_created_at-slot_at)*1000) stored,
 deepseek_latency_ms numeric generated always as (extract(epoch from deepseek_completed_at-deepseek_started_at)*1000) stored,
 gpt_latency_ms numeric generated always as (extract(epoch from gpt_completed_at-gpt_started_at)*1000) stored,
 decision_total_latency_ms numeric generated always as (extract(epoch from gpt_completed_at-slot_at)*1000) stored,
 check(capture_start=slot_at-interval '120 seconds' and capture_end=slot_at and decision_deadline=slot_at+interval '120 seconds')
);
alter table public.leader20_clock_slots enable row level security;
revoke all on public.leader20_clock_slots from public,anon,authenticated;
grant select,insert,update on public.leader20_clock_slots to service_role;

create function public.leader20_clock_note(p_slot_at timestamptz,p_data jsonb) returns jsonb
 language plpgsql set search_path='' as $$
begin
 if p_slot_at is null or mod(extract(epoch from p_slot_at),600)<>0 then raise exception 'CLOCK_SLOT_IDENTITY';end if;
 insert into public.leader20_clock_slots(slot_at,capture_start,capture_end,decision_deadline)
 values(p_slot_at,p_slot_at-interval '120 seconds',p_slot_at,p_slot_at+interval '120 seconds') on conflict do nothing;
 update public.leader20_clock_slots set
  decision_reserve_ms=coalesce((p_data->>'decision_reserve_ms')::integer,decision_reserve_ms),
  capture_ready_at=least(capture_ready_at,(p_data->>'capture_ready_at')::timestamptz),
  batch_requested_at=least(batch_requested_at,(p_data->>'batch_requested_at')::timestamptz),
  batch_created_at=least(batch_created_at,(p_data->>'batch_created_at')::timestamptz),
  deepseek_started_at=least(deepseek_started_at,(p_data->>'deepseek_started_at')::timestamptz),
  deepseek_completed_at=greatest(deepseek_completed_at,(p_data->>'deepseek_completed_at')::timestamptz),
  gpt_started_at=least(gpt_started_at,(p_data->>'gpt_started_at')::timestamptz),
  gpt_completed_at=greatest(gpt_completed_at,(p_data->>'gpt_completed_at')::timestamptz),
  order_started_at=least(order_started_at,(p_data->>'order_started_at')::timestamptz),
  order_sent_at=least(order_sent_at,(p_data->>'order_sent_at')::timestamptz),
  capture_ready_count=greatest(capture_ready_count,coalesce((p_data->>'capture_ready_count')::integer,0)),
  capture_blocked_count=coalesce((p_data->>'capture_blocked_count')::integer,capture_blocked_count),
  available_slots=coalesce((p_data->>'available_slots')::integer,available_slots),
  retry_count=greatest(retry_count,coalesce((p_data->>'retry_count')::integer,0)),
  batch_reason=case when batch_id is not null then batch_reason else coalesce(p_data->>'batch_reason',batch_reason) end,
  batch_id=coalesce(batch_id,(p_data->>'batch_id')::uuid),
  slot_status=case when slot_status in ('DONE','EXPIRED') then slot_status
   when batch_id is not null and p_data->>'slot_status'='EXPIRED' and clock_timestamp()<decision_deadline then slot_status
   when array_position(array['BATCH_WAITING','CAPTURE_COMPLETE','AI_REVIEWING','DECIDED','EXECUTING','DONE','EXPIRED'],p_data->>'slot_status')>
    array_position(array['BATCH_WAITING','CAPTURE_COMPLETE','AI_REVIEWING','DECIDED','EXECUTING','DONE','EXPIRED'],slot_status)
   then p_data->>'slot_status' else slot_status end,updated_at=clock_timestamp()
 where slot_at=p_slot_at;
 return jsonb_build_object('recorded',true);
end $$;

-- Patch the current function definition so preceding production fixes cannot be lost.
do $migration$
declare source text;old_guard text:='if at_time<slot_at+interval ''1 second'' or at_time>=slot_at+interval ''60 seconds'' then return jsonb_build_object(''created'',false,''reason'',''CLOCK_BATCH_NOT_DUE'');end if;';
begin
 select pg_get_functiondef('public.leader20_batch_claim(jsonb,text,boolean)'::regprocedure) into source;
 if strpos(source,old_guard)=0 then raise exception 'CLOCK_HANDOFF_BASELINE_CHANGED';end if;
 source:=replace(source,old_guard,$guard$
 -- Refresh wall time after acquiring the existing cross-request lock.
 at_time:=clock_timestamp();
 if at_time>=slot_at+interval '120 seconds' then return jsonb_build_object('created',false,'reason','DECISION_WINDOW_EXPIRED');end if;
 if at_time>=slot_at+interval '120 seconds'-c.decision_reserve_ms*interval '1 millisecond' then
  return jsonb_build_object('created',false,'reason','DECISION_WINDOW_INSUFFICIENT');end if;
 if c.last_periodic_slot>=slot_at or exists(select 1 from public.leader20_batches
  where periodic_slot=slot_at and packet->>'version'='TOP20_DEEPSEEK_BATCH_1') then
  return jsonb_build_object('created',false,'reason','NOT_DUE');end if;
 $guard$);
 source:=replace(source,'insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot)',
  'insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot,expires_at)');
 source:=replace(source,'''RESERVED'',reason,p_packet,slot_at)','''RESERVED'',reason,p_packet,slot_at,slot_at+interval ''120 seconds'')');
 source:=replace(source,'on conflict(data_version) do nothing','on conflict do nothing');
 -- Expensive integrity checks cannot admit after the reserved deadline either.
 source:=replace(source,'insert into public.leader20_batches(epoch_id',
  'if clock_timestamp()>=slot_at+interval ''120 seconds''-c.decision_reserve_ms*interval ''1 millisecond'' then return jsonb_build_object(''created'',false,''reason'',''DECISION_WINDOW_INSUFFICIENT'');end if;
 insert into public.leader20_batches(epoch_id');
 execute source;
end $migration$;

-- Carry the exact batch bindings into GPT even for unavailable advisory output.
do $migration$
declare source text;marker text:='insert into public.leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,reason,priority,result)';
begin
 select pg_get_functiondef('public.leader20_batch_finish(uuid,uuid,jsonb)'::regprocedure) into source;
 if strpos(source,marker)=0 then raise exception 'CLOCK_FINISH_BASELINE_CHANGED';end if;
 source:=replace(source,marker,'if b.packet#>>''{entry_window,version}''=''TOP20_CLOCK_CAPTURE_1'' then
   r:=r||jsonb_build_object(''entry_window'',s->''entry_window'',''trajectory_hash'',s->''trajectory_hash'',''capture_hash'',s->''capture_hash'');
  end if;
  '||marker);
 execute source;
end $migration$;

-- Journal changes provide timing even if an Edge response/worker is lost.
create function public.leader20_clock_journal() returns trigger language plpgsql set search_path='' as $$
declare j jsonb:=to_jsonb(new);prior jsonb;w jsonb;at_slot timestamptz;d jsonb;bid uuid;
 ready integer;finished integer;buys integer;
begin
 if tg_op='UPDATE' then prior:=to_jsonb(old);end if;
 if tg_table_name='leader20_batches' then
  w:=j#>'{packet,entry_window}';
  if w->>'version' is distinct from 'TOP20_CLOCK_CAPTURE_1' then return new;end if;
  at_slot:=to_timestamp((w->>'slot_ms')::numeric/1000);
  d:=jsonb_build_object('batch_id',j->>'id','batch_created_at',j->>'requested_at','batch_reason','CREATED',
   'capture_ready_count',(select count(*) from jsonb_array_elements(j#>'{packet,symbols}')s where s->>'state'='READY'),
   'capture_blocked_count',(select count(*) from jsonb_array_elements(j#>'{packet,symbols}')s where s->>'state'<>'READY'));
  if j->>'state'='DISPATCHED' and prior->>'state' is distinct from 'DISPATCHED' then
   d:=d||jsonb_build_object('deepseek_started_at',clock_timestamp(),'slot_status','AI_REVIEWING');end if;
  if j#>>'{result,completed_at_ms}' is not null then
   d:=d||jsonb_build_object('deepseek_completed_at',to_timestamp((j#>>'{result,completed_at_ms}')::numeric/1000));end if;
  if j->>'state' in ('SUPERSEDED','UNKNOWN') then d:=d||jsonb_build_object('slot_status','EXPIRED');end if;
 elsif tg_table_name='gpt_final_entry_reviews' then
  w:=j#>'{record,packet,leader20,entry_window}';
  if j->>'purpose' is distinct from 'PRODUCTION' or w->>'version' is distinct from 'TOP20_CLOCK_CAPTURE_1' then return new;end if;
  at_slot:=to_timestamp((w->>'slot_ms')::numeric/1000);bid:=(j#>>'{record,packet,leader20,batch_id}')::uuid;
  d:=jsonb_build_object('gpt_started_at',j->>'api_started_at','slot_status','AI_REVIEWING');
  if j->>'completed_at' is not null then
   d:=d||jsonb_build_object('gpt_completed_at',coalesce(j->>'api_completed_at',j->>'completed_at'));
   select count(*),count(*) filter(where r->>'decision'='BUY') into finished,buys
    from (select to_jsonb(r) r from public.gpt_final_entry_reviews r
     where r.record#>>'{packet,leader20,batch_id}'=bid::text and r.purpose='PRODUCTION') x where r->>'completed_at' is not null;
   select count(*) into ready from public.leader20_batches b cross join lateral jsonb_array_elements(b.packet->'symbols')s where b.id=bid and s->>'state'='READY';
   if finished>=ready and ready>0 then d:=d||jsonb_build_object('slot_status',case when buys>0 then 'DECIDED' else 'DONE' end);end if;
   if (j->>'completed_at')::timestamptz>=at_slot+interval '120 seconds' then d:=d||jsonb_build_object('slot_status','EXPIRED');end if;
  end if;
 else
  if j->>'intent' is distinct from 'OPEN_LONG' then return new;end if;
  select s.features#>'{leader20,entry_window}' into w from public.v11_long_regime_signals s where s.id::text=j->>'signal_id';
  if w->>'version' is distinct from 'TOP20_CLOCK_CAPTURE_1' then return new;end if;
  at_slot:=to_timestamp((w->>'slot_ms')::numeric/1000);
  d:=jsonb_build_object('order_started_at',coalesce(j->>'created_at',clock_timestamp()::text),'slot_status','EXECUTING');
  if j->>'state'='DISPATCHED' and prior->>'state' is distinct from 'DISPATCHED' then
   d:=d||jsonb_build_object('order_sent_at',clock_timestamp());end if;
  if j->>'state' in ('FILLED','REJECTED','CANCELLED','EXPIRED') then d:=d||jsonb_build_object('slot_status','DONE');end if;
 end if;
 perform public.leader20_clock_note(at_slot,d);return new;
end $$;
create trigger leader20_clock_batch_journal after insert or update on public.leader20_batches
 for each row execute function public.leader20_clock_journal();
create trigger leader20_clock_gpt_journal after insert or update on public.gpt_final_entry_reviews
 for each row execute function public.leader20_clock_journal();
create trigger leader20_clock_order_journal after insert or update on public.v11_long_regime_orders
 for each row execute function public.leader20_clock_journal();
revoke all on function public.leader20_clock_note(timestamptz,jsonb),public.leader20_clock_journal() from public,anon,authenticated;
grant execute on function public.leader20_clock_note(timestamptz,jsonb),public.leader20_clock_journal() to service_role;

create function public.leader20_clock_expire() returns void language sql set search_path='' as $$
 update public.leader20_clock_slots set slot_status=case when batch_reason='CAPACITY_ZERO' then 'DONE' else 'EXPIRED' end,
  updated_at=clock_timestamp()
 where decision_deadline<=clock_timestamp() and slot_status not in ('DONE','EXPIRED');
$$;
revoke all on function public.leader20_clock_expire() from public,anon,authenticated;
grant execute on function public.leader20_clock_expire() to service_role;
-- Only telemetry is finalized here; this job never requests a model or an order.
do $$begin
 if to_regclass('cron.job') is not null then
  perform cron.schedule('leader20-clock-telemetry-expiry','10 seconds','select public.leader20_clock_expire();');
 end if;
end $$;
