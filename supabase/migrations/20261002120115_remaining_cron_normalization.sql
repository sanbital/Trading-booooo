begin;set local lock_timeout='2s';set local statement_timeout='10s';
create table public.trading_cron_normalization_checkpoints(version text primary key,applied_at timestamptz,cron_backup jsonb,gateway_commit text);
alter table public.trading_cron_normalization_checkpoints enable row level security;
revoke all on public.trading_cron_normalization_checkpoints from public,anon,authenticated;
grant select on public.trading_cron_normalization_checkpoints to service_role;
insert into public.trading_scheduler_jobs(scheduler_key,job_key,enabled,period_ms,timeout_ms,recovery_mode,job_kind,requires_recovery,target)
values
('trading-production','gpt-review-expire',false,60000,2500,'DURABLE_CURSOR','MAINTENANCE',false,'{"rpc":"gpt_final_review_expire","limit":30}'),
('trading-production','bounded-clock-telemetry',false,60000,2500,'DURABLE_CURSOR','MAINTENANCE',false,'{"rpc":"leader20_clock_telemetry_maintain"}'),
('trading-production','entry-reservation-maintenance',false,60000,2500,'DURABLE_CURSOR','MAINTENANCE',false,'{"rpc":"leader20_entry_reservation_sweep"}');
create function public.trading_normalize_remaining_cron(p_gateway_commit text,p_verified_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $fn$
declare b jsonb:= $manifest$[{"jobid":111,"jobname":"gpt-final-review-expire","schedule":"* * * * *","command":"select public.gpt_final_review_expire(30)","active":true},{"jobid":147,"jobname":"leader20-clock-telemetry-maintenance-1m","schedule":"* * * * *","command":"select public.leader20_clock_telemetry_maintain();","active":true},{"jobid":152,"jobname":"leader20-entry-reservation-sweep","schedule":"* * * * *","command":"select public.leader20_entry_reservation_sweep();","active":true},{"jobid":49,"jobname":"v11-long-regime-generator","schedule":"*/5 * * * *","command":"\n    select net.http_post(\n      url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',\n      headers := jsonb_build_object(\n        'content-type','application/json',\n        'x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')\n      ),\n      body := '{}'::jsonb,\n      timeout_milliseconds := 120000\n    );\n  ","active":true},{"jobid":1,"jobname":"trading-account-raw-retention","schedule":"*/5 * * * *","command":"select trading_internal.prune_account_snapshots(250);","active":true},{"jobid":7,"jobname":"entry-admission-stall-detector","schedule":"*/5 * * * *","command":"select public.detect_entry_admission_stall();","active":true},{"jobid":88,"jobname":"fd1-final-recheck-track-5m","schedule":"*/5 * * * *","command":" select public.fd1_final_recheck_track(20); ","active":true},{"jobid":106,"jobname":"self-evolution-research-minute","schedule":"*/5 * * * *","command":"select evolution_private.dispatch();","active":true},{"jobid":3,"jobname":"trading-account-hourly-retention","schedule":"17 3 * * *","command":"select trading_internal.prune_account_hourly(1000);","active":true},{"jobid":101,"jobname":"doa-capture-retention","schedule":"17 3 * * *","command":"delete from doa_capture.observations where ctid in(select ctid from doa_capture.observations where at<now()-interval '14 days' order by at limit 10000);delete from doa_capture.batches where id in(select id from doa_capture.batches where created_at<now()-interval '2 days' order by created_at limit 10000);delete from doa_capture.candidates where signal_id in(select signal_id from doa_capture.candidates where candidate_at<now()-interval '90 days' limit 2000);","active":true}]$manifest$::jsonb;item jsonb;
begin
 if length(p_gateway_commit)<>40 or p_verified_at<clock_timestamp()-interval '5 minutes' or p_verified_at>clock_timestamp() or
  not exists(select 1 from public.trading_scheduler_control where scheduler_key='trading-production' and enabled and recovery_complete and recovered_postmaster_at=pg_postmaster_start_time()) then raise exception 'CRON_NORMALIZATION_PRECONDITION';end if;
 if exists(select 1 from public.trading_cron_normalization_checkpoints where version='CRON_BOUNDED_1') then raise exception 'CRON_NORMALIZATION_ALREADY_APPLIED';end if;
 for item in select * from jsonb_array_elements(b) loop
  if not exists(select 1 from cron.job where jobid=(item->>'jobid')::bigint and jobname=item->>'jobname' and schedule=item->>'schedule' and command=item->>'command' and active=(item->>'active')::boolean) then raise exception 'CRON_NORMALIZATION_DRIFT';end if;
 end loop;
 -- Prevent overlapping old DB maintenance with its new external registered task.
 if exists(select 1 from cron.job_run_details where jobid in (111,147,152) and status in ('running','starting')) then raise exception 'CRON_MAINTENANCE_STILL_RUNNING';end if;
 insert into public.trading_cron_normalization_checkpoints values('CRON_BOUNDED_1',clock_timestamp(),b,p_gateway_commit);
 perform cron.alter_job(111,active:=false);perform cron.alter_job(147,active:=false);perform cron.alter_job(152,active:=false);
 -- Proven no-op fallback: live generator returns LEADER20_OBSERVER_OWNS_SCHEDULE.
 perform cron.alter_job(49,active:=false);
 perform cron.alter_job(1,schedule:='1-59/5 * * * *');
 perform cron.alter_job(7,schedule:='1-59/5 * * * *');
 perform cron.alter_job(88,schedule:='2-59/5 * * * *');
 perform cron.alter_job(106,schedule:='4-59/5 * * * *');
 perform cron.alter_job(3,schedule:='23 3 * * *');
 perform cron.alter_job(101,schedule:='27 3 * * *');
 update public.trading_scheduler_jobs set enabled=true where scheduler_key='trading-production' and job_key in ('gpt-review-expire','bounded-clock-telemetry','entry-reservation-maintenance');
 return true;end $fn$;
create function public.trading_restore_remaining_cron(p_external_jobs_stopped boolean) returns boolean
language plpgsql security definer set search_path='' as $fn$
declare b jsonb;item jsonb;begin
 if p_external_jobs_stopped is distinct from true or exists(select 1 from public.trading_scheduler_jobs where scheduler_key='trading-production' and job_key in ('gpt-review-expire','bounded-clock-telemetry','entry-reservation-maintenance') and enabled) or
 exists(select 1 from public.trading_scheduler_ticks where job_key in ('gpt-review-expire','bounded-clock-telemetry','entry-reservation-maintenance') and state in ('STARTED','ACCEPTED') and started_at>clock_timestamp()-interval '10 seconds') then raise exception 'STOP_NEW_MAINTENANCE_BEFORE_RESTORE';end if;
 select cron_backup into b from public.trading_cron_normalization_checkpoints where version='CRON_BOUNDED_1';if b is null then raise exception 'CRON_ROLLBACK_CHECKPOINT_MISSING';end if;
 for item in select * from jsonb_array_elements(b) loop
  perform cron.alter_job((item->>'jobid')::bigint,schedule:=item->>'schedule',active:=(item->>'active')::boolean);
 end loop;return true;end $fn$;
revoke all on function public.trading_normalize_remaining_cron(text,timestamptz),public.trading_restore_remaining_cron(boolean) from public,anon,authenticated;
grant execute on function public.trading_normalize_remaining_cron(text,timestamptz),public.trading_restore_remaining_cron(boolean) to service_role;
create or replace function public.leader20_dispatch_terminal_cause(p_state text,p_error text,p_claimed boolean)
returns text language sql immutable set search_path='' as $$
 select case
 when p_state in ('FILLED','PARTIALLY_FILLED_CANCELED') then p_state
 when coalesce(p_error,'') ~* 'GW_429|HTTP_429|LOCAL_RATE_GUARD|RATE.?LIMIT' then 'RATE_LIMIT'
 when coalesce(p_error,'') ~* 'ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE' then 'ACCOUNT_STATE_UNAVAILABLE'
 when coalesce(p_error,'') ~* 'PRE_EXECUTION_GPT_CANCEL_OR_ERROR:CANCEL_BUY' then 'GPT_RECHECK_CANCELED'
 when coalesce(p_error,'') ~* 'PRE_EXECUTION_INVALID|PRE_EXECUTION_UNCERTAIN_DATA_UNSAFE|STALE|FRESHNESS|CAPTURE|SNAPSHOT' then 'LATEST_DATA_VALIDATION_FAILED'
 when coalesce(p_error,'') ~* 'CIRCUIT' then 'CIRCUIT_OPEN'
 when coalesce(p_error,'') ~* 'CAPACITY|SLOT_FULL|MARGIN_INSUFFICIENT|INSUFFICIENT_MARGIN' then 'CAPACITY_REJECTED'
 when coalesce(p_error,'') ~* 'DB.*TIMEOUT|DATABASE|CONNECTION|HTTP_50[234]|signal has been aborted' then 'DEPENDENCY_TIMEOUT_OR_5XX'
 when coalesce(p_error,'') ~* 'LEASE|FENCED' then 'LEASE_FAILURE'
 when p_state in ('CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION','EXECUTION_WINDOW_INSUFFICIENT') and not p_claimed then 'UNCLAIMED_DEADLINE_EXPIRED'
 when p_state='CLOCK_FINAL_EXPIRED_BEFORE_EXECUTION' then 'AUTHORITY_EXPIRED'
 when p_state='EXECUTION_WINDOW_INSUFFICIENT' then 'VALIDATION_WINDOW_EXHAUSTED'
 when p_state in ('EXPIRED','REJECTED') and nullif(p_error,'') is null then 'EXCHANGE_'||p_state
 when p_state='REJECTED' then 'OTHER_VALIDATION_REJECTED'
 else p_state end
$$;
commit;
