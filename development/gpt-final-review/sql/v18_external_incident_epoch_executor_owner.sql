-- User-approved (2026-09-23). The executor's own cycle error (last_error only;
-- circuit_open and circuit_reason unchanged) written by the CURRENT, unexpired lease
-- owner is not an external writer: it is still recorded in last_error, but it no
-- longer opens a non-recoverable MANUAL_REVIEW_REQUIRED epoch.
-- Unchanged behaviour: any writer without the lease-owner header, a non-owner or
-- expired owner, any circuit opening and any circuit_reason change still escalate.
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
CREATE OR REPLACE FUNCTION public.v18_external_incident_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog','public' AS $function$
declare owner_text text; lease_owner uuid; lease_expires timestamptz; own_error boolean:=false;
begin
 if new.circuit_open and (not old.circuit_open or new.circuit_reason is distinct from old.circuit_reason or new.last_error is distinct from old.last_error)
    and new.incident_id is not distinct from old.incident_id and new.incident_generation=old.incident_generation then
   if old.circuit_open and new.circuit_reason is not distinct from old.circuit_reason then
     begin
       owner_text:=nullif(current_setting('request.headers',true),'')::jsonb->>'x-v18-execution-owner';
     exception when others then owner_text:=null; end;
     if owner_text ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
       select owner,expires_at into lease_owner,lease_expires from public.v17_execution_lease where singleton;
       own_error:=coalesce(lease_owner=owner_text::uuid and lease_expires>clock_timestamp(),false);
     end if;
   end if;
   if own_error then return new; end if;
   new.incident_id:=gen_random_uuid();new.incident_generation:=old.incident_generation+1;
   new.incident_kind:='MANUAL_REVIEW_REQUIRED';new.incident_opened_at:=clock_timestamp();new.incident_resolved_at:=null;
   insert into public.v18_ops_incidents(id,generation,kind,reason,evidence)
     values(new.incident_id,new.incident_generation,new.incident_kind,coalesce(new.circuit_reason,new.last_error,'EXTERNAL_WRITER'),jsonb_build_object('source','PRE_EXISTING_WRITER'));
 end if;
 return new;
end $function$;
