-- Lightweight requests to the EXISTING generator; no legacy scan, AI or order call.
-- The control predicate keeps this inert until the authorized observation rollout.
begin;
select cron.schedule('leader20-observer-tick','20 seconds',$command$
 select net.http_post(
   url := 'https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
   headers := jsonb_build_object('content-type','application/json',
     'x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')),
   body := '{"mode":"leader20-observe"}'::jsonb,
   timeout_milliseconds := 18000
 ) from public.leader20_control where singleton and observation_enabled;
$command$);
commit;
