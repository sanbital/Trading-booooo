-- Restore the registry-driven regime influence guard (2026-09-24).
--
-- Root cause of "market_regime_observations.trading_influence=true stopped at
-- 2026-09-09 23:25Z": the live guard_unvalidated_market_regime_influence() had been
-- overwritten (outside the migration history) by the pre-2026-09-01 version that
-- hard-codes model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'. The
-- observer has written 'MARKET-REGIME-OBSERVER-v2-C01-HYSTERESIS-v1-FULLMARKET'
-- since the 2026-09-01 cutover, and that revision is registered ACTIVE in
-- market_regime_provenance_registry, so every new observation was silently forced
-- to trading_influence=false although features.trading_influence=true.
--
-- This re-creates exactly the function body of
-- 20260901130704_register_regime_hysteresis_v1_and_registry_guard.sql. It does not
-- touch any existing row (no backfill) and does not write a regime value: rows keep
-- whatever regime the observer computes. V17 entry routing does not read this flag
-- (routeAuthority = LEADER_MOMENTUM_V17); it only restores truthful provenance for
-- diagnostics and the dormant regime consumers.
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
