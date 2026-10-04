-- A new PLANNED intent has a SQL NULL response_payload in production.
-- NULL || jsonb is NULL: persist the proof before claiming a successful submit.
-- All ownership, generation, hash, current BUY, capture and reservation gates stay.
begin;
set local lock_timeout='500ms';
set local statement_timeout='3000ms';
CREATE OR REPLACE FUNCTION public.deterministic_begin_submit(p_order_id uuid, p_owner uuid, p_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o public.v11_long_regime_orders%rowtype;l public.v17_execution_lease%rowtype;
 a jsonb;t timestamptz:=clock_timestamp();stamp jsonb;
begin
 if public.v17_verify_execution_lease(p_owner) is distinct from true then return jsonb_build_object('updated',false,'reason','WRITER_FENCED');end if;
 select * into l from public.v17_execution_lease where singleton and owner=p_owner;
 if (public.v17_account_recovery_state()->>'ready') is distinct from 'true' then return jsonb_build_object('updated',false,'reason','RECONCILIATION_FIRST_ENTRY_FROZEN');end if;
 select * into o from public.v11_long_regime_orders where id=p_order_id for update;
 if o.id is null or o.intent<>'OPEN_LONG' or o.state<>'PLANNED' or o.exchange_order_id is not null
  or o.request_payload#>>'{deterministic,version}' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1'
  then return jsonb_build_object('updated',false,'reason','ORDER_IDENTITY_NOT_PLANNED');end if;
 a:=public.deterministic_entry_authority(o.signal_id);
 if a->>'allowed' is distinct from 'true' then return jsonb_build_object('updated',false,'reason',a->>'reason','authority',a);end if;
 if p_state->>'version' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1'
  or p_state->>'decision' is distinct from 'BUY' or p_state->>'setup' is distinct from 'PASS'
  or p_state->>'confirmation' is distinct from 'PASS'
  or coalesce(p_state->>'trigger','WAIT') not in ('BREAKOUT','PULLBACK_RECOVERY','LOCAL_HIGH_RECLAIM','MOMENTUM_REACCELERATION')
  or coalesce(p_state->>'at','') !~ '^[0-9]+$' or coalesce(p_state->>'capture_end_ms','') !~ '^[0-9]+$'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_NOT_EXECUTABLE','authority',a);end if;
 t:=clock_timestamp();
 if to_timestamp((p_state->>'at')::numeric/1000)>t or t-to_timestamp((p_state->>'at')::numeric/1000)>=interval '3 seconds'
  or to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>t
  or t-to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>=interval '10 seconds'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_STALE','authority',a,'validated_at',t,'state_at_ms',p_state->'at','capture_end_ms',p_state->'capture_end_ms');end if;
 if not exists(select 1 from public.leader20_entry_reservations r where r.signal_id=o.signal_id and r.symbol=o.symbol
  and r.state in ('RESERVED','ORDER_PENDING') and r.expires_at>t) then return jsonb_build_object('updated',false,'reason','CAPACITY_RESERVATION_MISSING');end if;
 if o.request_payload->>'entry_ioc_attempt'='2' and not exists(
  select 1 from public.v11_long_regime_orders first_order where first_order.id::text=o.request_payload->>'retry_of_order_id'
   and first_order.signal_id=o.signal_id and first_order.state in ('EXPIRED','CANCELED','REJECTED','PARTIALLY_FILLED_CANCELED')
   and first_order.response_payload#>>'{v22EntryFinality,finalStatus}' in ('EXPIRED','CANCELED','CANCELLED','REJECTED','PARTIALLY_FILLED_CANCELED')
  ) then return jsonb_build_object('updated',false,'reason','PRIOR_ORDER_RECONCILIATION_REQUIRED');end if;
 stamp:=jsonb_build_object('version','DETERMINISTIC_DYNAMIC_STATE_1','owner',l.owner,'fence',l.fence,
  'postmaster_at',pg_postmaster_start_time(),'submitted_at',t,'state_at_ms',p_state->'at',
  'capture_end_ms',p_state->'capture_end_ms','generation',a->'generation','authority',a,'execution_key',public.deterministic_order_key(jsonb_build_object('exchange','binance_futures','action','create_order','order',o.request_payload->'order','leverage',o.request_payload->'leverage')));
 update public.v11_long_regime_orders set response_payload=coalesce(response_payload,'{}'::jsonb)||jsonb_build_object('deterministic_submission',stamp),updated_at=t where id=o.id;
 return jsonb_build_object('updated',true,'order_id',o.id,'proof',stamp);
end $function$;

commit;
