-- Scope-aware incident/control state for V17 futures operations.
-- This migration does not change any position, fill, PnL, existing incident state,
-- circuit state, operator control, strategy setting, schedule, or exchange order.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.v18_ops_incidents
  add column if not exists exchange text,
  add column if not exists account_scope text,
  add column if not exists symbol text,
  add column if not exists control_scope text,
  add column if not exists status text,
  add column if not exists exposure_state text,
  add column if not exists accounting_state text,
  add column if not exists order_source text,
  add column if not exists evidence_version text,
  add column if not exists supersedes_id uuid references public.v18_ops_incidents(id),
  add column if not exists recheck_conditions jsonb;

alter table public.v11_long_regime_runtime
  add column if not exists last_account_evidence_at timestamptz,
  add column if not exists last_exposure_resolution_at timestamptz,
  add column if not exists last_accounting_settlement_at timestamptz,
  add column if not exists last_position_protection_success_at timestamptz,
  add column if not exists last_entry_evaluated_at timestamptz,
  add column if not exists last_symbol_quarantine_observed_at timestamptz;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='v18_ops_incidents_v19_scope_ck') then
  alter table public.v18_ops_incidents add constraint v18_ops_incidents_v19_scope_ck check(
    control_scope is null or control_scope in ('SYMBOL_QUARANTINE','ACCOUNT_ENTRY_HOLD','ACCOUNT_RISK_BLOCK','DIAGNOSTIC_ONLY')) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='v18_ops_incidents_v19_status_ck') then
  alter table public.v18_ops_incidents add constraint v18_ops_incidents_v19_status_ck check(
    status is null or status in ('OPEN','VERIFYING','RESOLVED','SUPERSEDED')) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='v18_ops_incidents_v19_exposure_ck') then
  alter table public.v18_ops_incidents add constraint v18_ops_incidents_v19_exposure_ck check(
    exposure_state is null or exposure_state in ('HELD','FLAT','UNKNOWN')) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='v18_ops_incidents_v19_accounting_ck') then
  alter table public.v18_ops_incidents add constraint v18_ops_incidents_v19_accounting_ck check(
    accounting_state is null or accounting_state in ('SETTLED','FILL_DETAILS_PENDING','ATTRIBUTION_INVESTIGATING','CONFLICT')) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conname='v18_ops_incidents_v19_source_ck') then
  alter table public.v18_ops_incidents add constraint v18_ops_incidents_v19_source_ck check(
    order_source is null or order_source in ('BOT','MANUAL_EXTERNAL','EXCHANGE_FORCED','UNKNOWN')) not valid;
 end if;
end $$;

create index if not exists v19_active_symbol_incident
  on public.v18_ops_incidents(symbol,last_checked_at,id)
  where control_scope='SYMBOL_QUARANTINE' and status in ('OPEN','VERIFYING');

create or replace function public.v19_record_incident(
 p_owner uuid,p_kind text,p_reason text,p_control_scope text,p_symbol text,
 p_state jsonb,p_evidence jsonb,p_evidence_version text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='2s' as $$
declare scope text:=upper(trim(p_control_scope));market text:=upper(trim(coalesce(p_symbol,'')));
 old public.v18_ops_incidents%rowtype;incident uuid;prior uuid;next_generation bigint;
 exposure text:=upper(coalesce(p_state->>'exposureState','UNKNOWN'));
 accounting text:=upper(coalesce(p_state->>'accountingState','CONFLICT'));
 source text:=upper(coalesce(p_state->>'orderSource','UNKNOWN'));
 recheck jsonb:=coalesce(p_state->'recheck','[]');
begin
 perform public.v18_require_lease(p_owner);
 if p_kind is null or trim(p_kind)='' or p_reason is null or trim(p_reason)='' or
    p_evidence_version is distinct from 'V19-SCOPE-AWARE-ENTRY-1' or
    scope not in ('SYMBOL_QUARANTINE','ACCOUNT_ENTRY_HOLD','ACCOUNT_RISK_BLOCK','DIAGNOSTIC_ONLY') or
    exposure not in ('HELD','FLAT','UNKNOWN') or
    accounting not in ('SETTLED','FILL_DETAILS_PENDING','ATTRIBUTION_INVESTIGATING','CONFLICT') or
    source not in ('BOT','MANUAL_EXTERNAL','EXCHANGE_FORCED','UNKNOWN') or jsonb_typeof(recheck)<>'array' then
   raise exception 'V19_INCIDENT_STATE_INVALID';
 end if;
 if scope='SYMBOL_QUARANTINE' and market='' then raise exception 'V19_SYMBOL_REQUIRED'; end if;
 if p_kind='INCOMPLETE_OR_STALE_SNAPSHOT' and scope<>'ACCOUNT_ENTRY_HOLD' then raise exception 'V19_ACCOUNT_EVIDENCE_SCOPE'; end if;
 if p_kind in ('UNKNOWN_ORDER_OUTCOME','KNOWN_ORDER_PENDING_RECONCILIATION') and scope not in ('ACCOUNT_ENTRY_HOLD','ACCOUNT_RISK_BLOCK') then
   raise exception 'V19_UNKNOWN_ORDER_SCOPE';end if;
 if p_kind='EXCHANGE_ONLY_POSITION' and scope<>'ACCOUNT_RISK_BLOCK' then raise exception 'V19_UNEXPLAINED_EXPOSURE_SCOPE'; end if;

 if scope in ('ACCOUNT_ENTRY_HOLD','ACCOUNT_RISK_BLOCK') then
   incident:=public.v18_record_incident(p_owner,p_kind,left(scope||':'||p_reason,500),p_evidence);
   select * into strict old from public.v18_ops_incidents where id=incident for update;
   select id into prior from public.v18_ops_incidents where id<>incident and generation<old.generation and
     symbol is null and resolved_at is null and status is distinct from 'RESOLVED'
     order by generation desc,opened_at desc limit 1;
   if prior is not null then
     update public.v18_ops_incidents set status='SUPERSEDED',resolved_at=clock_timestamp(),last_checked_at=clock_timestamp()
       where id=prior and resolved_at is null and status is distinct from 'RESOLVED';
   end if;
   update public.v18_ops_incidents set exchange='binance_futures',account_scope='futures',symbol=null,
     control_scope=scope,status='OPEN',exposure_state=exposure,accounting_state=accounting,
     order_source=source,evidence_version=p_evidence_version,recheck_conditions=recheck,supersedes_id=coalesce(supersedes_id,prior),
     last_checked_at=clock_timestamp() where id=incident;
   return jsonb_build_object('id',incident,'generation',old.generation,'scope',scope,'globalCircuit',true,'supersedes',prior);
 end if;

 perform pg_advisory_xact_lock(hashtext('v19-symbol-incident:'||market));
 select * into old from public.v18_ops_incidents where exchange='binance_futures' and account_scope='futures' and
   symbol=market and control_scope=scope and status in ('OPEN','VERIFYING') order by opened_at desc,id desc limit 1 for update;
 if old.id is not null and old.kind=p_kind and old.reason=p_reason and old.evidence_version=p_evidence_version then
   update public.v18_ops_incidents set evidence=p_evidence,last_checked_at=clock_timestamp(),status='OPEN',
     exposure_state=exposure,accounting_state=accounting,order_source=source,recheck_conditions=recheck,
     clean_checks=0,first_clean_at=null,last_observation_id=null,last_observed_at=null where id=old.id;
   return jsonb_build_object('id',old.id,'generation',old.generation,'scope',scope,'globalCircuit',false);
 end if;
 if old.id is not null then
   update public.v18_ops_incidents set status='SUPERSEDED',resolved_at=clock_timestamp(),last_checked_at=clock_timestamp()
   where id=old.id and status in ('OPEN','VERIFYING');
 end if;
 select coalesce(max(generation),0)+1 into next_generation from public.v18_ops_incidents
 where exchange='binance_futures' and account_scope='futures' and symbol=market;
 incident:=gen_random_uuid();
 insert into public.v18_ops_incidents(id,generation,kind,reason,evidence,opened_at,last_checked_at,
   exchange,account_scope,symbol,control_scope,status,exposure_state,accounting_state,order_source,
   evidence_version,supersedes_id,recheck_conditions)
 values(incident,next_generation,p_kind,left(p_reason,500),p_evidence,clock_timestamp(),clock_timestamp(),
   'binance_futures','futures',market,scope,'OPEN',exposure,accounting,source,p_evidence_version,old.id,recheck);
 return jsonb_build_object('id',incident,'generation',next_generation,'scope',scope,'globalCircuit',false,'supersedes',old.id);
end $$;

-- Keep the proven V18 three-observation account recovery intact, then close the
-- diagnostic lifecycle for only the exact incident/generation that it resolved.
-- No operator row, unrelated incident or symbol quarantine is changed here.
create or replace function public.v19_account_recovery_observation(
 p_owner uuid,p_incident_id uuid,p_generation bigint,p_evidence_version text,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='750ms' as $$
declare result jsonb;
begin
 perform public.v18_require_lease(p_owner);
 if p_evidence_version is distinct from 'V19-SCOPE-AWARE-ENTRY-1' then
   return jsonb_build_object('resolved',false,'reason','EVIDENCE_VERSION_MISMATCH');end if;
 result:=public.v18_recovery_observation(p_owner,p_incident_id,p_generation,p_evidence);
 if coalesce((result->>'resolved')::boolean,false) then
   update public.v18_ops_incidents set status='RESOLVED',resolved_at=coalesce(resolved_at,clock_timestamp()),
     last_checked_at=clock_timestamp()
   where id=p_incident_id and generation=p_generation and
     (control_scope in ('ACCOUNT_ENTRY_HOLD','ACCOUNT_RISK_BLOCK') or control_scope is null) and
     resolved_at is not null;
 end if;
 return result||jsonb_build_object('evidenceVersion',p_evidence_version);
end $$;

create or replace function public.v19_symbol_recovery_observation(
 p_owner uuid,p_incident_id uuid,p_generation bigint,p_evidence_version text,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout='500ms' as $$
declare i public.v18_ops_incidents%rowtype;seen timestamptz;obs text;expected jsonb;actual jsonb;checks integer;
begin
 perform public.v18_require_lease(p_owner);
 select * into i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.id is null or i.generation<>p_generation or i.control_scope<>'SYMBOL_QUARANTINE' or
    i.status not in ('OPEN','VERIFYING') or i.evidence_version is distinct from p_evidence_version then
   return jsonb_build_object('resolved',false,'reason','INCIDENT_CAS_MISS');end if;
 if p_evidence_version is distinct from 'V19-SCOPE-AWARE-ENTRY-1' or
    p_evidence->>'version' is distinct from p_evidence_version or p_evidence->>'symbol' is distinct from i.symbol or
    coalesce((p_evidence->>'clean')::boolean,false) is not true then
   return jsonb_build_object('resolved',false,'reason','EVIDENCE_MISMATCH');end if;
 seen:=to_timestamp((p_evidence#>>'{observation,requested_at_ms}')::double precision/1000);
 obs:=p_evidence#>>'{observation,id}';
 if obs is null or obs='' or p_evidence#>>'{observation,source}' is distinct from 'BINANCE_ACCOUNT_REST' or
    p_evidence#>>'{observation,received_at_ms}' is null or
    (p_evidence#>>'{observation,received_at_ms}')::double precision<(p_evidence#>>'{observation,requested_at_ms}')::double precision or
    p_evidence->>'ordersObservedAt' is null or jsonb_typeof(p_evidence->'positions') is distinct from 'array' or
    seen<clock_timestamp()-interval '5 seconds' or seen>clock_timestamp()+interval '1 second' or
    to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)<clock_timestamp()-interval '8 seconds' or
    to_timestamp((p_evidence->>'ordersObservedAt')::double precision/1000)>clock_timestamp()+interval '1 second' then
   return jsonb_build_object('resolved',false,'reason','STALE_EVIDENCE');end if;
 lock table public.v11_long_regime_positions,public.v11_long_regime_orders in share mode;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at,'quantity',remaining_quantity) order by id),'[]')
 into actual from public.v11_long_regime_positions where state='OPEN';
 select coalesce(jsonb_agg(jsonb_build_object('id',(x->>'id')::uuid,'updated_at',(x->>'updated_at')::timestamptz,
   'quantity',(x->>'quantity')::numeric) order by x->>'id'),'[]') into expected from jsonb_array_elements(p_evidence->'positions') x;
 if actual is distinct from expected or exists(select 1 from public.v11_long_regime_orders where symbol=i.symbol and
   state in ('PLANNED','DISPATCHED','RECONCILIATION_PENDING','RECONCILIATION_FAILED')) then
   update public.v18_ops_incidents set status='OPEN',clean_checks=0,first_clean_at=null where id=i.id;
   return jsonb_build_object('resolved',false,'reason','SYMBOL_STATE_CHANGED');end if;
 if obs=i.last_observation_id or seen<i.last_observed_at+interval '50 seconds' then
   return jsonb_build_object('resolved',false,'reason','OBSERVATION_NOT_INDEPENDENT','checks',i.clean_checks);end if;
 checks:=case when i.last_observed_at is null or seen<=i.last_observed_at+interval '90 seconds' then i.clean_checks+1 else 1 end;
 update public.v18_ops_incidents set status='VERIFYING',clean_checks=checks,
   first_clean_at=case when checks=1 then seen else first_clean_at end,last_observation_id=obs,last_observed_at=seen,
   last_checked_at=clock_timestamp(),resolution_evidence=coalesce(resolution_evidence,'{}')||
     jsonb_build_object('recovery',p_evidence) where id=i.id and generation=p_generation and status in ('OPEN','VERIFYING');
 if checks<2 or (i.first_clean_at is not null and seen<i.first_clean_at+interval '50 seconds') then
   return jsonb_build_object('resolved',false,'reason','VERIFYING','checks',checks);end if;
 update public.v18_ops_incidents set status='RESOLVED',resolved_at=clock_timestamp(),last_checked_at=clock_timestamp()
 where id=i.id and generation=p_generation and status='VERIFYING';
 if not found then return jsonb_build_object('resolved',false,'reason','INCIDENT_CAS_MISS');end if;
 return jsonb_build_object('resolved',true,'incidentId',i.id,'generation',i.generation,'symbol',i.symbol,'checks',checks);
end $$;

-- An operationally flat DB row must not consume an exposure slot.  Exclusion is
-- accepted only for the exact position id and a fresh lease-fenced incident proof;
-- a stale diagnostic can never increase capacity.
create or replace function public.v11_long_regime_enforce_slot_cap()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare slot_cap integer;open_count integer;
begin
 if new.state is distinct from 'OPEN' then return new;end if;
 slot_cap:=case when new.metadata->>'executionMode'='LEADER_MOMENTUM_V17' then 10 else 3 end;
 perform pg_advisory_xact_lock(hashtext('v11_long_regime_slot_cap'));
 select count(*) into open_count from public.v11_long_regime_positions p where p.state='OPEN' and p.id is distinct from new.id and
   not exists(select 1 from public.v18_ops_incidents i where i.exchange='binance_futures' and i.account_scope='futures' and
     i.symbol=p.symbol and i.control_scope='SYMBOL_QUARANTINE' and i.status in ('OPEN','VERIFYING') and i.exposure_state='FLAT' and
     i.last_checked_at>clock_timestamp()-interval '10 seconds' and i.evidence->>'positionId'=p.id::text);
 if open_count>=slot_cap then raise exception 'V11_SLOT_CAP_EXCEEDED: % exposure slots already, cap is %',open_count,slot_cap using errcode='23505';end if;
 return new;
end $$;

-- Preserve the V18 evidence/accounting implementation and widen only its incident
-- guard to accept an exact active symbol quarantine.  Once a proven stale native
-- stop is attributed to its target lifecycle, also retire its targeted recheck flag.
-- Both replacements are marker-guarded so changed upstream code fails the migration.
do $migration$
declare body text;old_guard text;new_guard text;old_cross text;new_cross text;
begin
 select p.prosrc into strict body from pg_proc p where p.oid='public.v18_settle_db_only_exit(uuid,uuid,bigint,uuid,jsonb)'::regprocedure;
 if position('V19_SYMBOL_SETTLEMENT_SCOPE_1' in body)>0 then return;end if;
 old_guard:=$old$
 select * into strict r from public.v11_long_regime_runtime where singleton for update;
 if not r.circuit_open or r.incident_id is distinct from p_incident_id or r.incident_generation<>p_generation or
    r.incident_kind not in ('UNEXPLAINED_EXPOSURE','KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION') then
   raise exception 'DB_ONLY_INCIDENT_CAS';
 end if;
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.generation<>p_generation or i.kind is distinct from r.incident_kind or i.reason is distinct from r.circuit_reason then
   raise exception 'DB_ONLY_INCIDENT_MISMATCH';
 end if;
$old$;
 new_guard:=$new$
 -- V19_SYMBOL_SETTLEMENT_SCOPE_1: exact active symbol incident, or unchanged V18 global incident.
 select * into strict i from public.v18_ops_incidents where id=p_incident_id for update;
 if i.control_scope='SYMBOL_QUARANTINE' then
   if i.generation<>p_generation or i.status not in ('OPEN','VERIFYING') or i.symbol is distinct from p.symbol or
      i.evidence_version is distinct from 'V19-SCOPE-AWARE-ENTRY-1' or i.kind not in ('DB_ONLY_POSITION','KNOWN_EXIT_PENDING_RECONCILIATION','QUANTITY_MISMATCH') then
     raise exception 'DB_ONLY_SYMBOL_INCIDENT_CAS';end if;
 else
   select * into strict r from public.v11_long_regime_runtime where singleton for update;
   if not r.circuit_open or r.incident_id is distinct from p_incident_id or r.incident_generation<>p_generation or
      r.incident_kind not in ('UNEXPLAINED_EXPOSURE','KNOWN_EXIT_PENDING_RECONCILIATION','KNOWN_ORDER_PENDING_RECONCILIATION') then
     raise exception 'DB_ONLY_INCIDENT_CAS';end if;
   if i.generation<>p_generation or i.kind is distinct from r.incident_kind or i.reason is distinct from r.circuit_reason then
     raise exception 'DB_ONLY_INCIDENT_MISMATCH';end if;
 end if;
$new$;
 if position(old_guard in body)=0 then raise exception 'V19_SETTLEMENT_UPSTREAM_GUARD_CHANGED';end if;
 body:=replace(body,old_guard,new_guard);
 old_cross:=$old$
            'crossLifecycleExecution',source_id<>p.id,'crossLifecycleTargetPositionId',case when source_id<>p.id then p.id else null end)
$old$;
 new_cross:=$new$
            'crossLifecycleExecution',source_id<>p.id,'crossLifecycleTargetPositionId',case when source_id<>p.id then p.id else null end,
            'crossLifecycleEvidencePending',false)
$new$;
 if position(old_cross in body)=0 then raise exception 'V19_SETTLEMENT_CROSS_LIFECYCLE_CHANGED';end if;
 body:=replace(body,old_cross,new_cross);
 execute 'create or replace function public.v18_settle_db_only_exit(p_owner uuid,p_incident_id uuid,p_generation bigint,p_position_id uuid,p_evidence jsonb) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public set lock_timeout=''2s'' as '||quote_literal(body);
end $migration$;

revoke all on function public.v19_record_incident(uuid,text,text,text,text,jsonb,jsonb,text),
 public.v19_account_recovery_observation(uuid,uuid,bigint,text,jsonb),
 public.v19_symbol_recovery_observation(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.v19_record_incident(uuid,text,text,text,text,jsonb,jsonb,text),
 public.v19_account_recovery_observation(uuid,uuid,bigint,text,jsonb),
 public.v19_symbol_recovery_observation(uuid,uuid,bigint,text,jsonb) to service_role;

commit;
