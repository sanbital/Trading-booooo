-- Evidence-gated repair for DB-only V17 positions and stale native stops.
-- This migration does not reset a circuit, change operator controls, or submit/cancel
-- an exchange order.  Settlement remains fenced by the existing execution lease and
-- exact incident generation; circuit recovery still requires three fresh observations.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.v18_closed_protection_backlog(p_limit integer default 100)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_limit<1 or p_limit>1000 then raise exception 'CLOSED_PROTECTION_LIMIT'; end if;
 with backlog as (
   select p.* from public.v11_long_regime_positions p
   where p.state='CLOSED' and (coalesce((p.metadata->>'exitAccountingPending')::boolean,false) or exists(
     select 1 from jsonb_array_elements(coalesce(p.metadata#>'{exitProtection,orders}','[]')) o
     where coalesce((o->>'terminal')::boolean,false) is not true))
   order by p.updated_at asc,p.id asc limit p_limit+1
 ),page as (select * from backlog order by updated_at asc,id asc limit p_limit)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at,x.id) from page x),'[]'),
   'complete',(select count(*)<=p_limit from backlog)) into result;
 return result;
end $$;

-- The general attribution trigger can identify the source lifecycle of a native stop.
-- A stale stop, however, executed against a later lifecycle.  This alphabetically-last
-- BEFORE trigger overrides only a previously persisted, exact cross-lifecycle receipt.
create or replace function public.v18_apply_reconciled_fill_owner()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare owner_count integer; owner_id uuid; owner_signal uuid; x jsonb;
begin
 if new.exchange is distinct from 'binance_futures' or new.account_scope is distinct from 'futures' or
    new.exchange_order_id is null or new.exchange_trade_id is null then return new; end if;
 select count(*) into owner_count
 from public.v11_long_regime_positions p
 where p.symbol=new.market and p.metadata#>>'{v18ExternalExit,status}'='SETTLED' and
   p.metadata#>>'{v18ExternalExit,exchangeOrderId}'=new.exchange_order_id and
   exists(select 1 from jsonb_array_elements_text(coalesce(p.metadata#>'{v18ExternalExit,tradeIds}','[]')) t
          where t.value=new.exchange_trade_id::text);
 if owner_count<>1 then return new; end if;
 select p.id,p.signal_id,p.metadata->'v18ExternalExit' into owner_id,owner_signal,x
 from public.v11_long_regime_positions p
 where p.symbol=new.market and p.metadata#>>'{v18ExternalExit,status}'='SETTLED' and
   p.metadata#>>'{v18ExternalExit,exchangeOrderId}'=new.exchange_order_id and
   exists(select 1 from jsonb_array_elements_text(coalesce(p.metadata#>'{v18ExternalExit,tradeIds}','[]')) t
          where t.value=new.exchange_trade_id::text)
 limit 1;
 new.v17_position_id:=owner_id;
 new.v17_order_id:=case when nullif(x->>'laneOrderId','') is null then null else (x->>'laneOrderId')::uuid end;
 new.bot_order_id:=null;new.position_id:=null;
 new.client_order_id:=nullif(x->>'clientOrderId','');
 new.source:=case when coalesce((x->>'strategyExit')::boolean,false) then 'AUTOMATED' else 'UNCLASSIFIED' end;
 new.accounting_status:='ACCOUNTED';
 return new;
end $$;
drop trigger if exists zz_v18_reconciled_fill_owner on public.exchange_trade_fills;
create trigger zz_v18_reconciled_fill_owner
before insert or update on public.exchange_trade_fills
for each row execute function public.v18_apply_reconciled_fill_owner();

create or replace function public.v18_settle_db_only_exit(
 p_owner uuid,p_incident_id uuid,p_generation bigint,p_position_id uuid,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='2s' as $$
declare
 r public.v11_long_regime_runtime%rowtype;i public.v18_ops_incidents%rowtype;
 p public.v11_long_regime_positions%rowtype;source_position public.v11_long_regime_positions%rowtype;
 lane_order public.v11_long_regime_orders%rowtype;stop_order jsonb;before_position jsonb;
 class text;evidence_key text;v_exit_reason text;client_id text;exchange_order text;
 source_id uuid;lane_id uuid;trade_count integer;matched_count integer;stop_count integer;
 q numeric;funds numeric;gross numeric;fees numeric;prior_pnl numeric;net_pnl numeric;exit_price numeric;
 v_closed_at timestamptz;seen timestamptz;new_metadata jsonb;recovery_eligible boolean;
begin
 perform public.v18_require_lease(p_owner);
 if p_evidence->>'version' is distinct from 'V18-DB-ONLY-EVIDENCE-1' then raise exception 'DB_ONLY_EVIDENCE_VERSION'; end if;
 class:=p_evidence->>'classification';
 if class not in ('VERIFIED_BOT_EXIT','VERIFIED_NATIVE_STOP','VERIFIED_STALE_NATIVE_STOP','VERIFIED_EXTERNAL_OR_UNATTRIBUTED_CLOSE') then
   raise exception 'DB_ONLY_EVIDENCE_CLASS';
 end if;
 evidence_key:=concat_ws(':',class,p_position_id::text,p_evidence->>'exchangeOrderId',(p_evidence->'tradeIds')::text);

 select * into strict p from public.v11_long_regime_positions where id=p_position_id for update;
 if p.state='CLOSED' and p.metadata#>>'{v18ExternalExit,evidenceKey}'=evidence_key then
   if p.remaining_quantity<>0 or p.metadata#>>'{v18ExternalExit,status}'<>'SETTLED' then raise exception 'DB_ONLY_IDEMPOTENCY_STATE'; end if;
   return jsonb_build_object('settled',true,'idempotent',true,'positionId',p.id,'evidenceKey',evidence_key,
     'realizedPnlUsdt',p.realized_pnl_usdt,'closedAt',p.closed_at);
 end if;
 if p.state<>'OPEN' or p.side<>'LONG' or p.remaining_quantity<=0 or
    p.metadata->>'executionMode'<>'LEADER_MOMENTUM_V17' or coalesce((p.metadata->>'v17ManualPosition')::boolean,false) then
   raise exception 'DB_ONLY_TARGET_STATE';
 end if;
 if p_evidence->>'targetPositionId' is distinct from p.id::text or
    p_evidence->>'targetSignalId' is distinct from p.signal_id::text or
    p_evidence->>'symbol' is distinct from p.symbol or
    p_evidence->>'entryOrderId' is distinct from p.metadata->>'entryOrderId' or
    (p_evidence->>'targetUpdatedAt')::timestamptz is distinct from p.updated_at or
    abs((p_evidence->>'targetRemainingQuantity')::numeric-p.remaining_quantity)>greatest(1e-10,p.remaining_quantity*1e-8) then
   raise exception 'DB_ONLY_TARGET_CAS';
 end if;
 if not exists(select 1 from public.v11_long_regime_orders o where o.position_id=p.id and o.signal_id=p.signal_id and
   o.symbol=p.symbol and o.intent='OPEN_LONG' and o.state in ('FILLED','RECONCILIATION_PENDING') and
   o.exchange_order_id=p.metadata->>'entryOrderId' and o.request_payload#>>'{order,side}'='BUY' and
   o.request_payload#>>'{order,position_side}'='LONG' and o.request_payload#>>'{order,position_effect}'='OPEN') then
   raise exception 'DB_ONLY_ENTRY_OWNERSHIP';
 end if;

 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 if not r.circuit_open or r.incident_id is distinct from p_incident_id or r.incident_generation<>p_generation or
    r.incident_kind not in ('UNEXPLAINED_EXPOSURE','KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION') then
   raise exception 'DB_ONLY_INCIDENT_CAS';
 end if;
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.generation<>p_generation or i.kind is distinct from r.incident_kind or i.reason is distinct from r.circuit_reason then
   raise exception 'DB_ONLY_INCIDENT_MISMATCH';
 end if;

 seen:=to_timestamp((p_evidence#>>'{portfolioObservation,requested_at_ms}')::double precision/1000);
 if p_evidence->>'exchange' is distinct from 'binance_futures' or p_evidence->>'accountScope' is distinct from 'futures' or
    p_evidence#>>'{portfolioObservation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or
    p_evidence#>>'{portfolioObservation,id}' is null or seen<clock_timestamp()-interval '8 seconds' or seen>clock_timestamp()+interval '1 second' or
    (p_evidence#>>'{portfolioObservation,received_at_ms}')::double precision<(p_evidence#>>'{portfolioObservation,requested_at_ms}')::double precision or
    to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)<clock_timestamp()-interval '8 seconds' or
    to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)>clock_timestamp()+interval '1 second' then
   raise exception 'DB_ONLY_STALE_LIVE_EVIDENCE';
 end if;

 exchange_order:=p_evidence->>'exchangeOrderId';client_id:=p_evidence->>'clientOrderId';
 q:=(p_evidence->>'quantity')::numeric;funds:=(p_evidence->>'funds')::numeric;
 gross:=(p_evidence->>'grossPnl')::numeric;fees:=(p_evidence->>'exitFee')::numeric;
 v_closed_at:=(p_evidence->>'closedAt')::timestamptz;exit_price:=(p_evidence->>'exitPrice')::numeric;
 if q<=0 or abs(q-p.remaining_quantity)>greatest(1e-10,p.remaining_quantity*1e-8) or funds<=0 or fees<0 or
    v_closed_at<=p.entry_at or abs(exit_price*q-funds)>greatest(1e-10,abs(funds)*1e-8) or
    p_evidence#>>'{order,orderId}' is distinct from exchange_order or p_evidence#>>'{order,clientOrderId}' is distinct from client_id or
    p_evidence#>>'{order,symbol}' is distinct from p.symbol or p_evidence#>>'{order,side}' is distinct from 'SELL' or
    p_evidence#>>'{order,positionSide}' is distinct from 'BOTH' or p_evidence#>>'{order,reduceOnly}' is distinct from 'true' or
    p_evidence#>>'{order,type}' is distinct from 'MARKET' or p_evidence#>>'{order,status}' is distinct from 'FILLED' or
    abs((p_evidence#>>'{order,origQty}')::numeric-q)>greatest(1e-10,q*1e-8) or
    abs((p_evidence#>>'{order,executedQty}')::numeric-q)>greatest(1e-10,q*1e-8) or
    abs((p_evidence#>>'{order,cumQuote}')::numeric-funds)>greatest(1e-10,funds*1e-8) then
   raise exception 'DB_ONLY_ORDER_PROOF';
 end if;
 if jsonb_typeof(p_evidence->'tradeIds')<>'array' or jsonb_array_length(p_evidence->'tradeIds')=0 then raise exception 'DB_ONLY_TRADE_IDS'; end if;
 perform 1 from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
   f.market=p.symbol and f.exchange_order_id=exchange_order for update;
 select count(*),coalesce(sum(f.quantity),0),coalesce(sum(f.quote_amount),0),coalesce(sum(f.realized_pnl_quote),0),
   coalesce(sum(f.fee_quote_amount),0),max(f.executed_at)
 into trade_count,q,funds,gross,fees,v_closed_at
 from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
   f.market=p.symbol and f.exchange_order_id=exchange_order and upper(f.side)='SELL';
 select count(*) into matched_count from jsonb_array_elements_text(p_evidence->'tradeIds') t
 where exists(select 1 from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
   f.market=p.symbol and f.exchange_order_id=exchange_order and f.exchange_trade_id::text=t.value and upper(f.side)='SELL');
 if trade_count<>jsonb_array_length(p_evidence->'tradeIds') or matched_count<>trade_count or
    abs(q-(p_evidence->>'quantity')::numeric)>greatest(1e-10,q*1e-8) or
    abs(funds-(p_evidence->>'funds')::numeric)>greatest(1e-10,abs(funds)*1e-8) or
    abs(gross-(p_evidence->>'grossPnl')::numeric)>greatest(1e-10,abs(gross)*1e-8) or
    abs(fees-(p_evidence->>'exitFee')::numeric)>greatest(1e-10,abs(fees)*1e-8) or
    v_closed_at is distinct from (p_evidence->>'closedAt')::timestamptz or
    exists(select 1 from public.exchange_trade_fills f where f.exchange='binance_futures' and f.account_scope='futures' and
      f.market=p.symbol and f.exchange_order_id=exchange_order and
      (f.v17_position_id is not null and f.v17_position_id not in (p.id,coalesce(nullif(p_evidence->>'sourcePositionId','')::uuid,p.id)))) then
   raise exception 'DB_ONLY_LEDGER_PROOF';
 end if;
 if abs(gross-(funds-p.entry_price*q))>greatest(1e-10,abs(gross)*1e-8) then raise exception 'DB_ONLY_GROSS_PNL_PROOF'; end if;
 if exists(select 1 from public.v11_long_regime_positions x where x.state='OPEN' and x.symbol=p.symbol and x.id<>p.id) then
   raise exception 'DB_ONLY_OVERLAPPING_LIFECYCLE';
 end if;

 source_id:=nullif(p_evidence->>'sourcePositionId','')::uuid;
 lane_id:=nullif(p_evidence->>'laneOrderId','')::uuid;
 if class='VERIFIED_BOT_EXIT' then
   if lane_id is null or source_id is not null then raise exception 'DB_ONLY_BOT_IDENTITY'; end if;
   select * into strict lane_order from public.v11_long_regime_orders where id=lane_id for update;
   if lane_order.position_id<>p.id or lane_order.client_order_id is distinct from client_id or
      lane_order.intent not in ('CLOSE_LONG','PARTIAL_CLOSE') or
      lane_order.request_payload#>>'{order,side}' is distinct from 'SELL' or
      lane_order.request_payload#>>'{order,position_side}' is distinct from 'LONG' or
      lane_order.request_payload#>>'{order,position_effect}' is distinct from 'CLOSE' or
      (lane_order.exchange_order_id is not null and lane_order.exchange_order_id<>exchange_order) then raise exception 'DB_ONLY_BOT_ORDER_PROOF'; end if;
 elsif class in ('VERIFIED_NATIVE_STOP','VERIFIED_STALE_NATIVE_STOP') then
   if source_id is null or lane_id is not null or p_evidence#>>'{algo,actualOrderId}' is distinct from exchange_order or
      p_evidence#>>'{algo,clientAlgoId}' is distinct from client_id or p_evidence#>>'{algo,status}' not in ('FINISHED','TRIGGERED') then
     raise exception 'DB_ONLY_ALGO_PROOF';
   end if;
   if source_id=p.id then source_position:=p; else
     select * into strict source_position from public.v11_long_regime_positions where id=source_id for update;
   end if;
   select count(*),(jsonb_agg(o)->0) into stop_count,stop_order
   from jsonb_array_elements(coalesce(source_position.metadata#>'{exitProtection,orders}','[]')) o
   where coalesce(o->>'clientId',o#>>'{spec,params,clientAlgoId}')=client_id and
     o#>>'{spec,params,symbol}'=p.symbol and o#>>'{spec,params,side}'='SELL' and
     o#>>'{spec,params,positionSide}'='BOTH' and o#>>'{spec,params,reduceOnly}'='true' and
     o->>'algoId'=p_evidence->>'algoId' and (o#>>'{spec,params,quantity}')::numeric+greatest(1e-10,q*1e-8)>=q;
   if stop_count<>1 then raise exception 'DB_ONLY_NATIVE_IDENTITY'; end if;
   if class='VERIFIED_NATIVE_STOP' and source_id<>p.id then raise exception 'DB_ONLY_NATIVE_TARGET'; end if;
   if class='VERIFIED_STALE_NATIVE_STOP' and (source_id=p.id or source_position.state<>'CLOSED' or
      source_position.remaining_quantity<>0 or source_position.closed_at is null or source_position.closed_at>=p.entry_at) then
     raise exception 'DB_ONLY_STALE_LIFECYCLE';
   end if;
 else
   if source_id is not null or lane_id is not null or client_id like 'tb-%' then raise exception 'DB_ONLY_EXTERNAL_IDENTITY'; end if;
 end if;

 prior_pnl:=coalesce(nullif(p.metadata->>'v18SettledPnl','')::numeric,p.realized_pnl_usdt);
 if prior_pnl is null then raise exception 'DB_ONLY_PRIOR_ACCOUNTING_UNKNOWN'; end if;
 net_pnl:=prior_pnl+gross-fees;
 recovery_eligible:=class in ('VERIFIED_BOT_EXIT','VERIFIED_NATIVE_STOP','VERIFIED_STALE_NATIVE_STOP');
 v_exit_reason:=case class when 'VERIFIED_BOT_EXIT' then 'RECONCILED_BOT_EXIT'
   when 'VERIFIED_NATIVE_STOP' then 'V17_NATIVE_STOP'
   when 'VERIFIED_STALE_NATIVE_STOP' then 'STALE_NATIVE_STOP_CROSS_LIFECYCLE'
   else 'EXTERNAL_OR_UNATTRIBUTED_CLOSE' end;
 before_position:=to_jsonb(p);
 new_metadata:=p.metadata||jsonb_build_object('v18SettledPnl',net_pnl,'exitAccountingPending',false,
   'lastExitOrderId',exchange_order,'lastExitReason',v_exit_reason,'executorPatch','V18-DB-ONLY-RECONCILIATION-1',
   'v18ExternalExit',p_evidence||jsonb_build_object('status','SETTLED','evidenceKey',evidence_key,
     'incidentId',p_incident_id,'generation',p_generation,'recoveryEligible',recovery_eligible,
     'accountingComplete',true,'strategyExit',recovery_eligible,'settledAt',clock_timestamp()))||
   jsonb_build_object('exitProtection',coalesce(p.metadata->'exitProtection','{}')||jsonb_build_object('health','POSITION_CLOSED'));
 update public.v11_long_regime_positions set remaining_quantity=0,state='CLOSED',exit_price=funds/q,
   exit_reason=v_exit_reason,closed_at=v_closed_at,realized_pnl_usdt=net_pnl,metadata=new_metadata,updated_at=clock_timestamp()
 where id=p.id and state='OPEN' and updated_at=p.updated_at;
 if not found then raise exception 'DB_ONLY_POSITION_CAS'; end if;

 update public.exchange_trade_fills f set client_order_id=client_id,
   source=case when recovery_eligible then 'AUTOMATED' else 'UNCLASSIFIED' end,
   v17_order_id=lane_id,v17_position_id=p.id,bot_order_id=null,position_id=null,accounting_status='ACCOUNTED',updated_at=clock_timestamp()
 where f.exchange='binance_futures' and f.account_scope='futures' and f.market=p.symbol and
   f.exchange_order_id=exchange_order and upper(f.side)='SELL';
 get diagnostics matched_count=row_count;
 if matched_count<>trade_count then raise exception 'DB_ONLY_FILL_CAS'; end if;

 if lane_id is not null then
   update public.v11_long_regime_orders set exchange_order_id=exchange_order,state='FILLED',
     response_payload=coalesce(response_payload,'{}')||jsonb_build_object('v18DbOnlyReconciliation',p_evidence,'v18ExposureFinal',true),
     updated_at=clock_timestamp() where id=lane_id;
 end if;
 if source_id is not null then
   update public.v11_long_regime_positions sp set metadata=sp.metadata||jsonb_build_object(
     'exitProtection',jsonb_set(coalesce(sp.metadata->'exitProtection','{}'),'{orders}',
       (select jsonb_agg(case when coalesce(o->>'clientId',o#>>'{spec,params,clientAlgoId}')=client_id then
          o||jsonb_build_object('actualOrderId',exchange_order,'status',p_evidence#>>'{algo,status}','terminal',true,
            'fillStatus','FILLED','observedQuantity',q,'observedFunds',funds,'observedFee',fees,
            'tradeIds',p_evidence->'tradeIds','accountingAppliedToSource',source_id=p.id,
            'crossLifecycleExecution',source_id<>p.id,'crossLifecycleTargetPositionId',case when source_id<>p.id then p.id else null end)
          else o end) from jsonb_array_elements(coalesce(sp.metadata#>'{exitProtection,orders}','[]')) o),true)||
       jsonb_build_object('health',case when source_id=p.id then 'POSITION_CLOSED' else 'CROSS_LIFECYCLE_EXECUTION' end)),
     updated_at=clock_timestamp() where sp.id=source_id;
 end if;
 update public.v11_long_regime_signals set status='CLOSED',updated_at=clock_timestamp()
 where id=p.signal_id and position_id=p.id and status in ('FILLED','ORDERED','CLAIMED');

 update public.v18_ops_incidents set last_checked_at=clock_timestamp(),
   resolution_evidence=coalesce(resolution_evidence,'{}')||jsonb_build_object('settlement',jsonb_build_object(
     'status','SETTLED','incidentId',p_incident_id,'generation',p_generation,'positionId',p.id,
     'classification',class,'recoveryEligible',recovery_eligible,'accountingComplete',true,
     'evidenceKey',evidence_key,'settledAt',clock_timestamp(),'beforePosition',before_position,'evidence',p_evidence))
 where id=p_incident_id;
 return jsonb_build_object('settled',true,'idempotent',false,'positionId',p.id,'evidenceKey',evidence_key,
   'classification',class,'recoveryEligible',recovery_eligible,'quantity',q,'exitPrice',funds/q,
   'grossPnl',gross,'exitFee',fees,'realizedPnlUsdt',net_pnl,'closedAt',v_closed_at,'fills',trade_count);
end $$;

-- Preserve the non-recoverable default for UNEXPLAINED_EXPOSURE.  The exception is
-- local to one incident generation whose atomic settlement proof remains stored.
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
      not exists(select 1 from public.v11_long_regime_positions p where p.id=target_id and p.state='CLOSED' and p.remaining_quantity=0 and
        p.metadata#>>'{v18ExternalExit,status}'='SETTLED' and p.metadata#>>'{v18ExternalExit,evidenceKey}'=settlement->>'evidenceKey') or
      exists(select 1 from public.exchange_trade_fills f where f.v17_position_id=target_id and f.accounting_status<>'ACCOUNTED') then
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
 return jsonb_build_object('resolved',true,'incidentId',i.id,'checks',checks);
end $$;

revoke all on function public.v18_apply_reconciled_fill_owner(),
 public.v18_closed_protection_backlog(integer),
 public.v18_settle_db_only_exit(uuid,uuid,bigint,uuid,jsonb),
 public.v18_recovery_observation(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.v18_apply_reconciled_fill_owner(),
 public.v18_closed_protection_backlog(integer),
 public.v18_settle_db_only_exit(uuid,uuid,bigint,uuid,jsonb),
 public.v18_recovery_observation(uuid,uuid,bigint,jsonb) to service_role;
commit;
