-- Exact user-confirmed external holding. Keep the circuit until normal recovery.
begin;
set local lock_timeout='500ms';
set local statement_timeout='3000ms';
select set_config('trading.manual_review',__REVIEW_JSON__,true);
do $review$
declare a jsonb:=current_setting('trading.manual_review')::jsonb;
 e jsonb:=a->'evidence';r public.v11_long_regime_runtime%rowtype;
 s public.trading_settings%rowtype;owner_id uuid:=(a->>'owner')::uuid;
 result jsonb;seen timestamptz;
begin
 if a->>'version' is distinct from 'USER_CONFIRMED_GTC_20261004_1' or
    a->>'attestation' is distinct from 'USER_CONFIRMED_DIRECT_ORDER' or
    length(a->>'commit')<>40 or
    (a->>'postmaster')::timestamptz is distinct from pg_postmaster_start_time() then
   raise exception 'MANUAL_REVIEW_IDENTITY_OR_RESTART';end if;
 if not public.v17_acquire_execution_lease(owner_id) then raise exception 'MANUAL_REVIEW_WRITER_BUSY';end if;
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 select * into strict s from public.trading_settings where id=1 for update;
 if r.circuit_open is not true or r.incident_id is distinct from '4959917c-987c-4bf5-b85b-8942808c20c2'::uuid or
    r.incident_generation<>199 or r.incident_kind is distinct from 'EXCHANGE_ONLY_POSITION' or
    r.circuit_reason is distinct from 'ACCOUNT_RISK_BLOCK:EXCHANGE_ONLY_POSITION:GTCUSDT' then
   raise exception 'MANUAL_REVIEW_INCIDENT_CAS';end if;
 if r.live_enabled is not true or s.mode is distinct from 'LIVE_LIMITED' or
    s.pause_new_entries is not true or s.pause_lock_reason is distinct from 'P10_UNTRACKED_FUTURES_EXPOSURE' or
    s.manual_event_reason is distinct from 'P10_UNTRACKED_FUTURES_EXPOSURE' or
    coalesce(s.emergency_liquidation,true) or coalesce(s.withdrawal_mode,true) or
    coalesce(s.scalp_kill_switch,true) or coalesce(s.manual_intervention_required,true) or
    not exists(select 1 from public.v17_operator_control where singleton and entry_enabled and legacy_entries_retired) then
   raise exception 'MANUAL_REVIEW_OTHER_OPERATOR_HALT';end if;
 seen:=to_timestamp((e#>>'{portfolio,observation,requested_at_ms}')::double precision/1000);
 if e#>>'{portfolio,exchange}' is distinct from 'binance_futures' or
    e#>>'{portfolio,account_scope}' is distinct from 'futures' or
    e#>>'{portfolio,positions_complete}' is distinct from 'true' or
    e#>>'{portfolio,observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or
    e#>>'{portfolio,observation,id}' is null or seen is null or
    seen<clock_timestamp()-interval '3 seconds' or seen>clock_timestamp()+interval '1 second' or
    e#>>'{portfolio,observation,received_at_ms}' is null or
    (e#>>'{portfolio,observation,received_at_ms}')::double precision < (e#>>'{portfolio,observation,requested_at_ms}')::double precision or
    jsonb_array_length(e#>'{portfolio,positions}') is distinct from 1 or
    e#>>'{portfolio,positions,0,market}' is distinct from 'GTCUSDT' or
    e#>>'{portfolio,positions,0,side}' is distinct from 'LONG' or
    (e#>>'{portfolio,positions,0,quantity}')::numeric is distinct from 1944.6 or
    e#>>'{openOrders,complete}' is distinct from 'true' or
    e#>'{openOrders,orders}' is distinct from '[]'::jsonb or
    e#>'{openOrders,algos}' is distinct from '[]'::jsonb or
    e#>>'{openOrders,observed_at_ms}' is null or
    to_timestamp((e#>>'{openOrders,observed_at_ms}')::double precision/1000)<clock_timestamp()-interval '5 seconds' then
   raise exception 'MANUAL_REVIEW_FRESH_EXACT_HOLDING_REQUIRED';end if;
 if e#>>'{order,exchange_order_id}' is distinct from '4634347872' or
    upper(e#>>'{order,status}') is distinct from 'FILLED' or
    (e#>>'{order,executed_volume}')::numeric is distinct from 1944.6 then
   raise exception 'MANUAL_REVIEW_EXACT_FILL_REQUIRED';end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 if exists(select 1 from public.v11_long_regime_positions where state<>'CLOSED') or
    exists(select 1 from public.trading_positions where is_paper=false and state not in ('CLOSED','CANCELLED','ERROR')) or
    exists(select 1 from public.v10_lane_positions where state<>'CLOSED') or
    exists(select 1 from public.v11_long_regime_orders where state in ('PLANNED','DISPATCHED','PARTIALLY_FILLED','UNKNOWN','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and coalesce(response_payload->>'v18ExposureFinal','false')<>'true') then
   raise exception 'MANUAL_REVIEW_BOT_EXPOSURE_CHANGED';end if;
 if (select count(*) from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and market='GTCUSDT' and exchange_order_id='4634347872' and side='BUY' and bot_order_id is null and position_id is null and v17_order_id is null and v17_position_id is null)<>11 or
    (select sum(quantity) from public.exchange_trade_fills where exchange='binance_futures' and account_scope='futures' and market='GTCUSDT' and exchange_order_id='4634347872') is distinct from 1944.6 then
   raise exception 'MANUAL_REVIEW_LEDGER_IDENTITY_CHANGED';end if;
 if exists(select 1 from public.trading_asset_locks where exchange='binance_futures' and asset='GTC') then
   raise exception 'MANUAL_REVIEW_ALLOWANCE_ALREADY_EXISTS';end if;
 insert into public.trading_asset_locks(exchange,asset,state,reason,metadata)
 values('binance_futures','GTC','LOCKED','USER_CONFIRMED_MANUAL_POSITION',
   jsonb_build_object('v17ManualPosition',true,'side','LONG','maxQuantity',1944.6,
     'source','USER_CONFIRMED_DIRECT_ORDER_2026_10_04','exchangeOrderId','4634347872',
     'operatorReview',a,'botManagementAuthorized',false));
 result:=public.v19_record_incident(owner_id,'ACCOUNTING_DETAILS_PENDING',
   'MANUAL_POSITION_ATTRIBUTED_PENDING_ACCOUNT_VERIFICATION:GTCUSDT','ACCOUNT_ENTRY_HOLD',null,
   '{"exposureState":"HELD","accountingState":"ATTRIBUTION_INVESTIGATING","orderSource":"MANUAL_EXTERNAL","recheck":["VERIFY_BOUNDED_MANUAL_ALLOWANCE","FRESH_COMPLETE_ACCOUNT_SNAPSHOT","FRESH_COMPLETE_OPEN_ORDERS"]}'::jsonb,
   jsonb_build_object('operatorReview',a,'reviewedIncident',r.incident_id,'circuitRetained',true,
     'manualFillAccountingUnchanged',true),'V19-SCOPE-AWARE-ENTRY-1');
 update public.v18_ops_incidents set resolution_evidence=coalesce(resolution_evidence,'{}')||
   jsonb_build_object('manualAttributionReview',a,'replacement',result) where id=r.incident_id;
 perform public.v17_release_execution_lease(owner_id);
end $review$;
select circuit_open,incident_id,incident_generation,incident_kind from public.v11_long_regime_runtime where singleton;
commit;
