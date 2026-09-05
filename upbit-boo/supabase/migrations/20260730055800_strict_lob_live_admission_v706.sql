-- Trading-booooo v7.0.6-STRICT-LOB-30S-EV-GATE
-- Fail closed before any live LOB position reservation can reach the exchange-order path.

create or replace function public.enforce_strict_lob_live_admission_v706()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_signal jsonb;
  v_observation_ms numeric;
  v_min_ev_bps numeric;
  v_conditional_ev numeric;
  v_conditional_ev_lb numeric;
  v_attempt_ev numeric;
  v_attempt_ev_lb numeric;
  v_warnings jsonb;
  v_low_evidence boolean;
  v_exploration boolean;
  v_pattern_samples integer;
  v_pattern_mean_bps numeric;
  v_pattern_profitable_rate numeric;
begin
  if coalesce(new.is_paper, true) or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  v_signal := coalesce(new.metadata -> 'lob_signal', '{}'::jsonb);
  if coalesce(v_signal ->> 'strategy', '') <> 'LOB_SCALP' then
    return new;
  end if;

  select greatest(
           0.50::numeric,
           coalesce(s.lob_min_net_ev_bps, 0.50::numeric),
           coalesce(s.lob_min_verified_ev_cushion_bps, 0.50::numeric)
         )
    into v_min_ev_bps
  from public.trading_settings s
  where s.id = 1;
  v_min_ev_bps := coalesce(v_min_ev_bps, 0.50::numeric);

  v_observation_ms := nullif(v_signal -> 'features' ->> 'observationMs', '')::numeric;
  v_conditional_ev := nullif(v_signal ->> 'conditional_ev_net_bps', '')::numeric;
  v_conditional_ev_lb := nullif(v_signal ->> 'conditional_ev_lower_bound_bps', '')::numeric;
  v_attempt_ev := nullif(v_signal ->> 'attempt_ev_net_bps', '')::numeric;
  v_attempt_ev_lb := nullif(v_signal ->> 'attempt_ev_lower_bound_bps', '')::numeric;
  v_warnings := coalesce(v_signal -> 'warnings', '[]'::jsonb);
  v_low_evidence := coalesce((new.metadata ->> 'low_evidence')::boolean, false);
  v_exploration := coalesce((new.metadata ->> 'is_exploration')::boolean, false);
  v_pattern_samples := coalesce(
    nullif(v_signal -> 'pattern_learning' ->> 'samples', '')::integer,
    0
  );
  v_pattern_mean_bps := nullif(
    v_signal -> 'pattern_learning' ->> 'mean_net_bps',
    ''
  )::numeric;
  v_pattern_profitable_rate := nullif(
    v_signal -> 'pattern_learning' ->> 'profitable_rate',
    ''
  )::numeric;

  if v_observation_ms is null or v_observation_ms < 30000 then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_LIVE_OBSERVATION_UNDER_30S market=%s observation_ms=%s',
        new.market,
        coalesce(v_observation_ms::text, 'null')
      );
  end if;

  if v_low_evidence or v_exploration then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_LOW_EVIDENCE_SHADOW_ONLY market=%s low_evidence=%s exploration=%s',
        new.market,
        v_low_evidence,
        v_exploration
      );
  end if;

  if v_warnings ? 'NET_PAYOFF_TOO_WEAK'
     or v_warnings ? 'STOP_TARGET_ASYMMETRY' then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_UNECONOMIC_PAYOFF market=%s warnings=%s',
        new.market,
        v_warnings::text
      );
  end if;

  if v_conditional_ev is null or v_conditional_ev <= v_min_ev_bps then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_CONDITIONAL_EV_TOO_LOW market=%s ev=%s minimum=%s',
        new.market,
        coalesce(v_conditional_ev::text, 'null'),
        v_min_ev_bps
      );
  end if;

  if v_conditional_ev_lb is null or v_conditional_ev_lb <= v_min_ev_bps then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_CONDITIONAL_EV_LB_TOO_LOW market=%s ev_lb=%s minimum=%s',
        new.market,
        coalesce(v_conditional_ev_lb::text, 'null'),
        v_min_ev_bps
      );
  end if;

  if v_attempt_ev is null or v_attempt_ev <= v_min_ev_bps then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_ATTEMPT_EV_TOO_LOW market=%s ev=%s minimum=%s',
        new.market,
        coalesce(v_attempt_ev::text, 'null'),
        v_min_ev_bps
      );
  end if;

  if v_attempt_ev_lb is null or v_attempt_ev_lb <= v_min_ev_bps then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_ATTEMPT_EV_LB_TOO_LOW market=%s ev_lb=%s minimum=%s',
        new.market,
        coalesce(v_attempt_ev_lb::text, 'null'),
        v_min_ev_bps
      );
  end if;

  if v_pattern_samples >= 40 and (
       (v_pattern_mean_bps is not null and v_pattern_mean_bps <= 0) or
       (v_pattern_profitable_rate is not null and v_pattern_profitable_rate < 0.35)
     ) then
    raise exception using
      errcode = '23514',
      message = format(
        'V706_NEGATIVE_LEARNED_PATTERN market=%s samples=%s mean_bps=%s profitable_rate=%s',
        new.market,
        v_pattern_samples,
        coalesce(v_pattern_mean_bps::text, 'null'),
        coalesce(v_pattern_profitable_rate::text, 'null')
      );
  end if;

  return new;
end;
$$;

drop trigger if exists az_trading_positions_strict_lob_live_v706
  on public.trading_positions;
create trigger az_trading_positions_strict_lob_live_v706
before insert or update on public.trading_positions
for each row
execute function public.enforce_strict_lob_live_admission_v706();

update public.trading_settings
set lob_observation_window_ms = greatest(lob_observation_window_ms, 32000),
    lob_search_base_observation_ms = greatest(lob_search_base_observation_ms, 32000),
    lob_search_max_observation_ms = greatest(lob_search_max_observation_ms, 32000),
    lob_min_net_ev_bps = greatest(lob_min_net_ev_bps, 0.50),
    lob_min_verified_ev_cushion_bps = greatest(
      lob_min_verified_ev_cushion_bps,
      0.50
    ),
    lob_live_shadow_low_evidence = true,
    lob_mission_enabled = false,
    lob_mission_hourly_min_trades = 0,
    lob_mission_daily_min_trades = 0,
    lob_mission_weekly_min_trades = 0,
    lob_mission_activity_deficit = false,
    lob_mission_activity_deficit_streak = 0,
    lob_live_admission_revision = '7.0.6-STRICT-LOB-30S-EV-GATE',
    lob_model_revision = '7.0.6-STRICT-LOB-30S-EV-GATE',
    version = case
      when lob_live_admission_revision is distinct from
           '7.0.6-STRICT-LOB-30S-EV-GATE'
        or lob_observation_window_ms < 32000
        or lob_min_net_ev_bps < 0.50
        or lob_min_verified_ev_cushion_bps < 0.50
        or not lob_live_shadow_low_evidence
        or lob_mission_enabled
      then version + 1
      else version
    end,
    updated_at = case
      when lob_live_admission_revision is distinct from
           '7.0.6-STRICT-LOB-30S-EV-GATE'
        or lob_observation_window_ms < 32000
        or lob_min_net_ev_bps < 0.50
        or lob_min_verified_ev_cushion_bps < 0.50
        or not lob_live_shadow_low_evidence
        or lob_mission_enabled
      then now()
      else updated_at
    end
where id = 1;
