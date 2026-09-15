-- Trading-booooo v6.5.2-GUARD
-- Allow legitimate single-character base symbols such as KRW-A and KRW-T.
-- Keep the exchange/quote routing invariant and uppercase alphanumeric restriction.

alter table public.scanner_candidates
  drop constraint if exists scanner_candidates_market_route_ck;
alter table public.scanner_candidates
  add constraint scanner_candidates_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;

alter table public.trading_positions
  drop constraint if exists trading_positions_market_route_ck;
alter table public.trading_positions
  add constraint trading_positions_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;

alter table public.trading_orders
  drop constraint if exists trading_orders_market_route_ck;
alter table public.trading_orders
  add constraint trading_orders_market_route_ck
  check (
    (exchange = 'upbit' and market ~ '^KRW-[A-Z0-9]{1,20}$') or
    (exchange = 'binance' and market ~ '^[A-Z0-9]{1,24}USDT$')
  ) not valid;
