-- Exactly one paid full Top10 batch per fixed UTC ten-minute slot.
-- Event/slot wakes still update observation state, but cannot buy another full batch.
-- Unreadable/stale account data pauses admission; it is not a confirmed full-to-free transition.
-- Keep the strict capacity gate, existing approvals and immutable periodic clock.
create or replace function public.leader20_batch_claim(p_packet jsonb,p_evidence_key text,p_strong_change boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.leader20_batch_control%rowtype;l public.leader20_control%rowtype;cap jsonb;b public.leader20_batches%rowtype;
 reason text;at_time timestamptz:=clock_timestamp(); slot_at timestamptz:=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600);
begin
 perform pg_advisory_xact_lock(20260928,52);
 select * into c from public.leader20_batch_control where singleton for update;
 if not c.enabled then return jsonb_build_object('created',false,'reason','BATCH_DISABLED'); end if;
 select * into l from public.leader20_control where singleton;
 cap:=public.leader20_batch_capacity();
 if cap->>'reason' like 'ACCOUNT_SNAPSHOT_%' then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 update public.leader20_batch_control set last_slots=(cap->>'available')::integer where singleton;
 if (cap->>'available')::integer=0 then return jsonb_build_object('created',false,'reason',cap->>'reason'); end if;
 if l.epoch_id::text is distinct from p_packet->>'epoch_id' or l.generation is distinct from (p_packet->>'generation')::bigint
 or not l.observation_enabled or l.active_strategy<>'LEADER20_DYNAMIC_1' then raise exception 'BATCH_GENERATION'; end if;
 if p_packet->>'version' is distinct from 'TOP10_DEEPSEEK_BATCH_3' then raise exception 'BATCH_LIVE_PROTOCOL_REQUIRED'; end if;
 if jsonb_array_length(p_packet->'symbols')<>10 or
 (select count(distinct x->>'id') from jsonb_array_elements(p_packet->'symbols')x)<>10 or
 exists(select 1 from jsonb_array_elements(p_packet->'symbols')x where not exists(
  select 1 from public.leader20_members where epoch_id=l.epoch_id and rank<=10 and symbol=x->>'id')) then raise exception 'BATCH_MEMBERSHIP'; end if;
 if (p_packet->>'as_of_ms')::numeric<extract(epoch from at_time)*1000-10000 or
  (p_packet->>'as_of_ms')::numeric>extract(epoch from at_time)*1000 then raise exception 'BATCH_STALE'; end if;
 reason:=case when c.last_periodic_slot is null or c.last_periodic_slot<slot_at then 'TEN_MINUTE' end;
 if reason is null then return jsonb_build_object('created',false,'reason','NOT_DUE'); end if;
 if exists(select 1 from public.leader20_batches where state in ('RESERVED','DISPATCHED') and expires_at>at_time) then
  return jsonb_build_object('created',false,'reason','BATCH_IN_FLIGHT'); end if;
 update public.leader20_batches set state='UNKNOWN' where state in ('RESERVED','DISPATCHED') and expires_at<=at_time;
 insert into public.leader20_batches(epoch_id,generation,data_version,state,reason,packet,periodic_slot)
 values(l.epoch_id,l.generation,p_packet->>'batch_hash','RESERVED',reason,p_packet,slot_at)
 on conflict(data_version) do nothing returning * into b;
 if b.id is null then return jsonb_build_object('created',false,'reason','DUPLICATE_CAPTURE'); end if;
 update public.leader20_batch_control set last_requested_at=at_time,last_evidence_key=p_evidence_key,generation=generation+1,wake_reason=reason,
  last_periodic_slot=slot_at,
  next_periodic_at=slot_at+interval '10 minutes' where singleton;
 return jsonb_build_object('created',true,'row',to_jsonb(b),'capacity',cap);
end $$;


revoke all on function public.leader20_batch_claim(jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.leader20_batch_claim(jsonb,text,boolean) to service_role;
