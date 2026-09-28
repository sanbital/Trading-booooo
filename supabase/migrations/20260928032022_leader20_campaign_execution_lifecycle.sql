-- Preserve production campaign/collector/order implementation. Candidate TTL remains 120 seconds.
alter table public.leader20_batch_control add column last_periodic_slot timestamptz,
 add column next_periodic_at timestamptz;
alter table public.leader20_batches add column periodic_slot timestamptz;
create unique index leader20_periodic_once on public.leader20_batches(periodic_slot) where periodic_slot is not null;
alter table public.leader20_campaigns add column review_due_at timestamptz,
 add column execution_state text not null default 'IDLE',add column last_candidate_id uuid,
 add column last_batch_id uuid;

-- The single existing one-minute observer and collector can both call this. Neither
-- creates paid reviews. Database claims below are the only paid batch admission.
create or replace function public.leader20_schedule() returns jsonb language plpgsql set search_path='' as $$
declare ctl public.leader20_control%rowtype;w record;c jsonb;at_time timestamptz:=clock_timestamp();held boolean;
begin
 if not (select enabled from public.leader20_batch_control where singleton) then return public.leader20_schedule_before_batch(); end if;
 if not pg_try_advisory_xact_lock(20260927,30) then return jsonb_build_object('reason','SCHEDULER_BUSY'); end if;
 select * into ctl from public.leader20_control where singleton;
 if not ctl.observation_enabled then return jsonb_build_object('reason','OBSERVATION_DISABLED'); end if;
 if ctl.last_scheduler_at>at_time-interval '55 seconds' then return jsonb_build_object('reason','OBSERVATION_THROTTLED'); end if;
 update public.leader20_control set last_scheduler_at=at_time where singleton;
 -- An execution lease is not a campaign lease. Keep terminal signal rows for audit.
 update public.leader20_review_events e set state=case when s.status in ('ORDERED','FILLED','CLOSED') then 'ORDERED' else 'DEFERRED' end,
  result=coalesce(e.result,'{}')||jsonb_build_object('signal_status',s.status,'candidate_expired',e.expires_at<=at_time,'reason',s.reject_reason)
 from public.v11_long_regime_signals s where s.id=e.signal_id and e.state='REVIEWING'
  and (s.status in ('REJECTED','ORDERED','FILLED','CLOSED') or e.expires_at<=at_time)
  and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=s.id and o.intent='OPEN_LONG'
   and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 update public.leader20_review_events set state='DEFERRED',result=coalesce(result,'{}')||'{"reason":"CAPTURE_REFRESH_WINDOW_EXHAUSTED"}'::jsonb
 where state='REQUESTED' and requested_at<at_time-interval '120 seconds';
 for w in select * from public.leader20_campaigns order by symbol for update skip locked loop
  held:=exists(select 1 from public.v11_long_regime_positions p where p.symbol=w.symbol and
   (p.state='OPEN' or p.remaining_quantity>0.0000000001 or p.metadata->>'exitAccountingPending'='true'));
  if not exists(select 1 from public.leader20_members m where m.epoch_id=ctl.epoch_id and m.symbol=w.symbol and m.rank<=ctl.watch_limit) then
   update public.leader20_campaigns set state=case when held then 'MANAGE_ONLY' else 'OUTSIDE_WATCH' end,
    reason='TOP10_EXIT',review_due_at=null,updated_at=at_time where symbol=w.symbol;continue;
  end if;
  c:=public.doa_context_for_role_v1(w.symbol,at_time,'TRADE_CANDIDATE',null);
  update public.leader20_campaigns set state=case when held then 'OPEN' else 'WATCHING' end,
   bucket_count=coalesce((c->>'buckets')::integer,0),last_bucket_at=case when c->>'status'='AVAILABLE' then to_timestamp((c->>'end_ms')::numeric/1000) else last_bucket_at end,
   execution_state=case when held then 'FILLED'
    when exists(select 1 from public.leader20_review_events e where e.symbol=w.symbol and e.state='REVIEWING') then execution_state
    when c->>'status' is distinct from 'AVAILABLE' then 'REFRESHING' else 'IDLE' end,
   review_due_at=(select coalesce(next_periodic_at,to_timestamp(floor(extract(epoch from at_time)/600)*600)) from public.leader20_batch_control where singleton),
   updated_at=at_time where symbol=w.symbol;
 end loop;
 return jsonb_build_object('requests',0,'reason','BATCH_SCHEDULER_OWNS_ENTRY','observed_at',at_time);
end $$;

create or replace function public.leader20_batch_claim(p_packet jsonb,p_evidence_key text,p_strong_change boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.leader20_batch_control%rowtype;l public.leader20_control%rowtype;cap jsonb;b public.leader20_batches%rowtype;
 reason text;at_time timestamptz:=clock_timestamp();strong boolean:=false;last_packet jsonb;
 estimate numeric;remaining_ticks integer;day_used numeric;entry_room numeric; slot_at timestamptz:=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600);
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into c from public.leader20_batch_control where singleton for update;
 if not c.enabled then return jsonb_build_object('created',false,'reason','BATCH_DISABLED'); end if;
 select * into l from public.leader20_control where singleton;
 cap:=public.leader20_batch_capacity();
 update public.leader20_batch_control set last_slots=(cap->>'available')::integer where singleton;
 if (cap->>'available')::integer=0 then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 select packet into last_packet from public.leader20_batches order by requested_at desc limit 1;
 select exists(select 1 from jsonb_array_elements(p_packet->'evidence') n
  join jsonb_array_elements(last_packet->'evidence') o on n->>0=o->>0
  where abs((n->>1)::numeric/nullif((o->>1)::numeric,0)-1)>=.002
   or (sign((n->>2)::numeric)<>sign((o->>2)::numeric) and abs((n->>3)::numeric-(o->>3)::numeric)>=.15)) into strong;
 if l.epoch_id::text is distinct from p_packet->>'epoch_id' or l.generation is distinct from (p_packet->>'generation')::bigint
 or not l.observation_enabled or l.active_strategy<>'LEADER20_DYNAMIC_1' then raise exception 'BATCH_GENERATION'; end if;
 if p_packet->>'version' is distinct from 'TOP10_DEEPSEEK_BATCH_3' then raise exception 'BATCH_LIVE_PROTOCOL_REQUIRED'; end if;
 if jsonb_array_length(p_packet->'symbols')<>10 or
 (select count(distinct x->>'id') from jsonb_array_elements(p_packet->'symbols')x)<>10 or
 exists(select 1 from jsonb_array_elements(p_packet->'symbols')x where not exists(
  select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=10 and symbol=x->>'id')) then raise exception 'BATCH_MEMBERSHIP'; end if;
 if (p_packet->>'as_of_ms')::numeric<extract(epoch from at_time)*1000-10000 or
  (p_packet->>'as_of_ms')::numeric>extract(epoch from at_time)*1000 then raise exception 'BATCH_STALE'; end if;
 reason:=case when c.last_periodic_slot is null or c.last_periodic_slot<slot_at then 'TEN_MINUTE' when c.last_slots=0 then 'SLOT_RELEASED'
  when p_strong_change and strong and p_evidence_key is distinct from c.last_evidence_key and c.last_requested_at<=at_time-interval '60 seconds' and at_time<slot_at+interval '9 minutes' then 'EVIDENCE_CHANGED' end;
 if reason is null then return jsonb_build_object('created',false,'reason','NOT_DUE'); end if;
 -- Extra evidence wakes cannot consume the remaining day's periodic review allowance.
 -- This is cost admission only, never a filter on model decisions or candidate quality.
 if reason='EVIDENCE_CHANGED' then
  select greatest(.0001,coalesce(max((input_tokens*.3+output_tokens*1.2)/1000000),.02)) into estimate
   from public.ai_call_ledger where provider='deepseek' and parent_key like 'batch:%' and state='SETTLED'
    and created_at>at_time-interval '7 days';
  remaining_ticks:=ceil(extract(epoch from (date_trunc('day',at_time)+interval '1 day'-at_time))/600);
  select coalesce(sum(case when state='CANCELLED' then 0 else coalesce(actual_usd,reserved_usd) end),0) into day_used
   from public.ai_call_ledger where provider='deepseek' and created_at>=date_trunc('day',at_time);
  day_used:=day_used+public.ai_legacy_deepseek_used((at_time at time zone 'UTC')::date,true);
  select daily_usd-least(daily_usd,coalesce((public.leader20_entry_budget_limits()->>'protected_usd')::numeric,.5))-day_used
   into entry_room from public.ai_provider_limits where provider='deepseek';
  if entry_room < estimate*(remaining_ticks+1) then
   update public.leader20_batch_control set wake_reason='EXTRA_BATCH_BUDGET_RESERVED',
    last_budget_block=jsonb_build_object('at',at_time,'reason','EXTRA_BATCH_BUDGET_RESERVED',
     'extra_required_usd',estimate*(remaining_ticks+1)-entry_room,'periodic_requests_reserved',remaining_ticks) where singleton;
   return jsonb_build_object('created',false,'reason','EXTRA_BATCH_BUDGET_RESERVED','additional_usd',estimate*(remaining_ticks+1)-entry_room);
  end if;
 end if;
 if exists(select 1 from public.leader20_batches where state in ('RESERVED','DISPATCHED') and expires_at>at_time) then
  return jsonb_build_object('created',false,'reason','BATCH_IN_FLIGHT'); end if;
 update public.leader20_batches set state='UNKNOWN' where state in ('RESERVED','DISPATCHED') and expires_at<=at_time;
 insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot)
 values(l.epoch_id,l.generation,p_packet->>'batch_hash','RESERVED',reason,p_packet,case when reason='TEN_MINUTE' then slot_at end)
 on conflict(data_version) do nothing returning * into b;
 if b.id is null then return jsonb_build_object('created',false,'reason','DUPLICATE_CAPTURE'); end if;
 update public.leader20_batch_control set last_requested_at=at_time,last_evidence_key=p_evidence_key,generation=generation+1,wake_reason=reason,
  last_periodic_slot=case when reason='TEN_MINUTE' then slot_at else last_periodic_slot end,
  next_periodic_at=slot_at+interval '10 minutes' where singleton;
 return jsonb_build_object('created',true,'row',to_jsonb(b),'capacity',cap);
end $$;

create or replace function public.leader20_batch_finish(p_id uuid,p_owner uuid,p_result jsonb) returns jsonb language plpgsql set search_path='' as $$
declare b public.leader20_batches%rowtype;l public.leader20_control%rowtype;r jsonb;s jsonb;c jsonb; n integer:=0;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into b from public.leader20_batches where id=p_id and owner=p_owner for update;
 if not found then raise exception 'BATCH_FINISH_OWNER'; end if;
 if b.state in ('DONE','SUPERSEDED') then return jsonb_build_object('events',0,'duplicate',true); end if;
 if b.state<>'DISPATCHED' then raise exception 'BATCH_FINISH_CAS'; end if;
 select * into l from public.leader20_control where singleton;
 c:=public.leader20_batch_capacity();
 if b.expires_at<=clock_timestamp() or b.epoch_id<>l.epoch_id or b.generation<>l.generation or (c->>'available')::integer<1
 or not (select enabled from public.leader20_batch_control where singleton)
 or exists(select 1 from public.leader20_batches where requested_at>b.requested_at) then
  update public.leader20_batches set state='SUPERSEDED',result=p_result||jsonb_build_object('blocked_reason','CAPACITY_OR_VERSION_CHANGED') where id=p_id;
  return jsonb_build_object('events',0,'reason','CAPACITY_OR_VERSION_CHANGED');
 end if;
 -- A newer batch is evidence, not revocation of a fresh GPT candidate.
 perform public.leader20_schedule();
 for r in select * from jsonb_array_elements(p_result->'results') loop
  update public.leader20_campaigns set
   state=case when c->'held' ? (r->>'id') then 'OPEN' else 'WATCHING' end,
   reason=case when r->>'valid'='true' then 'DEEPSEEK_'||(r->>'decision') else coalesce(r->>'reason','DATA_UNAVAILABLE') end,
   last_batch_id=b.id,last_decision=r->>'decision',last_requested_at=b.requested_at,
   review_due_at=(select next_periodic_at from public.leader20_batch_control where singleton),updated_at=clock_timestamp()
  where symbol=r->>'id' and epoch_id=b.epoch_id;
  -- DeepSeek is evidence, including WAIT/SKIP/unavailable opinions, never a strategy veto.
  select x into s from jsonb_array_elements(b.packet->'symbols') x where x->>'id'=r->>'id';
  if s is null or s->>'state'<>'READY' or s->>'data_version' is distinct from r->>'version' or s->>'last_ms' is distinct from r->>'last_ms'
   or (select count(*) from jsonb_array_elements(p_result->'results')x where x->>'id'=r->>'id')<>1
   or c->'held' ? (r->>'id') then continue; end if;
  insert into public.leader20_review_events(epoch_id,symbol,generation,requested_at,snapshot_end_ms,snapshot_hash,reason,priority,result)
  values(b.epoch_id,r->>'id',b.generation,clock_timestamp(),(r->>'last_ms')::bigint,r->>'version','TOP10_GPT_REVIEW',1,
   jsonb_build_object('batch_id',b.id,'batch_advice',r)) on conflict do nothing;
  if found then n:=n+1; end if;
 end loop;
 update public.leader20_batches set state='DONE',result=p_result where id=p_id;
 return jsonb_build_object('events',n,'reason',p_result->>'error');
end $$;

-- Fresh capture is obtained immediately before materialization. The old batch
-- snapshot remains advisory evidence; it never supplies the execution reference.
create or replace function public.leader20_materialize_event(p_event_id uuid,p_features jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare e public.leader20_review_events%rowtype;r jsonb;at_ms bigint:=floor(extract(epoch from clock_timestamp())*1000);v jsonb;
begin
 select * into e from public.leader20_review_events where id=p_event_id for update;
 if not (select enabled from public.leader20_batch_control where singleton) then return public.leader20_materialize_event_before_batch(p_event_id,p_features);end if;
 v:=p_features->'execution_snapshot';
 if e.state is distinct from 'REQUESTED' or e.requested_at<clock_timestamp()-interval '120 seconds' then return jsonb_build_object('created',false,'reason','EVENT_NOT_CURRENT');end if;
 if v is null or v->>'complete' is distinct from 'true' or v->>'causal' is distinct from 'true' or (v->>'bucket_count')::integer is distinct from 24
  or (v->>'end_ms')::bigint>at_ms or (v->>'end_ms')::bigint<=at_ms-10000 or (v->>'captured_at_ms')::bigint>at_ms
  or not (v ?& array['end_ms','start_ms','captured_at_ms','trajectory_hash'])
  or jsonb_typeof(v->'end_ms') is distinct from 'number' or jsonb_typeof(v->'captured_at_ms') is distinct from 'number'
  or jsonb_typeof(p_features->'referenceClose') is distinct from 'number'
  or nullif(v->>'trajectory_hash','') is null or (p_features->>'referenceClose')::numeric<=0 then
  return jsonb_build_object('created',false,'reason','FRESH_EXECUTION_CAPTURE_REQUIRED');end if;
 if (public.leader20_batch_capacity()->>'available')::integer<1 then return jsonb_build_object('created',false,'reason','NO_ENTRY_CAPACITY');end if;
 r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);
 if r->>'created'='true' then
  update public.v11_long_regime_signals set features=jsonb_set(features,'{leader20}',features->'leader20'||
   jsonb_build_object('batch_id',e.result->'batch_id','batch_advice',e.result->'batch_advice','snapshot_end_ms',v->'end_ms',
    'execution_snapshot_hash',v->'trajectory_hash')) where id=(r->>'signal_id')::uuid;
  update public.leader20_campaigns set state='WATCHING',execution_state='ENTRY_CANDIDATE',last_candidate_id=(r->>'signal_id')::uuid,
   updated_at=clock_timestamp() where symbol=e.symbol;
 end if;return r;
end $$;

-- Batch advice does not expire a campaign or a newer complete execution packet.
-- The existing current-membership/generation/candidate TTL checks remain binding.
create or replace function public.leader20_entry_authority(p_signal_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare prior jsonb;s public.v11_long_regime_signals%rowtype;b public.leader20_batches%rowtype;
begin
 prior:=public.leader20_entry_authority_before_batch(p_signal_id);
 if prior->>'allowed'<>'true' or not(select enabled from public.leader20_batch_control where singleton) then return prior;end if;
 select * into s from public.v11_long_regime_signals where id=p_signal_id;
 select * into b from public.leader20_batches where id::text=s.features#>>'{leader20,batch_id}';
 if not found or b.state<>'DONE' or b.epoch_id::text is distinct from s.features#>>'{leader20,epoch_id}'
  or b.generation is distinct from (s.features#>>'{leader20,generation}')::bigint
  or not exists(select 1 from jsonb_array_elements(b.packet->'symbols') x where x->>'id'=s.symbol
   and x->>'state'='READY' and x->>'data_version'=s.features#>>'{leader20,batch_advice,version}') then
  return jsonb_build_object('allowed',false,'reason','BATCH_EVIDENCE_INVALID');end if;
 return prior;
end $$;

CREATE OR REPLACE FUNCTION public.leader20_record_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 update public.leader20_campaigns w set last_decision=coalesce(new.record#>>'{result,decision}',outcome),
   state=case when outcome='ENTER' then 'ENTRY_APPROVED' else 'WATCHING' end,
   execution_state=case when outcome='ENTER' then 'APPROVED'
    when new.record#>>'{result,valid}'='true' then 'WAITING' else 'PAUSED' end,
   reason=coalesce(new.record#>>'{result,error}',new.record#>>'{result,decision}',outcome),
   review_due_at=(select next_periodic_at from public.leader20_batch_control where singleton),
   next_review_conditions=answer->'next_review_conditions',updated_at=clock_timestamp()
 where w.symbol=e.symbol and w.epoch_id=e.epoch_id and w.last_requested_at<=e.requested_at and
   exists(select 1 from public.leader20_control c where c.epoch_id=e.epoch_id and c.generation=e.generation);
 return new;
end $function$
;

-- Approved daily provider contract; no money or unknown reservations are erased.
-- Monthly ceilings are derived from 31 daily caps, not a second legacy USD95 veto.
alter table public.gpt_final_review_control drop constraint gpt_final_review_control_daily_cap_usd_check,
 drop constraint gpt_final_review_control_monthly_cap_usd_check,drop constraint gpt_final_review_control_max_calls_per_day_check;
alter table public.gpt_final_review_control add constraint gpt_final_review_control_daily_cap_usd_check
 check(daily_cap_usd>=0 and daily_cap_usd<=50 and daily_cap_usd::text not in ('NaN','Infinity','-Infinity')),
 add constraint gpt_final_review_control_monthly_cap_usd_check check(monthly_cap_usd>=0 and monthly_cap_usd<=1550),
 add constraint gpt_final_review_control_max_calls_per_day_check check(max_calls_per_day>=0 and max_calls_per_day<=10000);
-- Activation is a separate, evidence-backed operation after code parity validation.
notify pgrst,'reload schema';
