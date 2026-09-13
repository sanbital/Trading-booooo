-- Narrow the reconciled-incident recovery check to the exact exit order/trade set.
-- Entry fills can legitimately remain PENDING after their fee was durably reflected
-- in v18SettledPnl; they are not evidence that the later exit settlement is incomplete.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.v18_recovery_observation(p_owner uuid,p_incident_id uuid,p_generation bigint,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='500ms' as $$
declare r public.v11_long_regime_runtime%rowtype;i public.v18_ops_incidents%rowtype;
 c public.v17_operator_control%rowtype;s public.trading_settings%rowtype;
 seen timestamptz;obs text;expected jsonb;actual jsonb;checks integer;settlement jsonb;target_id uuid;
begin
 perform public.v18_require_lease(p_owner);
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 if not r.circuit_open or r.incident_id is distinct from p_incident_id or r.incident_generation<>p_generation then
   return jsonb_build_object('resolved',false,'reason','INCIDENT_CAS_MISS');end if;
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.generation is distinct from r.incident_generation or i.reason is distinct from r.circuit_reason or i.kind is distinct from r.incident_kind then
   return jsonb_build_object('resolved',false,'reason','MANUAL_REVIEW_REQUIRED');end if;
 if i.kind='UNEXPLAINED_EXPOSURE' then
   settlement:=i.resolution_evidence->'settlement';target_id:=nullif(settlement->>'positionId','')::uuid;
   if settlement->>'status'<>'SETTLED' or coalesce((settlement->>'recoveryEligible')::boolean,false) is not true or
      coalesce((settlement->>'accountingComplete')::boolean,false) is not true or settlement->>'incidentId'<>i.id::text or
      (settlement->>'generation')::bigint<>i.generation or target_id is null or
      settlement#>>'{evidence,exchangeOrderId}' is null or
      jsonb_typeof(settlement#>'{evidence,tradeIds}') is distinct from 'array' or
      jsonb_array_length(settlement#>'{evidence,tradeIds}')=0 or
      not exists(select 1 from public.v11_long_regime_positions p where p.id=target_id and p.state='CLOSED' and p.remaining_quantity=0 and
        p.metadata#>>'{v18ExternalExit,status}'='SETTLED' and p.metadata#>>'{v18ExternalExit,evidenceKey}'=settlement->>'evidenceKey' and
        p.metadata#>>'{v18ExternalExit,exchangeOrderId}'=settlement#>>'{evidence,exchangeOrderId}') or
      exists(select 1 from jsonb_array_elements_text(settlement#>'{evidence,tradeIds}') t where
        (select count(*) from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
          f.market=settlement#>>'{evidence,symbol}' and f.exchange_order_id=settlement#>>'{evidence,exchangeOrderId}' and
          f.exchange_trade_id::text=t.value and f.v17_position_id=target_id and f.accounting_status='ACCOUNTED')<>1) or
      exists(select 1 from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
        f.market=settlement#>>'{evidence,symbol}' and f.exchange_order_id=settlement#>>'{evidence,exchangeOrderId}' and
        not exists(select 1 from jsonb_array_elements_text(settlement#>'{evidence,tradeIds}') t where t.value=f.exchange_trade_id::text)) then
     return jsonb_build_object('resolved',false,'reason','MANUAL_REVIEW_REQUIRED');end if;
 elsif i.kind not in ('KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION','INCOMPLETE_OR_STALE_SNAPSHOT','TRANSIENT_DEPENDENCY','ACCOUNTING_DETAILS_PENDING','DB_CAS_CONFLICT') then
   return jsonb_build_object('resolved',false,'reason','MANUAL_REVIEW_REQUIRED');end if;
 select * into strict c from public.v17_operator_control where singleton for share;
 select * into strict s from public.trading_settings where id=1 for share;
 if r.live_enabled is not true or c.entry_enabled is not true or c.legacy_entries_retired is not true or s.mode is distinct from 'LIVE_LIMITED' or
   s.pause_new_entries is distinct from false or s.withdrawal_mode is distinct from false or s.manual_intervention_required is distinct from false or
   s.scalp_kill_switch is distinct from false or s.emergency_liquidation is distinct from false or s.pause_lock_reason is not null then
   update public.v18_ops_incidents set clean_checks=0,first_clean_at=null where id=i.id;
   return jsonb_build_object('resolved',false,'reason','OPERATOR_HALT');end if;
 seen:=to_timestamp((p_evidence#>>'{observation,requested_at_ms}')::double precision/1000);obs:=p_evidence#>>'{observation,id}';
 if obs is null or obs='' or p_evidence#>>'{observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or
   jsonb_typeof(p_evidence->'positions') is distinct from 'array' or p_evidence#>>'{observation,received_at_ms}' is null or
   (p_evidence#>>'{observation,received_at_ms}')::double precision<(p_evidence#>>'{observation,requested_at_ms}')::double precision or
   p_evidence->>'ordersObservedAt' is null or seen is null or seen<clock_timestamp()-interval '5 seconds' or seen>clock_timestamp()+interval '1 second' or
   to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)>clock_timestamp()+interval '1 second' or
   to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)<clock_timestamp()-interval '8 seconds' then
   return jsonb_build_object('resolved',false,'reason','STALE_EVIDENCE');end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at,'quantity',remaining_quantity) order by id),'[]') into actual
 from public.v11_long_regime_positions where state='OPEN';
 select coalesce(jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'updated_at',(x->>'updated_at')::timestamptz,'quantity',(x->>'quantity')::numeric) order by x->>'id'),'[]') into expected
 from jsonb_array_elements(p_evidence->'positions') x;
 if actual is distinct from expected or exists(select 1 from public.v11_long_regime_orders where
   state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED') and coalesce(response_payload->>'v18ExposureFinal','false')<>'true') then
   update public.v18_ops_incidents set clean_checks=0,first_clean_at=null where id=i.id;
   return jsonb_build_object('resolved',false,'reason','EXPOSURE_CHANGED');end if;
 if seen<clock_timestamp()-interval '5 seconds' then return jsonb_build_object('resolved',false,'reason','STALE_EVIDENCE_AFTER_LOCK');end if;
 if obs=i.last_observation_id or seen<i.last_observed_at+interval '50 seconds' then
   return jsonb_build_object('resolved',false,'reason','OBSERVATION_NOT_INDEPENDENT','checks',i.clean_checks);end if;
 checks:=case when i.last_observed_at is null or seen<=i.last_observed_at+interval '90 seconds' then i.clean_checks+1 else 1 end;
 update public.v18_ops_incidents set clean_checks=checks,first_clean_at=case when checks=1 then seen else first_clean_at end,
   last_observation_id=obs,last_observed_at=seen,last_checked_at=clock_timestamp(),
   resolution_evidence=coalesce(resolution_evidence,'{}')||jsonb_build_object('recovery',p_evidence) where id=i.id;
 update public.v11_long_regime_runtime set incident_last_checked_at=clock_timestamp() where singleton;
 if checks<3 or i.first_clean_at is null or seen<i.first_clean_at+interval '110 seconds' then
   return jsonb_build_object('resolved',false,'reason','VERIFYING','checks',checks);end if;
 update public.v11_long_regime_runtime set circuit_open=false,circuit_reason=null,last_error=null,
   incident_resolved_at=clock_timestamp(),entry_block_reason='RECOVERED_WAITING_FOR_STRATEGY',updated_at=clock_timestamp()
 where singleton and incident_id=p_incident_id and incident_generation=p_generation;
 update public.v18_ops_incidents set resolved_at=clock_timestamp() where id=i.id;
 return jsonb_build_object('resolved',true,'incidentId',i.id,'checks',checks,'scope','V18_RECOVERY_EXIT_FILL_SCOPE_1');
end $$;

revoke all on function public.v18_recovery_observation(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.v18_recovery_observation(uuid,uuid,bigint,jsonb) to service_role;
commit;
