-- Read-only, bounded original production cohort. No strategy or ledger writes.
with d as materialized(select * from public.leader20_execution_dispatches where gpt_completed_at>=now()-interval '10 minutes'),
 f as materialized(select r.record#>>'{identity,signal_id}' signal from public.gpt_final_entry_reviews r
 where r.created_at>=now()-interval '10 minutes' and r.purpose='PRODUCTION' and r.state='DONE' and r.valid and r.decision='BUY'
  and r.record#>>'{result,review_route}'='TOP20_CLOCK_GPT_FINAL_3'),
 o as materialized(select id,state from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED'))
select now() utc,now() at time zone 'Asia/Seoul' kst,pg_postmaster_start_time() postmaster_at,
 (select count(*) from f where not exists(select 1 from public.leader20_execution_dispatches x where x.signal_id::text=f.signal)) final_buy_dispatch_missing,
 (select count(*) from d where executor_claimed_at is null and valid_until<=now()) unclaimed_deadline,
 (select max(extract(epoch from now()-dispatch_requested_at)) from d where state='READY_TO_EXECUTE') ready_oldest_age_s,
 (select count(*) from d where state='READY_TO_EXECUTE' and valid_until<=now()) expired_ready,
 (select count(*) from d where terminal_reason='EXECUTOR_BUSY') busy_terminal,
 (select percentile_cont(.99)within group(order by extract(epoch from executor_claimed_at-dispatch_requested_at)*1000)from d where executor_claimed_at is not null) dispatch_claim_p99_ms,
 (select count(*) from d where state='UNKNOWN') unknown_dispatch,
 (select count(*) from o) unresolved_order,
 (select count(*) from o where state='UNKNOWN') unknown_order,
 (select count(*) from public.v11_long_regime_positions p where p.state='OPEN' and p.metadata#>>'{exitProtection,health}' is distinct from 'PROTECTED') protection_evidence_missing,
 (select count(*) from cron.job where active and schedule like '%seconds%') active_subminute_cron,
 (select count(*) from cron.job c join public.trading_scheduler_jobs j on j.legacy_cron_jobid=c.jobid join public.trading_scheduler_control s using(scheduler_key) where s.enabled and j.enabled and c.active) dual_scheduler,
 (select count(*) from cron.job_run_details where start_time>=now()-interval '10 minutes' and return_message ilike '%startup timeout%') cron_startup_timeout,
 (select count(*) from net.http_request_queue) net_queue_depth,
 (select count(*) from pg_stat_activity) db_connections,
 (select current_setting('max_connections')::integer) db_connection_limit,
 (select row_to_json(s) from public.trading_scheduler_control s where scheduler_key='trading-production') scheduler,
 (select row_to_json(s) from public.v17_execution_infrastructure_control s where singleton) infrastructure
