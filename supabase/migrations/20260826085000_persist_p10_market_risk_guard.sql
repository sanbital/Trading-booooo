-- Permanent, re-runnable P10 market-risk influence guard.
--
-- The incident-recovery migrations 20260826070000/071000 intentionally contain
-- a bounded one-time backfill and therefore must not be replayed by the normal
-- deployment batch. This migration carries only the durable database objects
-- required for future deployments and fresh environments.

create or replace function public.guard_unvalidated_market_regime_influence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.trading_influence is not true then
    return new;
  end if;

  if new.model_revision is distinct from 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'source', '') <>
     'BINANCE_SPOT_FUTURES_UPBIT_FULL_ACTIVE_UNIVERSE' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'momentum_phase' ->> 'model_revision', '') <>
     'C43-DYNAMIC-HORIZON-FORECAST-v1' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'conditional_forecast' ->> 'model_revision', '') <>
     'C43-DYNAMIC-HORIZON-FORECAST-v1' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'forecast_candidate_id', '') <>
     'C43_PHASE_TREE_PERSISTENCE_STRUCT_PERSIST' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features -> 'momentum_phase' ->> 'trading_influence', 'false') <> 'true' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.sample_size, 0) < 240 then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(jsonb_typeof(new.features -> 'conditional_forecast' -> 'horizons'), '') <> 'array' then
    new.trading_influence := false;
    return new;
  end if;

  if jsonb_array_length(new.features -> 'conditional_forecast' -> 'horizons') < 3 then
    new.trading_influence := false;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.guard_unvalidated_market_regime_influence() is
  'DB safety gate for P10 market-regime live influence. Allows only FULLMARKET observations from the full active universe with the C43 production forecast/candidate and sufficient sample size; all other producers are forced false.';

drop trigger if exists trg_guard_unvalidated_market_regime_influence
  on public.market_regime_observations;

create trigger trg_guard_unvalidated_market_regime_influence
before insert or update of model_revision, trading_influence
on public.market_regime_observations
for each row
execute function public.guard_unvalidated_market_regime_influence();
