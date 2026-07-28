-- Trading-booooo v5.8 — no mechanical exit on holding time.
--
-- A position is closed by the market: target, stop, trailing stop, live expected value,
-- executed-flow reversal, orderbook reversal, spread blowout, bid support evaporating, or
-- a trend flip. Elapsed time closes nothing.
--
-- Time survives in exactly one place — decayedPWin() lowers the weight of the entry
-- reading as it ages. That is a confidence model, not a clock, and it can only change the
-- estimate that the market-data test then evaluates.
--
-- The former safety TTL is replaced by a DATA-staleness check that raises an operator
-- alert and sells nothing. A position with live quotes is never closed for being old; a
-- position without them is not being managed, which is a different problem and must not
-- be answered by selling blind into a market the engine cannot see.

alter table public.trading_settings
  -- Executed-flow pressure at or below this counts as seller aggression.
  add column if not exists scalp_hold_reversal_trade_pressure numeric not null default -0.30,
  -- Spread at which execution cost alone has destroyed the remainder of the trade.
  add column if not exists scalp_hold_max_spread_bps numeric not null default 40,
  -- Bid depth as a fraction of the depth present at entry.
  add column if not exists scalp_hold_min_bid_depth_ratio numeric not null default 0.35,
  -- Minutes WITHOUT A USABLE MARKET EVALUATION before the position is flagged for review.
  -- This is not a holding limit and never triggers a sale.
  add column if not exists scalp_stale_data_minutes integer not null default 30;

alter table public.trading_settings drop constraint if exists trading_settings_hold_trade_pressure_ck;
alter table public.trading_settings drop constraint if exists trading_settings_hold_spread_ck;
alter table public.trading_settings drop constraint if exists trading_settings_hold_bid_depth_ck;
alter table public.trading_settings drop constraint if exists trading_settings_stale_data_ck;
alter table public.trading_settings
  add constraint trading_settings_hold_trade_pressure_ck
    check (scalp_hold_reversal_trade_pressure >= -1 and scalp_hold_reversal_trade_pressure <= 0) not valid,
  add constraint trading_settings_hold_spread_ck
    check (scalp_hold_max_spread_bps between 10 and 200) not valid,
  add constraint trading_settings_hold_bid_depth_ck
    check (scalp_hold_min_bid_depth_ratio >= 0 and scalp_hold_min_bid_depth_ratio <= 1) not valid,
  add constraint trading_settings_stale_data_ck
    check (scalp_stale_data_minutes between 5 and 1440) not valid;

alter table public.trading_settings validate constraint trading_settings_hold_trade_pressure_ck;
alter table public.trading_settings validate constraint trading_settings_hold_spread_ck;
alter table public.trading_settings validate constraint trading_settings_hold_bid_depth_ck;
alter table public.trading_settings validate constraint trading_settings_stale_data_ck;

-- Open positions carry a max_holding_at from the previous scheme. SCALP no longer reads
-- it, but pushing it far out removes any chance of a stale row closing a live position if
-- the strategy is switched back to TREND mid-flight.
update public.trading_positions
   set max_holding_at = now() + interval '30 days'
 where state = 'OPEN'
   and exists (select 1 from public.trading_settings s where s.id = 1 and s.strategy = 'SCALP');

update public.trading_settings set updated_at = now() where id = 1;

-- v5.8.1: EV threshold as a fraction of cost.
--
-- At the throughput optimum W* = 2C/δ the expected value per trade is exactly C. The gate
-- kept an absolute 0.10% while C under maker execution is 0.08%, so it demanded more than
-- the design produces and blocked every candidate at or below about +15pp of signal edge.
alter table public.trading_settings
  add column if not exists scalp_min_edge_cost_fraction numeric not null default 0.25;
alter table public.trading_settings drop constraint if exists trading_settings_min_edge_cost_fraction_ck;
alter table public.trading_settings
  add constraint trading_settings_min_edge_cost_fraction_ck
    check (scalp_min_edge_cost_fraction >= 0 and scalp_min_edge_cost_fraction <= 1) not valid;
alter table public.trading_settings validate constraint trading_settings_min_edge_cost_fraction_ck;
