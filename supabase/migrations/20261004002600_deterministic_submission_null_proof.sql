-- Exact additive repair. Preserve every BUY/state/capacity/fence deadline.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.deterministic_begin_submit(uuid,uuid,jsonb)'::regprocedure);
 if md5(definition) not in ('83b00387f9bb1a711fdfde5a51c73566','50bfd0b4738d9fc70e68f1758ee9f564','b9dadf9c57ec33edb972283fba4d0d26') then raise exception 'EXACT_SUBMIT_NULL_BASELINE_REQUIRED';end if;
 if position('response_payload=response_payload||jsonb_build_object' in definition)=0 then raise exception 'EXACT_SUBMIT_NULL_BASELINE_REQUIRED';end if;
 execute replace(definition,'response_payload=response_payload||jsonb_build_object','response_payload=coalesce(response_payload,''{}''::jsonb)||jsonb_build_object');
end $$;

-- A paused, flat account may resolve ONE already-proven never-placed identity.
-- This does not grant entry permission or touch orders, positions or accounting.
-- Keep the existing independent 50s / three observations / 110s recovery gate.
create function public.deterministic_paused_never_placed_recovery(
 p_owner uuid,p_incident_id uuid,p_generation bigint,p_order_id uuid,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='500ms' as $$
declare r record;i record;o record;s record;seen timestamptz;obs text;checks integer;proof jsonb;
begin
 perform public.v18_require_lease(p_owner);
 if public.v17_verify_execution_lease(p_owner) is distinct from true then raise exception 'V18_EXECUTION_FENCED';end if;
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 select * into strict s from public.trading_settings where id=1 for share;
 if r.circuit_open is distinct from true or r.incident_id is distinct from p_incident_id or r.incident_generation is distinct from p_generation
 or i.generation is distinct from p_generation or i.kind is distinct from 'KNOWN_ORDER_PENDING_RECONCILIATION'
 or i.kind is distinct from r.incident_kind or i.reason is distinct from r.circuit_reason or i.resolved_at is not null
 or i.control_scope is distinct from 'ACCOUNT_ENTRY_HOLD' or i.exchange is distinct from 'binance_futures' or i.account_scope is distinct from 'futures'
 or coalesce(i.status,'') not in ('OPEN','VERIFYING') then return jsonb_build_object('resolved',false,'reason','INCIDENT_CAS_MISS');end if;
 if s.pause_new_entries is distinct from true or s.mode is distinct from 'LIVE_LIMITED' or r.live_enabled is distinct from true or r.protection_health is distinct from 'FLAT'
 or s.withdrawal_mode is distinct from false or s.manual_intervention_required is distinct from false
 or s.scalp_kill_switch is distinct from false or s.emergency_liquidation is distinct from false or s.pause_lock_reason is not null
 or not exists(select 1 from public.v17_operator_control where singleton and entry_enabled and legacy_entries_retired)
 or not exists(select 1 from public.deterministic_control where singleton and enabled and generation=2 and version='DETERMINISTIC_DYNAMIC_STATE_1')
 or exists(select 1 from public.leader20_batch_control where singleton and enabled)
 or exists(select 1 from public.gpt_final_review_control where singleton and mode<>'OFF')
 then return jsonb_build_object('resolved',false,'reason','PAUSED_DETERMINISTIC_PERMISSION_REQUIRED');end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 select * into o from public.v11_long_regime_orders where id=p_order_id;
 if o.id is null or o.intent is distinct from 'OPEN_LONG' or o.state is distinct from 'REJECTED' or o.exchange_order_id is not null
 or o.response_payload->>'v18ExposureFinal' is distinct from 'true'
 or o.response_payload#>>'{v18EntryNeverPlaced,neverPlaced}' is distinct from 'true'
 or o.response_payload#>>'{v18EntryNeverPlaced,source}' is distinct from 'BINANCE_FUTURES_ORDER_AND_POSITION_REST'
 or not exists(select 1 from jsonb_array_elements(coalesce(i.evidence->'issues','[]')) x where x->>'orderId'=o.id::text and x->>'symbol'=o.symbol)
 or exists(select 1 from public.v11_long_regime_positions where state='OPEN')
 or exists(select 1 from public.v11_long_regime_positions p where p.state='CLOSED' and
   (p.metadata->>'exitAccountingPending'='true' or p.metadata->>'v18EntryAccountingPending'='true' or exists(
     select 1 from jsonb_array_elements(coalesce(p.metadata#>'{exitProtection,orders}','[]')) x where x->>'terminal' is distinct from 'true')))
 or exists(select 1 from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','SUBMITTING','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED'))
 or exists(select 1 from public.v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and resolved_at is null and status in ('OPEN','VERIFYING') and id<>i.id)
 then return jsonb_build_object('resolved',false,'reason','NEVER_PLACED_FLAT_TRUTH_REQUIRED');end if;
 proof:=p_evidence->'proof';obs:=p_evidence#>>'{observation,id}';
 seen:=to_timestamp((p_evidence#>>'{observation,requested_at_ms}')::double precision/1000);
 if obs is null or obs='' or seen is null or p_evidence#>>'{observation,source}' is distinct from 'BINANCE_ACCOUNT_REST'
 or p_evidence#>>'{observation,received_at_ms}' is null
 or (p_evidence#>>'{observation,received_at_ms}')::double precision<(p_evidence#>>'{observation,requested_at_ms}')::double precision
 or p_evidence->>'positionsComplete' is distinct from 'true' or p_evidence->'positions' is distinct from '[]'::jsonb
 or p_evidence->>'ordersComplete' is distinct from 'true' or p_evidence->'orders' is distinct from '[]'::jsonb or p_evidence->'algos' is distinct from '[]'::jsonb
 or proof->>'source' is distinct from 'BINANCE_FUTURES_ORDER_AND_POSITION_REST' or proof->>'market' is distinct from o.symbol or proof->>'identifier' is distinct from o.client_order_id
 or proof->>'proven' is distinct from 'true' or proof->>'found' is distinct from 'false'
 or proof->>'lookup_code' is distinct from '-2013' or proof->>'position_read_ok' is distinct from 'true' or proof->>'trade_read_ok' is distinct from 'true'
 or proof->>'position_quantity' is distinct from '0' or proof->>'recent_trade_count' is distinct from '0'
 or proof->>'observed_at_ms' is null or p_evidence->>'ordersObservedAt' is null
 or seen<clock_timestamp()-interval '5 seconds' or seen>clock_timestamp()+interval '1 second'
 or to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)<clock_timestamp()-interval '8 seconds'
 or to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)>clock_timestamp()+interval '1 second'
 or to_timestamp((proof->>'observed_at_ms')::double precision/1000)<clock_timestamp()-interval '5 seconds'
 or to_timestamp((proof->>'observed_at_ms')::double precision/1000)>clock_timestamp()+interval '1 second'
 then return jsonb_build_object('resolved',false,'reason','SIGNED_RECOVERY_EVIDENCE_INCOMPLETE');end if;
 if obs=i.last_observation_id or seen<i.last_observed_at+interval '50 seconds' then return jsonb_build_object('resolved',false,'reason','OBSERVATION_NOT_INDEPENDENT','checks',i.clean_checks);end if;
 checks:=case when i.last_observed_at is null or seen<=i.last_observed_at+interval '90 seconds' then coalesce(i.clean_checks,0)+1 else 1 end;
 update public.v18_ops_incidents set clean_checks=checks,first_clean_at=case when checks=1 then seen else first_clean_at end,
 last_observation_id=obs,last_observed_at=seen,last_checked_at=clock_timestamp(),
 resolution_evidence=coalesce(resolution_evidence,'{}')||jsonb_build_object('pausedNeverPlacedRecovery',p_evidence) where id=i.id;
 update public.v11_long_regime_runtime set incident_last_checked_at=clock_timestamp() where singleton;
 if checks<3 or i.first_clean_at is null or seen<i.first_clean_at+interval '110 seconds' then return jsonb_build_object('resolved',false,'reason','VERIFYING','checks',checks);end if;
 update public.v11_long_regime_runtime set circuit_open=false,circuit_reason=null,last_error=null,incident_resolved_at=clock_timestamp(),entry_block_reason='RECOVERED_ENTRIES_STILL_PAUSED',updated_at=clock_timestamp()
 where singleton and incident_id=p_incident_id and incident_generation=p_generation;
 update public.v18_ops_incidents set status='RESOLVED',resolved_at=clock_timestamp() where id=i.id and generation=p_generation;
 return jsonb_build_object('resolved',true,'incidentId',i.id,'checks',checks,'entriesPaused',true);
end $$;
revoke all on function public.deterministic_paused_never_placed_recovery(uuid,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.deterministic_paused_never_placed_recovery(uuid,uuid,bigint,uuid,jsonb) to service_role;
