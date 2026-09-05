-- Durable global cadence gate for market-autotrader heavy cycles.
-- Production was created ahead of this migration during the 2026-09-05 incident response.
create table if not exists public.autotrader_execution_gate (
  gate_key text primary key,
  last_started_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint autotrader_execution_gate_key_len check (char_length(gate_key) between 1 and 80)
);

alter table public.autotrader_execution_gate enable row level security;
revoke all on table public.autotrader_execution_gate from public, anon, authenticated;

create or replace function public.try_acquire_autotrader_execution_gate(
  p_gate_key text,
  p_min_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_acquired boolean := false;
begin
  if p_gate_key is null
     or btrim(p_gate_key) = ''
     or p_min_seconds is null
     or p_min_seconds < 1
     or p_min_seconds > 3600 then
    return false;
  end if;

  insert into public.autotrader_execution_gate as g
    (gate_key, last_started_at, updated_at)
  values
    (p_gate_key, v_now, v_now)
  on conflict (gate_key) do update
    set last_started_at = excluded.last_started_at,
        updated_at = excluded.updated_at
    where g.last_started_at <= excluded.last_started_at - make_interval(secs => p_min_seconds)
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

revoke all on function public.try_acquire_autotrader_execution_gate(text, integer)
  from public, anon, authenticated;
grant execute on function public.try_acquire_autotrader_execution_gate(text, integer)
  to service_role;
