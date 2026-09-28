begin;
set local lock_timeout='2s';
do $$ begin
 if not exists(select 1 from public.leader20_control where singleton and not clock_capture_enabled and watch_limit=10 and active_strategy='LEADER20_DYNAMIC_1')
  or not exists(select 1 from doa_capture.control where id=1 and metrics->>'version'='DOA-CAPTURE-7-CLOCK-TOP20' and heartbeat_at>clock_timestamp()-interval '25 seconds')
  or exists(select 1 from public.v11_long_regime_orders where intent='OPEN_LONG' and state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and response_payload->>'v18ExposureFinal' is distinct from 'true')
 then raise exception 'CLOCK_ACTIVATION_BASELINE';end if;
end $$;
update public.leader20_control set clock_capture_enabled=true,watch_limit=20,generation=generation+1,updated_at=clock_timestamp() where singleton;
update public.leader20_review_events set state='RETIRED',result=coalesce(result,'{}')||'{"retired_reason":"CLOCK_CAPTURE_CUTOVER"}' where state in ('REQUESTED','REVIEWING');
select cron.schedule('leader20-observer-tick','10 seconds',$command$
 select net.http_post(
  url:='https://etaajwpernzrcdrifdnw.supabase.co/functions/v1/v10-lane-signal-generator',
  headers:=jsonb_build_object('content-type','application/json','x-v10-lane-token',(select token from public.edge_internal_tokens where name='v10-lane-signal-generator')),
  body:='{"mode":"leader20-observe"}'::jsonb,timeout_milliseconds:=60000
 ) from public.leader20_control where singleton and observation_enabled and clock_capture_enabled
  and (mod(floor(extract(epoch from clock_timestamp()))::bigint,600)<120
   or mod(floor(extract(epoch from clock_timestamp()))::bigint,600) between 420 and 479);
$command$);
commit;
select clock_capture_enabled,watch_limit,generation,clock_timestamp() activated_at from public.leader20_control where singleton;
