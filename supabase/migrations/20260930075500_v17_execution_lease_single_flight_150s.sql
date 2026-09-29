-- Bound the V17/V10 execution single-flight lease to the real executor lifetime.
-- 30s cron cadence is intentionally unchanged. One owner may refresh its own lease;
-- competing invocations fail fast. A dead owner is reclaimable after 150 seconds.
CREATE OR REPLACE FUNCTION public.v17_acquire_execution_lease(p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare n integer;
begin
  if p_owner is null then return false; end if;
  update public.v17_execution_lease
     set owner = p_owner,
         expires_at = clock_timestamp() + interval '150 seconds'
   where singleton = true
     and (expires_at < clock_timestamp() or owner = p_owner);
  get diagnostics n = row_count;
  return n = 1;
end
$function$;

CREATE OR REPLACE FUNCTION public.v17_verify_execution_lease(p_owner uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select exists(
    select 1
      from public.v17_execution_lease
     where singleton = true
       and owner = p_owner
       and expires_at > clock_timestamp() + interval '30 seconds'
  );
$function$;
