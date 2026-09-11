-- Isolated analytics storage. No change to any trading table, controls, or trigger.
-- Applied individually via authenticated SQL; not a full migration-history push.
begin;
create table if not exists public.v18_strategy_shadow_runs (
  policy_version text not null,
  slot_at timestamptz not null,
  observed_at timestamptz not null,
  payload jsonb not null,
  primary key (policy_version, slot_at),
  check ((payload->>'executionEnabled' = 'false') is true),
  check ((payload->>'readOnlyTrading' = 'true') is true),
  check ((payload->>'version' = policy_version) is true)
);
alter table public.v18_strategy_shadow_runs enable row level security;
revoke all on public.v18_strategy_shadow_runs from public, anon, authenticated;
revoke all on public.v18_strategy_shadow_runs from service_role;
grant select, insert on public.v18_strategy_shadow_runs to service_role;
comment on table public.v18_strategy_shadow_runs is 'Unvalidated decision-only hypotheses. Never a live order or signal source.';
commit;
