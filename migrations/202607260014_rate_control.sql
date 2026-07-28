-- Trading-booooo v5.11 — trade rate as the control variable.
--
-- Target: about five entries per hour per exchange. Frequency is not an outcome to hope
-- for; the gate serves the rate.
--
-- Every previous attempt set the EV threshold to a fixed number and let the rate be
-- whatever fell out. It fell out at roughly one entry every two hours. Tuning that constant
-- by hand only moves the failure — too tight and nothing trades, too loose and nothing is
-- filtered — and neither setting knows which it is, because the coefficients inside pWin
-- have never been measured. Measuring the realized rate and steering toward the target
-- closes that loop.
--
-- Risk is carried by SIZE, not by frequency. At 240 entries a day:
--     edge  0    ->  -3.2%/day  ->  about -62% in a month
--     edge +10pp ->  +3.2%/day  ->  about +157% in a month
-- Frequency amplifies the sign of the edge, it does not create one. So size stays small
-- while the edge is unmeasured and grows only as shadow outcomes confirm it: the samples
-- that settle the question arrive at full speed while little capital rides on the answer.

alter table public.trading_settings
  add column if not exists scalp_target_trades_per_hour numeric not null default 5,
  add column if not exists scalp_rate_window_minutes integer not null default 60,
  add column if not exists scalp_rate_max_relaxation numeric not null default 1.5,
  -- Current relaxation, written by the controller each scan.
  add column if not exists scalp_rate_relaxation numeric not null default 0,
  -- Order size while the edge is unmeasured, and the sample count at which it reaches full.
  add column if not exists scalp_unproven_size_fraction numeric not null default 0.35,
  add column if not exists scalp_samples_for_full_size integer not null default 400,
  -- Size multiplier currently in effect, written by the controller each scan. Persisted so
  -- the operator can see at a glance how much evidence the engine thinks it has.
  add column if not exists scalp_size_fraction numeric not null default 0.35;

alter table public.trading_settings drop constraint if exists trading_settings_target_rate_ck;
alter table public.trading_settings drop constraint if exists trading_settings_rate_window_ck;
alter table public.trading_settings drop constraint if exists trading_settings_rate_relaxation_ck;
alter table public.trading_settings drop constraint if exists trading_settings_unproven_size_ck;
alter table public.trading_settings drop constraint if exists trading_settings_size_fraction_ck;
alter table public.trading_settings
  add constraint trading_settings_target_rate_ck
    check (scalp_target_trades_per_hour >= 0 and scalp_target_trades_per_hour <= 60) not valid,
  add constraint trading_settings_rate_window_ck
    check (scalp_rate_window_minutes between 10 and 1440) not valid,
  add constraint trading_settings_rate_relaxation_ck
    check (scalp_rate_relaxation >= 0 and scalp_rate_relaxation <= 5) not valid,
  add constraint trading_settings_unproven_size_ck
    check (scalp_unproven_size_fraction > 0 and scalp_unproven_size_fraction <= 1) not valid,
  add constraint trading_settings_size_fraction_ck
    check (scalp_size_fraction > 0 and scalp_size_fraction <= 1) not valid;

alter table public.trading_settings validate constraint trading_settings_target_rate_ck;
alter table public.trading_settings validate constraint trading_settings_rate_window_ck;
alter table public.trading_settings validate constraint trading_settings_rate_relaxation_ck;
alter table public.trading_settings validate constraint trading_settings_unproven_size_ck;
alter table public.trading_settings validate constraint trading_settings_size_fraction_ck;

-- The funnel has to be able to supply the target. Six slots at a 45-minute average hold is
-- eight entries an hour per exchange, so slots are not the constraint — candidate supply is.
update public.trading_settings
   set max_new_entries_per_scan = greatest(coalesce(max_new_entries_per_scan, 2), 4),
       scalp_position_slots = greatest(coalesce(scalp_position_slots, 6), 6),
       updated_at = now()
 where id = 1 and strategy = 'SCALP';
