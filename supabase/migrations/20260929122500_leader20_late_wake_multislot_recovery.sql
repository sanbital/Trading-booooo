-- 2026-09-29 multi-slot late wake recovery.
-- Keep the immutable slot authority at T+120s. The historical decision_reserve_ms=80000
-- made leader20_batch_claim refuse every wake after T+40s, while production cron/Edge
-- jitter has repeatedly delivered otherwise-funded slots at T+52..59s. The runtime now
-- requires a hard 55s remaining budget; mirror that bound here so the SQL claim cannot
-- veto a batch the runtime safely admitted.
--
-- This changes admission timing only. It does not alter sizing, leverage, max slots,
-- model authority, account-capacity checks, capture binding, or the T+120s expiry.

CREATE OR REPLACE FUNCTION public.leader20_batch_claim(p_packet jsonb, p_evidence_key text, p_strong_change boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c public.leader20_batch_control%rowtype;l public.leader20_control%rowtype;cap jsonb;b public.leader20_batches%rowtype;
 reason text;at_time timestamptz:=clock_timestamp(); slot_at timestamptz:=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600);
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into c from public.leader20_batch_control where singleton for update;
 if not c.enabled then return jsonb_build_object('created',false,'reason','BATCH_DISABLED'); end if;
 select * into l from public.leader20_control where singleton;
 if not l.clock_capture_enabled then return public.leader20_batch_claim_before_clock(p_packet,p_evidence_key,p_strong_change);end if;
 
 -- Refresh wall time after acquiring the existing cross-request lock.
 at_time:=clock_timestamp();
 if at_time>=slot_at+interval '120 seconds' then return jsonb_build_object('created',false,'reason','DECISION_WINDOW_EXPIRED');end if;
 if at_time>=slot_at+interval '120 seconds'-least(c.decision_reserve_ms,55000)*interval '1 millisecond' then
  return jsonb_build_object('created',false,'reason','DECISION_WINDOW_INSUFFICIENT');end if;
 if c.last_periodic_slot>=slot_at or exists(select 1 from public.leader20_batches
  where periodic_slot=slot_at and packet->>'version'='TOP20_DEEPSEEK_BATCH_1') then
  return jsonb_build_object('created',false,'reason','NOT_DUE');end if;
 
 cap:=public.leader20_batch_capacity();
 if cap->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 update public.leader20_batch_control set last_slots=(cap->>'available')::integer where singleton;
 if (cap->>'available')::integer=0 then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 if l.epoch_id::text is distinct from p_packet->>'epoch_id' or l.generation is distinct from (p_packet->>'generation')::bigint
 or not l.observation_enabled or l.active_strategy<>'LEADER20_DYNAMIC_1' then raise exception 'BATCH_GENERATION'; end if;
 if p_packet->>'version' is distinct from 'TOP20_DEEPSEEK_BATCH_1' then raise exception 'BATCH_LIVE_PROTOCOL_REQUIRED'; end if;
 if jsonb_array_length(p_packet->'symbols')<>20 or
 (select count(distinct x->>'id') from jsonb_array_elements(p_packet->'symbols')x)<>20 or
 exists(select 1 from jsonb_array_elements(p_packet->'symbols')x where not exists(
  select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=20 and symbol=x->>'id')) then raise exception 'BATCH_MEMBERSHIP'; end if;
 if (p_packet->>'as_of_ms')::numeric<extract(epoch from at_time)*1000-10000 or
  (p_packet->>'as_of_ms')::numeric>extract(epoch from at_time)*1000 then raise exception 'BATCH_STALE'; end if;
 if p_packet#>>'{entry_window,version}' is distinct from 'TOP20_CLOCK_CAPTURE_1' or
  (p_packet#>>'{entry_window,slot_ms}')::bigint is distinct from floor(extract(epoch from slot_at)*1000)::bigint or
  not exists(select 1 from public.leader20_epochs where id=l.epoch_id and (snapshot->>'capture_slot_ms')::bigint=(p_packet#>>'{entry_window,slot_ms}')::bigint)
 then raise exception 'CLOCK_BATCH_WINDOW';end if;
 if not exists(select 1 from jsonb_array_elements(p_packet->'symbols') x where x->>'state'='READY') then
  return jsonb_build_object('created',false,'reason','CLOCK_CAPTURE_NOT_READY');end if;
 if exists(select 1 from jsonb_array_elements(p_packet->'symbols') x where x->>'state'='READY' and (
  x->'entry_window' is distinct from public.doa_context_for_role_v1(x->>'id',at_time,'TRADE_CANDIDATE',null)->'entry_window'))
 then raise exception 'CLOCK_BATCH_CAPTURE_BINDING';end if;
 reason:=case when c.last_periodic_slot is null or c.last_periodic_slot<slot_at then 'TEN_MINUTE' end;
 if reason is null then return jsonb_build_object('created',false,'reason','NOT_DUE'); end if;
 if exists(select 1 from public.leader20_batches where state in ('RESERVED','DISPATCHED') and expires_at>at_time) then
  return jsonb_build_object('created',false,'reason','BATCH_IN_FLIGHT'); end if;
 update public.leader20_batches set state='UNKNOWN' where state in ('RESERVED','DISPATCHED') and expires_at<=at_time;
 if clock_timestamp()>=slot_at+interval '120 seconds'-least(c.decision_reserve_ms,55000)*interval '1 millisecond' then return jsonb_build_object('created',false,'reason','DECISION_WINDOW_INSUFFICIENT');end if;
 insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot,expires_at)
 values(l.epoch_id,l.generation,p_packet->>'batch_hash','RESERVED',reason,p_packet,slot_at,slot_at+interval '120 seconds')
 on conflict do nothing returning * into b;
 if b.id is null then return jsonb_build_object('created',false,'reason','DUPLICATE_CAPTURE'); end if;
 update public.leader20_batch_control set last_requested_at=at_time,last_evidence_key=p_evidence_key,generation=generation+1,wake_reason=reason,
  last_periodic_slot=slot_at,
  next_periodic_at=slot_at+interval '10 minutes' where singleton;
 return jsonb_build_object('created',true,'row',to_jsonb(b),'capacity',cap);
end $function$


comment on function public.leader20_batch_claim(jsonb,text,boolean) is
'Leader20 clock batch claim. T+120s remains immutable; late wakes may claim only while >=55s remain.';
