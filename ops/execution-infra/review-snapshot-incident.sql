-- Explicit one-shot operator review. Never clears a circuit or replays an order.
-- Caller substitutes only a JSON object using a SQL literal with quote escaping.
begin;
set local lock_timeout='500ms';set local statement_timeout='3000ms';
select set_config('trading.review',__REVIEW_JSON__,true);
do $review$
declare a jsonb:=current_setting('trading.review')::jsonb;e jsonb:=a->'evidence';
 r public.v11_long_regime_runtime%rowtype;old public.v18_ops_incidents%rowtype;
 owner_id uuid:=(a->>'owner')::uuid;seen timestamptz;result jsonb;
begin
 if a->>'version' is distinct from 'REVIEW_SNAPSHOT_EPOCH_145_1' or length(a->>'commit')<>40 or
    (a->>'postmaster')::timestamptz is distinct from pg_postmaster_start_time() then raise exception 'REVIEW_VERSION_OR_RESTART';end if;
 if not public.v17_acquire_execution_lease(owner_id) then raise exception 'REVIEW_WRITER_BUSY';end if;
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 select * into strict old from public.v18_ops_incidents where id='3d38253a-77a8-4b6b-ae78-6b38d41987a1' for update;
 if r.circuit_open is not true or r.incident_id is distinct from '4e0deb37-e159-4521-ad90-916f58fc1cc6'::uuid or
    r.incident_generation<>145 or r.incident_kind is distinct from 'MANUAL_REVIEW_REQUIRED' or
    r.circuit_reason is distinct from 'ACCOUNT_ENTRY_HOLD:ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE' or
    r.last_error is not null or old.generation<>144 or old.kind is distinct from 'INCOMPLETE_OR_STALE_SNAPSHOT' or
    old.reason is distinct from r.circuit_reason or old.evidence#>>'{decision,reasons,0}' is distinct from 'ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE' or
    not exists(select 1 from public.v18_ops_incidents where id=r.incident_id and evidence='{"source":"PRE_EXISTING_WRITER"}'::jsonb and resolved_at is null) then
  raise exception 'REVIEW_EXACT_INCIDENT_CAS_MISS';end if;
 perform 1 from public.v17_operator_control where singleton for share;
 perform 1 from public.trading_settings where id=1 for share;
 if r.live_enabled is not true or not exists(select 1 from public.v17_operator_control where singleton and entry_enabled and legacy_entries_retired) or
    not exists(select 1 from public.trading_settings where id=1 and mode='LIVE_LIMITED' and
    not coalesce(pause_new_entries,true) and not coalesce(scalp_kill_switch,true) and not coalesce(withdrawal_mode,true) and
    not coalesce(manual_intervention_required,true) and not coalesce(emergency_liquidation,true) and pause_lock_reason is null) then raise exception 'REVIEW_OPERATOR_HALT';end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 seen:=to_timestamp((e#>>'{portfolio,observation,requested_at_ms}')::double precision/1000);
 if e#>>'{portfolio,exchange}' is distinct from 'binance_futures' or e#>>'{portfolio,account_scope}' is distinct from 'futures' or
    e#>>'{portfolio,positions_complete}' is distinct from 'true' or e#>'{portfolio,positions}' is distinct from '[]'::jsonb or
    e#>>'{portfolio,observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or e#>>'{portfolio,observation,id}' is null or
    seen is null or seen<clock_timestamp()-interval '3 seconds' or seen>clock_timestamp()+interval '1 second' or
    e#>>'{portfolio,observation,received_at_ms}' is null or
    (e#>>'{portfolio,observation,received_at_ms}')::double precision>(extract(epoch from clock_timestamp())*1000+1000) or
    (e#>>'{portfolio,observation,received_at_ms}')::double precision<(e#>>'{portfolio,observation,requested_at_ms}')::double precision or
    e#>>'{openOrders,complete}' is distinct from 'true' or e#>'{openOrders,orders}' is distinct from '[]'::jsonb or e#>'{openOrders,algos}' is distinct from '[]'::jsonb or
    e#>>'{openOrders,observed_at_ms}' is null or to_timestamp((e#>>'{openOrders,observed_at_ms}')::double precision/1000)<clock_timestamp()-interval '5 seconds' or
    to_timestamp((e#>>'{openOrders,observed_at_ms}')::double precision/1000)>clock_timestamp()+interval '1 second' then raise exception 'REVIEW_FRESH_FLAT_EVIDENCE_MISSING';end if;
 if exists(select 1 from public.v11_long_regime_positions where state='OPEN') or
    exists(select 1 from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and coalesce(response_payload->>'v18ExposureFinal','false')<>'true') then raise exception 'REVIEW_EXPOSURE_CHANGED';end if;
 -- A fresh recoverable epoch, not a release: all original independent recovery
 -- checks, 50-90s spacing and 110s minimum span remain in the unchanged RPC.
 result:=public.v19_record_incident(owner_id,'INCOMPLETE_OR_STALE_SNAPSHOT','ACCOUNT_EVIDENCE_INCOMPLETE_OR_STALE','ACCOUNT_ENTRY_HOLD',null,
  '{"exposureState":"FLAT","accountingState":"ATTRIBUTION_INVESTIGATING","orderSource":"BOT","recheck":["FRESH_COMPLETE_ACCOUNT_SNAPSHOT","FRESH_COMPLETE_OPEN_ORDERS"]}'::jsonb,
  jsonb_build_object('operatorReview',a,'reviewedIncident',r.incident_id,'reviewedCause',old.id,'circuitRetained',true),'V19-SCOPE-AWARE-ENTRY-1');
 update public.v18_ops_incidents set resolution_evidence=coalesce(resolution_evidence,'{}')||jsonb_build_object('reviewClassification',result,'review',a),
  status='SUPERSEDED',resolved_at=coalesce(resolved_at,clock_timestamp()) where id in (r.incident_id,old.id);
 perform public.v17_release_execution_lease(owner_id);
end $review$;
select circuit_open,incident_id,incident_generation,incident_kind from public.v11_long_regime_runtime where singleton;
commit;
