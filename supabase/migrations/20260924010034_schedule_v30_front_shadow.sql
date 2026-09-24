-- Schedule the order-free V30 front-policy shadow observer every 30 seconds.
select cron.schedule('v30-front-shadow-30s', '30 seconds', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v30-front-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-v30-shadow-token',(select token from public.edge_internal_tokens where name='v30-front-shadow')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$cmd$);
