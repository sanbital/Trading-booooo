create extension if not exists pgcrypto;
create table if not exists public.scanner_scan_runs (
  id uuid primary key, created_at timestamptz not null default now(), mode text not null,
  engine_version text not null, status text not null, profile_version int not null default 0,
  profile_source text not null default 'CODE_DEFAULT', summary jsonb not null default '{}'::jsonb
);
create table if not exists public.scanner_candidates (
  id uuid primary key default gen_random_uuid(), scan_id uuid not null references public.scanner_scan_runs(id) on delete cascade,
  exchange text not null check(exchange in ('upbit','binance')), market text not null, created_at timestamptz not null default now(),
  decision text not null, score double precision not null, confidence double precision,
  entry_low double precision, entry_high double precision, stop_price double precision, target_1 double precision, target_2 double precision,
  net_rr double precision, estimated_cost_pct double precision, failed_gate_count int not null default 0, snapshot jsonb not null,
  unique(scan_id,exchange,market)
);
create table if not exists public.scanner_signal_outcomes (
  candidate_id uuid primary key references public.scanner_candidates(id) on delete cascade,
  evaluated_at timestamptz not null default now(), evaluated_until timestamptz not null, entered boolean not null,
  entry_price double precision, entry_time timestamptz, outcome text not null, net_return_pct double precision not null,
  mfe_pct double precision not null, mae_pct double precision not null, peak_capture_ratio double precision,
  target_first boolean not null default false, stop_first boolean not null default false
);
create table if not exists public.scanner_runtime_profiles (
  version serial primary key, active boolean not null default false, source text not null,
  parameters jsonb not null, samples int not null, validation_samples int not null, objective double precision not null,
  champion_objective double precision, evidence jsonb not null default '{}'::jsonb, promoted_at timestamptz not null default now()
);
create unique index if not exists scanner_one_active_profile on public.scanner_runtime_profiles(active) where active;
create index if not exists scanner_candidates_created_idx on public.scanner_candidates(created_at);
create index if not exists scanner_candidates_market_idx on public.scanner_candidates(exchange,market,created_at);
alter table public.scanner_scan_runs enable row level security;
alter table public.scanner_candidates enable row level security;
alter table public.scanner_signal_outcomes enable row level security;
alter table public.scanner_runtime_profiles enable row level security;
-- Edge Function uses service_role; no public policies are intentionally created.
