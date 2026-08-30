-- Reconcile production wiring after a later, unrelated migration restored the
-- historical V3 wrapper/claim definitions after the V10 cutover. The immutable
-- V10 cutover audit supplies the expected canonical function hashes.

create table if not exists public.p10_v10_claim_drift_repairs (
  repair_revision text primary key,
  router_revision text not null,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  implementation_sha256 text not null
    check (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  observed_latest_migration text not null,
  prior_wrapper_md5 text not null check (prior_wrapper_md5 ~ '^[0-9a-f]{32}$'),
  prior_claim_md5 text not null check (prior_claim_md5 ~ '^[0-9a-f]{32}$'),
  expected_wrapper_md5 text not null check (expected_wrapper_md5 ~ '^[0-9a-f]{32}$'),
  expected_claim_md5 text not null check (expected_claim_md5 ~ '^[0-9a-f]{32}$'),
  core_resolver_md5 text not null check (core_resolver_md5 ~ '^[0-9a-f]{32}$'),
  core_verifier_md5 text not null check (core_verifier_md5 ~ '^[0-9a-f]{32}$'),
  final_wrapper_md5 text not null check (final_wrapper_md5 ~ '^[0-9a-f]{32}$'),
  final_claim_md5 text not null check (final_claim_md5 ~ '^[0-9a-f]{32}$'),
  prior_acl jsonb not null,
  final_acl jsonb not null,
  legacy_resolver_acl jsonb not null,
  action text not null,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.p10_v10_claim_drift_repairs enable row level security;
revoke all on table public.p10_v10_claim_drift_repairs
  from public, anon, authenticated, service_role;
grant select on table public.p10_v10_claim_drift_repairs to service_role;

drop trigger if exists p10_v10_claim_drift_repairs_immutable
  on public.p10_v10_claim_drift_repairs;
create trigger p10_v10_claim_drift_repairs_immutable
before update or delete on public.p10_v10_claim_drift_repairs
for each row execute function public.reject_p10_v10_router_lineage_mutation();

drop trigger if exists p10_v10_claim_drift_repairs_no_truncate
  on public.p10_v10_claim_drift_repairs;
create trigger p10_v10_claim_drift_repairs_no_truncate
before truncate on public.p10_v10_claim_drift_repairs
for each statement execute function public.reject_p10_v10_router_lineage_mutation();

do $capture_v10_prior_wiring$
declare
  v_expected_wrapper_md5 text;
  v_expected_claim_md5 text;
  v_expected_resolver_md5 text;
  v_expected_verifier_md5 text;
  v_current_wrapper_md5 text;
  v_current_claim_md5 text;
begin
  select
    wrapper_definition_md5,
    claim_definition_md5,
    resolver_definition_md5,
    producer_verifier_definition_md5
  into strict
    v_expected_wrapper_md5,
    v_expected_claim_md5,
    v_expected_resolver_md5,
    v_expected_verifier_md5
  from public.p10_v10_router_cutover_audit
  where router_revision = 'P10-PRODUCTION-REGIME-ROUTER-V10';

  if md5(pg_get_functiondef(
       'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
     )) is distinct from v_expected_resolver_md5
     or md5(pg_get_functiondef(
       'public.validate_p10_v10_persisted_signal(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
     )) is distinct from v_expected_verifier_md5 then
    raise exception 'V10 core resolver/verifier drifted; refusing wrapper-only repair'
      using errcode = '55000';
  end if;

  v_current_wrapper_md5 := md5(pg_get_functiondef(
    'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure
  ));
  v_current_claim_md5 := md5(pg_get_functiondef(
    'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
  ));

  if v_current_wrapper_md5 is distinct from '95806742a2bcfce40422d239333cbd0f'
     or v_current_claim_md5 is distinct from 'a5249960c0774034688ac431fb841d46' then
    raise exception 'unknown wrapper/claim drift; refusing noncanonical repair'
      using errcode = '55000';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure,
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure,
       'EXECUTE'
     ) then
    raise exception 'unexpected pre-repair wrapper/claim ACL'
      using errcode = '55000';
  end if;
end;
$capture_v10_prior_wiring$;

-- Compatibility/diagnostic wrapper. It cannot authorize an entry because it
-- lacks a venue and immutable producer lineage.
create or replace function public.resolve_p10_production_regime_route(
  p_side text,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select public.resolve_p10_production_regime_route_v10(
    null,
    null,
    p_side,
    p_at,
    '{}'::jsonb,
    p_at
  );
$function$;

create or replace function public.claim_p10_signal(
  p_venue text,
  p_market text,
  p_signal_time timestamptz,
  p_side text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim public.p10_signal_claims%rowtype;
  v_route jsonb := '{}'::jsonb;
  v_gate jsonb := '{}'::jsonb;
  v_decision text := 'BLOCK';
  v_reason text := 'V10_ROUTER_UNAVAILABLE_FAIL_CLOSED';
  v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
begin
  begin
    v_route := public.resolve_p10_production_regime_route_v10(
      p_venue,
      p_market,
      upper(p_side),
      p_signal_time,
      coalesce(p_evidence, '{}'::jsonb),
      clock_timestamp()
    );
    v_gate := coalesce(v_route->'gate', '{}'::jsonb);
    v_decision := upper(coalesce(v_route->>'action', 'BLOCK'));
    v_reason := coalesce(v_route->>'reason', 'V10_ROUTER_UNAVAILABLE_FAIL_CLOSED');

    if v_decision = 'PASS'
       and (
         v_route->>'policy_revision' is distinct from v_policy_revision
         or v_route->>'claim_wiring_revision' is distinct from v_policy_revision
         or v_route->>'strategy_key' is distinct from
           'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R'
       ) then
      v_decision := 'BLOCK';
      v_reason := 'V10_ROUTE_CONTRACT_MISMATCH_FAIL_CLOSED';
      v_route := v_route || jsonb_build_object(
        'action', v_decision,
        'reason', v_reason,
        'strategy_key', null
      );
    end if;
  exception when others then
    v_decision := 'BLOCK';
    v_reason := 'V10_ROUTER_ERROR_FAIL_CLOSED';
    v_route := jsonb_build_object(
      'policy_revision', v_policy_revision,
      'claim_wiring_revision', v_policy_revision,
      'error', left(sqlerrm, 240),
      'action', v_decision,
      'reason', v_reason,
      'fail_closed', true
    );
    v_gate := '{}'::jsonb;
  end;

  insert into public.p10_entry_regime_gate_attempts (
    venue,
    market,
    signal_time,
    side,
    observation_id,
    observed_at,
    regime,
    phase,
    bull_score,
    confidence,
    sample_size,
    decision,
    reason,
    policy_revision,
    audit
  ) values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
    nullif(v_gate->>'observation_id', ''),
    case
      when coalesce(v_gate->>'observed_at', '') <> ''
        then (v_gate->>'observed_at')::timestamptz
      else null
    end,
    nullif(v_route->>'regime', ''),
    nullif(v_route->>'phase', ''),
    nullif(v_gate->>'bull_score', '')::numeric,
    nullif(v_gate->>'confidence', '')::numeric,
    nullif(v_gate->>'sample_size', '')::integer,
    v_decision,
    v_reason,
    v_policy_revision,
    jsonb_build_object(
      'route', coalesce(v_route, '{}'::jsonb),
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    )
  )
  on conflict (venue, market, signal_time, side, policy_revision)
  do update set
    last_attempt_at = clock_timestamp(),
    attempt_count = public.p10_entry_regime_gate_attempts.attempt_count + 1,
    observation_id = excluded.observation_id,
    observed_at = excluded.observed_at,
    regime = excluded.regime,
    phase = excluded.phase,
    bull_score = excluded.bull_score,
    confidence = excluded.confidence,
    sample_size = excluded.sample_size,
    decision = excluded.decision,
    reason = excluded.reason,
    audit = excluded.audit;

  -- Anything other than exact PASS is a block. Unknown future action strings cannot claim.
  if v_decision <> 'PASS' then
    return jsonb_build_object(
      'claimed', false,
      'blocked', true,
      'reason', v_reason,
      'regime_route', v_route,
      'claim', null
    );
  end if;

  insert into public.p10_signal_claims (
    venue,
    market,
    signal_time,
    side,
    strategy_key,
    evidence
  ) values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
    'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R',
    coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('regime_route', v_route)
  )
  on conflict (venue, market, signal_time, side) do nothing
  returning * into v_claim;

  if not found then
    select *
    into v_claim
    from public.p10_signal_claims
    where venue = p_venue
      and market = p_market
      and signal_time = p_signal_time
      and side = upper(p_side);

    return jsonb_build_object(
      'claimed', false,
      'blocked', false,
      'reason', 'P10_SIGNAL_ALREADY_CLAIMED',
      'regime_route', v_route,
      'claim', to_jsonb(v_claim)
    );
  end if;

  return jsonb_build_object(
    'claimed', true,
    'blocked', false,
    'reason', v_reason,
    'regime_route', v_route,
    'claim', to_jsonb(v_claim)
  );
end;
$function$;

revoke all on function public.resolve_p10_production_regime_route(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_p10_signal(text, text, timestamptz, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_p10_production_regime_route(text, timestamptz)
  to service_role;
grant execute on function public.claim_p10_signal(text, text, timestamptz, text, jsonb)
  to service_role;

-- Remove app access from any noncanonical overload that could make PostgREST
-- dispatch ambiguous. Historical definitions remain available to the owner.
do $v10_noncanonical_overload_acl$
declare
  v_proc regprocedure;
begin
  for v_proc in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname in (
        'resolve_p10_production_regime_route',
        'claim_p10_signal'
      )
      and p.oid not in (
        'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure::oid,
        'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure::oid
      )
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      v_proc
    );
  end loop;
end;
$v10_noncanonical_overload_acl$;

do $v10_claim_drift_finalize$
declare
  v_repair_revision constant text := 'P10-V10-CLAIM-DRIFT-RECONCILIATION-20260830';
  v_router_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
  v_source_sha constant text := '54f4b80479a4531fac6d8569c3c8833b124259e4';
  -- SHA-256 of this migration with only this literal normalized to 64 zeroes.
  v_implementation_sha256 constant text :=
    '703903378a6174dcc533caf780044cd68868c1ac899f1409fde2227f83dd026b';
  v_prior_wrapper_md5 constant text := '95806742a2bcfce40422d239333cbd0f';
  v_prior_claim_md5 constant text := 'a5249960c0774034688ac431fb841d46';
  v_expected_wrapper_md5 text;
  v_expected_claim_md5 text;
  v_expected_resolver_md5 text;
  v_expected_verifier_md5 text;
  v_core_resolver_md5 text;
  v_core_verifier_md5 text;
  v_final_wrapper_md5 text;
  v_final_claim_md5 text;
  v_prior_acl jsonb;
  v_final_acl jsonb;
  v_legacy_acl jsonb;
  v_proc regprocedure;
  v_expected jsonb;
  v_existing jsonb;
begin
  for v_proc in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and left(p.proname, length('resolve_p10_production_regime_route_v')) =
        'resolve_p10_production_regime_route_v'
      and p.oid <>
        'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      v_proc
    );
  end loop;

  select
    wrapper_definition_md5,
    claim_definition_md5,
    resolver_definition_md5,
    producer_verifier_definition_md5
  into strict
    v_expected_wrapper_md5,
    v_expected_claim_md5,
    v_expected_resolver_md5,
    v_expected_verifier_md5
  from public.p10_v10_router_cutover_audit
  where router_revision = v_router_revision;

  v_core_resolver_md5 := md5(pg_get_functiondef(
    'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
  ));
  v_core_verifier_md5 := md5(pg_get_functiondef(
    'public.validate_p10_v10_persisted_signal(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure
  ));

  if v_core_resolver_md5 is distinct from v_expected_resolver_md5
     or v_core_verifier_md5 is distinct from v_expected_verifier_md5 then
    raise exception 'V10 core resolver/verifier changed during claim repair'
      using errcode = '55000';
  end if;

  v_prior_acl := jsonb_build_array(
    jsonb_build_object(
      'function',
        'claim_p10_signal(text,text,timestamp with time zone,text,jsonb)',
      'owner', 'postgres',
      'service_execute', true,
      'authenticated_execute', false,
      'anon_execute', false
    ),
    jsonb_build_object(
      'function',
        'resolve_p10_production_regime_route(text,timestamp with time zone)',
      'owner', 'postgres',
      'service_execute', true,
      'authenticated_execute', false,
      'anon_execute', false
    )
  );

  v_final_wrapper_md5 := md5(pg_get_functiondef(
    'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure
  ));
  v_final_claim_md5 := md5(pg_get_functiondef(
    'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
  ));

  if v_final_wrapper_md5 is distinct from v_expected_wrapper_md5
     or v_final_claim_md5 is distinct from v_expected_claim_md5
     or position(
       'resolve_p10_production_regime_route_v10'
       in pg_get_functiondef(
         'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
       )
     ) = 0
     or position(
       'resolve_p10_production_regime_route_v3'
       in pg_get_functiondef(
         'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
       )
     ) > 0
     or position(
       'FAIL_OPEN'
       in upper(pg_get_functiondef(
         'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure
       ))
     ) > 0 then
    raise exception 'V10 claim/wrapper canonical definition assertion failed'
      using errcode = '55000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'function', p.oid::regprocedure::text,
        'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
        'authenticated_execute',
          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'public_execute', has_function_privilege('public', p.oid, 'EXECUTE')
      ) order by p.oid::regprocedure::text
    ),
    '[]'::jsonb
  )
  into v_legacy_acl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and left(p.proname, length('resolve_p10_production_regime_route_v')) =
      'resolve_p10_production_regime_route_v'
    and p.oid <>
      'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'function', p.oid::regprocedure::text,
        'owner', p.proowner::regrole::text,
        'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
        'authenticated_execute',
          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE')
      ) order by p.oid::regprocedure::text
    ),
    '[]'::jsonb
  )
  into v_final_acl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and (
      left(p.proname, length('resolve_p10_production_regime_route_v')) =
        'resolve_p10_production_regime_route_v'
      or p.proname in (
        'resolve_p10_production_regime_route',
        'claim_p10_signal'
      )
    );

  if exists (
    select 1
    from jsonb_array_elements(v_legacy_acl) item
    where (item->>'service_execute')::boolean
       or (item->>'authenticated_execute')::boolean
       or (item->>'anon_execute')::boolean
       or (item->>'public_execute')::boolean
  ) then
    raise exception 'legacy resolver execute privilege remains after claim reconciliation'
      using errcode = '55000';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure,
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure,
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure,
       'EXECUTE'
     )
     or exists (
       select 1
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and (
           left(p.proname, length('resolve_p10_production_regime_route_v')) =
             'resolve_p10_production_regime_route_v'
           or p.proname in (
             'resolve_p10_production_regime_route',
             'claim_p10_signal'
           )
         )
         and (
           has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE')
           or (
             has_function_privilege('service_role', p.oid, 'EXECUTE')
             and p.oid not in (
               'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid,
               'public.resolve_p10_production_regime_route(text,timestamptz)'::regprocedure::oid,
               'public.claim_p10_signal(text,text,timestamptz,text,jsonb)'::regprocedure::oid
             )
           )
         )
     ) then
    raise exception 'V10 canonical claim/wrapper ACL assertion failed'
      using errcode = '55000';
  end if;

  v_expected := jsonb_build_object(
    'repair_revision', v_repair_revision,
    'router_revision', v_router_revision,
    'source_sha', v_source_sha,
    'implementation_sha256', v_implementation_sha256,
    'observed_latest_migration', '20260830035656_mf_collector_throttle_relax_v2',
    'prior_wrapper_md5', v_prior_wrapper_md5,
    'prior_claim_md5', v_prior_claim_md5,
    'expected_wrapper_md5', v_expected_wrapper_md5,
    'expected_claim_md5', v_expected_claim_md5,
    'core_resolver_md5', v_core_resolver_md5,
    'core_verifier_md5', v_core_verifier_md5,
    'final_wrapper_md5', v_final_wrapper_md5,
    'final_claim_md5', v_final_claim_md5,
    'prior_acl', v_prior_acl,
    'final_acl', v_final_acl,
    'legacy_resolver_acl', v_legacy_acl,
    'action', 'RESTORE_EXACT_V10_WRAPPER_CLAIM_AND_REVOKE_LEGACY_EXECUTE'
  );

  insert into public.p10_v10_claim_drift_repairs (
    repair_revision,
    router_revision,
    source_sha,
    implementation_sha256,
    observed_latest_migration,
    prior_wrapper_md5,
    prior_claim_md5,
    expected_wrapper_md5,
    expected_claim_md5,
    core_resolver_md5,
    core_verifier_md5,
    final_wrapper_md5,
    final_claim_md5,
    prior_acl,
    final_acl,
    legacy_resolver_acl,
    action
  ) values (
    v_repair_revision,
    v_router_revision,
    v_source_sha,
    v_implementation_sha256,
    '20260830035656_mf_collector_throttle_relax_v2',
    v_prior_wrapper_md5,
    v_prior_claim_md5,
    v_expected_wrapper_md5,
    v_expected_claim_md5,
    v_core_resolver_md5,
    v_core_verifier_md5,
    v_final_wrapper_md5,
    v_final_claim_md5,
    v_prior_acl,
    v_final_acl,
    v_legacy_acl,
    'RESTORE_EXACT_V10_WRAPPER_CLAIM_AND_REVOKE_LEGACY_EXECUTE'
  )
  on conflict (repair_revision) do nothing;

  select to_jsonb(r) - 'recorded_at'
  into strict v_existing
  from public.p10_v10_claim_drift_repairs r
  where repair_revision = v_repair_revision;

  if v_existing is distinct from v_expected then
    raise exception 'V10 claim drift repair audit differs from immutable release'
      using errcode = '55000';
  end if;
end;
$v10_claim_drift_finalize$;

comment on table public.p10_v10_claim_drift_repairs is
  'Append-only evidence for V10 claim/wrapper drift detection and reconciliation.';
