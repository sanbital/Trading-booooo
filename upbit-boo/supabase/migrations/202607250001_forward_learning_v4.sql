alter table public.scanner_candidates
  add column if not exists period_score double precision,
  add column if not exists intended_horizon_hours int not null default 24,
  add column if not exists recommendation_valid_until timestamptz,
  add column if not exists active_policy_key text not null default 'FIXED_T1',
  add column if not exists profile_version int not null default 0,
  add column if not exists feature_vector jsonb not null default '{}'::jsonb,
  add column if not exists applied_parameters jsonb not null default '{}'::jsonb;

alter table public.scanner_runtime_profiles
  add column if not exists parent_version int;

create table if not exists public.scanner_signal_horizon_outcomes (
  candidate_id uuid not null references public.scanner_candidates(id) on delete cascade,
  horizon_hours int not null,
  is_final boolean not null default false,
  evaluated_at timestamptz not null default now(),
  evaluated_until timestamptz not null,
  active_policy_key text not null,
  active_outcome jsonb not null,
  policy_outcomes jsonb not null,
  optimal_policy_key text,
  optimal_net_return_pct double precision not null default 0,
  failure_causes jsonb not null default '[]'::jsonb,
  primary key(candidate_id, horizon_hours)
);

create index if not exists scanner_candidates_pending_learning_idx
  on public.scanner_candidates(decision, created_at, intended_horizon_hours);
create index if not exists scanner_candidates_profile_idx
  on public.scanner_candidates(profile_version, created_at);
create index if not exists scanner_horizon_outcomes_final_idx
  on public.scanner_signal_horizon_outcomes(is_final, evaluated_at);

alter table public.scanner_signal_horizon_outcomes enable row level security;
-- service_role only; no public policies.
