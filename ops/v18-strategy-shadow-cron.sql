-- Apply only after the exact reviewed function bundle and auth checks pass.
-- This task evaluates and records hypotheses; it cannot submit a trade.
select cron.schedule('v18-strategy-shadow-observe', '* * * * *', $job$
  select net.http_post(
    url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v18-strategy-shadow',
    headers:=jsonb_build_object('content-type','application/json','x-v16-diagnostic-token',
      (select token from public.edge_internal_tokens where name='v16-futures-position-diagnostic')),
    body:='{"mode":"evaluate"}'::jsonb,
    timeout_milliseconds:=45000
  );
$job$);
-- Rollback (preserve evidence; never alter live entry or protection controls):
-- select cron.unschedule('v18-strategy-shadow-observe');
