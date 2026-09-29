-- Review every READY Top20 candidate before applying entry-slot capacity.
--
-- Incident: 2026-09-29 19:40 KST.
-- The batch contained 14 READY symbols and 6 correctly BLOCKED symbols, but only two
-- READY symbols reached GPT because leader20_materialize_event() reserved one entry
-- slot BEFORE signal/GPT materialization. With available_for_new_entry=2, the first
-- two candidates consumed both reservations and the remaining READY events stayed
-- REQUESTED until leader20_schedule() marked them CAPTURE_REFRESH_WINDOW_EXHAUSTED.
--
-- This was the wrong layer for capacity. The production executor already reviews
-- candidates first, then admits GPT BUY candidates serially and recomputes account
-- capacity after every fill. Capture validity, clock expiry, order sizing, leverage,
-- margin, TTL and all execution safety remain unchanged.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

create or replace function public.leader20_materialize_event(p_event_id uuid,p_features jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
 e public.leader20_review_events%rowtype;
 b public.leader20_batches%rowtype;
 c jsonb;
 w jsonb;
 s jsonb;
 r jsonb;
 sid uuid;
 deadline timestamptz;
begin
 if not(select clock_capture_enabled from public.leader20_control where singleton) then
  return public.leader20_materialize_before_clock(p_event_id,p_features);
 end if;

 select * into e from public.leader20_review_events where id=p_event_id for update;
 select * into b from public.leader20_batches where id::text=e.result->>'batch_id';
 select x into s from jsonb_array_elements(b.packet->'symbols') x where x->>'id'=e.symbol;
 c:=public.doa_context_for_role_v1(e.symbol,clock_timestamp(),'TRADE_CANDIDATE',null);
 w:=c->'entry_window';

 if e.state is distinct from 'REQUESTED'
  or b.state is distinct from 'DONE'
  or s->>'state' is distinct from 'READY'
  or c->>'status' is distinct from 'AVAILABLE'
  or w is null
  or w is distinct from s->'entry_window'
  or w is distinct from p_features#>'{execution_snapshot,entry_window}'
  or p_features#>>'{execution_snapshot,complete}' is distinct from 'true'
  or p_features#>>'{execution_snapshot,causal}' is distinct from 'true'
  or p_features#>>'{execution_snapshot,bucket_count}' is distinct from '24'
  or p_features#>>'{execution_snapshot,end_ms}' is distinct from c->>'end_ms'
  or (p_features->>'referenceClose')::numeric<=0
 then
  return jsonb_build_object('created',false,'reason','CLOCK_CAPTURE_BINDING');
 end if;

 -- IMPORTANT: do not reserve account entry capacity here.
 -- This function creates a REVIEW CANDIDATE, not an order candidate.
 -- All READY symbols must be able to reach GPT regardless of how many positions
 -- can ultimately be opened. The executor applies the unchanged capacity ceiling
 -- after GPT and serializes actual entry attempts.
 r:=public.leader20_materialize_event_before_batch(p_event_id,p_features);

 if r->>'created'='true' then
  sid:=(r->>'signal_id')::uuid;
  deadline:=to_timestamp((w->>'expires_at_ms')::numeric/1000);

  update public.v11_long_regime_signals
   set features=jsonb_set(features,'{leader20}',features->'leader20'||jsonb_build_object(
    'batch_id',b.id,
    'batch_advice',e.result->'batch_advice',
    'entry_window',w,
    'expires_at_ms',w->'expires_at_ms',
    'execution_snapshot_hash',p_features#>'{execution_snapshot,trajectory_hash}'))
   where id=sid;

  update public.leader20_review_events
   set expires_at=deadline
   where id=e.id;

  update public.leader20_campaigns
   set state='WATCHING',
       execution_state='ENTRY_CANDIDATE',
       last_candidate_id=sid,
       updated_at=clock_timestamp()
   where symbol=e.symbol;
 end if;

 return r;
end $$;

revoke all on function public.leader20_materialize_event(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.leader20_materialize_event(uuid,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
