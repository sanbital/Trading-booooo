select cron.unschedule(jobid) from cron.job where jobname='v16-momentum-shadow-5m';

select cron.schedule(
  'v16-momentum-shadow-5m',
  '2-59/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v16-momentum-shadow',
    headers := jsonb_build_object(
      'content-type','application/json',
      'x-v16-shadow-token',(select token from public.edge_internal_tokens where name='v16-momentum-shadow')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
