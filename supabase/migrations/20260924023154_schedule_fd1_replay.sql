-- Reset the pilot batch (prompt/schema changed) and run the order-free FD1 replay every 30s.
update public.fd1_replay_jobs set state='NEW', claimed_at=null, completed_at=null, packet=null, result=null, decision=null, valid=null, error=null, api_cost_usd=null, latency_ms=null where run_tag='fd1-entry-16d';
select cron.schedule('fd1-replay-30s', '30 seconds', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/gpt-final-decision-replay',
    headers := jsonb_build_object('content-type','application/json',
      'x-fd1-replay-token',(select token from public.edge_internal_tokens where name='gpt-final-decision-replay')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
  where exists (select 1 from public.fd1_replay_jobs where state <> 'DONE');
$cmd$);
