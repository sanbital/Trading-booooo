-- Restore the intended P10 market-risk data path without removing the DB safety guard.
--
-- The observer already emits trading_influence=true only when the full-market
-- breadth snapshot is available. A legacy DB-only trigger was overriding every
-- C01/FULLMARKET row back to false, so the P10 consumer's
-- `trading_influence=eq.true` query could never see a live observation.
--
-- Keep the trigger, but allow only the exact production observer/forecast
-- provenance that the P10 overlay was rolled out with. Unknown, stale, legacy,
-- or malformed producers remain blocked at the database boundary.

create or replace function public.guard_unvalidated_market_regime_influence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- False stays false. Only an explicit producer request for live influence is
  -- eligible for the allow-list checks below.
  if new.trading_influence is not true then
    return new;
  end if;

  if new.model_revision is distinct from 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET' then
    new.trading_influence := false;
    return new;
  end if;

  if coalesce(new.features ->> 'source', '') <>
     'MARKET-REGIME-OBSERVER-v2-C01-D3X2-T10-G0-C43-FULLMARKET' then
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
  'DB safety gate for market-regime live influence. Allows only the exact FULLMARKET+C43 production provenance used by the guarded P10 exit-risk consumer; all other producers are forced false.';

-- Restore only the current consumer lookback window so the P10 overlay recovers
-- immediately after this migration. Older observations intentionally remain
-- non-influential.
update public.market_regime_observations
set trading_influence = true
where observed_at >= now() - interval '14 minutes'
  and trading_influence = false
  and model_revision = 'MARKET-REGIME-OBSERVER-v2-C01-FULLMARKET'
  and coalesce(features ->> 'source', '') =
    'MARKET-REGIME-OBSERVER-v2-C01-D3X2-T10-G0-C43-FULLMARKET'
  and coalesce(features ->> 'trading_influence', 'false') = 'true'
  and coalesce(features -> 'momentum_phase' ->> 'model_revision', '') =
    'C43-DYNAMIC-HORIZON-FORECAST-v1'
  and coalesce(features -> 'momentum_phase' ->> 'trading_influence', 'false') = 'true'
  and coalesce(sample_size, 0) >= 240
  and jsonb_typeof(features -> 'conditional_forecast' -> 'horizons') = 'array';
