-- V24 entry gate operator control.
--
-- The V24 entry rule refuses to trade without an expected-edge estimate backed by at
-- least 30 samples. No such estimator exists, and the estimate that CAN be built from the
-- measured data is negative (research/v24/HYPOTHESIS_TEST_20260915.md). So the gate blocks
-- every entry unless an operator states the edge assumption explicitly here.
--
-- Keeping that assumption in a row rather than in code or an env var is deliberate: the
-- audit found unvalidated operator overrides running as if they were validated policy
-- (E1, X1, QV3). This table makes the assumption, its author and its reason part of the
-- record, and every V24 decision stamps basis = OPERATOR_ASSUMED_UNVALIDATED.
--
-- Defaults are OFF with no edge, so applying this migration changes no behaviour.
create table if not exists public.v24_operator_control (
  singleton boolean primary key default true check (singleton),
  entry_enabled boolean not null default false,
  -- Operator's assumed edge. NULL keeps the cost gate refusing, which is the safe default.
  assumed_edge_bps numeric,
  edge_samples integer,
  -- Free text: why this assumption was set, and by whom.
  set_reason text,
  set_by text,
  updated_at timestamptz not null default now(),
  constraint v24_edge_pair_complete check (
    (assumed_edge_bps is null and edge_samples is null)
    or (assumed_edge_bps is not null and edge_samples is not null and edge_samples > 0)
  )
);

insert into public.v24_operator_control(singleton) values (true)
on conflict (singleton) do nothing;

alter table public.v24_operator_control enable row level security;
revoke all on public.v24_operator_control from anon, authenticated;
grant select, update on public.v24_operator_control to service_role;

create table if not exists public.v24_entry_decisions (
  id bigserial primary key,
  decided_at timestamptz not null default now(),
  signal_id uuid,
  symbol text not null,
  decision text not null,
  reason text not null,
  reason_codes text[],
  setup_type text,
  trigger_level numeric,
  setup_low numeric,
  initial_stop numeric,
  cost_bps numeric,
  net_edge_bps numeric,
  buy_share_60s numeric,
  buy_share_180s numeric,
  imbalance_25 numeric,
  spread_bps numeric,
  edge_basis text,
  adapter_version text not null,
  policy_version text not null,
  evidence jsonb not null default '{}'::jsonb
);
create index if not exists v24_entry_decisions_at on public.v24_entry_decisions(decided_at desc);
create index if not exists v24_entry_decisions_symbol on public.v24_entry_decisions(symbol);

alter table public.v24_entry_decisions enable row level security;
revoke all on public.v24_entry_decisions from anon, authenticated;
grant select, insert on public.v24_entry_decisions to service_role;
grant usage, select on sequence public.v24_entry_decisions_id_seq to service_role;
