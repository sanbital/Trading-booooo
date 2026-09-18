-- Trading-booooo v5.3 — scalp pWin calibration profiles.
--
-- The scalp probability model (signal.ts) is built from hand-chosen constants that have
-- never been measured against a realized outcome. The existing forward-learning loop does
-- not cover them: its parameters are scoreThreshold / minNetRR / shortTargetAtrMult /
-- stopAtrMult, all TREND parameters, and its candidate query filters on period_score and
-- net_rr, which SCALP does not gate on.
--
-- This table holds Platt-scaling profiles fitted on realized scalp outcomes:
--   p_calibrated = sigmoid(a * logit(p_raw) + b)
-- a = 1, b = 0 is the identity. Exactly one row may be active.

create table if not exists public.scalp_calibration_profiles (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  active            boolean not null default false,
  -- Platt parameters.
  slope             numeric not null default 1,
  intercept         numeric not null default 0,
  -- Fit provenance.
  train_samples     integer not null default 0,
  holdout_samples   integer not null default 0,
  train_brier       numeric,
  holdout_brier     numeric,
  incumbent_brier   numeric,
  mean_predicted    numeric,
  mean_realized     numeric,
  -- Realized share of positions that reached either barrier — the empirical counterpart
  -- of geometry.ts's modelled resolveProbability.
  realized_resolve_rate numeric,
  reliability_bins  jsonb not null default '[]'::jsonb,
  promotion_reason  text,
  notes             jsonb not null default '{}'::jsonb
);

create unique index if not exists scalp_calibration_profiles_single_active
  on public.scalp_calibration_profiles (active) where active;

create index if not exists scalp_calibration_profiles_created_at
  on public.scalp_calibration_profiles (created_at desc);

alter table public.scalp_calibration_profiles enable row level security;
revoke all on public.scalp_calibration_profiles from public, anon, authenticated;
grant select, insert, update on public.scalp_calibration_profiles to service_role;

-- Seed the identity profile so the live path always has a row to read and the
-- uncalibrated behavior is explicit rather than implicit.
insert into public.scalp_calibration_profiles (active, slope, intercept, promotion_reason, notes)
select true, 1, 0, 'seed_identity', '{"seeded_by":"202607260005"}'::jsonb
where not exists (select 1 from public.scalp_calibration_profiles);

-- Promote a challenger atomically: deactivate the incumbent and insert the new active row.
create or replace function public.promote_scalp_calibration(
  p_slope numeric,
  p_intercept numeric,
  p_train_samples integer,
  p_holdout_samples integer,
  p_train_brier numeric,
  p_holdout_brier numeric,
  p_incumbent_brier numeric,
  p_mean_predicted numeric,
  p_mean_realized numeric,
  p_realized_resolve_rate numeric,
  p_reliability_bins jsonb,
  p_promotion_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.scalp_calibration_profiles;
begin
  update public.scalp_calibration_profiles set active = false where active;
  insert into public.scalp_calibration_profiles (
    active, slope, intercept, train_samples, holdout_samples, train_brier, holdout_brier,
    incumbent_brier, mean_predicted, mean_realized, realized_resolve_rate,
    reliability_bins, promotion_reason
  ) values (
    true, p_slope, p_intercept, p_train_samples, p_holdout_samples, p_train_brier,
    p_holdout_brier, p_incumbent_brier, p_mean_predicted, p_mean_realized,
    p_realized_resolve_rate, coalesce(p_reliability_bins, '[]'::jsonb), p_promotion_reason
  ) returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.promote_scalp_calibration(numeric, numeric, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, jsonb, text) from public, anon, authenticated;
grant execute on function public.promote_scalp_calibration(numeric, numeric, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, jsonb, text) to service_role;
