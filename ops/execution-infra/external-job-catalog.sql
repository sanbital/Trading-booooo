-- Reviewed live callers. Catalog enabled, scheduler control disabled until exact cutover.
begin;
insert into public.trading_scheduler_control(scheduler_key) values('trading-production');
with desired(jobname,period_ms,offset_ms,timeout_ms,recovery_mode,job_kind,requires_recovery,target) as (values
 ('v11-long-regime-executor',30000,0,110000,'CURRENT_ONLY','PROTECTION_SYNC',true,'{"endpoint":"v10-lane-executor","body":{}}'::jsonb),
 ('leader20-execution-outbox-sweeper',5000,0,100000,'CURRENT_ONLY','ENTRY',true,'{"endpoint":"v10-lane-executor","body":{"mode":"execute-ready-any"},"guard":"OUTBOX_WAKE"}'::jsonb),
 ('gpt-final-review-durable-recovery',5000,0,2500,'DURABLE_CURSOR','MAINTENANCE',false,'{"rpc":"gpt_final_review_recover_ready","limit":30}'::jsonb),
 ('leader20-observer-tick',10000,0,60000,'CURRENT_ONLY','SIGNAL',false,'{"endpoint":"v10-lane-signal-generator","body":{"mode":"leader20-observe"},"guard":"LEADER20_OBSERVE"}'::jsonb),
 ('market-regime-observer-v2',300000,0,60000,'CURRENT_ONLY','SIGNAL',false,'{"endpoint":"market-regime-observer","body":{"action":"tick"}}'::jsonb),
 ('market-v2-signal-binance-spot',3600000,120000,120000,'CURRENT_ONLY','SIGNAL',false,'{"endpoint":"market-v2-signal","body":{"action":"run","venue":"binance_spot"}}'::jsonb),
 ('market-v2-signal-binance-futures',3600000,240000,120000,'CURRENT_ONLY','SIGNAL',false,'{"endpoint":"market-v2-signal","body":{"action":"run","venue":"binance_futures"}}'::jsonb),
 ('market-v2-signal-upbit-spot',3600000,480000,120000,'CURRENT_ONLY','SIGNAL',false,'{"endpoint":"market-v2-signal","body":{"action":"run","venue":"upbit_spot"}}'::jsonb)
)
insert into public.trading_scheduler_jobs(scheduler_key,job_key,enabled,period_ms,offset_ms,timeout_ms,recovery_mode,job_kind,requires_recovery,target,legacy_cron_jobid)
select 'trading-production',d.jobname,true,d.period_ms,d.offset_ms,d.timeout_ms,d.recovery_mode,d.job_kind,d.requires_recovery,d.target,j.jobid
from desired d join cron.job j on j.jobname=d.jobname;
insert into public.trading_scheduler_jobs(scheduler_key,job_key,enabled,period_ms,timeout_ms,recovery_mode,job_kind,requires_recovery,target)
values
 ('trading-production','existing-position-monitor',true,2000,45000,'CURRENT_ONLY','MONITOR',false,'{"endpoint":"market-autotrader","body":{"action":"monitor"}}'),
 ('trading-production','legacy-account-maintenance',true,12000,360000,'CURRENT_ONLY','MAINTENANCE',false,'{"endpoint":"market-autotrader","body":{"action":"scan"}}');
-- Bounded provider receipt promotion uses original durable DONE/RUNNING ledger rows as cursor.
-- It never starts a paid request and its original BUY deadline filter remains authoritative.
commit;
