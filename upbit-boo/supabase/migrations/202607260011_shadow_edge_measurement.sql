-- Trading-booooo v5.9 — shadow edge measurement.
--
-- The calibration loop learned only from filled positions. At the observed rate of about
-- one live entry every two hours its 200-sample threshold is roughly seventeen days away,
-- so in practice self-correction never begins: edgeBudget stays a guess, the barrier width
-- derived from it stays wrong, and the gate keeps rejecting candidates. The system could
-- not correct itself out of the condition that was stopping it from trading.
--
-- The scanner already writes EVERY finalist to scanner_candidates. At eight finalists per
-- exchange on a sixty-second scan that is ~960 rows an hour against 0.5 fills — about
-- 1900x the evidence, already on disk and unread. Replaying the price path that followed
-- each one measures the single number the whole design rests on:
--
--     delta = realized target-first rate  -  neutral rate S/(T+S)
--
-- edgeBudget IS that quantity, and barrier width is 2C/delta.

create table if not exists public.scalp_shadow_outcomes (
  id                bigint generated always as identity primary key,
  candidate_id      uuid not null references public.scanner_candidates(id) on delete cascade,
  scan_id           uuid,
  exchange          text not null,
  market            text not null,
  scanned_at        timestamptz not null,
  evaluated_at      timestamptz not null default now(),
  -- What the model claimed at scan time.
  predicted_p_win   numeric,
  neutral_win_rate  numeric,
  signal_edge       numeric,
  target_pct        numeric,
  stop_pct          numeric,
  decision          text,
  -- What the market actually did.
  outcome           text not null check (outcome in ('TARGET','STOP','TIMEOUT')),
  bars_to_resolve   integer,
  realized_return   numeric,
  features          jsonb not null default '{}'::jsonb,
  unique (candidate_id)
);

create index if not exists scalp_shadow_outcomes_scanned_idx on public.scalp_shadow_outcomes (scanned_at desc);
create index if not exists scalp_shadow_outcomes_outcome_idx on public.scalp_shadow_outcomes (outcome);

alter table public.scalp_shadow_outcomes enable row level security;
revoke all on public.scalp_shadow_outcomes from public, anon, authenticated;
grant select, insert, update on public.scalp_shadow_outcomes to service_role;

-- Measured edge, written back so the geometry can use data instead of an assumption.
alter table public.trading_settings
  add column if not exists scalp_edge_budget_source text not null default 'ASSUMED',
  add column if not exists scalp_edge_budget_measured_at timestamptz,
  add column if not exists scalp_edge_budget_samples integer not null default 0,
  -- Automatic write-back of a measured edgeBudget. Off means measure and report only.
  add column if not exists scalp_auto_tune_edge_budget boolean not null default false;

alter table public.trading_settings drop constraint if exists trading_settings_edge_budget_source_ck;
alter table public.trading_settings
  add constraint trading_settings_edge_budget_source_ck
    check (scalp_edge_budget_source in ('ASSUMED','MEASURED')) not valid;
alter table public.trading_settings validate constraint trading_settings_edge_budget_source_ck;

-- Real fills remain scarce, and the Platt fit is already shrunk toward the identity by
-- n/(n+300). The extra 200-sample gate on top of that shrinkage was belt-and-braces that
-- only served to prevent the loop from ever starting.
comment on column public.trading_settings.scalp_edge_budget_source is
  'ASSUMED = hand-set. MEASURED = fitted from shadow outcomes by the scalp-calibration job.';

update public.trading_settings set updated_at = now() where id = 1;
