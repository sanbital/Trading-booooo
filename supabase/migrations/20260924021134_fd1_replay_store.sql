-- GPT FINAL DECISION (FD1) historical replay store (validation only, order-free).
-- Jobs are historical decision points; results are GPT answers on point-in-time
-- Binance history. Its budget row is separate from the production GPT ledger.
create table if not exists public.fd1_replay_jobs (
  id text primary key,
  run_tag text not null,
  task text not null check (task in ('ENTRY','HOLD')),
  symbol text not null,
  as_of_ms bigint not null,
  context jsonb not null default '{}'::jsonb,
  state text not null default 'NEW' check (state in ('NEW','RUNNING','DONE')),
  claimed_at timestamptz,
  completed_at timestamptz,
  packet jsonb,
  result jsonb,
  decision text,
  valid boolean,
  error text,
  api_cost_usd numeric,
  latency_ms bigint,
  created_at timestamptz not null default now()
);
create index if not exists fd1_replay_jobs_state_idx on public.fd1_replay_jobs (state, as_of_ms);
create index if not exists fd1_replay_jobs_tag_idx on public.fd1_replay_jobs (run_tag);
alter table public.fd1_replay_jobs enable row level security;
revoke all on public.fd1_replay_jobs from anon, authenticated;

create table if not exists public.fd1_replay_budget (
  singleton boolean primary key default true check (singleton),
  cap_usd numeric not null check (cap_usd >= 0 and cap_usd <= 25),
  max_calls integer not null check (max_calls >= 0 and max_calls <= 10000),
  reserved_usd numeric not null default 0,
  settled_usd numeric not null default 0,
  calls integer not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.fd1_replay_budget(singleton, cap_usd, max_calls) values (true, 20, 8000) on conflict do nothing;
alter table public.fd1_replay_budget enable row level security;
revoke all on public.fd1_replay_budget from anon, authenticated;

create or replace function public.fd1_replay_claim(p_limit integer)
returns setof public.fd1_replay_jobs language sql security definer set search_path = public as $$
  update public.fd1_replay_jobs j set state = 'RUNNING', claimed_at = now()
  where j.id in (select id from public.fd1_replay_jobs
                 where state = 'NEW' or (state = 'RUNNING' and claimed_at < now() - interval '5 minutes')
                 order by as_of_ms limit least(greatest(p_limit, 0), 50) for update skip locked)
  returning j.*;
$$;
create or replace function public.fd1_replay_reserve(p_reserve numeric)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update public.fd1_replay_budget set reserved_usd = reserved_usd + p_reserve, calls = calls + 1, updated_at = now()
  where singleton and calls < max_calls and settled_usd + reserved_usd + p_reserve <= cap_usd
  returning true into ok;
  return coalesce(ok, false);
end $$;
create or replace function public.fd1_replay_settle(p_reserve numeric, p_cost numeric)
returns void language sql security definer set search_path = public as $$
  update public.fd1_replay_budget set reserved_usd = greatest(reserved_usd - p_reserve, 0),
    settled_usd = settled_usd + greatest(coalesce(p_cost, p_reserve), 0), updated_at = now() where singleton;
$$;
revoke all on function public.fd1_replay_claim(integer), public.fd1_replay_reserve(numeric), public.fd1_replay_settle(numeric, numeric) from public, anon, authenticated;

insert into public.edge_internal_tokens(name, token)
values ('gpt-final-decision-replay', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;
