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
  v_gate jsonb;
  v_recommendation text := 'UNKNOWN';
  v_regime text := 'UNKNOWN';
  v_live_candidate boolean := false;
  v_decision text := 'FAIL_OPEN';
  v_reason text := 'REGIME_GATE_UNAVAILABLE';
  v_policy_revision constant text := 'P10-ENTRY-REGIME-GATE-v1.1-RANGE-ISOLATION';
begin
  begin
    v_gate := public.evaluate_p10_entry_regime_shadow(upper(p_side), clock_timestamp());
    v_recommendation := upper(coalesce(v_gate->>'recommendation', 'UNKNOWN'));
    v_regime := upper(coalesce(v_gate->>'regime', 'UNKNOWN'));
    v_live_candidate := coalesce((v_gate->>'live_gate_candidate')::boolean, false);

    if v_live_candidate and v_regime = 'NEUTRAL' then
      v_decision := 'BLOCK';
      v_reason := 'RANGE_ISOLATION_TREND_ENTRY_BLOCK';
    elsif v_live_candidate and v_recommendation = 'BLOCK' then
      v_decision := 'BLOCK';
      v_reason := coalesce(v_gate->>'reason', 'REGIME_GATE_BLOCK');
    elsif v_live_candidate then
      v_decision := 'PASS';
      v_reason := coalesce(v_gate->>'reason', 'REGIME_GATE_PASS');
    else
      v_decision := 'FAIL_OPEN';
      v_reason := case when v_gate is null then 'REGIME_GATE_UNAVAILABLE' else 'REGIME_GATE_NOT_LIVE_CANDIDATE' end;
    end if;
  exception when others then
    v_gate := jsonb_build_object('recommendation','UNKNOWN','error',left(sqlerrm,240),'evaluated_at',clock_timestamp());
    v_recommendation := 'UNKNOWN';
    v_regime := 'UNKNOWN';
    v_live_candidate := false;
    v_decision := 'FAIL_OPEN';
    v_reason := 'REGIME_GATE_EVALUATION_ERROR';
  end;

  insert into public.p10_entry_regime_gate_attempts (
    venue, market, signal_time, side, observation_id, observed_at, regime, phase,
    bull_score, confidence, sample_size, decision, reason, policy_revision, audit
  ) values (
    p_venue, p_market, p_signal_time, upper(p_side), nullif(v_gate->>'observation_id',''),
    case when coalesce(v_gate->>'observed_at','') <> '' then (v_gate->>'observed_at')::timestamptz else null end,
    nullif(v_gate->>'regime',''), nullif(v_gate->>'phase',''), nullif(v_gate->>'bull_score','')::numeric,
    nullif(v_gate->>'confidence','')::numeric, nullif(v_gate->>'sample_size','')::integer,
    v_decision, v_reason, v_policy_revision,
    jsonb_build_object('gate',coalesce(v_gate,'{}'::jsonb),'recommendation',v_recommendation,'regime',v_regime,'live_gate_candidate',v_live_candidate,'evidence',coalesce(p_evidence,'{}'::jsonb))
  )
  on conflict (venue, market, signal_time, side, policy_revision) do update set
    last_attempt_at = clock_timestamp(), attempt_count = public.p10_entry_regime_gate_attempts.attempt_count + 1,
    observation_id = excluded.observation_id, observed_at = excluded.observed_at, regime = excluded.regime,
    phase = excluded.phase, bull_score = excluded.bull_score, confidence = excluded.confidence,
    sample_size = excluded.sample_size, decision = excluded.decision, reason = excluded.reason, audit = excluded.audit;

  if v_decision = 'BLOCK' then
    return jsonb_build_object('claimed',false,'blocked',true,'reason',v_reason,'regime_gate',v_gate,'claim',null);
  end if;

  insert into public.p10_signal_claims (venue, market, signal_time, side, evidence)
  values (p_venue,p_market,p_signal_time,upper(p_side),coalesce(p_evidence,'{}'::jsonb))
  on conflict (venue, market, signal_time, side) do nothing
  returning * into v_claim;

  if not found then
    select * into v_claim from public.p10_signal_claims
    where venue=p_venue and market=p_market and signal_time=p_signal_time and side=upper(p_side);
    return jsonb_build_object('claimed',false,'blocked',false,'reason','P10_SIGNAL_ALREADY_CLAIMED','regime_gate',v_gate,'claim',to_jsonb(v_claim));
  end if;

  return jsonb_build_object('claimed',true,'blocked',false,'reason',v_reason,'regime_gate',v_gate,'claim',to_jsonb(v_claim));
end;
$$;

grant execute on function public.claim_p10_signal(text,text,timestamptz,text,jsonb) to service_role;
