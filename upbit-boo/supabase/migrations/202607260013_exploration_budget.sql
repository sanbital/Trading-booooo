-- Trading-booooo v5.10 — exploration budget.
--
-- The EV gate rejects a candidate using pWin = neutralWinRate + signalEdge, where
-- signalEdge comes from weights chosen by hand (0.18 imbalance, 0.12 trade pressure,
-- 0.08 stability, 0.10 breakout) that have never been measured against an outcome.
--
-- Being strict on that basis is not caution — it is arbitrary, and it is self-sealing:
-- no trades means no outcomes, no outcomes means no calibration, and the weights stay
-- unmeasured forever. The system talks itself out of the only activity that could tell it
-- whether it is right.
--
-- This buys a bounded amount of information. A capped number of entries per day, sized
-- down, drawn from candidates the gate refused ONLY for a marginal expected value. Kill
-- switch, daily loss limit, depth, spread, exchange minimums and the operator allocation
-- all still apply.
--
-- Worst case, if the signal is worthless: 40 trades x 0.08% round trip x 1/3 size across
-- 6 slots is under 0.2% of capital per day, in exchange for 40 samples that include
-- execution — which shadow replay cannot provide.

alter table public.trading_settings
  add column if not exists scalp_exploration_per_day integer not null default 40,
  add column if not exists scalp_exploration_per_scan integer not null default 1,
  add column if not exists scalp_exploration_size_fraction numeric not null default 0.33,
  add column if not exists scalp_exploration_min_edge_cost_multiple numeric not null default -1,
  -- Read by the cost model and the geometry; previously code-only.
  add column if not exists scalp_min_edge_cost_fraction numeric not null default 0.25;

alter table public.trading_settings drop constraint if exists trading_settings_exploration_per_day_ck;
alter table public.trading_settings drop constraint if exists trading_settings_exploration_per_scan_ck;
alter table public.trading_settings drop constraint if exists trading_settings_exploration_size_ck;
alter table public.trading_settings drop constraint if exists trading_settings_exploration_floor_ck;
alter table public.trading_settings
  add constraint trading_settings_exploration_per_day_ck
    check (scalp_exploration_per_day between 0 and 500) not valid,
  add constraint trading_settings_exploration_per_scan_ck
    check (scalp_exploration_per_scan between 0 and 10) not valid,
  add constraint trading_settings_exploration_size_ck
    check (scalp_exploration_size_fraction > 0 and scalp_exploration_size_fraction <= 1) not valid,
  add constraint trading_settings_exploration_floor_ck
    check (scalp_exploration_min_edge_cost_multiple >= -5 and scalp_exploration_min_edge_cost_multiple <= 0) not valid;

alter table public.trading_settings validate constraint trading_settings_exploration_per_day_ck;
alter table public.trading_settings validate constraint trading_settings_exploration_per_scan_ck;
alter table public.trading_settings validate constraint trading_settings_exploration_size_ck;
alter table public.trading_settings validate constraint trading_settings_exploration_floor_ck;

update public.trading_settings set updated_at = now() where id = 1;
