-- Trading-booooo v5.1.0 autonomous spot trading schema.
-- Exchange-neutral accounting for Upbit KRW and Binance USDT spot only.

create extension if not exists pgcrypto;

-- Normalize scanner candidates for exchange-neutral execution.
alter table public.scanner_candidates
  add column if not exists quote_currency text;
update public.scanner_candidates
set quote_currency = case exchange when 'upbit' then 'KRW' when 'binance' then 'USDT' else quote_currency end
where quote_currency is null;
alter table public.scanner_candidates alter column quote_currency set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'scanner_candidates_quote_currency_check'
      and conrelid = 'public.scanner_candidates'::regclass
  ) then
    alter table public.scanner_candidates
      add constraint scanner_candidates_quote_currency_check
      check ((exchange = 'upbit' and quote_currency = 'KRW') or
             (exchange = 'binance' and quote_currency = 'USDT'));
  end if;
end $$;

create table if not exists public.trading_settings (
  id smallint primary key default 1 check (id = 1),
  configured boolean not null default false,
  mode text not null default 'PAPER' check (mode in ('PAUSED','PAPER','LIVE_LIMITED')),
  pause_new_entries boolean not null default false,
  emergency_liquidation boolean not null default false,
  upbit_enabled boolean not null default true,
  binance_enabled boolean not null default true,
  max_open_positions int not null default 4 check (max_open_positions between 1 and 20),
  max_open_positions_per_exchange int not null default 2 check (max_open_positions_per_exchange between 1 and 10),
  max_daily_entries int not null default 8 check (max_daily_entries between 1 and 50),
  max_daily_entries_per_exchange int not null default 4 check (max_daily_entries_per_exchange between 1 and 25),
  max_position_pct double precision not null default 5 check (max_position_pct between 0.5 and 25),
  risk_per_trade_pct double precision not null default 0.5 check (risk_per_trade_pct between 0.05 and 2),
  max_order_krw numeric not null default 100000 check (max_order_krw >= 5000),
  min_order_krw numeric not null default 5000 check (min_order_krw >= 5000),
  max_daily_buy_krw numeric not null default 300000 check (max_daily_buy_krw >= max_order_krw),
  max_order_usdt numeric not null default 100 check (max_order_usdt >= 5),
  min_order_usdt numeric not null default 10 check (min_order_usdt >= 5),
  max_daily_buy_usdt numeric not null default 300 check (max_daily_buy_usdt >= max_order_usdt),
  max_daily_loss_pct double precision not null default 1.5 check (max_daily_loss_pct between 0.2 and 10),
  max_weekly_loss_pct double precision not null default 3 check (max_weekly_loss_pct between 0.5 and 20),
  max_consecutive_losses int not null default 3 check (max_consecutive_losses between 1 and 10),
  entry_ttl_seconds int not null default 180 check (entry_ttl_seconds between 30 and 900),
  full_scan_interval_seconds int not null default 300 check (full_scan_interval_seconds between 300 and 3600),
  monitor_interval_seconds int not null default 15 check (monitor_interval_seconds between 10 and 300),
  max_new_entries_per_scan int not null default 2 check (max_new_entries_per_scan between 1 and 4),
  suppress_cross_exchange_same_asset boolean not null default true,
  last_full_scan_at timestamptz,
  last_monitor_at timestamptz,
  last_gateway_heartbeat_at timestamptz,
  gateway_error_count int not null default 0,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.trading_cycle_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('SCAN','MONITOR','BOOTSTRAP','CONTROL')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING' check (status in ('RUNNING','SUCCESS','SKIPPED','FAILED')),
  mode text,
  scan_id uuid references public.scanner_scan_runs(id) on delete set null,
  summary jsonb not null default '{}'::jsonb,
  error text
);

create table if not exists public.trading_positions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.scanner_candidates(id) on delete set null,
  scan_id uuid references public.scanner_scan_runs(id) on delete set null,
  exchange text not null check (exchange in ('upbit','binance')),
  quote_currency text not null check (quote_currency in ('KRW','USDT')),
  market text not null,
  base_asset text not null,
  state text not null default 'ENTRY_PENDING' check (state in ('ENTRY_PENDING','OPEN','EXITING','CLOSED','CANCELLED','ERROR')),
  is_paper boolean not null default true,
  profile_version int not null default 0,
  initial_quantity numeric not null default 0,
  remaining_quantity numeric not null default 0,
  average_entry_price numeric,
  planned_entry_price numeric not null,
  stop_price numeric not null,
  target_1 numeric not null,
  target_2 numeric,
  tick_size numeric not null,
  quantity_step numeric,
  min_notional_quote numeric,
  t1_allocation_pct double precision not null default 60,
  t1_completed boolean not null default false,
  exit_policy text not null default 'SCALE_OUT' check (exit_policy in ('FIXED_T1','SCALE_OUT','TRAIL_AFTER_T1')),
  peak_price numeric,
  trough_price numeric,
  trailing_stop numeric,
  trailing_distance_pct double precision,
  intended_horizon_hours int not null default 24,
  max_holding_at timestamptz not null,
  opened_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  realized_proceeds_quote numeric not null default 0,
  realized_cost_quote numeric not null default 0,
  paid_fees_quote numeric not null default 0,
  realized_pnl_quote numeric not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((exchange = 'upbit' and quote_currency = 'KRW' and market like 'KRW-%') or
         (exchange = 'binance' and quote_currency = 'USDT' and market like '%USDT')),
  check (remaining_quantity >= 0),
  check (stop_price < coalesce(average_entry_price, planned_entry_price)),
  check (target_1 > coalesce(average_entry_price, planned_entry_price))
);

create unique index if not exists trading_one_active_exchange_market_position
  on public.trading_positions(exchange, market)
  where state in ('ENTRY_PENDING','OPEN','EXITING');
create index if not exists trading_positions_state_idx on public.trading_positions(state, updated_at);
create index if not exists trading_positions_exchange_idx on public.trading_positions(exchange, state, updated_at);
create index if not exists trading_positions_base_idx on public.trading_positions(base_asset, state);
create index if not exists trading_positions_candidate_idx on public.trading_positions(candidate_id);

create table if not exists public.trading_orders (
  id uuid primary key default gen_random_uuid(),
  position_id uuid references public.trading_positions(id) on delete cascade,
  candidate_id uuid references public.scanner_candidates(id) on delete set null,
  cycle_id uuid references public.trading_cycle_runs(id) on delete set null,
  exchange text not null check (exchange in ('upbit','binance')),
  quote_currency text not null check (quote_currency in ('KRW','USDT')),
  identifier text not null unique,
  exchange_order_id text,
  market text not null,
  side text not null check (side in ('BUY','SELL')),
  purpose text not null check (purpose in ('ENTRY','STOP','TARGET_1','TARGET_2','TRAIL','TIME_EXIT','EMERGENCY','MANUAL_RECONCILE')),
  order_type text not null,
  time_in_force text,
  requested_price numeric,
  requested_volume numeric,
  requested_notional_quote numeric,
  state text not null default 'REQUESTED',
  executed_volume numeric not null default 0,
  average_fill_price numeric,
  executed_funds_quote numeric not null default 0,
  paid_fee_quote numeric not null default 0,
  fee_asset text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(exchange, exchange_order_id)
);
create index if not exists trading_orders_position_idx on public.trading_orders(position_id, created_at);
create index if not exists trading_orders_state_idx on public.trading_orders(state, updated_at);
create index if not exists trading_orders_exchange_idx on public.trading_orders(exchange, state, updated_at);

create table if not exists public.trading_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.trading_orders(id) on delete cascade,
  trade_id text,
  price numeric not null,
  volume numeric not null,
  funds_quote numeric not null,
  fee_amount numeric not null default 0,
  fee_asset text,
  fee_quote_estimate numeric not null default 0,
  executed_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  unique(order_id, trade_id)
);

create table if not exists public.trading_events (
  id bigserial primary key,
  cycle_id uuid references public.trading_cycle_runs(id) on delete set null,
  position_id uuid references public.trading_positions(id) on delete cascade,
  order_id uuid references public.trading_orders(id) on delete cascade,
  level text not null default 'INFO' check (level in ('INFO','WARNING','CRITICAL')),
  code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trading_events_created_idx on public.trading_events(created_at desc);

create table if not exists public.trading_account_snapshots (
  id bigserial primary key,
  exchange text not null check (exchange in ('upbit','binance')),
  quote_currency text not null check (quote_currency in ('KRW','USDT')),
  captured_at timestamptz not null default now(),
  total_equity_quote numeric not null,
  available_quote numeric not null,
  locked_quote numeric not null default 0,
  bot_open_cost_quote numeric not null default 0,
  bot_unrealized_pnl_quote numeric not null default 0,
  balances jsonb not null default '[]'::jsonb,
  prices jsonb not null default '{}'::jsonb,
  source text not null default 'STATIC_IP_GATEWAY'
);
create index if not exists trading_account_snapshots_time_idx on public.trading_account_snapshots(exchange, captured_at desc);

create table if not exists public.trading_leases (
  name text primary key,
  owner uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create or replace function public.acquire_trading_lease(p_name text, p_owner uuid, p_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.trading_leases(name, owner, acquired_at, expires_at)
  values (p_name, p_owner, now(), now() + make_interval(secs => greatest(10, p_seconds)))
  on conflict (name) do update
    set owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    where public.trading_leases.expires_at < now() or public.trading_leases.owner = excluded.owner;
  return exists(select 1 from public.trading_leases where name = p_name and owner = p_owner);
end; $$;

create or replace function public.release_trading_lease(p_name text, p_owner uuid)
returns boolean language sql security definer set search_path = public as $$
  with deleted as (delete from public.trading_leases where name = p_name and owner = p_owner returning 1)
  select exists(select 1 from deleted);
$$;

alter table public.trading_settings enable row level security;
alter table public.trading_cycle_runs enable row level security;
alter table public.trading_positions enable row level security;
alter table public.trading_orders enable row level security;
alter table public.trading_fills enable row level security;
alter table public.trading_events enable row level security;
alter table public.trading_account_snapshots enable row level security;
alter table public.trading_leases enable row level security;
-- No public policies. Only service_role Edge Functions may access these tables.

create or replace function public.apply_trading_entry_order(
  p_order_id uuid,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_stop_price numeric,
  p_target_1 numeric,
  p_target_2 numeric default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
begin
  select * into v_order from public.trading_orders where id = p_order_id for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;
  if v_order.purpose <> 'ENTRY' or v_order.side <> 'BUY' then raise exception 'order % is not an entry order', p_order_id; end if;
  select * into v_position from public.trading_positions where id = v_order.position_id for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object('applied', false, 'position', to_jsonb(v_position), 'order', to_jsonb(v_order));
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 then raise exception 'entry fill must be positive'; end if;

  update public.trading_positions set
    state = 'OPEN', initial_quantity = p_fill_quantity, remaining_quantity = p_fill_quantity,
    average_entry_price = p_fill_price, stop_price = p_stop_price, target_1 = p_target_1, target_2 = p_target_2,
    peak_price = p_fill_price, trough_price = p_fill_price, opened_at = coalesce(opened_at, v_now),
    realized_cost_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fees_quote = greatest(0, coalesce(p_fill_fee_quote, 0)),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('last_applied_order_id', p_order_id, 'last_applied_order_at', v_now),
    updated_at = v_now
  where id = v_position.id returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED', executed_volume = p_fill_quantity, average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_price * p_fill_quantity)),
    paid_fee_quote = greatest(0, coalesce(p_fill_fee_quote, 0)), completed_at = coalesce(completed_at, v_now), updated_at = v_now
  where id = p_order_id returning * into v_order;

  return jsonb_build_object('applied', true, 'position', to_jsonb(v_position), 'order', to_jsonb(v_order));
end; $$;

create or replace function public.apply_trading_exit_order(
  p_order_id uuid,
  p_action text,
  p_fill_price numeric,
  p_fill_quantity numeric,
  p_fill_funds numeric,
  p_fill_fee_quote numeric,
  p_trailing_stop numeric default null,
  p_dust_value_quote numeric default 0
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order public.trading_orders%rowtype;
  v_position public.trading_positions%rowtype;
  v_now timestamptz := now();
  v_sold numeric; v_remaining numeric; v_proceeds numeric; v_fees numeric; v_closed boolean; v_pnl numeric;
begin
  select * into v_order from public.trading_orders where id = p_order_id for update;
  if not found then raise exception 'trading order % not found', p_order_id; end if;
  if v_order.side <> 'SELL' or v_order.purpose = 'ENTRY' then raise exception 'order % is not an exit order', p_order_id; end if;
  select * into v_position from public.trading_positions where id = v_order.position_id for update;
  if not found then raise exception 'position for order % not found', p_order_id; end if;
  if v_order.state = 'APPLIED' then
    return jsonb_build_object('applied', false, 'closed', v_position.state = 'CLOSED', 'position', to_jsonb(v_position), 'order', to_jsonb(v_order));
  end if;
  if coalesce(p_fill_quantity, 0) <= 0 or coalesce(p_fill_price, 0) <= 0 then raise exception 'exit fill must be positive'; end if;

  v_sold := least(greatest(0, v_position.remaining_quantity), greatest(0, p_fill_quantity));
  if v_sold <= 0 then
    update public.trading_orders set state = 'APPLIED', completed_at = coalesce(completed_at, v_now), updated_at = v_now where id = p_order_id returning * into v_order;
    return jsonb_build_object('applied', false, 'closed', v_position.state = 'CLOSED', 'position', to_jsonb(v_position), 'order', to_jsonb(v_order));
  end if;

  v_remaining := greatest(0, v_position.remaining_quantity - v_sold);
  v_proceeds := v_position.realized_proceeds_quote + greatest(0, coalesce(p_fill_funds, v_sold * p_fill_price));
  v_fees := v_position.paid_fees_quote + greatest(0, coalesce(p_fill_fee_quote, 0));
  v_closed := v_remaining <= 0.000000000001 or v_remaining * p_fill_price < greatest(0, p_dust_value_quote);
  v_pnl := case when v_closed then v_proceeds - v_position.realized_cost_quote - v_fees else v_position.realized_pnl_quote end;

  update public.trading_positions set
    remaining_quantity = case when v_closed then 0 else v_remaining end,
    realized_proceeds_quote = v_proceeds, paid_fees_quote = v_fees, realized_pnl_quote = v_pnl,
    t1_completed = t1_completed or p_action = 'TARGET_1',
    trailing_stop = case when not v_closed and p_action = 'TARGET_1' and exit_policy = 'TRAIL_AFTER_T1'
      then greatest(coalesce(trailing_stop, 0), coalesce(p_trailing_stop, 0), stop_price) else trailing_stop end,
    state = case when v_closed then 'CLOSED' else 'OPEN' end,
    close_reason = case when v_closed then p_action else null end,
    closed_at = case when v_closed then v_now else null end,
    metadata = (coalesce(metadata, '{}'::jsonb) - 'pending_exit_action' - 'pending_exit_at') ||
      jsonb_build_object('last_applied_order_id', p_order_id, 'last_applied_order_at', v_now),
    updated_at = v_now
  where id = v_position.id returning * into v_position;

  update public.trading_orders set
    state = 'APPLIED', executed_volume = p_fill_quantity, average_fill_price = p_fill_price,
    executed_funds_quote = greatest(0, coalesce(p_fill_funds, p_fill_quantity * p_fill_price)),
    paid_fee_quote = greatest(0, coalesce(p_fill_fee_quote, 0)), completed_at = coalesce(completed_at, v_now), updated_at = v_now
  where id = p_order_id returning * into v_order;

  return jsonb_build_object('applied', true, 'closed', v_closed, 'position', to_jsonb(v_position), 'order', to_jsonb(v_order));
end; $$;

revoke all on function public.acquire_trading_lease(text, uuid, int) from public, anon, authenticated;
revoke all on function public.release_trading_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.apply_trading_entry_order(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.apply_trading_exit_order(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.acquire_trading_lease(text, uuid, int) to service_role;
grant execute on function public.release_trading_lease(text, uuid) to service_role;
grant execute on function public.apply_trading_entry_order(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric) to service_role;
grant execute on function public.apply_trading_exit_order(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric) to service_role;
