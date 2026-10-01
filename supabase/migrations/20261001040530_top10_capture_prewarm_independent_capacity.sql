begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Top10 capture prewarm is market-data collection, not entry authority.
-- Keep it independent from transient account snapshot freshness/capacity so a late
-- account snapshot cannot destroy the next immutable 120s trajectory.
create or replace function public.doa_capture_rpc(p_action text,p_body jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;c public.leader20_control%rowtype;capacity jsonb;
 slot_ms bigint;epoch_slot_ms bigint;at_ms bigint;arm_deadline bigint;
 funded boolean;certain boolean;holding boolean;in_path boolean;armed boolean;
 can_arm boolean;entry_allowed boolean;validity_tail boolean;capture_watch boolean;reason text;
begin
 r:=public.doa_capture_rpc_before_clock(p_action,p_body);
 if p_action<>'watch' or r->>'enabled' is distinct from 'true' or r->>'reason'='LEASE_BUSY' then return r;end if;
 select * into c from public.leader20_control where singleton for update;
 if not c.clock_capture_enabled then return r;end if;

 at_ms:=floor(extract(epoch from clock_timestamp())*1000);
 select (snapshot->>'capture_slot_ms')::bigint into epoch_slot_ms
 from public.leader20_epochs where id=c.epoch_id;
 slot_ms:=floor((at_ms+180000)/600000)*600000;

 capacity:=public.leader20_batch_capacity();
 funded:=coalesce((capacity->>'available')::integer,0)>0;
 certain:=coalesce(capacity->>'certain','false')='true';
 holding:=exists(select 1 from jsonb_array_elements(coalesce(r->'watch','[]')) x where x->'roles' ? 'OPEN_POSITION');

 -- Capture runs from T-180s through T+120s for the current published epoch.
 -- This is intentionally independent of account freshness/capacity.
 capture_watch:=coalesce(epoch_slot_ms=slot_ms and at_ms>=slot_ms-180000 and at_ms<slot_ms+120000,false);

 in_path:=slot_ms is not null and at_ms>=slot_ms-180000 and at_ms<slot_ms+1000;
 arm_deadline:=slot_ms-120000-c.entry_capture_arm_lead_ms;

 -- Since market data is already prewarmed independently, capacity may become certain
 -- any time before T without losing the fixed trajectory.
 can_arm:=in_path and at_ms<slot_ms+1000;

 if certain and not funded then
  if c.entry_capture_slot_ms is not null then
   update public.leader20_control set entry_capture_slot_ms=null where singleton;
   c.entry_capture_slot_ms:=null;
  end if;
 elsif funded and coalesce(can_arm,false) and c.entry_capture_slot_ms is distinct from slot_ms then
  update public.leader20_control set entry_capture_slot_ms=slot_ms where singleton;
  c.entry_capture_slot_ms:=slot_ms;
 end if;

 armed:=coalesce(slot_ms is not null and c.entry_capture_slot_ms=slot_ms,false);
 entry_allowed:=coalesce((funded or not certain) and armed and in_path,false);
 validity_tail:=coalesce((funded or not certain) and armed and slot_ms is not null
  and at_ms>=slot_ms+1000 and at_ms<slot_ms+120000,false);

 reason:=case
  when entry_allowed then 'CAPTURE_WINDOW'
  when certain and not funded then coalesce(capacity->>'reason','NO_ENTRY_CAPACITY')
  when not certain and not armed then 'CAPACITY_UNCERTAIN'
  when slot_ms is null or not in_path then 'CLOCK_OUTSIDE_CAPTURE_WINDOW'
  else 'WAITING_FOR_NEXT_CAPTURE_WINDOW' end;

 return r||jsonb_build_object(
  'entry_window',jsonb_build_object('version','TOP20_CLOCK_CAPTURE_1','slot_ms',slot_ms),
  'entry_capture',jsonb_build_object(
   'funded',funded,'certain',certain,'enabled',entry_allowed,
   'capture_watch',capture_watch,'validity_tail',validity_tail,
   'armed_slot_ms',c.entry_capture_slot_ms,'arm_deadline_ms',arm_deadline,'reason',reason,
   'watch_limit',10,'epoch_slot_ms',epoch_slot_ms,'epoch_published',epoch_slot_ms=slot_ms,
   'available_slots',capacity->'available','available_for_new_entry',capacity->'available_for_new_entry',
   'open_positions',capacity->'open_positions','reserved_slots',capacity->'reserved_slots',
   'available_quote',capacity->'available_quote'),
  'watch',(select coalesce(jsonb_agg(x),'[]'::jsonb)
   from jsonb_array_elements(coalesce(r->'watch','[]'::jsonb)) x
   where x->'roles' ? 'OPEN_POSITION'
    or (capture_watch or funded or holding) and x->'roles' ? 'MARKET_SENSOR'
    or capture_watch and exists(
      select 1 from public.leader20_members m
      where m.epoch_id=c.epoch_id
        and m.symbol=x->>'symbol'
        and m.rank<=10
    )));
end $$;

revoke all on function public.doa_capture_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
