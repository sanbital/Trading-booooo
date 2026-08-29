create or replace function public.resolve_p10_production_regime_route(
  p_side text,
  p_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gate jsonb;
  v_side text := upper(coalesce(p_side,''));
  v_regime text := 'UNKNOWN';
  v_phase text := 'UNKNOWN';
  v_state text := 'UNKNOWN';
  v_strategy text := null;
  v_action text := 'BLOCK';
  v_reason text := 'ROUTER_UNAVAILABLE';
  v_live boolean := false;
begin
  v_gate := public.evaluate_p10_entry_regime_shadow(v_side, p_at);
  v_regime := upper(coalesce(v_gate->>'regime','UNKNOWN'));
  v_phase := upper(coalesce(v_gate->>'phase','UNKNOWN'));
  v_live := coalesce((v_gate->>'live_gate_candidate')::boolean,false);

  if v_regime in ('BULL','STRONG_BULL') then
    v_state := case when v_phase in ('ACCELERATING','IMPULSE_CONTINUATION')
      then 'BULL_TREND' else 'BULL_DECELERATING' end;
  elsif v_regime = 'NEUTRAL' then
    v_state := 'RANGE_UP_CYCLE';
  elsif v_regime = 'RISK_OFF' then
    v_state := case when v_phase = 'CAPITULATION_REBOUND'
      then 'BEAR_REBOUND' else 'BEAR_REBREAK' end;
  end if;

  if not v_live then
    if v_side = 'LONG' then
      v_action := 'FAIL_OPEN';
      v_strategy := 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R';
      v_reason := 'OBSERVER_UNAVAILABLE_PRESERVE_VALIDATED_LONG_EDGE';
    else
      v_action := 'BLOCK';
      v_reason := 'SHORT_DISABLED_UNTIL_VALIDATED_EDGE';
    end if;
  elsif v_side = 'LONG' and v_regime in ('BULL','STRONG_BULL') then
    v_action := 'PASS';
    v_strategy := 'P10_DONCHIAN_BREAKOUT_E10_SLOW_4R';
    v_reason := 'VALIDATED_BULL_LONG_EDGE';
  elsif v_side = 'SHORT' then
    v_action := 'BLOCK';
    v_reason := 'SHORT_DISABLED_NEGATIVE_LIVE_AND_NO_V5_ROBUST_EDGE';
  elsif v_regime = 'NEUTRAL' then
    v_action := 'BLOCK';
    v_reason := 'RANGE_ABSTAIN_NO_VALIDATED_EDGE';
  elsif v_regime = 'RISK_OFF' then
    v_action := 'BLOCK';
    v_reason := 'BEAR_ABSTAIN_NO_VALIDATED_EDGE';
  else
    v_action := 'BLOCK';
    v_reason := 'NON_BULL_LONG_ENTRY_BLOCK';
  end if;

  return jsonb_build_object(
    'policy_revision','P10-PRODUCTION-REGIME-ROUTER-v2',
    'evaluated_at',p_at,
    'side',v_side,
    'regime',v_regime,
    'phase',v_phase,
    'state',v_state,
    'action',v_action,
    'strategy_key',v_strategy,
    'reason',v_reason,
    'live_gate_candidate',v_live,
    'gate',coalesce(v_gate,'{}'::jsonb)
  );
end;
$$;

grant execute on function public.resolve_p10_production_regime_route(text,timestamptz) to service_role;

create or replace function public.claim_p10_signal(
  p_venue text,
  p_market text,
  p_signal_time timestamptz,
  p_side text,
  p_evidence jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.p10_signal_claims%rowtype;
  v_route jsonb;
  v_gate jsonb;
  v_decision text := 'BLOCK';
  v_reason text := 'ROUTER_UNAVAILABLE';
  v_policy_revision constant text := 'P10-PRODUCTION-REGIME-ROUTER-v2';
begin
  begin
    v_route := public.resolve_p10_production_regime_route(upper(p_side), clock_timestamp());
    v_gate := coalesce(v_route->'gate','{}'::jsonb);
    v_decision := upper(coalesce(v_route->>'action','BLOCK'));
    v_reason := coalesce(v_route->>'reason','ROUTER_UNAVAILABLE');
  exception when others then
    if upper(coalesce(p_side,'')) = 'LONG' then
      v_decision := 'FAIL_OPEN';
      v_reason := 'ROUTER_ERROR_PRESERVE_VALIDATED_LONG_EDGE';
    else
      v_decision := 'BLOCK';
      v_reason := 'ROUTER_ERROR_SHORT_FAIL_CLOSED';
    end if;
    v_route := jsonb_build_object('error',left(sqlerrm,240));
    v_gate := '{}'::jsonb;
  end;

  insert into public.p10_entry_regime_gate_attempts (
    venue, market, signal_time, side,
    observation_id, observed_at, regime, phase, bull_score, confidence, sample_size,
    decision, reason, policy_revision, audit
  ) values (
    p_venue, p_market, p_signal_time, upper(p_side),
    nullif(v_gate->>'observation_id',''),
    case when coalesce(v_gate->>'observed_at','') <> '' then (v_gate->>'observed_at')::timestamptz else null end,
    nullif(v_route->>'regime',''),
    nullif(v_route->>'phase',''),
    nullif(v_gate->>'bull_score','')::numeric,
    nullif(v_gate->>'confidence','')::numeric,
    nullif(v_gate->>'sample_size','')::integer,
    v_decision, v_reason, v_policy_revision,
    jsonb_build_object('route',coalesce(v_route,'{}'::jsonb),'evidence',coalesce(p_evidence,'{}'::jsonb))
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

  if v_decision = 'BLOCK' then
    return jsonb_build_object('claimed',false,'blocked',true,'reason',v_reason,'regime_route',v_route,'claim',null);
  end if;

  insert into public.p10_signal_claims (venue,market,signal_time,side,evidence)
  values (p_venue,p_market,p_signal_time,upper(p_side),coalesce(p_evidence,'{}'::jsonb) || jsonb_build_object('regime_route',v_route))
  on conflict (venue,market,signal_time,side) do nothing
  returning * into v_claim;

  if not found then
    select * into v_claim from public.p10_signal_claims
    where venue=p_venue and market=p_market and signal_time=p_signal_time and side=upper(p_side);
    return jsonb_build_object('claimed',false,'blocked',false,'reason','P10_SIGNAL_ALREADY_CLAIMED','regime_route',v_route,'claim',to_jsonb(v_claim));
  end if;

  return jsonb_build_object('claimed',true,'blocked',false,'reason',v_reason,'regime_route',v_route,'claim',to_jsonb(v_claim));
end;
$$;

grant execute on function public.claim_p10_signal(text,text,timestamptz,text,jsonb) to service_role;