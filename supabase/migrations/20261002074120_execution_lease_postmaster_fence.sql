-- Expand only. Preserve the 150s TTL and both existing verification reserves.
-- A logged lease survives a database restart; its old process authority must not.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
alter table public.v17_execution_lease
 add column if not exists postmaster_started_at timestamptz,
 add column if not exists fence bigint not null default 0,
 add column if not exists heartbeat_at timestamptz;
-- Bind the currently running generation without invalidating a live pre-migration holder.
update public.v17_execution_lease set postmaster_started_at=pg_postmaster_start_time()
 where postmaster_started_at is null;
create or replace function public.v17_acquire_execution_lease(p_owner uuid)
 returns boolean language plpgsql security definer set search_path='pg_catalog','public' as $fn$
declare n integer;
begin
 if p_owner is null then return false; end if;
 update public.v17_execution_lease
 set fence=case when owner is distinct from p_owner or postmaster_started_at is distinct from pg_postmaster_start_time()
   or expires_at<clock_timestamp() then fence+1 else fence end,
 owner=p_owner,expires_at=clock_timestamp()+interval '150 seconds',
 heartbeat_at=clock_timestamp(),postmaster_started_at=pg_postmaster_start_time()
 where singleton and (expires_at<clock_timestamp() or owner=p_owner
   or postmaster_started_at is distinct from pg_postmaster_start_time());
 get diagnostics n=row_count;return n=1;
end $fn$;
create or replace function public.v17_verify_execution_lease(p_owner uuid)
 returns boolean language sql security definer set search_path='pg_catalog','public' as $fn$
 select exists(select 1 from public.v17_execution_lease where singleton and owner=p_owner
  and postmaster_started_at=pg_postmaster_start_time()
  and expires_at>clock_timestamp()+interval '30 seconds');
$fn$;
create or replace function public.v18_require_lease(p_owner uuid)
 returns void language plpgsql set search_path='pg_catalog','public' as $fn$
declare l public.v17_execution_lease%rowtype;
begin
 select * into l from public.v17_execution_lease where singleton for share;
 if p_owner is null or l.owner is distinct from p_owner
  or l.postmaster_started_at is distinct from pg_postmaster_start_time()
  or l.expires_at<=clock_timestamp()+interval '1 second' then
  raise exception 'V18_EXECUTION_FENCED';
 end if;
end $fn$;
-- Heartbeat never revives expired ownership or a pre-restart process.
create or replace function public.v17_heartbeat_execution_lease(p_owner uuid,p_fence bigint)
 returns boolean language plpgsql security definer set search_path='pg_catalog','public' as $fn$
declare n integer;
begin
 update public.v17_execution_lease set expires_at=clock_timestamp()+interval '150 seconds',heartbeat_at=clock_timestamp()
 where singleton and owner=p_owner and fence=p_fence
  and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '1 second';
 get diagnostics n=row_count;return n=1;
end $fn$;
revoke all on function public.v17_heartbeat_execution_lease(uuid,bigint) from public,anon,authenticated;
grant execute on function public.v17_heartbeat_execution_lease(uuid,bigint) to service_role;
commit;
