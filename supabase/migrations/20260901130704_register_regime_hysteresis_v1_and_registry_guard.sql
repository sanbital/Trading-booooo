insert into public.market_regime_provenance_registry (
  model_revision,
  features_source,
  momentum_phase_revision,
  conditional_forecast_revision,
  forecast_candidate_id,
  min_sample_size,
  min_forecast_horizons,
  active,
  notes
) values (
  'MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET',
  'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE',
  'C43-DYNAMIC-HORIZON-FORECAST-v1',
  'C43-DYNAMIC-HORIZON-FORECAST-v1',
  'C43_PHASE_TREE_PERSISTENCE_STRUCT_PERSIST',
  240,
  3,
  true,
  'C01 full-market observer with two-observation hysteresis. Boundary bands are RISK_OFF↔NEUTRAL up 42/down 40, NEUTRAL↔BULL up 60/down 58, and BULL↔STRONG_BULL up 75/down 72, exactly as encoded by regime-hysteresis.ts. Registered before coordinated observer/consumer cutover; predecessor remains active during handoff.'
)
on conflict (
  model_revision,
  features_source,
  momentum_phase_revision,
  conditional_forecast_revision,
  forecast_candidate_id
) do update set
  min_sample_size = excluded.min_sample_size,
  min_forecast_horizons = excluded.min_forecast_horizons,
  active = true,
  notes = excluded.notes;

create or replace function public.guard_unvalidated_market_regime_influence()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_min_sample_size integer;
  v_min_forecast_horizons integer;
begin
  if new.trading_influence is not true then
    return new;
  end if;

  if coalesce(new.features ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'momentum_phase' ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  select r.min_sample_size, r.min_forecast_horizons
  into v_min_sample_size, v_min_forecast_horizons
  from public.market_regime_provenance_registry r
  where r.active is true
    and r.model_revision = new.model_revision
    and r.features_source = coalesce(new.features ->> 'source', '')
    and r.momentum_phase_revision = coalesce(new.features -> 'momentum_phase' ->> 'model_revision', '')
    and r.conditional_forecast_revision = coalesce(new.features -> 'conditional_forecast' ->> 'model_revision', '')
    and r.forecast_candidate_id = coalesce(new.features ->> 'forecast_candidate_id', '')
  order by r.registered_at desc
  limit 1;

  if not found then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.sample_size, 0) < coalesce(v_min_sample_size, 2147483647) then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(jsonb_typeof(new.features -> 'conditional_forecast' -> 'horizons'), '') <> 'array' then
    new.trading_influence := false;
    return new;
  end if;

  if jsonb_array_length(new.features -> 'conditional_forecast' -> 'horizons') < coalesce(v_min_forecast_horizons, 2147483647) then
    new.trading_influence := false;
    return new;
  end if;

  return new;
end;
$function$;
