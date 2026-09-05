-- Trading-booooo v6.5.0-LATENCY
--
-- Three changes, each closing a gap that the 2026-07-27 joint review identified and that
-- the code confirmed:
--
--   1. LATENCY IS MEASURED. `cost-model.ts` has subtracted a flat `latencyPenalty: 0.0001`
--      from every trade's edge since v5.2 without one millisecond ever being recorded.
--      A constant with no measurement behind it was deciding which trades cleared the gate.
--      `trading_latency_samples` records the real path; the hourly calibration job turns it
--      into `scalp_latency_penalty_bps`, which is what the gate then charges.
--
--   2. DECISIONS ARE A LEDGER. Until now a rejected candidate left only a log line and an
--      accepted one left an order, with nothing joining scan -> decision -> order ->
--      position -> exit. `trading_decisions` is that join, and it records rejections as
--      first-class rows: the reasons candidates DO NOT trade are the primary evidence for
--      whether the gates are calibrated, and they were the least durable thing in the system.
--
--   3. CAPITAL ROTATES. Entry has only ever asked whether a book clears its own cost floor.
--      With every slot full, a book worth ten times the worst holding was declined without
--      being compared to it. Rotation makes the comparison, charged for the round trip it
--      would cost and damped so it cannot churn on estimation noise.

-- ---------------------------------------------------------------------------
-- 1. The decision ledger
-- ---------------------------------------------------------------------------
create table if not exists public.trading_decisions (
  id            uuid primary key default gen_random_uuid(),
  cycle_id      uuid,
  scan_id       text,
  exchange      text not null,
  market        text not null,
  strategy      text,
  -- ENTERED, REJECTED, ROTATED_IN, ERROR. A rejection is data, not an absence of data.
  outcome       text not null,
  reason        text,
  ev_lower_bound_bps numeric,
  target_bps    numeric,
  stop_bps      numeric,
  neutral_win_rate numeric,
  p_target      numeric,
  -- Everything the decision was made from, so a past decision can be re-derived rather
  -- than reconstructed from memory.
  audit         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists trading_decisions_created_idx  on public.trading_decisions (created_at desc);
create index if not exists trading_decisions_outcome_idx  on public.trading_decisions (outcome, created_at desc);
create index if not exists trading_decisions_market_idx   on public.trading_decisions (exchange, market, created_at desc);

comment on table public.trading_decisions is
  'One row per candidate evaluated at order time, entered or not. The join key between a scan and everything that follows it.';

-- The chain. A position must be traceable back to the book that produced it.
alter table public.trading_orders    add column if not exists decision_id uuid;
alter table public.trading_positions add column if not exists decision_id uuid;

create index if not exists trading_orders_decision_idx    on public.trading_orders (decision_id);
create index if not exists trading_positions_decision_idx on public.trading_positions (decision_id);

-- ---------------------------------------------------------------------------
-- 2. Latency samples
-- ---------------------------------------------------------------------------
create table if not exists public.trading_latency_samples (
  id                    bigserial primary key,
  decision_id           uuid,
  exchange              text not null,
  market                text not null,
  outcome               text,
  -- The exchange's own stamp on the orderbook. Null where the venue does not publish one
  -- (Binance /api/v3/depth), which is itself worth counting.
  book_captured_at      timestamptz,
  book_to_quote_ms      integer,
  quote_to_decision_ms  integer,
  decision_to_order_ms  integer,
  order_round_trip_ms   integer,
  tick_to_decision_ms   integer,
  tick_to_order_ms      integer,
  tick_to_ack_ms        integer,
  created_at            timestamptz not null default now()
);

create index if not exists trading_latency_created_idx  on public.trading_latency_samples (created_at desc);
create index if not exists trading_latency_exchange_idx on public.trading_latency_samples (exchange, created_at desc);

comment on table public.trading_latency_samples is
  'tick-to-decision and tick-to-order timings. p50/p95/p99 are computed from these; nothing is pre-aggregated so the raw distribution stays inspectable.';

-- ---------------------------------------------------------------------------
-- 3. Settings: measured latency cost, and rotation
-- ---------------------------------------------------------------------------
alter table public.trading_settings
  add column if not exists scalp_latency_penalty_bps numeric not null default 0,
  add column if not exists scalp_latency_samples     integer not null default 0,
  add column if not exists scalp_latency_source      text    not null default 'ASSUMED',
  add column if not exists scalp_latency_p95_ms      numeric not null default 0,
  add column if not exists scalp_auto_tune_latency   boolean not null default true,
  -- The LOB observation window. Read by the engine since v6.1 as a hardcoded 8000ms and
  -- never exposed as a column, so it could not be changed from the dashboard -- the same
  -- class of gap that broke the v5.5 deploy on scalp_resting_tp. Latency cost is scaled
  -- against this window, so it now has to be a real setting.
  add column if not exists lob_observation_window_ms      integer not null default 8000,
  add column if not exists lob_rotation_enabled           boolean not null default true,
  add column if not exists lob_rotation_hysteresis        numeric not null default 0.40,
  add column if not exists lob_rotation_min_hold_seconds  integer not null default 60,
  add column if not exists lob_max_rotations_per_hour     integer not null default 6;

comment on column public.trading_settings.scalp_latency_penalty_bps is
  'Adverse-selection cost prior in bps. Defaults to 0 until p95 tick-to-order and symbol volatility are measured.';
comment on column public.trading_settings.scalp_latency_source is
  'ASSUMED = the pre-v6.5 flat constant. MEASURED = derived from trading_latency_samples.';
comment on column public.trading_settings.lob_rotation_enabled is
  'Allow a candidate to displace the worst held position when no slot is free.';

alter table public.trading_settings drop constraint if exists trading_settings_latency_penalty_ck;
alter table public.trading_settings
  add constraint trading_settings_latency_penalty_ck
  check (scalp_latency_penalty_bps >= 0 and scalp_latency_penalty_bps <= 15) not valid;
alter table public.trading_settings validate constraint trading_settings_latency_penalty_ck;

alter table public.trading_settings drop constraint if exists trading_settings_latency_source_ck;
alter table public.trading_settings
  add constraint trading_settings_latency_source_ck
  check (scalp_latency_source in ('ASSUMED','MEASURED')) not valid;
alter table public.trading_settings validate constraint trading_settings_latency_source_ck;

-- Rotation must not be able to become a churn machine by configuration. The hysteresis
-- floor and the hourly ceiling are bounded in the schema, not only in code.
alter table public.trading_settings drop constraint if exists trading_settings_rotation_hysteresis_ck;
alter table public.trading_settings
  add constraint trading_settings_rotation_hysteresis_ck
  check (lob_rotation_hysteresis >= 0.10 and lob_rotation_hysteresis <= 3.0) not valid;
alter table public.trading_settings validate constraint trading_settings_rotation_hysteresis_ck;

alter table public.trading_settings drop constraint if exists trading_settings_observation_window_ck;
alter table public.trading_settings
  add constraint trading_settings_observation_window_ck
  check (lob_observation_window_ms between 2000 and 60000) not valid;
alter table public.trading_settings validate constraint trading_settings_observation_window_ck;

alter table public.trading_settings drop constraint if exists trading_settings_rotation_rate_ck;
alter table public.trading_settings
  add constraint trading_settings_rotation_rate_ck
  check (lob_max_rotations_per_hour between 0 and 60
     and lob_rotation_min_hold_seconds between 10 and 3600) not valid;
alter table public.trading_settings validate constraint trading_settings_rotation_rate_ck;

update public.trading_settings
   set lob_observation_window_ms = 8000,
       scalp_latency_penalty_bps = 0,
       scalp_latency_source      = 'ASSUMED',
       lob_rotation_enabled      = true,
       lob_rotation_hysteresis   = 0.40,
       lob_rotation_min_hold_seconds = 60,
       lob_max_rotations_per_hour    = 6
 where id = 1;
