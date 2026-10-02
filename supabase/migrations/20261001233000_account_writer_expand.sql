-- Expand only. No legacy lease, trigger, cron or strategy is changed here.
-- Activation requires an audited cutover and measured lease policy; default is disabled.
create table public.trading_writer_control (
  account_key text primary key,
  enabled boolean not null default false,
  lease_ttl_ms integer check (lease_ttl_ms between 1000 and 60000),
  network_bound_ms integer check (network_bound_ms between 100 and 30000),
  critical_p99_ms integer check (critical_p99_ms > 0),
  measurement_ref text,
  recovery_required boolean not null default true,
  recovery_generation bigint not null default 0,
  recovered_generation bigint,
  recovered_postmaster_at timestamptz,
  recovery_evidence jsonb,
  check (not enabled or (lease_ttl_ms is not null and network_bound_ms is not null
    and critical_p99_ms is not null and lease_ttl_ms > network_bound_ms + critical_p99_ms
    and measurement_ref is not null))
);
create table public.trading_writer_leases (
  account_key text primary key references public.trading_writer_control(account_key),
  owner uuid,
  fence bigint not null default 0,
  expires_at timestamptz not null default '-infinity',
  heartbeat_at timestamptz,
  acquired_at timestamptz
);
create table public.trading_execution_outbox (
  execution_key text primary key,
  account_key text not null references public.trading_writer_control(account_key),
  decision_id text,
  correlation_id text not null,
  symbol text not null,
  side text not null,
  kind text not null check (kind in ('RECONCILE','PROTECTION','EXIT','ENTRY','MAINTENANCE')),
  created_at timestamptz not null default clock_timestamp(),
  deadline timestamptz,
  authority_version text,
  strategy_version text not null,
  state text not null default 'PENDING' check (state in
    ('PENDING','CLAIMED','VALIDATING','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED',
     'FILLED','REJECTED','CANCELED','EXPIRED','UNKNOWN','RECONCILED')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_owner uuid,
  claim_fence bigint,
  claimed_at timestamptz,
  validated_at timestamptz,
  submitting_at timestamptz,
  acknowledged_at timestamptz,
  filled_at timestamptz,
  position_attributed_at timestamptz,
  protection_installed_at timestamptz,
  client_order_id text,
  exchange_order_id text,
  payload jsonb not null,
  result jsonb,
  last_error_code text,
  terminal_reason text,
  terminal_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (kind <> 'ENTRY' or (decision_id is not null and deadline is not null
    and authority_version is not null and client_order_id is not null)),
  check (payload->>'action' <> 'create_order' or (kind in ('ENTRY','EXIT','PROTECTION')
    and client_order_id is not null
    and (payload#>>'{order,identifier}') is not distinct from client_order_id
    and (payload#>>'{order,market}') is not distinct from symbol
    and (payload#>>'{order,side}') is not distinct from side)),
  check (payload->>'action' <> 'v17_create_stop' or (kind='PROTECTION'
    and client_order_id is not null
    and (payload#>>'{params,clientAlgoId}') is not distinct from client_order_id
    and (payload#>>'{params,symbol}') is not distinct from symbol)),
  check ((terminal_at is null) = (terminal_reason is null)),
  check (state not in ('FILLED','REJECTED','CANCELED','EXPIRED','RECONCILED')
    or terminal_at is not null)
);
-- Cancels and reconciliation reference the original ID. Only creation reserves it.
create unique index trading_execution_submission_identity
  on public.trading_execution_outbox(account_key,client_order_id)
  where kind in ('ENTRY','EXIT','PROTECTION') and payload->>'action' in ('create_order','v17_create_stop');
create index trading_execution_pending on public.trading_execution_outbox(account_key,state,created_at)
  where terminal_at is null;
create table public.trading_execution_events (
  id bigint generated always as identity primary key,
  execution_key text not null references public.trading_execution_outbox(execution_key),
  correlation_id text not null,
  at timestamptz not null default clock_timestamp(),
  state text not null,
  reason text,
  fence bigint,
  evidence jsonb not null default '{}'
);

create function public.trading_execution_enqueue(p_request jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.trading_execution_outbox%rowtype; k text := p_request->>'execution_key';
begin
  if k is null or length(k)>200 or p_request->>'correlation_id' is null then
    raise exception 'EXECUTION_IDENTITY_REQUIRED';
  end if;
  insert into public.trading_execution_outbox(execution_key,account_key,decision_id,correlation_id,
    symbol,side,kind,deadline,authority_version,strategy_version,client_order_id,payload)
  values(k,p_request->>'account_key',p_request->>'decision_id',p_request->>'correlation_id',
    p_request->>'symbol',p_request->>'side',p_request->>'kind',(p_request->>'deadline')::timestamptz,
    p_request->>'authority_version',p_request->>'strategy_version',p_request->>'client_order_id',p_request->'payload')
  on conflict(execution_key) do nothing;
  select * into d from public.trading_execution_outbox where execution_key=k for update;
  -- A repeated key may recover its original result, never replace its instructions.
  if d.account_key is distinct from p_request->>'account_key'
    or d.decision_id is distinct from p_request->>'decision_id'
    or d.correlation_id is distinct from p_request->>'correlation_id'
    or d.symbol is distinct from p_request->>'symbol' or d.side is distinct from p_request->>'side'
    or d.kind is distinct from p_request->>'kind'
    or d.deadline is distinct from (p_request->>'deadline')::timestamptz
    or d.authority_version is distinct from p_request->>'authority_version'
    or d.strategy_version is distinct from p_request->>'strategy_version'
    or d.client_order_id is distinct from p_request->>'client_order_id'
    or d.payload is distinct from p_request->'payload' then
    raise exception 'EXECUTION_KEY_CONFLICT';
  end if;
  return to_jsonb(d);
end $$;

create function public.trading_writer_acquire(p_account text,p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.trading_writer_control%rowtype; l public.trading_writer_leases%rowtype;
  t timestamptz:=clock_timestamp();
begin
  select * into c from public.trading_writer_control where account_key=p_account;
  if p_owner is null or c.enabled is distinct from true then return null; end if;
  insert into public.trading_writer_leases(account_key) values(p_account) on conflict do nothing;
  update public.trading_writer_leases set owner=p_owner,fence=fence+1,
    expires_at=t+c.lease_ttl_ms*interval '1 millisecond',heartbeat_at=t,acquired_at=t
  where account_key=p_account and expires_at<=t returning * into l;
  if l.account_key is null then return null; end if;
  return to_jsonb(l)||jsonb_build_object('ttl_ms',c.lease_ttl_ms,'network_bound_ms',c.network_bound_ms);
end $$;
create function public.trading_writer_verify(p_account text,p_owner uuid,p_fence bigint) returns boolean
language sql security definer set search_path = '' as $$
  select exists(select 1 from public.trading_writer_leases l
    join public.trading_writer_control c using(account_key)
    where l.account_key=p_account and l.owner=p_owner and l.fence=p_fence
      and l.expires_at>clock_timestamp() and c.enabled)
$$;
create function public.trading_writer_heartbeat(p_account text,p_owner uuid,p_fence bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer; t timestamptz:=clock_timestamp();
begin
  update public.trading_writer_leases l set heartbeat_at=t,expires_at=t+c.lease_ttl_ms*interval '1 millisecond'
  from public.trading_writer_control c where l.account_key=p_account and c.account_key=l.account_key
    and c.enabled and l.owner=p_owner and l.fence=p_fence and l.expires_at>t;
  get diagnostics n=row_count; return n=1;
end $$;
create function public.trading_writer_release(p_account text,p_owner uuid,p_fence bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.trading_writer_leases set owner=null,expires_at='-infinity'
    where account_key=p_account and owner=p_owner and fence=p_fence;
  get diagnostics n=row_count; return n=1;
end $$;

create function public.trading_execution_claim(p_account text,p_owner uuid,p_fence bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.trading_execution_outbox%rowtype; c public.trading_writer_control%rowtype;
  t timestamptz:=clock_timestamp();
begin
  -- Lock the lease BEFORE the outbox. Every mutator uses this same ordering.
  perform 1 from public.trading_writer_leases where account_key=p_account for update;
  if not public.trading_writer_verify(p_account,p_owner,p_fence) then raise exception 'WRITER_FENCED'; end if;
  select * into c from public.trading_writer_control where account_key=p_account;
  -- Never expire a possibly submitted order. It must be reconciled by identity.
  with expired as (
    update public.trading_execution_outbox set state='EXPIRED',terminal_reason='DEADLINE_EXPIRED',
      terminal_at=t,last_error_code=coalesce(last_error_code,
        case when attempt_count=0 then 'UNCLAIMED_DEADLINE_EXPIRED' else 'DEADLINE_EXPIRED' end),updated_at=t
    where account_key=p_account and kind='ENTRY' and terminal_at is null and deadline<=t
      and submitting_at is null and state in ('PENDING','CLAIMED','VALIDATING')
    returning execution_key,correlation_id,last_error_code
  ) insert into public.trading_execution_events(execution_key,correlation_id,state,reason,fence,evidence)
    select execution_key,correlation_id,'EXPIRED','DEADLINE_EXPIRED',p_fence,
      jsonb_build_object('last_infrastructure_error',last_error_code) from expired;
  select * into d from public.trading_execution_outbox
  where account_key=p_account and terminal_at is null
    and next_attempt_at<=t
    and (state='PENDING' or state in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN')
      or (state in ('CLAIMED','VALIDATING') and claim_fence is distinct from p_fence))
    and (kind<>'ENTRY' or submitting_at is not null or (not c.recovery_required
      and c.recovered_generation=c.recovery_generation
      and c.recovered_postmaster_at=pg_postmaster_start_time()
      and not exists(select 1 from public.trading_execution_outbox ambiguous
        where ambiguous.account_key=p_account and ambiguous.terminal_at is null
          and ambiguous.state in ('SUBMITTING','UNKNOWN'))))
  order by case when state in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') then 0
    when kind='RECONCILE' then 0 when kind in ('PROTECTION','EXIT') then 1
    when kind='ENTRY' then 2 else 3 end,created_at,execution_key
  for update skip locked limit 1;
  if d.execution_key is null then return null; end if;
  update public.trading_execution_outbox set
    state=case when submitting_at is not null then 'UNKNOWN' else 'CLAIMED' end,
    claim_owner=p_owner,claim_fence=p_fence,claimed_at=t,attempt_count=attempt_count+1,updated_at=t
  where execution_key=d.execution_key returning * into d;
  insert into public.trading_execution_events(execution_key,correlation_id,state,fence)
    values(d.execution_key,d.correlation_id,d.state,p_fence);
  return to_jsonb(d);
end $$;

create function public.trading_execution_transition(p_key text,p_account text,p_owner uuid,p_fence bigint,
  p_state text,p_reason text default null,p_evidence jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.trading_execution_outbox%rowtype; t timestamptz:=clock_timestamp(); allowed boolean;
begin
  perform 1 from public.trading_writer_leases where account_key=p_account for update;
  if not public.trading_writer_verify(p_account,p_owner,p_fence) then raise exception 'WRITER_FENCED'; end if;
  select * into d from public.trading_execution_outbox where execution_key=p_key and account_key=p_account for update;
  if d.execution_key is null or d.claim_owner is distinct from p_owner or d.claim_fence is distinct from p_fence
    then raise exception 'COMMAND_FENCED'; end if;
  if d.terminal_at is not null then
    if d.state=p_state and d.terminal_reason is not distinct from p_reason then return to_jsonb(d); end if;
    raise exception 'COMMAND_ALREADY_TERMINAL';
  end if;
  allowed := case d.state
    when 'CLAIMED' then p_state in ('VALIDATING','REJECTED','EXPIRED','PENDING')
    when 'VALIDATING' then p_state in ('SUBMITTING','REJECTED','EXPIRED','PENDING')
    when 'SUBMITTING' then p_state in ('ACKNOWLEDGED','UNKNOWN','REJECTED')
    when 'ACKNOWLEDGED' then p_state in ('PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','UNKNOWN','RECONCILED')
    when 'PARTIALLY_FILLED' then p_state in ('PARTIALLY_FILLED','FILLED','CANCELED','UNKNOWN','RECONCILED')
    when 'UNKNOWN' then p_state in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED','EXPIRED','RECONCILED','UNKNOWN')
    else false end;
  if not allowed then raise exception 'INVALID_COMMAND_TRANSITION:%:%',d.state,p_state; end if;
  if p_state in ('FILLED','REJECTED','CANCELED','EXPIRED','RECONCILED') and nullif(p_reason,'') is null
    then raise exception 'TERMINAL_REASON_REQUIRED'; end if;
  if p_state='SUBMITTING' and d.kind='ENTRY' and (d.deadline<=t or
    not exists(select 1 from public.trading_writer_control where account_key=p_account
      and not recovery_required and recovered_generation=recovery_generation
      and recovered_postmaster_at=pg_postmaster_start_time())) then
    raise exception 'ENTRY_RECOVERY_OR_DEADLINE_BLOCK';
  end if;
  update public.trading_execution_outbox set state=p_state,last_error_code=p_reason,
    next_attempt_at=case when p_state in ('PENDING','UNKNOWN','PARTIALLY_FILLED') then
      t+least(30000,1000*power(2,least(greatest(attempt_count-1,0),5))) * interval '1 millisecond'
      else t end,
    validated_at=case when p_state='VALIDATING' then t else validated_at end,
    submitting_at=case when p_state='SUBMITTING' then t else submitting_at end,
    acknowledged_at=case when p_state='ACKNOWLEDGED' then coalesce(acknowledged_at,t) else acknowledged_at end,
    filled_at=case when p_state='FILLED' then t else filled_at end,
    exchange_order_id=coalesce(p_evidence->>'exchange_order_id',exchange_order_id),result=p_evidence,
    terminal_at=case when p_state in ('FILLED','REJECTED','CANCELED','EXPIRED','RECONCILED') then t end,
    terminal_reason=case when p_state in ('FILLED','REJECTED','CANCELED','EXPIRED','RECONCILED') then p_reason end,
    claim_owner=case when p_state='PENDING' then null else claim_owner end,
    claim_fence=case when p_state='PENDING' then null else claim_fence end,updated_at=t
  where execution_key=p_key returning * into d;
  insert into public.trading_execution_events(execution_key,correlation_id,state,reason,fence,evidence)
    values(p_key,d.correlation_id,p_state,p_reason,p_fence,p_evidence);
  return to_jsonb(d);
end $$;

create function public.trading_writer_recovery_status(p_account text) returns jsonb
language sql security definer set search_path = '' as $$
 select jsonb_build_object('account_key',c.account_key,'generation',c.recovery_generation,
   'postmaster_at',pg_postmaster_start_time(),'event_cursor',
   (select coalesce(max(e.id),0) from public.trading_execution_events e
     join public.trading_execution_outbox d using(execution_key) where d.account_key=p_account))
 from public.trading_writer_control c where c.account_key=p_account
$$;

-- A worker cannot clear entry freeze with only an HTTP health response.
create function public.trading_writer_recovery_complete(p_account text,p_owner uuid,p_fence bigint,
  p_generation bigint,p_evidence jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform 1 from public.trading_writer_leases where account_key=p_account for update;
  if not public.trading_writer_verify(p_account,p_owner,p_fence) then raise exception 'WRITER_FENCED'; end if;
  if (p_evidence->>'postmaster_at')::timestamptz is distinct from pg_postmaster_start_time()
    or (p_evidence->>'event_cursor')::bigint is distinct from
      (select coalesce(max(e.id),0) from public.trading_execution_events e
        join public.trading_execution_outbox d using(execution_key) where d.account_key=p_account)
    then raise exception 'RECOVERY_CHECKPOINT_CHANGED'; end if;
  if not (p_evidence @> '{"db_ready":true,"open_orders_complete":true,"positions_complete":true,
    "unknown_reconciled":true,"fills_attributed":true,"protection_complete":true,"capacity_recalculated":true}')
    then raise exception 'RECOVERY_EVIDENCE_INCOMPLETE'; end if;
  if exists(select 1 from public.trading_execution_outbox where account_key=p_account and terminal_at is null
    and state in ('SUBMITTING','UNKNOWN')) then raise exception 'RECOVERY_BACKLOG'; end if;
  update public.trading_writer_control set recovery_required=false,recovered_generation=p_generation,
    recovered_postmaster_at=pg_postmaster_start_time(),recovery_evidence=p_evidence
    where account_key=p_account and recovery_generation=p_generation;
  get diagnostics n=row_count; return n=1;
end $$;

-- Called by the authenticated exchange gateway immediately before a side effect.
-- Exact durable payload binding prevents using one fence to send another order.
create function public.trading_gateway_authorize(p_key text,p_account text,p_owner uuid,p_fence bigint,
  p_command jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare d public.trading_execution_outbox%rowtype;
begin
  perform 1 from public.trading_writer_leases where account_key=p_account for update;
  if not public.trading_writer_verify(p_account,p_owner,p_fence) then return false; end if;
  select * into d from public.trading_execution_outbox where execution_key=p_key and account_key=p_account;
  if d.state<>'SUBMITTING' or d.claim_owner is distinct from p_owner or d.claim_fence is distinct from p_fence
    or d.payload is distinct from p_command then return false; end if;
  if d.kind='ENTRY' and (d.deadline<=clock_timestamp() or not exists(
    select 1 from public.trading_writer_control where account_key=p_account and not recovery_required
      and recovered_generation=recovery_generation and recovered_postmaster_at=pg_postmaster_start_time()))
    then return false; end if;
  return d.execution_key is not null;
end $$;

-- Logged tables, RLS, and service-only RPCs. No browser may enqueue or forge fencing.
do $$ declare t text; f record; begin
  foreach t in array array['trading_writer_control','trading_writer_leases','trading_execution_outbox','trading_execution_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('trading_execution_enqueue','trading_writer_acquire',
      'trading_writer_verify','trading_writer_heartbeat','trading_writer_release','trading_execution_claim',
      'trading_execution_transition','trading_writer_recovery_status','trading_writer_recovery_complete','trading_gateway_authorize') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
