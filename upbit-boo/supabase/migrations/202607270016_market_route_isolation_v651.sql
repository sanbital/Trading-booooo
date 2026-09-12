-- Trading-booooo v6.5.1-GUARD
--
-- The gateway correctly rejected an Upbit quote whose market was not KRW-BASE, but the
-- autotrader grouped every open position quote in one Promise.all. One malformed row
-- therefore rejected the entire monitor cycle and stopped exit evaluation for every
-- healthy position.
--
-- These NOT VALID constraints immediately protect every new/updated row while allowing a
-- deployment to finish even if historical dirty rows still need operator review. They can
-- be validated separately after SQL_CHECK_v6.5.1.sql returns zero invalid rows.

alter table public.scanner_candidates
  drop constraint if exists scanner_candidates_market_route_ck;
alter table public.scanner_candidates
  add constraint scanner_candidates_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
  ) not valid;

alter table public.trading_positions
  drop constraint if exists trading_positions_market_route_ck;
alter table public.trading_positions
  add constraint trading_positions_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
  ) not valid;

alter table public.trading_orders
  drop constraint if exists trading_orders_market_route_ck;
alter table public.trading_orders
  add constraint trading_orders_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{2,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{2,24}USDT$')
  ) not valid;

-- No unearned latency cost before the first measured sample set. Operators may still set
-- an explicit non-zero prior later; the release default is observe-first.
alter table public.trading_settings
  alter column scalp_latency_penalty_bps set default 0;

update public.trading_settings
set scalp_latency_penalty_bps = 0,
    scalp_latency_samples = 0,
    scalp_latency_source = 'ASSUMED',
    scalp_latency_p95_ms = 0,
    updated_at = now()
where id = 1
  and scalp_latency_source = 'ASSUMED'
  and coalesce(scalp_latency_samples, 0) = 0;
