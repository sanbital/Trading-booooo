create or replace function public.enforce_lob_live_admission_v711()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_signal jsonb;
  v_observation_ms numeric;
  v_target_net_bps numeric;
  v_min_target_net_bps numeric;
  v_pattern text;
  v_universe_mode text;
  v_gainer_rank numeric;
  v_effective_reasons jsonb;
  v_low_evidence boolean;
  v_exploration boolean;
begin
  if coalesce(new.is_paper, true) or new.state <> 'ENTRY_PENDING' then
    return new;
  end if;

  v_signal := coalesce(new.metadata -> 'lob_signal', '{}'::jsonb);
  if coalesce(v_signal ->> 'strategy', '') <> 'LOB_SCALP' then
    return new;
  end if;

  select greatest(0.01::numeric, coalesce(s.lob_min_target_net_profit_bps, 0.01::numeric))
    into v_min_target_net_bps
  from public.trading_settings s
  where s.id = 1;
  v_min_target_net_bps := coalesce(v_min_target_net_bps, 0.01::numeric);

  v_observation_ms := nullif(v_signal -> 'features' ->> 'observationMs', '')::numeric;
  v_target_net_bps := nullif(v_signal ->> 'target_return_net_bps', '')::numeric;
  v_pattern := nullif(v_signal ->> 'pattern', '');
  v_universe_mode := nullif(v_signal -> 'features' ->> 'universeMode', '');
  v_gainer_rank := nullif(v_signal -> 'features' ->> 'gainerRank', '')::numeric;
  v_effective_reasons := coalesce(v_signal -> 'reasons', '[]'::jsonb) - 'FIXED_PLAN_STOP_INVALIDATED';
  v_low_evidence := coalesce((new.metadata ->> 'low_evidence')::boolean, false);
  v_exploration := coalesce((new.metadata ->> 'is_exploration')::boolean, false);

  if v_observation_ms is null or v_observation_ms < 45000 then
    raise exception using
      errcode = '23514',
      message = format('V711_LIVE_OBSERVATION_UNDER_45S market=%s observation_ms=%s', new.market, coalesce(v_observation_ms::text, 'null'));
  end if;

  if v_low_evidence or v_exploration then
    raise exception using
      errcode = '23514',
      message = format('V711_LOW_EVIDENCE_SHADOW_ONLY market=%s low_evidence=%s exploration=%s', new.market, v_low_evidence, v_exploration);
  end if;

  if v_universe_mode is distinct from 'TOP10_24H_GAINERS_LOB_ONLY'
     or v_gainer_rank is null or v_gainer_rank < 1 or v_gainer_rank > 10 then
    raise exception using
      errcode = '23514',
      message = format('V711_OUTSIDE_TOP10 market=%s mode=%s rank=%s', new.market, coalesce(v_universe_mode, 'null'), coalesce(v_gainer_rank::text, 'null'));
  end if;

  if v_pattern is null then
    raise exception using
      errcode = '23514',
      message = format('V711_NO_PRIMARY_PATTERN market=%s', new.market);
  end if;

  if jsonb_typeof(v_effective_reasons) <> 'array' or jsonb_array_length(v_effective_reasons) > 0 then
    raise exception using
      errcode = '23514',
      message = format('V711_ENTRY_BLOCKED market=%s reasons=%s', new.market, v_effective_reasons::text);
  end if;

  if v_target_net_bps is null or v_target_net_bps <= v_min_target_net_bps then
    raise exception using
      errcode = '23514',
      message = format('V711_TARGET_NET_TOO_LOW market=%s target_net_bps=%s minimum=%s', new.market, coalesce(v_target_net_bps::text, 'null'), v_min_target_net_bps);
  end if;

  return new;
end;
$$;

drop trigger if exists az_trading_positions_strict_lob_live_v706 on public.trading_positions;
drop trigger if exists az_trading_positions_lob_live_v711 on public.trading_positions;
create trigger az_trading_positions_lob_live_v711
before insert or update on public.trading_positions
for each row execute function public.enforce_lob_live_admission_v711();

update public.trading_settings
set lob_live_admission_revision = '7.1.1-LOB-45S-FLOW-POLICY',
    lob_model_revision = '7.1.1-LOB-45S-PROFIT-OR-5PCT',
    manual_event_reason = 'v7.1.1 active: Top10 flow filter, 45s LOB, 180s review, fee-net profit or -5% hard stop',
    updated_at = now(),
    version = coalesce(version, 0) + 1
where id = 1;
