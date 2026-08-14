-- Market regime observer v1
-- Learning-only: this ledger must never affect entry/exit decisions.

create table if not exists public.market_regime_observations (
  id uuid primary key default gen_random_uuid(),
  observation_bucket timestamptz not null unique,
  observed_at timestamptz not null default now(),
  model_revision text not null,
  predicted_regime text not null check (predicted_regime in ('STRONG_BULL','BULL','NEUTRAL','RISK_OFF')),
  bull_score double precision not null check (bull_score >= 0 and bull_score <= 100),
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  sample_size integer not null check (sample_size >= 0),
  features jsonb not null default '{}'::jsonb,
  benchmark_prices jsonb not null default '{}'::jsonb,
  liquid_prices jsonb not null default '{}'::jsonb,
  trading_influence boolean not null default false check (trading_influence is false),
  created_at timestamptz not null default now()
);

create index if not exists market_regime_observations_observed_at_idx
  on public.market_regime_observations (observed_at desc);
create index if not exists market_regime_observations_regime_idx
  on public.market_regime_observations (predicted_regime, observed_at desc);

create table if not exists public.market_regime_outcomes (
  observation_id uuid not null references public.market_regime_observations(id) on delete cascade,
  horizon_minutes integer not null check (horizon_minutes in (30, 120, 360)),
  evaluated_at timestamptz not null default now(),
  actual_horizon_minutes double precision not null check (actual_horizon_minutes > 0),
  realized_regime text not null check (realized_regime in ('STRONG_BULL','BULL','NEUTRAL','RISK_OFF')),
  realized_bull_score double precision not null check (realized_bull_score >= 0 and realized_bull_score <= 100),
  exact_match boolean not null,
  directional_match boolean not null,
  regime_distance integer not null check (regime_distance >= 0 and regime_distance <= 3),
  forward_benchmark_pct double precision,
  forward_median_pct double precision,
  forward_positive_fraction double precision check (forward_positive_fraction is null or (forward_positive_fraction >= 0 and forward_positive_fraction <= 1)),
  sample_size integer not null default 0 check (sample_size >= 0),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (observation_id, horizon_minutes)
);

create index if not exists market_regime_outcomes_horizon_eval_idx
  on public.market_regime_outcomes (horizon_minutes, evaluated_at desc);

alter table public.market_regime_observations enable row level security;
alter table public.market_regime_outcomes enable row level security;

revoke all on table public.market_regime_observations from anon, authenticated;
revoke all on table public.market_regime_outcomes from anon, authenticated;
grant select, insert, update, delete on table public.market_regime_observations to service_role;
grant select, insert, update, delete on table public.market_regime_outcomes to service_role;

insert into public.edge_internal_tokens(name, token, created_at, rotated_at)
values (
  'market-regime-observer',
  encode(extensions.gen_random_bytes(32), 'hex'),
  now(),
  now()
)
on conflict (name) do nothing;
