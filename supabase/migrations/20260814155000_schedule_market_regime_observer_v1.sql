-- Run the isolated market-regime observer every 5 minutes.
-- The internal token is read at execution time and is never embedded in the cron command.

select cron.unschedule(jobid)
from cron.job
where jobname = 'market-regime-observer-v1';

select cron.schedule(
  'market-regime-observer-v1',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/market-regime-observer',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-regime-token', (
          select token
          from public.edge_internal_tokens
          where name = 'market-regime-observer'
        )
      ),
      body := '{"action":"tick"}'::jsonb
    );
  $cron$
);
