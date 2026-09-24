-- Two staggered order-free FD1 replay workers (v5: batch 20, concurrency 3 each).
select cron.alter_job((select jobid from cron.job where jobname='fd1-replay-30s'), active:=true);
select cron.schedule('fd1-replay-30s-b', '30 seconds', $cmd$
  select pg_sleep(15);
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/gpt-final-decision-replay',
    headers := jsonb_build_object('content-type','application/json',
      'x-fd1-replay-token',(select token from public.edge_internal_tokens where name='gpt-final-decision-replay')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
  where exists (select 1 from public.fd1_replay_jobs where state <> 'DONE');
$cmd$);
