-- Trading-booooo v6.2.0-HEAT — order-book trap thresholds and LOB self-correction.
--
-- v6.1 shipped three hazard measures that entry never acted on: the spoof gate was set at
-- 0.97 while the scanner's own risk label fires at 0.65, so a book the system had already
-- flagged remained buyable. It also had no self-correction path at all — `scalp-calibration`
-- reads `metadata.scalp_signal`, and the LOB route writes `metadata.lob_signal`, so the job
-- has been fitting a model that no longer trades.
--
-- Every column is created before it is written, and every constraint is dropped before it is
-- added, so a partially applied run can be re-pushed.

alter table public.trading_settings
  add column if not exists lob_trap_ask_iceberg_absorption numeric not null default 0.55,
  add column if not exists lob_trap_ask_iceberg_refill numeric not null default 0.60,
  add column if not exists lob_trap_bid_spoof numeric not null default 0.60,
  add column if not exists lob_trap_ask_spoof numeric not null default 0.70,
  add column if not exists lob_trap_stop_noise_multiple numeric not null default 1.25,
  add column if not exists lob_trap_max_viable_stop_bps numeric not null default 200,
  add column if not exists lob_trap_flicker_per_trade numeric not null default 25,
  add column if not exists lob_learning_enabled boolean not null default true;

alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_iceberg_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_refill_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_bid_spoof_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_ask_spoof_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_noise_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_stop_ck;
alter table public.trading_settings drop constraint if exists trading_settings_lob_trap_flicker_ck;

alter table public.trading_settings
  add constraint trading_settings_lob_trap_iceberg_ck
    check (lob_trap_ask_iceberg_absorption > 0 and lob_trap_ask_iceberg_absorption <= 1) not valid,
  add constraint trading_settings_lob_trap_refill_ck
    check (lob_trap_ask_iceberg_refill > 0 and lob_trap_ask_iceberg_refill <= 5) not valid,
  add constraint trading_settings_lob_trap_bid_spoof_ck
    check (lob_trap_bid_spoof > 0 and lob_trap_bid_spoof <= 1) not valid,
  add constraint trading_settings_lob_trap_ask_spoof_ck
    check (lob_trap_ask_spoof > 0 and lob_trap_ask_spoof <= 1) not valid,
  -- A multiple below 1 would place the stop inside the book's own median adverse
  -- excursion, which is the condition this release exists to stop happening.
  add constraint trading_settings_lob_trap_noise_ck
    check (lob_trap_stop_noise_multiple >= 1 and lob_trap_stop_noise_multiple <= 4) not valid,
  add constraint trading_settings_lob_trap_stop_ck
    check (lob_trap_max_viable_stop_bps >= 20 and lob_trap_max_viable_stop_bps <= 500) not valid,
  add constraint trading_settings_lob_trap_flicker_ck
    check (lob_trap_flicker_per_trade >= 1 and lob_trap_flicker_per_trade <= 500) not valid;

alter table public.trading_settings validate constraint trading_settings_lob_trap_iceberg_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_refill_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_bid_spoof_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_ask_spoof_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_noise_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_stop_ck;
alter table public.trading_settings validate constraint trading_settings_lob_trap_flicker_ck;

-- Measured per-pattern and per-trap statistics. One active row; history is kept so a bad
-- promotion can be inspected rather than merely undone.
create table if not exists public.lob_learning_profiles (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  active boolean not null default false,
  samples integer not null default 0,
  base_hit_rate numeric not null default 0,
  window_hours integer not null default 168,
  patterns jsonb not null default '[]'::jsonb,
  traps jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists lob_learning_profiles_active_idx
  on public.lob_learning_profiles (active, generated_at desc);

alter table public.lob_learning_profiles enable row level security;

drop policy if exists lob_learning_profiles_service_all on public.lob_learning_profiles;
create policy lob_learning_profiles_service_all
  on public.lob_learning_profiles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Only one profile may be active. Enforced rather than left to the job, because two active
-- rows would make the correction applied at any moment depend on read ordering.
create unique index if not exists lob_learning_profiles_single_active_idx
  on public.lob_learning_profiles (active) where active;
