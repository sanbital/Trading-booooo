
-- Production v192 baseline was read before this patch. Keep 3s/10s/30s contracts.
create or replace function public.v17_verify_writer(p_owner uuid,p_fence bigint)
returns boolean language sql security definer set search_path='' as $fn$
 select exists(select 1 from public.v17_execution_lease where singleton and owner=p_owner and fence=p_fence
  and postmaster_started_at=pg_postmaster_start_time() and expires_at>clock_timestamp()+interval '30 seconds')
$fn$;
create or replace function public.v17_release_writer(p_owner uuid,p_fence bigint)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare n integer;
begin
 update public.v17_execution_lease set owner=null,expires_at='-infinity'
 where singleton and owner=p_owner and fence=p_fence and postmaster_started_at=pg_postmaster_start_time();
 get diagnostics n=row_count;return n=1;
end $fn$;
create or replace function public.deterministic_order_key(p_command jsonb)
returns text language sql immutable set search_path='' as $fn$
 select encode(sha256(convert_to(jsonb_build_object('exchange',p_command->'exchange','action',p_command->'action',
  'order',p_command->'order','leverage',p_command->'leverage')::text,'UTF8')),'hex')
$fn$;
create or replace function public.deterministic_entry_authority(p_signal_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $fn$
declare s jsonb;d jsonb;e jsonb;rank_value integer;r text;t timestamptz;ev jsonb;
begin
 -- One MVCC snapshot binds control/epoch/member/generation; no epoch-crossing reads.
 select to_jsonb(sig),to_jsonb(ctl),to_jsonb(epoch),member.rank into s,d,e,rank_value
 from public.deterministic_control ctl
 left join public.v11_long_regime_signals sig on sig.id=p_signal_id
 left join public.leader20_control c on c.singleton
 left join public.leader20_epochs epoch on epoch.id=c.epoch_id
 left join public.leader20_members member on member.epoch_id=c.epoch_id and member.symbol=sig.symbol
 where ctl.singleton;
 t:=clock_timestamp();
 r:=case when s is null then 'SIGNAL_MISSING'
  when d->>'enabled' is distinct from 'true' then 'DETERMINISTIC_DISABLED'
  when s#>>'{features,deterministic,version}' is distinct from d->>'version' then 'ENGINE_VERSION_MISMATCH'
  when s#>>'{features,deterministic,generation}' is distinct from d->>'generation' then 'ENGINE_GENERATION_MISMATCH'
  when s#>>'{features,deterministic,decision,decision}' is distinct from 'BUY' then 'INITIAL_BUY_REQUIRED'
  when s->>'status' not in ('NEW','CLAIMED','ORDERED','FILLED') then 'SIGNAL_STATE_INVALID'
  when e is null then 'TOP20_SNAPSHOT_MISSING'
  when (e->>'next_refresh_at')::timestamptz<=t then 'TOP20_REFRESH_DELAY'
  when rank_value is null or rank_value>20 then 'TOP20_LEFT_UNIVERSE' else null end;
 ev:=jsonb_build_object('allowed',r is null,'reason',r,'validated_at',t,'generation',d->'generation',
  'signal_generation',s#>'{features,deterministic,generation}','signal_status',s->'status',
  'epoch_id',e->'id','next_refresh_at',e->'next_refresh_at','member',rank_value between 1 and 20,'rank',rank_value);
 return ev;
end $fn$;
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
 if a->>'allowed' is distinct from 'true' or p_state->>'version' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1'
  or p_state->>'decision' is distinct from 'BUY' or p_state->>'setup' is distinct from 'PASS'
  or p_state->>'confirmation' is distinct from 'PASS'
  or coalesce(p_state->>'trigger','WAIT') not in ('BREAKOUT','PULLBACK_RECOVERY','LOCAL_HIGH_RECLAIM','MOMENTUM_REACCELERATION')
  or coalesce(p_state->>'at','') !~ '^[0-9]+$' or coalesce(p_state->>'capture_end_ms','') !~ '^[0-9]+$'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_NOT_EXECUTABLE');end if;
 t:=clock_timestamp();
 if to_timestamp((p_state->>'at')::numeric/1000)>t or t-to_timestamp((p_state->>'at')::numeric/1000)>=interval '3 seconds'
  or to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>t
  or t-to_timestamp((p_state->>'capture_end_ms')::numeric/1000)>=interval '10 seconds'
  then return jsonb_build_object('updated',false,'reason','CURRENT_STATE_STALE');end if;
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
 update public.v11_long_regime_orders set response_payload=response_payload||jsonb_build_object('deterministic_submission',stamp),updated_at=t where id=o.id;
 return jsonb_build_object('updated',true,'order_id',o.id,'proof',stamp);
end $function$
;
create or replace function public.v17_gateway_authorize_evidence(p_key text,p_account text,p_owner uuid,p_fence bigint,p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.v11_long_regime_orders%rowtype;l public.v17_execution_lease%rowtype;
 stamp jsonb;a jsonb;r text;t timestamptz;
begin
 select * into l from public.v17_execution_lease where singleton;
 select * into o from public.v11_long_regime_orders where client_order_id=p_command#>>'{order,identifier}' and intent='OPEN_LONG';
 t:=clock_timestamp();stamp:=o.response_payload->'deterministic_submission';
 if p_account is distinct from 'binance_futures:futures' or p_key is null or length(p_key)<16 or p_command->>'exchange' is distinct from 'binance_futures' then r:='WRITER_ACCOUNT_OR_KEY_INVALID';
 elsif l.owner is distinct from p_owner or l.fence is distinct from p_fence then r:='WRITER_OWNER_OR_FENCE_MISMATCH';
 elsif l.postmaster_started_at is distinct from pg_postmaster_start_time() then r:='WRITER_RESTART_FENCED';
 elsif l.expires_at<=t+interval '30 seconds' then r:='WRITER_LEASE_TOO_SHORT';
 elsif p_command->>'action'='prepare_entry' then
  if p_command->>'leverage' is distinct from '3' or coalesce(p_command->>'market','') !~ '^[[:alnum:]]{1,24}USDT$' then r:='PREPARATION_CONTRACT_INVALID';end if;
 elsif p_command->>'action'='create_order' and upper(p_command#>>'{order,side}')='BUY' and upper(p_command#>>'{order,position_effect}')='OPEN' then
  a:=public.deterministic_entry_authority(o.signal_id);
  if o.id is null or o.state<>'PLANNED' or o.exchange_order_id is not null then r:='ORDER_IDENTITY_NOT_PLANNED';
  elsif o.symbol is distinct from p_command#>>'{order,market}' or o.requested_quantity is distinct from (p_command#>>'{order,quantity}')::numeric or o.request_payload->'order' is distinct from p_command->'order' or o.request_payload->'leverage' is distinct from p_command->'leverage' then r:='ORDER_PAYLOAD_MISMATCH';
  elsif stamp->>'version' is distinct from 'DETERMINISTIC_DYNAMIC_STATE_1' or stamp->>'owner' is distinct from p_owner::text or (stamp->>'fence')::bigint is distinct from p_fence or (stamp->>'postmaster_at')::timestamptz is distinct from pg_postmaster_start_time() then r:='SUBMISSION_OWNER_OR_GENERATION_MISMATCH';
  elsif stamp->>'execution_key' is distinct from p_key or p_key is distinct from public.deterministic_order_key(p_command) then r:='SUBMISSION_PAYLOAD_HASH_MISMATCH';
  elsif (stamp->>'submitted_at')::timestamptz<=t-interval '3 seconds' or (stamp->>'submitted_at')::timestamptz>t or to_timestamp((stamp->>'state_at_ms')::numeric/1000)<=t-interval '3 seconds' then r:='SUBMISSION_EVIDENCE_EXPIRED';
  elsif to_timestamp((stamp->>'capture_end_ms')::numeric/1000)<=t-interval '10 seconds' or to_timestamp((stamp->>'capture_end_ms')::numeric/1000)>t then r:='SUBMISSION_CAPTURE_EXPIRED';
  elsif a->>'allowed' is distinct from 'true' then r:=coalesce(a->>'reason','ENTRY_AUTHORITY_UNAVAILABLE');end if;
 elsif p_command->>'action'='create_order' then
  if upper(p_command#>>'{order,side}') is distinct from 'SELL' or upper(p_command#>>'{order,position_effect}') is distinct from 'CLOSE' then r:='REDUCE_ONLY_CLOSE_REQUIRED';end if;
 elsif p_command->>'action' not in ('cancel_order','v17_create_stop','v17_cancel_stop') then r:='WRITER_ACTION_INVALID';
 end if;
 return jsonb_build_object('allowed',r is null,'reason',r,'validated_at',t,'order_id',o.id,'owner',p_owner,'fence',p_fence,
  'lease_remaining_ms',extract(epoch from l.expires_at-t)*1000,'submission_age_ms',extract(epoch from t-(stamp->>'submitted_at')::timestamptz)*1000,
  'state_age_ms',extract(epoch from t)*1000-(stamp->>'state_at_ms')::numeric,
  'capture_age_ms',extract(epoch from t)*1000-(stamp->>'capture_end_ms')::numeric,'authority',a);
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
 return jsonb_build_object('allowed',false,'reason','WRITER_MALFORMED_EVIDENCE','validated_at',clock_timestamp());
end $fn$;
create or replace function public.v17_gateway_authorize(p_key text,p_account text,p_owner uuid,p_fence bigint,p_command jsonb)
returns boolean language sql security definer set search_path='' as $fn$
 select (public.v17_gateway_authorize_evidence(p_key,p_account,p_owner,p_fence,p_command)->>'allowed')::boolean
$fn$;
revoke all on function public.v17_verify_writer(uuid,bigint),public.v17_release_writer(uuid,bigint),public.deterministic_order_key(jsonb),public.v17_gateway_authorize_evidence(text,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.v17_verify_writer(uuid,bigint),public.v17_release_writer(uuid,bigint),public.deterministic_order_key(jsonb),public.v17_gateway_authorize_evidence(text,text,uuid,bigint,jsonb) to service_role;

create or replace function public.deterministic_recover_claims()
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare item record;ids jsonb:='[]';t timestamptz:=clock_timestamp();
begin
 for item in select id,symbol,features,updated_at from public.v11_long_regime_signals
  where status='CLAIMED' and features#>>'{deterministic,version}'='DETERMINISTIC_DYNAMIC_STATE_1'
   and updated_at<t-interval '150 seconds' order by updated_at limit 20 for update skip locked
 loop
  perform pg_advisory_xact_lock(hashtextextended('deterministic-symbol:'||item.symbol,0));
  if exists(select 1 from public.v11_long_regime_orders where signal_id=item.id)
   or exists(select 1 from public.v11_long_regime_positions where signal_id=item.id and state='OPEN')
   or exists(select 1 from public.v17_analysis_lease where singleton and owner::text=item.features#>>'{executionClaim,analysis_owner}'
     and expires_at>t and postmaster_started_at=pg_postmaster_start_time())
   or exists(select 1 from public.v17_execution_lease where singleton and owner::text=item.features#>>'{executionClaim,writer_owner}'
     and expires_at>t and postmaster_started_at=pg_postmaster_start_time()) then continue;end if;
  update public.v11_long_regime_signals set status='REJECTED',reject_reason='CLAIM_RECOVERED_NO_ORDER_INTENT',
   features=features||jsonb_build_object('entryExecution',jsonb_build_object('version','ENTRY_BOUNDARY_EVIDENCE_1',
    'signal_id',item.id,'reason','CLAIM_RECOVERED_NO_ORDER_INTENT','category','AUTHORITY_OR_STATE',
    'phase','PRE_SEND','not_dispatched',true,'cancelled_at',t,'proof','DURABLE_INTENT_REQUIRED_BEFORE_TRANSPORT')),
   updated_at=t where id=item.id and status='CLAIMED' and updated_at=item.updated_at;
  update public.leader20_entry_reservations set state='RELEASED',reason='CLAIM_RECOVERED_NO_ORDER_INTENT',settled_at=t,updated_at=t
   where signal_id=item.id and state in ('RESERVED','ORDER_PENDING');
  ids:=ids||jsonb_build_array(item.id);
 end loop;
 return jsonb_build_object('recovered',ids,'at',t);
end $fn$;
revoke all on function public.deterministic_recover_claims() from public,anon,authenticated;
grant execute on function public.deterministic_recover_claims() to service_role;
CREATE OR REPLACE FUNCTION public.deterministic_publish_universe(p_snapshot jsonb, p_source_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare eid uuid; t timestamptz:=clock_timestamp();
begin
 perform pg_advisory_xact_lock(20261002,1);t:=clock_timestamp();
 if jsonb_array_length(p_snapshot->'members')<>20 or length(p_source_hash)<>64
  or (p_snapshot->>'observed_at')::timestamptz>t or (p_snapshot->>'observed_at')::timestamptz<t-interval '10 seconds'
  or (select count(distinct x->>'symbol') from jsonb_array_elements(p_snapshot->'members') x)<>20
 or (p_snapshot->>'next_refresh_at')::timestamptz<=t
  or (p_snapshot->>'next_refresh_at')::timestamptz is distinct from (p_snapshot->>'observed_at')::timestamptz+interval '60 seconds'
  or (select count(distinct (x->>'rank')::integer) from jsonb_array_elements(p_snapshot->'members') x where (x->>'rank')::integer between 1 and 20)<>20
 then raise exception 'universe evidence invalid';end if;
 if exists(select 1 from public.leader20_control c join public.leader20_epochs e on e.id=c.epoch_id where c.singleton and e.observed_at>(p_snapshot->>'observed_at')::timestamptz) then return public.deterministic_universe();end if;
 insert into public.leader20_epochs(scheduled_at,observed_at,effective_at,next_refresh_at,snapshot,source_hash)
 values((p_snapshot->>'requested_at')::timestamptz,(p_snapshot->>'observed_at')::timestamptz,t,
  (p_snapshot->>'next_refresh_at')::timestamptz,p_snapshot,p_source_hash) returning id into eid;
 insert into public.leader20_members(epoch_id,symbol,rank,price_change_percent,quote_volume)
 select eid,x->>'symbol',(x->>'rank')::integer,(x->>'price_change_percent')::numeric,(x->>'quote_volume')::numeric
 from jsonb_array_elements(p_snapshot->'members') x;
 update public.leader20_control set epoch_id=eid,updated_at=t where singleton;
 return public.deterministic_universe();
end $function$
;
