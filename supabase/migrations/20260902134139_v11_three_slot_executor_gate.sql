-- Let the executors run whenever a slot is still free, not only when flat.
--
-- The previous gate fired the entry path only when zero positions were open, so
-- a lane could never add a second or third slot if the open position belonged to
-- the other lane (for example a MICRO position graduated to BULL). The lane's own
-- management branch is unchanged.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'v11-micro-executor'),
  command => $job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v11-micro-executor',
    headers := jsonb_build_object('content-type','application/json','x-v10-executor-token',(select token from public.edge_internal_tokens where name='v10-lane-executor')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (select 1 from public.v11_long_regime_positions where state='OPEN' and active_lane in ('RANGE','BEAR'))
     or (
       (select count(*) from public.v11_long_regime_positions where state='OPEN') < 3
       and coalesce((
         select predicted_regime in ('NEUTRAL','RISK_OFF')
         from public.market_regime_observations
         where model_revision='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
           and trading_influence=true
           and observed_at >= now()-interval '12 minutes'
         order by observed_at desc limit 1
       ),false)
     );
  $job$
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'v11-long-regime-executor'),
  command => $job$
  with extended as (
    update public.v11_long_regime_positions
       set hard_deadline = greatest(hard_deadline, entry_at + interval '30 days')
     where state='OPEN' and active_lane='BULL'
       and hard_deadline < entry_at + interval '30 days'
    returning id
  )
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-executor',
    headers := jsonb_build_object('content-type','application/json','x-v10-executor-token',(select token from public.edge_internal_tokens where name='v10-lane-executor')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (select 1 from public.v11_long_regime_positions where state='OPEN' and active_lane='BULL')
     or (
       (select count(*) from public.v11_long_regime_positions where state='OPEN') < 3
       and coalesce((
         select predicted_regime in ('BULL','STRONG_BULL')
         from public.market_regime_observations
         where model_revision='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
           and trading_influence=true
           and observed_at >= now()-interval '12 minutes'
         order by observed_at desc limit 1
       ),false)
     );
  $job$
);
