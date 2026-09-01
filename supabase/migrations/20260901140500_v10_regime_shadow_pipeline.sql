create table if not exists public.v10_regime_shadow_evaluations (
  id bigint generated always as identity primary key,
  invocation_id uuid not null,
  observed_at timestamptz not null default now(),
  signal_bar_at timestamptz not null,
  observer_revision text,
  observer_regime text,
  observer_route text not null,
  model_route text not null,
  lane text not null,
  symbol text not null,
  eligible boolean not null,
  reason text not null,
  fingerprint text,
  hold_hours integer,
  cooldown_hours integer,
  validation_state text not null,
  engine_revision text not null,
  spec_sha256 text not null,
  features jsonb not null default '{}'::jsonb,
  unique (engine_revision, signal_bar_at, symbol)
);

create index if not exists v10_regime_shadow_eval_time_lane_idx
  on public.v10_regime_shadow_evaluations(signal_bar_at desc, lane, eligible);
create index if not exists v10_regime_shadow_eval_reason_idx
  on public.v10_regime_shadow_evaluations(signal_bar_at desc, reason);

create table if not exists public.v10_regime_shadow_positions (
  id uuid primary key default gen_random_uuid(),
  lane text not null check (lane in ('BULL','RANGE','BEAR')),
  symbol text not null,
  side text not null default 'LONG' check (side='LONG'),
  signal_bar_at timestamptz not null,
  entry_bar_at timestamptz not null,
  opened_at timestamptz not null,
  entry_price numeric not null check (entry_price>0),
  entry_bb_pos numeric not null,
  leverage integer not null default 3 check (leverage>0),
  hold_hours integer not null check (hold_hours>0),
  fingerprint text not null,
  validation_state text not null,
  exit_policy_key text not null,
  exit_policy_revision text not null,
  exit_policy_spec_sha256 text not null,
  policy_parameters jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  remaining_fraction numeric not null default 1 check (remaining_fraction>=0 and remaining_fraction<=1),
  realized_gross_bps numeric not null default 0,
  realized_net_bps numeric,
  terminal boolean not null default false,
  last_evaluated_bar_open_at timestamptz,
  closed_at timestamptz,
  exit_reason text,
  exit_price numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane, symbol, signal_bar_at)
);

create index if not exists v10_regime_shadow_positions_open_idx
  on public.v10_regime_shadow_positions(terminal, lane, opened_at);

create table if not exists public.v10_regime_shadow_exit_decisions (
  id bigint generated always as identity primary key,
  position_id uuid not null references public.v10_regime_shadow_positions(id) on delete cascade,
  completed_bar_at timestamptz not null,
  action text not null,
  reason text not null,
  fraction numeric not null default 0,
  trigger_price numeric,
  execution_price numeric,
  state_before jsonb not null default '{}'::jsonb,
  state_after jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (position_id, completed_bar_at)
);

create index if not exists v10_regime_shadow_exit_position_time_idx
  on public.v10_regime_shadow_exit_decisions(position_id, completed_bar_at);

alter table public.v10_regime_shadow_evaluations enable row level security;
alter table public.v10_regime_shadow_positions enable row level security;
alter table public.v10_regime_shadow_exit_decisions enable row level security;

comment on table public.v10_regime_shadow_evaluations is 'Order-free V10 BULL/RANGE/BEAR shadow signal diagnostics. Service-role only; never claimed by live executor.';
comment on table public.v10_regime_shadow_positions is 'Order-free V10 regime shadow positions for paper execution parity.';
comment on table public.v10_regime_shadow_exit_decisions is 'Order-free V10 regime shadow exit decisions; contains no exchange order routing.';