-- APPROVAL REQUIRED. Never invoked by a migration, scheduler or deployment workflow.
-- Only for the reviewed TAC/SAGA legacy incident with a currently verified FLAT account.
-- psql variables: owner_uuid, expected_updated_at, evidence_json (fresh signed gateway reads).
-- evidence_json: {portfolio:<full p10_portfolio>,openOrders:<full v18_open_orders>}
-- The incident stays OPEN; the normal executor still needs three independent checks.
begin;
set local lock_timeout='500ms';
set local statement_timeout='3000ms';
select set_config('v18.approval',jsonb_build_object(
 'owner',:'owner_uuid','expectedUpdatedAt',:'expected_updated_at',
 'evidence',:'evidence_json'::jsonb)::text,true);
do $$
declare a jsonb:=current_setting('v18.approval')::jsonb;
 e jsonb:=a->'evidence'; r public.v11_long_regime_runtime%rowtype;
 seen timestamptz; owner_id uuid:=(a->>'owner')::uuid;
begin
 if not public.v17_acquire_execution_lease(owner_id) then raise exception 'APPROVAL_LEASE_BUSY'; end if;
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 if r.updated_at is distinct from (a->>'expectedUpdatedAt')::timestamptz or r.circuit_open is not true or
    r.circuit_reason is distinct from 'BULL_EXTERNAL_EXPOSURE:COUNT:1:2:SAGAUSDT' or
    r.last_error is distinct from 'EXTERNAL_POSITION' or r.incident_id is not null or r.incident_generation<>0 then
   raise exception 'APPROVAL_INCIDENT_CAS_MISS';
 end if;
 perform 1 from public.v17_operator_control where singleton for share;
 perform 1 from public.trading_settings where id=1 for share;
 if r.live_enabled is not true or not exists(select 1 from public.v17_operator_control where singleton and entry_enabled and legacy_entries_retired) or
    not exists(select 1 from public.trading_settings where id=1 and mode='LIVE_LIMITED' and
      not coalesce(pause_new_entries,true) and not coalesce(scalp_kill_switch,true) and
      not coalesce(withdrawal_mode,true) and not coalesce(manual_intervention_required,true) and
      not coalesce(emergency_liquidation,true) and pause_lock_reason is null) then raise exception 'APPROVAL_OPERATOR_HALT'; end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 seen:=to_timestamp((e#>>'{portfolio,observation,requested_at_ms}')::double precision/1000);
 if e#>>'{portfolio,exchange}' is distinct from 'binance_futures' or e#>>'{portfolio,account_scope}' is distinct from 'futures' or
    e#>>'{portfolio,positions_complete}' is distinct from 'true' or e#>'{portfolio,positions}' is distinct from '[]'::jsonb or
    e#>>'{portfolio,observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or e#>>'{portfolio,observation,id}' is null or
    seen is null or seen<clock_timestamp()-interval '5 seconds' or seen>clock_timestamp()+interval '1 second' or
    e#>>'{openOrders,complete}' is distinct from 'true' or e#>'{openOrders,orders}' is distinct from '[]'::jsonb or e#>'{openOrders,algos}' is distinct from '[]'::jsonb or
    e#>>'{openOrders,observed_at_ms}' is null or
    to_timestamp((e#>>'{openOrders,observed_at_ms}')::double precision/1000)<clock_timestamp()-interval '5 seconds' or
    to_timestamp((e#>>'{openOrders,observed_at_ms}')::double precision/1000)>clock_timestamp()+interval '1 second' then raise exception 'APPROVAL_FRESH_FLAT_EVIDENCE_MISSING'; end if;
 if exists(select 1 from public.v11_long_regime_positions where state='OPEN') or
    exists(select 1 from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','RECONCILIATION_FAILED','RECONCILIATION_PENDING') and coalesce(response_payload->>'v18ExposureFinal','false')<>'true') then raise exception 'APPROVAL_EXPOSURE_CHANGED'; end if;
 if (select count(*) from public.v11_long_regime_positions where
      (id='9d21a501-0b4a-4230-826b-6ca2d37d66e8' and symbol='TACUSDT' and original_quantity=64310 or
       id='794da229-cdce-4d41-800d-578f92d03f56' and symbol='SAGAUSDT' and original_quantity=7067.3)
      and state='CLOSED' and remaining_quantity=0)<>2 then raise exception 'APPROVAL_TERMINAL_EVIDENCE_MISSING'; end if;
 if (select sum(quantity) from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and market='TACUSDT' and exchange_order_id='1179849258' and exchange_trade_id in (116576836,116576837,116576838) and side='SELL') is distinct from 64310::numeric or
    (select sum(quantity) from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and market='SAGAUSDT' and exchange_order_id='4882990988' and exchange_trade_id=311493537 and side='SELL') is distinct from 7067.3::numeric then raise exception 'APPROVAL_FILL_EVIDENCE_MISSING'; end if;
 perform public.v18_record_incident(owner_id,'KNOWN_EXIT_PENDING_RECONCILIATION','APPROVED_TAC_NATIVE_CLOSE_RECONCILED',e);
 perform public.v17_release_execution_lease(owner_id);
end $$;
select incident_id,incident_generation,circuit_open,incident_kind from public.v11_long_regime_runtime where singleton;
commit;
