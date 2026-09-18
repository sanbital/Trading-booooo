-- Trading-booooo v6.10.0 r6: fill-time integrity
--
-- Market lifecycle timestamps are immutable exchange facts. Reconciliation and fee repair may
-- update accounting fields, but must never move an order's completion time to the repair time.
-- Historical order completed_at and position opened_at values are repaired from actual fills.

create index if not exists trading_orders_position_lifecycle_idx
  on public.trading_orders(position_id, side, purpose, state);

create index if not exists trading_fills_order_executed_at_idx
  on public.trading_fills(order_id, executed_at);

-- Repair historical order completion timestamps from the latest actual fill in that order.
with fill_times as (
  select
    f.order_id,
    max(f.executed_at) as actual_completed_at
  from public.trading_fills f
  where f.executed_at is not null
    and (coalesce(f.volume, 0) > 0 or coalesce(f.funds_quote, 0) > 0)
  group by f.order_id
)
update public.trading_orders o
set
  completed_at = ft.actual_completed_at,
  raw_response = coalesce(o.raw_response, '{}'::jsonb) || jsonb_build_object(
    'time_integrity', jsonb_build_object(
      'revision', '6.10.0-r6',
      'completed_at_source', 'TRADING_FILLS_MAX_EXECUTED_AT',
      'repaired_at', now()
    )
  ),
  updated_at = now()
from fill_times ft
where o.id = ft.order_id
  and ft.actual_completed_at is not null
  and o.completed_at is distinct from ft.actual_completed_at;

-- Repair position opened_at from the earliest actual ENTRY fill. Rejected/no-fill ghost positions
-- remain null and are explicitly excluded from performance.
with entry_times as (
  select
    o.position_id,
    min(f.executed_at) as actual_entry_at
  from public.trading_orders o
  join public.trading_fills f on f.order_id = o.id
  where o.state = 'APPLIED'
    and upper(o.side) = 'BUY'
    and upper(o.purpose) = 'ENTRY'
    and f.executed_at is not null
    and (coalesce(f.volume, 0) > 0 or coalesce(f.funds_quote, 0) > 0)
  group by o.position_id
)
update public.trading_positions p
set
  opened_at = et.actual_entry_at,
  metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
    'time_integrity', jsonb_build_object(
      'revision', '6.10.0-r6',
      'entry_at_source', 'TRADING_FILLS_MIN_EXECUTED_AT',
      'repaired_at', now()
    )
  ),
  updated_at = now()
from entry_times et
where p.id = et.position_id
  and et.actual_entry_at is not null
  and p.opened_at is distinct from et.actual_entry_at;

-- Mark zero-fill rejected position shells as audit records, not trades.
update public.trading_positions p
set
  close_reason = case
    when coalesce(p.close_reason, '') = '' then 'ENTRY_REJECTED_GHOST'
    else p.close_reason
  end,
  metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
    'lifecycle_quality', 'ENTRY_REJECTED_NO_FILL',
    'performance_excluded', true,
    'learning_excluded', true,
    'time_integrity_revision', '6.10.0-r6',
    'verified_at', now()
  ),
  updated_at = now()
where p.is_paper = false
  and p.state = 'CLOSED'
  and coalesce(p.initial_quantity, 0) = 0
  and coalesce(p.remaining_quantity, 0) = 0
  and not exists (
    select 1
    from public.trading_orders o
    join public.trading_fills f on f.order_id = o.id
    where o.position_id = p.id
      and o.state = 'APPLIED'
      and upper(o.side) = 'BUY'
      and upper(o.purpose) = 'ENTRY'
      and f.executed_at is not null
      and (coalesce(f.volume, 0) > 0 or coalesce(f.funds_quote, 0) > 0)
  );

-- Database-level guard: once completed_at exists, ordinary reconciliation cannot rewrite it.
-- A controlled repair can opt in within its transaction using:
--   select set_config('trading.allow_completed_at_repair', 'on', true);
create or replace function public.preserve_trading_order_completed_at_v610_r6()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.completed_at is not null
     and new.completed_at is distinct from old.completed_at
     and coalesce(current_setting('trading.allow_completed_at_repair', true), '') <> 'on' then
    new.completed_at := old.completed_at;
  end if;
  return new;
end;
$$;

revoke all on function public.preserve_trading_order_completed_at_v610_r6()
  from public, anon, authenticated;

drop trigger if exists trading_orders_preserve_completed_at_v610_r6
  on public.trading_orders;
create trigger trading_orders_preserve_completed_at_v610_r6
before update of completed_at
on public.trading_orders
for each row
execute function public.preserve_trading_order_completed_at_v610_r6();

-- Read-only verification function used by SQL_VERIFY_v6100_FILL_TIME_r6.sql.
create or replace function public.verify_fill_time_integrity_v610_r6()
returns table(check_name text, check_status text, bad_rows bigint)
language sql
stable
security definer
set search_path = public
as $$
  with lifecycle as (
    select
      p.id,
      p.state,
      min(f.executed_at) filter (
        where upper(o.side) = 'BUY'
          and upper(o.purpose) = 'ENTRY'
          and o.state = 'APPLIED'
          and (coalesce(f.volume, 0) > 0 or coalesce(f.funds_quote, 0) > 0)
      ) as entry_at,
      max(f.executed_at) filter (
        where upper(o.side) = 'SELL'
          and o.state = 'APPLIED'
          and (coalesce(f.volume, 0) > 0 or coalesce(f.funds_quote, 0) > 0)
      ) as exit_at
    from public.trading_positions p
    left join public.trading_orders o on o.position_id = p.id
    left join public.trading_fills f on f.order_id = o.id
    where p.is_paper = false
      and p.state in ('OPEN', 'EXITING', 'CLOSED')
    group by p.id, p.state
  ), checks as (
    select
      'ACTUAL_FILL_TIME_REVERSED'::text as check_name,
      count(*) filter (
        where state = 'CLOSED'
          and entry_at is not null
          and exit_at is not null
          and exit_at < entry_at
      )::bigint as bad_rows
    from lifecycle
    union all
    select
      'VERIFIED_POSITION_OPENED_AT',
      count(*) filter (
        where l.entry_at is not null
          and abs(extract(epoch from (p.opened_at - l.entry_at))) > 0.001
      )::bigint
    from lifecycle l
    join public.trading_positions p on p.id = l.id
    union all
    select
      'ORDER_COMPLETED_AT_MATCHES_FILL',
      count(*)::bigint
    from public.trading_orders o
    join (
      select order_id, max(executed_at) as actual_completed_at
      from public.trading_fills
      where executed_at is not null
        and (coalesce(volume, 0) > 0 or coalesce(funds_quote, 0) > 0)
      group by order_id
    ) ft on ft.order_id = o.id
    where o.completed_at is distinct from ft.actual_completed_at
  )
  select
    check_name,
    case when bad_rows = 0 then 'PASS' else 'FAIL' end,
    bad_rows
  from checks
  order by check_name
$$;

revoke all on function public.verify_fill_time_integrity_v610_r6()
  from public, anon, authenticated;
grant execute on function public.verify_fill_time_integrity_v610_r6()
  to service_role;
