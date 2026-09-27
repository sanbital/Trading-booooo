begin;
-- Default privileges had granted service_role full DML on the new table. An approved protection
-- level's history must not be rewritable by the executor's own role, so keep insert+select only.
revoke update,delete,truncate on table public.v11_protection_decisions from service_role;
revoke all on table public.v11_protection_decisions from public,anon,authenticated;
grant insert,select on table public.v11_protection_decisions to service_role;
commit;
