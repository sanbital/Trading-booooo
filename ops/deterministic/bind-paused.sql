begin;
set local lock_timeout='750ms';
set local statement_timeout='5000ms';
do $$ begin
 if not exists(select 1 from public.deterministic_control where singleton and not enabled)
 or not exists(select 1 from public.trading_settings where id=1 and pause_new_entries)
 or not exists(select 1 from public.leader20_control where singleton and active_strategy='PAUSED')
 or exists(select 1 from public.leader20_batch_control where singleton and enabled)
 or exists(select 1 from public.gpt_final_review_control where singleton and mode<>'OFF')
 then raise exception 'PAUSED_AUTHORITY_REQUIRED';end if;
 if (select count(*) from public.trading_scheduler_jobs where scheduler_key='trading-production'
 and job_key in ('v11-long-regime-executor','leader20-observer-tick'))<>2
 then raise exception 'EXACT_EXISTING_CLOCK_JOBS_REQUIRED';end if;
end $$;
update public.leader20_control set watch_limit=20,clock_capture_enabled=false,updated_at=clock_timestamp() where singleton;
update public.trading_scheduler_jobs set target=jsonb_build_object('endpoint',case when job_key='v11-long-regime-executor'
 then 'v10-lane-executor' else 'v10-lane-signal-generator' end,'body',jsonb_build_object('mode','run')),
 enabled=true,period_ms=5000,offset_ms=0,retry_at=null,failure_count=0
 where scheduler_key='trading-production' and job_key in ('v11-long-regime-executor','leader20-observer-tick');
-- The operator pause stays set through migration, deployment and source parity.
-- Only disabled deterministic services now hold these targets. Restore the prior
-- operator permission so the unchanged V18 recovery RPC can observe the incident;
-- deterministic_control.enabled=false still prohibits every new BUY.
update public.trading_settings set pause_new_entries=false where id=1 and pause_new_entries;
commit;
