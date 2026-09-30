create or replace function public.doa_capture_release(p_worker_id text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare released boolean:=false;
begin
 if p_worker_id is null or p_worker_id !~ '^[a-zA-Z0-9-]{8,80}$' then raise exception 'worker identity required'; end if;
 update doa_capture.control set lease_owner=null,lease_until=null where id=1 and lease_owner=p_worker_id;
 released:=found;
 return jsonb_build_object('enabled',true,'released',released);
end $$;
revoke all on function public.doa_capture_release(text) from public,anon,authenticated;
grant execute on function public.doa_capture_release(text) to service_role;