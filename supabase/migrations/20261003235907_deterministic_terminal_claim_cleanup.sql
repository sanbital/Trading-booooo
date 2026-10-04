create or replace function public.deterministic_recover_claims()
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare item record;ids jsonb:='[]';t timestamptz:=clock_timestamp();why text;has_intent boolean;
begin
 for item in select id,symbol,features,updated_at from public.v11_long_regime_signals
  where status='CLAIMED' and features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1'
   and updated_at<t-interval '150 seconds' order by updated_at limit 20 for update skip locked
 loop
  perform pg_advisory_xact_lock(hashtextextended('deterministic-symbol:'||item.symbol,0));
  if exists(select 1 from public.v11_long_regime_orders where signal_id=item.id and (
     state in ('REJECTED','EXPIRED') and (response_payload->>'notDispatched'='true' or
       response_payload->>'v18ExposureFinal'='true' and response_payload#>>'{orderStateEvidence,executedQty}'='0'
       and response_payload#>>'{positionReconciliation,actualPositionQty}'='0'
       and response_payload#>>'{positionReconciliation,positionsComplete}'='true')) is not true)
   or exists(select 1 from public.v11_long_regime_positions where signal_id=item.id and state='OPEN')
   or exists(select 1 from public.v17_analysis_lease where singleton and owner::text=item.features#>>'{executionClaim,analysis_owner}'
     and expires_at>t and postmaster_started_at=pg_postmaster_start_time())
   or exists(select 1 from public.v17_execution_lease where singleton and owner::text=item.features#>>'{executionClaim,writer_owner}'
     and expires_at>t and postmaster_started_at=pg_postmaster_start_time()) then continue;end if;
  has_intent:=exists(select 1 from public.v11_long_regime_orders where signal_id=item.id);
  why:=case when has_intent then 'CLAIM_RECOVERED_FINAL_NO_EXPOSURE' else 'CLAIM_RECOVERED_NO_ORDER_INTENT' end;
  update public.v11_long_regime_signals set status='REJECTED',reject_reason=why,
   features=features||jsonb_build_object('entryExecution',jsonb_build_object('version','ENTRY_BOUNDARY_EVIDENCE_1',
    'signal_id',item.id,'reason',why,'category','AUTHORITY_OR_STATE',
    'phase',case when has_intent then 'FINAL_NO_EXPOSURE' else 'PRE_SEND' end,'not_dispatched',not has_intent,'cancelled_at',t,'proof','DURABLE_INTENT_REQUIRED_BEFORE_TRANSPORT')),
   updated_at=t where id=item.id and status='CLAIMED' and updated_at=item.updated_at;
  update public.leader20_entry_reservations set state='RELEASED',reason=why,settled_at=t,updated_at=t
   where signal_id=item.id and state in ('RESERVED','ORDER_PENDING');
  ids:=ids||jsonb_build_array(item.id);
 end loop;
 return jsonb_build_object('recovered',ids,'at',t);
end $fn$;
revoke all on function public.deterministic_recover_claims() from public,anon,authenticated;
grant execute on function public.deterministic_recover_claims() to service_role;
