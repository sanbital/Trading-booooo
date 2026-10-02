-- Expand only: no cron, trading control, entry guard or exchange side effect changes.
create table if not exists public.v18_closed_native_proof_events (
 position_id uuid not null references public.v11_long_regime_positions(id),
 client_id text not null,
 proof_version text not null check(proof_version='CLOSED_NATIVE_ABSENCE_1'),
 proof jsonb not null,
 reconciled_at timestamptz not null default clock_timestamp(),
 primary key(position_id,client_id)
);
alter table public.v18_closed_native_proof_events enable row level security;
revoke all on public.v18_closed_native_proof_events from public,anon,authenticated;
grant select,insert on public.v18_closed_native_proof_events to service_role;
create or replace function public.v18_reconcile_closed_native_absence(
 p_owner uuid,p_postmaster timestamptz,p_proofs jsonb
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public as $function$
declare proof jsonb;pos public.v11_long_regime_positions%rowtype;st jsonb;new_orders jsonb;
 matched integer;resolved integer:=0;already integer:=0;at_ms numeric;q numeric;funds numeric;fee numeric;
begin
 if p_owner is null then raise exception 'NATIVE_PROOF_LEASE_FENCED';end if;
 -- Exchange reads happened outside the writer lease. This transaction alone owns
 -- the short DB state-change section; rollback also rolls back the acquisition.
 if not public.v17_acquire_execution_lease(p_owner) then raise exception 'NATIVE_PROOF_LEASE_BUSY';end if;
 if not public.v17_verify_execution_lease(p_owner) then raise exception 'NATIVE_PROOF_LEASE_FENCED';end if;
 if p_postmaster is distinct from pg_postmaster_start_time() then raise exception 'NATIVE_PROOF_POSTMASTER_CHANGED';end if;
 if jsonb_typeof(p_proofs) is distinct from 'array' or jsonb_array_length(p_proofs)>20 then raise exception 'NATIVE_PROOF_BATCH_INVALID';end if;
 for proof in select value from jsonb_array_elements(p_proofs) loop
  if not public.v17_verify_execution_lease(p_owner) then raise exception 'NATIVE_PROOF_LEASE_FENCED';end if;
  if jsonb_typeof(proof) is distinct from 'object' or exists(select 1 from unnest(array['observed_at_ms','coverage_start_ms','coverage_end_ms','submitted_at_ms','trade_count','original_quantity','quantity','funds','fee']) field where jsonb_typeof(proof->field) is distinct from 'number')
    or jsonb_typeof(proof->'expected_receipts') is distinct from 'object' or jsonb_typeof(proof->'spec') is distinct from 'object' then raise exception 'NATIVE_PROOF_FIELDS_INVALID';end if;
  at_ms=extract(epoch from clock_timestamp())*1000;
  if proof->>'version' is distinct from 'CLOSED_NATIVE_ABSENCE_1' or proof->>'kind' is distinct from 'CLOSED_ABSENT_WITH_COMPLETE_ACCOUNTING'
    or proof->'exact_negative_lookup' is distinct from 'true'::jsonb or proof->'complete_history' is distinct from 'true'::jsonb or proof->'account_flat' is distinct from 'true'::jsonb
    or (proof->>'observed_at_ms')::numeric<at_ms-5000 or (proof->>'observed_at_ms')::numeric>at_ms+1000
    or (proof->>'coverage_end_ms')::numeric>(proof->>'observed_at_ms')::numeric
    or (proof->>'coverage_start_ms')::numeric>(proof->>'submitted_at_ms')::numeric-5000
    or (proof->>'coverage_end_ms')::numeric-(proof->>'coverage_start_ms')::numeric>=604800000
    or coalesce((proof->>'trade_count')::integer,0)<=0 then raise exception 'NATIVE_PROOF_INVALID_OR_STALE';end if;
  select * into pos from public.v11_long_regime_positions where id=(proof->>'position_id')::uuid for update;
  if not found or pos.state<>'CLOSED' or pos.remaining_quantity<>0 or pos.symbol<>proof->>'symbol'
    or pos.metadata->>'executionMode' is distinct from 'LEADER_MOMENTUM_V17'
    or coalesce(pos.metadata->>'v17ManualPosition','false')<>'false'
    or coalesce(pos.metadata->>'exitAccountingPending','false')<>'false'
    or coalesce(pos.metadata->>'v18EntryAccountingPending','false')<>'false'
    or coalesce(pos.metadata->'v18Exits','{}'::jsonb) is distinct from proof->'expected_receipts'
    or pos.original_quantity<>(proof->>'original_quantity')::numeric then raise exception 'NATIVE_PROOF_POSITION_OR_ACCOUNTING_CHANGED';end if;
  select count(*) into matched from jsonb_array_elements(pos.metadata#>'{exitProtection,orders}') o where o->>'clientId'=proof->>'client_id';
  if matched<>1 then raise exception 'NATIVE_PROOF_STOP_IDENTITY_MISMATCH';end if;
  select o into st from jsonb_array_elements(pos.metadata#>'{exitProtection,orders}') o where o->>'clientId'=proof->>'client_id';
  if st->'terminal'='true'::jsonb then already=already+1;continue;end if;
  if nullif(st->>'ackAt','') is not null or nullif(st->>'algoId','') is not null or nullif(st->>'actualOrderId','') is not null
    or coalesce((st->>'appliedQuantity')::numeric,0)<>0 or st->'accountingPending'='true'::jsonb or st->'crossLifecycleExecution'='true'::jsonb
    or st#>'{spec,params}' is distinct from proof->'spec'
    or (st->>'submittedAt')::numeric<>(proof->>'submitted_at_ms')::numeric then raise exception 'NATIVE_PROOF_SUBMISSION_CHANGED';end if;
  if exists(select 1 from jsonb_each(coalesce(pos.metadata->'v18Exits','{}'::jsonb)) as j(k,r) where (r->>'quantity')::numeric>0 and
    (r->'detailsComplete' is distinct from 'true'::jsonb or r->>'status' is distinct from 'FILLED' or (r->>'accountedQuantity')::numeric is distinct from (r->>'quantity')::numeric)) then raise exception 'NATIVE_PROOF_RECEIPT_NOT_SETTLED';end if;
  select coalesce(sum((r->>'accountedQuantity')::numeric),0),coalesce(sum((r->>'funds')::numeric),0),coalesce(sum((r->>'fee')::numeric),0)
   into q,funds,fee from jsonb_each(coalesce(pos.metadata->'v18Exits','{}'::jsonb)) as j(k,r) where (r->>'quantity')::numeric>0;
  if abs(q-pos.original_quantity)>greatest(0.00000001,abs(q)*0.0000001)
    or abs(q-(proof->>'quantity')::numeric)>greatest(0.00000001,abs(q)*0.0000001)
    or abs(funds-(proof->>'funds')::numeric)>greatest(0.00000001,abs(funds)*0.0000001)
    or abs(fee-(proof->>'fee')::numeric)>greatest(0.00000001,abs(fee)*0.0000001) then raise exception 'NATIVE_PROOF_SETTLED_AMOUNTS_MISMATCH';end if;
  select jsonb_agg(case when o->>'clientId'=proof->>'client_id' then o||jsonb_build_object(
    'status','RECONCILED','terminal',true,'lastQueryError',null,'terminalResolution',
    jsonb_build_object('kind','CLOSED_ABSENT_WITH_COMPLETE_ACCOUNTING','version','CLOSED_NATIVE_ABSENCE_1',
      'at',at_ms,'submitError',o->'submitError','priorStatus',o->'status','lookupError',o->'lastQueryError',
      'tradeIds',proof->'trade_ids','receiptIds',proof->'receipt_ids','historicalSubmission','NOT_INFERRED'))
    else o end order by ord) into new_orders
   from jsonb_array_elements(pos.metadata#>'{exitProtection,orders}') with ordinality as a(o,ord);
  update public.v11_long_regime_positions set metadata=jsonb_set(jsonb_set(jsonb_set(metadata,
    '{exitProtection,orders}',new_orders),'{exitProtection,version}',to_jsonb(coalesce((metadata#>>'{exitProtection,version}')::integer,0)+1)),
    '{exitProtection,health}',to_jsonb(case when exists(select 1 from jsonb_array_elements(new_orders) o where coalesce(o->>'terminal','false')<>'true' or o->'accountingPending'='true'::jsonb) then 'RECONCILIATION_PENDING'::text else 'POSITION_CLOSED'::text end)),
    updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=pos.id;
  insert into public.v18_closed_native_proof_events(position_id,client_id,proof_version,proof)
    values(pos.id,proof->>'client_id','CLOSED_NATIVE_ABSENCE_1',proof) on conflict do nothing;
  resolved=resolved+1;
 end loop;
 if not public.v17_release_execution_lease(p_owner) then raise exception 'NATIVE_PROOF_LEASE_FENCED';end if;
 return jsonb_build_object('ok',true,'resolved',resolved,'already_terminal',already,'utc',clock_timestamp(),'kst',clock_timestamp() at time zone 'Asia/Seoul');
end
$function$;
revoke all on function public.v18_reconcile_closed_native_absence(uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.v18_reconcile_closed_native_absence(uuid,timestamptz,jsonb) to service_role;
comment on function public.v18_reconcile_closed_native_absence(uuid,timestamptz,jsonb) is 'CLOSED_NATIVE_ABSENCE_1: fenced, restart-aware, exact-accounting closed stop reconciliation. No exchange mutation and no PnL reapplication.';
