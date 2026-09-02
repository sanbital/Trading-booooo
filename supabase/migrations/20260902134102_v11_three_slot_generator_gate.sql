-- Open the signal generators to three concurrent slots.
--
-- Both generator jobs were gated on "not exists (... state='OPEN')", so once the
-- first slot filled no further signals were produced and slots 2 and 3 could
-- never be reached, no matter what MAX_SLOTS said in the executors. The gate now
-- follows the same three-slot cap enforced by v11_long_regime_slot_cap_trg.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'v11-micro-generator'),
  command => $job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v11-micro-signal-generator',
    headers := jsonb_build_object('content-type','application/json','x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  where (select count(*) from public.v11_long_regime_positions where state='OPEN') < 3
    and coalesce((
      select predicted_regime in ('NEUTRAL','RISK_OFF')
      from public.market_regime_observations
      where model_revision='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
        and trading_influence=true
        and observed_at >= now()-interval '12 minutes'
      order by observed_at desc limit 1
    ),false);
  $job$
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'v11-long-regime-generator'),
  command => $job$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
    headers := jsonb_build_object('content-type','application/json','x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  where (select count(*) from public.v11_long_regime_positions where state='OPEN') < 3
    and coalesce((
      select predicted_regime in ('BULL','STRONG_BULL')
      from public.market_regime_observations
      where model_revision='MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
        and trading_influence=true
        and observed_at >= now()-interval '12 minutes'
      order by observed_at desc limit 1
    ),false);
  $job$
);
