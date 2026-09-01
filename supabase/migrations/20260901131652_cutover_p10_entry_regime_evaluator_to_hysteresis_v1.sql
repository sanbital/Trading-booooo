create or replace function public.evaluate_p10_entry_regime_v10(p_side text, p_at timestamp with time zone)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_obs public.market_regime_observations%rowtype;
  v_side text := upper(coalesce(p_side, ''));
  v_at timestamptz := coalesce(p_at, statement_timestamp());
  v_phase text := 'UNKNOWN';
  v_recommendation text := 'BLOCK';
  v_reason text := 'OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED';
  v_observer_ready boolean := false;
begin
  select o.*
  into v_obs
  from public.market_regime_observations o
  where o.model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
    and o.observed_at <= v_at
    and o.observed_at >= v_at - interval '12 minutes'
    and o.confidence >= 0.60
    and o.sample_size >= 240
    and o.features->>'source' = 'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE'
    and case
      when o.features->'breadth_30m'->'binance_spot'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'binance_spot'->>'sample_size')::numeric
      else 0
    end >= 80
    and case
      when o.features->'breadth_30m'->'binance_futures'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'binance_futures'->>'sample_size')::numeric
      else 0
    end >= 80
    and case
      when o.features->'breadth_30m'->'upbit_spot'->>'sample_size' ~ '^[0-9]+$'
        then (o.features->'breadth_30m'->'upbit_spot'->>'sample_size')::numeric
      else 0
    end >= 40
    and o.predicted_regime in ('RISK_OFF', 'NEUTRAL', 'BULL', 'STRONG_BULL')
  order by o.observed_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'policy_revision', 'P10-ENTRY-REGIME-GATE-V10',
      'model_revision', 'MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET',
      'evaluated_at', v_at,
      'side', v_side,
      'recommendation', 'BLOCK',
      'reason', 'OBSERVER_UNAVAILABLE_OR_STALE_FAIL_CLOSED',
      'observer_ready', false,
      'live_gate_candidate', false,
      'fail_closed', true
    );
  end if;

  v_phase := coalesce(v_obs.features->'momentum_phase'->>'phase', 'UNKNOWN');
  v_observer_ready := coalesce(v_obs.trading_influence, false);

  if not v_observer_ready then
    v_reason := 'OBSERVER_NOT_LIVE_FOR_TRADING_FAIL_CLOSED';
  elsif v_side = 'LONG' and v_obs.predicted_regime in ('BULL', 'STRONG_BULL') then
    v_recommendation := 'ALLOW';
    v_reason := 'LONG_STRUCTURAL_BULL';
  elsif v_side = 'LONG' and v_obs.predicted_regime = 'NEUTRAL' then
    v_reason := 'RANGE_NO_TRADE';
  elsif v_side = 'LONG' and v_obs.predicted_regime = 'RISK_OFF' then
    v_reason := 'BEAR_NO_TRADE';
  elsif v_side = 'SHORT' then
    v_reason := 'SHORT_DISABLED_NO_LOCKED_V10_EDGE';
  else
    v_reason := 'UNSUPPORTED_POSITION_SIDE';
  end if;

  return jsonb_build_object(
    'policy_revision', 'P10-ENTRY-REGIME-GATE-V10',
    'model_revision', v_obs.model_revision,
    'evaluated_at', v_at,
    'side', v_side,
    'observation_id', v_obs.id,
    'observed_at', v_obs.observed_at,
    'regime', v_obs.predicted_regime,
    'phase', v_phase,
    'bull_score', v_obs.bull_score,
    'confidence', v_obs.confidence,
    'sample_size', v_obs.sample_size,
    'observation_trading_influence', v_obs.trading_influence,
    'observer_ready', v_observer_ready,
    'live_gate_candidate', v_observer_ready,
    'recommendation', v_recommendation,
    'reason', v_reason,
    'fail_closed', true,
    'observation_age_seconds', extract(epoch from (v_at - v_obs.observed_at))
  );
end;
$function$;
