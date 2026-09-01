do $$
declare v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname='v10-lane-exit-shadow-every-minute';
  if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
end $$;

select cron.schedule(
  'v10-lane-exit-shadow-every-minute',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-exit-shadow-invoker',
    headers := jsonb_build_object(
      'content-type','application/json',
      'x-v10-exit-token',(
        select token from public.edge_internal_tokens where name='v10-lane-exit-shadow'
      )
    ),
    body := '{"limit":50}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);
