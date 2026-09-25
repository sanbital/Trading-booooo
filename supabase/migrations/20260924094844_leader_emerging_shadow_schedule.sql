-- LE-SHADOW-1 schedules (separate from the schema so they can be stopped on their own:
--   select cron.unschedule('leader-emerging-shadow-scan');   -- and -wait / -outcome
-- ). Minutes avoid the production generator (:00/:05) and v16-momentum-broad-shadow (:04/:09).
-- The shadow_le_writer credential is read from Vault per call; the function connects AS that role.
select cron.schedule('leader-emerging-shadow-scan', '1-59/5 * * * *', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name = 'leader_emerging_shadow_db_password')),
    body := '{"mode":"scan"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from shadow_le.control where singleton and enabled);
$cmd$);

-- WAIT follow-up: only while a GPT WAIT is open (stage 2); never on :x0/:x4/:x5/:x9.
select cron.schedule('leader-emerging-shadow-wait', '1-3,6-8,11-13,16-18,21-23,26-28,31-33,36-38,41-43,46-48,51-53,56-58 * * * *', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name = 'leader_emerging_shadow_db_password')),
    body := '{"mode":"wait"}'::jsonb,
    timeout_milliseconds := 60000)
  where exists (select 1 from shadow_le.control where singleton and enabled)
    and exists (select 1 from shadow_le.decisions d where d.decision = 'WAIT' and d.wait_expires_at > now()
      and not exists (select 1 from shadow_le.wait_events e where e.decision_id = d.decision_id));
$cmd$);

select cron.schedule('leader-emerging-shadow-outcome', '12,27,42,57 * * * *', $cmd$
  select net.http_post(
    url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/leader-emerging-shadow',
    headers := jsonb_build_object('content-type','application/json',
      'x-shadow-le-credential',(select decrypted_secret from vault.decrypted_secrets where name = 'leader_emerging_shadow_db_password')),
    body := '{"mode":"outcome"}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from shadow_le.control where singleton and enabled);
$cmd$);
