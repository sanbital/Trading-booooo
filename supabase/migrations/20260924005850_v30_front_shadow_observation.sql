-- V30 front-end policy SHADOW observation store (order-free).
-- Rows record, for every production-triggered and B06133-stamped signal, what the
-- V30 score gate would decide (from the unmodified B06133 stamp) and, for V30-admitted
-- candidates, the GPT V6 real-time risk review taken on a live snapshot. Nothing here
-- is read by the executor or any trading path.
create table if not exists public.v30_front_shadow (
  signal_id uuid primary key,
  symbol text not null,
  trigger_at timestamptz not null,
  policy_version text not null,
  v30_admitted boolean not null,
  v30 jsonb not null,
  b06133_allowed boolean not null,
  b06133_reason text,
  cec jsonb,
  production_status text,
  production_reason text,
  observed_lag_ms bigint,
  gpt_state text not null,
  gpt_job_key text,
  gpt_decision text,
  gpt_reason text,
  gpt_error text,
  snapshot_offset_ms bigint,
  microstructure_complete boolean,
  risk_hard jsonb,
  risk_soft jsonb,
  patch text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists v30_front_shadow_trigger_idx on public.v30_front_shadow (trigger_at);
alter table public.v30_front_shadow enable row level security;
revoke all on public.v30_front_shadow from anon, authenticated;

insert into public.edge_internal_tokens(name, token)
values ('v30-front-shadow', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;
