-- Finalize the V10 resolver boundary after production verification found that
-- one legacy V3 overload retained an explicit service_role EXECUTE grant.
-- Keep the historical function for replay, but make V10 the only callable
-- versioned production resolver.

create table if not exists public.p10_v10_acl_repair_audit (
  repair_revision text primary key,
  router_revision text not null,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  implementation_sha256 text not null
    check (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  prior_acl jsonb not null,
  final_acl jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.p10_v10_acl_repair_audit enable row level security;
revoke all on table public.p10_v10_acl_repair_audit
  from public, anon, authenticated, service_role;
grant select on table public.p10_v10_acl_repair_audit to service_role;

drop trigger if exists p10_v10_acl_repair_audit_immutable
  on public.p10_v10_acl_repair_audit;
create trigger p10_v10_acl_repair_audit_immutable
before update or delete on public.p10_v10_acl_repair_audit
for each row execute function public.reject_p10_v10_router_lineage_mutation();

drop trigger if exists p10_v10_acl_repair_audit_no_truncate
  on public.p10_v10_acl_repair_audit;
create trigger p10_v10_acl_repair_audit_no_truncate
before truncate on public.p10_v10_acl_repair_audit
for each statement execute function public.reject_p10_v10_router_lineage_mutation();

do $v10_acl_finalization$
declare
  v_repair_revision constant text := 'P10-V10-LEGACY-RESOLVER-ACL-FINAL-20260830';
  v_router_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V10';
  v_source_sha constant text := '0e37d82262c813a1de3e91dd7cbce85c3b20aa76';
  -- SHA-256 of this migration with only this literal normalized to 64 zeroes.
  v_implementation_sha256 constant text :=
    '00e01bcec89f659a379119dffacb72525e5f1e0a9bd07f6feecc0d218e1aa0a8';
  v_proc regprocedure;
  v_prior jsonb;
  v_final jsonb;
  v_existing jsonb;
  v_expected jsonb;
begin
  if not exists (
    select 1
    from public.p10_v10_router_manifests
    where router_revision = v_router_revision
      and implementation_sha256 =
        '06c338e0831517f9ef980adfde3ebc26192696adde848177164239bdc7b0b454'
  ) then
    raise exception 'V10 manifest prerequisite is absent or differs'
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
  into v_prior
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and left(p.proname, length('resolve_p10_production_regime_route_v')) =
      'resolve_p10_production_regime_route_v'
    and p.oid <>
      'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid;

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
  into v_final
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and left(p.proname, length('resolve_p10_production_regime_route_v')) =
      'resolve_p10_production_regime_route_v'
    and p.oid <>
      'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and left(p.proname, length('resolve_p10_production_regime_route_v')) =
        'resolve_p10_production_regime_route_v'
      and p.oid <>
        'public.resolve_p10_production_regime_route_v10(text,text,text,timestamptz,jsonb,timestamptz)'::regprocedure::oid
      and (
        has_function_privilege('service_role', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('public', p.oid, 'EXECUTE')
      )
  ) then
    raise exception 'legacy resolver EXECUTE privilege remains after V10 finalization'
      using errcode = '55000';
  end if;

  v_expected := jsonb_build_object(
    'repair_revision', v_repair_revision,
    'router_revision', v_router_revision,
    'source_sha', v_source_sha,
    'implementation_sha256', v_implementation_sha256,
    'prior_acl', v_prior,
    'final_acl', v_final
  );

  insert into public.p10_v10_acl_repair_audit (
    repair_revision,
    router_revision,
    source_sha,
    implementation_sha256,
    prior_acl,
    final_acl
  ) values (
    v_repair_revision,
    v_router_revision,
    v_source_sha,
    v_implementation_sha256,
    v_prior,
    v_final
  )
  on conflict (repair_revision) do nothing;

  select to_jsonb(a) - 'recorded_at'
  into strict v_existing
  from public.p10_v10_acl_repair_audit a
  where repair_revision = v_repair_revision;

  if v_existing is distinct from v_expected then
    raise exception 'V10 ACL repair audit differs from immutable release'
      using errcode = '55000';
  end if;
end;
$v10_acl_finalization$;

comment on table public.p10_v10_acl_repair_audit is
  'Append-only V10 post-deployment ACL verification and repair evidence.';
