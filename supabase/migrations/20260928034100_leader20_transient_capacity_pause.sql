-- Unreadable/stale account data pauses admission; it is not a confirmed full-to-free transition.
-- Keep the strict capacity gate, existing approvals and immutable periodic clock.
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
 if cap->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
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

create or replace function public.leader20_batch_note_full() returns jsonb language plpgsql set search_path='' as $$
declare c jsonb;
begin
 perform pg_advisory_xact_lock(20260928,52);c:=public.leader20_batch_capacity();
 if c->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return c; end if;
 if (c->>'available')::integer=0 then
  update public.leader20_batch_control set last_slots=0,wake_reason=c->>'reason' where singleton;
  update public.leader20_review_events e set state='RETIRED' where result?'batch_id' and state in ('REQUESTED','REVIEWING')
   and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=e.signal_id and o.intent='OPEN_LONG'
    and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 end if;
 return c;
end $$;

create or replace function public.leader20_batch_start(p_id uuid,p_owner uuid) returns jsonb language plpgsql set search_path='' as $$
declare b public.leader20_batches%rowtype;c jsonb;
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into b from public.leader20_batches where id=p_id and owner=p_owner for update;
 if not found or b.state<>'RESERVED' or b.expires_at<=clock_timestamp() then raise exception 'BATCH_START_CAS'; end if;
 c:=public.leader20_batch_capacity();
 if (c->>'available')::integer<1 then
  update public.leader20_batches set state='SUPERSEDED',result=c where id=p_id;
  if coalesce(c->>'reason','') not like 'ACCOUNT_SNAPSHOT_%' then
   update public.leader20_batch_control set last_slots=0 where singleton;
  end if;
  return jsonb_build_object('allowed',false,'reason',c->>'reason');
 end if;
 update public.leader20_batches set state='DISPATCHED' where id=p_id;
 return jsonb_build_object('allowed',true);
end $$;

create or replace function public.leader20_batch_slot_wake() returns trigger language plpgsql set search_path='' as $$
declare ctl public.leader20_batch_control%rowtype;c jsonb;token text;
begin
 select * into ctl from public.leader20_batch_control where singleton;
 if not ctl.enabled then return null; end if;
 perform pg_advisory_xact_lock(20260928,52);
 select * into ctl from public.leader20_batch_control where singleton for update;
 c:=public.leader20_batch_capacity();
 if c->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return null; end if;
 if (c->>'available')::integer<1 then
  update public.leader20_batch_control set last_slots=0,wake_reason=c->>'reason' where singleton;
  update public.leader20_review_events e set state='RETIRED' where result?'batch_id' and state in ('REQUESTED','REVIEWING')
   and not exists(select 1 from public.v11_long_regime_orders o where o.signal_id=e.signal_id and o.intent='OPEN_LONG'
    and o.state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')
    and o.response_payload->>'v18ExposureFinal' is distinct from 'true');
 elsif ctl.last_slots=0 and (ctl.wake_requested_at is null or ctl.wake_requested_at<clock_timestamp()-interval '10 seconds') then
  select t.token into token from public.edge_internal_tokens t where name='v10-lane-signal-generator';
  if token is null then raise exception 'BATCH_WAKE_TOKEN_MISSING'; end if;
  perform net.http_post(url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
   headers:=jsonb_build_object('Content-Type','application/json','x-v10-lane-token',token),
   body:='{"mode":"leader20-observe"}'::jsonb,timeout_milliseconds:=40000);
  update public.leader20_batch_control set wake_requested_at=clock_timestamp(),wake_reason='SLOT_RELEASED' where singleton;
 end if;
 return null;
exception when others then
 raise log 'LEADER20_BATCH_WAKE_FAILED:%',sqlstate;return null;
end $$;
