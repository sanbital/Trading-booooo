begin;
set local lock_timeout='2s';

-- A funded preparation admits one complete clock window. Losing entry capacity
-- clears that admission; a mid-window balance recovery cannot restart half a path.
alter table public.leader20_control add column entry_capture_slot_ms bigint;

create or replace function public.doa_capture_rpc(p_action text,p_body jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare r jsonb;c public.leader20_control%rowtype;capacity jsonb;
 slot_ms bigint;at_ms bigint;funded boolean;entry_allowed boolean;
begin
 r:=public.doa_capture_rpc_before_clock(p_action,p_body);
 if p_action<>'watch' or r->>'enabled' is distinct from 'true' or r->>'reason'='LEASE_BUSY' then return r;end if;
 select * into c from public.leader20_control where singleton for update;
 if not c.clock_capture_enabled then return r;end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000);
 select (snapshot->>'capture_slot_ms')::bigint into slot_ms from public.leader20_epochs where id=c.epoch_id;
 capacity:=public.leader20_batch_capacity();
 funded:=coalesce((capacity->>'available')::integer,0)>0;
 if not funded then
  if c.entry_capture_slot_ms is not null then
   update public.leader20_control set entry_capture_slot_ms=null where singleton;
   c.entry_capture_slot_ms:=null;
  end if;
 elsif at_ms>=slot_ms-180000 and at_ms<slot_ms-120000 then
  if c.entry_capture_slot_ms is distinct from slot_ms then
   update public.leader20_control set entry_capture_slot_ms=slot_ms where singleton;
   c.entry_capture_slot_ms:=slot_ms;
  end if;
 end if;
 entry_allowed:=funded and c.entry_capture_slot_ms=slot_ms
  and at_ms>=slot_ms-180000 and at_ms<slot_ms+1000;
 return r||jsonb_build_object(
  'entry_window',jsonb_build_object('version','TOP20_CLOCK_CAPTURE_1','slot_ms',slot_ms),
  'entry_capture',jsonb_build_object('funded',funded,'enabled',coalesce(entry_allowed,false),
   'reason',case when not funded then coalesce(capacity->>'reason','NO_ENTRY_CAPACITY')
    when at_ms<slot_ms-180000 or at_ms>=slot_ms+1000 then 'CLOCK_OUTSIDE_CAPTURE_WINDOW'
    when c.entry_capture_slot_ms is distinct from slot_ms or slot_ms is null then 'WAITING_FOR_NEXT_CAPTURE_WINDOW'
    else 'CAPTURE_WINDOW' end,
   'available_slots',capacity->'available','available_quote',capacity->'available_quote'),
  'watch',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(r->'watch') x
   where x->'roles' ? 'OPEN_POSITION'
    or funded and x->'roles' ? 'MARKET_SENSOR'
    or coalesce(entry_allowed,false)));
end $$;

revoke all on function public.doa_capture_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.doa_capture_rpc(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
