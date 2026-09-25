-- LE-SHADOW-2 schedules (separate from the schema so they can be stopped on their own:
--   select cron.unschedule('leader-emerging-shadow-parity'); select cron.unschedule('leader-emerging-shadow-v2wait');
-- ). DISCOVERY runs inside the existing scan job (90) and V2 outcomes inside the outcome job (92).
--
-- PARITY: every minute, but the HTTP call is made only when a production FD1 ENTRY review from
-- the last 15 minutes has no parity event yet. It makes ZERO Binance requests (it reuses the
-- production snapshot), so it cannot compete with the production scanner for weight.
select cron.schedule('leader-emerging-shadow-parity', '* * * * *', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name = 'leader_emerging_shadow_db_password')),
    body := '{"mode":"parity"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from shadow_le.control where singleton and enabled and v2_parity_enabled)
    and exists (select 1 from public.gpt_final_entry_reviews r
      where r.purpose = 'PRODUCTION' and r.state = 'DONE' and r.created_at > now() - interval '15 minutes'
        and r.record->'packet'->>'task' = 'ENTRY'
        and not exists (select 1 from shadow_le.v2_events e where e.lane = 'PARITY' and e.prod_job_key = r.job_key));
$cmd$);

-- V2 WAIT follow-up: only while a V2 WAIT has no terminal event; never on :x0/:x4/:x5/:x9
-- (production scanner :x0/:x5, v16 broad shadow :x4/:x9).
select cron.schedule('leader-emerging-shadow-v2wait', '1-3,6-8,11-13,16-18,21-23,26-28,31-33,36-38,41-43,46-48,51-53,56-58 * * * *', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name = 'leader_emerging_shadow_db_password')),
    body := '{"mode":"v2wait"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from shadow_le.control where singleton and enabled)
    and exists (select 1 from shadow_le.v2_decisions d where d.decision = 'WAIT'
      and not exists (select 1 from shadow_le.v2_wait_events w where w.decision_id = d.decision_id));
$cmd$);
