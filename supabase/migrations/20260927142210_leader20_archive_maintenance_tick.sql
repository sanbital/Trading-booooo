-- Reuse the existing authenticated ingest service; no new always-on machine.
begin;
select cron.schedule('leader20-private-archive','*/2 * * * *',$command$
 select net.http_post(
  url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/doa-capture-ingest',
  headers:=jsonb_build_object('content-type','application/json',
   'x-doa-capture-token',(select token from public.edge_internal_tokens where name='doa-capture')),
  body:='{"action":"archive-maintenance"}'::jsonb,timeout_milliseconds:=90000
 ) from public.leader20_control where singleton and observation_enabled and archive_max_bytes>0;
$command$);
select cron.schedule('leader20-observer-tick','* * * * *',$command$
 select net.http_post(
  url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
  headers:=jsonb_build_object('content-type','application/json',
   'x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')),
  body:='{"mode":"leader20-observe"}'::jsonb,timeout_milliseconds:=18000
 ) from public.leader20_control where singleton and observation_enabled;
$command$);
commit;
