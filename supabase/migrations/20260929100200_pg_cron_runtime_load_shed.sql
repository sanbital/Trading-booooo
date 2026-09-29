-- Emergency runtime load shedding after the 2026-09-29 database-origin outage.
--
-- Evidence immediately before Postgres stopped emitting logs:
--   * 24-29 cron starts/minute across the preceding 20 minutes.
--   * 14 jobs launched within 42ms at 23:50:00Z.
--   * missed_opportunity_track(30) occupied a backend for 28.7s.
--   * leader20_clock_execution_expire then hit pg_cron's job startup timeout.
--
-- Preserve the production observer/order path. Shed only analysis work that is safe to defer
-- and reduce telemetry-only expiry polling from two 10-second jobs to one 1-minute job.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create or replace function public.leader20_clock_telemetry_maintain()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.leader20_clock_expire();
  perform public.leader20_clock_execution_expire();
end
$function$;

revoke all on function public.leader20_clock_telemetry_maintain()
  from public, anon, authenticated;
grant execute on function public.leader20_clock_telemetry_maintain()
  to service_role;

do $load_shed$
declare
  j record;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  -- These jobs reconstruct research/audit outcomes. They do no ordering, position protection,
  -- account sizing or admission. Their implementation performs synchronous Binance HTTP calls
  -- from inside Postgres and can occupy a backend for tens of seconds, so keep them OFF until
  -- the HTTP portion is moved outside Postgres.
  for j in
    select jobid
    from cron.job
    where active
      and (
        command ~* 'missed_opportunity_track[[:space:]]*\\('
        or command ~* 'missed_opportunity_track_lane[[:space:]]*\\('
      )
  loop
    perform cron.alter_job(j.jobid, active := false);
  end loop;

  -- The old 10-second jobs update telemetry rows only. Disable both and replace them with a
  -- single bounded maintenance tick; this removes roughly 11 cron starts/minute.
  for j in
    select jobid
    from cron.job
    where active
      and jobname in (
        'leader20-clock-telemetry-expiry',
        'leader20-clock-execution-expiry'
      )
  loop
    perform cron.alter_job(j.jobid, active := false);
  end loop;

  perform cron.schedule(
    'leader20-clock-telemetry-maintenance-1m',
    '* * * * *',
    'select public.leader20_clock_telemetry_maintain();'
  );

  -- Two order-free replay workers were created for a finite pilot. Once the pilot is fully
  -- DONE, stop waking Postgres every 30s. If any replay work remains they stay untouched.
  if to_regclass('public.fd1_replay_jobs') is not null
     and not exists (
       select 1 from public.fd1_replay_jobs
       where state is distinct from 'DONE'
     )
  then
    for j in
      select jobid
      from cron.job
      where active and jobname in ('fd1-replay-30s','fd1-replay-30s-b')
    loop
      perform cron.alter_job(j.jobid, active := false);
    end loop;
  end if;
end
$load_shed$;

commit;
