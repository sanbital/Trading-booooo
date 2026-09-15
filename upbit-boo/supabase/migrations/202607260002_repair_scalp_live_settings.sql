-- Repair the malformed v5.2.0 live scalp settings and persist the operator-approved limits.

alter table public.trading_settings
  add column if not exists strategy text not null default 'TREND',
  add column if not exists scalp_per_order_pct double precision not null default 10,
  add column if not exists scalp_daily_loss_pct double precision not null default 20,
  add column if not exists scalp_max_single_loss_pct double precision not null default 5,
  add column if not exists scalp_max_consecutive_losses integer not null default 4,
  add column if not exists scalp_kill_switch boolean not null default false,
  add column if not exists scalp_max_holding_minutes integer not null default 30;

alter table public.trading_settings drop constraint if exists trading_settings_strategy_check;
alter table public.trading_settings add constraint trading_settings_strategy_check
  check (strategy in ('TREND', 'SCALP'));
alter table public.trading_settings drop constraint if exists trading_settings_scalp_per_order_pct_check;
alter table public.trading_settings add constraint trading_settings_scalp_per_order_pct_check
  check (scalp_per_order_pct between 0.1 and 100);
alter table public.trading_settings drop constraint if exists trading_settings_scalp_daily_loss_pct_check;
alter table public.trading_settings add constraint trading_settings_scalp_daily_loss_pct_check
  check (scalp_daily_loss_pct between 0.1 and 100);
alter table public.trading_settings drop constraint if exists trading_settings_scalp_max_single_loss_pct_check;
alter table public.trading_settings add constraint trading_settings_scalp_max_single_loss_pct_check
  check (scalp_max_single_loss_pct between 0.1 and 100);
alter table public.trading_settings drop constraint if exists trading_settings_scalp_max_consecutive_losses_check;
alter table public.trading_settings add constraint trading_settings_scalp_max_consecutive_losses_check
  check (scalp_max_consecutive_losses between 1 and 50);
alter table public.trading_settings drop constraint if exists trading_settings_scalp_max_holding_minutes_check;
alter table public.trading_settings add constraint trading_settings_scalp_max_holding_minutes_check
  check (scalp_max_holding_minutes between 1 and 1440);

update public.trading_settings
set strategy = 'SCALP',
    scalp_per_order_pct = 10,
    scalp_daily_loss_pct = 20,
    scalp_max_single_loss_pct = 5,
    scalp_max_consecutive_losses = 4,
    scalp_kill_switch = false,
    scalp_max_holding_minutes = 30,
    version = coalesce(version, 0) + 1,
    updated_at = now()
where id = 1;
