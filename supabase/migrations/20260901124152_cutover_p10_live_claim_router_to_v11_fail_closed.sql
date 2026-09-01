create or replace function public.resolve_p10_production_regime_route_v3(
  p_market text,
  p_side text,
  p_signal_time timestamptz,
  p_evidence jsonb,
  p_at timestamptz default clock_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select public.resolve_p10_production_regime_route_v11(
    null,
    p_market,
    p_side,
    p_signal_time,
    coalesce(p_evidence, '{}'::jsonb),
    p_at
  );
$function$;

create or replace function public.resolve_p10_production_regime_route(
  p_side text,
  p_at timestamptz default clock_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select public.resolve_p10_production_regime_route_v11(
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
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_claim public.p10_signal_claims%rowtype;
  v_route jsonb;
  v_gate jsonb;
  v_decision text := 'BLOCK';
  v_reason text := 'V11_ROUTER_UNAVAILABLE_FAIL_CLOSED';
  v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-V11';
begin
  begin
    v_route := public.resolve_p10_production_regime_route_v11(
      p_venue,
      p_market,
      upper(p_side),
      p_signal_time,
      coalesce(p_evidence, '{}'::jsonb),
      clock_timestamp()
    );
    v_gate := coalesce(v_route->'gate', '{}'::jsonb);
    v_decision := upper(coalesce(v_route->>'action', 'BLOCK'));
    v_reason := coalesce(v_route->>'reason', 'V11_ROUTER_UNAVAILABLE_FAIL_CLOSED');
  exception when others then
    v_decision := 'BLOCK';
    v_reason := 'V11_ROUTER_ERROR_FAIL_CLOSED';
    v_route := jsonb_build_object(
      'policy_revision', v_policy_revision,
      'claim_wiring_revision', v_policy_revision,
      'error', left(sqlerrm, 240),
      'action', v_decision,
      'reason', v_reason,
      'fail_closed', true,
      'zero_entry_policy', true
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
      when coalesce(v_gate->>'observed_at', '') <> '' then (v_gate->>'observed_at')::timestamptz
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

  if v_decision <> 'PASS' then
    return jsonb_build_object(
      'claimed', false,
      'blocked', true,
      'reason', v_reason,
      'regime_route', v_route,
      'claim', null
    );
  end if;

  insert into public.p10_signal_claims (venue, market, signal_time, side, evidence)
  values (
    p_venue,
    p_market,
    p_signal_time,
    upper(p_side),
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
