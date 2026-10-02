begin;
set local lock_timeout='2s';set local statement_timeout='10s';
-- Empty, disabled catalog. Populate from the preserved LIVE cron inventory at cutover.
create table public.trading_scheduler_control (
  scheduler_key text primary key,
  enabled boolean not null default false,
  owner uuid,
  fence bigint not null default 0,
  expires_at timestamptz not null default '-infinity',
  heartbeat_at timestamptz,
  last_error_code text,
  recovery_complete boolean not null default false,
  recovered_postmaster_at timestamptz,
  lease_postmaster_at timestamptz
);
create table public.trading_scheduler_jobs (
  scheduler_key text not null references public.trading_scheduler_control(scheduler_key),
  job_key text not null,
  enabled boolean not null default false,
  period_ms integer not null check (period_ms between 1000 and 86400000),
  offset_ms integer not null default 0 check(offset_ms>=0),
  timeout_ms integer not null check (timeout_ms between 100 and 360000),
  recovery_mode text not null check (recovery_mode in ('CURRENT_ONLY','DURABLE_CURSOR')),
  job_kind text not null default 'SIGNAL' check (job_kind in
    ('RECONCILIATION','ATTRIBUTION','ACCOUNTING','PROTECTION_SYNC','MAINTENANCE','SIGNAL','ENTRY','REVIEW','MONITOR','SCAN')),
  requires_recovery boolean not null default true,
  target jsonb not null,
  cursor jsonb not null default '{}',
  last_start timestamptz,
  last_success timestamptz,
  last_duration_ms numeric,
  last_result text,
  failure_count integer not null default 0,
  retry_at timestamptz,
  legacy_cron_jobid bigint,
  check (recovery_mode='CURRENT_ONLY' or job_kind in
    ('RECONCILIATION','ATTRIBUTION','ACCOUNTING','PROTECTION_SYNC','MAINTENANCE')),
  check (target->>'endpoint' not in ('market-v2-signal','market-autotrader','v10-lane-executor','v10-lane-signal-generator')
    or recovery_mode='CURRENT_ONLY'),
  primary key(scheduler_key,job_key)
);
create table public.trading_scheduler_ticks (
  scheduler_key text not null,
  job_key text not null,
  tick bigint not null,
  idempotency_key text not null unique,
  owner uuid not null,
  fence bigint not null,
  state text not null check (state in ('STARTED','ACCEPTED','SUCCEEDED','FAILED','UNKNOWN')),
  started_at timestamptz not null default clock_timestamp(),
  accepted_at timestamptz,
  attempt_count integer not null default 1,
  finished_at timestamptz,
  result text,
  primary key(scheduler_key,job_key,tick),
  foreign key(scheduler_key,job_key) references public.trading_scheduler_jobs(scheduler_key,job_key)
);
create table public.trading_scheduler_cutovers (
  cutover_id text primary key,
  scheduler_key text not null references public.trading_scheduler_control(scheduler_key),
  created_at timestamptz not null default clock_timestamp(),
  phase text not null check (phase in ('PAUSED','EXTERNAL','ROLLED_BACK')),
  cron_backup jsonb not null,
  verified_gateway_commit text not null,
  verified_gateway_health_at timestamptz not null
);
create function public.trading_scheduler_lead(p_scheduler text,p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.trading_scheduler_control%rowtype; t timestamptz:=clock_timestamp();
begin
  update public.trading_scheduler_control set owner=p_owner,fence=fence+1,
    expires_at=t+interval '15 seconds',heartbeat_at=t,recovery_complete=false,lease_postmaster_at=pg_postmaster_start_time()
  where scheduler_key=p_scheduler and enabled and (expires_at<=t or lease_postmaster_at is distinct from pg_postmaster_start_time()) and p_owner is not null returning * into s;
  return case when s.scheduler_key is null then null else to_jsonb(s) end;
end $$;
-- Run only after the disabled Fly image/leader/catalog were externally verified.
-- An exact manifest, transactionally backed-up old jobs and disabled Fly mode are
-- prerequisites. The final enable step is separate and cannot allow dual schedulers.
create function public.trading_scheduler_pause_cron(p_scheduler text,p_cutover text,p_manifest jsonb,
  p_commit text,p_health_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb; job record; backup jsonb:='[]'; s public.trading_scheduler_control%rowtype;
begin
  select * into s from public.trading_scheduler_control where scheduler_key=p_scheduler for update;
  if s.scheduler_key is null or s.enabled or p_health_at is null or p_commit is null or p_manifest is null
    or jsonb_typeof(p_manifest)<>'array' or p_health_at<clock_timestamp()-interval '5 minutes'
    or p_health_at>clock_timestamp() or length(p_commit)<>40 or jsonb_array_length(p_manifest)<1
    then raise exception 'CUTOVER_PRECONDITION';end if;
  if exists(select 1 from public.trading_scheduler_cutovers where cutover_id=p_cutover)
    then raise exception 'CUTOVER_VERSION_ALREADY_USED';end if;
  for item in select * from jsonb_array_elements(p_manifest) loop
    select * into job from cron.job where jobid=(item->>'jobid')::bigint;
    if job.jobid is null or job.jobname is distinct from item->>'jobname'
      or job.schedule is distinct from item->>'schedule'
      or md5(job.command) is distinct from item->>'command_md5' then raise exception 'LIVE_CRON_DRIFT';end if;
    backup:=backup||jsonb_build_array(to_jsonb(job));
  end loop;
  -- Every registered migrated job must have its exact old caller in the checkpoint.
  if exists(select 1 from public.trading_scheduler_jobs where scheduler_key=p_scheduler and enabled
    and legacy_cron_jobid is not null and not exists(select 1 from jsonb_array_elements(backup) b
      where (b->>'jobid')::bigint=legacy_cron_jobid)) then raise exception 'CRON_MANIFEST_INCOMPLETE';end if;
  insert into public.trading_scheduler_cutovers values(p_cutover,p_scheduler,clock_timestamp(),'PAUSED',backup,p_commit,p_health_at);
  for item in select * from jsonb_array_elements(backup) loop
    perform cron.alter_job((item->>'jobid')::bigint,active:=false);
  end loop;
  return jsonb_build_object('phase','PAUSED','job_count',jsonb_array_length(backup));
end $$;
create function public.trading_scheduler_activate(p_scheduler text,p_cutover text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.trading_scheduler_cutovers%rowtype;
begin
  select * into c from public.trading_scheduler_cutovers where cutover_id=p_cutover and scheduler_key=p_scheduler for update;
  if c.phase is distinct from 'PAUSED' then raise exception 'CUTOVER_NOT_PAUSED';end if;
  if exists(select 1 from cron.job where active and jobid in
    (select (b->>'jobid')::bigint from jsonb_array_elements(c.cron_backup) b)) then raise exception 'DUAL_SCHEDULER_BLOCKED';end if;
  if exists(select 1 from cron.job_run_details where status in ('starting','running') and jobid in
    (select (b->>'jobid')::bigint from jsonb_array_elements(c.cron_backup) b)) then raise exception 'OLD_CRON_STILL_RUNNING';end if;
  update public.trading_scheduler_control set enabled=true,owner=null,expires_at='-infinity',recovery_complete=false
    where scheduler_key=p_scheduler;
  update public.trading_scheduler_cutovers set phase='EXTERNAL' where cutover_id=p_cutover;
  return true;
end $$;
create function public.trading_scheduler_rollback(p_scheduler text,p_cutover text,p_fly_disabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.trading_scheduler_cutovers%rowtype; item jsonb;
begin
  -- Caller must have verified Fly disabled FIRST. Fence rejects any old in-flight ticks.
  if p_fly_disabled is distinct from true then raise exception 'STOP_FLY_BEFORE_CRON_RESTORE';end if;
  select * into c from public.trading_scheduler_cutovers where cutover_id=p_cutover and scheduler_key=p_scheduler for update;
  if c.phase not in ('PAUSED','EXTERNAL') then raise exception 'CUTOVER_ROLLBACK_STATE';end if;
  update public.trading_scheduler_control set enabled=false,owner=null,fence=fence+1,
    expires_at='-infinity',recovery_complete=false where scheduler_key=p_scheduler;
  for item in select * from jsonb_array_elements(c.cron_backup) loop
    if not exists(select 1 from cron.job where jobid=(item->>'jobid')::bigint
      and jobname=item->>'jobname' and schedule=item->>'schedule' and md5(command)=md5(item->>'command'))
      then raise exception 'ROLLBACK_CRON_DRIFT';end if;
    perform cron.alter_job((item->>'jobid')::bigint,active:=(item->>'active')::boolean);
  end loop;
  update public.trading_scheduler_cutovers set phase='ROLLED_BACK' where cutover_id=p_cutover;
  return true;
end $$;
create function public.trading_scheduler_heartbeat(p_scheduler text,p_owner uuid,p_fence bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer; t timestamptz:=clock_timestamp();
begin
  update public.trading_scheduler_control set heartbeat_at=t,expires_at=t+interval '15 seconds'
    where scheduler_key=p_scheduler and enabled and owner=p_owner and fence=p_fence and expires_at>t and lease_postmaster_at=pg_postmaster_start_time();
  get diagnostics n=row_count;return n=1;
end $$;
create function public.trading_scheduler_claim(p_scheduler text,p_owner uuid,p_fence bigint,p_job text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.trading_scheduler_control%rowtype; j public.trading_scheduler_jobs%rowtype;
  t timestamptz:=clock_timestamp(); tick_id bigint; n integer;
begin
  select * into s from public.trading_scheduler_control where scheduler_key=p_scheduler for update;
  if s.enabled is distinct from true or s.owner is distinct from p_owner or s.fence is distinct from p_fence
    or s.expires_at<=t or s.lease_postmaster_at is distinct from pg_postmaster_start_time() then raise exception 'SCHEDULER_FENCED'; end if;
  select * into j from public.trading_scheduler_jobs where scheduler_key=p_scheduler and job_key=p_job for update;
  if j.enabled is distinct from true or j.retry_at>t then return null; end if;
  if j.requires_recovery and (not s.recovery_complete or s.recovered_postmaster_at is distinct from pg_postmaster_start_time())
    then return null; end if;
  if j.target->>'guard'='LEADER20_OBSERVE' and not exists(select 1 from public.leader20_control where singleton and observation_enabled and clock_capture_enabled and (mod(floor(extract(epoch from t))::bigint,600)<120 or mod(floor(extract(epoch from t))::bigint,600) between 420 and 479)) then return null;end if;
  if j.target->>'guard'='OUTBOX_WAKE' and not public.leader20_claim_execution_wake('SWEEPER') then return null;end if;
  -- Single-flight across machines. A timed-out target remains UNKNOWN; no past tick
  -- is replayed. Its order effects belong to the independently reconciled outbox.
  if exists(select 1 from public.trading_scheduler_ticks where scheduler_key=p_scheduler and job_key=p_job
    and state in ('STARTED','ACCEPTED') and started_at+j.timeout_ms*interval '1 millisecond'>t) then return null; end if;
  if j.offset_ms>0 and abs(mod(extract(epoch from t)*1000-j.offset_ms,j.period_ms))>=10000 and j.retry_at is null then return null;end if;
  update public.trading_scheduler_ticks set state='UNKNOWN',result='PRIOR_TICK_TIMEOUT_RECONCILE_ONLY',finished_at=t
   where scheduler_key=p_scheduler and job_key=p_job and state in ('STARTED','ACCEPTED') and started_at+j.timeout_ms*interval '1 millisecond'<=t;
  tick_id:=floor((extract(epoch from t)*1000-j.offset_ms)/j.period_ms)::bigint;
  insert into public.trading_scheduler_ticks(scheduler_key,job_key,tick,idempotency_key,owner,fence,state)
    values(p_scheduler,p_job,tick_id,p_scheduler||':'||p_job||':'||tick_id,p_owner,p_fence,'STARTED') on conflict(scheduler_key,job_key,tick) do update
    set owner=excluded.owner,fence=excluded.fence,state='STARTED',started_at=t,finished_at=null,attempt_count=public.trading_scheduler_ticks.attempt_count+1
    where public.trading_scheduler_ticks.state in ('FAILED','UNKNOWN') and public.trading_scheduler_ticks.accepted_at is null
     and j.retry_at is not null and j.retry_at<=t;
  get diagnostics n=row_count;if n=0 then return null;end if;
  update public.trading_scheduler_jobs set last_start=t,last_result='STARTED' where scheduler_key=p_scheduler and job_key=p_job;
  return to_jsonb(j)||jsonb_build_object('tick',tick_id,'idempotency_key',p_scheduler||':'||p_job||':'||tick_id,
    'owner',p_owner,'fence',p_fence,'started_at',t);
end $$;
create function public.trading_scheduler_accept(p_scheduler text,p_job text,p_tick bigint,p_owner uuid,p_fence bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform 1 from public.trading_scheduler_control where scheduler_key=p_scheduler and enabled and owner=p_owner
    and fence=p_fence and expires_at>clock_timestamp() and lease_postmaster_at=pg_postmaster_start_time() for update;
  if not found then return false;end if;
  update public.trading_scheduler_ticks set state='ACCEPTED',accepted_at=clock_timestamp() where scheduler_key=p_scheduler and job_key=p_job
    and tick=p_tick and owner=p_owner and fence=p_fence and state='STARTED' and accepted_at is null;
  get diagnostics n=row_count;return n=1;
end $$;
create function public.trading_scheduler_finish(p_scheduler text,p_job text,p_tick bigint,p_owner uuid,p_fence bigint,
  p_state text,p_result text,p_retry_ms integer default 0,p_permanent boolean default false,p_cursor jsonb default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer; t timestamptz:=clock_timestamp(); start_time timestamptz;
begin
  perform 1 from public.trading_scheduler_control where scheduler_key=p_scheduler and enabled and owner=p_owner
    and fence=p_fence and expires_at>t and lease_postmaster_at=pg_postmaster_start_time() for update;
  if not found then return false;end if;
  if p_state not in ('SUCCEEDED','FAILED','UNKNOWN') or p_retry_ms not between 0 and 60000
    then raise exception 'SCHEDULER_FINISH_INPUT';end if;
  update public.trading_scheduler_ticks set state=p_state,result=p_result,finished_at=t
    where scheduler_key=p_scheduler and job_key=p_job and tick=p_tick and owner=p_owner and fence=p_fence
      and state in ('STARTED','ACCEPTED') returning started_at into start_time;
  get diagnostics n=row_count;if n=0 then return false;end if;
  update public.trading_scheduler_jobs set enabled=enabled and not p_permanent,
    last_result=p_result,last_duration_ms=extract(epoch from t-start_time)*1000,
    last_success=case when p_state='SUCCEEDED' then t else last_success end,
    failure_count=case when p_state='SUCCEEDED' then 0 else failure_count+1 end,
    retry_at=case when p_retry_ms>0 then t+p_retry_ms*interval '1 millisecond' else null end,
    cursor=case when p_state='SUCCEEDED' and recovery_mode='DURABLE_CURSOR' and p_cursor is not null then p_cursor else cursor end
    where scheduler_key=p_scheduler and job_key=p_job;
  return true;
end $$;
create function public.trading_scheduler_recovered(p_scheduler text,p_owner uuid,p_fence bigint,p_account text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not exists(select 1 from public.v17_execution_infrastructure_control where singleton and short_writer_enabled
    and recovered_postmaster_at=pg_postmaster_start_time() and p_account='binance_futures:futures') then return false;end if;
  update public.trading_scheduler_control set recovery_complete=true,recovered_postmaster_at=pg_postmaster_start_time()
    where scheduler_key=p_scheduler and owner=p_owner and fence=p_fence and enabled and expires_at>clock_timestamp() and lease_postmaster_at=pg_postmaster_start_time();
  get diagnostics n=row_count;return n=1;
end $$;
create function public.trading_scheduler_admit(p_endpoint text,p_body jsonb,p_envelope jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare j public.trading_scheduler_jobs%rowtype; accepted boolean;
begin
  if p_envelope is null then
    if exists(select 1 from public.trading_scheduler_jobs catalog join public.trading_scheduler_control s using(scheduler_key)
      where catalog.enabled and s.enabled and catalog.target->>'endpoint'=p_endpoint
        and catalog.target->'body'=p_body) then return 'EXTERNAL_SCHEDULER_REQUIRED'; end if;
    return 'LEGACY_ALLOWED';
  end if;
  select * into j from public.trading_scheduler_jobs where scheduler_key=p_envelope->>'key'
    and job_key=p_envelope->>'job' and enabled;
  if j.job_key is null or j.target->>'endpoint' is distinct from p_endpoint
    or j.target->'body' is distinct from p_body then return 'TICK_TARGET_MISMATCH'; end if;
  if p_envelope->>'idempotency_key' is distinct from
    (j.scheduler_key||':'||j.job_key||':'||(p_envelope->>'tick')) then return 'TICK_IDENTITY_MISMATCH';end if;
  if j.recovery_mode='CURRENT_ONLY' and (p_envelope->>'tick')::bigint<
    floor((extract(epoch from clock_timestamp())*1000-j.offset_ms)/j.period_ms)::bigint then return 'STALE_TICK_BLOCKED';end if;
  accepted:=public.trading_scheduler_accept(j.scheduler_key,j.job_key,(p_envelope->>'tick')::bigint,
    (p_envelope->>'owner')::uuid,(p_envelope->>'fence')::bigint);
  return case when accepted then 'ACCEPTED' else 'DUPLICATE_OR_FENCED' end;
end $$;
do $$ declare t text; f record; begin
  foreach t in array array['trading_scheduler_control','trading_scheduler_jobs','trading_scheduler_ticks','trading_scheduler_cutovers'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('trading_scheduler_lead','trading_scheduler_heartbeat',
      'trading_scheduler_claim','trading_scheduler_accept','trading_scheduler_finish','trading_scheduler_recovered',
      'trading_scheduler_admit','trading_scheduler_pause_cron','trading_scheduler_activate','trading_scheduler_rollback') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

commit;
