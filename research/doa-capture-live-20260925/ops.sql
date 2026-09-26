-- Read-only operational coverage; does not inspect TEST profitability.
select id,enabled,starts_at,ends_at,heartbeat_at,metrics,bytes_reserved,requests from doa_capture.control;
select kind,count(*),count(distinct symbol),min(at),max(at) from doa_capture.observations group by kind;
select d.signal_id,d.symbol,d.candidate_at,d.position_id,d.fill_at,d.status,
 count(o.*) filter(where o.at<d.candidate_at) pre_buckets,
 count(o.*) filter(where o.at>=d.candidate_at) post_buckets,
 count(o.*) filter(where o.payload->>'bucket_complete'='true') complete_buckets,
 case when now()<d.candidate_at+interval '130 seconds' then 'PENDING'
 when count(o.*)=0 then 'UNWATCHED'
 when count(o.*) filter(where o.at<d.candidate_at)>=12 and count(o.*) filter(where o.at>=d.candidate_at)>=24
 and bool_and(coalesce((o.payload->>'bucket_complete')::boolean,false)) then 'COMPLETE' else 'GAP' end as computed_coverage
from doa_capture.candidates d left join doa_capture.observations o on o.kind='micro' and o.symbol=d.symbol
 and o.at between d.candidate_at-interval '60 seconds' and d.candidate_at+interval '120 seconds'
group by d.signal_id order by d.candidate_at;

-- Rollback: does not cancel trades, change stops, or deploy the executor.
-- update doa_capture.control set enabled=false where id=1;
-- select cron.unschedule(jobid) from cron.job where jobname='doa-capture-retention';

-- Dedicated retention registration; execute only once after deployment.
-- This is batched, eventual retention: rows become eligible after14d, at most10k/day removed.
-- select cron.schedule('doa-capture-retention','17 3 * * *',$job$
-- delete from doa_capture.observations where ctid in(select ctid from doa_capture.observations where at<now()-interval '14 days' order by at limit 10000);
-- delete from doa_capture.batches where id in(select id from doa_capture.batches where created_at<now()-interval '2 days' order by created_at limit 10000);
-- delete from doa_capture.candidates where signal_id in(select signal_id from doa_capture.candidates where candidate_at<now()-interval '90 days' limit 2000);
-- $job$);
