-- Trading-booooo v5.2.0 dashboard, allocation and manual-intervention controls.

alter table public.trading_settings
  add column if not exists upbit_allocation_mode text not null default 'ALL',
  add column if not exists upbit_allocation_krw numeric not null default 0,
  add column if not exists upbit_reserve_krw numeric not null default 0,
  add column if not exists binance_allocation_mode text not null default 'ALL',
  add column if not exists binance_allocation_usdt numeric not null default 0,
  add column if not exists binance_reserve_usdt numeric not null default 0,
  add column if not exists withdrawal_mode boolean not null default false,
  add column if not exists manual_intervention_required boolean not null default false,
  add column if not exists manual_event_reason text,
  add column if not exists last_manual_event_at timestamptz,
  add column if not exists last_resume_at timestamptz;

alter table public.trading_settings drop constraint if exists trading_settings_upbit_allocation_mode_check;
alter table public.trading_settings add constraint trading_settings_upbit_allocation_mode_check
  check (upbit_allocation_mode in ('ALL','FIXED'));
alter table public.trading_settings drop constraint if exists trading_settings_binance_allocation_mode_check;
alter table public.trading_settings add constraint trading_settings_binance_allocation_mode_check
  check (binance_allocation_mode in ('ALL','FIXED'));
alter table public.trading_settings drop constraint if exists trading_settings_upbit_allocation_krw_check;
alter table public.trading_settings add constraint trading_settings_upbit_allocation_krw_check
  check (upbit_allocation_krw >= 0);
alter table public.trading_settings drop constraint if exists trading_settings_upbit_reserve_krw_check;
alter table public.trading_settings add constraint trading_settings_upbit_reserve_krw_check
  check (upbit_reserve_krw >= 0);
alter table public.trading_settings drop constraint if exists trading_settings_binance_allocation_usdt_check;
alter table public.trading_settings add constraint trading_settings_binance_allocation_usdt_check
  check (binance_allocation_usdt >= 0);
alter table public.trading_settings drop constraint if exists trading_settings_binance_reserve_usdt_check;
alter table public.trading_settings add constraint trading_settings_binance_reserve_usdt_check
  check (binance_reserve_usdt >= 0);

alter table public.trading_account_snapshots
  add column if not exists capital_base_quote numeric not null default 0,
  add column if not exists managed_capital_quote numeric not null default 0,
  add column if not exists managed_available_quote numeric not null default 0,
  add column if not exists protected_reserve_quote numeric not null default 0,
  add column if not exists allocation_mode text not null default 'ALL';

alter table public.trading_account_snapshots drop constraint if exists trading_account_snapshots_allocation_mode_check;
alter table public.trading_account_snapshots add constraint trading_account_snapshots_allocation_mode_check
  check (allocation_mode in ('ALL','FIXED'));

create table if not exists public.trading_cash_flows (
  id bigserial primary key,
  exchange text not null check (exchange in ('upbit','binance')),
  quote_currency text not null check (quote_currency in ('KRW','USDT')),
  flow_type text not null check (flow_type in ('EXTERNAL_DECREASE','EXTERNAL_INCREASE','MANUAL_POSITION_REDUCTION')),
  amount_quote numeric not null default 0,
  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  details jsonb not null default '{}'::jsonb
);
create index if not exists trading_cash_flows_detected_idx on public.trading_cash_flows(detected_at desc);
create index if not exists trading_cash_flows_exchange_idx on public.trading_cash_flows(exchange, detected_at desc);
alter table public.trading_cash_flows enable row level security;
-- No public policies. Only the service-role Edge Function can read or write.
